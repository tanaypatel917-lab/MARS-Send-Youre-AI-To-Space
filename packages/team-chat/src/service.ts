import { cloneFixture, FIXTURE } from "./fixture";
import {
  type FixtureDataset,
  FixtureDatasetSchema,
  fail,
  MAX_GROUP_MEMBERS,
  MAX_MESSAGE_CHARS,
  MAX_REFERENCES_PER_MESSAGE,
  type Message,
  type ReactionEmoji,
  ReactionEmojiSchema,
  type Reference,
  type ReferenceInput,
  type ReferenceKind,
  type SendMessageInput,
  SendMessageInputSchema,
  succeed,
  type TeamResult,
} from "./schemas";

// ---------------------------------------------------------------- read models

export interface UserView {
  user_id: string;
  handle: string;
  display_name: string;
}

export interface ConversationSummary {
  conversation_id: string;
  kind: "dm" | "group";
  /** Group title, or the other participant's display name for a DM. */
  title: string;
  member_ids: string[];
  pinned: boolean;
  read_cursor: number;
  last_sequence: number;
  unread_count: number;
  /** First visible unread sequence (join-point aware), or null when nothing is unread. */
  first_unread_sequence: number | null;
  last_message: {
    author_id: string;
    excerpt: string;
    created_at: string;
  } | null;
}

export interface ReactionView {
  emoji: ReactionEmoji;
  count: number;
  mine: boolean;
}

/** Chip metadata. A restricted chip carries no repo, path, SHA or range. */
export type ReferenceView =
  | {
      reference_id: string;
      state: "ok";
      kind: ReferenceKind;
      repo_id: string;
      repo_name: string;
      path: string;
      commit_sha: string;
      short_sha: string;
      line_start: number | null;
      line_end: number | null;
      symbol: string | null;
    }
  | { reference_id: string; state: "restricted" };

export interface MessageView {
  message_id: string;
  conversation_id: string;
  author_id: string;
  author_name: string;
  sequence: number;
  client_message_id: string;
  body: string;
  created_at: string;
  reply_to: {
    message_id: string;
    author_name: string;
    excerpt: string;
  } | null;
  reactions: ReactionView[];
  references: ReferenceView[];
}

export interface ConversationPage {
  conversation: ConversationSummary;
  messages: MessageView[];
  /** Opaque cursor for the next older page, or null at the start of visible history. */
  older_cursor: string | null;
}

export type ReferencePreview =
  | {
      state: "ok";
      reference_id: string;
      kind: ReferenceKind;
      repo_name: string;
      path: string;
      commit_sha: string;
      short_sha: string;
      symbol: string | null;
      lines: { number: number; text: string }[];
      highlight: { start: number; end: number } | null;
    }
  | { state: "restricted"; reference_id: string }
  | { state: "unavailable"; reference_id: string };

export interface MentionFile {
  path: string;
  line_count: number;
  symbols: { name: string; line: number }[];
}

export interface MentionRepo {
  repo_id: string;
  name: string;
  commit_sha: string;
  files: MentionFile[];
}

/** Everything the `@` picker may offer the viewer: only repos they can read. */
export interface MentionIndex {
  repos: MentionRepo[];
}

export interface SendResult {
  message_id: string;
  sequence: number;
  /** True when the client message id was already committed with identical content. */
  duplicate: boolean;
}

export type MaybePromise<T> = T | Promise<T>;

/** `FIXTURE` is the in-memory dataset; `SERVICE` is the authenticated `@mars/team` adapter. */
export type TeamServiceLabel = "FIXTURE" | "SERVICE";

/**
 * Which optional operations the backing service really implements. The
 * fixture answers everything; the RPC adapter reports what `team.describe`
 * advertises so the UI can hide controls instead of failing them.
 */
export interface TeamCapabilities {
  reactions: boolean;
  search: boolean;
  realtime: boolean;
}

export interface SearchResult {
  query: string;
  hits: MessageView[];
}

/**
 * Operation shapes shared by the fixture and the real service. Every method
 * may be synchronous (fixture) or asynchronous (RPC); callers always `await`.
 * `viewer` is the authenticated identity: the fixture takes it as a parameter
 * so tests can switch members, the RPC adapter ignores it and uses the
 * server-derived `user_id`.
 */
