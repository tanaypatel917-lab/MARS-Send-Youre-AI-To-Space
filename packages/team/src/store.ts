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
  AGENT_MAX_IDEMPOTENCY_KEY_CHARS,
  AGENT_MAX_MESSAGES,
  type AgentCitation,
  type AgentPreview,
  type AgentPreviewItem,
  AgentPreviewSchema,
  type AgentRequest,
  AgentRequestSchema,
  type Conversation,
  ConversationSchema,
  MARS_AGENT_USER_ID,
  type Message,
  MessageSchema,
  type Participant,
  ParticipantSchema,
  TEAM_MAX_REFERENCES,
  type TeamDeliveryEvent,
  TeamDeliveryEventSchema,
  type TeamMembership,
  TeamMembershipSchema,
  type TeamRole,
} from "@mars/contracts";
import { z } from "zod";
import {
  AGENT_REASON_CODE,
  type AgentCompletion,
  type AgentFrozenInput,
  AgentFrozenInputSchema,
  type ClaimedAgentRequest,
  type TeamAgentHostPort,
  type TeamAgentOptions,
} from "./agent";
import { conflict, invalidInput, notFound, TeamError } from "./errors";
import {
  DEFAULT_TEAM_LIMITS,
  type TeamLimits,
  TeamLimitsSchema,
} from "./schemas";

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
  {
    id: "0002_agent_requests",
    sql: `
      ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'user' CHECK (kind IN ('user', 'agent'));
      ALTER TABLE messages ADD COLUMN agent_request_id TEXT;
      CREATE TABLE agent_requests (
        request_id TEXT PRIMARY KEY, team_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id),
        requester_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, params_sha256 TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled', 'restricted')),
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        input_json TEXT NOT NULL, input_sha256 TEXT NOT NULL,
        record_json TEXT NOT NULL, record_sha256 TEXT NOT NULL,
        answer_body TEXT, created_seq INTEGER NOT NULL,
        UNIQUE (team_id, requester_id, idempotency_key)
      );
      CREATE INDEX agent_requests_queue ON agent_requests(status, created_seq);
      CREATE INDEX agent_requests_conversation ON agent_requests(conversation_id, created_seq);
    `,
  },
];

export interface TeamStoreOptions {
  rootDir: string;
  limits?: Partial<TeamLimits>;
  now?: () => Date;
  randomId?: () => string;
  /** Enables `agent.*`; absent means the methods answer `unavailable`. */
  agent?: TeamAgentOptions;
}

export interface AgentSelection {
  conversation_id: string;
  message_ids: string[];
  reference_ids: string[];
}

