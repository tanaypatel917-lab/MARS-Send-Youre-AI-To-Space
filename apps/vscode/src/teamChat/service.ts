import type { Message, Reaction } from "@mars/contracts";
import {
  type ConversationPage,
  type ConversationSummary,
  fail,
  MAX_SEARCH_HITS,
  MAX_SEARCH_QUERY_CHARS,
  type MentionIndex,
  type MessageView,
  type ReactionEmoji,
  type ReactionView,
  type ReferencePreview,
  type ReferenceView,
  type SearchResult,
  type SendMessageInput,
  type SendResult,
  succeed,
  type TeamCapabilities,
  type TeamErrorCode,
  type TeamResult,
  type TeamService,
  type UserView,
} from "@mars/team-chat";
import { isRpcError, type RpcError } from "../rpc";
import type { TeamClient } from "./client";
import type { ConversationView } from "./protocol";

const CURSOR_PREFIX = "seq:";
const EXCERPT_CHARS = 80;
const DEFAULT_PAGE = 20;
const MAX_PAGE = 200;
/** Messages kept per conversation in the host cache; older pages are re-fetched on demand. */
const MAX_CACHED_PER_CONVERSATION = 1000;

function excerpt(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length <= EXCERPT_CHARS
    ? flat
    : `${flat.slice(0, EXCERPT_CHARS - 1)}…`;
}

