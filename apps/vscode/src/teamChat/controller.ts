import {
  type ConversationSummary,
  FIXTURE_USERS,
  FixtureTeamService,
  type MessageView,
  type SendMessageInput,
  type TeamErrorCode,
  type TeamService,
} from "@mars/team-chat";
import {
  type PendingSend,
  type SelectedConversation,
  type TeamChatNotice,
  type TeamChatViewState,
  type TeamChatWebviewMessage,
  TeamChatWebviewMessageSchema,
} from "./messages";

export interface TeamChatControllerOptions {
  post: (state: TeamChatViewState) => void;
  service?: TeamService;
  viewer?: string;
  /** Messages per history page; small by default so pagination is visible on the fixture. */
  pageSize?: number;
  /** Simulated acknowledgement delay so pending state is observable. */
  sendDelayMs?: number;
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
  reply_outside_conversation: "The reply target is not in this conversation.",
  reference_not_attachable:
    "A reference could not be attached: no access to that repo or unknown revision.",
  too_many_references: "Too many references on one message.",
  empty_message: "Nothing to send.",
};

/**
 * Extension-host state machine for the Team Chat prototype. The webview only
 * sends validated intents; every read and write goes through the injected
 * `TeamService` with a host-chosen viewer, and the webview receives view state
 * only (no tokens, no service handles, no fixture internals).
 */
export class TeamChatController {
  private readonly service: TeamService;
  private readonly pageSize: number;
  private viewer: string;
  private conversations: ConversationSummary[] = [];
  private selected: SelectedConversation | null = null;
  private readonly pending: PendingSend[] = [];
  private readonly pendingInputs = new Map<string, SendMessageInput>();
  private panel: TeamChatViewState["panel"] = null;
  private notice: TeamChatNotice | null = null;
  private disposedFlag = false;

  constructor(private readonly options: TeamChatControllerOptions) {
    this.service = options.service ?? new FixtureTeamService();
    this.pageSize = Math.max(1, options.pageSize ?? DEFAULT_PAGE_SIZE);
    this.viewer = options.viewer ?? FIXTURE_USERS.ada;
  }

  get disposed(): boolean {
    return this.disposedFlag;
  }

  get currentViewer(): string {
    return this.viewer;
  }

  dispose(): void {
    this.disposedFlag = true;
  }

  /** Validates and dispatches one untrusted webview message. */
  async handleMessage(raw: unknown): Promise<boolean> {
    const parsed = TeamChatWebviewMessageSchema.safeParse(raw);
    if (!parsed.success || this.disposedFlag) return false;
    await this.dispatch(parsed.data);
    return true;
  }

