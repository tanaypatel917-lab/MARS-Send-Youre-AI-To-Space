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
  type GitRangeReference,
  GitRangeReferenceSchema,
  MARS_AGENT_USER_ID,
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
  type ResultCard,
  ResultCardSchema,
  type ResultShare,
  ResultShareSchema,
  SHARE_MAX_VERIFY_EVENT_IDS,
  type SharedEvidence,
  type SharedEvidenceRecord,
  type SharePreview,
  type ShareSelection,
  type ShareUnverifiedReason,
  TASK_LINK_MAX_MESSAGES,
  type TaskLink,
  TaskLinkSchema,
  TaskLinkSummarySchema,
  type TaskLinkView,
  type TaskStatus,
  TEAM_MAX_EMOJI_CHARS,
  TEAM_MAX_EXCERPT_CHARS,
  TEAM_MAX_REFERENCES,
  TEAM_MAX_SEARCH_QUERY_CHARS,
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
import {
  conflict,
  invalidInput,
  notFound,
  rateLimited,
  referenceNotFound,
  TeamError,
  unavailable,
} from "./errors";
import {
  isTeamMetricCounter,
  metricsSnapshot,
  type TeamMetrics,
  type TeamMetricsSnapshot,
} from "./metrics";
import {
  TASK_LINK_EXCERPT_CHARS,
  type TaskLinkDraftResult,
  TaskLinkDraftResultSchema,
} from "./protocol";
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
  {
    // Team Chat PR 6: chat-side task links and result cards. Workbench ids are
    // opaque here; `provenance_json` is frozen at draft time and never rewritten.
    id: "0002_task_links",
    sql: `
      CREATE TABLE task_links (
        link_id TEXT PRIMARY KEY, team_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id),
        requester_id TEXT NOT NULL, launch_key TEXT NOT NULL,
        provenance_json TEXT NOT NULL, reference_ids_json TEXT NOT NULL,
        target_json TEXT, workbench_json TEXT, task_revision INTEGER,
        status TEXT NOT NULL CHECK (status IN ('draft', 'confirmed', 'created', 'shared', 'abandoned')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, record_sha256 TEXT NOT NULL,
        UNIQUE (team_id, launch_key)
      );
      CREATE INDEX task_links_conversation ON task_links(conversation_id);
      CREATE TABLE result_shares (
        share_id TEXT PRIMARY KEY,
        link_id TEXT NOT NULL REFERENCES task_links(link_id),
        message_id TEXT NOT NULL UNIQUE REFERENCES messages(message_id),
        message_seq INTEGER NOT NULL, preview_sha256 TEXT NOT NULL,
        candidate_diff_sha256 TEXT NOT NULL, evidence_sha256 TEXT NOT NULL,
        card_json TEXT NOT NULL, created_at TEXT NOT NULL, record_sha256 TEXT NOT NULL
      );
      CREATE INDEX result_shares_link ON result_shares(link_id, message_seq);
    `,
  },
  {
    // Repo access + committed code references (Team Chat PR 4; after PR 6's 0002_task_links). `repo_id` is
    // the opaque id the host registered in the @mars/code-refs registry; no
    // filesystem path is stored. `references` is an SQL keyword, hence
    // `code_references`. Postgres-portable types only.
    id: "0003_references",
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
  {
    id: "0004_agent_requests",
    sql: `
      ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'user' CHECK (kind IN ('user', 'agent', 'result_card'));
      ALTER TABLE messages ADD COLUMN agent_request_id TEXT;
      UPDATE messages SET kind = 'result_card' WHERE message_id IN (SELECT message_id FROM result_shares);
      CREATE TABLE agent_requests (
        request_id TEXT PRIMARY KEY, team_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id),
        requester_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, params_sha256 TEXT NOT NULL,
        anchor_seq INTEGER NOT NULL,
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
  {
    // Team Chat PR 7: durable redacted counters (`TEAM_METRIC_COUNTERS` names
    // only, integer values) so `mars team stats` in another process reads
    // what the serving process counted. The `team.enabled` kill switch lives
    // in `meta` and needs no table.
    id: "0005_metrics",
    sql: `
      CREATE TABLE metrics (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
    `,
  },
];

/** Tables `exportSnapshot` dumps, in foreign-key order so `importSnapshot` can replay them. */
export const TEAM_SNAPSHOT_TABLES = [
  "members",
  "conversations",
  "participants",
  "messages",
  "reactions",
  "outbox",
  "idempotency",
  "task_links",
  "result_shares",
  "repos",
  "repo_access",
  "code_references",
  "message_references",
  "agent_requests",
  "metrics",
] as const;
export const TEAM_SNAPSHOT_SCHEMA_VERSION = 1;
const sqlValue = z.union([z.string(), z.number(), z.null()]);
/**
 * `mars team export` output: every durable row of the store plus the ledger it
 * was written under. It never contains a credential because the store holds
 * none (dev tokens live in the CLI's token file, hashed in memory only).
 */
export const TeamStoreSnapshotSchema = z
  .object({
    schema_version: z.literal(TEAM_SNAPSHOT_SCHEMA_VERSION),
    format_version: z.literal(TEAM_STORE_FORMAT_VERSION),
    ledger: z.array(z.string().min(1).max(128)).max(1000),
    /** The kill-switch state at export time; `importSnapshot` records it but leaves the restored store disabled. */
    enabled: z.boolean(),
    exported_at: z.string().datetime({ offset: true }),
    tables: z.record(
      z.enum(TEAM_SNAPSHOT_TABLES),
      z.array(z.record(z.string().regex(/^[a-z_][a-z0-9_]*$/), sqlValue)),
    ),
  })
  .strict();
export type TeamStoreSnapshot = z.infer<typeof TeamStoreSnapshotSchema>;

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

const UNVERIFIED_REASON_ORDER: readonly ShareUnverifiedReason[] = [
  "missing",
  "stale",
  "failed",
  "inconclusive",
  "skipped",
];

/**
 * The only path to `verified: true`: a selected record the workbench marked
 * `verified && !stale` for this exact candidate. Everything else yields a
 * reason; the service never judges evidence itself.
 */
export function assessVerification(
  evidence: SharedEvidence,
  selected: SharedEvidenceRecord[],
): {
  verified: boolean;
  reason: ShareUnverifiedReason | null;
  evidence_event_id: string | null;
} {
  if (selected.length === 0)
    return { verified: false, reason: "missing", evidence_event_id: null };
  const fresh = (record: SharedEvidenceRecord) =>
    !record.stale &&
    record.diff_sha256 === evidence.diff_sha256 &&
    record.workspace_revision === evidence.workspace.revision;
  const proof = selected.find((record) => record.verified && fresh(record));
  if (proof)
    return { verified: true, reason: null, evidence_event_id: proof.event_id };
  const reasons = selected.map((record): ShareUnverifiedReason => {
    if (!fresh(record)) return "stale";
    if (record.verdict === "fail" || record.verdict === "error")
      return "failed";
    if (record.verdict === "inconclusive") return "inconclusive";
    return "skipped";
  });
  const reason =
    UNVERIFIED_REASON_ORDER.find((candidate) => reasons.includes(candidate)) ??
    "missing";
  const primary = selected[reasons.indexOf(reason)] ?? selected[0];
  return {
    verified: false,
    reason,
    evidence_event_id: primary?.event_id ?? null,
  };
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

/**
 * Idempotency results stored before migration 0004 lack `agent_request_id`
 * (and, for plain sends, `kind`) on messages; replays add the values those
 * rows had.
 */
function upgradeLegacyResult(operation: string, raw: unknown): unknown {
  if (
    (operation === "messages.send" || operation === "shares.create") &&
    raw !== null &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    !("agent_request_id" in raw)
  ) {
    // Pre-0004 cards already carried `kind: "result_card"`; plain sends had no kind.
    const legacy = raw as { kind?: unknown };
    return {
      ...raw,
      kind:
        legacy.kind ?? (operation === "shares.create" ? "result_card" : "user"),
      agent_request_id: null,
    };
  }
  return raw;
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
  anchor_seq: number;
  input_json: string;
  input_sha256: string;
  record_json: string;
  record_sha256: string;
  answer_body: string | null;
  created_seq: number;
}
interface TaskLinkRow {
  link_id: string;
  team_id: string;
  conversation_id: string;
  requester_id: string;
  launch_key: string;
  provenance_json: string;
  reference_ids_json: string;
  target_json: string | null;
  workbench_json: string | null;
  task_revision: number | null;
  status: string;
  created_at: string;
  updated_at: string;
  record_sha256: string;
}
interface ResultShareRow {
  share_id: string;
  link_id: string;
  message_id: string;
  message_seq: number;
  preview_sha256: string;
  candidate_diff_sha256: string;
  evidence_sha256: string;
  card_json: string;
  created_at: string;
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
  const timestamp = () => now().toISOString();
  const metrics: TeamMetrics = {
    increment(name, by = 1) {
      if (!isTeamMetricCounter(name) || !Number.isInteger(by) || by < 0)
        throw invalidInput("Unknown metric counter");
      db.query(
        "INSERT INTO metrics (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = value + excluded.value",
      ).run(name, by);
    },
    snapshot() {
      return metricsSnapshot(
        db
          .query<{ name: string; value: number }, []>(
            "SELECT name, value FROM metrics",
          )
          .all(),
      );
    },
  };
  const readEnabled = (): boolean =>
    db
      .query<{ value: string }, []>(
        "SELECT value FROM meta WHERE key = 'team.enabled'",
      )
      .get()?.value === "1";

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
    // Rows written before migration 0004 were digested without `kind` and
    // `agent_request_id` (user text and result cards alike).
    const intact =
      sha256(canonicalJson(record)) === row.record_sha256 ||
      (row.agent_request_id === null &&
        sha256(canonicalJson(legacy)) === row.record_sha256);
    if (!intact)
      throw new TeamError("corrupt_record", "Stored message is invalid");
    const share = row.kind === "result_card" ? shareRow(row.message_id) : null;
    if (!share) return MessageSchema.parse(record);
    return MessageSchema.parse({ ...record, payload: shareView(share) });
  };

  const storedMessageRow = (messageId: string): MessageRow => {
    const row = db
      .query<MessageRow, [string]>(
        "SELECT * FROM messages WHERE message_id = ?",
      )
      .get(messageId);
    if (!row)
      throw new TeamError("corrupt_record", "Stored message is missing");
    return row;
  };

  const shareRow = (messageId: string): ResultShareRow | null =>
    db
      .query<ResultShareRow, [string]>(
        "SELECT * FROM result_shares WHERE message_id = ?",
      )
      .get(messageId) ?? null;

  /** Posted content never changes; staleness is overlaid from later shares of the same link. */
  const shareView = (row: ResultShareRow): ResultShare => {
    const stored = {
      share_id: row.share_id,
      link_id: row.link_id,
      message_id: row.message_id,
      message_seq: row.message_seq,
      preview_sha256: row.preview_sha256,
      candidate_diff_sha256: row.candidate_diff_sha256,
      evidence_sha256: row.evidence_sha256,
      card_json: row.card_json,
      created_at: row.created_at,
    };
    if (sha256(canonicalJson(stored)) !== row.record_sha256)
      throw new TeamError("corrupt_record", "Stored result share is invalid");
    const card = ResultCardSchema.safeParse(JSON.parse(row.card_json));
    if (!card.success)
      throw new TeamError("corrupt_record", "Stored result card is invalid");
    const newer = db
      .query<Pick<ResultShareRow, "message_id">, [string, number, string]>(
        "SELECT message_id FROM result_shares WHERE link_id = ? AND message_seq > ? AND candidate_diff_sha256 != ? ORDER BY message_seq ASC LIMIT 1",
      )
      .get(row.link_id, row.message_seq, row.candidate_diff_sha256);
    return ResultShareSchema.parse({
      ...card.data,
      share_id: row.share_id,
      message_id: row.message_id,
      preview_sha256: row.preview_sha256,
      stale: newer !== null && newer !== undefined,
      superseded_by: newer?.message_id ?? null,
      created_at: row.created_at,
    });
  };

  const linkRow = (linkId: string): TaskLinkRow | null =>
    idSchema.safeParse(linkId).success
      ? (db
          .query<TaskLinkRow, [string]>(
            "SELECT * FROM task_links WHERE link_id = ?",
          )
          .get(linkId) ?? null)
      : null;

  const linkRecord = (row: TaskLinkRow): TaskLink => {
    const record = {
      link_id: row.link_id,
      team_id: row.team_id,
      conversation_id: row.conversation_id,
      requester_id: row.requester_id,
      launch_key: row.launch_key,
      provenance: JSON.parse(row.provenance_json) as unknown,
      reference_ids: JSON.parse(row.reference_ids_json) as unknown,
      target:
        row.target_json === null
          ? null
          : (JSON.parse(row.target_json) as unknown),
      workbench:
        row.workbench_json === null
          ? null
          : (JSON.parse(row.workbench_json) as unknown),
      task_revision: row.task_revision,
      status: row.status,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
    if (sha256(canonicalJson(record)) !== row.record_sha256)
      throw new TeamError("corrupt_record", "Stored task link is invalid");
    return TaskLinkSchema.parse(record);
  };

  const saveLink = (link: TaskLink, insert: boolean) => {
    const recordHash = sha256(canonicalJson(link));
    if (insert) metrics.increment("links");
    if (insert)
      db.query(
        "INSERT INTO task_links (link_id, team_id, conversation_id, requester_id, launch_key, provenance_json, reference_ids_json, target_json, workbench_json, task_revision, status, created_at, updated_at, record_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        link.link_id,
        link.team_id,
        link.conversation_id,
        link.requester_id,
        link.launch_key,
        canonicalJson(link.provenance),
        canonicalJson(link.reference_ids),
        link.target === null ? null : canonicalJson(link.target),
        link.workbench === null ? null : canonicalJson(link.workbench),
        link.task_revision,
        link.status,
        link.created_at,
        link.updated_at,
        recordHash,
      );
    else
      db.query(
        "UPDATE task_links SET target_json = ?, workbench_json = ?, task_revision = ?, status = ?, updated_at = ?, record_sha256 = ? WHERE link_id = ?",
      ).run(
        link.target === null ? null : canonicalJson(link.target),
        link.workbench === null ? null : canonicalJson(link.workbench),
        link.task_revision,
        link.status,
        link.updated_at,
        recordHash,
        link.link_id,
      );
  };

  /**
   * Resolves a link for the actor: absent, foreign-team and non-participant
   * cases all answer the same `not_found`; `requesterOnly` rejects other
   * members with `forbidden` (they may inspect, never act).
   */
  const requireLink = (
    actor: TeamActor,
    linkId: string,
    requesterOnly: boolean,
  ): {
    link: TaskLink;
    conversation: ConversationRow;
    participant: ParticipantRow;
  } => {
    const row = linkRow(linkId);
    if (!row || row.team_id !== actor.team_id) throw notFound();
    const { conversation, participant } = requireParticipant(
      actor,
      row.conversation_id,
    );
    const link = linkRecord(row);
    if (link.requester_id !== actor.user_id) {
      // A member who joined (or rejoined) after the quoted messages cannot read
      // them through history, so the link stays invisible to them as well.
      if (link.provenance.some((entry) => entry.seq <= participant.joined_seq))
        throw notFound();
      if (requesterOnly)
        throw new TeamError(
          "forbidden",
          "Only the requester may act on a link",
        );
    }
    return { link, conversation, participant };
  };

  const linkRecordSchema: z.ZodType<TaskLink> = TaskLinkSchema;

  const buildCard = (
    actor: TeamActor,
    link: TaskLink,
    input: ShareInput,
  ): SharePreview => {
    if ((input.selection.artifacts?.length ?? 0) > 0)
      throw unavailable("Artifact shares are not available yet");
    if (link.status !== "created" && link.status !== "shared")
      throw conflict("Link has no workbench task yet");
    const ids = [...new Set(input.selection.verify_event_ids)];
    if (ids.length > SHARE_MAX_VERIFY_EVENT_IDS)
      throw invalidInput("Too many verify records");
    const selected = ids.map((eventId) => {
      const record = input.evidence.verify_records.find(
        (candidate) => candidate.event_id === eventId,
      );
      if (!record) throw invalidInput("Verify record is not in the evidence");
      return record;
    });
    const verdict = assessVerification(input.evidence, selected);
    const card: ResultCard = {
      link_id: link.link_id,
      requester_id: link.requester_id,
      attested_by: actor.user_id,
      summary: input.selection.summary,
      run_status: input.run_status,
      verified: verdict.verified,
      verified_reason: verdict.reason,
      task_revision: input.evidence.task_revision,
      workspace: input.evidence.workspace,
      diff_sha256: input.selection.include_diff_digest
        ? input.evidence.diff_sha256
        : null,
      evidence_event_id: verdict.evidence_event_id,
      evidence_sha256: sha256(canonicalJson(input.evidence)),
      verify_records: selected.map((record) => ({
        event_id: record.event_id,
        verdict: record.verdict,
        assurance: record.assurance,
        verified: record.verified,
        stale: record.stale,
        recorded_at: record.recorded_at,
      })),
      export_status: "not_exported",
      git_status: "unknown",
    };
    const parsed = ResultCardSchema.parse(card);
    return { preview_sha256: sha256(canonicalJson(parsed)), card: parsed };
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
    // Chips join through message_references; ids outside code_references
    // (agent citations supplied by the host port) render as restricted chips.
    record.reference_ids.forEach((referenceId, position) => {
      db.query(
        "INSERT INTO message_references (message_id, team_id, reference_id, position) SELECT ?, team_id, reference_id, ? FROM code_references WHERE team_id = ? AND reference_id = ?",
      ).run(record.message_id, position, conversation.team_id, referenceId);
    });
    conversation.last_seq = record.seq;
    metrics.increment("sends");
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
  const referenceChips = (
    actor: TeamActor,
    message: Message,
  ): ReferenceChip[] => {
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
    return references;
  };

  const emitEvent = (
    conversation: ConversationRow,
    kind: "message" | "membership" | "reaction" | "edit",
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
      if (operation === "messages.send") metrics.increment("send_replays");
      try {
        return schema.parse(
          upgradeLegacyResult(operation, JSON.parse(match.result_json)),
        );
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

  /**
   * Per-(window, team, user) sliding-minute budgets. In-memory and therefore
   * per serving process (the pilot runs one); the store itself stays
   * multi-process safe. A refused call carries the seconds until the oldest
   * stamp leaves the window, which the server turns into `Retry-After`.
   */
  const RATE_WINDOW_MS = 60_000;
  const windows = new Map<string, number[]>();
  const takeSlot = (
    actor: TeamActor,
    window: "send" | "reaction" | "search" | "agent",
    limit: number,
  ) => {
    const key = `${window}\u0000${actor.team_id}\u0000${actor.user_id}`;
    const at = now().getTime();
    const recent = (windows.get(key) ?? []).filter(
      (stamp) => at - stamp < RATE_WINDOW_MS,
    );
    if (recent.length >= limit) {
      windows.set(key, recent);
      const oldest = recent[0] ?? at;
      throw rateLimited(
        `${window} rate limit reached`,
        (oldest + RATE_WINDOW_MS - at) / 1000,
      );
    }
    recent.push(at);
    windows.set(key, recent);
  };
  const takeSearchSlot = (actor: TeamActor) =>
    takeSlot(actor, "search", limits.max_search_per_minute);
  const takeSendSlot = (actor: TeamActor) =>
    takeSlot(actor, "send", limits.max_sends_per_minute);
  const takeReactionSlot = (actor: TeamActor) =>
    takeSlot(actor, "reaction", limits.max_reactions_per_minute);
  const takeAgentSlot = (actor: TeamActor) =>
    takeSlot(actor, "agent", limits.max_agent_requests_per_minute);

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
    actor: TeamActor,
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
    return MessageViewSchema.parse({
      ...message,
      references: referenceChips(actor, message),
      reactions: reactionSummaries(row.message_id, participant.user_id),
      reply_excerpt,
      reply_restricted,
    });
  };

  const messagePage = (
    actor: TeamActor,
    participant: ParticipantRow,
    rows: MessageRow[],
    fromCursorSide: boolean,
  ): MessageView[] => {
    const page: MessageView[] = [];
    let bytes = ENVELOPE_BYTES;
    for (const row of rows) {
      const message = messageView(actor, row, participant);
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
      // A reference someone in the audience cannot read contributes nothing
      // but its id: no label, text, size or threat flag leaves the gate.
      references: references.map((entry) =>
        entry.readers.length === participants.length
          ? {
              reference_id: entry.reference_id,
              label: entry.label,
              text: entry.text,
              bytes: Buffer.byteLength(entry.text),
              flagged: scan(entry.text) ?? scan(entry.label) ?? null,
            }
          : {
              reference_id: entry.reference_id,
              label: "",
              text: "",
              bytes: 0,
              flagged: null,
            },
      ),
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
  const countAgentStatus = (status: string) => {
    const name = `agent_requests.${status}`;
    if (isTeamMetricCounter(name)) metrics.increment(name);
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
    if (next.status !== row.status) countAgentStatus(next.status);
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
      // Only participants who could see the selected messages may see the
      // request: a later joiner (`joined_seq` at or past the anchor) cannot.
      const participant = participantRow(row.conversation_id, actor.user_id);
      if (
        !participant ||
        participant.state !== "active" ||
        participant.joined_seq >= row.anchor_seq
      )
        throw notFound();
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
        if (!readEnabled()) return null;
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
    recover() {
      return write(() => {
        const rows = db
          .query<AgentRequestRow, []>(
            "SELECT * FROM agent_requests WHERE status = 'running' ORDER BY created_seq",
          )
          .all()
          .filter((row) => !cancelControllers.has(row.request_id));
        for (const row of rows)
          finish(
            row,
            agentRecord(row),
            row.cancel_requested === 1 ? "cancelled" : "failed",
            row.cancel_requested === 1 ? "cancelled" : "worker_lost",
          );
        return rows.length;
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

  const snapshotColumns = (table: string): string[] =>
    db
      .query<{ name: string }, []>(`PRAGMA table_info("${table}")`)
      .all()
      .map((column) => column.name);

  return {
    rootDir,
    limits,
    agentHost,
    migrationsApplied: Object.freeze([...migrationsApplied]),
    ledgerHead: TEAM_MIGRATIONS[TEAM_MIGRATIONS.length - 1]?.id ?? "",
    metrics,
    isEnabled() {
      return readEnabled();
    },
    setEnabled(enabled) {
      if (typeof enabled !== "boolean")
        throw invalidInput("enabled must be boolean");
      return write(() => {
        const before = readEnabled();
        db.query(
          "INSERT INTO meta (key, value) VALUES ('team.enabled', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        ).run(enabled ? "1" : "0");
        if (!enabled) notify({ type: "disabled" });
        return { enabled, changed: before !== enabled };
      });
    },
    metricsSnapshot(actor) {
      return read(() => {
        const member = requireTeamMember(actor);
        if (member.role !== "admin")
          throw new TeamError("forbidden", "Team admin role required");
        return metrics.snapshot();
      });
    },
    getReferences(teamId, referenceIds) {
      if (!idSchema.safeParse(teamId).success) return [];
      return read(() =>
        [...new Set(referenceIds)].flatMap((referenceId) => {
          if (!idSchema.safeParse(referenceId).success) return [];
          const row = referenceRow(teamId, referenceId);
          return row ? [referenceRecord(row)] : [];
        }),
      );
    },
    exportSnapshot() {
      return read(() => {
        const tables: Record<string, Record<string, string | number | null>[]> =
          {};
        for (const table of TEAM_SNAPSHOT_TABLES)
          tables[table] = db
            .query<Record<string, string | number | null>, []>(
              `SELECT * FROM "${table}" ORDER BY rowid`,
            )
            .all();
        return TeamStoreSnapshotSchema.parse({
          schema_version: TEAM_SNAPSHOT_SCHEMA_VERSION,
          format_version: TEAM_STORE_FORMAT_VERSION,
          ledger: TEAM_MIGRATIONS.map((migration) => migration.id),
          enabled: readEnabled(),
          exported_at: timestamp(),
          tables,
        });
      });
    },
    importSnapshot(raw) {
      const parsed = TeamStoreSnapshotSchema.safeParse(raw);
      if (!parsed.success) throw invalidInput("Invalid team store snapshot");
      const snapshot = parsed.data;
      const ledger = TEAM_MIGRATIONS.map((migration) => migration.id);
      if (
        snapshot.ledger.length !== ledger.length ||
        snapshot.ledger.some((id, index) => id !== ledger[index])
      )
        throw conflict(
          "Snapshot was exported under a different migration ledger",
        );
      // A partial snapshot is not a restore: every table must be present (empty arrays included).
      for (const table of TEAM_SNAPSHOT_TABLES)
        if (!snapshot.tables[table])
          throw invalidInput("Snapshot is missing a table");
      return write(() => {
        for (const table of TEAM_SNAPSHOT_TABLES) {
          const count =
            db
              .query<{ count: number }, []>(
                `SELECT COUNT(*) AS count FROM "${table}"`,
              )
              .get()?.count ?? 0;
          if (count > 0)
            throw conflict("Refusing to import into a non-empty team store");
        }
        let rows = 0;
        let tables = 0;
        for (const table of TEAM_SNAPSHOT_TABLES) {
          const incoming = snapshot.tables[table];
          if (!incoming) continue;
          tables += 1;
          const columns = snapshotColumns(table);
          const columnSet = new Set(columns);
          const insert = db.query(
            `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
          );
          for (const row of incoming) {
            const keys = Object.keys(row);
            if (
              keys.length !== columns.length ||
              keys.some((key) => !columnSet.has(key))
            )
              throw invalidInput("Snapshot row does not match the table");
            insert.run(...columns.map((column) => row[column] ?? null));
            rows += 1;
          }
        }
        return { tables, rows };
      });
    },
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
          enabled: readEnabled(),
          limits,
          capabilities: {
            stream: true,
            reactions: true,
            search: true,
            references: false,
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
        takeSendSlot(actor);
        // Before any idempotent replay: a participant removed since the
        // original send must not read the stored message back.
        requireParticipant(actor, input.conversation_id);
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
              metrics.increment("send_replays");
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
              reference_ids: referenceIds,
              created_at: timestamp(),
              edited_at: null,
              deleted: false,
            });
          },
        );
        // Chips are derived now, never stored: a replay after a revocation
        // shows the sender's own reference as restricted.
        const viewed = stored;
        const viewer = participantRow(viewed.conversation_id, actor.user_id);
        if (!viewer) throw notFound();
        // A replay (same request_id or client_message_id) of a message sent
        // before the caller's current join window would reveal that body.
        if (viewed.seq <= viewer.joined_seq)
          throw conflict("client_message_id predates the current membership");
        return messageView(actor, storedMessageRow(viewed.message_id), viewer);
      });
    },
    editMessage(actor, input) {
      return write(() => {
        requireTeamMember(actor);
        takeSendSlot(actor);
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
        return messageView(
          actor,
          storedMessageRow(message.message_id),
          requireParticipant(actor, conversation.conversation_id).participant,
        );
      });
    },
    deleteMessage(actor, input) {
      return write(() => {
        requireTeamMember(actor);
        takeSendSlot(actor);
        const parsed = z
          .object({ message_id: idSchema })
          .strict()
          .safeParse(input);
        if (!parsed.success) throw invalidInput("Invalid delete input");
        const { conversation, row } = requireOwnMessage(
          actor,
          parsed.data.message_id,
        );
        if (row.deleted === 1)
          return messageView(
            actor,
            row,
            requireParticipant(actor, conversation.conversation_id).participant,
          );
        const message = saveMessageBody(row, "", true);
        emitEvent(
          conversation,
          "edit",
          message.seq,
          message.message_id,
          conversation.revision,
        );
        saveConversation(conversation);
        return messageView(
          actor,
          storedMessageRow(message.message_id),
          requireParticipant(actor, conversation.conversation_id).participant,
        );
      });
    },
    agentPreview(actor, input) {
      return read(() => {
        requireTeamMember(actor);
        takeAgentSlot(actor);
        return buildPreview(actor, input).preview;
      });
    },
    agentRequest(actor, input) {
      return write(() => {
        requireTeamMember(actor);
        requireAgent();
        takeAgentSlot(actor);
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
        const anchorSeq =
          frozen.messages.length > 0
            ? Math.min(...frozen.messages.map((m) => m.seq))
            : conversation.last_seq + 1;
        const inputJson = canonicalJson(frozen);
        const recordJson = canonicalJson(record);
        const createdSeq =
          (db
            .query<{ max: number | null }, []>(
              "SELECT MAX(created_seq) AS max FROM agent_requests",
            )
            .get()?.max ?? 0) + 1;
        metrics.increment("agent_requests.pending");
        db.query(
          "INSERT INTO agent_requests (request_id, team_id, conversation_id, requester_id, idempotency_key, params_sha256, status, cancel_requested, anchor_seq, input_json, input_sha256, record_json, record_sha256, answer_body, created_seq) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?, NULL, ?)",
        ).run(
          record.request_id,
          record.team_id,
          record.conversation_id,
          record.requester_id,
          record.idempotency_key,
          paramsHash,
          anchorSeq,
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
          return messagePage(actor, participant, rows, false);
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
        return messagePage(actor, participant, rows, true);
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
        // Every cursor is authorized and bounds-checked before any row is
        // read, so a full page can never hide an invalid later cursor.
        const seen = new Set<string>();
        const checked: {
          conversation: ConversationRow;
          participant: ParticipantRow;
          after: number;
        }[] = [];
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
          checked.push({
            conversation,
            participant,
            after: cursor.after_event_seq,
          });
        }
        const events: TeamDeliveryEvent[] = [];
        for (const { conversation, participant, after } of checked) {
          const remaining = limit - events.length;
          if (remaining <= 0) break;
          const rows = db
            .query<OutboxRow, [string, number, number, number]>(
              "SELECT conversation_id, event_seq, kind, message_seq, message_id, revision FROM outbox WHERE conversation_id = ? AND event_seq > ? AND event_seq > ? ORDER BY event_seq ASC LIMIT ?",
            )
            .all(
              conversation.conversation_id,
              after,
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
        takeReactionSlot(actor);
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
    repoAccessState(input) {
      const row = read(() =>
        repoAccessRow(input.team_id, input.repo_id, input.user_id),
      );
      return row ? toRepoAccess(row).state : null;
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
    linkDraft(actor, requestId, input) {
      return write(() => {
        requireTeamMember(actor);
        return idempotent(
          actor,
          requestId,
          "tasks.link_draft",
          input,
          TaskLinkDraftResultSchema,
          () => {
            const parsed = z
              .object({
                conversation_id: idSchema,
                message_ids: z
                  .array(idSchema)
                  .min(1)
                  .max(TASK_LINK_MAX_MESSAGES),
                reference_ids: z.array(idSchema).max(TEAM_MAX_REFERENCES),
              })
              .strict()
              .safeParse(input);
            if (!parsed.success) throw invalidInput("Invalid task link input");
            const { conversation, participant } = requireParticipant(
              actor,
              parsed.data.conversation_id,
            );
            const rows: MessageRow[] = [];
            for (const messageId of new Set(parsed.data.message_ids)) {
              const row = db
                .query<MessageRow, [string, string]>(
                  "SELECT * FROM messages WHERE message_id = ? AND conversation_id = ?",
                )
                .get(messageId, conversation.conversation_id);
              if (!row || row.seq <= participant.joined_seq)
                throw invalidInput("Message is not in this conversation");
              rows.push(row);
            }
            rows.sort((a, b) => a.seq - b.seq);
            const at = timestamp();
            const linkId = randomId();
            const link: TaskLink = TaskLinkSchema.parse({
              link_id: linkId,
              team_id: actor.team_id,
              conversation_id: conversation.conversation_id,
              requester_id: actor.user_id,
              launch_key: `tc-${sha256(canonicalJson([actor.team_id, linkId])).slice(0, 48)}`,
              provenance: rows.map((row) => ({
                message_id: row.message_id,
                seq: row.seq,
                body_sha256: row.body_sha256,
              })),
              reference_ids: [...new Set(parsed.data.reference_ids)],
              target: null,
              workbench: null,
              task_revision: null,
              status: "draft",
              created_at: at,
              updated_at: at,
            });
            saveLink(link, true);
            return TaskLinkDraftResultSchema.parse({
              link,
              excerpts: rows.map((row) => {
                const body = row.deleted === 1 ? "" : row.body;
                const chars = Array.from(body);
                return {
                  message_id: row.message_id,
                  seq: row.seq,
                  author_id: row.author_id,
                  excerpt: chars.slice(0, TASK_LINK_EXCERPT_CHARS).join(""),
                  truncated: chars.length > TASK_LINK_EXCERPT_CHARS,
                };
              }),
            });
          },
        );
      });
    },
    linkConfirm(actor, requestId, input) {
      return write(() => {
        requireTeamMember(actor);
        return idempotent(
          actor,
          requestId,
          "tasks.link_confirm",
          input,
          linkRecordSchema,
          () => {
            const { link } = requireLink(actor, input.link_id, true);
            const workbench = TaskLinkSchema.shape.workbench
              .unwrap()
              .safeParse(input.workbench);
            if (!workbench.success)
              throw invalidInput("Invalid workbench binding");
            const target = {
              repo_id: input.target.repo_id ?? null,
              base_revision: input.target.base_revision ?? null,
            };
            if (link.status !== "draft") {
              // An interrupted confirm retried with a new request id resolves to
              // the same link only when it names the same workbench task.
              if (
                link.workbench !== null &&
                canonicalJson(link.workbench) ===
                  canonicalJson(workbench.data) &&
                canonicalJson(link.target) === canonicalJson(target)
              )
                return link;
              throw conflict("Link is already bound to a workbench task");
            }
            const confirmed = TaskLinkSchema.parse({
              ...link,
              workbench: workbench.data,
              target,
              status: "confirmed",
              updated_at: timestamp(),
            });
            saveLink(confirmed, false);
            return confirmed;
          },
        );
      });
    },
    linkCreated(actor, requestId, input) {
      return write(() => {
        requireTeamMember(actor);
        return idempotent(
          actor,
          requestId,
          "tasks.link_created",
          input,
          linkRecordSchema,
          () => {
            if (
              !Number.isInteger(input.task_revision) ||
              input.task_revision < 0
            )
              throw invalidInput("Invalid task revision");
            const { link } = requireLink(actor, input.link_id, true);
            if (
              link.status !== "confirmed" &&
              link.status !== "created" &&
              link.status !== "shared"
            )
              throw conflict("Link is not awaiting workbench creation");
            if (
              link.task_revision !== null &&
              input.task_revision < link.task_revision
            )
              throw conflict("Task revision moved backwards");
            if (link.task_revision === input.task_revision) return link;
            const created = TaskLinkSchema.parse({
              ...link,
              task_revision: input.task_revision,
              status: link.status === "shared" ? "shared" : "created",
              updated_at: timestamp(),
            });
            saveLink(created, false);
            return created;
          },
        );
      });
    },
    linkInspect(actor, linkId) {
      return read(() => {
        requireTeamMember(actor);
        const { link } = requireLink(actor, linkId, false);
        if (link.requester_id === actor.user_id)
          return { view: "requester" as const, link };
        const {
          launch_key: _key,
          target: _target,
          workbench: _wb,
          ...rest
        } = link;
        return {
          view: "member" as const,
          link: TaskLinkSummarySchema.parse(rest),
        };
      });
    },
    sharePreview(actor, input) {
      return read(() => {
        requireTeamMember(actor);
        const { link } = requireLink(actor, input.link_id, true);
        return buildCard(actor, link, input);
      });
    },
    shareCreate(actor, requestId, input) {
      return write(() => {
        requireTeamMember(actor);
        takeSendSlot(actor);
        // The idempotent replay carries the bytes as first posted; the
        // stale/superseded overlay is re-read so a retry agrees with history.
        const posted = idempotent(
          actor,
          requestId,
          "shares.create",
          input,
          MessageSchema,
          () => {
            const { link, conversation } = requireLink(
              actor,
              input.link_id,
              true,
            );
            const { preview_sha256, ...rest } = input;
            const preview = buildCard(actor, link, rest);
            if (preview.preview_sha256 !== preview_sha256)
              throw conflict("Preview digest does not match the card");
            if (Buffer.byteLength(preview.card.summary) > limits.max_body_bytes)
              throw new TeamError(
                "too_large",
                "Message body exceeds the size limit",
              );
            const seq = conversation.last_seq + 1;
            const shareId = randomId();
            const at = timestamp();
            const record = insertMessage(conversation, {
              message_id: randomId(),
              conversation_id: conversation.conversation_id,
              author_id: actor.user_id,
              kind: "result_card",
              agent_request_id: null,
              seq,
              client_message_id: `share:${shareId}`,
              body: preview.card.summary,
              body_sha256: sha256(preview.card.summary),
              reply_to: null,
              reference_ids: [],
              created_at: at,
              edited_at: null,
              deleted: false,
            });
            const stored = {
              share_id: shareId,
              link_id: link.link_id,
              message_id: record.message_id,
              message_seq: seq,
              preview_sha256: preview.preview_sha256,
              candidate_diff_sha256: input.evidence.diff_sha256,
              evidence_sha256: preview.card.evidence_sha256,
              card_json: canonicalJson(preview.card),
              created_at: at,
            };
            metrics.increment("shares");
            db.query(
              "INSERT INTO result_shares (share_id, link_id, message_id, message_seq, preview_sha256, candidate_diff_sha256, evidence_sha256, card_json, created_at, record_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ).run(
              stored.share_id,
              stored.link_id,
              stored.message_id,
              stored.message_seq,
              stored.preview_sha256,
              stored.candidate_diff_sha256,
              stored.evidence_sha256,
              stored.card_json,
              stored.created_at,
              sha256(canonicalJson(stored)),
            );
            if (link.status !== "shared")
              saveLink(
                TaskLinkSchema.parse({
                  ...link,
                  status: "shared",
                  updated_at: at,
                }),
                false,
              );
            const message = messageRecord(storedMessageRow(record.message_id));
            // A card must stay readable through messages.history even once the
            // overlay marks it stale and every reaction key is in use: the
            // history item (`MessageView`) at its ceiling is what is measured.
            const worstCase = {
              ...message,
              references: message.reference_ids.map((referenceId) => ({
                reference_id: referenceId,
                restricted: false,
                repo_id: "\uffff".repeat(256),
                commit_sha: "f".repeat(40),
                path: "\uffff".repeat(1024),
                line_start: Number.MAX_SAFE_INTEGER,
                line_end: Number.MAX_SAFE_INTEGER,
              })),
              payload: message.payload && {
                ...message.payload,
                stale: true,
                superseded_by: message.message_id,
              },
              reactions: Array.from(
                { length: limits.max_reactions_per_message },
                () => ({
                  emoji: "\uffff".repeat(TEAM_MAX_EMOJI_CHARS),
                  count: Number.MAX_SAFE_INTEGER,
                  reacted: true,
                }),
              ),
              reply_excerpt:
                message.reply_to === null
                  ? null
                  : "\uffff".repeat(TEAM_MAX_EXCERPT_CHARS),
              reply_restricted: false,
            };
            if (
              Buffer.byteLength(JSON.stringify(worstCase)) + ENVELOPE_BYTES >
              limits.max_page_bytes
            )
              throw new TeamError(
                "too_large",
                "Result card exceeds the page size",
              );
            return message;
          },
        );
        const viewed = messageRecord(storedMessageRow(posted.message_id));
        const viewer = participantRow(viewed.conversation_id, actor.user_id);
        if (!viewer) throw notFound();
        return messageView(actor, storedMessageRow(viewed.message_id), viewer);
      });
    },
    close() {
      listeners.clear();
      db.close();
    },
  };
}
