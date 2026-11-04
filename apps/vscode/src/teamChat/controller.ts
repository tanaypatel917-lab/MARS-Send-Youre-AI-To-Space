import {
  type ConversationSummary,
  FIXTURE_USERS,
  FixtureTeamService,
  type MessageView,
  type SendMessageInput,
  type TeamErrorCode,
  type TeamResult,
  type TeamService,
} from "@mars/team-chat";
import {
  type PendingSend,
  type SelectedConversation,
  type TeamChatAnnouncement,
  type TeamChatNotice,
  type TeamChatViewState,
  type TeamChatWebviewMessage,
  TeamChatWebviewMessageSchema,
  type TeamConnectionState,
} from "./messages";

/**
 * Delivery source the controller subscribes to. Events carry metadata only;
 * the controller re-reads protected fields through the service.
 */
export interface TeamRealtimeSource {
  /** Replace the set of conversations to follow (the viewer's current inbox). */
  subscribe(conversationIds: readonly string[]): void;
  stop(): void;
}

export interface TeamChatControllerOptions {
  post: (state: TeamChatViewState) => void;
  service?: TeamService;
  realtime?: TeamRealtimeSource;
  viewer?: string;
  /** Messages per history page; small by default so pagination is visible on the fixture. */
  pageSize?: number;
  /** Simulated acknowledgement delay so pending state is observable. */
  sendDelayMs?: number;
  /** Upper bound on messages kept in memory for the selected conversation. */
  maxLoaded?: number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_PAGE_SIZE = 3;
const MAX_LOADED = 200;

/** Fixed, content-free reasons shown next to a failed send. */
const SEND_FAILURE_TEXT: Record<TeamErrorCode, string> = {
  not_found: "Conversation is not available to you.",
  forbidden: "You may not post in this conversation.",
  invalid: "The message was rejected as invalid.",
  client_message_id_reused:
    "This message id was already committed with different content. Discard and compose again.",
  conflict:
    "This message id was already committed with different content. Edit and resend.",
  reply_outside_conversation: "The reply target is not in this conversation.",
  reference_not_attachable:
    "A reference could not be attached: no access to that repo or unknown revision.",
  too_many_references: "Too many references on one message.",
  empty_message: "Nothing to send.",
  unavailable:
    "The team service did not acknowledge the send. Retry keeps the same message id.",
  unauthorized: "The team token is missing or was rejected.",
};

const NOTICE_UNAVAILABLE: TeamChatNotice = {
  kind: "error",
  text: "The team service is not reachable.",
};
const NOTICE_UNAUTHORIZED: TeamChatNotice = {
  kind: "error",
  text: "No valid team token. Run “MARS: Set team token”.",
};
const NOTICE_REMOVED: TeamChatNotice = {
  kind: "info",
  text: "A conversation is no longer available to you and was removed.",
};

const REMOVAL_CODES: ReadonlySet<TeamErrorCode> = new Set([
  "not_found",
  "forbidden",
]);

interface Viewport {
  focused: boolean;
  atBottom: boolean;
}

/**
 * Extension-host state machine for Team Chat. The webview only sends
 * validated intents; every read and write goes through the injected
 * `TeamService` (fixture or `@mars/team` adapter) and the webview receives
 * view state only: no tokens, no service handles, no transport errors.
 *
 * Operations are serialized through one queue so a delivery event, a send
 * acknowledgement and a user action cannot interleave their reads.
 */
export class TeamChatController {
  private readonly service: TeamService;
  private readonly pageSize: number;
  private readonly maxLoaded: number;
  private viewer: string;
  private conversations: ConversationSummary[] = [];
  private selected: SelectedConversation | null = null;
  private readonly pending: PendingSend[] = [];
  private readonly pendingInputs = new Map<string, SendMessageInput>();
  private panel: TeamChatViewState["panel"] = null;
  private notice: TeamChatNotice | null = null;
  private search: TeamChatViewState["search"] = null;
  private announcement: TeamChatAnnouncement | null = null;
  private announcementSeq = 0;
  private connection: TeamConnectionState = "offline";
  private viewport: Viewport = { focused: false, atBottom: false };
  private queue: Promise<void> = Promise.resolve();
  private disposedFlag = false;

