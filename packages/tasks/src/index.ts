import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import {
  type ArtifactRef,
  ArtifactRefSchema,
  canTransition,
  type EventEnvelope,
  EventEnvelopeSchema,
  type RequestContext,
  SCHEMA_VERSION,
  type Scope,
  ScopeSchema,
  type Task,
  TaskSchema,
  type TaskService,
  type TaskStatus,
  TaskStatusSchema,
  VersionRefSchema,
} from "@mars/contracts";
import { z } from "zod";

export const TASK_STORE_FORMAT_VERSION = 1;

const nonempty = z.string().min(1);

export const RequestContextSchema = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    scope: ScopeSchema,
    request_id: nonempty,
  })
  .strict();

export const ExecutionObservedPayloadSchema = z
  .object({
    upstream: z
      .object({
        runtime: z.literal("oh-my-pi"),
        package_version: nonempty,
        session_id: nonempty,
        entry_ids: z.array(nonempty).min(1),
      })
      .strict(),
    kind: z.string().min(1).max(64),
    summary: z.string().max(2000).optional(),
    artifacts: z.array(ArtifactRefSchema).optional(),
  })
  .strict();

export interface TaskStoreOptions {
  rootDir: string;
  workspaceRoots?: readonly string[];
  maxArtifactBytes?: number;
}

export interface ArtifactStore {
  put(
    context: RequestContext,
    data: Uint8Array,
    mediaType: string,
  ): Promise<ArtifactRef>;
  get(context: RequestContext, ref: ArtifactRef): Promise<Uint8Array>;
}

export interface AppendEventInput {
  event_type: EventEnvelope["event_type"];
  run_id: string;
  producer: string;
  versions: Array<{ component: string; revision: string }>;
  payload: unknown;
  source_event_ids?: string[];
  usage?: EventEnvelope["usage"];
}

export interface TaskPatch {
  status?: TaskStatus;
  artifacts?: ArtifactRef[];
  specialist_revision?: string | null;
}

export interface UpstreamSessionBinding {
  runtime: "oh-my-pi";
  package_version: string;
  session_id: string;
  session_file: string;
}

export interface DurableTaskStore extends TaskService {
  readonly artifacts: ArtifactStore;
  list(context: RequestContext): Promise<Task[]>;
  update(
    context: RequestContext,
    taskId: string,
    expectedRevision: number,
    patch: TaskPatch,
  ): Promise<Task>;
  appendEvent(
    context: RequestContext,
    taskId: string,
    input: AppendEventInput,
  ): Promise<EventEnvelope>;
  bindUpstreamSession(
    context: RequestContext,
    taskId: string,
    binding: UpstreamSessionBinding,
  ): Promise<void>;
  upstreamSession(
    context: RequestContext,
    taskId: string,
  ): Promise<UpstreamSessionBinding | null>;
  recoverInterrupted(
    context: RequestContext,
    options: { reason: string },
  ): Promise<Task[]>;
  close(): Promise<void>;
}

export type TaskStoreErrorCode =
  | "invalid_input"
  | "not_found"
  | "conflict"
  | "stale_revision"
  | "invalid_transition"
  | "corrupt_record"
  | "unknown_cursor"
  | "unsafe_path"
  | "closed";

export class TaskStoreError extends Error {
  readonly code: TaskStoreErrorCode;

  constructor(code: TaskStoreErrorCode, message: string) {
    super(message);
    this.name = "TaskStoreError";
    this.code = code;
  }
}

interface ArtifactRow {
  scope_key: string;
  artifact_id: string;
  sha256: string;
  media_type: string;
  byte_length: number;
}

interface TaskRow {
  scope_key: string;
  task_id: string;
  record_json: string;
  record_sha256: string;
}

interface EventRow {
  scope_key: string;
  task_id: string;
  event_id: string;
  task_seq: number;
  record_json: string;
  record_sha256: string;
  chain_sha256: string;
}

interface InstanceRow {
  instance_id: string;
  pid: number;
  hostname: string;
  started_at: string;
  closed_at: string | null;
}

const NOT_FOUND_MESSAGE = "Task or artifact not found";
const MAX_EVENT_PAYLOAD_BYTES = 1024 * 1024;
const MAX_STEER_BYTES = 16 * 1024;
const unsafePath = (message: string): TaskStoreError =>
  new TaskStoreError("unsafe_path", message);
const invalidInput = (message: string): TaskStoreError =>
  new TaskStoreError("invalid_input", message);

function fail(code: TaskStoreErrorCode, message: string): never {
  throw new TaskStoreError(code, message);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalValue(value: unknown, seen = new Set<object>()): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw invalidInput("Value is not JSON-serializable");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object")
    throw invalidInput("Value is not JSON-serializable");
  if (seen.has(value)) throw invalidInput("Cyclic JSON value");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const entries: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index))
          throw invalidInput("Value is not JSON-serializable");
        entries.push(canonicalValue(value[index], seen));
      }
      return entries;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw invalidInput("Value is not a plain JSON object");
    }
    const record = value as Record<string, unknown>;
    const output: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const key of Object.keys(record).sort()) {
      output[key] = canonicalValue(record[key], seen);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  try {
    const serialized = JSON.stringify(canonicalValue(value));
    if (typeof serialized !== "string")
      throw invalidInput("Value is not JSON-serializable");
    return serialized;
  } catch (error) {
    if (error instanceof TaskStoreError) throw error;
    throw invalidInput("Value is not JSON-serializable");
  }
}

function parseJson<T>(text: string, schema: z.ZodType<T>, label: string): T {
  try {
    const value: unknown = JSON.parse(text);
    const parsed = schema.safeParse(value);
    if (!parsed.success) fail("corrupt_record", `Corrupt ${label}`);
    return parsed.data;
  } catch (error) {
    if (error instanceof TaskStoreError) throw error;
    fail("corrupt_record", `Corrupt ${label}`);
  }
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

function scopeKey(scope: Scope): string {
  return sha256(canonicalJson(scope));
}

function scopeMatches(scopeA: Scope, scopeB: Scope): boolean {
  return canonicalJson(scopeA) === canonicalJson(scopeB);
}

function assertSchema<T>(
  schema: z.ZodType<T>,
  value: unknown,
  message: string,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw invalidInput(message);
  return parsed.data;
}

function assertTaskId(taskId: string): string {
  if (!nonempty.safeParse(taskId).success)
    throw invalidInput("Invalid task id");
  return taskId;
}

function assertPathComponents(rootDir: string, targetPath: string): void {
  const relative = path.relative(rootDir, targetPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw unsafePath("Path escapes task store root");
  }
  let current = rootDir;
  const rootStat = lstatSync(current);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw unsafePath("Task store path contains a symlink");
  }
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let isSymlink = false;
    try {
      isSymlink = lstatSync(current).isSymbolicLink();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (isSymlink) throw unsafePath("Task store path contains a symlink");
  }
}