export interface AgentRequestInput extends AgentSelection {
  idempotency_key: string;
  audience: "conversation";
  preview_sha256: string;
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

export interface TeamDescription {
  team_id: string;
  user_id: string;
  role: TeamRole;
  limits: TeamLimits;
  capabilities: {
    stream: boolean;
    reactions: boolean;
    search: boolean;
    agent: boolean;
  };
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
  list(actor: TeamActor): ConversationView[];
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
  /** Author only; the stored body, `body_sha256` and `edited_at` change, `seq` does not. */
  editMessage(
    actor: TeamActor,
    input: { message_id: string; body: string },
  ): Message;
  /** Author only; the body is cleared and `deleted` set, the row stays so citations keep resolving. */
  deleteMessage(actor: TeamActor, input: { message_id: string }): Message;
  /** Page cut by count and serialized bytes; never skips a message. */
  history(actor: TeamActor, query: HistoryQuery): Message[];
  poll(
    actor: TeamActor,
    input: { cursors: PollCursor[]; limit?: number | undefined },
  ): TeamDeliveryEvent[];
  /** The exact context list a client shows before `agent.request`; its digest is `preview_sha256`. */
  agentPreview(actor: TeamActor, input: AgentSelection): AgentPreview;
  agentRequest(actor: TeamActor, input: AgentRequestInput): AgentRequest;
  agentCancel(actor: TeamActor, input: { request_id: string }): AgentRequest;
  /** Requester or active participant only; everyone else gets `not_found`. */
  agentInspect(actor: TeamActor, input: { request_id: string }): AgentRequest;
  /** Host-only driver; never exposed over RPC. */
  readonly agentHost: TeamAgentHostPort;
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
  kind: string;
  agent_request_id: string | null;
}
interface AgentRequestRow {
  request_id: string;
  team_id: string;
  conversation_id: string;
  requester_id: string;
  idempotency_key: string;
  params_sha256: string;
  status: string;
  cancel_requested: number;
  input_json: string;
  input_sha256: string;
  record_json: string;
  record_sha256: string;
  answer_body: string | null;
  created_seq: number;
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
    const legacy = {
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
    const record = {
      ...legacy,
      kind: row.kind,
      agent_request_id: row.agent_request_id,
    };
    // Rows written before migration 0002 were digested without `kind`.
    const intact =
      sha256(canonicalJson(record)) === row.record_sha256 ||
      (row.kind === "user" &&
        row.agent_request_id === null &&
        sha256(canonicalJson(legacy)) === row.record_sha256);
    if (!intact)
      throw new TeamError("corrupt_record", "Stored message is invalid");
    return MessageSchema.parse(record);
  };
  const saveMessageBody = (
    row: MessageRow,
    body: string,
    deleted: boolean,
  ): Message => {
    const record: Message = {
      ...messageRecord(row),
      body,
      body_sha256: sha256(body),
      edited_at: timestamp(),
      deleted,
    };
    db.query(
      "UPDATE messages SET body = ?, body_sha256 = ?, edited_at = ?, deleted = ?, record_sha256 = ? WHERE message_id = ?",
    ).run(
      record.body,
      record.body_sha256,
      record.edited_at,
      deleted ? 1 : 0,
      sha256(canonicalJson(record)),
      record.message_id,
    );
    return MessageSchema.parse(record);
  };
  const insertMessage = (
    conversation: ConversationRow,
    record: Message,
  ): Message => {
    db.query(
      "INSERT INTO messages (message_id, conversation_id, seq, author_id, client_message_id, body, body_sha256, reply_to, reference_ids_json, created_at, edited_at, deleted, record_sha256, kind, agent_request_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, ?)",
    ).run(
      record.message_id,
      record.conversation_id,
      record.seq,
      record.author_id,
      record.client_message_id,
      record.body,
      record.body_sha256,
      record.reply_to,
      JSON.stringify(record.reference_ids),
      record.created_at,
      sha256(canonicalJson(record)),
      record.kind,
      record.agent_request_id,
    );
    conversation.last_seq = record.seq;
    emitEvent(
      conversation,
      "message",
      record.seq,
      record.message_id,
      conversation.revision,
    );
    saveConversation(conversation);
    return MessageSchema.parse(record);
  };
  /** Author-only lookup for edits; absent and not-yours answer alike. */
  const requireOwnMessage = (
    actor: TeamActor,
    messageId: string,
  ): { conversation: ConversationRow; row: MessageRow } => {
    if (!idSchema.safeParse(messageId).success) throw notFound();
    const row = db
      .query<MessageRow, [string]>(
        "SELECT * FROM messages WHERE message_id = ?",
      )
      .get(messageId);
    if (!row || row.author_id !== actor.user_id) throw notFound();
    const { conversation } = requireParticipant(actor, row.conversation_id);
    if (row.kind !== "user")
      throw invalidInput("Agent messages cannot be edited");
    return { conversation, row };
  };

