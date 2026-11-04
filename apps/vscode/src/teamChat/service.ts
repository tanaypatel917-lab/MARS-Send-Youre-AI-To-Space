import type { ReferenceChip } from "@mars/contracts";
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
import {
  type ConversationListItem,
  type ConversationView,
  MIN_SEARCH_QUERY_CHARS,
  type ReactionSummary,
  type SearchHit,
  type MessageView as ServiceMessage,
} from "./protocol";

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
  /** Latest view per conversation; list items also carry the server's counters. */
  private readonly views = new Map<
    string,
    ConversationView &
      Partial<Pick<ConversationListItem, "unread_count" | "last_message_at">>
  >();
  private readonly messages = new Map<string, Map<number, ServiceMessage>>();
  /** Reaction summaries by message id (from history items or `reactions.set`). */
  private readonly reactions = new Map<string, ReactionSummary[]>();

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

  private remember(message: ServiceMessage): void {
    let cached = this.messages.get(message.conversation_id);
    if (!cached) {
      cached = new Map();
      this.messages.set(message.conversation_id, cached);
    }
    cached.set(message.seq, message);
    if (message.reactions)
      this.reactions.set(message.message_id, message.reactions);
    if (cached.size > MAX_CACHED_PER_CONVERSATION) {
      const seqs = [...cached.keys()].sort((a, b) => a - b);
      for (const seq of seqs.slice(
        0,
        cached.size - MAX_CACHED_PER_CONVERSATION,
      ))
        cached.delete(seq);
    }
  }

  private cachedSorted(conversationId: string): ServiceMessage[] {
    const cached = this.messages.get(conversationId);
    if (!cached) return [];
    return [...cached.values()].sort((a, b) => a.seq - b.seq);
  }

  private findMessage(messageId: string): ServiceMessage | undefined {
    for (const cached of this.messages.values())
      for (const m of cached.values()) if (m.message_id === messageId) return m;
    return undefined;
  }

  // ---------------------------------------------------------------- views

  private summary(
    view: ConversationView &
      Partial<Pick<ConversationListItem, "unread_count" | "last_message_at">>,
    me: string,
  ): ConversationSummary {
    const { conversation, participant, members } = view;
    const floor = Math.max(participant.read_seq, participant.joined_seq);
    const cached = this.cachedSorted(conversation.conversation_id);
    const after = cached.filter((m) => m.seq > floor);
    // `conversations.list` carries the server's counter (excludes the
    // viewer's own posts); `conversations.open` does not, so after an open
    // count cached messages by others when the cache covers the unread span,
    // else fall back to the sequence distance.
    const covered =
      after.length === conversation.last_seq - floor &&
      conversation.last_seq >= floor;
    const unread =
      view.unread_count ??
      (covered
        ? after.filter((m) => m.author_id !== me).length
        : Math.max(0, conversation.last_seq - floor));
    const firstUnread = unread > 0 ? firstUnreadSeq(after, floor, me) : null;
    const others = members
      .filter((m) => m.state === "active" && m.user_id !== me)
      .map((m) => m.user_id);
    const title =
      conversation.kind === "group"
        ? (conversation.title ?? "Group")
        : (others[0] ?? "Direct message");
    const last = cached.at(-1);
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
      first_unread_sequence: firstUnread,
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

  private reactionViews(messageId: string): ReactionView[] {
    return (this.reactions.get(messageId) ?? [])
      .filter((r) => r.count > 0)
      .map((r) => ({
        emoji: r.emoji as ReactionEmoji,
        count: r.count,
        mine: r.reacted,
      }));
  }

  private messageView(message: ServiceMessage): MessageView {
    // A reply target is only ever shown from the same conversation; a
    // mismatched id from the server never reveals another thread's text.
    const candidate = message.reply_to
      ? this.findMessage(message.reply_to)
      : undefined;
    const replyTarget =
      candidate && candidate.conversation_id === message.conversation_id
        ? candidate
        : undefined;
    // The server sends per-viewer chips (a restricted chip renders with no
    // path, sha or excerpt); a pre-#66 record without chips fails closed.
    const references: ReferenceView[] = (
      message.references ??
      message.reference_ids.map((id: string) => ({
        reference_id: id,
        restricted: true as const,
      }))
    ).map((chip: ReferenceChip) =>
      chip.restricted
        ? { reference_id: chip.reference_id, state: "restricted" }
        : {
            reference_id: chip.reference_id,
            state: "ok",
            kind: chip.line_start === null ? "file" : "range",
            repo_id: chip.repo_id,
            repo_name: chip.repo_id,
            path: chip.path,
            commit_sha: chip.commit_sha,
            short_sha: chip.commit_sha.slice(0, 7),
            line_start: chip.line_start,
            line_end: chip.line_end,
            symbol: null,
          },
    );
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
            excerpt: message.reply_restricted
              ? ""
              : (message.reply_excerpt ??
                (replyTarget ? excerpt(replyTarget.body) : "")),
          }
        : null,
      reactions: this.reactionViews(message.message_id),
      references,
    };
  }

  private hitView(hit: SearchHit): MessageView {
    const cached = this.findMessage(hit.message_id);
    if (cached) return this.messageView(cached);
    return {
      message_id: hit.message_id,
      conversation_id: hit.conversation_id,
      author_id: hit.author_id,
      author_name: hit.author_id,
      sequence: hit.seq,
      client_message_id: hit.message_id,
      body: `${hit.cut_before ? "…" : ""}${hit.excerpt}${hit.cut_after ? "…" : ""}`,
      created_at: hit.created_at,
      reply_to: null,
      reactions: [],
      references: [],
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
          // The excerpt needs the latest message; a server without
          // `unread_count` (pre-#64) also needs the unread span cached so the
          // count can skip the viewer's own posts (exact up to one page).
          const floor = Math.max(
            view.participant.read_seq,
            view.participant.joined_seq,
          );
          const page =
            view.unread_count === undefined &&
            view.conversation.last_seq > floor
              ? await this.client.history(id, {
                  after_seq: floor,
                  limit: MAX_PAGE,
                })
              : await this.client.history(id, { limit: 1 });
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
      const opened = await this.client.openConversation(conversationId);
      const listed = this.views.get(conversationId);
      const view =
        listed?.unread_count !== undefined &&
        listed.conversation.last_seq === opened.conversation.last_seq &&
        listed.participant.read_seq === opened.participant.read_seq
          ? {
              ...opened,
              unread_count: listed.unread_count,
              last_message_at: listed.last_message_at ?? null,
            }
          : opened;
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
        messages: visible.map((m) => this.messageView(m)),
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
      await this.identity();
      const state = await this.client.setReaction(messageId, emoji, on);
      const rest = (this.reactions.get(messageId) ?? []).filter(
        (r) => r.emoji !== state.emoji,
      );
      if (state.count > 0)
        rest.push({
          emoji: state.emoji,
          count: state.count,
          reacted: state.reacted,
        });
      this.reactions.set(messageId, rest);
      return { reactions: this.reactionViews(messageId) };
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
      await this.identity();
      let hits: ServiceMessage[];
      if (this.serverCapabilities.search) {
        if (needle.length < MIN_SEARCH_QUERY_CHARS)
          return { query: needle, hits: [] };
        const response = await this.client.search(
          needle,
          conversationId,
          MAX_SEARCH_HITS,
        );
        return {
          query: needle,
          hits: response.hits
            .filter((h) => this.views.has(h.conversation_id))
            .map((h) => this.hitView(h)),
        };
      }
      {
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
      return { query: needle, hits: hits.map((m) => this.messageView(m)) };
    });
  }

  mentionIndex(): MentionIndex {
    return { repos: [] };
  }
}

/**
 * First unread sequence the read-cursor gate may trust: walks the cache from
 * `floor + 1` and stops at the first message by someone else, but only while
 * the cache is contiguous — an uncached gap means unseen messages may hide
 * there, so the conservative `floor + 1` is kept.
 */
function firstUnreadSeq(
  after: readonly ServiceMessage[],
  floor: number,
  me: string,
): number {
  let seq = floor + 1;
  for (const message of after) {
    if (message.seq !== seq) return floor + 1;
    if (message.author_id !== me) return seq;
    seq += 1;
  }
  return floor + 1;
}
