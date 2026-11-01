import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import type { ResearchFinding } from "@mars/contracts";
import { canonicalJson } from "@mars/tasks";
import { ResearchError, throwResearchError } from "./errors";
import {
  proposedEventInput,
  type ResearchWorkerVersion,
  staleEventInput,
} from "./events";
import { ResearchFindingSchema } from "./schemas";

export const RESEARCH_STORE_FORMAT_VERSION = 2;

const V1_STORE_FORMAT_VERSION = 1;

export interface StoreOptions {
  rootDir: string;
  hostPrivateRoots?: readonly string[];
}

export interface PrivateNeedles {
  readonly exact: ReadonlySet<string>;
  readonly roots: ReadonlySet<string>;
}

export interface OpenResearchStore {
  readonly db: Database;
  readonly rootDir: string;
  readonly privateNeedles: PrivateNeedles;
  close(): void;
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function timestamp(now: number): string {
  return new Date(now).toISOString();
}

function pathContains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function resolveForSafety(value: string): string {
  const absolute = path.resolve(value);
  try {
    return realpathSync(absolute);
  } catch {
    const suffix: string[] = [];
    let existing = absolute;
    while (!existsSync(existing)) {
      const parent = path.dirname(existing);
      if (parent === existing) return absolute;
      suffix.unshift(path.basename(existing));
      existing = parent;
    }
    return path.resolve(realpathSync(existing), ...suffix);
  }
}

function prepareRoot(options: StoreOptions): {
  rootDir: string;
  privateNeedles: PrivateNeedles;
} {
  if (!path.isAbsolute(options.rootDir)) {
    throw new ResearchError("invalid_input", "rootDir must be absolute");
  }
  const requestedRoot = path.resolve(options.rootDir);
  const privateRoots = new Set<string>();
  for (const candidate of options.hostPrivateRoots ?? []) {
    if (
      typeof candidate !== "string" ||
      !path.isAbsolute(candidate) ||
      path.resolve(candidate) === path.parse(path.resolve(candidate)).root
    ) {
      throw new ResearchError(
        "invalid_input",
        "hostPrivateRoots must be absolute non-root paths",
      );
    }
    privateRoots.add(path.resolve(candidate));
    privateRoots.add(resolveForSafety(candidate));
  }

  const rootDir = resolveForSafety(requestedRoot);
  for (const privateRoot of privateRoots) {
    if (
      pathContains(rootDir, privateRoot) ||
      pathContains(privateRoot, rootDir)
    ) {
      throw new ResearchError(
        "unsafe_path",
        "Research store root overlaps a private path",
      );
    }
  }

  let rootStat: ReturnType<typeof lstatSync> | undefined;
  try {
    rootStat = lstatSync(requestedRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new ResearchError("unsafe_path", "Research store root is unsafe");
    }
  }
  if (rootStat) {
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new ResearchError(
        "unsafe_path",
        "Research store root must be a real directory",
      );
    }
    if (
      typeof process.getuid === "function" &&
      rootStat.uid !== process.getuid()
    ) {
      throw new ResearchError(
        "unsafe_path",
        "Research store root must be owned by the current user",
      );
    }
    const entries = readdirSync(requestedRoot);
    if (entries.length > 0 && !entries.includes("research.sqlite")) {
      throw new ResearchError(
        "unsafe_path",
        "Research store root is not empty and has no database",
      );
    }
  } else {
    try {
      mkdirSync(requestedRoot, { recursive: true, mode: 0o700 });
    } catch {
      throw new ResearchError("unsafe_path", "Research store root is unsafe");
    }
  }
  chmodSync(requestedRoot, 0o700);
  const realRoot = realpathSync(requestedRoot);
  for (const privateRoot of privateRoots) {
    if (
      pathContains(realRoot, privateRoot) ||
      pathContains(privateRoot, realRoot)
    ) {
      throw new ResearchError(
        "unsafe_path",
        "Research store root overlaps a private path",
      );
    }
  }
  return {
    rootDir: realRoot,
    privateNeedles: { exact: privateRoots, roots: privateRoots },
  };
}

