import { Database } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { Locator } from "@mars/code-refs";
import type {
  AgentPreview,
  AgentRequest,
  Conversation,
  GitRangeReference,
  MessageView,
  Participant,
  ReferencePreviewState,
  Repo,
  RepoAccess,
  SharedEvidence,
  SharePreview,
  ShareSelection,
  TaskLink,
  TaskLinkView,
  TaskStatus,
  TeamDeliveryEvent,
  TeamMembership,
  TeamRole,
} from "@mars/contracts";
import type { TeamAgentHostPort, TeamAgentOptions } from "./agent";
import { invalidInput, TeamError } from "./errors";
import type { TeamMetrics, TeamMetricsSnapshot } from "./metrics";
import type { TaskLinkDraftResult } from "./protocol";
import {
  DEFAULT_TEAM_LIMITS,
  type TeamLimits,
  TeamLimitsSchema,
} from "./schemas";
import { agentOperations } from "./store-agent";
import { conversationOperations } from "./store-conversations";
import { linkOperations } from "./store-links";
import { messageOperations } from "./store-messages";
import { TEAM_MIGRATIONS, TEAM_STORE_FORMAT_VERSION } from "./store-migrations";
import { referenceOperations } from "./store-references";
import { createStoreScope } from "./store-scope";
import { snapshotOperations, type TeamStoreSnapshot } from "./store-snapshot";
import { teamOperations } from "./store-team";

export { dmKey } from "./store-conversations";
export { assessVerification } from "./store-links";
export { TEAM_MIGRATIONS, TEAM_STORE_FORMAT_VERSION };
export {
  TEAM_SNAPSHOT_SCHEMA_VERSION,
  TEAM_SNAPSHOT_TABLES,
  type TeamStoreSnapshot,
  TeamStoreSnapshotSchema,
} from "./store-snapshot";

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

export interface ConversationListItem extends ConversationView {
  unread_count: number;
  last_message_at: string | null;
}