  private async dispatch(message: TeamChatWebviewMessage): Promise<void> {
    switch (message.type) {
      case "ready":
        this.refreshInbox();
        if (!this.selected) {
          const first = this.conversations[0];
          if (first) this.select(first.conversation_id);
        }
        return this.emit();
      case "selectConversation":
        this.select(message.conversationId);
        return this.emit();
      case "loadOlder":
        this.loadOlder(message.conversationId, message.cursor);
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
        if (!input) return;
        return this.send(input);
      }
      case "discardSend":
        this.removePending(message.clientMessageId);
        return this.emit();
      case "markRead":
        this.markRead(message.conversationId, message.sequence);
        return this.emit();
      case "togglePin":
        this.togglePin(message.conversationId);
        return this.emit();
      case "toggleReaction":
        this.toggleReaction(message.messageId, message.emoji);
        return this.emit();
      case "openReference":
        this.openReference(message.messageId, message.referenceId);
        return this.emit();
      case "closeReference":
        this.panel = null;
        return this.emit();
      case "fixtureSwitchViewer":
        this.switchViewer(message.userId);
        return this.emit();
    }
  }

  // ---------------------------------------------------------------- reads

  private refreshInbox(): void {
    const result = this.service.listConversations(this.viewer);
    this.conversations = result.ok ? result.value : [];
    if (!result.ok) this.selected = null;
  }

  private select(conversationId: string): void {
    this.notice = null;
    if (this.selected?.conversation.conversation_id !== conversationId)
      this.panel = null;
    const page = this.service.openConversation(this.viewer, conversationId, {
      limit: this.pageSize,
    });
    if (!page.ok) {
      this.selected = null;
      this.notice = {
        kind: "error",
        text: "That conversation is not available.",
      };
      return;
    }
    const cursor = page.value.conversation.read_cursor;
    const firstUnread = page.value.messages.find((m) => m.sequence > cursor);
    this.selected = {
      conversation: page.value.conversation,
      messages: page.value.messages,
      older_cursor: page.value.older_cursor,
      divider_sequence:
        page.value.conversation.unread_count > 0
          ? (firstUnread?.sequence ?? null)
          : null,
    };
    const last = page.value.conversation.last_sequence;
    if (last > cursor) this.markRead(conversationId, last);
  }

  private loadOlder(conversationId: string, cursor: string): void {
    if (this.selected?.conversation.conversation_id !== conversationId) return;
    if (this.selected.older_cursor !== cursor) return;
    const page = this.service.openConversation(this.viewer, conversationId, {
      before: cursor,
      limit: this.pageSize,
    });
    if (!page.ok) {
      this.notice = { kind: "error", text: "Older history is not available." };
      return;
    }
    const known = new Set(this.selected.messages.map((m) => m.message_id));
    const older = page.value.messages.filter((m) => !known.has(m.message_id));
    this.selected = {
      ...this.selected,
      messages: [...older, ...this.selected.messages].slice(-MAX_LOADED),
      older_cursor: page.value.older_cursor,
    };
  }

  /** Re-reads the selected conversation keeping everything already loaded plus `grow` new messages. */
  private reloadSelected(grow: number): void {
    if (!this.selected) return;
    const id = this.selected.conversation.conversation_id;
    const limit = Math.min(
      MAX_LOADED,
      Math.max(this.pageSize, this.selected.messages.length + grow),
    );
    const page = this.service.openConversation(this.viewer, id, { limit });
    if (!page.ok) {
      this.selected = null;
      this.panel = null;
      return;
    }
    this.selected = {
      ...this.selected,
      conversation: page.value.conversation,
      messages: page.value.messages,
      older_cursor: page.value.older_cursor,
    };
  }

  private markRead(conversationId: string, sequence: number): void {
    const result = this.service.markRead(this.viewer, conversationId, sequence);
    if (!result.ok) return;
    this.refreshInbox();
    if (this.selected?.conversation.conversation_id === conversationId) {
      const summary = this.conversations.find(
        (c) => c.conversation_id === conversationId,
      );
      if (summary) this.selected = { ...this.selected, conversation: summary };
    }
  }

  // ---------------------------------------------------------------- writes

  private async send(input: SendMessageInput): Promise<void> {
    const existing = this.pending.find(
      (p) => p.client_message_id === input.client_message_id,
    );
    if (existing?.status === "pending") return;
    if (existing) existing.status = "pending";
    else
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
    const result = this.service.sendMessage(this.viewer, input);
    const item = this.pending.find(
      (p) => p.client_message_id === input.client_message_id,
    );
    if (!item) return;
    if (result.ok) {
      this.removePending(input.client_message_id);
      this.refreshInbox();
      this.reloadSelected(result.value.duplicate ? 0 : 1);
      this.markRead(input.conversation_id, result.value.sequence);
    } else {
      item.status = "failed";
      item.reason = SEND_FAILURE_TEXT[result.code];
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

  private togglePin(conversationId: string): void {
    const summary = this.conversations.find(
      (c) => c.conversation_id === conversationId,
    );
    if (!summary) return;
    const result = this.service.setPinned(
      this.viewer,
      conversationId,
      !summary.pinned,
    );
    if (!result.ok) return;
    this.refreshInbox();
    if (this.selected?.conversation.conversation_id === conversationId)
      this.selected = {
        ...this.selected,
        conversation: {
          ...this.selected.conversation,
          pinned: result.value.pinned,
        },
      };
  }

  private toggleReaction(
    messageId: string,
    emoji: Parameters<TeamService["setReaction"]>[2],
  ): void {
    const message = this.selected?.messages.find(
      (m) => m.message_id === messageId,
    );
    if (!message) return;
    const mine = message.reactions.some((r) => r.emoji === emoji && r.mine);
    const result = this.service.setReaction(
      this.viewer,
      messageId,
      emoji,
      !mine,
    );
    if (!result.ok) return;
    if (!this.selected) return;
    const messages: MessageView[] = this.selected.messages.map((m) =>
      m.message_id === messageId
        ? { ...m, reactions: result.value.reactions }
        : m,
    );
    this.selected = { ...this.selected, messages };
  }

  private openReference(messageId: string, referenceId: string): void {
    const result = this.service.resolveReference(
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

  private switchViewer(userId: string): void {
    if (!this.service.users().some((u) => u.user_id === userId)) return;
    this.viewer = userId;
    this.selected = null;
    this.panel = null;
    this.notice = null;
    this.pending.splice(0, this.pending.length);
    this.pendingInputs.clear();
    this.refreshInbox();
    const first = this.conversations[0];
    if (first) this.select(first.conversation_id);
  }

  // ---------------------------------------------------------------- state

  snapshot(): TeamChatViewState {
    const users = this.service.users();
    const viewer = users.find((u) => u.user_id === this.viewer) ?? {
      user_id: this.viewer,
      handle: "unknown",
      display_name: "Unknown member",
    };
    return {
      label: this.service.label,
      viewer,
      viewers: users,
      conversations: this.conversations,
      selected: this.selected,
      pending: this.pending.map((p) => ({ ...p })),
      panel: this.panel,
      mention_index: this.service.mentionIndex(this.viewer),
      notice: this.notice,
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
