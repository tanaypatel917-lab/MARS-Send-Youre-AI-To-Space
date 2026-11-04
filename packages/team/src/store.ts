import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  type Conversation,
  ConversationSchema,
  type Message,
  MessageSchema,
  type Participant,
  ParticipantSchema,
  TEAM_MAX_EMOJI_CHARS,
  TEAM_MAX_EXCERPT_CHARS,
  TEAM_MAX_SEARCH_QUERY_CHARS,
  type TeamDeliveryEvent,
  TeamDeliveryEventSchema,
  type TeamMembership,
  TeamMembershipSchema,
  type TeamRole,
} from "@mars/contracts";
import { z } from "zod";
import { conflict, invalidInput, notFound, TeamError } from "./errors";
import {
  DEFAULT_TEAM_LIMITS,
  type TeamLimits,
  TeamLimitsSchema,
} from "./schemas";
import {
  excerptAround,
  hasInvisibleCodePoint,
  headExcerpt,
  isValidEmoji,
  likePattern,
} from "./text";

export const TEAM_STORE_FORMAT_VERSION = 1;

/**
 * Forward-only, ordered migration ledger. This is the first migration
 * mechanism in the repository and it is private to this store: the other
 * SQLite stores keep rejecting foreign format versions. Append new entries,
 * never edit or reorder applied ones; a ledger that names an id this code does
 * not know (written by newer code) or in a different order is rejected.
 */
export const TEAM_MIGRATIONS: ReadonlyArray<{ id: string; sql: string }> = [
  {
    id: "0001_initial",
    sql: `
      CREATE TABLE members (
        team_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active', 'removed')),
        revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (team_id, user_id)
      );
      CREATE TABLE conversations (
        conversation_id TEXT PRIMARY KEY, team_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('dm', 'group')),
        title TEXT, dm_key TEXT, revision INTEGER NOT NULL, last_seq INTEGER NOT NULL,
        last_event_seq INTEGER NOT NULL, created_by TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX conversations_team_dm ON conversations(team_id, dm_key) WHERE kind = 'dm';
      CREATE INDEX conversations_team ON conversations(team_id);
      CREATE TABLE participants (
        conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id),
        user_id TEXT NOT NULL, joined_seq INTEGER NOT NULL, joined_event_seq INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active', 'removed')),
        pinned INTEGER NOT NULL, read_seq INTEGER NOT NULL,
        PRIMARY KEY (conversation_id, user_id)
      );
      CREATE INDEX participants_user ON participants(user_id, state);
      CREATE TABLE messages (
        message_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id),
        seq INTEGER NOT NULL, author_id TEXT NOT NULL, client_message_id TEXT NOT NULL,
        body TEXT NOT NULL, body_sha256 TEXT NOT NULL, reply_to TEXT,
        reference_ids_json TEXT NOT NULL, created_at TEXT NOT NULL, edited_at TEXT,
        deleted INTEGER NOT NULL, record_sha256 TEXT NOT NULL,
        UNIQUE (conversation_id, seq),
        UNIQUE (conversation_id, author_id, client_message_id)
      );
      CREATE TABLE reactions (
        message_id TEXT NOT NULL REFERENCES messages(message_id),
        user_id TEXT NOT NULL, emoji TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY (message_id, user_id, emoji)
      );
      CREATE TABLE outbox (
        conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id),
        event_seq INTEGER NOT NULL, kind TEXT NOT NULL, message_seq INTEGER NOT NULL,
        message_id TEXT, revision INTEGER NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY (conversation_id, event_seq)
      );
      CREATE TABLE idempotency (
        team_id TEXT NOT NULL, user_id TEXT NOT NULL, request_id TEXT NOT NULL,
        operation TEXT NOT NULL, input_sha256 TEXT NOT NULL, result_json TEXT NOT NULL,
        created_seq INTEGER NOT NULL,
        PRIMARY KEY (team_id, user_id, request_id, operation, input_sha256)
      );
      CREATE INDEX idempotency_owner ON idempotency(team_id, user_id, created_seq);
    `,
  },
];

export interface TeamStoreOptions {
  rootDir: string;
  limits?: Partial<TeamLimits>;
  now?: () => Date;
  randomId?: () => string;
}

/** Server-resolved identity: `user_id` comes from the authenticator, never a client. */
export interface TeamActor {
  readonly team_id: string;
  readonly user_id: string;
}

export interface ConversationMember {
  user_id: string;
  state: "active" | "removed";
  joined_seq: number;
}

export interface ConversationView {
  conversation: Conversation;
  participant: Participant;
  members: ConversationMember[];
}

export interface HistoryQuery {
  conversation_id: string;
  after_seq?: number | undefined;
  before_seq?: number | undefined;
  limit?: number | undefined;
}

export interface PollCursor {
  conversation_id: string;
  after_event_seq: number;
}

export interface ConversationListItem extends ConversationView {
  unread_count: number;
  last_message_at: string | null;
}

export interface ReactionSummary {
  emoji: string;
  count: number;
  reacted: boolean;
}

/** History item: the record plus aggregates the caller may see. */
export interface MessageView extends Message {
  reactions: ReactionSummary[];
  reply_excerpt: string | null;
  reply_restricted: boolean;
}

export interface ReactionState {
  message_id: string;
  emoji: string;
  count: number;
  reacted: boolean;
}

export interface SearchQuery {
  query: string;
  conversation_id?: string | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}

export interface SearchHit {
  conversation_id: string;
  message_id: string;
  seq: number;
  author_id: string;
  created_at: string;
  excerpt: string;
  cut_before: boolean;
  cut_after: boolean;
}

export interface SearchPage {
  hits: SearchHit[];
  next_cursor: string | null;
}

/**
 * Delivered synchronously after a write transaction commits, in commit order.
 * `event`: new outbox rows exist for the conversation (the listener re-polls
 * through the membership-filtered query; nothing else is carried).
 * `removed`: the user's participation in the conversation ended.
 */
export type StoreNotice =
  | { type: "event"; conversation_id: string }
  | { type: "removed"; conversation_id: string; user_id: string };

export interface TeamDescription {
  team_id: string;
  user_id: string;
  role: TeamRole;
  limits: TeamLimits;
  capabilities: { stream: boolean; reactions: boolean; search: boolean };
}