export interface ReactionSummary {
  emoji: string;
  count: number;
  reacted: boolean;
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
  | { type: "removed"; conversation_id: string; user_id: string }
  /** The host switched `team.enabled` off; the server closes every stream. */
  | { type: "disabled" };

export interface TeamDescription {
  team_id: string;
  user_id: string;
  role: TeamRole;
  /** The host kill switch (`meta.team.enabled`); when false only this call answers. */
  enabled: boolean;
  limits: TeamLimits;
  capabilities: {
    stream: boolean;
    reactions: boolean;
    search: boolean;
    /** Set by the server when a `@mars/code-refs` registry is wired in. */
    references: boolean;
    agent: boolean;
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
  /** Host-side lookup of active team ids for a user (used by token/GitHub authenticators). */
  activeTeamIds(user_id: string): string[];
  /** Returns 'active', 'removed', or null if the user was never provisioned in this team. */
  teamMemberState(input: {
    team_id: string;
    user_id: string;
  }): "active" | "removed" | null;
  /** Returns the stored role for a team member, or null if never provisioned. */
  teamMemberRole(input: { team_id: string; user_id: string }): TeamRole | null;
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
  send(actor: TeamActor, requestId: string, input: SendInput): MessageView;
  /** Author only; the stored body, `body_sha256` and `edited_at` change, `seq` does not. */
  editMessage(
    actor: TeamActor,
    input: { message_id: string; body: string },
  ): MessageView;
  /** Author only; the body is cleared and `deleted` set, the row stays so citations keep resolving. */
  deleteMessage(actor: TeamActor, input: { message_id: string }): MessageView;
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
  /** Host-side: the stored access row's state, or null when none was ever written (lets provisioning skip revoked rows). */
  repoAccessState(input: {
    team_id: string;
    repo_id: string;
    user_id: string;
  }): "active" | "removed" | null;
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
  /** Idempotent set/remove; emits a `reaction` outbox row only on change. */
  setReaction(
    actor: TeamActor,
    input: { message_id: string; emoji: string; on: boolean },
  ): ReactionState;
  /** Membership-filtered before excerpting; newest first; opaque cursor. */
  search(actor: TeamActor, query: SearchQuery): SearchPage;
  /** Post-commit notices for the in-process server (streams). */
  subscribe(listener: (notice: StoreNotice) => void): () => void;
  /** Start-task handoff, chat half: the workbench task itself is created by the client. */
  linkDraft(
    actor: TeamActor,
    requestId: string,
    input: LinkDraftInput,
  ): TaskLinkDraftResult;
  linkConfirm(
    actor: TeamActor,
    requestId: string,
    input: LinkConfirmInput,
  ): TaskLink;
  linkCreated(
    actor: TeamActor,
    requestId: string,
    input: { link_id: string; task_revision: number },
  ): TaskLink;
  linkInspect(actor: TeamActor, linkId: string): TaskLinkView;
  /** Exactly the card `shareCreate` would post, plus its digest. */
  sharePreview(actor: TeamActor, input: ShareInput): SharePreview;
  shareCreate(
    actor: TeamActor,
    requestId: string,
    input: ShareInput & { preview_sha256: string },
  ): MessageView;
  /** The exact context list a client shows before `agent.request`; its digest is `preview_sha256`. */
  agentPreview(actor: TeamActor, input: AgentSelection): AgentPreview;
  agentRequest(actor: TeamActor, input: AgentRequestInput): AgentRequest;
  agentCancel(actor: TeamActor, input: { request_id: string }): AgentRequest;
  /** Requester or active participant only; everyone else gets `not_found`. */
  agentInspect(actor: TeamActor, input: { request_id: string }): AgentRequest;
  /** Host-only driver; never exposed over RPC. */
  readonly agentHost: TeamAgentHostPort;
  /** Migration ids this `createTeamStore` call applied (empty when the ledger was already current). */
  readonly migrationsApplied: readonly string[];
  /** Last ledger id in the store after opening. */
  readonly ledgerHead: string;
  /** Kill switch, re-read from `meta` on every call; default off. Host-only writer. */
  isEnabled(): boolean;
  setEnabled(enabled: boolean): { enabled: boolean; changed: boolean };
  /** Durable redacted counters; fixed names, integer values. */
  readonly metrics: TeamMetrics;
  /** `team.metrics`: team admins only (`forbidden` otherwise). */
  metricsSnapshot(actor: TeamActor): TeamMetricsSnapshot;
  /** Host-only read of stored reference locators (no viewer check; callers authorize per viewer). Unknown ids are omitted. */
  getReferences(
    teamId: string,
    referenceIds: readonly string[],
  ): GitRangeReference[];
  /** Host-only: every durable row for `mars team export`. */
  exportSnapshot(): TeamStoreSnapshot;
  /** Host-only: replays a snapshot into an empty store at the same ledger; `conflict` otherwise. */
  importSnapshot(snapshot: unknown): { tables: number; rows: number };
  close(): void;
}

export interface LinkDraftInput {
  conversation_id: string;
  message_ids: string[];
  reference_ids: string[];
}
export interface LinkConfirmInput {
  link_id: string;
  workbench: NonNullable<TaskLink["workbench"]>;
  target: { repo_id?: string | undefined; base_revision?: string | undefined };
}
export interface ShareInput {
  link_id: string;
  evidence: SharedEvidence;
  run_status: TaskStatus;
  selection: ShareSelection;
}

export { canonicalJson, sha256 } from "./store-db";

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

function openDatabase(rootDir: string): {
  db: Database;
  applied: string[];
} {
  const dbPath = join(rootDir, "team.sqlite");
  const appliedNow: string[] = [];
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
        appliedNow.push(migration.id);
      }
    }).immediate();
  } catch (error) {
    db.close();
    throw error;
  }
  return { db, applied: appliedNow };
}

export function createTeamStore(options: TeamStoreOptions): TeamStore {
  const limits = TeamLimitsSchema.parse({
    ...DEFAULT_TEAM_LIMITS,
    ...(options.limits ?? {}),
  });
  const now = options.now ?? (() => new Date());
  const randomId = options.randomId ?? (() => Bun.randomUUIDv7());
  const rootDir = prepareRoot(options.rootDir);
  const { db, applied: migrationsApplied } = openDatabase(rootDir);
  const scope = createStoreScope(db, {
    limits,
    now,
    randomId,
    agentOptions: options.agent,
  });
  const { listeners, metrics } = scope;

  return {
    rootDir,
    limits,
    migrationsApplied: Object.freeze([...migrationsApplied]),
    ledgerHead: TEAM_MIGRATIONS[TEAM_MIGRATIONS.length - 1]?.id ?? "",
    metrics,
    ...teamOperations(scope),
    ...snapshotOperations(scope),
    ...conversationOperations(scope),
    ...messageOperations(scope),
    ...agentOperations(scope),
    ...referenceOperations(scope),
    ...linkOperations(scope),
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