function ensureDirectory(rootDir: string, directory: string): void {
  const relative = path.relative(rootDir, directory);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw unsafePath("Path escapes task store root");
  }
  let current = rootDir;
  const rootStat = lstatSync(current);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw unsafePath("Task store path contains a symlink");
  }
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let created = false;
    try {
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw unsafePath("Task store path contains a symlink");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        mkdirSync(current, { mode: 0o700 });
        created = true;
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST")
          throw mkdirError;
        const stat = lstatSync(current);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          throw unsafePath("Task store path contains a symlink");
        }
      }
    }
    if (created) chmodSync(current, 0o700);
  }
}

function fsyncDirectory(directory: string): void {
  const fd = openSync(directory, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function prepareRoot(options: TaskStoreOptions): string {
  if (!path.isAbsolute(options.rootDir))
    throw invalidInput("rootDir must be absolute");
  const requestedRoot = path.resolve(options.rootDir);
  const workspaceRoots = options.workspaceRoots ?? [process.cwd()];
  const rootDir = resolveForSafety(requestedRoot);
  for (const workspaceRoot of workspaceRoots) {
    if (typeof workspaceRoot !== "string" || !path.isAbsolute(workspaceRoot)) {
      throw invalidInput("workspaceRoots must be absolute");
    }
    const workspace = resolveForSafety(workspaceRoot);
    if (pathContains(workspace, rootDir) || pathContains(rootDir, workspace)) {
      throw unsafePath("Task store root overlaps a workspace root");
    }
  }
  let rootStat: ReturnType<typeof lstatSync> | undefined;
  try {
    rootStat = lstatSync(requestedRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (rootStat) {
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw unsafePath("Task store root must be a real directory");
    }
    if (
      typeof process.getuid === "function" &&
      rootStat.uid !== process.getuid()
    ) {
      throw unsafePath("Task store root must be owned by the current user");
    }
    const entries = requireDirectoryEntries(requestedRoot);
    if (entries.length > 0 && !entries.includes("tasks.sqlite")) {
      throw unsafePath("Task store root is not empty and has no tasks.sqlite");
    }
  } else {
    mkdirSync(requestedRoot, { recursive: true, mode: 0o700 });
  }
  chmodSync(requestedRoot, 0o700);
  return realpathSync(requestedRoot);
}

function requireDirectoryEntries(directory: string): string[] {
  return readdirSync(directory);
}

function artifactId(mediaType: string, digest: string): string {
  return `art_${sha256(`${mediaType}\n${digest}`)}`;
}

function artifactRef(mediaType: string, data: Uint8Array): ArtifactRef {
  const digest = sha256(data);
  return {
    artifact_id: artifactId(mediaType, digest),
    sha256: digest,
    media_type: mediaType,
    byte_length: data.byteLength,
  };
}

function artifactRelativePath(scopeDigest: string, digest: string): string {
  return path.join("artifacts", scopeDigest, digest.slice(0, 2), digest);
}

function ensureArtifactFile(
  rootDir: string,
  scopeDigest: string,
  ref: ArtifactRef,
  data: Uint8Array,
): void {
  const relative = artifactRelativePath(scopeDigest, ref.sha256);
  const finalPath = path.join(rootDir, relative);
  const parentDir = path.dirname(finalPath);
  ensureDirectory(rootDir, path.join(rootDir, "artifacts"));
  ensureDirectory(rootDir, path.dirname(parentDir));
  ensureDirectory(rootDir, parentDir);
  const temporaryDir = path.join(rootDir, "tmp");
  ensureDirectory(rootDir, temporaryDir);
  if (existsSync(finalPath)) {
    const stat = lstatSync(finalPath);
    if (stat.isSymbolicLink() || !stat.isFile())
      throw unsafePath("Artifact path is not a regular file");
    const existing = readFileSync(finalPath);
    if (sha256(existing) !== ref.sha256) {
      throw new TaskStoreError(
        "corrupt_record",
        "Artifact content hash mismatch",
      );
    }
    chmodSync(finalPath, 0o600);
    return;
  }
  const tempPath = path.join(temporaryDir, `${Bun.randomUUIDv7()}.tmp`);
  const fd = openSync(
    tempPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // The original write error is more useful.
    }
    throw error;
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tempPath, finalPath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // The rename error is more useful.
    }
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const stat = lstatSync(finalPath);
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      sha256(readFileSync(finalPath)) !== ref.sha256
    ) {
      throw new TaskStoreError(
        "corrupt_record",
        "Artifact content hash mismatch",
      );
    }
  }
  chmodSync(finalPath, 0o600);
  fsyncDirectory(parentDir);
}