  const emitEvent = (
    conversation: ConversationRow,
    kind: "message" | "membership" | "edit",
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
    return eventSeq;
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

  const write = <T>(fn: () => T): T => db.transaction(fn).immediate();
  const read = <T>(fn: () => T): T => db.transaction(fn)();

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
            db.query(
              "UPDATE participants SET state = 'removed' WHERE conversation_id = ? AND user_id = ?",
            ).run(conversation.conversation_id, input.user_id);
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

  const messagePage = (
    rows: MessageRow[],
    fromCursorSide: boolean,
  ): Message[] => {
    const page: Message[] = [];
    let bytes = ENVELOPE_BYTES;
    for (const row of rows) {
      const message = messageRecord(row);
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

  // ---------------------------------------------------------------------------
  // @MARS requests: queued here, executed by the workbench (never a model call).
  // ---------------------------------------------------------------------------
  const agentOptions = options.agent;
  const requireAgent = (): TeamAgentOptions => {
    if (!agentOptions)
      throw new TeamError("unavailable", "Agent requests are not enabled");
    return agentOptions;
  };
  const activeParticipants = (conversationId: string): string[] =>
    db
      .query<{ user_id: string }, [string]>(
        "SELECT user_id FROM participants WHERE conversation_id = ? AND state = 'active' ORDER BY user_id",
      )
      .all(conversationId)
      .map((row) => row.user_id);
  const selectionSchema = z
    .object({
      conversation_id: idSchema,
      message_ids: z.array(idSchema).max(AGENT_MAX_MESSAGES),
      reference_ids: z.array(idSchema).max(TEAM_MAX_REFERENCES),
    })
    .strict();
  interface ReferenceSnapshot {
    reference_id: string;
    label: string;
    text: string;
    readers: string[];
  }
  const describeReferences = (
    agent: TeamAgentOptions,
    teamId: string,
    referenceIds: readonly string[],
    viewers: readonly string[],
  ): ReferenceSnapshot[] => {
    if (referenceIds.length === 0) return [];
    if (!agent.references)
      throw invalidInput("References are not available to agent requests");
    const described = new Map(
      agent.references
        .describe({ team_id: teamId, reference_ids: referenceIds, viewers })
        .map((entry) => [entry.reference_id, entry] as const),
    );
    return referenceIds.map((referenceId) => {
      const entry = described.get(referenceId);
      const readers = entry
        ? [...new Set(entry.readers.filter((v) => viewers.includes(v)))].sort()
        : [];
      const text = entry?.text ?? "";
      if (Buffer.byteLength(text) > limits.max_reference_excerpt_bytes)
        throw new TeamError(
          "too_large",
          "A reference excerpt exceeds the agent context limit",
        );
      return {
        reference_id: referenceId,
        label: entry?.label ?? "",
        text,
        readers,
      };
    });
  };
  const referenceAccessDigest = (snapshots: readonly ReferenceSnapshot[]) =>
    sha256(
      canonicalJson(
        snapshots.map((entry) => ({
          reference_id: entry.reference_id,
          readers: entry.readers,
        })),
      ),
    );
  /** Authorizes, freezes and digests a selection inside the caller's transaction. */
  const buildPreview = (
    actor: TeamActor,
    rawInput: unknown,
  ): {
    preview: AgentPreview;
    conversation: ConversationRow;
    frozen: AgentFrozenInput;
  } => {
    const agent = requireAgent();
    const parsed = selectionSchema.safeParse(rawInput);
    if (!parsed.success) throw invalidInput("Invalid agent selection");
    const input = parsed.data;
    const { conversation, participant } = requireParticipant(
      actor,
      input.conversation_id,
    );
    if (
      new Set(input.message_ids).size !== input.message_ids.length ||
      new Set(input.reference_ids).size !== input.reference_ids.length
    )
      throw invalidInput("Selection contains duplicates");
    if (input.message_ids.length + input.reference_ids.length === 0)
      throw invalidInput("Selection is empty");
    const rows = input.message_ids.map((messageId) => {
      const row = db
        .query<MessageRow, [string, string]>(
          "SELECT * FROM messages WHERE message_id = ? AND conversation_id = ?",
        )
        .get(messageId, conversation.conversation_id);
      if (!row || row.seq <= participant.joined_seq || row.deleted === 1)
        throw invalidInput("Selection includes an unavailable message");
      return messageRecord(row);
    });
    rows.sort((a, b) => a.seq - b.seq);
    const participants = activeParticipants(conversation.conversation_id);
    const references = describeReferences(
      agent,
      actor.team_id,
      [...input.reference_ids].sort(),
      participants,
    );
    const scan = agent.scan ?? (() => undefined);
    const frozen: AgentFrozenInput = {
      messages: rows.map((message) => ({
        message_id: message.message_id,
        seq: message.seq,
        author_id: message.author_id,
        created_at: message.created_at,
        body: message.body,
        body_sha256: message.body_sha256,
        flagged: scan(message.body) ?? null,
      })),
      references: references.map((entry) => ({
        reference_id: entry.reference_id,
        label: entry.label,
        text: entry.text,
        bytes: Buffer.byteLength(entry.text),
        flagged: scan(entry.text) ?? scan(entry.label) ?? null,
      })),
      participants,
      reference_access_sha256: referenceAccessDigest(references),
    };
    const items: AgentPreviewItem[] = [
      ...frozen.messages.map((message) => ({
        kind: "message" as const,
        message_id: message.message_id,
        seq: message.seq,
        body_sha256: message.body_sha256,
        bytes: Buffer.byteLength(message.body),
        flagged: message.flagged,
      })),
      ...frozen.references.map((entry) => ({
        kind: "reference" as const,
        reference_id: entry.reference_id,
        bytes: entry.bytes,
        flagged: entry.flagged,
      })),
    ];
    const total = items.reduce((sum, item) => sum + item.bytes, 0);
    if (total > limits.max_agent_context_bytes)
      throw new TeamError(
        "too_large",
        "Selection exceeds the agent context limit",
      );
    const unsigned = {
      conversation_id: conversation.conversation_id,
      audience: "conversation" as const,
      items,
      participant_count: participants.length,
      restricted_reference_ids: references
        .filter((entry) => entry.readers.length !== participants.length)
        .map((entry) => entry.reference_id),
      model: agent.model(),
    };
    const preview = AgentPreviewSchema.parse({
      ...unsigned,
      preview_sha256: sha256(canonicalJson(unsigned)),
    });
    return { preview, conversation, frozen };
  };
  const agentRow = (requestId: string): AgentRequestRow | null =>
    idSchema.safeParse(requestId).success
      ? db
          .query<AgentRequestRow, [string]>(
            "SELECT * FROM agent_requests WHERE request_id = ?",
          )
          .get(requestId)
      : null;
  const agentRecord = (row: AgentRequestRow): AgentRequest => {
    if (sha256(row.record_json) !== row.record_sha256)
      throw new TeamError("corrupt_record", "Stored agent request is invalid");
    const parsed = AgentRequestSchema.safeParse(JSON.parse(row.record_json));
    if (!parsed.success)
      throw new TeamError("corrupt_record", "Stored agent request is invalid");
    return parsed.data;
  };
  const frozenInput = (row: AgentRequestRow): AgentFrozenInput => {
    if (sha256(row.input_json) !== row.input_sha256)
      throw new TeamError("corrupt_record", "Stored agent input is invalid");
    const parsed = AgentFrozenInputSchema.safeParse(JSON.parse(row.input_json));
    if (!parsed.success)
      throw new TeamError("corrupt_record", "Stored agent input is invalid");
    return parsed.data;
  };
  const saveAgentRecord = (
    row: AgentRequestRow,
    record: AgentRequest,
    extra: { cancel_requested?: boolean; answer_body?: string | null } = {},
  ): AgentRequest => {
    const next = AgentRequestSchema.parse({
      ...record,
      updated_at: timestamp(),
    });
    const json = canonicalJson(next);
    db.query(
      "UPDATE agent_requests SET status = ?, record_json = ?, record_sha256 = ?, cancel_requested = ?, answer_body = ? WHERE request_id = ?",
    ).run(
      next.status,
      json,
      sha256(json),
      (extra.cancel_requested ?? row.cancel_requested === 1) ? 1 : 0,
      extra.answer_body === undefined ? row.answer_body : extra.answer_body,
      row.request_id,
    );
    return next;
  };
  const cancelControllers = new Map<string, AbortController>();
  const requireAgentViewer = (
    actor: TeamActor,
    requestId: string,
  ): AgentRequestRow => {
    const row = agentRow(requestId);
    if (!row || row.team_id !== actor.team_id) throw notFound();
    if (row.requester_id !== actor.user_id) {
      const participant = participantRow(row.conversation_id, actor.user_id);
      if (!participant || participant.state !== "active") throw notFound();
    }
    return row;
  };
  const completionSchema = z
    .object({
      answer_body: z.string(),
      citations: z.array(
        z.discriminatedUnion("kind", [
          z
            .object({
              kind: z.literal("message"),
              message_id: idSchema,
              seq: z.number().int().positive(),
            })
            .strict(),
          z
            .object({ kind: z.literal("reference"), reference_id: idSchema })
            .strict(),
        ]),
      ),
      dropped_citations: z.number().int().nonnegative().optional(),
      evidence: z.unknown().optional(),
    })
    .strict();
  const requireRunning = (requestId: string): AgentRequestRow => {
    const row = agentRow(requestId);
    if (!row) throw notFound();
    if (row.status !== "running")
      throw conflict("Agent request is not running");
    return row;
  };
  const finish = (
    row: AgentRequestRow,
    record: AgentRequest,
    status: AgentRequest["status"],
    reasonCode: string | null,
    extra: { answer_body?: string | null } = {},
  ): AgentRequest => {
    cancelControllers.delete(row.request_id);
    return saveAgentRecord(
      row,
      { ...record, status, reason_code: reasonCode },
      extra,
    );
  };
  const agentHost: TeamAgentHostPort = {
    claimNext() {
      return write((): ClaimedAgentRequest | null => {
        const row = db
          .query<AgentRequestRow, []>(
            "SELECT * FROM agent_requests WHERE status = 'pending' ORDER BY created_seq LIMIT 1",
          )
          .get();
        if (!row) return null;
        const record = saveAgentRecord(row, {
          ...agentRecord(row),
          status: "running",
        });
        const controller = new AbortController();
        cancelControllers.set(row.request_id, controller);
        return {
          request: record,
          input: frozenInput(row),
          signal: controller.signal,
        };
      });
    },
    complete(requestId, completion: AgentCompletion) {
      return write(() => {
        const row = requireRunning(requestId);
        const record = agentRecord(row);
        const parsed = completionSchema.safeParse(completion);
        if (!parsed.success) throw invalidInput("Invalid agent completion");
        if (row.cancel_requested === 1)
          return finish(row, record, "cancelled", "cancelled");
        const body = parsed.data.answer_body;
        if (
          body.trim().length === 0 ||
          Buffer.byteLength(body) > limits.max_body_bytes
        )
          return finish(row, record, "failed", "answer_too_large");
        const frozen = frozenInput(row);
        const known = new Set(
          frozen.messages.map((m) => `${m.message_id}@${m.seq}`),
        );
        const knownReferences = new Set(
          frozen.references.map((r) => r.reference_id),
        );
        const citations: AgentCitation[] = [];
        let dropped = parsed.data.dropped_citations ?? 0;
        for (const citation of parsed.data.citations) {
          const ok =
            citation.kind === "message"
              ? known.has(`${citation.message_id}@${citation.seq}`)
              : knownReferences.has(citation.reference_id);
          if (ok) citations.push(citation);
          else dropped += 1;
        }
        const conversation = conversationRow(row.conversation_id);
        if (!conversation)
          throw new TeamError("corrupt_record", "Conversation missing");
        const participants = activeParticipants(conversation.conversation_id);
        const sameAudience =
          participants.length === frozen.participants.length &&
          participants.every((user, i) => user === frozen.participants[i]);
        const withResult = {
          ...record,
          citations,
          dropped_citations: dropped,
        };
        if (!sameAudience)
          return finish(row, withResult, "restricted", "audience_changed", {
            answer_body: body,
          });
        if (frozen.references.length > 0) {
          const agent = requireAgent();
          const current = describeReferences(
            agent,
            row.team_id,
            frozen.references.map((r) => r.reference_id),
            participants,
          );
          if (referenceAccessDigest(current) !== frozen.reference_access_sha256)
            return finish(
              row,
              withResult,
              "restricted",
              "reference_access_changed",
              { answer_body: body },
            );
        }
        const message = insertMessage(conversation, {
          message_id: randomId(),
          conversation_id: conversation.conversation_id,
          author_id: MARS_AGENT_USER_ID,
          kind: "agent",
          agent_request_id: row.request_id,
          seq: conversation.last_seq + 1,
          client_message_id: `agent:${row.request_id}`,
          body,
          body_sha256: sha256(body),
          reply_to: null,
          reference_ids: [
            ...new Set(
              citations.flatMap((c) =>
                c.kind === "reference" ? [c.reference_id] : [],
              ),
            ),
          ],
          created_at: timestamp(),
          edited_at: null,
          deleted: false,
        });
        return finish(
          row,
          {
            ...withResult,
            answer: { message_id: message.message_id, evidence: null },
          },
          "completed",
          null,
          { answer_body: body },
        );
      });
    },
    fail(requestId, reasonCode) {
      if (!AGENT_REASON_CODE.test(reasonCode))
        throw invalidInput("Invalid agent failure reason");
      return write(() => {
        const row = requireRunning(requestId);
        const record = agentRecord(row);
        return row.cancel_requested === 1 || reasonCode === "cancelled"
          ? finish(row, record, "cancelled", "cancelled")
          : finish(row, record, "failed", reasonCode);
      });
    },
  };

  return {
    rootDir,
    limits,
    agentHost,
    setTeamMember(input) {
      const parsed = z
        .object({
          team_id: idSchema,
          user_id: idSchema,
          role: z.enum(["admin", "member"]),
        })
        .strict()
        .parse(input);
      if (parsed.user_id === MARS_AGENT_USER_ID)
        throw invalidInput("The agent user id is reserved");
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
          db.query(
            "UPDATE participants SET state = 'removed' WHERE conversation_id = ? AND user_id = ?",
          ).run(conversation.conversation_id, parsed.user_id);
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
          capabilities: {
            stream: false,
            reactions: false,
            search: false,
            agent: agentOptions !== undefined,
          },
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
          return view(row, participant);
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
            return insertMessage(conversation, {
              message_id: randomId(),
              conversation_id: conversation.conversation_id,
              author_id: actor.user_id,
              kind: "user",
              agent_request_id: null,
              seq: conversation.last_seq + 1,
              client_message_id: parsed.data.client_message_id,
              body: parsed.data.body,
              body_sha256: bodyHash,
              reply_to: parsed.data.reply_to ?? null,
              reference_ids: [],
              created_at: timestamp(),
              edited_at: null,
              deleted: false,
            });
          },
        );
      });
    },
    editMessage(actor, input) {
      return write(() => {
        requireTeamMember(actor);
        const parsed = z
          .object({ message_id: idSchema, body: z.string().min(1) })
          .strict()
          .safeParse(input);
        if (!parsed.success) throw invalidInput("Invalid edit input");
        if (Buffer.byteLength(parsed.data.body) > limits.max_body_bytes)
          throw new TeamError(
            "too_large",
            "Message body exceeds the size limit",
          );
        const { conversation, row } = requireOwnMessage(
          actor,
          parsed.data.message_id,
        );
        if (row.deleted === 1)
          throw invalidInput("Deleted messages cannot be edited");
        const message = saveMessageBody(row, parsed.data.body, false);
        emitEvent(
          conversation,
          "edit",
          message.seq,
          message.message_id,
          conversation.revision,
        );
        saveConversation(conversation);
        return message;
      });
    },
    deleteMessage(actor, input) {
      return write(() => {
        requireTeamMember(actor);
        const parsed = z
          .object({ message_id: idSchema })
          .strict()
          .safeParse(input);
        if (!parsed.success) throw invalidInput("Invalid delete input");
        const { conversation, row } = requireOwnMessage(
          actor,
          parsed.data.message_id,
        );
        if (row.deleted === 1) return messageRecord(row);
        const message = saveMessageBody(row, "", true);
        emitEvent(
          conversation,
          "edit",
          message.seq,
          message.message_id,
          conversation.revision,
        );
        saveConversation(conversation);
        return message;
      });
    },
    agentPreview(actor, input) {
      return read(() => {
        requireTeamMember(actor);
        return buildPreview(actor, input).preview;
      });
    },
    agentRequest(actor, input) {
      return write(() => {
        requireTeamMember(actor);
        requireAgent();
        const parsed = z
          .object({
            idempotency_key: z
              .string()
              .min(1)
              .max(AGENT_MAX_IDEMPOTENCY_KEY_CHARS),
            conversation_id: idSchema,
            message_ids: z.array(idSchema).max(AGENT_MAX_MESSAGES),
            reference_ids: z.array(idSchema).max(TEAM_MAX_REFERENCES),
            audience: z.literal("conversation"),
            preview_sha256: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict()
          .safeParse(input);
        if (!parsed.success) throw invalidInput("Invalid agent request");
        const paramsHash = sha256(canonicalJson(parsed.data));
        const existing = db
          .query<AgentRequestRow, [string, string, string]>(
            "SELECT * FROM agent_requests WHERE team_id = ? AND requester_id = ? AND idempotency_key = ?",
          )
          .get(actor.team_id, actor.user_id, parsed.data.idempotency_key);
        if (existing) {
          if (existing.params_sha256 !== paramsHash)
            throw conflict("Idempotency key was reused with different input");
          return agentRecord(existing);
        }
        const { preview, conversation, frozen } = buildPreview(actor, {
          conversation_id: parsed.data.conversation_id,
          message_ids: parsed.data.message_ids,
          reference_ids: parsed.data.reference_ids,
        });
        if (preview.preview_sha256 !== parsed.data.preview_sha256)
          throw conflict("Preview digest does not match the current selection");
        if (preview.restricted_reference_ids.length > 0)
          throw new TeamError(
            "forbidden",
            "Not every participant may read the selected references",
          );
        const at = timestamp();
        const record = AgentRequestSchema.parse({
          request_id: randomId(),
          team_id: actor.team_id,
          conversation_id: conversation.conversation_id,
          requester_id: actor.user_id,
          idempotency_key: parsed.data.idempotency_key,
          audience: "conversation",
          messages: frozen.messages.map((m) => ({
            message_id: m.message_id,
            seq: m.seq,
            body_sha256: m.body_sha256,
          })),
          reference_ids: frozen.references.map((r) => r.reference_id),
          preview_sha256: preview.preview_sha256,
          model_id: preview.model.model_id,
          status: "pending",
          flagged: [
            ...frozen.messages.flatMap((m) =>
              m.flagged
                ? [
                    {
                      kind: "message" as const,
                      message_id: m.message_id,
                      threat: m.flagged,
                    },
                  ]
                : [],
            ),
            ...frozen.references.flatMap((r) =>
              r.flagged
                ? [
                    {
                      kind: "reference" as const,
                      reference_id: r.reference_id,
                      threat: r.flagged,
                    },
                  ]
                : [],
            ),
          ],
          citations: [],
          dropped_citations: 0,
          reason_code: null,
          answer: null,
          created_at: at,
          updated_at: at,
        } satisfies AgentRequest);
        const inputJson = canonicalJson(frozen);
        const recordJson = canonicalJson(record);
        const createdSeq =
          (db
            .query<{ max: number | null }, []>(
              "SELECT MAX(created_seq) AS max FROM agent_requests",
            )
            .get()?.max ?? 0) + 1;
        db.query(
          "INSERT INTO agent_requests (request_id, team_id, conversation_id, requester_id, idempotency_key, params_sha256, status, cancel_requested, input_json, input_sha256, record_json, record_sha256, answer_body, created_seq) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, NULL, ?)",
        ).run(
          record.request_id,
          record.team_id,
          record.conversation_id,
          record.requester_id,
          record.idempotency_key,
          paramsHash,
          inputJson,
          sha256(inputJson),
          recordJson,
          sha256(recordJson),
          createdSeq,
        );
        return record;
      });
    },
    agentCancel(actor, input) {
      return write(() => {
        requireTeamMember(actor);
        const row = agentRow(input?.request_id);
        if (
          !row ||
          row.team_id !== actor.team_id ||
          row.requester_id !== actor.user_id
        )
          throw notFound();
        const record = agentRecord(row);
        if (row.status === "pending")
          return finish(row, record, "cancelled", "cancelled");
        if (row.status === "running") {
          const next = saveAgentRecord(row, record, { cancel_requested: true });
          cancelControllers.get(row.request_id)?.abort();
          return next;
        }
        return record;
      });
    },
    agentInspect(actor, input) {
      return read(() => {
        requireTeamMember(actor);
        return agentRecord(requireAgentViewer(actor, input?.request_id));
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
          return messagePage(rows, false);
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
        return messagePage(rows, true);
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
    close() {
      db.close();
    },
  };
}