export interface TeamStore {
  readonly rootDir: string;
  readonly limits: TeamLimits;
  /** Host-side team administration (no RPC exposes these in PR 2). */
  setTeamMember(input: {
    team_id: string;
    user_id: string;
    role: TeamRole;
  }): TeamMembership;
  removeTeamMember(input: { team_id: string; user_id: string }): TeamMembership;
  describe(actor: TeamActor): TeamDescription;
  createDm(
    actor: TeamActor,
    requestId: string,
    input: { peer_user_id: string },
  ): ConversationView;
  createGroup(
    actor: TeamActor,
    requestId: string,
    input: { member_ids: string[]; title: string },
  ): ConversationView;
  list(actor: TeamActor): ConversationListItem[];
  open(actor: TeamActor, conversationId: string): ConversationView;
  addMember(
    actor: TeamActor,
    requestId: string,
    input: {
      conversation_id: string;
      user_id: string;
      expected_revision: number;
    },
  ): ConversationView;
  removeMember(
    actor: TeamActor,
    requestId: string,
    input: {
      conversation_id: string;
      user_id: string;
      expected_revision: number;
    },
  ): ConversationView;
  /** Self-removal from a DM or group; the returned participant is `removed`. */
  leave(
    actor: TeamActor,
    requestId: string,
    input: { conversation_id: string },
  ): ConversationView;
  markRead(
    actor: TeamActor,
    input: { conversation_id: string; read_seq: number },
  ): Participant;
  pin(
    actor: TeamActor,
    input: { conversation_id: string; pinned: boolean },
  ): Participant;
  send(
    actor: TeamActor,
    requestId: string,
    input: {
      conversation_id: string;
      client_message_id: string;
      body: string;
      reply_to?: string | undefined;
    },
  ): Message;
  /** Page cut by count and serialized bytes; never skips a message. */
  history(actor: TeamActor, query: HistoryQuery): MessageView[];
  poll(
    actor: TeamActor,
    input: { cursors: PollCursor[]; limit?: number | undefined },
  ): TeamDeliveryEvent[];
  /** Idempotent set/remove; emits a `reaction` outbox row only on change. */
  setReaction(
    actor: TeamActor,
    input: { message_id: string; emoji: string; on: boolean },
  ): ReactionState;
  /** Membership-filtered before excerpting; newest first; opaque cursor. */
  search(actor: TeamActor, query: SearchQuery): SearchPage;
  /** Post-commit notices for the in-process server (streams). */
  subscribe(listener: (notice: StoreNotice) => void): () => void;
  close(): void;
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw invalidInput("Value is not JSON data");
    return serialized;
  }
  if (Array.isArray(value))
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function dmKey(userA: string, userB: string): string {
  return sha256(canonicalJson([userA, userB].sort()));
}

const ENVELOPE_BYTES = Buffer.byteLength('{"result":[]}');
const idSchema = z.string().min(1).max(256);

interface MemberRow {
  team_id: string;
  user_id: string;
  role: string;
  state: string;
  revision: number;
}
interface ConversationRow {
  conversation_id: string;
  team_id: string;
  kind: string;
  title: string | null;
  dm_key: string | null;
  revision: number;
  last_seq: number;
  last_event_seq: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}
interface ParticipantRow {
  conversation_id: string;
  user_id: string;
  joined_seq: number;
  joined_event_seq: number;
  state: string;
  pinned: number;
  read_seq: number;
}
interface MessageRow {
  message_id: string;
  conversation_id: string;
  seq: number;
  author_id: string;
  client_message_id: string;
  body: string;
  body_sha256: string;
  reply_to: string | null;
  reference_ids_json: string;
  created_at: string;
  edited_at: string | null;
  deleted: number;
  record_sha256: string;
}
interface OutboxRow {
  conversation_id: string;
  event_seq: number;
  kind: string;
  message_seq: number;
  message_id: string | null;
  revision: number;
}

function prepareRoot(rootDir: string): string {
  if (typeof rootDir !== "string" || !isAbsolute(rootDir))
    throw invalidInput("rootDir must be absolute");
  const requested = resolve(rootDir);
  let rootStat: ReturnType<typeof lstatSync> | undefined;
  try {
    rootStat = lstatSync(requested);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (rootStat) {
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory())
      throw new TeamError(
        "unsafe_path",
        "Team store root must be a real directory",
      );
    if (
      typeof process.getuid === "function" &&
      rootStat.uid !== process.getuid()
    )
      throw new TeamError(
        "unsafe_path",
        "Team store root must be owned by the current user",
      );
  } else {
    mkdirSync(requested, { recursive: true, mode: 0o700 });
  }
  chmodSync(requested, 0o700);
  return realpathSync(requested);
}