  constructor(private readonly options: TeamChatControllerOptions) {
    this.service = options.service ?? new FixtureTeamService();
    this.pageSize = Math.max(1, options.pageSize ?? DEFAULT_PAGE_SIZE);
    this.maxLoaded = Math.max(this.pageSize, options.maxLoaded ?? MAX_LOADED);
    this.viewer = options.viewer ?? FIXTURE_USERS.ada;
  }

  get disposed(): boolean {
    return this.disposedFlag;
  }

  get currentViewer(): string {
    return this.me();
  }

  /** The authenticated identity: server-derived for the service, the chosen fixture user otherwise. */
  private me(): string {
    return this.service.currentUser?.() ?? this.viewer;
  }

  dispose(): void {
    this.disposedFlag = true;
    this.options.realtime?.stop();
  }

  /** Waits for every queued operation to settle (tests and shutdown). */
  idle(): Promise<void> {
    return this.queue;
  }

  private run(task: () => Promise<void> | void): Promise<void> {
    const next = this.queue.then(async () => {
      if (this.disposedFlag) return;
      await task();
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Validates and dispatches one untrusted webview message. */
  async handleMessage(raw: unknown): Promise<boolean> {
    const parsed = TeamChatWebviewMessageSchema.safeParse(raw);
    if (!parsed.success || this.disposedFlag) return false;
    await this.run(() => this.dispatch(parsed.data));
    return true;
  }

  /**
   * Called by the realtime source for each delivery event. Only the
   * conversation id and kind are trusted; everything else is re-read.
   */
  notifyDelivery(
    conversationId: string,
    kind: "message" | "membership" | "reaction",
  ): Promise<void> {
    return this.run(async () => {
      const known = this.conversations.some(
        (c) => c.conversation_id === conversationId,
      );
      if (!known) {
        await this.refreshInbox();
        return this.emit();
      }
      const before = this.selected?.conversation.last_sequence ?? null;
      await this.refreshInbox();
      const still = this.conversations.find(
        (c) => c.conversation_id === conversationId,
      );
      if (!still) {
        this.forget(conversationId);
        return this.emit();
      }
      if (this.selected?.conversation.conversation_id === conversationId) {
        const grow = Math.max(
          1,
          still.last_sequence - (before ?? still.last_sequence),
        );
        await this.reloadSelected(grow);
        if (kind === "message" && this.selected) {
          const fresh = this.selected.messages.filter(
            (m) =>
              before !== null &&
              m.sequence > before &&
              m.author_id !== this.me(),
          );
          if (fresh.length > 0) this.announce(still, fresh.length);
          await this.markReadIfBoundaryLoaded();
        }
      } else if (kind === "message" && still.unread_count > 0) {
        this.announce(still, 1);
      }
      this.emit();
    });
  }

  /** Called by the realtime source when its connection state changes. */
  notifyConnection(state: TeamConnectionState): Promise<void> {
    return this.run(() => {
      if (this.connection === state) return;
      this.connection = state;
      this.emit();
    });
  }

  /** Drops every cached conversation, message, draft and search (token cleared or source changed). */
  reset(): Promise<void> {
    return this.run(() => {
      this.conversations = [];
      this.selected = null;
      this.panel = null;
      this.notice = null;
      this.search = null;
      this.announcement = null;
      this.pending.splice(0, this.pending.length);
      this.pendingInputs.clear();
      this.options.realtime?.subscribe([]);
      this.emit();
    });
  }

  private async dispatch(message: TeamChatWebviewMessage): Promise<void> {
    switch (message.type) {
      case "ready":
        await this.refreshInbox();
        if (!this.selected) {
          const first = this.conversations[0];
          if (first) await this.select(first.conversation_id);
        }
        return this.emit();
      case "selectConversation":
        await this.select(message.conversationId);
        return this.emit();
      case "loadOlder":
        await this.loadOlder(message.conversationId, message.cursor);
        return this.emit();
      case "send":
        return this.send({
          conversation_id: message.conversationId,
          client_message_id: message.clientMessageId,
          body: message.body,
          reply_to: message.replyTo,
          references: message.references,
        });
      case "retrySend": {
        const input = this.pendingInputs.get(message.clientMessageId);
        const item = this.pending.find(
          (p) => p.client_message_id === message.clientMessageId,
        );
        if (!input || item?.status === "conflict") return;
        return this.send(input);
      }
      case "discardSend":
        this.removePending(message.clientMessageId);
        return this.emit();
      case "viewport":
        this.viewport = {
          focused: message.focused,
          atBottom: message.atBottom,
        };
        await this.markReadIfBoundaryLoaded();
        return this.emit();
      case "markRead":
        if (!this.viewport.focused || !this.viewport.atBottom) return;
        await this.markRead(message.conversationId, message.sequence);
        return this.emit();
      case "togglePin":
        await this.togglePin(message.conversationId);
        return this.emit();
      case "toggleReaction":
        await this.toggleReaction(message.messageId, message.emoji);
        return this.emit();
      case "openReference":
        await this.openReference(message.messageId, message.referenceId);
        return this.emit();
      case "closeReference":
        this.panel = null;
        return this.emit();
      case "search":
        await this.runSearch(message.query);
        return this.emit();
      case "clearSearch":
        this.search = null;
        return this.emit();
      case "openSearchHit":
        await this.openHit(
          message.conversationId,
          message.messageId,
          message.sequence,
        );
        return this.emit();
      case "fixtureSwitchViewer":
        await this.switchViewer(message.userId);
        return this.emit();
    }
  }

  // ---------------------------------------------------------------- reads

  /** Maps a failed service result to a notice; removal codes on a known conversation drop it. */
  private failed(code: TeamErrorCode, conversationId?: string): void {
    if (code === "unavailable") this.notice = NOTICE_UNAVAILABLE;
    else if (code === "unauthorized") {
      this.notice = NOTICE_UNAUTHORIZED;
      this.connection = "unauthenticated";
    } else if (conversationId && REMOVAL_CODES.has(code))
      this.forget(conversationId);
  }

  /** Removes a conversation the viewer can no longer see, with every cached message and draft. */
  private forget(conversationId: string): void {
    const index = this.conversations.findIndex(
      (c) => c.conversation_id === conversationId,
    );
    const wasKnown = index !== -1;
    if (wasKnown) this.conversations.splice(index, 1);
    if (this.selected?.conversation.conversation_id === conversationId) {
      this.selected = null;
      this.panel = null;
    }
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const item = this.pending[i];
      if (item && item.conversation_id === conversationId) {
        this.pending.splice(i, 1);
        this.pendingInputs.delete(item.client_message_id);
      }
    }
    if (this.search)
      this.search = {
        ...this.search,
        hits: this.search.hits.filter(
          (h) => h.conversation_id !== conversationId,
        ),
      };
    if (wasKnown) this.notice = NOTICE_REMOVED;
    this.options.realtime?.subscribe(
      this.conversations.map((c) => c.conversation_id),
    );
  }

  private async refreshInbox(): Promise<void> {
    const result = await this.service.listConversations(this.viewer);
    if (!result.ok) {
      this.failed(result.code);
      if (result.code !== "unavailable") {
        this.conversations = [];
        this.selected = null;
      }
      return;
    }
    this.conversations = result.value;
    if (this.connection === "unauthenticated") this.connection = "offline";
    const ids = new Set(this.conversations.map((c) => c.conversation_id));
    if (this.selected && !ids.has(this.selected.conversation.conversation_id))
      this.forget(this.selected.conversation.conversation_id);
    else
      this.options.realtime?.subscribe(
        this.conversations.map((c) => c.conversation_id),
      );
  }

  private async select(conversationId: string): Promise<void> {
    this.notice = null;
    if (this.selected?.conversation.conversation_id !== conversationId)
      this.panel = null;
    const page = await this.service.openConversation(
      this.viewer,
      conversationId,
      { limit: this.pageSize },
    );
    if (!page.ok) {
      this.selected = null;
      this.failed(page.code, conversationId);
      if (!this.notice)
        this.notice = {
          kind: "error",
          text: "That conversation is not available.",
        };
      return;
    }
    this.selected = {
      conversation: page.value.conversation,
      messages: page.value.messages,
      older_cursor: page.value.older_cursor,
      older_blocked: false,
      // The first visible unread sequence (after the member's join point),
      // whether or not that page is loaded yet.
      divider_sequence: page.value.conversation.first_unread_sequence,
      highlight_message_id: null,
    };
    this.reconcilePending();
    await this.markReadIfBoundaryLoaded();
  }

  /**
   * Selects the hit's conversation, pages back until its sequence is loaded
   * (bounded by the in-memory cap) and marks it for highlighting.
   */
  private async openHit(
    conversationId: string,
    messageId: string,
    sequence: number,
  ): Promise<void> {
    if (this.selected?.conversation.conversation_id !== conversationId)
      await this.select(conversationId);
    // Page back while the hit is older than what is loaded and each page
    // still advances; the in-memory cap (older_blocked) or an exhausted
    // cursor ends the walk.
    for (;;) {
      const selected = this.selected;
      if (selected?.conversation.conversation_id !== conversationId) return;
      const earliest = selected.messages[0]?.sequence;
      if (
        earliest === undefined ||
        earliest <= sequence ||
        selected.older_cursor === null
      )
        break;
      const cursor = selected.older_cursor;
      await this.loadOlder(conversationId, cursor);
      const next = this.selected;
      if (
        next?.conversation.conversation_id !== conversationId ||
        next.older_cursor === cursor ||
        (next.messages[0]?.sequence ?? earliest) >= earliest
      )
        break;
    }
    const selected = this.selected;
    if (selected?.conversation.conversation_id !== conversationId) return;
    if (selected.messages.some((m) => m.message_id === messageId))
      this.selected = { ...selected, highlight_message_id: messageId };
    else
      this.notice = {
        kind: "info",
        text: "That message is not loaded (in-memory limit reached).",
      };
  }

  /**
   * Advances the read cursor to the latest message only once the first unread
   * message is actually loaded and the viewer is looking at the bottom of a
   * focused view; unread history on older pages stays unread.
   */
  private async markReadIfBoundaryLoaded(): Promise<void> {
    const selected = this.selected;
    if (!selected) return;
    if (!this.viewport.focused || !this.viewport.atBottom) return;
    const firstUnread = selected.conversation.first_unread_sequence;
    const last = selected.conversation.last_sequence;
    if (firstUnread === null || last <= selected.conversation.read_cursor)
      return;
    const earliest = selected.messages[0]?.sequence;
    const exhausted = selected.older_cursor === null && !selected.older_blocked;
    const boundaryLoaded =
      exhausted || (earliest !== undefined && earliest <= firstUnread);
    if (boundaryLoaded)
      await this.markRead(selected.conversation.conversation_id, last);
  }

  private async loadOlder(
    conversationId: string,
    cursor: string,
  ): Promise<void> {
    if (this.selected?.conversation.conversation_id !== conversationId) return;
    if (this.selected.older_cursor !== cursor) return;
    const page = await this.service.openConversation(
      this.viewer,
      conversationId,
      { before: cursor, limit: this.pageSize },
    );
    if (!page.ok) {
      this.failed(page.code, conversationId);
      if (!this.notice)
        this.notice = {
          kind: "error",
          text: "Older history is not available.",
        };
      return;
    }
    if (this.selected?.conversation.conversation_id !== conversationId) return;
    const known = new Set(this.selected.messages.map((m) => m.message_id));
    const older = page.value.messages.filter((m) => !known.has(m.message_id));
    const messages = [...older, ...this.selected.messages];
    // Never drop a fetched page: once the in-memory cap is reached the older
    // cursor is withheld (and flagged as blocked, not exhausted) instead of
    // silently skipping history.
    const blocked =
      page.value.older_cursor !== null && messages.length >= this.maxLoaded;
    this.selected = {
      ...this.selected,
      messages,
      older_cursor: blocked ? null : page.value.older_cursor,
      older_blocked: blocked,
    };
    await this.markReadIfBoundaryLoaded();
  }

  /** Re-reads the selected conversation keeping everything already loaded plus `grow` new messages. */
  private async reloadSelected(grow: number): Promise<void> {
    if (!this.selected) return;
    const id = this.selected.conversation.conversation_id;
    const limit = Math.min(
      this.maxLoaded,
      Math.max(this.pageSize, this.selected.messages.length + grow),
    );
    const page = await this.service.openConversation(this.viewer, id, {
      limit,
    });
    if (!page.ok) {
      this.failed(page.code, id);
      if (!REMOVAL_CODES.has(page.code)) return;
      this.selected = null;
      this.panel = null;
      return;
    }
    if (this.selected?.conversation.conversation_id !== id) return;
    const blocked =
      page.value.older_cursor !== null &&
      page.value.messages.length >= this.maxLoaded;
    this.selected = {
      ...this.selected,
      conversation: page.value.conversation,
      messages: page.value.messages,
      older_cursor: blocked ? null : page.value.older_cursor,
      older_blocked: blocked,
    };
    this.reconcilePending();
  }

  /** A pending send whose `client_message_id` is now in the loaded history was acknowledged out of band. */
  private reconcilePending(): void {
    if (!this.selected) return;
    const committed = new Set(
      this.selected.messages.map((m) => m.client_message_id),
    );
    for (const item of [...this.pending])
      if (committed.has(item.client_message_id))
        this.removePending(item.client_message_id);
  }

  private async markRead(
    conversationId: string,
    sequence: number,
  ): Promise<void> {
    const result = await this.service.markRead(
      this.viewer,
      conversationId,
      sequence,
    );
    if (!result.ok) {
      this.failed(result.code, conversationId);
      return;
    }
    await this.refreshInbox();
    if (this.selected?.conversation.conversation_id === conversationId) {
      const summary = this.conversations.find(
        (c) => c.conversation_id === conversationId,
      );
      if (summary) this.selected = { ...this.selected, conversation: summary };
    }
  }

  private async runSearch(query: string): Promise<void> {
    const result = await this.service.searchMessages(this.viewer, query, null);
    if (!result.ok) {
      this.search = { query, hits: [] };
      this.failed(result.code);
      return;
    }
    const visible = new Set(this.conversations.map((c) => c.conversation_id));
    this.search = {
      query: result.value.query,
      hits: result.value.hits.filter((h) => visible.has(h.conversation_id)),
    };
  }

  // ---------------------------------------------------------------- writes

  private async send(input: SendMessageInput): Promise<void> {
    const existing = this.pending.find(
      (p) => p.client_message_id === input.client_message_id,
    );
    if (existing?.status === "pending") return;
    if (existing) {
      existing.status = "pending";
      existing.reason = null;
    } else
      this.pending.push({
        client_message_id: input.client_message_id,
        conversation_id: input.conversation_id,
        body: input.body,
        reference_count: input.references.length,
        reply_to: input.reply_to,
        status: "pending",
        reason: null,
      });
    this.pendingInputs.set(input.client_message_id, input);
    this.notice = null;
    this.emit();
    const delay = this.options.sendDelayMs ?? 0;
    if (delay > 0) await (this.options.sleep ?? defaultSleep)(delay);
    if (this.disposedFlag) return;
    const result: TeamResult<{ sequence: number; duplicate: boolean }> =
      await this.service.sendMessage(this.viewer, input);
    const item = this.pending.find(
      (p) => p.client_message_id === input.client_message_id,
    );
    if (!item) return;
    if (result.ok) {
      this.removePending(input.client_message_id);
      await this.refreshInbox();
      await this.reloadSelected(result.value.duplicate ? 0 : 1);
      if (this.viewport.focused && this.viewport.atBottom)
        await this.markRead(input.conversation_id, result.value.sequence);
    } else if (
      REMOVAL_CODES.has(result.code) &&
      this.conversations.some(
        (c) => c.conversation_id === input.conversation_id,
      )
    ) {
      this.failed(result.code, input.conversation_id);
    } else {
      item.status =
        result.code === "conflict" || result.code === "client_message_id_reused"
          ? "conflict"
          : "failed";
      item.reason = SEND_FAILURE_TEXT[result.code];
      if (result.code === "unauthorized") this.failed(result.code);
    }
    this.emit();
  }

  private removePending(clientMessageId: string): void {
    const index = this.pending.findIndex(
      (p) => p.client_message_id === clientMessageId,
    );
    if (index !== -1) this.pending.splice(index, 1);
    this.pendingInputs.delete(clientMessageId);
  }

  private async togglePin(conversationId: string): Promise<void> {
    const summary = this.conversations.find(
      (c) => c.conversation_id === conversationId,
    );
    if (!summary) return;
    const result = await this.service.setPinned(
      this.viewer,
      conversationId,
      !summary.pinned,
    );
    if (!result.ok) {
      this.failed(result.code, conversationId);
      return;
    }
    await this.refreshInbox();
    if (this.selected?.conversation.conversation_id === conversationId)
      this.selected = {
        ...this.selected,
        conversation: {
          ...this.selected.conversation,
          pinned: result.value.pinned,
        },
      };
  }

  private async toggleReaction(
    messageId: string,
    emoji: Parameters<TeamService["setReaction"]>[2],
  ): Promise<void> {
    if (!this.service.capabilities.reactions) return;
    const message = this.selected?.messages.find(
      (m) => m.message_id === messageId,
    );
    if (!message) return;
    const conversationId = message.conversation_id;
    const mine = message.reactions.some((r) => r.emoji === emoji && r.mine);
    const result = await this.service.setReaction(
      this.viewer,
      messageId,
      emoji,
      !mine,
    );
    if (!result.ok) {
      this.failed(result.code, conversationId);
      return;
    }
    if (!this.selected) return;
    const messages: MessageView[] = this.selected.messages.map((m) =>
      m.message_id === messageId
        ? { ...m, reactions: result.value.reactions }
        : m,
    );
    this.selected = { ...this.selected, messages };
  }

  private async openReference(
    messageId: string,
    referenceId: string,
  ): Promise<void> {
    const result = await this.service.resolveReference(
      this.viewer,
      messageId,
      referenceId,
    );
    if (!result.ok) {
      this.panel = null;
      this.notice = { kind: "error", text: "That reference is not available." };
      return;
    }
    this.panel = {
      message_id: messageId,
      reference_id: referenceId,
      preview: result.value,
    };
  }

  private async switchViewer(userId: string): Promise<void> {
    if (this.service.label !== "FIXTURE") return;
    if (!this.service.users().some((u) => u.user_id === userId)) return;
    this.viewer = userId;
    this.selected = null;
    this.panel = null;
    this.notice = null;
    this.search = null;
    this.pending.splice(0, this.pending.length);
    this.pendingInputs.clear();
    await this.refreshInbox();
    const first = this.conversations[0];
    if (first) await this.select(first.conversation_id);
  }

  private announce(conversation: ConversationSummary, count: number): void {
    this.announcementSeq += 1;
    const where = conversation.title;
    this.announcement = {
      seq: this.announcementSeq,
      text:
        count === 1
          ? `New message in ${where}`
          : `${count} new messages in ${where}`,
    };
  }

  // ---------------------------------------------------------------- state

  snapshot(): TeamChatViewState {
    const users = this.service.users();
    const me = this.me();
    const viewer = users.find((u) => u.user_id === me) ?? {
      user_id: me,
      handle: me === this.viewer ? "unknown" : me,
      display_name: me === this.viewer ? "Unknown member" : me,
    };
    return {
      label: this.service.label,
      capabilities: { ...this.service.capabilities },
      connection: this.connection,
      viewer,
      viewers: this.service.label === "FIXTURE" ? users : [],
      conversations: this.conversations,
      selected: this.selected,
      pending: this.pending.map((p) => ({ ...p })),
      panel: this.panel,
      mention_index: this.service.mentionIndex(this.viewer),
      notice: this.notice,
      search: this.search,
      announcement: this.announcement,
    };
  }

  private emit(): void {
    if (this.disposedFlag) return;
    this.options.post(this.snapshot());
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
