import { Database } from "bun:sqlite";
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { chmod, mkdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { RequestContext, Scope } from "@mars/contracts";
import { CollaborationError } from "./errors";
import {
  type CollaborationLimits,
  CollaborationLimitsSchema,
  RequestContextSchema,
  type RoomStats,
} from "./schemas";

export const STORE_FORMAT_VERSION = 2;

export const DEFAULT_LIMITS: CollaborationLimits = {
  max_depth: 2,
  max_children_per_agent: 4,
  max_total_children: 8,
  max_recipients: 4,
  max_body_bytes: 8192,
  max_instruction_bytes: 16384,
  max_summary_bytes: 4096,
  max_artifacts: 8,
  max_inbox_backlog: 32,
  max_room_messages: 256,
  max_pair_messages: 16,
  max_reply_hops: 6,
  default_ttl_ms: 600_000,
  max_ttl_ms: 3_600_000,
  page_limit: 50,
  lease_ms: 30_000,
  max_attempts: 2,
};

export const EMPTY_STATS: RoomStats = {
  messages_sent: 0,
  deliveries: 0,
  redeliveries: 0,
  acked: 0,
  expired: 0,
  rejected_backpressure: 0,
  rejected_loop: 0,
  rejected_forbidden: 0,
  replayed_sends: 0,
  delegations: 0,
  replayed_delegations: 0,
  children_completed: 0,
  children_failed: 0,
  children_cancelled: 0,
  children_expired: 0,
  discarded_results: 0,
  usage_unaccounted: 0,
  over_budget: 0,
  results_accepted: 0,
  results_rejected: 0,
  results_stale: 0,
  tokens: { input: 0, output: 0 },
  usd: 0,
  steps: 0,
  reserved: { tokens: 0, usd: 0 },
};

export interface CollaborationStoreOptions {
  rootDir: string;
  hostPrivateRoots: readonly string[];
  limits?: Partial<CollaborationLimits>;
  now?: () => number;
  randomId?: () => string;
  randomToken?: () => string;
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    if (serialized === undefined)
      throw new CollaborationError("invalid_input", "Value is not JSON data");
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

export function parseJson<T>(value: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new CollaborationError("corrupt_record", "Stored record is invalid");
  }
}

export function defaultToken(): string {
  return randomBytes(32).toString("base64url");
}

export function equalScope(left: Scope, right: Scope): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function parseContext(context: RequestContext): RequestContext {
  const parsed = RequestContextSchema.parse(context);
  return parsed;
}

export function isTerminalStatus(
  status: string,
): status is "completed" | "failed" | "cancelled" | "expired" {
  return ["completed", "failed", "cancelled", "expired"].includes(status);
}

export class CollaborationStore {
  readonly rootDir: string;
  readonly hostPrivateRoots: readonly string[];
  readonly limits: CollaborationLimits;
  readonly now: () => number;
  readonly randomId: () => string;
  readonly randomToken: () => string;
  readonly db: Database;
  private isClosed = false;

  private constructor(
    rootDir: string,
    options: CollaborationStoreOptions,
    db: Database,
  ) {
    this.rootDir = rootDir;
    this.hostPrivateRoots = options.hostPrivateRoots;
    this.limits = CollaborationLimitsSchema.parse({
      ...DEFAULT_LIMITS,
      ...options.limits,
    });
    this.now = options.now ?? Date.now;
    this.randomId = options.randomId ?? randomUUID;
    this.randomToken = options.randomToken ?? defaultToken;
    this.db = db;
  }

  static async open(
    options: CollaborationStoreOptions,
  ): Promise<CollaborationStore> {
    if (!isAbsolute(options.rootDir))
      throw new CollaborationError("invalid_input", "rootDir must be absolute");
    let root = options.rootDir;
    try {
      await mkdir(root, { recursive: true, mode: 0o700 });
      root = await realpath(root);
      await chmod(root, 0o700);
      if (((await stat(root)).mode & 0o077) !== 0)
        throw new Error("unsafe mode");
    } catch {
      throw new CollaborationError(
        "invalid_input",
        "Collaboration state directory must be private",
      );
    }
    const dbPath = join(root, "collaboration.sqlite");
    let db!: Database;
    try {
      db = new Database(dbPath, { create: true, strict: true });
      db.exec(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000;",
      );
      await chmod(dbPath, 0o600);
      db.exec(`
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS rooms (
          room_id TEXT PRIMARY KEY, scope_json TEXT NOT NULL, task_id TEXT NOT NULL,
          task_revision INTEGER NOT NULL, budget_json TEXT NOT NULL, deadline REAL NOT NULL,
          limits_json TEXT NOT NULL, status TEXT NOT NULL, model_id TEXT, next_seq INTEGER NOT NULL,
          created_at REAL NOT NULL, open_key TEXT NOT NULL, open_digest TEXT NOT NULL,
          root_agent_id TEXT NOT NULL, counters_json TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS rooms_scope_task_open
          ON rooms(scope_json, task_id) WHERE status IN ('open', 'draining');
        CREATE TABLE IF NOT EXISTS members (
          agent_id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(room_id),
          parent_agent_id TEXT, depth INTEGER NOT NULL, role_label TEXT NOT NULL,
          status TEXT NOT NULL, task_revision INTEGER NOT NULL, token_hash TEXT UNIQUE NOT NULL,
          authority_json TEXT NOT NULL, peers_json TEXT NOT NULL, budget_json TEXT NOT NULL,
          usage_json TEXT NOT NULL, reserved_json TEXT NOT NULL, pool_json TEXT NOT NULL,
          instruction_digest TEXT NOT NULL,
          instruction_text TEXT NOT NULL, workspace_mode TEXT NOT NULL, write_paths_json TEXT NOT NULL,
          created_at REAL NOT NULL,
          max_steps INTEGER, max_messages INTEGER, acceptance_json TEXT NOT NULL,
          solution_space TEXT, complexity TEXT, paid_models INTEGER NOT NULL,
          UNIQUE(room_id, agent_id)
        );
        CREATE INDEX IF NOT EXISTS members_room_parent ON members(room_id, parent_agent_id, created_at);
        CREATE TABLE IF NOT EXISTS stale_capabilities (
          token_hash TEXT PRIMARY KEY, room_id TEXT NOT NULL, agent_id TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS messages (
          message_id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(room_id),
          seq INTEGER NOT NULL, sender_id TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL,
          in_reply_to TEXT, artifacts_json TEXT NOT NULL, created_at REAL NOT NULL,
          expires_at REAL NOT NULL, hop INTEGER NOT NULL, idempotency_key TEXT NOT NULL,
          digest TEXT NOT NULL, UNIQUE(room_id, seq), UNIQUE(room_id, sender_id, idempotency_key)
        );
        CREATE TABLE IF NOT EXISTS deliveries (
          message_id TEXT NOT NULL REFERENCES messages(message_id), recipient_id TEXT NOT NULL,
          state TEXT NOT NULL, delivered_count INTEGER NOT NULL, first_delivered_at REAL,
          acked_at REAL, PRIMARY KEY(message_id, recipient_id)
        );
        CREATE INDEX IF NOT EXISTS deliveries_recipient_state ON deliveries(recipient_id, state);
        CREATE TABLE IF NOT EXISTS delegations (
          room_id TEXT NOT NULL, parent_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
          digest TEXT NOT NULL, child_id TEXT NOT NULL, PRIMARY KEY(room_id, parent_id, idempotency_key)
        );
        CREATE TABLE IF NOT EXISTS jobs (
          job_id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(room_id),
          agent_id TEXT NOT NULL, state TEXT NOT NULL, attempt INTEGER NOT NULL,
          lease_owner TEXT, lease_epoch INTEGER NOT NULL, lease_expires_at REAL,
          cancel_requested INTEGER NOT NULL, session_ref TEXT, base_revision TEXT,
          charged_usage_json TEXT NOT NULL, created_seq INTEGER NOT NULL,
          model_id TEXT, model_reason TEXT
        );
        CREATE INDEX IF NOT EXISTS jobs_queued ON jobs(state, created_seq);
        CREATE TABLE IF NOT EXISTS write_claims (
          room_id TEXT NOT NULL, path TEXT NOT NULL, agent_id TEXT NOT NULL,
          PRIMARY KEY(room_id, path, agent_id)
        );
        CREATE TABLE IF NOT EXISTS results (
          result_id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(room_id),
          child_agent_id TEXT NOT NULL, parent_agent_id TEXT NOT NULL,
          source_task_id TEXT NOT NULL, source_task_revision INTEGER NOT NULL,
          base_revision TEXT, status TEXT NOT NULL, outcome TEXT NOT NULL,
          summary TEXT NOT NULL, summary_truncated INTEGER NOT NULL,
          unsafe_summary INTEGER NOT NULL, artifacts_json TEXT NOT NULL,
          usage_json TEXT NOT NULL, created_at REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS results_parent ON results(room_id, parent_agent_id, created_at);
      `);
      const memberColumns = db
        .query<{ name: string }, []>("PRAGMA table_info(members)")
        .all();
      if (!memberColumns.some((column) => column.name === "pool_json"))
        db.exec(
          `ALTER TABLE members ADD COLUMN pool_json TEXT NOT NULL DEFAULT '{"tokens":0,"usd":0}'`,
        );
      const init = db.transaction(() => {
        const current = db
          .query<{ value: string }, [string]>(
            "SELECT value FROM meta WHERE key = ?",
          )
          .get("format_version");
        if (
          current &&
          current.value !== "1" &&
          current.value !== String(STORE_FORMAT_VERSION)
        )
          throw new CollaborationError(
            "corrupt_record",
            "Unsupported collaboration store format",
          );
        db.query(
          "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        ).run("format_version", String(STORE_FORMAT_VERSION));
      });
      init.immediate();
    } catch (error) {
      db?.close();
      if (error instanceof CollaborationError) throw error;
      throw new CollaborationError(
        "invalid_input",
        "Unable to open private collaboration state",
      );
    }
    return new CollaborationStore(root, options, db);
  }

  transaction<T>(work: () => T): T {
    this.assertOpen();
    return this.db.transaction(work).immediate();
  }

  assertOpen(): void {
    if (this.isClosed)
      throw new CollaborationError("closed", "Collaboration store is closed");
  }

  close(): void {
    if (this.isClosed) return;
    this.db.close();
    this.isClosed = true;
  }

  bump(roomId: string, key: keyof RoomStats, by = 1): void {
    const row = this.getRoomRow(roomId);
    const counters = parseJson<RoomStats>(row.counters_json);
    if (key === "tokens" || key === "reserved") return;
    const current = counters[key];
    if (typeof current === "number") counters[key] = current + by;
    this.db
      .query("UPDATE rooms SET counters_json = ? WHERE room_id = ?")
      .run(JSON.stringify(counters), roomId);
  }

  getRoomRow(roomId: string): RoomRow {
    const room = this.db
      .query<RoomRow, [string]>("SELECT * FROM rooms WHERE room_id = ?")
      .get(roomId);
    if (!room)
      throw new CollaborationError("not_found", "Collaboration room not found");
    return room;
  }

  getMemberRow(agentId: string): MemberRow {
    const member = this.db
      .query<MemberRow, [string]>("SELECT * FROM members WHERE agent_id = ?")
      .get(agentId);
    if (!member)
      throw new CollaborationError(
        "not_found",
        "Collaboration member not found",
      );
    return member;
  }

  getMemberByToken(token: string): MemberRow | null {
    const hash = sha256(token);
    return (
      this.db
        .query<MemberRow, [string]>(
          "SELECT * FROM members WHERE token_hash = ?",
        )
        .get(hash) ?? null
    );
  }

  tokenMatches(token: string, storedHash: string): boolean {
    const actual = Buffer.from(sha256(token), "hex");
    const expected = Buffer.from(storedHash, "hex");
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  }
}

export interface RoomRow {
  room_id: string;
  scope_json: string;
  task_id: string;
  task_revision: number;
  budget_json: string;
  deadline: number;
  limits_json: string;
  status: "open" | "draining" | "closed";
  model_id: string | null;
  next_seq: number;
  created_at: number;
  open_key: string;
  open_digest: string;
  root_agent_id: string;
  counters_json: string;
}

export interface MemberRow {
  agent_id: string;
  room_id: string;
  parent_agent_id: string | null;
  depth: number;
  role_label: string;
  status: "active" | "completed" | "failed" | "cancelled" | "expired";
  task_revision: number;
  token_hash: string;
  authority_json: string;
  peers_json: string;
  budget_json: string;
  usage_json: string;
  reserved_json: string;
  pool_json: string;
  instruction_digest: string;
  instruction_text: string;
  workspace_mode: "private" | "read_only" | "parent";
  write_paths_json: string;
  created_at: number;
  max_steps: number | null;
  max_messages: number | null;
  acceptance_json: string;
  solution_space: string | null;
  complexity: string | null;
  paid_models: number;
}