function openDatabase(rootDir: string): Database {
  const dbPath = join(rootDir, "team.sqlite");
  if (existsSync(dbPath)) {
    const dbStat = lstatSync(dbPath);
    if (dbStat.isSymbolicLink() || !dbStat.isFile())
      throw new TeamError("unsafe_path", "team.sqlite must be a regular file");
  }
  const db = new Database(dbPath, { create: true, strict: true });
  try {
    db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000;",
    );
    chmodSync(dbPath, 0o600);
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, position INTEGER NOT NULL UNIQUE);
    `);
    db.transaction(() => {
      const format = db
        .query<{ value: string }, []>(
          "SELECT value FROM meta WHERE key = 'format_version'",
        )
        .get();
      if (format && Number(format.value) !== TEAM_STORE_FORMAT_VERSION)
        throw new TeamError(
          "corrupt_record",
          "Unsupported team store format version",
        );
      if (!format)
        db.query(
          "INSERT INTO meta (key, value) VALUES ('format_version', ?)",
        ).run(String(TEAM_STORE_FORMAT_VERSION));
      const applied = db
        .query<{ id: string; position: number }, []>(
          "SELECT id, position FROM migrations ORDER BY position",
        )
        .all();
      applied.forEach((row, index) => {
        if (row.position !== index || TEAM_MIGRATIONS[index]?.id !== row.id)
          throw new TeamError(
            "corrupt_record",
            "Team store migration ledger does not match this version",
          );
      });
      for (
        let index = applied.length;
        index < TEAM_MIGRATIONS.length;
        index++
      ) {
        const migration = TEAM_MIGRATIONS[index];
        if (!migration) break;
        db.exec(migration.sql);
        db.query(
          "INSERT INTO migrations (id, applied_at, position) VALUES (?, ?, ?)",
        ).run(migration.id, new Date().toISOString(), index);
      }
    }).immediate();
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

export function createTeamStore(options: TeamStoreOptions): TeamStore {
  const limits = TeamLimitsSchema.parse({
    ...DEFAULT_TEAM_LIMITS,
    ...(options.limits ?? {}),
  });
  const now = options.now ?? (() => new Date());
  const randomId = options.randomId ?? (() => Bun.randomUUIDv7());
  const rootDir = prepareRoot(options.rootDir);
  const db = openDatabase(rootDir);
  const timestamp = () => now().toISOString();

  const memberRow = (teamId: string, userId: string): MemberRow | null =>
    db
      .query<MemberRow, [string, string]>(
        "SELECT team_id, user_id, role, state, revision FROM members WHERE team_id = ? AND user_id = ?",
      )
      .get(teamId, userId);
  const membership = (row: MemberRow): TeamMembership =>
    TeamMembershipSchema.parse({
      team_id: row.team_id,
      user_id: row.user_id,
      role: row.role,
      state: row.state,
      revision: row.revision,
    });
  const requireTeamMember = (actor: TeamActor): MemberRow => {
    const parsed = z
      .object({ team_id: idSchema, user_id: idSchema })
      .strict()
      .safeParse(actor);
    if (!parsed.success)
      throw new TeamError("forbidden", "Team membership required");
    const row = memberRow(parsed.data.team_id, parsed.data.user_id);
    if (!row || row.state !== "active")
      throw new TeamError("forbidden", "Team membership required");
    return row;
  };
  const activeTeamMember = (teamId: string, userId: string): boolean => {
    const row = memberRow(teamId, userId);
    return row !== null && row.state === "active";
  };

  const conversationRow = (conversationId: string): ConversationRow | null =>
    db
      .query<ConversationRow, [string]>(
        "SELECT * FROM conversations WHERE conversation_id = ?",
      )
      .get(conversationId);
  const participantRow = (
    conversationId: string,
    userId: string,
  ): ParticipantRow | null =>
    db
      .query<ParticipantRow, [string, string]>(
        "SELECT * FROM participants WHERE conversation_id = ? AND user_id = ?",
      )
      .get(conversationId, userId);
  /** Conversation in the actor's team with the actor as an active participant; one code for absent and not-yours. */
  const requireParticipant = (
    actor: TeamActor,
    conversationId: string,
  ): { conversation: ConversationRow; participant: ParticipantRow } => {
    if (!idSchema.safeParse(conversationId).success) throw notFound();
    const conversation = conversationRow(conversationId);
    if (!conversation || conversation.team_id !== actor.team_id)
      throw notFound();
    const participant = participantRow(conversationId, actor.user_id);
    if (!participant || participant.state !== "active") throw notFound();
    return { conversation, participant };
  };

  const toConversation = (row: ConversationRow): Conversation =>
    ConversationSchema.parse({
      conversation_id: row.conversation_id,
      team_id: row.team_id,
      kind: row.kind,
      title: row.title,
      dm_key: row.dm_key,
      revision: row.revision,
      last_seq: row.last_seq,
    });
  const toParticipant = (row: ParticipantRow): Participant =>
    ParticipantSchema.parse({
      conversation_id: row.conversation_id,
      user_id: row.user_id,
      joined_seq: row.joined_seq,
      state: row.state,
      pinned: row.pinned === 1,
      read_seq: row.read_seq,
    });
  const view = (
    conversation: ConversationRow,
    participant: ParticipantRow,
  ): ConversationView => ({
    conversation: toConversation(conversation),
    participant: toParticipant(participant),
    members: db
      .query<
        Pick<ParticipantRow, "user_id" | "state" | "joined_seq">,
        [string]
      >(
        "SELECT user_id, state, joined_seq FROM participants WHERE conversation_id = ? ORDER BY user_id",
      )
      .all(conversation.conversation_id)
      .map((row) => ({
        user_id: row.user_id,
        state: row.state === "active" ? "active" : "removed",
        joined_seq: row.joined_seq,
      })),
  });

  const messageRecord = (row: MessageRow): Message => {
    const record = {
      message_id: row.message_id,
      conversation_id: row.conversation_id,
      author_id: row.author_id,
      seq: row.seq,
      client_message_id: row.client_message_id,
      body: row.body,
      body_sha256: row.body_sha256,
      reply_to: row.reply_to,
      reference_ids: JSON.parse(row.reference_ids_json) as string[],
      created_at: row.created_at,
      edited_at: row.edited_at,
      deleted: row.deleted === 1,
    };
    if (sha256(canonicalJson(record)) !== row.record_sha256)
      throw new TeamError("corrupt_record", "Stored message is invalid");
    return MessageSchema.parse(record);
  };

  const emitEvent = (
    conversation: ConversationRow,
    kind: "message" | "membership" | "reaction",
    messageSeq: number,
    messageId: string | null,
    revision: number,
  ): number => {
    const eventSeq = conversation.last_event_seq + 1;
    db.query(
      "INSERT INTO outbox (conversation_id, event_seq, kind, message_seq, message_id, revision, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      conversation.conversation_id,
      eventSeq,
      kind,
      messageSeq,
      messageId,
      revision,
      timestamp(),
    );
    conversation.last_event_seq = eventSeq;
    notify({ type: "event", conversation_id: conversation.conversation_id });
    return eventSeq;
  };
  const removeParticipant = (conversationId: string, userId: string) => {
    db.query(
      "UPDATE participants SET state = 'removed' WHERE conversation_id = ? AND user_id = ?",
    ).run(conversationId, userId);
    notify({
      type: "removed",
      conversation_id: conversationId,
      user_id: userId,
    });
  };
  const saveConversation = (conversation: ConversationRow) => {
    db.query(
      "UPDATE conversations SET title = ?, revision = ?, last_seq = ?, last_event_seq = ?, updated_at = ? WHERE conversation_id = ?",
    ).run(
      conversation.title,
      conversation.revision,
      conversation.last_seq,
      conversation.last_event_seq,
      timestamp(),
      conversation.conversation_id,
    );
  };
  const insertParticipant = (conversation: ConversationRow, userId: string) => {
    db.query(
      "INSERT INTO participants (conversation_id, user_id, joined_seq, joined_event_seq, state, pinned, read_seq) VALUES (?, ?, ?, ?, 'active', 0, ?)",
    ).run(
      conversation.conversation_id,
      userId,
      conversation.last_seq,
      conversation.last_event_seq,
      conversation.last_seq,
    );
  };

  /** A returning participant starts at the current seq: nothing before it is visible. */
  const reactivateParticipant = (
    conversation: ConversationRow,
    userId: string,
  ) => {
    db.query(
      "UPDATE participants SET state = 'active', joined_seq = ?, joined_event_seq = ?, pinned = 0, read_seq = ? WHERE conversation_id = ? AND user_id = ?",
    ).run(
      conversation.last_seq,
      conversation.last_event_seq,
      conversation.last_seq,
      conversation.conversation_id,
      userId,
    );
  };

  // Idempotency: (team, user, request, operation, input digest) → stored result.
  // Equal digest replays; a reused request id with another input is a conflict.
  const idempotent = <T>(
    actor: TeamActor,
    requestId: string,
    operation: string,
    input: unknown,
    schema: z.ZodType<T>,
    perform: () => T,
  ): T => {
    if (!idSchema.safeParse(requestId).success)
      throw invalidInput("request_id is required");
    const inputHash = sha256(canonicalJson(input));
    const previous = db
      .query<
        { input_sha256: string; result_json: string },
        [string, string, string, string]
      >(
        "SELECT input_sha256, result_json FROM idempotency WHERE team_id = ? AND user_id = ? AND request_id = ? AND operation = ?",
      )
      .all(actor.team_id, actor.user_id, requestId, operation);
    const match = previous.find((row) => row.input_sha256 === inputHash);
    if (match) {
      try {
        return schema.parse(JSON.parse(match.result_json));
      } catch {
        throw new TeamError("corrupt_record", "Corrupt idempotency result");
      }
    }
    if (previous.length > 0)
      throw conflict("Request id was reused with different input");
    const result = perform();
    const createdSeq =
      (db
        .query<{ max: number | null }, []>(
          "SELECT MAX(created_seq) AS max FROM idempotency",
        )
        .get()?.max ?? 0) + 1;
    db.query(
      "INSERT INTO idempotency (team_id, user_id, request_id, operation, input_sha256, result_json, created_seq) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      actor.team_id,
      actor.user_id,
      requestId,
      operation,
      inputHash,
      canonicalJson(result),
      createdSeq,
    );
    const count =
      db
        .query<{ count: number }, [string, string]>(
          "SELECT COUNT(*) AS count FROM idempotency WHERE team_id = ? AND user_id = ?",
        )
        .get(actor.team_id, actor.user_id)?.count ?? 0;
    if (count > limits.max_pending_idempotency_rows)
      db.query(
        "DELETE FROM idempotency WHERE rowid IN (SELECT rowid FROM idempotency WHERE team_id = ? AND user_id = ? ORDER BY created_seq LIMIT ?)",
      ).run(
        actor.team_id,
        actor.user_id,
        count - limits.max_pending_idempotency_rows,
      );
    return result;
  };

  const viewSchema: z.ZodType<ConversationView> = z
    .object({
      conversation: ConversationSchema,
      participant: ParticipantSchema,
      members: z.array(
        z
          .object({
            user_id: idSchema,
            state: z.enum(["active", "removed"]),
            joined_seq: z.number().int().nonnegative(),
          })
          .strict(),
      ),
    })
    .strict();

  const listeners = new Set<(notice: StoreNotice) => void>();
  let pending: StoreNotice[] | null = null;
  const notify = (notice: StoreNotice) => {
    if (pending) pending.push(notice);
  };
  const write = <T>(fn: () => T): T => {
    if (pending) return fn();
    pending = [];
    let notices: StoreNotice[];
    try {
      const result = db.transaction(fn).immediate();
      notices = pending;
      pending = null;
      for (const notice of notices)
        for (const listener of listeners) {
          try {
            listener(notice);
          } catch {
            // A failing subscriber never undoes a committed write.
          }
        }
      return result;
    } finally {
      pending = null;
    }
  };
  const read = <T>(fn: () => T): T => db.transaction(fn)();

  const searchWindow = new Map<string, number[]>();
  const takeSearchSlot = (actor: TeamActor) => {
    const key = `${actor.team_id}\u0000${actor.user_id}`;
    const at = now().getTime();
    const recent = (searchWindow.get(key) ?? []).filter(
      (stamp) => at - stamp < 60_000,
    );
    if (recent.length >= limits.max_search_per_minute) {
      searchWindow.set(key, recent);
      throw new TeamError("rate_limited", "Search rate limit reached");
    }
    recent.push(at);
    searchWindow.set(key, recent);
  };

  const changeMembership = (
    actor: TeamActor,
    requestId: string,
    input: {
      conversation_id: string;
      user_id: string;
      expected_revision: number;
    },
    direction: "add" | "remove",
  ): ConversationView =>
    write(() => {
      requireTeamMember(actor);
      return idempotent(
        actor,
        requestId,
        `conversations.${direction}_member`,
        input,
        viewSchema,
        () => {
          const { conversation } = requireParticipant(
            actor,
            input.conversation_id,
          );
          if (!idSchema.safeParse(input.user_id).success) throw notFound();
          if (conversation.kind !== "group")
            throw invalidInput("Direct conversations have fixed membership");
          if (conversation.revision !== input.expected_revision)
            throw conflict("Conversation revision does not match");
          const target = participantRow(
            conversation.conversation_id,
            input.user_id,
          );
          if (direction === "add") {
            if (!activeTeamMember(actor.team_id, input.user_id))
              throw notFound();
            if (target?.state === "active")
              throw conflict("User is already a participant");
            const active =
              db
                .query<{ count: number }, [string]>(
                  "SELECT COUNT(*) AS count FROM participants WHERE conversation_id = ? AND state = 'active'",
                )
                .get(conversation.conversation_id)?.count ?? 0;
            if (active + 1 > limits.max_group_size)
              throw invalidInput("Group size limit reached");
            if (target) reactivateParticipant(conversation, input.user_id);
            else insertParticipant(conversation, input.user_id);
          } else {
            if (!target || target.state !== "active") throw notFound();
            removeParticipant(conversation.conversation_id, input.user_id);
          }
          conversation.revision += 1;
          emitEvent(
            conversation,
            "membership",
            conversation.last_seq,
            null,
            conversation.revision,
          );
          saveConversation(conversation);
          // After leaving, the caller's own row is `removed`; the server
          // accepts that only for self-removal.
          const self = participantRow(
            conversation.conversation_id,
            actor.user_id,
          );
          if (!self) throw notFound();
          return view(conversation, self);
        },
      );
    });

  const reactionSummaries = (
    messageId: string,
    userId: string,
  ): ReactionSummary[] =>
    db
      .query<{ emoji: string; count: number; mine: number }, [string, string]>(
        "SELECT emoji, COUNT(*) AS count, SUM(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS mine FROM reactions WHERE message_id = ? GROUP BY emoji ORDER BY emoji",
      )
      .all(userId, messageId)
      .map((row) => ({
        emoji: row.emoji,
        count: row.count,
        reacted: row.mine > 0,
      }));

  const messageView = (
    row: MessageRow,
    participant: ParticipantRow,
  ): MessageView => {
    const message = messageRecord(row);
    let reply_excerpt: string | null = null;
    let reply_restricted = false;
    if (message.reply_to !== null) {
      const target = db
        .query<Pick<MessageRow, "seq" | "body" | "deleted">, [string, string]>(
          "SELECT seq, body, deleted FROM messages WHERE message_id = ? AND conversation_id = ?",
        )
        .get(message.reply_to, row.conversation_id);
      if (!target || target.seq <= participant.joined_seq)
        reply_restricted = true;
      else if (target.deleted !== 1)
        reply_excerpt = headExcerpt(target.body, TEAM_MAX_EXCERPT_CHARS).text;
    }
    return {
      ...message,
      reactions: reactionSummaries(row.message_id, participant.user_id),
      reply_excerpt,
      reply_restricted,
    };
  };

  const messagePage = (
    rows: MessageRow[],
    participant: ParticipantRow,
    fromCursorSide: boolean,
  ): MessageView[] => {
    const page: MessageView[] = [];
    let bytes = ENVELOPE_BYTES;
    for (const row of rows) {
      const message = messageView(row, participant);
      const size =
        Buffer.byteLength(JSON.stringify(message)) + (page.length ? 1 : 0);
      if (bytes + size > limits.max_page_bytes) {
        if (page.length === 0)
          throw new TeamError(
            "too_large",
            "A single message exceeds the page size",
          );
        break;
      }
      page.push(message);
      bytes += size;
    }
    return fromCursorSide ? page.reverse() : page;
  };

  return {
    rootDir,
    limits,
    setTeamMember(input) {
      const parsed = z
        .object({
          team_id: idSchema,
          user_id: idSchema,
          role: z.enum(["admin", "member"]),
        })
        .strict()
        .parse(input);
      return write(() => {
        const existing = memberRow(parsed.team_id, parsed.user_id);
        const at = timestamp();
        if (existing)
          db.query(
            "UPDATE members SET role = ?, state = 'active', revision = revision + 1, updated_at = ? WHERE team_id = ? AND user_id = ?",
          ).run(parsed.role, at, parsed.team_id, parsed.user_id);
        else
          db.query(
            "INSERT INTO members (team_id, user_id, role, state, revision, created_at, updated_at) VALUES (?, ?, ?, 'active', 0, ?, ?)",
          ).run(parsed.team_id, parsed.user_id, parsed.role, at, at);
        const row = memberRow(parsed.team_id, parsed.user_id);
        if (!row) throw new TeamError("corrupt_record", "Member row missing");
        return membership(row);
      });
    },
    removeTeamMember(input) {
      const parsed = z
        .object({ team_id: idSchema, user_id: idSchema })
        .strict()
        .parse(input);
      return write(() => {
        const existing = memberRow(parsed.team_id, parsed.user_id);
        if (!existing) throw notFound();
        db.query(
          "UPDATE members SET state = 'removed', revision = revision + 1, updated_at = ? WHERE team_id = ? AND user_id = ?",
        ).run(timestamp(), parsed.team_id, parsed.user_id);
        // Leaving the team leaves every conversation in it.
        const rows = db
          .query<ConversationRow, [string, string]>(
            "SELECT c.* FROM conversations c JOIN participants p ON p.conversation_id = c.conversation_id WHERE c.team_id = ? AND p.user_id = ? AND p.state = 'active'",
          )
          .all(parsed.team_id, parsed.user_id);
        for (const conversation of rows) {
          removeParticipant(conversation.conversation_id, parsed.user_id);
          conversation.revision += 1;
          emitEvent(
            conversation,
            "membership",
            conversation.last_seq,
            null,
            conversation.revision,
          );
          saveConversation(conversation);
        }
        const row = memberRow(parsed.team_id, parsed.user_id);
        if (!row) throw new TeamError("corrupt_record", "Member row missing");
        return membership(row);
      });
    },
    describe(actor) {
      return read(() => {
        const member = requireTeamMember(actor);
        return {
          team_id: member.team_id,
          user_id: member.user_id,
          role: member.role === "admin" ? "admin" : "member",
          limits,
          capabilities: { stream: true, reactions: true, search: true },
        };
      });
    },
    createDm(actor, requestId, input) {
      return write(() => {
        requireTeamMember(actor);
        return idempotent(
          actor,
          requestId,
          "conversations.create_dm",
          input,
          viewSchema,
          () => {
            if (!idSchema.safeParse(input.peer_user_id).success)
              throw notFound();
            if (input.peer_user_id === actor.user_id)
              throw invalidInput("A direct conversation needs another user");
            if (!activeTeamMember(actor.team_id, input.peer_user_id))
              throw notFound();
            const key = dmKey(actor.user_id, input.peer_user_id);
            // The immediate transaction holds the write lock between this read and
            // the insert, and the partial unique index guards the file itself.
            const existing = db
              .query<ConversationRow, [string, string]>(
                "SELECT * FROM conversations WHERE team_id = ? AND dm_key = ? AND kind = 'dm'",
              )
              .get(actor.team_id, key);
            if (existing) {
              // Only the caller re-enters a DM they were removed from (by a
              // team departure); the peer cannot restore someone else's access.
              const own = participantRow(
                existing.conversation_id,
                actor.user_id,
              );
              if (!own)
                throw new TeamError("corrupt_record", "DM participant missing");
              if (own.state !== "active") {
                reactivateParticipant(existing, actor.user_id);
                existing.revision += 1;
                emitEvent(
                  existing,
                  "membership",
                  existing.last_seq,
                  null,
                  existing.revision,
                );
                saveConversation(existing);
              }
              const self = participantRow(
                existing.conversation_id,
                actor.user_id,
              );
              if (!self)
                throw new TeamError("corrupt_record", "DM participant missing");
              return view(existing, self);
            }
            const at = timestamp();
            const conversation: ConversationRow = {
              conversation_id: randomId(),
              team_id: actor.team_id,
              kind: "dm",
              title: null,
              dm_key: key,
              revision: 0,
              last_seq: 0,
              last_event_seq: 0,
              created_by: actor.user_id,
              created_at: at,
              updated_at: at,
            };
            db.query(
              "INSERT INTO conversations (conversation_id, team_id, kind, title, dm_key, revision, last_seq, last_event_seq, created_by, created_at, updated_at) VALUES (?, ?, 'dm', NULL, ?, 0, 0, 0, ?, ?, ?)",
            ).run(
              conversation.conversation_id,
              actor.team_id,
              key,
              actor.user_id,
              at,
              at,
            );
            insertParticipant(conversation, actor.user_id);
            insertParticipant(conversation, input.peer_user_id);
            emitEvent(conversation, "membership", 0, null, 0);
            saveConversation(conversation);
            const self = participantRow(
              conversation.conversation_id,
              actor.user_id,
            );
            if (!self)
              throw new TeamError("corrupt_record", "DM participant missing");
            return view(conversation, self);
          },
        );
      });
    },
    createGroup(actor, requestId, input) {
      return write(() => {
        requireTeamMember(actor);
        return idempotent(
          actor,
          requestId,
          "conversations.create_group",
          input,
          viewSchema,
          () => {
            const parsed = z
              .object({
                member_ids: z.array(idSchema).max(limits.max_group_size),
                title: z.string().min(1).max(limits.max_title_chars),
              })
              .strict()
              .safeParse(input);
            if (!parsed.success) throw invalidInput("Invalid group input");
            const members = [
              ...new Set([actor.user_id, ...parsed.data.member_ids]),
            ];
            if (members.length < 2)
              throw invalidInput("A group needs at least two members");
            if (members.length > limits.max_group_size)
              throw invalidInput("Group size limit reached");
            for (const userId of members)
              if (!activeTeamMember(actor.team_id, userId)) throw notFound();
            const at = timestamp();
            const conversation: ConversationRow = {
              conversation_id: randomId(),
              team_id: actor.team_id,
              kind: "group",
              title: parsed.data.title,
              dm_key: null,
              revision: 0,
              last_seq: 0,
              last_event_seq: 0,
              created_by: actor.user_id,
              created_at: at,
              updated_at: at,
            };
            db.query(
              "INSERT INTO conversations (conversation_id, team_id, kind, title, dm_key, revision, last_seq, last_event_seq, created_by, created_at, updated_at) VALUES (?, ?, 'group', ?, NULL, 0, 0, 0, ?, ?, ?)",
            ).run(
              conversation.conversation_id,
              actor.team_id,
              parsed.data.title,
              actor.user_id,
              at,
              at,
            );
            for (const userId of members)
              insertParticipant(conversation, userId);
            emitEvent(conversation, "membership", 0, null, 0);
            saveConversation(conversation);
            const self = participantRow(
              conversation.conversation_id,
              actor.user_id,
            );
            if (!self)
              throw new TeamError(
                "corrupt_record",
                "Group participant missing",
              );
            return view(conversation, self);
          },
        );
      });
    },
    list(actor) {
      return read(() => {
        requireTeamMember(actor);
        const rows = db
          .query<ConversationRow & { p_pinned: number }, [string, string]>(
            "SELECT c.*, p.pinned AS p_pinned FROM conversations c JOIN participants p ON p.conversation_id = c.conversation_id WHERE c.team_id = ? AND p.user_id = ? AND p.state = 'active' ORDER BY p.pinned DESC, c.updated_at DESC, c.conversation_id",
          )
          .all(actor.team_id, actor.user_id);
        return rows.map((row) => {
          const participant = participantRow(
            row.conversation_id,
            actor.user_id,
          );
          if (!participant)
            throw new TeamError("corrupt_record", "Participant missing");
          // read_seq never drops below joined_seq, so it is the unread floor.
          const unread =
            db
              .query<{ count: number }, [string, number, string]>(
                "SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ? AND seq > ? AND author_id != ?",
              )
              .get(row.conversation_id, participant.read_seq, actor.user_id)
              ?.count ?? 0;
          const last = db
            .query<{ created_at: string }, [string, number]>(
              "SELECT created_at FROM messages WHERE conversation_id = ? AND seq > ? ORDER BY seq DESC LIMIT 1",
            )
            .get(row.conversation_id, participant.joined_seq);
          return {
            ...view(row, participant),
            unread_count: unread,
            last_message_at: last?.created_at ?? null,
          };
        });
      });
    },
    open(actor, conversationId) {
      return read(() => {
        requireTeamMember(actor);
        const { conversation, participant } = requireParticipant(
          actor,
          conversationId,
        );
        return view(conversation, participant);
      });
    },
    addMember(actor, requestId, input) {
      return changeMembership(actor, requestId, input, "add");
    },
    removeMember(actor, requestId, input) {
      return changeMembership(actor, requestId, input, "remove");
    },
    leave(actor, requestId, input) {
      return write(() => {
        requireTeamMember(actor);
        return idempotent(
          actor,
          requestId,
          "conversations.leave",
          input,
          viewSchema,
          () => {
            const { conversation } = requireParticipant(
              actor,
              input.conversation_id,
            );
            removeParticipant(conversation.conversation_id, actor.user_id);
            conversation.revision += 1;
            emitEvent(
              conversation,
              "membership",
              conversation.last_seq,
              null,
              conversation.revision,
            );
            saveConversation(conversation);
            const self = participantRow(
              conversation.conversation_id,
              actor.user_id,
            );
            if (!self) throw notFound();
            return view(conversation, self);
          },
        );
      });
    },
    markRead(actor, input) {
      return write(() => {
        requireTeamMember(actor);
        const { conversation, participant } = requireParticipant(
          actor,
          input.conversation_id,
        );
        if (
          !Number.isInteger(input.read_seq) ||
          input.read_seq < 0 ||
          input.read_seq > conversation.last_seq
        )
          throw invalidInput("read_seq exceeds the visible sequence");
        const next = Math.max(participant.read_seq, input.read_seq);
        if (next !== participant.read_seq)
          db.query(
            "UPDATE participants SET read_seq = ? WHERE conversation_id = ? AND user_id = ?",
          ).run(next, conversation.conversation_id, actor.user_id);
        return toParticipant({ ...participant, read_seq: next });
      });
    },
    pin(actor, input) {
      return write(() => {
        requireTeamMember(actor);
        const { conversation, participant } = requireParticipant(
          actor,
          input.conversation_id,
        );
        if (typeof input.pinned !== "boolean")
          throw invalidInput("pinned must be boolean");
        db.query(
          "UPDATE participants SET pinned = ? WHERE conversation_id = ? AND user_id = ?",
        ).run(
          input.pinned ? 1 : 0,
          conversation.conversation_id,
          actor.user_id,
        );
        return toParticipant({ ...participant, pinned: input.pinned ? 1 : 0 });
      });
    },
    send(actor, requestId, input) {
      return write(() => {
        requireTeamMember(actor);
        return idempotent(
          actor,
          requestId,
          "messages.send",
          input,
          MessageSchema,
          () => {
            const { conversation, participant } = requireParticipant(
              actor,
              input.conversation_id,
            );
            const parsed = z
              .object({
                conversation_id: idSchema,
                client_message_id: z
                  .string()
                  .min(1)
                  .max(limits.max_client_message_id_chars),
                body: z.string().min(1),
                reply_to: idSchema.optional(),
              })
              .strict()
              .safeParse(input);
            if (!parsed.success) throw invalidInput("Invalid message input");
            if (Buffer.byteLength(parsed.data.body) > limits.max_body_bytes)
              throw new TeamError(
                "too_large",
                "Message body exceeds the size limit",
              );
            const bodyHash = sha256(parsed.data.body);
            const previous = db
              .query<MessageRow, [string, string, string]>(
                "SELECT * FROM messages WHERE conversation_id = ? AND author_id = ? AND client_message_id = ?",
              )
              .get(
                conversation.conversation_id,
                actor.user_id,
                parsed.data.client_message_id,
              );
            if (previous) {
              if (previous.body_sha256 !== bodyHash)
                throw conflict(
                  "client_message_id was reused with a different body",
                );
              return messageRecord(previous);
            }
            if (parsed.data.reply_to !== undefined) {
              const target = db
                .query<Pick<MessageRow, "seq">, [string, string]>(
                  "SELECT seq FROM messages WHERE message_id = ? AND conversation_id = ?",
                )
                .get(parsed.data.reply_to, conversation.conversation_id);
              if (!target || target.seq <= participant.joined_seq)
                throw invalidInput("Reply target is not in this conversation");
            }
            const seq = conversation.last_seq + 1;
            const record: Message = {
              message_id: randomId(),
              conversation_id: conversation.conversation_id,
              author_id: actor.user_id,
              seq,
              client_message_id: parsed.data.client_message_id,
              body: parsed.data.body,
              body_sha256: bodyHash,
              reply_to: parsed.data.reply_to ?? null,
              reference_ids: [],
              created_at: timestamp(),
              edited_at: null,
              deleted: false,
            };
            db.query(
              "INSERT INTO messages (message_id, conversation_id, seq, author_id, client_message_id, body, body_sha256, reply_to, reference_ids_json, created_at, edited_at, deleted, record_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?)",
            ).run(
              record.message_id,
              record.conversation_id,
              record.seq,
              record.author_id,
              record.client_message_id,
              record.body,
              record.body_sha256,
              record.reply_to,
              "[]",
              record.created_at,
              sha256(canonicalJson(record)),
            );
            conversation.last_seq = seq;
            emitEvent(
              conversation,
              "message",
              seq,
              record.message_id,
              conversation.revision,
            );
            saveConversation(conversation);
            return MessageSchema.parse(record);
          },
        );
      });
    },
    history(actor, query) {
      return read(() => {
        requireTeamMember(actor);
        const { conversation, participant } = requireParticipant(
          actor,
          query.conversation_id,
        );
        const limit = query.limit ?? limits.page_limit;
        if (!Number.isInteger(limit) || limit < 1 || limit > limits.page_limit)
          throw invalidInput("Invalid page limit");
        if (query.after_seq !== undefined && query.before_seq !== undefined)
          throw invalidInput("Use either after_seq or before_seq");
        const floor = participant.joined_seq;
        if (query.after_seq !== undefined) {
          if (
            !Number.isInteger(query.after_seq) ||
            query.after_seq < 0 ||
            query.after_seq > conversation.last_seq
          )
            throw new TeamError("unknown_cursor", "Unknown history cursor");
          const rows = db
            .query<MessageRow, [string, number, number, number]>(
              "SELECT * FROM messages WHERE conversation_id = ? AND seq > ? AND seq > ? ORDER BY seq ASC LIMIT ?",
            )
            .all(conversation.conversation_id, query.after_seq, floor, limit);
          return messagePage(rows, participant, false);
        }
        const before = query.before_seq ?? conversation.last_seq + 1;
        if (
          !Number.isInteger(before) ||
          before < 1 ||
          before > conversation.last_seq + 1
        )
          throw new TeamError("unknown_cursor", "Unknown history cursor");
        const rows = db
          .query<MessageRow, [string, number, number, number]>(
            "SELECT * FROM messages WHERE conversation_id = ? AND seq < ? AND seq > ? ORDER BY seq DESC LIMIT ?",
          )
          .all(conversation.conversation_id, before, floor, limit);
        return messagePage(rows, participant, true);
      });
    },
    poll(actor, input) {
      return read(() => {
        requireTeamMember(actor);
        const limit = input.limit ?? limits.max_poll_events;
        if (
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > limits.max_poll_events
        )
          throw invalidInput("Invalid poll limit");
        if (
          !Array.isArray(input.cursors) ||
          input.cursors.length > limits.max_cursors_per_poll
        )
          throw invalidInput("Too many cursors");
        const seen = new Set<string>();
        const events: TeamDeliveryEvent[] = [];
        for (const cursor of input.cursors) {
          if (seen.has(cursor.conversation_id))
            throw invalidInput("Duplicate cursor");
          seen.add(cursor.conversation_id);
          const { conversation, participant } = requireParticipant(
            actor,
            cursor.conversation_id,
          );
          if (
            !Number.isInteger(cursor.after_event_seq) ||
            cursor.after_event_seq < 0 ||
            cursor.after_event_seq > conversation.last_event_seq
          )
            throw new TeamError("unknown_cursor", "Unknown event cursor");
          const remaining = limit - events.length;
          if (remaining <= 0) break;
          const rows = db
            .query<OutboxRow, [string, number, number, number]>(
              "SELECT conversation_id, event_seq, kind, message_seq, message_id, revision FROM outbox WHERE conversation_id = ? AND event_seq > ? AND event_seq > ? ORDER BY event_seq ASC LIMIT ?",
            )
            .all(
              conversation.conversation_id,
              cursor.after_event_seq,
              participant.joined_event_seq,
              remaining,
            );
          for (const row of rows)
            events.push(
              TeamDeliveryEventSchema.parse({
                conversation_id: row.conversation_id,
                event_seq: row.event_seq,
                kind: row.kind,
                message_seq: row.message_seq,
                message_id: row.message_id,
                revision: row.revision,
              }),
            );
        }
        return events;
      });
    },
    setReaction(actor, input) {
      return write(() => {
        requireTeamMember(actor);
        if (typeof input.on !== "boolean")
          throw invalidInput("on must be boolean");
        if (!isValidEmoji(input.emoji, TEAM_MAX_EMOJI_CHARS))
          throw invalidInput("Invalid reaction key");
        if (!idSchema.safeParse(input.message_id).success) throw notFound();
        const message = db
          .query<
            Pick<MessageRow, "message_id" | "conversation_id" | "seq">,
            [string]
          >(
            "SELECT message_id, conversation_id, seq FROM messages WHERE message_id = ?",
          )
          .get(input.message_id);
        if (!message) throw notFound();
        const { conversation, participant } = requireParticipant(
          actor,
          message.conversation_id,
        );
        if (message.seq <= participant.joined_seq) throw notFound();
        const existing = db
          .query<{ user_id: string }, [string, string, string]>(
            "SELECT user_id FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?",
          )
          .get(message.message_id, actor.user_id, input.emoji);
        let changed = false;
        if (input.on && !existing) {
          const distinct =
            db
              .query<{ count: number }, [string, string]>(
                "SELECT COUNT(*) AS count FROM (SELECT DISTINCT emoji FROM reactions WHERE message_id = ? AND emoji != ?)",
              )
              .get(message.message_id, input.emoji)?.count ?? 0;
          if (distinct + 1 > limits.max_reactions_per_message)
            throw new TeamError(
              "too_large",
              "Reaction key limit reached for this message",
            );
          db.query(
            "INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)",
          ).run(message.message_id, actor.user_id, input.emoji, timestamp());
          changed = true;
        } else if (!input.on && existing) {
          db.query(
            "DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?",
          ).run(message.message_id, actor.user_id, input.emoji);
          changed = true;
        }
        if (changed) {
          emitEvent(
            conversation,
            "reaction",
            message.seq,
            message.message_id,
            conversation.revision,
          );
          saveConversation(conversation);
        }
        const count =
          db
            .query<{ count: number }, [string, string]>(
              "SELECT COUNT(*) AS count FROM reactions WHERE message_id = ? AND emoji = ?",
            )
            .get(message.message_id, input.emoji)?.count ?? 0;
        return {
          message_id: message.message_id,
          emoji: input.emoji,
          count,
          reacted: input.on,
        };
      });
    },
    search(actor, query) {
      return read(() => {
        requireTeamMember(actor);
        const parsed = z
          .object({
            query: z.string().min(2).max(TEAM_MAX_SEARCH_QUERY_CHARS),
            conversation_id: idSchema.optional(),
            limit: z.number().int().positive().max(50).optional(),
            cursor: z.string().min(1).max(512).optional(),
          })
          .strict()
          .safeParse(query);
        if (!parsed.success || parsed.data.query.trim().length < 2)
          throw invalidInput("Invalid search input");
        if (hasInvisibleCodePoint(parsed.data.query))
          throw invalidInput("Invalid search input");
        takeSearchSlot(actor);
        const limit = parsed.data.limit ?? 20;
        const conversationId = parsed.data.conversation_id ?? null;
        if (conversationId !== null) requireParticipant(actor, conversationId);
        const cursorKey = sha256(
          canonicalJson([
            actor.team_id,
            actor.user_id,
            parsed.data.query,
            conversationId,
          ]),
        ).slice(0, 32);
        let after: { created_at: string; message_id: string } | null = null;
        if (parsed.data.cursor !== undefined) {
          try {
            const raw = Buffer.from(parsed.data.cursor, "base64url").toString(
              "utf8",
            );
            if (Buffer.from(raw).toString("base64url") !== parsed.data.cursor)
              throw new Error("cursor does not round-trip");
            const decoded = z
              .object({
                k: z.literal(cursorKey),
                t: z.string().datetime({ offset: true }),
                m: idSchema,
              })
              .strict()
              .parse(JSON.parse(raw));
            after = { created_at: decoded.t, message_id: decoded.m };
          } catch {
            throw new TeamError("unknown_cursor", "Unknown search cursor");
          }
        }
        // Membership is applied in SQL before any body is read: active
        // participation in the caller's team and seq inside the joined window.
        const rows = db
          .query<
            MessageRow,
            [
              string,
              string,
              string,
              string | null,
              string | null,
              string | null,
              string | null,
              string | null,
              string | null,
              number,
            ]
          >(
            `SELECT m.* FROM messages m
               JOIN participants p ON p.conversation_id = m.conversation_id AND p.user_id = ? AND p.state = 'active'
               JOIN conversations c ON c.conversation_id = m.conversation_id AND c.team_id = ?
             WHERE m.seq > p.joined_seq AND m.deleted = 0 AND m.body LIKE ? ESCAPE '\\'
               AND (? IS NULL OR m.conversation_id = ?)
               AND (? IS NULL OR m.created_at < ? OR (m.created_at = ? AND m.message_id < ?))
             ORDER BY m.created_at DESC, m.message_id DESC LIMIT ?`,
          )
          .all(
            actor.user_id,
            actor.team_id,
            likePattern(parsed.data.query),
            conversationId,
            conversationId,
            after?.created_at ?? null,
            after?.created_at ?? null,
            after?.created_at ?? null,
            after?.message_id ?? null,
            limit + 1,
          );
        const page = rows.slice(0, limit);
        const hits = page.map((row) => {
          const message = messageRecord(row);
          const excerpt = excerptAround(
            message.body,
            parsed.data.query,
            TEAM_MAX_EXCERPT_CHARS,
          );
          return {
            conversation_id: message.conversation_id,
            message_id: message.message_id,
            seq: message.seq,
            author_id: message.author_id,
            created_at: message.created_at,
            excerpt: excerpt.text,
            cut_before: excerpt.cut_before,
            cut_after: excerpt.cut_after,
          };
        });
        const tail = page[page.length - 1];
        const next_cursor =
          rows.length > limit && tail
            ? Buffer.from(
                JSON.stringify({
                  k: cursorKey,
                  t: tail.created_at,
                  m: tail.message_id,
                }),
              ).toString("base64url")
            : null;
        return { hits, next_cursor };
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      listeners.clear();
      db.close();
    },
  };
}