function decodeCursor(cursor: string): number | null {
  if (!cursor.startsWith(CURSOR_PREFIX)) return null;
  const n = Number(cursor.slice(CURSOR_PREFIX.length));
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * Maps transport failures to the fixed `TeamErrorCode` vocabulary. Only the
 * kind/code is inspected; server text never reaches the view.
 */
export function teamErrorCode(error: unknown): TeamErrorCode {
  if (!isRpcError(error)) return "unavailable";
  const rpc = error as RpcError;
  switch (rpc.kind) {
    case "no-token":
    case "unauthorized":
      return "unauthorized";
    case "forbidden":
      return "forbidden";
    case "not-found":
      return "not_found";
    case "conflict":
      return "conflict";
    case "server":
      return rpc.code === "invalid_request" || rpc.code === "too_large"
        ? "invalid"
        : "unavailable";
    default:
      return "unavailable";
  }
}

/**
 * `TeamService` over the authenticated `@mars/team` RPC. Runs in the extension
 * host; the `viewer` parameter is ignored in favour of the server-derived
 * `user_id`. Conversation views and messages are cached so delivery events
 * (metadata only) can be turned into targeted `messages.history` reads, and
 * a `not_found`/`forbidden` answer for a known conversation purges its cache.
 *
 * Reference ids on a service message render as restricted chips: there is no
 * reference resolution method yet, so the adapter fails closed.
 */
export class RpcTeamService implements TeamService {
  readonly label = "SERVICE" as const;
  private serverCapabilities: TeamCapabilities = {
    reactions: false,
    search: false,
    realtime: false,
  };
  private readonly views = new Map<string, ConversationView>();
  private readonly messages = new Map<string, Map<number, Message>>();
  private readonly reactions = new Map<string, Reaction[]>();

  constructor(private readonly client: TeamClient) {}

  get capabilities(): TeamCapabilities {
    return { ...this.serverCapabilities };
  }

  /** The authenticated user id, once `team.describe` has answered. */
  get userId(): string | undefined {
    return this.client.identity?.user_id;
  }

  currentUser(): string | undefined {
    return this.userId;
  }

  /** Whether the server advertises `POST /v1/stream`. */
  get streamSupported(): boolean {
    return this.client.identity?.capabilities.stream ?? false;
  }

  /** Drops every cached record (token cleared or source changed). */
  forgetAll(): void {
    this.views.clear();
    this.messages.clear();
    this.reactions.clear();
    this.client.forget();
  }

  /** Drops one conversation's cache after the server denied access to it. */
  forgetConversation(conversationId: string): void {
    this.views.delete(conversationId);
    const cached = this.messages.get(conversationId);
    if (cached)
      for (const m of cached.values()) this.reactions.delete(m.message_id);
    this.messages.delete(conversationId);
  }

  private async identity(): Promise<string> {
    const known = this.client.identity;
    if (known) return known.user_id;
    const described = await this.client.describe();
    this.serverCapabilities = {
      reactions: described.capabilities.reactions,
      search: described.capabilities.search,
      realtime: true,
    };
    return described.user_id;
  }

  private async guard<T>(
    conversationId: string | null,
    work: () => Promise<T>,
  ): Promise<TeamResult<T>> {
    try {
      return succeed(await work());
    } catch (error) {
      const code = teamErrorCode(error);
      if (conversationId && (code === "not_found" || code === "forbidden"))
        this.forgetConversation(conversationId);
      if (code === "unauthorized") this.client.forget();
      return fail(code);
    }
  }

  // ---------------------------------------------------------------- cache

  private remember(message: Message): void {
    let cached = this.messages.get(message.conversation_id);
    if (!cached) {
      cached = new Map();
      this.messages.set(message.conversation_id, cached);
    }
    cached.set(message.seq, message);
    if (cached.size > MAX_CACHED_PER_CONVERSATION) {
      const seqs = [...cached.keys()].sort((a, b) => a - b);
      for (const seq of seqs.slice(
        0,
        cached.size - MAX_CACHED_PER_CONVERSATION,
      ))
        cached.delete(seq);
    }
  }

  private cachedSorted(conversationId: string): Message[] {
    const cached = this.messages.get(conversationId);
    if (!cached) return [];
    return [...cached.values()].sort((a, b) => a.seq - b.seq);
  }

  private findMessage(messageId: string): Message | undefined {
    for (const cached of this.messages.values())
      for (const m of cached.values()) if (m.message_id === messageId) return m;
    return undefined;
  }

  // ---------------------------------------------------------------- views

  private summary(view: ConversationView, me: string): ConversationSummary {
    const { conversation, participant, members } = view;
    const floor = Math.max(participant.read_seq, participant.joined_seq);
    const unread = Math.max(0, conversation.last_seq - floor);
    const others = members
      .filter((m) => m.state === "active" && m.user_id !== me)
      .map((m) => m.user_id);
    const title =
      conversation.kind === "group"
        ? (conversation.title ?? "Group")
        : (others[0] ?? "Direct message");
    const last = this.cachedSorted(conversation.conversation_id).at(-1);
    return {
      conversation_id: conversation.conversation_id,
      kind: conversation.kind,
      title,
      member_ids: members
        .filter((m) => m.state === "active")
        .map((m) => m.user_id),
      pinned: participant.pinned,
      read_cursor: participant.read_seq,
      last_sequence: conversation.last_seq,
      unread_count: unread,
      first_unread_sequence: unread > 0 ? floor + 1 : null,
      last_message:
        last && last.seq > participant.joined_seq
          ? {
              author_id: last.author_id,
              excerpt: last.deleted ? "" : excerpt(last.body),
              created_at: last.created_at,
            }
          : null,
    };
  }

  private reactionViews(messageId: string, me: string): ReactionView[] {
    const counts = new Map<string, ReactionView>();
    for (const r of this.reactions.get(messageId) ?? []) {
      const view = counts.get(r.emoji) ?? {
        emoji: r.emoji as ReactionEmoji,
        count: 0,
        mine: false,
      };
      view.count += 1;
      if (r.user_id === me) view.mine = true;
      counts.set(r.emoji, view);
    }
    return [...counts.values()];
  }

  private messageView(message: Message, me: string): MessageView {
    const replyTarget = message.reply_to
      ? this.findMessage(message.reply_to)
      : undefined;
    const references: ReferenceView[] = message.reference_ids.map((id) => ({
      reference_id: id,
      state: "restricted",
    }));
    return {
      message_id: message.message_id,
      conversation_id: message.conversation_id,
      author_id: message.author_id,
      author_name: message.author_id,
      sequence: message.seq,
      client_message_id: message.client_message_id,
      body: message.deleted ? "" : message.body,
      created_at: message.created_at,
      reply_to: message.reply_to
        ? {
            message_id: message.reply_to,
            author_name: replyTarget?.author_id ?? "Unknown member",
            excerpt: replyTarget ? excerpt(replyTarget.body) : "",
          }
        : null,
      reactions: this.reactionViews(message.message_id, me),
      references,
    };
  }

  // ---------------------------------------------------------------- TeamService

  users(): UserView[] {
    const ids = new Set<string>();
    const me = this.client.identity?.user_id;
    if (me) ids.add(me);
    for (const view of this.views.values())
      for (const m of view.members) ids.add(m.user_id);
    return [...ids].sort().map((user_id) => ({
      user_id,
      handle: user_id,
      display_name: user_id,
    }));
  }

  listConversations(): Promise<TeamResult<ConversationSummary[]>> {
    return this.guard(null, async () => {
      const me = await this.identity();
      const views = await this.client.listConversations();
      const seen = new Set<string>();
      for (const view of views) {
        seen.add(view.conversation.conversation_id);
        this.views.set(view.conversation.conversation_id, view);
      }
      for (const id of [...this.views.keys()])
        if (!seen.has(id)) this.forgetConversation(id);
      for (const view of views) {
        const id = view.conversation.conversation_id;
        const latest = this.cachedSorted(id).at(-1)?.seq ?? -1;
        if (
          view.conversation.last_seq > view.participant.joined_seq &&
          latest < view.conversation.last_seq
        ) {
          const page = await this.client.history(id, { limit: 1 });
          for (const m of page) this.remember(m);
        }
      }
      const summaries = views.map((v) => this.summary(v, me));
      summaries.sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        const ta = a.last_message?.created_at ?? "";
        const tb = b.last_message?.created_at ?? "";
        if (ta !== tb) return ta < tb ? 1 : -1;
        return a.conversation_id < b.conversation_id ? -1 : 1;
      });
      return summaries;
    });
  }

  openConversation(
    _viewer: string,
    conversationId: string,
    options: { before?: string | null; limit?: number } = {},
  ): Promise<TeamResult<ConversationPage>> {
    let before: number | undefined;
    if (options.before) {
      const decoded = decodeCursor(options.before);
      if (decoded === null) return Promise.resolve(fail("invalid"));
      before = decoded;
    }
    const limit = Math.min(
      MAX_PAGE,
      Math.max(1, Math.floor(options.limit ?? DEFAULT_PAGE)),
    );
    return this.guard(conversationId, async () => {
      const me = await this.identity();
      const view = await this.client.openConversation(conversationId);
      this.views.set(conversationId, view);
      const window =
        before === undefined ? { limit } : { before_seq: before, limit };
      const page = await this.client.history(conversationId, window);
      for (const m of page) this.remember(m);
      const floor = view.participant.joined_seq;
      const visible = page.filter((m) => m.seq > floor);
      const first = visible[0];
      const olderExists =
        first !== undefined && first.seq > floor + 1 && page.length >= limit;
      return {
        conversation: this.summary(view, me),
        messages: visible.map((m) => this.messageView(m, me)),
        older_cursor:
          olderExists && first ? `${CURSOR_PREFIX}${first.seq}` : null,
      };
    });
  }

  sendMessage(
    _viewer: string,
    input: SendMessageInput,
  ): Promise<TeamResult<SendResult>> {
    if (input.body.trim().length === 0)
      return Promise.resolve(fail("empty_message"));
    if (input.references.length > 0)
      return Promise.resolve(fail("reference_not_attachable"));
    return this.guard(input.conversation_id, async () => {
      await this.identity();
      const known = this.cachedSorted(input.conversation_id).find(
        (m) => m.client_message_id === input.client_message_id,
      );
      const message = await this.client.send({
        conversation_id: input.conversation_id,
        client_message_id: input.client_message_id,
        body: input.body,
        ...(input.reply_to ? { reply_to: input.reply_to } : {}),
      });
      this.remember(message);
      return {
        message_id: message.message_id,
        sequence: message.seq,
        duplicate:
          known !== undefined && known.message_id === message.message_id,
      };
    });
  }

  markRead(
    _viewer: string,
    conversationId: string,
    sequence: number,
  ): Promise<TeamResult<{ read_cursor: number }>> {
    return this.guard(conversationId, async () => {
      await this.identity();
      const participant = await this.client.markRead(conversationId, sequence);
      const view = this.views.get(conversationId);
      if (view) this.views.set(conversationId, { ...view, participant });
      return { read_cursor: participant.read_seq };
    });
  }

  setPinned(
    _viewer: string,
    conversationId: string,
    pinned: boolean,
  ): Promise<TeamResult<{ pinned: boolean }>> {
    return this.guard(conversationId, async () => {
      await this.identity();
      const participant = await this.client.pin(conversationId, pinned);
      const view = this.views.get(conversationId);
      if (view) this.views.set(conversationId, { ...view, participant });
      return { pinned: participant.pinned };
    });
  }

  setReaction(
    _viewer: string,
    messageId: string,
    emoji: ReactionEmoji,
    on: boolean,
  ): Promise<TeamResult<{ reactions: ReactionView[] }>> {
    const message = this.findMessage(messageId);
    if (!message) return Promise.resolve(fail("not_found"));
    if (!this.serverCapabilities.reactions)
      return Promise.resolve(fail("invalid"));
    return this.guard(message.conversation_id, async () => {
      const me = await this.identity();
      const reactions = await this.client.setReaction(messageId, emoji, on);
      this.reactions.set(messageId, reactions);
      return { reactions: this.reactionViews(messageId, me) };
    });
  }

  resolveReference(
    _viewer: string,
    _messageId: string,
    referenceId: string,
  ): TeamResult<ReferencePreview> {
    return succeed({ state: "restricted", reference_id: referenceId });
  }

  searchMessages(
    _viewer: string,
    query: string,
    conversationId?: string | null,
  ): Promise<TeamResult<SearchResult>> {
    const needle = query.trim();
    if (needle.length === 0 || needle.length > MAX_SEARCH_QUERY_CHARS)
      return Promise.resolve(fail("invalid"));
    return this.guard(conversationId ?? null, async () => {
      const me = await this.identity();
      let hits: Message[];
      if (this.serverCapabilities.search) {
        hits = await this.client.search(
          needle,
          conversationId,
          MAX_SEARCH_HITS,
        );
        for (const m of hits) this.remember(m);
        hits = hits.filter((m) => this.views.has(m.conversation_id));
      } else {
        // Local fallback over the host cache: only conversations the server
        // already listed for this viewer are cached, so membership holds.
        const lower = needle.toLowerCase();
        hits = [];
        for (const [id, cached] of this.messages)
          if (!conversationId || id === conversationId)
            for (const m of cached.values())
              if (!m.deleted && m.body.toLowerCase().includes(lower))
                hits.push(m);
        hits.sort((a, b) =>
          a.created_at === b.created_at
            ? b.seq - a.seq
            : a.created_at < b.created_at
              ? 1
              : -1,
        );
        hits = hits.slice(0, MAX_SEARCH_HITS);
      }
      return { query: needle, hits: hits.map((m) => this.messageView(m, me)) };
    });
  }

  mentionIndex(): MentionIndex {
    return { repos: [] };
  }
}