export async function createTaskStore(
  options: TaskStoreOptions,
): Promise<DurableTaskStore> {
  if (!options || typeof options.rootDir !== "string")
    throw invalidInput("rootDir must be a string");
  if (
    options.workspaceRoots !== undefined &&
    !Array.isArray(options.workspaceRoots)
  ) {
    throw invalidInput("workspaceRoots must be an array");
  }
  if (
    options.maxArtifactBytes !== undefined &&
    (!Number.isSafeInteger(options.maxArtifactBytes) ||
      options.maxArtifactBytes < 0)
  ) {
    throw invalidInput("maxArtifactBytes must be a nonnegative safe integer");
  }
  const maxArtifactBytes = options.maxArtifactBytes ?? 64 * 1024 * 1024;
  const rootDir = prepareRoot(options);
  const dbPath = path.join(rootDir, "tasks.sqlite");
  if (existsSync(dbPath)) {
    const dbStat = lstatSync(dbPath);
    if (dbStat.isSymbolicLink() || !dbStat.isFile())
      throw unsafePath("tasks.sqlite must be a regular file");
  }
  if (existsSync(dbPath)) {
    const dbStat = lstatSync(dbPath);
    if (dbStat.isSymbolicLink() || !dbStat.isFile())
      throw unsafePath("tasks.sqlite must be a regular file");
  }
  const db = new Database(dbPath, { create: true, strict: true });
  try {
    db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000;",
    );
    chmodSync(dbPath, 0o600);
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (
        scope_key TEXT NOT NULL,
        task_id TEXT NOT NULL,
        record_json TEXT NOT NULL,
        record_sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (scope_key, task_id)
      );
      CREATE TABLE IF NOT EXISTS events (
        scope_key TEXT NOT NULL,
        task_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        task_seq INTEGER NOT NULL,
        record_json TEXT NOT NULL,
        record_sha256 TEXT NOT NULL,
        chain_sha256 TEXT NOT NULL,
        PRIMARY KEY (scope_key, task_id, task_seq),
        UNIQUE (scope_key, event_id),
        FOREIGN KEY (scope_key, task_id) REFERENCES tasks(scope_key, task_id)
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        scope_key TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        media_type TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        PRIMARY KEY (scope_key, artifact_id)
      );
      CREATE TABLE IF NOT EXISTS idempotency (
        scope_key TEXT NOT NULL,
        request_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        task_id TEXT NOT NULL,
        input_sha256 TEXT NOT NULL,
        result_json TEXT NOT NULL,
        PRIMARY KEY (scope_key, request_id, operation, task_id, input_sha256)
      );
      CREATE TABLE IF NOT EXISTS instances (
        instance_id TEXT PRIMARY KEY,
        pid INTEGER NOT NULL,
        hostname TEXT NOT NULL,
        started_at TEXT NOT NULL,
        closed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS task_runners (
        scope_key TEXT NOT NULL,
        task_id TEXT NOT NULL,
        instance_id TEXT NOT NULL,
        PRIMARY KEY (scope_key, task_id),
        FOREIGN KEY (scope_key, task_id) REFERENCES tasks(scope_key, task_id),
        FOREIGN KEY (instance_id) REFERENCES instances(instance_id)
      );
      CREATE TABLE IF NOT EXISTS session_bindings (
        scope_key TEXT NOT NULL,
        task_id TEXT NOT NULL,
        record_json TEXT NOT NULL,
        record_sha256 TEXT NOT NULL,
        PRIMARY KEY (scope_key, task_id),
        FOREIGN KEY (scope_key, task_id) REFERENCES tasks(scope_key, task_id)
      );
    `);
    const format = db
      .query("SELECT value FROM meta WHERE key = 'format_version'")
      .get() as { value: string } | null;
    if (format && Number(format.value) !== TASK_STORE_FORMAT_VERSION) {
      fail(
        "corrupt_record",
        `Unsupported task store format version: ${format.value}`,
      );
    }
    if (!format) {
      const insertFormat = db.transaction(() => {
        db.query(
          "INSERT INTO meta (key, value) VALUES ('format_version', ?)",
        ).run(String(TASK_STORE_FORMAT_VERSION));
      });
      insertFormat.immediate();
    }
  } catch (error) {
    db.close();
    throw error;
  }

  const instanceId = Bun.randomUUIDv7();
  const instanceRecord: InstanceRow = {
    instance_id: instanceId,
    pid: process.pid,
    hostname: hostname(),
    started_at: new Date().toISOString(),
    closed_at: null,
  };
  const insertInstance = db.transaction(() => {
    db.query(
      "INSERT INTO instances (instance_id, pid, hostname, started_at, closed_at) VALUES (?, ?, ?, ?, NULL)",
    ).run(
      instanceRecord.instance_id,
      instanceRecord.pid,
      instanceRecord.hostname,
      instanceRecord.started_at,
    );
  });
  insertInstance.immediate();

  let closed = false;
  const checkOpen = (): void => {
    if (closed) fail("closed", "Task store is closed");
  };
  const contextFor = (
    context: RequestContext,
  ): { context: RequestContext; scopeKey: string } => {
    checkOpen();
    const parsed = assertSchema(
      RequestContextSchema,
      context,
      "Invalid request context",
    );
    return { context: parsed, scopeKey: scopeKey(parsed.scope) };
  };
  const taskRow = (key: string, taskId: string): TaskRow => {
    const row = db
      .query(
        "SELECT scope_key, task_id, record_json, record_sha256 FROM tasks WHERE scope_key = ? AND task_id = ?",
      )
      .get(key, taskId) as TaskRow | null;
    if (!row) fail("not_found", NOT_FOUND_MESSAGE);
    return row;
  };
  const verifyTaskRow = (row: TaskRow): Task => {
    let value: unknown;
    try {
      value = JSON.parse(row.record_json);
    } catch {
      fail("corrupt_record", "Corrupt task record");
    }
    const canonical = canonicalJson(value);
    if (sha256(canonical) !== row.record_sha256)
      fail("corrupt_record", "Corrupt task record");
    const parsed = TaskSchema.safeParse(value);
    if (
      !parsed.success ||
      parsed.data.task_id !== row.task_id ||
      scopeKey(parsed.data.scope) !== row.scope_key
    ) {
      fail("corrupt_record", "Corrupt task record");
    }
    for (const ref of parsed.data.artifacts) {
      const artifact = db
        .query(
          "SELECT sha256, media_type, byte_length FROM artifacts WHERE scope_key = ? AND artifact_id = ?",
        )
        .get(row.scope_key, ref.artifact_id) as Omit<
        ArtifactRow,
        "scope_key" | "artifact_id"
      > | null;
      if (
        !artifact ||
        artifact.sha256 !== ref.sha256 ||
        artifact.media_type !== ref.media_type ||
        artifact.byte_length !== ref.byte_length ||
        artifactId(ref.media_type, ref.sha256) !== ref.artifact_id
      ) {
        fail("corrupt_record", "Corrupt task artifact reference");
      }
    }
    return parsed.data;
  };
  const readTask = (key: string, taskId: string): Task =>
    verifyTaskRow(taskRow(key, taskId));
  const insertArtifactRow = (key: string, ref: ArtifactRef): void => {
    db.query(
      "INSERT OR IGNORE INTO artifacts (scope_key, artifact_id, sha256, media_type, byte_length) VALUES (?, ?, ?, ?, ?)",
    ).run(key, ref.artifact_id, ref.sha256, ref.media_type, ref.byte_length);
    const row = db
      .query(
        "SELECT scope_key, artifact_id, sha256, media_type, byte_length FROM artifacts WHERE scope_key = ? AND artifact_id = ?",
      )
      .get(key, ref.artifact_id) as ArtifactRow | null;
    if (
      !row ||
      row.sha256 !== ref.sha256 ||
      row.media_type !== ref.media_type ||
      row.byte_length !== ref.byte_length
    ) {
      fail(
        "conflict",
        "Artifact reference conflicts with an existing artifact",
      );
    }
  };
  const assertArtifactOwned = (key: string, refInput: unknown): ArtifactRef => {
    const ref = assertSchema(
      ArtifactRefSchema,
      refInput,
      "Invalid artifact reference",
    );
    if (artifactId(ref.media_type, ref.sha256) !== ref.artifact_id) {
      throw invalidInput("Artifact reference does not match its content hash");
    }
    const row = db
      .query(
        "SELECT scope_key, artifact_id, sha256, media_type, byte_length FROM artifacts WHERE scope_key = ? AND artifact_id = ?",
      )
      .get(key, ref.artifact_id) as ArtifactRow | null;
    if (
      !row ||
      row.sha256 !== ref.sha256 ||
      row.media_type !== ref.media_type ||
      row.byte_length !== ref.byte_length
    ) {
      throw invalidInput("Artifact is not owned by this scope");
    }
    return ref;
  };
  const prepareArtifact = (
    scope: Scope,
    data: Uint8Array,
    mediaType: string,
  ): ArtifactRef => {
    if (
      !(data instanceof Uint8Array) ||
      typeof mediaType !== "string" ||
      mediaType.length === 0
    ) {
      throw invalidInput("Invalid artifact data or media type");
    }
    if (data.byteLength > maxArtifactBytes)
      throw invalidInput("Artifact exceeds maxArtifactBytes");
    const ref = artifactRef(mediaType, data);
    ensureArtifactFile(rootDir, scopeKey(scope), ref, data);
    return ref;
  };
  const preparePayloadArtifact = (
    scope: Scope,
    payload: unknown,
    enforceEventLimit = false,
  ): {
    ref: ArtifactRef;
    bytes: Uint8Array;
  } => {
    const json = canonicalJson(payload);
    const bytes = new TextEncoder().encode(json);
    if (enforceEventLimit && bytes.byteLength > MAX_EVENT_PAYLOAD_BYTES) {
      throw invalidInput("Event payload exceeds 1 MiB");
    }
    const ref = prepareArtifact(scope, bytes, "application/json");
    return { ref, bytes };
  };
  const verifiedEvents = (key: string, taskId: string): EventEnvelope[] => {
    const rows = db
      .query(
        "SELECT scope_key, task_id, event_id, task_seq, record_json, record_sha256, chain_sha256 FROM events WHERE scope_key = ? AND task_id = ? ORDER BY task_seq",
      )
      .all(key, taskId) as EventRow[];
    let previousId: string | null = null;
    let previousChain = "";
    return rows.map((row, index) => {
      let value: unknown;
      try {
        value = JSON.parse(row.record_json);
      } catch {
        fail("corrupt_record", "Corrupt event record");
      }
      const canonical = canonicalJson(value);
      if (sha256(canonical) !== row.record_sha256)
        fail("corrupt_record", "Corrupt event record");
      const parsed = EventEnvelopeSchema.safeParse(value);
      if (
        !parsed.success ||
        row.scope_key !== key ||
        row.task_id !== taskId ||
        parsed.data.scope === undefined ||
        scopeKey(parsed.data.scope) !== key ||
        parsed.data.task_id !== taskId ||
        parsed.data.event_id !== row.event_id ||
        row.task_seq !== index + 1 ||
        parsed.data.parent_event_id !== previousId ||
        sha256(`${previousChain}${row.record_sha256}`) !== row.chain_sha256
      ) {
        fail("corrupt_record", "Corrupt event chain");
      }
      const artifact = db
        .query(
          "SELECT artifact_id, sha256, media_type, byte_length FROM artifacts WHERE scope_key = ? AND artifact_id = ?",
        )
        .get(key, parsed.data.payload.artifact_id) as Omit<
        ArtifactRow,
        "scope_key"
      > | null;
      if (
        !artifact ||
        artifact.sha256 !== parsed.data.payload.sha256 ||
        artifact.media_type !== parsed.data.payload.media_type ||
        artifact.byte_length !== parsed.data.payload.byte_length ||
        artifactId(
          parsed.data.payload.media_type,
          parsed.data.payload.sha256,
        ) !== parsed.data.payload.artifact_id
      ) {
        fail("corrupt_record", "Corrupt event payload reference");
      }
      previousId = parsed.data.event_id;
      previousChain = row.chain_sha256;
      return parsed.data;
    });
  };
  const insertTaskRecord = (key: string, task: Task): void => {
    const json = canonicalJson(task);
    db.query(
      "INSERT INTO tasks (scope_key, task_id, record_json, record_sha256, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(key, task.task_id, json, sha256(json), new Date().toISOString());
  };
  const saveTaskRecord = (key: string, task: Task): void => {
    const json = canonicalJson(task);
    const result = db
      .query(
        "UPDATE tasks SET record_json = ?, record_sha256 = ? WHERE scope_key = ? AND task_id = ?",
      )
      .run(json, sha256(json), key, task.task_id);
    if (result.changes !== 1) fail("not_found", NOT_FOUND_MESSAGE);
  };
  const insertEventRecord = (
    key: string,
    task: Task,
    event: EventEnvelope,
  ): void => {
    const events = db
      .query(
        "SELECT event_id, chain_sha256, task_seq FROM events WHERE scope_key = ? AND task_id = ? ORDER BY task_seq DESC LIMIT 1",
      )
      .get(key, task.task_id) as {
      event_id: string;
      chain_sha256: string;
      task_seq: number;
    } | null;
    const seq = events ? events.task_seq + 1 : 1;
    const previousId = events?.event_id ?? null;
    if (event.parent_event_id !== previousId)
      fail("corrupt_record", "Invalid event parent");
    const json = canonicalJson(event);
    const digest = sha256(json);
    const chain = sha256(`${events?.chain_sha256 ?? ""}${digest}`);
    db.query(
      "INSERT INTO events (scope_key, task_id, event_id, task_seq, record_json, record_sha256, chain_sha256) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(key, task.task_id, event.event_id, seq, json, digest, chain);
  };
  const buildEvent = (
    task: Task,
    input: {
      event_type: EventEnvelope["event_type"];
      run_id: string;
      producer: string;
      versions: Array<{ component: string; revision: string }>;
      payload: ArtifactRef;
      source_event_ids?: string[];
      usage?: EventEnvelope["usage"];
      parent_event_id: string | null;
    },
  ): EventEnvelope => {
    const eventBase: Record<string, unknown> = {
      schema_version: SCHEMA_VERSION,
      event_id: `evt_${Bun.randomUUIDv7()}`,
      scope: task.scope,
      session_id: task.session_id,
      task_id: task.task_id,
      occurred_at: new Date().toISOString(),
      event_type: input.event_type,
      parent_event_id: input.parent_event_id,
      run_id: input.run_id,
      producer: input.producer,
      versions: input.versions,
      payload: input.payload,
      source_event_ids: input.source_event_ids ?? [],
      access: "private",
    };
    if (input.usage !== undefined) eventBase.usage = input.usage;
    return assertSchema(
      EventEnvelopeSchema,
      eventBase,
      "Invalid event envelope",
    );
  };
  const lifecycleEvent = (
    context: RequestContext,
    task: Task,
    eventType: "task.created" | "task.updated",
    payloadRef: ArtifactRef,
  ): EventEnvelope => {
    const events = verifiedEvents(scopeKey(task.scope), task.task_id);
    return buildEvent(task, {
      event_type: eventType,
      run_id: context.request_id,
      producer: "mars.tasks",
      versions: [{ component: "@mars/tasks", revision: "format-1" }],
      payload: payloadRef,
      parent_event_id: events.at(-1)?.event_id ?? null,
    });
  };
  const idemKeyInput = (value: unknown): string => sha256(canonicalJson(value));
  const getIdempotent = (
    key: string,
    requestId: string,
    operation: string,
    taskId: string,
    inputHash: string,
  ): string | null => {
    const row = db
      .query(
        "SELECT result_json FROM idempotency WHERE scope_key = ? AND request_id = ? AND operation = ? AND task_id = ? AND input_sha256 = ?",
      )
      .get(key, requestId, operation, taskId, inputHash) as {
      result_json: string;
    } | null;
    return row?.result_json ?? null;
  };
  const saveIdempotent = (
    key: string,
    requestId: string,
    operation: string,
    taskId: string,
    inputHash: string,
    result: unknown,
  ): void => {
    db.query(
      "INSERT INTO idempotency (scope_key, request_id, operation, task_id, input_sha256, result_json) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(key, requestId, operation, taskId, inputHash, canonicalJson(result));
  };
  const taskFromIdempotency = (
    value: string,
    key: string,
    taskId: string,
  ): Task => {
    const task = parseJson(value, TaskSchema, "idempotency result");
    if (task.task_id !== taskId || scopeKey(task.scope) !== key) {
      fail("corrupt_record", "Corrupt idempotency result");
    }
    return task;
  };
  const setRunner = (key: string, taskId: string): void => {
    db.query(
      "INSERT INTO task_runners (scope_key, task_id, instance_id) VALUES (?, ?, ?) ON CONFLICT(scope_key, task_id) DO UPDATE SET instance_id = excluded.instance_id",
    ).run(key, taskId, instanceId);
  };
  const clearRunner = (key: string, taskId: string): void => {
    db.query(
      "DELETE FROM task_runners WHERE scope_key = ? AND task_id = ?",
    ).run(key, taskId);
  };
  const validateTaskArtifacts = (key: string, task: Task): void => {
    for (const ref of task.artifacts) assertArtifactOwned(key, ref);
  };
  const readBinding = (
    key: string,
    taskId: string,
  ): UpstreamSessionBinding | null => {
    const row = db
      .query(
        "SELECT record_json, record_sha256 FROM session_bindings WHERE scope_key = ? AND task_id = ?",
      )
      .get(key, taskId) as {
      record_json: string;
      record_sha256: string;
    } | null;
    if (!row) return null;
    let value: unknown;
    try {
      value = JSON.parse(row.record_json);
    } catch {
      fail("corrupt_record", "Corrupt upstream session binding");
    }
    if (sha256(canonicalJson(value)) !== row.record_sha256) {
      fail("corrupt_record", "Corrupt upstream session binding");
    }
    return parseJson(
      row.record_json,
      bindingSchema,
      "upstream session binding",
    );
  };
  const bindingSchema = z
    .object({
      runtime: z.literal("oh-my-pi"),
      package_version: nonempty,
      session_id: nonempty,
      session_file: z.string().min(1).refine(path.isAbsolute),
    })
    .strict();
  const appendEventSchema = z
    .object({
      event_type: z.enum([
        "task.created",
        "task.updated",
        "execution.observed",
        "tool.completed",
        "research.proposed",
        "research.stale",
        "memory.revised",
        "skill.revised",
        "evaluation.completed",
        "training.updated",
        "promotion.decided",
      ]),
      run_id: nonempty,
      producer: nonempty,
      versions: z.array(VersionRefSchema).min(1),
      payload: z.custom<unknown>((value) => value !== undefined),
      source_event_ids: z.array(nonempty).optional(),
      usage: z
        .object({
          input_tokens: z.number().int().nonnegative(),
          output_tokens: z.number().int().nonnegative(),
          cost_usd: z.number().finite().nonnegative().nullable(),
        })
        .strict()
        .optional(),
    })
    .strict();

  const artifactStore: ArtifactStore = {
    async put(context, data, mediaType) {
      const { scopeKey: key, context: parsed } = contextFor(context);
      const ref = prepareArtifact(parsed.scope, data, mediaType);
      const transaction = db.transaction(() => {
        insertArtifactRow(key, ref);
      });
      transaction.immediate();
      return ref;
    },
    async get(context, refInput) {
      const { scopeKey: key } = contextFor(context);
      const ref = assertSchema(
        ArtifactRefSchema,
        refInput,
        "Invalid artifact reference",
      );
      if (artifactId(ref.media_type, ref.sha256) !== ref.artifact_id) {
        throw invalidInput(
          "Artifact reference does not match its content hash",
        );
      }
      const row = db
        .query(
          "SELECT scope_key, artifact_id, sha256, media_type, byte_length FROM artifacts WHERE scope_key = ? AND artifact_id = ?",
        )
        .get(key, ref.artifact_id) as ArtifactRow | null;
      if (!row) fail("not_found", NOT_FOUND_MESSAGE);
      if (
        row.sha256 !== ref.sha256 ||
        row.media_type !== ref.media_type ||
        row.byte_length !== ref.byte_length
      ) {
        throw invalidInput("Artifact reference does not match stored artifact");
      }
      const relative = artifactRelativePath(key, row.sha256);
      const filePath = path.join(rootDir, relative);
      assertPathComponents(rootDir, filePath);
      let fd: number;
      try {
        fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      } catch {
        fail("corrupt_record", "Artifact file is missing or unsafe");
      }
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile())
          fail("corrupt_record", "Artifact is not a regular file");
        const data = readFileSync(fd);
        if (
          data.byteLength !== row.byte_length ||
          sha256(data) !== row.sha256
        ) {
          fail("corrupt_record", "Artifact content hash mismatch");
        }
        return new Uint8Array(data);
      } finally {
        closeSync(fd);
      }
    },
  };

  const store: DurableTaskStore = {
    artifacts: artifactStore,
    async create(context, taskInput) {
      const { context: parsedContext, scopeKey: key } = contextFor(context);
      const task = assertSchema(TaskSchema, taskInput, "Invalid task");
      if (
        task.status !== "pending" ||
        task.revision !== 0 ||
        !scopeMatches(task.scope, parsedContext.scope)
      ) {
        throw invalidInput(
          "New tasks must be pending at revision 0 in the request scope",
        );
      }
      const inputHash = idemKeyInput(task);
      const prepared = preparePayloadArtifact(task.scope, { task });
      const transaction = db.transaction(() => {
        const replay = getIdempotent(
          key,
          parsedContext.request_id,
          "create",
          task.task_id,
          inputHash,
        );
        if (replay !== null)
          return taskFromIdempotency(replay, key, task.task_id);
        if (
          db
            .query(
              "SELECT 1 AS found FROM tasks WHERE scope_key = ? AND task_id = ?",
            )
            .get(key, task.task_id)
        ) {
          fail("conflict", "Task already exists");
        }
        validateTaskArtifacts(key, task);
        insertArtifactRow(key, prepared.ref);
        insertTaskRecord(key, task);
        const event = lifecycleEvent(
          parsedContext,
          task,
          "task.created",
          prepared.ref,
        );
        insertEventRecord(key, task, event);
        saveIdempotent(
          key,
          parsedContext.request_id,
          "create",
          task.task_id,
          inputHash,
          task,
        );
        return task;
      });
      return transaction.immediate();
    },
    async inspect(context, taskId) {
      const { scopeKey: key } = contextFor(context);
      assertTaskId(taskId);
      return readTask(key, taskId);
    },
    async list(context) {
      const { scopeKey: key } = contextFor(context);
      const rows = db
        .query(
          "SELECT scope_key, task_id, record_json, record_sha256 FROM tasks WHERE scope_key = ? ORDER BY rowid",
        )
        .all(key) as TaskRow[];
      return rows.map(verifyTaskRow);
    },
    async resume(context, taskId, expectedRevision) {
      const { context: parsedContext, scopeKey: key } = contextFor(context);
      assertTaskId(taskId);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
        throw invalidInput("Invalid expected revision");
      const inputHash = idemKeyInput({ expectedRevision });
      const snapshot = readTask(key, taskId);
      const payload = {
        change: "status",
        from: snapshot.status,
        to: "running",
      };
      const prepared = preparePayloadArtifact(snapshot.scope, payload);
      const transaction = db.transaction(() => {
        const replay = getIdempotent(
          key,
          parsedContext.request_id,
          "resume",
          taskId,
          inputHash,
        );
        if (replay !== null) return taskFromIdempotency(replay, key, taskId);
        const current = readTask(key, taskId);
        if (current.revision !== expectedRevision)
          fail("stale_revision", "Task revision is stale");
        if (current.status !== "paused")
          fail("invalid_transition", "Only paused tasks can be resumed");
        const updated = TaskSchema.parse({
          ...current,
          status: "running",
          revision: current.revision + 1,
        });
        insertArtifactRow(key, prepared.ref);
        saveTaskRecord(key, updated);
        setRunner(key, taskId);
        const event = lifecycleEvent(
          parsedContext,
          updated,
          "task.updated",
          prepared.ref,
        );
        insertEventRecord(key, updated, event);
        saveIdempotent(
          key,
          parsedContext.request_id,
          "resume",
          taskId,
          inputHash,
          updated,
        );
        return updated;
      });
      return transaction.immediate();
    },
    async update(context, taskId, expectedRevision, patchInput) {
      const { context: parsedContext, scopeKey: key } = contextFor(context);
      assertTaskId(taskId);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
        throw invalidInput("Invalid expected revision");
      if (
        patchInput === null ||
        typeof patchInput !== "object" ||
        Array.isArray(patchInput)
      ) {
        throw invalidInput("Invalid task patch");
      }
      const patch = patchInput as Record<string, unknown>;
      const keys = Object.keys(patch);
      if (
        keys.length === 0 ||
        keys.some(
          (field) =>
            !["status", "artifacts", "specialist_revision"].includes(field),
        )
      ) {
        throw invalidInput("Task patch must contain supported fields");
      }
      if ("status" in patch)
        assertSchema(TaskStatusSchema, patch.status, "Invalid task status");
      if ("artifacts" in patch && !Array.isArray(patch.artifacts))
        throw invalidInput("Invalid task artifacts");
      if (
        "specialist_revision" in patch &&
        patch.specialist_revision !== null &&
        (typeof patch.specialist_revision !== "string" ||
          patch.specialist_revision.length === 0)
      ) {
        throw invalidInput("Invalid specialist revision");
      }
      const inputHash = idemKeyInput({ expectedRevision, patch });
      const replay = getIdempotent(
        key,
        parsedContext.request_id,
        "update",
        taskId,
        inputHash,
      );
      if (replay !== null) return taskFromIdempotency(replay, key, taskId);
      const snapshot = readTask(key, taskId);
      const prospective = assertSchema(
        TaskSchema,
        { ...snapshot, ...patch, revision: snapshot.revision + 1 },
        "Invalid task patch",
      );
      const changed: Record<string, unknown> = {};
      for (const field of keys) {
        const from = (snapshot as unknown as Record<string, unknown>)[field];
        const to = (prospective as unknown as Record<string, unknown>)[field];
        if (canonicalJson(from) !== canonicalJson(to))
          changed[field] = { from, to };
      }
      if (Object.keys(changed).length === 0)
        throw invalidInput("Task patch makes no changes");
      const payload = { change: "updated", changes: changed };
      const prepared = preparePayloadArtifact(snapshot.scope, payload);
      const transaction = db.transaction(() => {
        const replay = getIdempotent(
          key,
          parsedContext.request_id,
          "update",
          taskId,
          inputHash,
        );
        if (replay !== null) return taskFromIdempotency(replay, key, taskId);
        const current = readTask(key, taskId);
        if (current.revision !== expectedRevision)
          fail("stale_revision", "Task revision is stale");
        const next = assertSchema(
          TaskSchema,
          { ...current, ...patch, revision: current.revision + 1 },
          "Invalid task patch",
        );
        const actualChanges: Record<string, unknown> = {};
        for (const field of keys) {
          const from = (current as unknown as Record<string, unknown>)[field];
          const to = (next as unknown as Record<string, unknown>)[field];
          if (canonicalJson(from) !== canonicalJson(to))
            actualChanges[field] = { from, to };
        }
        if (Object.keys(actualChanges).length === 0)
          throw invalidInput("Task patch makes no changes");
        if (
          "status" in actualChanges &&
          !canTransition(current.status, next.status)
        ) {
          fail("invalid_transition", "Task status transition is not allowed");
        }
        validateTaskArtifacts(key, next);
        insertArtifactRow(key, prepared.ref);
        saveTaskRecord(key, next);
        if (current.status !== "running" && next.status === "running")
          setRunner(key, taskId);
        else if (current.status === "running" && next.status !== "running")
          clearRunner(key, taskId);
        const event = lifecycleEvent(
          parsedContext,
          next,
          "task.updated",
          prepared.ref,
        );
        insertEventRecord(key, next, event);
        saveIdempotent(
          key,
          parsedContext.request_id,
          "update",
          taskId,
          inputHash,
          next,
        );
        return next;
      });
      return transaction.immediate();
    },
    async cancel(context, taskId) {
      const { context: parsedContext, scopeKey: key } = contextFor(context);
      assertTaskId(taskId);
      const inputHash = idemKeyInput({});
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const snapshot = readTask(key, taskId);
        if (snapshot.status === "completed" || snapshot.status === "failed") {
          throw new TaskStoreError(
            "invalid_transition",
            "Terminal tasks cannot be cancelled",
          );
        }
        const next =
          snapshot.status === "cancelled"
            ? snapshot
            : TaskSchema.parse({
                ...snapshot,
                status: "cancelled",
                revision: snapshot.revision + 1,
              });
        const prepared =
          next === snapshot
            ? null
            : preparePayloadArtifact(snapshot.scope, {
                change: "status",
                from: snapshot.status,
                to: "cancelled",
              });
        const transaction = db.transaction(() => {
          const replay = getIdempotent(
            key,
            parsedContext.request_id,
            "cancel",
            taskId,
            inputHash,
          );
          if (replay !== null) {
            taskFromIdempotency(replay, key, taskId);
            return "replay";
          }
          const current = readTask(key, taskId);
          if (current.revision !== snapshot.revision) return "retry";
          if (current.status === "completed" || current.status === "failed") {
            fail("invalid_transition", "Terminal tasks cannot be cancelled");
          }
          if (current.status !== "cancelled") {
            if (!prepared)
              fail("corrupt_record", "Missing cancellation payload");
            insertArtifactRow(key, prepared.ref);
            saveTaskRecord(key, next);
            clearRunner(key, taskId);
            const event = lifecycleEvent(
              parsedContext,
              next,
              "task.updated",
              prepared.ref,
            );
            insertEventRecord(key, next, event);
          }
          saveIdempotent(
            key,
            parsedContext.request_id,
            "cancel",
            taskId,
            inputHash,
            current.status === "cancelled" ? current : next,
          );
          return "done";
        });
        const result = transaction.immediate();
        if (result === "retry") continue;
        return;
      }
      fail("conflict", "Task changed repeatedly while cancelling");
    },
    async steer(context, taskId, instruction) {
      const { context: parsedContext, scopeKey: key } = contextFor(context);
      assertTaskId(taskId);
      if (
        typeof instruction !== "string" ||
        instruction.trim().length === 0 ||
        Buffer.byteLength(instruction) > MAX_STEER_BYTES
      ) {
        throw invalidInput("Instruction must be non-empty and at most 16 KiB");
      }
      const inputHash = idemKeyInput({ instruction });
      const replay = getIdempotent(
        key,
        parsedContext.request_id,
        "steer",
        taskId,
        inputHash,
      );
      if (replay !== null) return;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const snapshot = readTask(key, taskId);
        if (["completed", "cancelled", "failed"].includes(snapshot.status)) {
          fail("invalid_transition", "Terminal tasks cannot be steered");
        }
        const payload = {
          change: "steered",
          instruction,
          task_revision: snapshot.revision,
        };
        const prepared = preparePayloadArtifact(snapshot.scope, payload);
        const transaction = db.transaction(() => {
          const replay = getIdempotent(
            key,
            parsedContext.request_id,
            "steer",
            taskId,
            inputHash,
          );
          if (replay !== null) return "replay";
          const current = readTask(key, taskId);
          if (current.revision !== snapshot.revision) return "retry";
          if (["completed", "cancelled", "failed"].includes(current.status)) {
            fail("invalid_transition", "Terminal tasks cannot be steered");
          }
          insertArtifactRow(key, prepared.ref);
          const event = lifecycleEvent(
            parsedContext,
            current,
            "task.updated",
            prepared.ref,
          );
          insertEventRecord(key, current, event);
          saveIdempotent(
            key,
            parsedContext.request_id,
            "steer",
            taskId,
            inputHash,
            null,
          );
          return "done";
        });
        const result = transaction.immediate();
        if (result === "retry") continue;
        return;
      }
      fail("conflict", "Task changed repeatedly while steering");
    },
    async appendEvent(context, taskId, input) {
      const { context: parsedContext, scopeKey: key } = contextFor(context);
      assertTaskId(taskId);
      input = assertSchema(
        appendEventSchema,
        input,
        "Invalid event input",
      ) as AppendEventInput;
      if (
        input.event_type === "task.created" ||
        input.event_type === "task.updated"
      ) {
        throw invalidInput("Lifecycle event types are reserved");
      }
      const versions = assertSchema(
        z.array(VersionRefSchema).min(1),
        input.versions,
        "Invalid event versions",
      );
      if (
        !nonempty.safeParse(input.run_id).success ||
        !nonempty.safeParse(input.producer).success
      ) {
        throw invalidInput("Event run_id and producer must be non-empty");
      }
      const sourceIds = input.source_event_ids ?? [];
      if (
        !Array.isArray(sourceIds) ||
        sourceIds.some((id) => !nonempty.safeParse(id).success)
      ) {
        throw invalidInput("Invalid source event ids");
      }
      const payload =
        input.event_type === "execution.observed"
          ? assertSchema(
              ExecutionObservedPayloadSchema,
              input.payload,
              "Invalid execution.observed payload",
            )
          : input.payload;
      const inputHash = idemKeyInput({
        event_type: input.event_type,
        run_id: input.run_id,
        producer: input.producer,
        versions,
        payload,
        source_event_ids: sourceIds,
        ...(input.usage === undefined ? {} : { usage: input.usage }),
      });
      const snapshot = readTask(key, taskId);
      if (input.event_type === "execution.observed") {
        const observed = payload as z.infer<
          typeof ExecutionObservedPayloadSchema
        >;
        const binding = readBinding(key, taskId);
        if (
          !binding ||
          observed.upstream.runtime !== binding.runtime ||
          observed.upstream.package_version !== binding.package_version ||
          observed.upstream.session_id !== binding.session_id
        ) {
          throw invalidInput(
            "execution.observed does not match the upstream session binding",
          );
        }
        for (const ref of observed.artifacts ?? [])
          assertArtifactOwned(key, ref);
      }
      const prepared = preparePayloadArtifact(snapshot.scope, payload, true);
      const transaction = db.transaction(() => {
        const replay = getIdempotent(
          key,
          parsedContext.request_id,
          "appendEvent",
          taskId,
          inputHash,
        );
        if (replay !== null) {
          const eventId = parseJson(
            replay,
            z.string().min(1),
            "idempotency event result",
          );
          const matches = verifiedEvents(key, taskId);
          const prior = matches.find((event) => event.event_id === eventId);
          if (!prior)
            fail("corrupt_record", "Idempotency event does not exist");
          return prior;
        }
        const task = readTask(key, taskId);
        const allEvents = verifiedEvents(key, taskId);
        const knownIds = new Set(allEvents.map((event) => event.event_id));
        if (sourceIds.some((id) => !knownIds.has(id))) {
          throw invalidInput("Source event id does not belong to this task");
        }
        if (input.event_type === "execution.observed") {
          const observed = payload as z.infer<
            typeof ExecutionObservedPayloadSchema
          >;
          const binding = readBinding(key, taskId);
          if (
            !binding ||
            observed.upstream.runtime !== binding.runtime ||
            observed.upstream.package_version !== binding.package_version ||
            observed.upstream.session_id !== binding.session_id
          ) {
            throw invalidInput(
              "execution.observed does not match the upstream session binding",
            );
          }
          for (const ref of observed.artifacts ?? [])
            assertArtifactOwned(key, ref);
        }
        insertArtifactRow(key, prepared.ref);
        const event = buildEvent(task, {
          event_type: input.event_type,
          run_id: input.run_id,
          producer: input.producer,
          versions,
          payload: prepared.ref,
          source_event_ids: sourceIds,
          ...(input.usage === undefined ? {} : { usage: input.usage }),
          parent_event_id: allEvents.at(-1)?.event_id ?? null,
        });
        insertEventRecord(key, task, event);
        saveIdempotent(
          key,
          parsedContext.request_id,
          "appendEvent",
          taskId,
          inputHash,
          event.event_id,
        );
        return event;
      });
      return transaction.immediate();
    },
    async bindUpstreamSession(context, taskId, bindingInput) {
      const { context: parsedContext, scopeKey: key } = contextFor(context);
      assertTaskId(taskId);
      const binding = assertSchema(
        bindingSchema,
        bindingInput,
        "Invalid upstream session binding",
      );
      const lexicalBindingPath = path.resolve(binding.session_file);
      const bindingPath = resolveForSafety(binding.session_file);
      if (
        pathContains(rootDir, lexicalBindingPath) ||
        pathContains(rootDir, bindingPath)
      ) {
        throw invalidInput("Upstream session file cannot be inside task store");
      }
      const inputHash = idemKeyInput(binding);
      const snapshot = readTask(key, taskId);
      const prepared = preparePayloadArtifact(snapshot.scope, {
        change: "upstream_session_bound",
        binding,
      });
      const transaction = db.transaction(() => {
        const replay = getIdempotent(
          key,
          parsedContext.request_id,
          "bindUpstreamSession",
          taskId,
          inputHash,
        );
        if (replay !== null) return;
        const task = readTask(key, taskId);
        if (["completed", "cancelled", "failed"].includes(task.status)) {
          fail(
            "invalid_transition",
            "Terminal tasks cannot bind an upstream session",
          );
        }
        const existing = readBinding(key, taskId);
        if (existing) {
          if (canonicalJson(existing) !== canonicalJson(binding)) {
            fail("conflict", "A different upstream session is already bound");
          }
          saveIdempotent(
            key,
            parsedContext.request_id,
            "bindUpstreamSession",
            taskId,
            inputHash,
            null,
          );
          return;
        }
        insertArtifactRow(key, prepared.ref);
        const bindingJson = canonicalJson(binding);
        db.query(
          "INSERT INTO session_bindings (scope_key, task_id, record_json, record_sha256) VALUES (?, ?, ?, ?)",
        ).run(key, taskId, bindingJson, sha256(bindingJson));
        const event = lifecycleEvent(
          parsedContext,
          task,
          "task.updated",
          prepared.ref,
        );
        insertEventRecord(key, task, event);
        saveIdempotent(
          key,
          parsedContext.request_id,
          "bindUpstreamSession",
          taskId,
          inputHash,
          null,
        );
      });
      transaction.immediate();
    },
    async upstreamSession(context, taskId) {
      const { scopeKey: key } = contextFor(context);
      assertTaskId(taskId);
      readTask(key, taskId);
      return readBinding(key, taskId);
    },
    async recoverInterrupted(context, optionsInput) {
      const { context: parsedContext, scopeKey: key } = contextFor(context);
      if (
        !optionsInput ||
        typeof optionsInput.reason !== "string" ||
        optionsInput.reason.trim().length === 0
      ) {
        throw invalidInput("Recovery reason must be non-empty");
      }
      const tasks = await store.list(parsedContext);
      const recovered: Task[] = [];
      for (const candidate of tasks) {
        if (candidate.status !== "running") continue;
        const runner = db
          .query(
            "SELECT i.instance_id, i.pid, i.hostname, i.started_at, i.closed_at FROM task_runners r LEFT JOIN instances i ON i.instance_id = r.instance_id WHERE r.scope_key = ? AND r.task_id = ?",
          )
          .get(key, candidate.task_id) as
          | (Omit<InstanceRow, "instance_id"> & { instance_id: string | null })
          | null;
        const shouldRecover = (
          instance:
            | (Omit<InstanceRow, "instance_id"> & {
                instance_id: string | null;
              })
            | null,
        ): boolean => {
          if (!instance || !instance.instance_id || instance.closed_at !== null)
            return true;
          if (instance.hostname !== hostname()) return false;
          try {
            process.kill(instance.pid, 0);
            return false;
          } catch (error) {
            return (error as NodeJS.ErrnoException).code === "ESRCH";
          }
        };
        if (!shouldRecover(runner)) continue;
        const payload = {
          change: "recovered",
          previous_status: "running",
          status: "paused",
          reason: optionsInput.reason,
          interrupted_instance_id: runner?.instance_id ?? null,
        };
        const prepared = preparePayloadArtifact(candidate.scope, payload);
        const transaction = db.transaction(() => {
          const current = readTask(key, candidate.task_id);
          if (
            current.status !== "running" ||
            current.revision !== candidate.revision
          )
            return null;
          const currentRunner = db
            .query(
              "SELECT i.instance_id, i.pid, i.hostname, i.started_at, i.closed_at FROM task_runners r LEFT JOIN instances i ON i.instance_id = r.instance_id WHERE r.scope_key = ? AND r.task_id = ?",
            )
            .get(key, candidate.task_id) as
            | (Omit<InstanceRow, "instance_id"> & {
                instance_id: string | null;
              })
            | null;
          if (
            !shouldRecover(currentRunner) ||
            (currentRunner?.instance_id ?? null) !==
              (runner?.instance_id ?? null)
          ) {
            return null;
          }
          const next = TaskSchema.parse({
            ...current,
            status: "paused",
            revision: current.revision + 1,
          });
          insertArtifactRow(key, prepared.ref);
          saveTaskRecord(key, next);
          clearRunner(key, current.task_id);
          const event = lifecycleEvent(
            parsedContext,
            next,
            "task.updated",
            prepared.ref,
          );
          insertEventRecord(key, next, event);
          return next;
        });
        const result = transaction.immediate();
        if (result) recovered.push(result);
      }
      return recovered;
    },
    async *events(context, taskId, afterEventId) {
      const { scopeKey: key } = contextFor(context);
      assertTaskId(taskId);
      const snapshot = db.transaction(() => {
        readTask(key, taskId);
        const events = verifiedEvents(key, taskId);
        let offset = 0;
        if (afterEventId !== undefined) {
          const index = events.findIndex(
            (event) => event.event_id === afterEventId,
          );
          if (index < 0) fail("unknown_cursor", "Unknown event cursor");
          offset = index + 1;
        }
        return events.slice(offset);
      })();
      for (const event of snapshot) yield event;
    },
    async close() {
      checkOpen();
      const transaction = db.transaction(() => {
        db.query(
          "UPDATE instances SET closed_at = ? WHERE instance_id = ?",
        ).run(new Date().toISOString(), instanceId);
      });
      transaction.immediate();
      closed = true;
      db.close();
    },
  };
  return store;
}