export interface TeamService {
  readonly label: TeamServiceLabel;
  readonly capabilities: TeamCapabilities;
  /** Server-derived identity when known (real service); absent for the fixture, whose viewer is a parameter. */
  currentUser?(): string | undefined;
  /** True after the server reported `team.describe.enabled === false` (host kill switch); re-read on every failed call. */
  disabled?(): boolean;
  /** A delivery event said this message changed (edit/delete): drop any cached copy so the next read refetches it. */
  forgetMessage?(conversationId: string, sequence: number): void;
  users(): UserView[];
  listConversations(
    viewer: string,
  ): MaybePromise<TeamResult<ConversationSummary[]>>;
  openConversation(
    viewer: string,
    conversationId: string,
    options?: { before?: string | null; limit?: number },
  ): MaybePromise<TeamResult<ConversationPage>>;
  sendMessage(
    viewer: string,
    input: SendMessageInput,
  ): MaybePromise<TeamResult<SendResult>>;
  markRead(
    viewer: string,
    conversationId: string,
    sequence: number,
  ): MaybePromise<TeamResult<{ read_cursor: number }>>;
  setPinned(
    viewer: string,
    conversationId: string,
    pinned: boolean,
  ): MaybePromise<TeamResult<{ pinned: boolean }>>;
  setReaction(
    viewer: string,
    messageId: string,
    emoji: ReactionEmoji,
    on: boolean,
  ): MaybePromise<TeamResult<{ reactions: ReactionView[] }>>;
  resolveReference(
    viewer: string,
    messageId: string,
    referenceId: string,
  ): MaybePromise<TeamResult<ReferencePreview>>;
  /** Membership-filtered substring search; `conversationId` narrows to one thread. */
  searchMessages(
    viewer: string,
    query: string,
    conversationId?: string | null,
  ): MaybePromise<TeamResult<SearchResult>>;
  mentionIndex(viewer: string): MentionIndex;
}

export interface FixtureTeamServiceOptions {
  dataset?: FixtureDataset;
  /** Deterministic clock for new messages. */
  now?: () => string;
}

const DEFAULT_PAGE = 20;
const MAX_PAGE = 200;
export const MAX_SEARCH_QUERY_CHARS = 200;
export const MAX_SEARCH_HITS = 50;
const EXCERPT_CHARS = 80;
const CURSOR_PREFIX = "seq:";

function excerpt(body: string): string {
  const line = body.replace(/\s+/g, " ").trim();
  return line.length > EXCERPT_CHARS
    ? `${line.slice(0, EXCERPT_CHARS)}…`
    : line;
}

function encodeCursor(sequence: number): string {
  return `${CURSOR_PREFIX}${sequence}`;
}