const CREATE_V2_SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS requests (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    scope_key TEXT NOT NULL,
    request_id TEXT NOT NULL,
    scope_json TEXT NOT NULL,
    idem_request_id TEXT NOT NULL,
    input_sha256 TEXT NOT NULL,
    record_json TEXT NOT NULL,
    record_sha256 TEXT NOT NULL,
    task_id TEXT NOT NULL,
    task_revision INTEGER NOT NULL,
    status TEXT NOT NULL,
    stale INTEGER NOT NULL,
    cancel_requested INTEGER NOT NULL,
    attempts INTEGER NOT NULL,
    max_attempts INTEGER NOT NULL,
    submitted_at TEXT NOT NULL,
    requested_deadline TEXT NOT NULL,
    deadline TEXT NOT NULL,
    available_at INTEGER NOT NULL,
    lease_owner TEXT,
    lease_token TEXT,
    lease_expires_at INTEGER,
    usage_json TEXT NOT NULL,
    error_code TEXT,
    worker_json TEXT,
    finished_at TEXT,
    stale_event_state TEXT NOT NULL,
    stale_event_request_id TEXT,
    stale_event_json TEXT,
    UNIQUE(scope_key, request_id),
    UNIQUE(scope_key, idem_request_id)
  );
  CREATE INDEX IF NOT EXISTS requests_claimable
    ON requests(status, available_at, seq);
  CREATE INDEX IF NOT EXISTS requests_scope_active
    ON requests(scope_key, status);
  CREATE TABLE IF NOT EXISTS findings (
    scope_key TEXT NOT NULL,
    request_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    finding_id TEXT NOT NULL,
    finding_key TEXT NOT NULL,
    record_json TEXT NOT NULL,
    record_sha256 TEXT NOT NULL,
    status TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    event_state TEXT NOT NULL,
    event_request_id TEXT,
    event_json TEXT,
    PRIMARY KEY(scope_key, request_id, seq),
    UNIQUE(scope_key, finding_id),
    UNIQUE(scope_key, request_id, finding_key),
    FOREIGN KEY(scope_key, request_id) REFERENCES requests(scope_key, request_id)
  );
  CREATE TABLE IF NOT EXISTS evidence (
    scope_key TEXT NOT NULL,
    request_id TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    media_type TEXT NOT NULL,
    byte_length INTEGER NOT NULL,
    url TEXT NOT NULL,
    retrieved_at TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    PRIMARY KEY(scope_key, request_id, artifact_id, url, retrieved_at),
    FOREIGN KEY(scope_key, request_id) REFERENCES requests(scope_key, request_id)
  );
