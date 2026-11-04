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
import { type Locator, referenceDigest } from "@mars/code-refs";
import {
  type Conversation,
  ConversationSchema,
  type GitRangeReference,
  GitRangeReferenceSchema,
  type Message,
  MessageSchema,
  type MessageView,
  MessageViewSchema,
  type Participant,
  ParticipantSchema,
  type ReferenceChip,
  type ReferencePreviewState,
  type Repo,
  type RepoAccess,
  RepoAccessSchema,
  RepoSchema,
  type TeamDeliveryEvent,
  TeamDeliveryEventSchema,
  type TeamMembership,
  TeamMembershipSchema,
  type TeamRole,
} from "@mars/contracts";
import { z } from "zod";
import {
  conflict,
  invalidInput,
  notFound,
  referenceNotFound,
  TeamError,
} from "./errors";
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
    // Repo access + committed code references (Team Chat PR 4). `repo_id` is
    // the opaque id the host registered in the @mars/code-refs registry; no
    // filesystem path is stored. `references` is an SQL keyword, hence
    // `code_references`. Postgres-portable types only.
    id: "0002_references",
    sql: `
      CREATE TABLE repos (
        team_id TEXT NOT NULL, repo_id TEXT NOT NULL, label TEXT NOT NULL,
        revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (team_id, repo_id)
      );
      CREATE TABLE repo_access (
        team_id TEXT NOT NULL, repo_id TEXT NOT NULL, user_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active', 'removed')),
        revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (team_id, repo_id, user_id),
        FOREIGN KEY (team_id, repo_id) REFERENCES repos(team_id, repo_id)
      );
      CREATE INDEX repo_access_user ON repo_access(team_id, user_id, state);
      CREATE TABLE code_references (
        team_id TEXT NOT NULL, reference_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('git_range')),
        repo_id TEXT NOT NULL, commit_sha TEXT NOT NULL, path TEXT NOT NULL,
        line_start INTEGER, line_end INTEGER, blob_sha256 TEXT,
        resolved_state TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
        record_sha256 TEXT NOT NULL,
        PRIMARY KEY (team_id, reference_id)
      );
      CREATE INDEX code_references_repo ON code_references(team_id, repo_id);
      CREATE TABLE message_references (
        message_id TEXT NOT NULL REFERENCES messages(message_id),
        team_id TEXT NOT NULL, reference_id TEXT NOT NULL, position INTEGER NOT NULL,
        PRIMARY KEY (message_id, reference_id),
        FOREIGN KEY (team_id, reference_id) REFERENCES code_references(team_id, reference_id)
      );
      CREATE INDEX message_references_reference ON message_references(team_id, reference_id);
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

export interface TeamDescription {
  team_id: string;
  user_id: string;
  role: TeamRole;
  limits: TeamLimits;
  capabilities: {
    stream: boolean;
    reactions: boolean;
    search: boolean;
    /** Set by the server when a `@mars/code-refs` registry is wired in. */
    references: boolean;
  };
}

export interface SendInput {
  conversation_id: string;
  client_message_id: string;
  body: string;
  reply_to?: string | undefined;
  /** Must exist in the team and be accessible to the sender at send time. */
  reference_ids?: string[] | undefined;
}

export interface PutReferenceInput {
  locator: Locator;
  /** The `@mars/code-refs` state observed once at creation (`unavailable` is never stored). */
  resolved_state: ReferencePreviewState;
  /** `text_sha256` of the `ok` excerpt at creation; null for other states. */
  blob_sha256: string | null;
}

export interface ReferenceVisibility {
  reference: GitRangeReference;
  /** False → render exactly `{state: "restricted"}` / `{reference_id, restricted: true}`. */
  accessible: boolean;
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
  send(actor: TeamActor, requestId: string, input: SendInput): MessageView;
  /** Page cut by count and serialized bytes; never skips a message. Chips are per viewer. */
  history(actor: TeamActor, query: HistoryQuery): MessageView[];
  /** Host-side repo administration (no RPC grants repo access in the pilot). */
  setRepo(input: { team_id: string; repo_id: string; label: string }): Repo;
  setRepoAccess(input: {
    team_id: string;
    repo_id: string;
    user_id: string;
  }): RepoAccess;
  /** Takes effect on the next read: nothing is cached. */
  revokeRepoAccess(input: {
    team_id: string;
    repo_id: string;
    user_id: string;
  }): RepoAccess;
  /** Repos in the actor's team the actor currently has access to. */
  listRepos(actor: TeamActor): Repo[];
  /** Active team member, repo registered for the team, access `active`; re-read every call. */
  hasRepoAccess(actor: TeamActor, repoId: string): boolean;
  /** `not_found` for an absent repo and for one the actor cannot access alike. */
  requireRepoAccess(actor: TeamActor, repoId: string): void;
  /** Stores (or returns the existing) reference; `reference_id = referenceDigest(locator)`. */
  putReference(actor: TeamActor, input: PutReferenceInput): GitRangeReference;
  /**
   * The reference as seen by the actor: `not_found` unless it is attached to a
   * message in a conversation the actor is an active participant of (and
   * after the actor joined); `accessible` reflects current repo access.
   */
  viewReference(actor: TeamActor, referenceId: string): ReferenceVisibility;
  poll(
    actor: TeamActor,
    input: { cursors: PollCursor[]; limit?: number | undefined },
  ): TeamDeliveryEvent[];
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
interface RepoRow {
  team_id: string;
  repo_id: string;
  label: string;
  revision: number;
}
interface RepoAccessRow {
  team_id: string;
  repo_id: string;
  user_id: string;
  state: string;
  revision: number;
}
interface ReferenceRow {
  team_id: string;
  reference_id: string;
  kind: string;
  repo_id: string;
  commit_sha: string;
  path: string;
  line_start: number | null;
  line_end: number | null;
  blob_sha256: string | null;
  resolved_state: string;
  created_by: string;
  created_at: string;
  record_sha256: string;
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

  const repoRow = (teamId: string, repoId: string): RepoRow | null =>
    db
      .query<RepoRow, [string, string]>(
        "SELECT team_id, repo_id, label, revision FROM repos WHERE team_id = ? AND repo_id = ?",
      )
      .get(teamId, repoId);
  const toRepo = (row: RepoRow): Repo =>
    RepoSchema.parse({
      team_id: row.team_id,
      repo_id: row.repo_id,
      label: row.label,
      revision: row.revision,
    });
  const repoAccessRow = (
    teamId: string,
    repoId: string,
    userId: string,
  ): RepoAccessRow | null =>
    db
      .query<RepoAccessRow, [string, string, string]>(
        "SELECT team_id, repo_id, user_id, state, revision FROM repo_access WHERE team_id = ? AND repo_id = ? AND user_id = ?",
      )
      .get(teamId, repoId, userId);
  const toRepoAccess = (row: RepoAccessRow): RepoAccess =>
    RepoAccessSchema.parse({
      team_id: row.team_id,
      repo_id: row.repo_id,
      user_id: row.user_id,
      state: row.state,
      revision: row.revision,
    });
  /** Re-read on every call; the only place repo access is decided. */
  const repoAccessible = (actor: TeamActor, repoId: string): boolean => {
    if (!idSchema.safeParse(repoId).success) return false;
    if (!activeTeamMember(actor.team_id, actor.user_id)) return false;
    if (!repoRow(actor.team_id, repoId)) return false;
    const access = repoAccessRow(actor.team_id, repoId, actor.user_id);
    return access !== null && access.state === "active";
  };
  const referenceRow = (
    teamId: string,
    referenceId: string,
  ): ReferenceRow | null =>
    db
      .query<ReferenceRow, [string, string]>(
        "SELECT * FROM code_references WHERE team_id = ? AND reference_id = ?",
      )
      .get(teamId, referenceId);
  const referenceRecord = (row: ReferenceRow): GitRangeReference => {
    const record = {
      kind: "git_range" as const,
      reference_id: row.reference_id,
      team_id: row.team_id,
      repo_id: row.repo_id,
      commit_sha: row.commit_sha,
      path: row.path,
      line_start: row.line_start,
      line_end: row.line_end,
      blob_sha256: row.blob_sha256,
    };
    if (sha256(canonicalJson(record)) !== row.record_sha256)
      throw new TeamError("corrupt_record", "Stored reference is invalid");
    return GitRangeReferenceSchema.parse(record);
  };
  /** Per-viewer chips: a reference the viewer may not see is `{reference_id, restricted: true}` and nothing else. */
  const withChips = (actor: TeamActor, message: Message): MessageView => {
    const references: ReferenceChip[] = message.reference_ids.map(
      (referenceId) => {
        const row = referenceRow(actor.team_id, referenceId);
        if (!row || !repoAccessible(actor, row.repo_id))
          return { reference_id: referenceId, restricted: true };
        const reference = referenceRecord(row);
        return {
          reference_id: reference.reference_id,
          restricted: false,
          repo_id: reference.repo_id,
          commit_sha: reference.commit_sha,
          path: reference.path,
          line_start: reference.line_start,
          line_end: reference.line_end,
        };
      },
    );
    return MessageViewSchema.parse({ ...message, references });
  };

  const emitEvent = (
    conversation: ConversationRow,
    kind: "message" | "membership",
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
    actor: TeamActor,
    rows: MessageRow[],
    fromCursorSide: boolean,
  ): MessageView[] => {
    const page: MessageView[] = [];
    let bytes = ENVELOPE_BYTES;
    for (const row of rows) {
      const message = withChips(actor, messageRecord(row));
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

  const setAccess = (
    input: { team_id: string; repo_id: string; user_id: string },
    state: "active" | "removed",
  ): RepoAccess => {
    const parsed = z
      .object({ team_id: idSchema, repo_id: idSchema, user_id: idSchema })
      .strict()
      .safeParse(input);
    if (!parsed.success) throw invalidInput("Invalid repo access input");
    if (!repoRow(parsed.data.team_id, parsed.data.repo_id))
      throw referenceNotFound();
    const existing = repoAccessRow(
      parsed.data.team_id,
      parsed.data.repo_id,
      parsed.data.user_id,
    );
    const revision = (existing?.revision ?? 0) + 1;
    db.query(
      "INSERT INTO repo_access (team_id, repo_id, user_id, state, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (team_id, repo_id, user_id) DO UPDATE SET state = excluded.state, revision = excluded.revision, updated_at = excluded.updated_at",
    ).run(
      parsed.data.team_id,
      parsed.data.repo_id,
      parsed.data.user_id,
      state,
      revision,
      timestamp(),
      timestamp(),
    );
    const row = repoAccessRow(
      parsed.data.team_id,
      parsed.data.repo_id,
      parsed.data.user_id,
    );
    if (!row) throw new TeamError("corrupt_record", "Repo access write failed");
    return toRepoAccess(row);
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
            references: false,
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
        const stored = idempotent(
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
                reference_ids: z
                  .array(idSchema)
                  .max(limits.max_references_per_message)
                  .optional(),
              })
              .strict()
              .safeParse(input);
            if (!parsed.success) throw invalidInput("Invalid message input");
            const referenceIds = parsed.data.reference_ids ?? [];
            if (new Set(referenceIds).size !== referenceIds.length)
              throw invalidInput("Duplicate reference id");
            // Each reference must exist in this team and the sender must have
            // access to its repo now; absent and inaccessible look alike.
            for (const referenceId of referenceIds) {
              const row = referenceRow(actor.team_id, referenceId);
              if (!row || !repoAccessible(actor, row.repo_id))
                throw referenceNotFound();
            }
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
              if (
                previous.body_sha256 !== bodyHash ||
                previous.reference_ids_json !== JSON.stringify(referenceIds)
              )
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
              reference_ids: referenceIds,
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
              JSON.stringify(referenceIds),
              record.created_at,
              sha256(canonicalJson(record)),
            );
            referenceIds.forEach((referenceId, position) => {
              db.query(
                "INSERT INTO message_references (message_id, team_id, reference_id, position) VALUES (?, ?, ?, ?)",
              ).run(record.message_id, actor.team_id, referenceId, position);
            });
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
        // Chips are derived now, never stored: a replay after a revocation
        // shows the sender's own reference as restricted.
        return withChips(actor, stored);
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
          return messagePage(actor, rows, false);
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
        return messagePage(actor, rows, true);
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
    setRepo(input) {
      return write(() => {
        const parsed = z
          .object({
            team_id: idSchema,
            repo_id: idSchema,
            label: z.string().min(1).max(limits.max_title_chars),
          })
          .strict()
          .safeParse(input);
        if (!parsed.success) throw invalidInput("Invalid repo input");
        const existing = repoRow(parsed.data.team_id, parsed.data.repo_id);
        const revision = (existing?.revision ?? 0) + 1;
        db.query(
          "INSERT INTO repos (team_id, repo_id, label, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (team_id, repo_id) DO UPDATE SET label = excluded.label, revision = excluded.revision, updated_at = excluded.updated_at",
        ).run(
          parsed.data.team_id,
          parsed.data.repo_id,
          parsed.data.label,
          revision,
          timestamp(),
          timestamp(),
        );
        const row = repoRow(parsed.data.team_id, parsed.data.repo_id);
        if (!row) throw new TeamError("corrupt_record", "Repo write failed");
        return toRepo(row);
      });
    },
    setRepoAccess(input) {
      return write(() => setAccess(input, "active"));
    },
    revokeRepoAccess(input) {
      return write(() => setAccess(input, "removed"));
    },
    listRepos(actor) {
      return read(() => {
        requireTeamMember(actor);
        return db
          .query<RepoRow, [string, string]>(
            "SELECT r.team_id, r.repo_id, r.label, r.revision FROM repos r JOIN repo_access a ON a.team_id = r.team_id AND a.repo_id = r.repo_id WHERE r.team_id = ? AND a.user_id = ? AND a.state = 'active' ORDER BY r.repo_id",
          )
          .all(actor.team_id, actor.user_id)
          .map(toRepo);
      });
    },
    hasRepoAccess(actor, repoId) {
      return read(() => repoAccessible(actor, repoId));
    },
    requireRepoAccess(actor, repoId) {
      read(() => {
        requireTeamMember(actor);
        if (!repoAccessible(actor, repoId)) throw referenceNotFound();
      });
    },
    putReference(actor, input) {
      return write(() => {
        requireTeamMember(actor);
        if (!repoAccessible(actor, input.locator.repo_id))
          throw referenceNotFound();
        if (input.resolved_state === "unavailable") throw referenceNotFound();
        const record: GitRangeReference = GitRangeReferenceSchema.parse({
          kind: "git_range",
          reference_id: referenceDigest(input.locator),
          team_id: actor.team_id,
          repo_id: input.locator.repo_id,
          commit_sha: input.locator.commit_sha,
          path: input.locator.path,
          line_start: input.locator.line_start,
          line_end: input.locator.line_end,
          blob_sha256: input.blob_sha256,
        });
        const existing = referenceRow(actor.team_id, record.reference_id);
        if (existing) return referenceRecord(existing);
        db.query(
          "INSERT INTO code_references (team_id, reference_id, kind, repo_id, commit_sha, path, line_start, line_end, blob_sha256, resolved_state, created_by, created_at, record_sha256) VALUES (?, ?, 'git_range', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          record.team_id,
          record.reference_id,
          record.repo_id,
          record.commit_sha,
          record.path,
          record.line_start,
          record.line_end,
          record.blob_sha256,
          input.resolved_state,
          actor.user_id,
          timestamp(),
          sha256(canonicalJson(record)),
        );
        return record;
      });
    },
    viewReference(actor, referenceId) {
      return read(() => {
        requireTeamMember(actor);
        if (!idSchema.safeParse(referenceId).success) throw referenceNotFound();
        const visible = db
          .query<{ one: number }, [string, string, string]>(
            `SELECT 1 AS one FROM message_references mr
             JOIN messages m ON m.message_id = mr.message_id
             JOIN conversations c ON c.conversation_id = m.conversation_id
             JOIN participants p ON p.conversation_id = m.conversation_id AND p.user_id = ?
             WHERE mr.team_id = ? AND mr.reference_id = ? AND c.team_id = mr.team_id
               AND p.state = 'active' AND m.seq > p.joined_seq
             LIMIT 1`,
          )
          .get(actor.user_id, actor.team_id, referenceId);
        const row = referenceRow(actor.team_id, referenceId);
        if (!visible || !row) throw referenceNotFound();
        return {
          reference: referenceRecord(row),
          accessible: repoAccessible(actor, row.repo_id),
        };
      });
    },
    close() {
      db.close();
    },
  };
}