function decodeCursor(cursor: string): number | null {
  if (!cursor.startsWith(CURSOR_PREFIX)) return null;
  const value = Number(cursor.slice(CURSOR_PREFIX.length));
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Fixed key order so equal references always serialize identically. */
function canonicalReference(r: ReferenceInput): ReferenceInput {
  return {
    kind: r.kind,
    repo_id: r.repo_id,
    commit_sha: r.commit_sha,
    path: r.path,
    line_start: r.line_start,
    line_end: r.line_end,
    symbol: r.symbol,
  };
}

/** Content identity of a send: trimmed body, reply target and canonical references. */
function fingerprintOf(
  body: string,
  replyTo: string | null,
  references: ReferenceInput[],
): string {
  return JSON.stringify([body.trim(), replyTo, references]);
}

function fixedClock(): () => string {
  let minute = 40;
  return () => {
    minute += 1;
    const h = 14 + Math.floor(minute / 60);
    const m = minute % 60;
    return `2026-11-03T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;
  };
}

/**
 * Pure in-memory team service over the fixture dataset. It enforces the plan's
 * access rules on every read: team membership alone grants nothing, a
 * non-participant gets `not_found`, a participant without repo access gets a
 * restricted chip and no metadata. There is no network, no persistence, no
 * delivery stream; PR 2 replaces this with an authenticated service behind the
 * same operation shapes.
 */
export class FixtureTeamService implements TeamService {
  readonly label = "FIXTURE" as const;
  readonly capabilities: TeamCapabilities = {
    reactions: true,
    search: true,
    realtime: false,
  };
  private readonly data: FixtureDataset;
  private readonly now: () => string;
  /** `${author}|${conversation}|${client_message_id}` → committed message + content fingerprint. */
  private readonly sends = new Map<
    string,
    { message_id: string; fingerprint: string }
  >();
  private referenceCounter = 0;

  constructor(options: FixtureTeamServiceOptions = {}) {
    // Re-validated here so a custom dataset gets the same DM/participant invariants.
    this.data = cloneFixture(
      FixtureDatasetSchema.parse(options.dataset ?? FIXTURE),
    );
    this.now = options.now ?? fixedClock();
    for (const message of this.data.messages) {
      const references = this.data.shares
        .filter((share) => share.message_id === message.message_id)
        .map((share) =>
          this.data.references.find(
            (r) => r.reference_id === share.reference_id,
          ),
        )
        .filter((r): r is Reference => r !== undefined)
        .map(canonicalReference);
      this.sends.set(
        this.sendKey(
          message.author_id,
          message.conversation_id,
          message.client_message_id,
        ),
        {
          message_id: message.message_id,
          fingerprint: fingerprintOf(
            message.body,
            message.reply_to,
            references,
          ),
        },
      );
    }
  }

  users(): UserView[] {
    return this.data.users.map((u) => ({
      user_id: u.user_id,
      handle: u.handle,
      display_name: u.display_name,
    }));
  }

  listConversations(viewer: string): TeamResult<ConversationSummary[]> {
    if (!this.teamMember(viewer)) return fail("not_found");
    const summaries = this.data.conversations
      .filter((c) => this.participant(viewer, c.conversation_id) !== undefined)
      .map((c) => this.summary(viewer, c.conversation_id))
      .filter((s): s is ConversationSummary => s !== undefined);
    summaries.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      const ta = a.last_message?.created_at ?? "";
      const tb = b.last_message?.created_at ?? "";
      if (ta !== tb) return ta < tb ? 1 : -1;
      return a.conversation_id < b.conversation_id ? -1 : 1;
    });
    return succeed(summaries);
  }

  openConversation(
    viewer: string,
    conversationId: string,
    options: { before?: string | null; limit?: number } = {},
  ): TeamResult<ConversationPage> {
    const participant = this.participant(viewer, conversationId);
    if (!participant) return fail("not_found");
    const summary = this.summary(viewer, conversationId);
    if (!summary) return fail("not_found");
    const limit = Math.min(
      MAX_PAGE,
      Math.max(1, Math.floor(options.limit ?? DEFAULT_PAGE)),
    );
    let before = Number.POSITIVE_INFINITY;
    if (options.before) {
      const decoded = decodeCursor(options.before);
      if (decoded === null) return fail("invalid");
      before = decoded;
    }
    const visible = this.visibleMessages(viewer, conversationId).filter(
      (m) => m.sequence < before,
    );
    const page = visible.slice(Math.max(0, visible.length - limit));
    const first = page[0];
    const olderExists = first !== undefined && visible.length > page.length;
    return succeed({
      conversation: summary,
      messages: page.map((m) => this.messageView(viewer, m)),
      older_cursor: olderExists && first ? encodeCursor(first.sequence) : null,
    });
  }

  sendMessage(viewer: string, raw: SendMessageInput): TeamResult<SendResult> {
    const parsed = SendMessageInputSchema.safeParse(raw);
    if (!parsed.success) return fail("invalid");
    const input = parsed.data;
    const participant = this.participant(viewer, input.conversation_id);
    if (!participant) return fail("not_found");
    const body = input.body.trim();
    const fingerprint = fingerprintOf(
      body,
      input.reply_to,
      input.references.map(canonicalReference),
    );
    const key = this.sendKey(
      viewer,
      input.conversation_id,
      input.client_message_id,
    );
    const existing = this.sends.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        return fail("client_message_id_reused");
      const message = this.data.messages.find(
        (m) => m.message_id === existing.message_id,
      );
      if (!message) return fail("not_found");
      return succeed({
        message_id: message.message_id,
        sequence: message.sequence,
        duplicate: true,
      });
    }
    if (body.length === 0 && input.references.length === 0)
      return fail("empty_message");
    if (body.length > MAX_MESSAGE_CHARS) return fail("invalid");
    if (input.references.length > MAX_REFERENCES_PER_MESSAGE)
      return fail("too_many_references");
    if (input.reply_to !== null) {
      const target = this.visibleMessages(viewer, input.conversation_id).find(
        (m) => m.message_id === input.reply_to,
      );
      if (!target) return fail("reply_outside_conversation");
    }
    const references: Reference[] = [];
    for (const draft of input.references) {
      if (!this.repoAccess(viewer, draft.repo_id))
        return fail("reference_not_attachable");
      const blob = this.blob(draft.repo_id, draft.commit_sha, draft.path);
      if (!blob) return fail("reference_not_attachable");
      const lineCount = blob.text.split("\n").length;
      if (draft.line_end !== null && draft.line_end > lineCount)
        return fail("reference_not_attachable");
      if (draft.kind === "range" && draft.line_start === null)
        return fail("invalid");
      if (draft.kind === "symbol" && draft.symbol === null)
        return fail("invalid");
      this.referenceCounter += 1;
      references.push({
        reference_id: `ref_sent_${this.referenceCounter}`,
        kind: draft.kind,
        repo_id: draft.repo_id,
        commit_sha: draft.commit_sha,
        path: draft.path,
        line_start: draft.line_start,
        line_end: draft.line_end,
        symbol: draft.symbol,
        access_scope: {
          team_id: this.data.team.team_id,
          repo_id: draft.repo_id,
        },
      });
    }
    const sequence = this.lastSequence(input.conversation_id) + 1;
    const message: Message = {
      message_id: `msg_${input.conversation_id}_${sequence}`,
      conversation_id: input.conversation_id,
      author_id: viewer,
      sequence,
      client_message_id: input.client_message_id,
      body,
      reply_to: input.reply_to,
      created_at: this.now(),
    };
    // Message, references and shares are committed together or not at all.
    this.data.messages.push(message);
    for (const reference of references) {
      this.data.references.push(reference);
      this.data.shares.push({
        message_id: message.message_id,
        reference_id: reference.reference_id,
      });
    }
    this.sends.set(key, { message_id: message.message_id, fingerprint });
    return succeed({
      message_id: message.message_id,
      sequence,
      duplicate: false,
    });
  }

  markRead(
    viewer: string,
    conversationId: string,
    sequence: number,
  ): TeamResult<{ read_cursor: number }> {
    const participant = this.participant(viewer, conversationId);
    if (!participant) return fail("not_found");
    if (!Number.isSafeInteger(sequence) || sequence < 0) return fail("invalid");
    const accessible = this.visibleMessages(viewer, conversationId).some(
      (m) => m.sequence === sequence,
    );
    if (!accessible) return fail("invalid");
    if (sequence > participant.read_cursor) participant.read_cursor = sequence;
    return succeed({ read_cursor: participant.read_cursor });
  }

  setPinned(
    viewer: string,
    conversationId: string,
    pinned: boolean,
  ): TeamResult<{ pinned: boolean }> {
    const participant = this.participant(viewer, conversationId);
    if (!participant) return fail("not_found");
    participant.pinned = pinned;
    return succeed({ pinned });
  }

  setReaction(
    viewer: string,
    messageId: string,
    emoji: ReactionEmoji,
    on: boolean,
  ): TeamResult<{ reactions: ReactionView[] }> {
    if (!ReactionEmojiSchema.safeParse(emoji).success) return fail("invalid");
    const message = this.accessibleMessage(viewer, messageId);
    if (!message) return fail("not_found");
    const index = this.data.reactions.findIndex(
      (r) =>
        r.message_id === messageId && r.user_id === viewer && r.emoji === emoji,
    );
    if (on && index === -1)
      this.data.reactions.push({
        message_id: messageId,
        user_id: viewer,
        emoji,
      });
    if (!on && index !== -1) this.data.reactions.splice(index, 1);
    return succeed({ reactions: this.reactionViews(viewer, messageId) });
  }

  resolveReference(
    viewer: string,
    messageId: string,
    referenceId: string,
  ): TeamResult<ReferencePreview> {
    const message = this.accessibleMessage(viewer, messageId);
    if (!message) return fail("not_found");
    const shared = this.data.shares.some(
      (s) => s.message_id === messageId && s.reference_id === referenceId,
    );
    if (!shared) return fail("not_found");
    const reference = this.data.references.find(
      (r) => r.reference_id === referenceId,
    );
    if (!reference) return fail("not_found");
    if (!this.repoAccess(viewer, reference.repo_id))
      return succeed({ state: "restricted", reference_id: referenceId });
    const repo = this.data.repos.find((r) => r.repo_id === reference.repo_id);
    const blob = this.blob(
      reference.repo_id,
      reference.commit_sha,
      reference.path,
    );
    if (!repo || !blob)
      return succeed({ state: "unavailable", reference_id: referenceId });
    const lines = blob.text
      .split("\n")
      .map((text, i) => ({ number: i + 1, text }));
    const highlight =
      reference.line_start !== null && reference.line_end !== null
        ? {
            start: reference.line_start,
            end: Math.min(reference.line_end, lines.length),
          }
        : null;
    if (highlight && highlight.start > lines.length)
      return succeed({ state: "unavailable", reference_id: referenceId });
    return succeed({
      state: "ok",
      reference_id: referenceId,
      kind: reference.kind,
      repo_name: repo.name,
      path: reference.path,
      commit_sha: reference.commit_sha,
      short_sha: reference.commit_sha.slice(0, 7),
      symbol: reference.symbol,
      lines,
      highlight,
    });
  }

  searchMessages(
    viewer: string,
    query: string,
    conversationId?: string | null,
  ): TeamResult<SearchResult> {
    if (!this.teamMember(viewer)) return fail("not_found");
    const needle = query.trim().toLowerCase();
    if (needle.length === 0 || needle.length > MAX_SEARCH_QUERY_CHARS)
      return fail("invalid");
    const scope = conversationId
      ? this.data.conversations.filter(
          (c) => c.conversation_id === conversationId,
        )
      : this.data.conversations;
    if (conversationId && scope.length === 0) return fail("not_found");
    const hits: MessageView[] = [];
    for (const conversation of scope) {
      if (
        conversationId &&
        !this.participant(viewer, conversation.conversation_id)
      )
        return fail("not_found");
      for (const message of this.visibleMessages(
        viewer,
        conversation.conversation_id,
      )) {
        if (message.body.toLowerCase().includes(needle))
          hits.push(this.messageView(viewer, message));
      }
    }
    hits.sort((a, b) =>
      a.created_at === b.created_at
        ? a.sequence - b.sequence
        : a.created_at < b.created_at
          ? 1
          : -1,
    );
    return succeed({
      query: query.trim(),
      hits: hits.slice(0, MAX_SEARCH_HITS),
    });
  }

  mentionIndex(viewer: string): MentionIndex {
    if (!this.teamMember(viewer)) return { repos: [] };
    const repos: MentionRepo[] = [];
    for (const repo of this.data.repos) {
      if (!this.repoAccess(viewer, repo.repo_id)) continue;
      const blobs = this.data.blobs.filter((b) => b.repo_id === repo.repo_id);
      const head = blobs[0]?.commit_sha;
      if (!head) continue;
      repos.push({
        repo_id: repo.repo_id,
        name: repo.name,
        commit_sha: head,
        files: blobs
          .filter((b) => b.commit_sha === head)
          .map((b) => ({
            path: b.path,
            line_count: b.text.split("\n").length,
            symbols: b.symbols.map((s) => ({ name: s.name, line: s.line })),
          }))
          .sort((a, b) => (a.path < b.path ? -1 : 1)),
      });
    }
    return { repos };
  }

  // ---------------------------------------------------------------- internals

  private sendKey(author: string, conversation: string, clientId: string) {
    return `${author}|${conversation}|${clientId}`;
  }

  private teamMember(userId: string): boolean {
    return this.data.memberships.some(
      (m) =>
        m.user_id === userId &&
        m.team_id === this.data.team.team_id &&
        m.state === "active",
    );
  }

  private participant(userId: string, conversationId: string) {
    if (!this.teamMember(userId)) return undefined;
    const conversation = this.data.conversations.find(
      (c) =>
        c.conversation_id === conversationId &&
        c.team_id === this.data.team.team_id,
    );
    if (!conversation) return undefined;
    return this.data.participants.find(
      (p) => p.conversation_id === conversationId && p.user_id === userId,
    );
  }

  private repoAccess(userId: string, repoId: string): boolean {
    return this.data.repo_access.some(
      (a) => a.user_id === userId && a.repo_id === repoId,
    );
  }

  private blob(repoId: string, sha: string, path: string) {
    return this.data.blobs.find(
      (b) => b.repo_id === repoId && b.commit_sha === sha && b.path === path,
    );
  }

  private lastSequence(conversationId: string): number {
    let last = 0;
    for (const m of this.data.messages)
      if (m.conversation_id === conversationId && m.sequence > last)
        last = m.sequence;
    return last;
  }

  /** Messages the viewer may read: participant, and at or after their join point. */
  private visibleMessages(viewer: string, conversationId: string): Message[] {
    const participant = this.participant(viewer, conversationId);
    if (!participant) return [];
    return this.data.messages
      .filter(
        (m) =>
          m.conversation_id === conversationId &&
          m.sequence > participant.joined_at_sequence,
      )
      .sort((a, b) => a.sequence - b.sequence);
  }

  private accessibleMessage(viewer: string, messageId: string) {
    const message = this.data.messages.find((m) => m.message_id === messageId);
    if (!message) return undefined;
    return this.visibleMessages(viewer, message.conversation_id).find(
      (m) => m.message_id === messageId,
    );
  }

  private userName(userId: string): string {
    return (
      this.data.users.find((u) => u.user_id === userId)?.display_name ??
      "Unknown member"
    );
  }

  private summary(
    viewer: string,
    conversationId: string,
  ): ConversationSummary | undefined {
    const participant = this.participant(viewer, conversationId);
    const conversation = this.data.conversations.find(
      (c) => c.conversation_id === conversationId,
    );
    if (!participant || !conversation) return undefined;
    const members = this.data.participants
      .filter((p) => p.conversation_id === conversationId)
      .map((p) => p.user_id);
    if (conversation.kind === "group" && members.length > MAX_GROUP_MEMBERS)
      return undefined;
    const visible = this.visibleMessages(viewer, conversationId);
    const last = visible[visible.length - 1];
    const unread = visible.filter((m) => m.sequence > participant.read_cursor);
    const title =
      conversation.kind === "group"
        ? (conversation.title ?? "Group")
        : this.userName(members.find((id) => id !== viewer) ?? viewer);
    return {
      conversation_id: conversationId,
      kind: conversation.kind,
      title,
      member_ids: members,
      pinned: participant.pinned,
      read_cursor: participant.read_cursor,
      last_sequence: last?.sequence ?? 0,
      unread_count: unread.length,
      first_unread_sequence: unread[0]?.sequence ?? null,
      last_message: last
        ? {
            author_id: last.author_id,
            excerpt: excerpt(last.body),
            created_at: last.created_at,
          }
        : null,
    };
  }

  private reactionViews(viewer: string, messageId: string): ReactionView[] {
    const views = new Map<ReactionEmoji, ReactionView>();
    for (const reaction of this.data.reactions) {
      if (reaction.message_id !== messageId) continue;
      const view = views.get(reaction.emoji) ?? {
        emoji: reaction.emoji,
        count: 0,
        mine: false,
      };
      view.count += 1;
      if (reaction.user_id === viewer) view.mine = true;
      views.set(reaction.emoji, view);
    }
    return [...views.values()].sort((a, b) => (a.emoji < b.emoji ? -1 : 1));
  }

  private referenceViews(viewer: string, messageId: string): ReferenceView[] {
    const views: ReferenceView[] = [];
    for (const share of this.data.shares) {
      if (share.message_id !== messageId) continue;
      const reference = this.data.references.find(
        (r) => r.reference_id === share.reference_id,
      );
      if (!reference) continue;
      if (!this.repoAccess(viewer, reference.repo_id)) {
        views.push({
          reference_id: reference.reference_id,
          state: "restricted",
        });
        continue;
      }
      const repo = this.data.repos.find((r) => r.repo_id === reference.repo_id);
      views.push({
        reference_id: reference.reference_id,
        state: "ok",
        kind: reference.kind,
        repo_id: reference.repo_id,
        repo_name: repo?.name ?? reference.repo_id,
        path: reference.path,
        commit_sha: reference.commit_sha,
        short_sha: reference.commit_sha.slice(0, 7),
        line_start: reference.line_start,
        line_end: reference.line_end,
        symbol: reference.symbol,
      });
    }
    return views;
  }

  private messageView(viewer: string, message: Message): MessageView {
    const target =
      message.reply_to === null
        ? undefined
        : this.visibleMessages(viewer, message.conversation_id).find(
            (m) => m.message_id === message.reply_to,
          );
    return {
      message_id: message.message_id,
      conversation_id: message.conversation_id,
      author_id: message.author_id,
      author_name: this.userName(message.author_id),
      sequence: message.sequence,
      client_message_id: message.client_message_id,
      body: message.body,
      created_at: message.created_at,
      reply_to: target
        ? {
            message_id: target.message_id,
            author_name: this.userName(target.author_id),
            excerpt: excerpt(target.body),
          }
        : null,
      reactions: this.reactionViews(viewer, message.message_id),
      references: this.referenceViews(viewer, message.message_id),
    };
  }
}