`;

function workerFromJson(value: string | null): ResearchWorkerVersion | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      typeof (parsed as { id?: unknown }).id === "string" &&
      (parsed as { id: string }).id.length > 0 &&
      typeof (parsed as { version?: unknown }).version === "string" &&
      (parsed as { version: string }).version.length > 0
    ) {
      return {
        id: (parsed as { id: string }).id,
        version: (parsed as { version: string }).version,
      };
    }
  } catch {
    // Invalid persisted worker metadata is corrupt state.
  }
  throw new ResearchError("corrupt_record", "Corrupt worker record");
}

function verifiedFindingForMigration(row: {
  record_json: string;
  record_sha256: string;
  finding_id: string;
  request_id: string;
  status: string;
}): ResearchFinding {
  verifyRecordHash(row.record_json, row.record_sha256);
  let decoded: unknown;
  try {
    decoded = JSON.parse(row.record_json);
  } catch {
    throw new ResearchError("corrupt_record", "Corrupt finding record");
  }
  const parsed = ResearchFindingSchema.safeParse(decoded);
  if (
    !parsed.success ||
    canonicalJson(parsed.data) !== row.record_json ||
    parsed.data.finding_id !== row.finding_id ||
    parsed.data.request_id !== row.request_id ||
    parsed.data.status !== row.status
  ) {
    throw new ResearchError("corrupt_record", "Corrupt finding record");
  }
  return parsed.data;
}

function ensureV2OutboxColumns(db: Database): void {
  const addIfMissing = (
    table: "findings" | "requests",
    column:
      | "event_request_id"
      | "event_json"
      | "stale_event_request_id"
      | "stale_event_json",
  ): void => {
    const columns = db.query(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>;
    if (columns.some((existing) => existing.name === column)) return;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
  };
  addIfMissing("findings", "event_request_id");
  addIfMissing("findings", "event_json");
  addIfMissing("requests", "stale_event_request_id");
  addIfMissing("requests", "stale_event_json");
}

function backfillV1Events(db: Database): void {
  const findings = db
    .query(
      `SELECT f.scope_key, f.request_id, f.seq, f.finding_id, f.status,
              f.record_json, f.record_sha256, r.worker_json
       FROM findings AS f
       JOIN requests AS r
         ON r.scope_key = f.scope_key AND r.request_id = f.request_id
       WHERE f.event_state = 'pending' AND f.event_json IS NULL
       ORDER BY f.scope_key, f.request_id, f.seq`,
    )
    .all() as Array<{
    scope_key: string;
    request_id: string;
    seq: number;
    finding_id: string;
    status: string;
    record_json: string;
    record_sha256: string;
    worker_json: string | null;
  }>;
  for (const row of findings) {
    const finding = verifiedFindingForMigration(row);
    const event = proposedEventInput(
      row.request_id,
      finding,
      workerFromJson(row.worker_json),
      V1_STORE_FORMAT_VERSION,
    );
    db.query(
      `UPDATE findings SET event_request_id = ?, event_json = ?
       WHERE scope_key = ? AND request_id = ? AND seq = ?
         AND event_state = 'pending' AND event_json IS NULL`,
    ).run(
      event.eventRequestId,
      event.eventJson,
      row.scope_key,
      row.request_id,
      row.seq,
    );
  }

  const staleRequests = db
    .query(
      `SELECT scope_key, request_id, task_revision, worker_json
       FROM requests
       WHERE stale_event_state = 'pending' AND stale_event_json IS NULL
       ORDER BY seq`,
    )
    .all() as Array<{
    scope_key: string;
    request_id: string;
    task_revision: number;
    worker_json: string | null;
  }>;
  for (const row of staleRequests) {
    const staleFindingIds = db
      .query(
        `SELECT finding_id FROM findings
         WHERE scope_key = ? AND request_id = ? AND status = 'stale'
         ORDER BY seq`,
      )
      .all(row.scope_key, row.request_id) as Array<{ finding_id: string }>;
    const event = staleEventInput(
      row.request_id,
      row.task_revision,
      staleFindingIds.map((finding) => finding.finding_id),
      workerFromJson(row.worker_json),
      V1_STORE_FORMAT_VERSION,
    );
    db.query(
      `UPDATE requests SET stale_event_request_id = ?, stale_event_json = ?
       WHERE scope_key = ? AND request_id = ?
         AND stale_event_state = 'pending' AND stale_event_json IS NULL`,
    ).run(event.eventRequestId, event.eventJson, row.scope_key, row.request_id);
  }
}

function prepareDatabase(db: Database): void {
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000;",
  );
  const migrate = db.transaction(() => {
    db.exec(
      "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    const format = db
      .query("SELECT value FROM meta WHERE key = 'format_version'")
      .get() as { value: string } | null;
    if (
      format?.value !== undefined &&
      format.value !== "1" &&
      format.value !== "2"
    ) {
      throw new ResearchError(
        "corrupt_record",
        "Unsupported research store format version",
      );
    }
    db.exec(CREATE_V2_SCHEMA);
    if (format?.value === "1") {
      ensureV2OutboxColumns(db);
      backfillV1Events(db);
      db.query("UPDATE meta SET value = ? WHERE key = 'format_version'").run(
        String(RESEARCH_STORE_FORMAT_VERSION),
      );
      return;
    }
    if (format?.value === "2") {
      const columns = {
        findings: new Set(
          (
            db.query("PRAGMA table_info(findings)").all() as Array<{
              name: string;
            }>
          ).map((column) => column.name),
        ),
        requests: new Set(
          (
            db.query("PRAGMA table_info(requests)").all() as Array<{
              name: string;
            }>
          ).map((column) => column.name),
        ),
      };
      if (
        !columns.findings.has("event_request_id") ||
        !columns.findings.has("event_json") ||
        !columns.requests.has("stale_event_request_id") ||
        !columns.requests.has("stale_event_json")
      ) {
        throw new ResearchError("corrupt_record", "Corrupt research store");
      }
      return;
    }
    ensureV2OutboxColumns(db);
    db.query("INSERT INTO meta (key, value) VALUES ('format_version', ?)").run(
      String(RESEARCH_STORE_FORMAT_VERSION),
    );
  });
  migrate.immediate();
}

export async function openResearchStore(
  options: StoreOptions,
): Promise<OpenResearchStore> {
  if (!options || typeof options.rootDir !== "string") {
    throw new ResearchError("invalid_input", "rootDir must be a string");
  }
  if (
    options.hostPrivateRoots !== undefined &&
    !Array.isArray(options.hostPrivateRoots)
  ) {
    throw new ResearchError(
      "invalid_input",
      "hostPrivateRoots must be an array",
    );
  }
  let prepared: ReturnType<typeof prepareRoot>;
  try {
    prepared = prepareRoot(options);
  } catch (error) {
    if (error instanceof ResearchError) throw error;
    throw new ResearchError("unsafe_path", "Research store root is unsafe");
  }
  const dbPath = path.join(prepared.rootDir, "research.sqlite");
  try {
    if (existsSync(dbPath)) {
      const stat = lstatSync(dbPath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new ResearchError(
          "unsafe_path",
          "research.sqlite must be a regular file",
        );
      }
    }
  } catch (error) {
    if (error instanceof ResearchError) throw error;
    throw new ResearchError("unsafe_path", "Research database path is unsafe");
  }
  let db: Database | undefined;
  try {
    db = new Database(dbPath, { create: true, strict: true });
    chmodSync(dbPath, 0o600);
    prepareDatabase(db);
  } catch (error) {
    db?.close();
    if (error instanceof ResearchError) {
      throw error;
    }
    throwResearchError("unsafe_path", "Unable to open research store");
  }
  if (!db) {
    throwResearchError("unsafe_path", "Unable to open research store");
  }
  return {
    db,
    rootDir: prepared.rootDir,
    privateNeedles: prepared.privateNeedles,
    close() {
      db.close();
    },
  };
}

export function canonicalRecord(value: unknown): {
  record_json: string;
  record_sha256: string;
} {
  const record_json = canonicalJson(value);
  return { record_json, record_sha256: sha256(record_json) };
}

export function verifyRecordHash(
  recordJson: string,
  recordSha256: string,
): void {
  if (sha256(recordJson) !== recordSha256) {
    throw new ResearchError("corrupt_record", "Stored record hash mismatch");
  }
}
