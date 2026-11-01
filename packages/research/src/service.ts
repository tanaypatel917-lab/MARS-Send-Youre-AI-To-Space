import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import {
  type ArtifactRef,
  ArtifactRefSchema,
  type Budget,
  type RequestContext,
  type ResearchFinding,
  type ResearchRequest,
  type ResearchService,
  ScopeSchema,
  type Task,
} from "@mars/contracts";
import { type AppendEventInput, canonicalJson } from "@mars/tasks";
import { validateCitationUrl } from "./citations";
import { ResearchError } from "./errors";
import {
  FindingProposalSchema,
  RequestContextSchema,
  ResearchFindingSchema,
  ResearchRequestSchema,
  ResearchTimestampSchema,
} from "./schemas";
import {
  canonicalRecord,
  type OpenResearchStore,
  openResearchStore,
  type PrivateNeedles,
  RESEARCH_STORE_FORMAT_VERSION,
  sha256,
  timestamp,
  verifyRecordHash,
} from "./store";

export interface ResearchUsage {
  input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
  reported: boolean;
}

export type ResearchJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired";

export interface ResearchJob {
  request_id: string;
  task_id: string;
  task_revision: number;
  question: string;
  status: ResearchJobStatus;
  stale: boolean;
  cancel_requested: boolean;
  attempts: number;
  max_attempts: number;
  submitted_at: string;
  deadline: string;
  requested_deadline: string;
  finished_at: string | null;
  error_code:
    | ResearchError["code"]
    | "worker_failed"
    | "attempts_exhausted"
    | null;
  budget: Budget;
  usage: ResearchUsage;
  enforcement: {
    deadline: "enforced";
    duration: "enforced";
    concurrency: "enforced";
    tokens: "reported_usage_only";
    usd: "reported_usage_only";
  };
  worker: { id: string; version: string } | null;
  finding_count: number;
}

export interface ResearchWorkerInput {
  request_id: string;
  attempt: number;
  question: string;
  task_id: string;
  task_revision: number;
  known_context: ArtifactRef[];
  source_requirements: string[];
  deadline: string;
  budget: Budget;
  published_finding_keys: string[];
}

export interface EvidenceCapture {
  url: string;
  retrieved_at: string;
  media_type: string;
  data: Uint8Array;
}

export interface FindingProposal {
  finding_key: string;
  claim: string;
  recommendation: string;
  confidence: "low" | "medium" | "high";
  remaining_uncertainty: string[];
  sources: Array<{
    url: string;
    retrieved_at: string;
    evidence: ArtifactRef;
  }>;
}

export interface ResearchWorkerContext {
  readonly signal: AbortSignal;
  readKnownContext(ref: ArtifactRef): Promise<Uint8Array>;
  captureEvidence(capture: EvidenceCapture): Promise<ArtifactRef>;
  publish(proposal: FindingProposal): Promise<ResearchFinding>;
  reportUsage(delta: {
    input_tokens: number;
    output_tokens: number;
    cost_usd?: number | null;
  }): Promise<void>;
}

export interface ResearchWorker {
  readonly id: string;
  readonly version: string;
  run(
    input: ResearchWorkerInput,
    context: ResearchWorkerContext,
  ): Promise<void>;
}

export class RetryableResearchError extends Error {}

export interface ResearchTaskReader {
  inspect(context: RequestContext, taskId: string): Promise<Task>;
}

export interface ResearchArtifactStore {
  put(
    context: RequestContext,
    data: Uint8Array,
    mediaType: string,
  ): Promise<ArtifactRef>;
  get(context: RequestContext, ref: ArtifactRef): Promise<Uint8Array>;
}

export interface ResearchEventSink {
  appendEvent(
    context: RequestContext,
    taskId: string,
    input: AppendEventInput,
  ): Promise<unknown>;
}

export interface ResearchServiceOptions {
  rootDir: string;
  tasks: ResearchTaskReader;
  artifacts: ResearchArtifactStore;
  worker: ResearchWorker;
  events?: ResearchEventSink;
  hostPrivateRoots?: readonly string[];
  maxConcurrency?: number;
  maxActivePerScope?: number;
  maxActiveTotal?: number;
  maxAttempts?: number;
  leaseMs?: number;
  retryBackoffMs?: number;
  maxFindingsPerRequest?: number;
  maxEvidenceBytes?: number;
  pollMs?: number;
  autoStart?: boolean;
  now?: () => number;
}

export interface DurableResearchService extends ResearchService {
  inspect(context: RequestContext, requestId: string): Promise<ResearchJob>;
  list(
    context: RequestContext,
    filter?: { task_id?: string },
  ): Promise<ResearchJob[]>;
  readFindings(
    context: RequestContext,
    requestId: string,
  ): Promise<ResearchFinding[]>;
  markUsed(
    context: RequestContext,
    findingId: string,
    expectedTaskRevision: number,
  ): Promise<ResearchFinding>;
  reconcileTask(
    context: RequestContext,
    taskId: string,
  ): Promise<{ task_revision: number; stale_request_ids: string[] }>;
  pump(): Promise<void>;
  close(options?: { drainMs?: number }): Promise<void>;
}

interface RequestRow {
  scope_key: string;
  request_id: string;
  scope_json: string;
  idem_request_id: string;
  input_sha256: string;
  record_json: string;
  record_sha256: string;
  task_id: string;
  task_revision: number;
  status: ResearchJobStatus;
  stale: number;
  cancel_requested: number;
  attempts: number;
  max_attempts: number;
  submitted_at: string;
  requested_deadline: string;
  deadline: string;
  available_at: number;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at: number | null;
  usage_json: string;
  error_code: ResearchJob["error_code"];
  worker_json: string | null;
  finished_at: string | null;
  stale_event_state: "none" | "pending" | "sent";
  stale_event_request_id: string | null;
  stale_event_json: string | null;
  seq: number;
}

interface FindingRow {
  scope_key: string;
  request_id: string;
  seq: number;
  finding_id: string;
  finding_key: string;
  record_json: string;
  record_sha256: string;
  status: ResearchFinding["status"];
  attempt: number;
  event_state: "none" | "pending" | "sent";
  event_request_id: string | null;
  event_json: string | null;
}

interface ClaimedJob {
  row: RequestRow;
  request: ResearchRequest;
  token: string;
  attempt: number;
}

interface LocalRun {
  key: string;
  scopeKey: string;
  requestId: string;
  token: string;
  controller: AbortController;
  heartbeat: ReturnType<typeof setInterval>;
  deadlineTimer: ReturnType<typeof setTimeout>;
  forced: boolean;
  settled: Promise<void>;
}

interface ParsedContext {
  context: RequestContext;
  scopeKey: string;
  scopeJson: string;
}

const ACTIVE_STATUSES = ["queued", "running"] as const;
const TERMINAL_TASK_STATUSES = new Set(["completed", "cancelled", "failed"]);
const TERMINAL_JOB_STATUSES = new Set<ResearchJobStatus>([
  "completed",
  "failed",
  "cancelled",
  "expired",
]);
const NOT_FOUND_MESSAGE = "Research request or task not found";
const CLOSED_MESSAGE = "Research service is closed";
const INVALID_CONTEXT_MESSAGE = "Invalid request context";
const MAX_TIMER_MS = 2_147_000_000;

function immediate<T>(db: Database, operation: () => T): T {
  const transaction = db.transaction(operation);
  return transaction.immediate();
}

function parseStored<T>(
  recordJson: string,
  recordSha256: string,
  schema: { safeParse(value: unknown): { success: boolean; data?: T } },
  label: string,
): T {
  verifyRecordHash(recordJson, recordSha256);
  let decoded: unknown;
  try {
    decoded = JSON.parse(recordJson);
  } catch {
    throw new ResearchError("corrupt_record", `Corrupt ${label}`);
  }
  const parsed = schema.safeParse(decoded);
  if (!parsed.success || parsed.data === undefined) {
    throw new ResearchError("corrupt_record", `Corrupt ${label}`);
  }
  return parsed.data;
}

function privateBoundaryMatch(text: string, root: string): boolean {
  let index = text.indexOf(root);
  while (index >= 0) {
    const next = text[index + root.length];
    if (
      next === undefined ||
      next === "/" ||
      next === "\\" ||
      !/[A-Za-z0-9._~-]/.test(next)
    ) {
      return true;
    }
    index = text.indexOf(root, index + 1);
  }
  return false;
}

function privatePathForms(
  rootDir: string,
  hostRoots: readonly string[],
): PrivateNeedles {
  const roots = new Set<string>([rootDir]);
  for (const root of hostRoots) {
    roots.add(path.resolve(root));
    try {
      roots.add(realpathSync(root));
    } catch {
      roots.add(path.resolve(root));
    }
  }
  const exact = new Set(roots);
  return { exact, roots };
}

function containsPrivateText(text: string, needles: PrivateNeedles): boolean {
  for (const root of needles.roots) {
    if (privateBoundaryMatch(text, root)) return true;
    const escaped = JSON.stringify(root).slice(1, -1);
    if (escaped !== root && privateBoundaryMatch(text, escaped)) return true;
  }
  return false;
}

function validateOptions(
  options: ResearchServiceOptions,
): Required<
  Pick<
    ResearchServiceOptions,
    | "maxConcurrency"
    | "maxActivePerScope"
    | "maxActiveTotal"
    | "maxAttempts"
    | "leaseMs"
    | "retryBackoffMs"
    | "maxFindingsPerRequest"
    | "maxEvidenceBytes"
    | "pollMs"
    | "autoStart"
    | "now"
  >
> {
  const defaults = {
    maxConcurrency: 2,
    maxActivePerScope: 16,
    maxActiveTotal: 256,
    maxAttempts: 3,
    leaseMs: 30_000,
    retryBackoffMs: 1_000,
    maxFindingsPerRequest: 64,
    maxEvidenceBytes: 8 * 1024 * 1024,
    pollMs: 250,
    autoStart: true,
    now: Date.now,
  };
  const values = { ...defaults, ...options };
  for (const key of [
    "maxConcurrency",
    "maxActivePerScope",
    "maxActiveTotal",
    "maxAttempts",
    "leaseMs",
    "maxFindingsPerRequest",
    "maxEvidenceBytes",
    "pollMs",
  ] as const) {
    if (!Number.isSafeInteger(values[key]) || values[key] <= 0) {
      throw new ResearchError(
        "invalid_input",
        "Invalid research service option",
      );
    }
  }
  if (
    !Number.isSafeInteger(values.retryBackoffMs) ||
    values.retryBackoffMs < 0
  ) {
    throw new ResearchError("invalid_input", "Invalid research service option");
  }
  if (
    typeof values.autoStart !== "boolean" ||
    typeof values.now !== "function"
  ) {
    throw new ResearchError("invalid_input", "Invalid research service option");
  }
  return values;
}

function storedContext(
  scope: RequestContext["scope"],
  requestId: string,
): RequestContext {
  return { schema_version: 1, scope, request_id: requestId };
}

function safeContext(value: unknown): RequestContext {
  const parsed = RequestContextSchema.safeParse(value);
  if (!parsed.success) {
    throw new ResearchError("invalid_input", INVALID_CONTEXT_MESSAGE);
  }
  return parsed.data;
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function mapTaskError(error: unknown): ResearchError {
  if (isErrorCode(error, "not_found")) {
    return new ResearchError("not_found", NOT_FOUND_MESSAGE);
  }
  if (isErrorCode(error, "corrupt_record")) {
    return new ResearchError("corrupt_record", "Stored task record is corrupt");
  }
  if (isErrorCode(error, "closed")) {
    return new ResearchError("closed", CLOSED_MESSAGE);
  }
  return new ResearchError("invalid_input", "Task validation failed");
}

function usageFromJson(value: string): ResearchUsage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ResearchError("corrupt_record", "Corrupt usage record");
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !Number.isSafeInteger((parsed as ResearchUsage).input_tokens) ||
    !Number.isSafeInteger((parsed as ResearchUsage).output_tokens) ||
    typeof (parsed as ResearchUsage).reported !== "boolean" ||
    !(
      (parsed as ResearchUsage).cost_usd === null ||
      (typeof (parsed as ResearchUsage).cost_usd === "number" &&
        Number.isFinite((parsed as ResearchUsage).cost_usd))
    )
  ) {
    throw new ResearchError("corrupt_record", "Corrupt usage record");
  }
  return parsed as ResearchUsage;
}

function rowWorker(row: RequestRow): { id: string; version: string } | null {
  if (row.worker_json === null) return null;
  try {
    const value: unknown = JSON.parse(row.worker_json);
    if (
      value !== null &&
      typeof value === "object" &&
      typeof (value as { id?: unknown }).id === "string" &&
      typeof (value as { version?: unknown }).version === "string"
    ) {
      return {
        id: (value as { id: string }).id,
        version: (value as { version: string }).version,
      };
    }
  } catch {
    // Treat malformed worker metadata as corrupt persisted state.
  }
  throw new ResearchError("corrupt_record", "Corrupt worker record");
}

function parseStoredEventInput(value: string | null): AppendEventInput | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    const event = parsed as Record<string, unknown>;
    if (
      (event.event_type !== "research.proposed" &&
        event.event_type !== "research.stale") ||
      typeof event.run_id !== "string" ||
      event.run_id.length === 0 ||
      event.producer !== "mars-research" ||
      !Array.isArray(event.versions) ||
      event.versions.length === 0 ||
      event.versions.some(
        (version) =>
          version === null ||
          typeof version !== "object" ||
          typeof (version as { component?: unknown }).component !== "string" ||
          typeof (version as { revision?: unknown }).revision !== "string",
      ) ||
      !Array.isArray(event.source_event_ids) ||
      event.source_event_ids.some((id) => typeof id !== "string")
    ) {
      return null;
    }
    if (
      event.payload === null ||
      typeof event.payload !== "object" ||
      Array.isArray(event.payload)
    ) {
      return null;
    }
    const payload = event.payload as Record<string, unknown>;
    if (
      typeof payload.request_id !== "string" ||
      !Number.isSafeInteger(payload.task_revision)
    ) {
      return null;
    }
    if (
      event.event_type === "research.proposed" &&
      (typeof payload.finding_id !== "string" ||
        typeof payload.confidence !== "string" ||
        !Number.isSafeInteger(payload.source_count))
    ) {
      return null;
    }
    if (
      event.event_type === "research.stale" &&
      (!Array.isArray(payload.stale_finding_ids) ||
        payload.stale_finding_ids.some((id) => typeof id !== "string"))
    ) {
      return null;
    }
    if (event.usage !== undefined || canonicalJson(parsed) !== value) {
      return null;
    }
    return parsed as AppendEventInput;
  } catch {
    return null;
  }
}

function findRequest(
  db: Database,
  scopeKey: string,
  requestId: string,
): RequestRow {
  const row = db
    .query("SELECT * FROM requests WHERE scope_key = ? AND request_id = ?")
    .get(scopeKey, requestId) as RequestRow | null;
  if (!row) throw new ResearchError("not_found", NOT_FOUND_MESSAGE);
  return row;
}

function findFindingById(
  db: Database,
  scopeKey: string,
  findingId: string,
): FindingRow {
  const row = db
    .query("SELECT * FROM findings WHERE scope_key = ? AND finding_id = ?")
    .get(scopeKey, findingId) as FindingRow | null;
  if (!row) throw new ResearchError("not_found", NOT_FOUND_MESSAGE);
  return row;
}

function verifiedRequest(row: RequestRow): ResearchRequest {
  const parsed = parseStored(
    row.record_json,
    row.record_sha256,
    ResearchRequestSchema,
    "request record",
  );
  if (
    parsed.task_id !== row.task_id ||
    parsed.task_revision !== row.task_revision ||
    parsed.deadline !== row.requested_deadline
  ) {
    throw new ResearchError("corrupt_record", "Corrupt request record");
  }
  return parsed;
}

function verifiedFinding(row: FindingRow): ResearchFinding {
  const parsed = parseStored(
    row.record_json,
    row.record_sha256,
    ResearchFindingSchema,
    "finding record",
  );
  if (parsed.status !== row.status || parsed.finding_id !== row.finding_id) {
    throw new ResearchError("corrupt_record", "Corrupt finding record");
  }
  return parsed;
}

function updateFindingRecord(
  db: Database,
  row: FindingRow,
  record: ResearchFinding,
  eventState = row.event_state,
): void {
  const canonical = canonicalRecord(record);
  db.query(
    `UPDATE findings
     SET record_json = ?, record_sha256 = ?, status = ?, event_state = ?
     WHERE scope_key = ? AND request_id = ? AND seq = ?`,
  ).run(
    canonical.record_json,
    canonical.record_sha256,
    record.status,
    eventState,
    row.scope_key,
    row.request_id,
    row.seq,
  );
}

function isTerminalTask(task: Task): boolean {
  return TERMINAL_TASK_STATUSES.has(task.status);
}

export async function createResearchService(
  options: ResearchServiceOptions,
): Promise<DurableResearchService> {
  if (
    !options ||
    !options.tasks ||
    !options.artifacts ||
    !options.worker ||
    typeof options.worker.id !== "string" ||
    options.worker.id.length === 0 ||
    typeof options.worker.version !== "string" ||
    options.worker.version.length === 0 ||
    typeof options.worker.run !== "function"
  ) {
    throw new ResearchError(
      "invalid_input",
      "Invalid research service options",
    );
  }
  const configured = validateOptions(options);
  const requestedMaxTimerMs = (
    options as ResearchServiceOptions & { __maxTimerMs?: number }
  ).__maxTimerMs;
  const maxTimerMs =
    typeof requestedMaxTimerMs === "number" &&
    Number.isSafeInteger(requestedMaxTimerMs) &&
    requestedMaxTimerMs > 0
      ? Math.min(MAX_TIMER_MS, requestedMaxTimerMs)
      : MAX_TIMER_MS;
  const storeOptions =
    options.hostPrivateRoots === undefined
      ? { rootDir: options.rootDir }
      : {
          rootDir: options.rootDir,
          hostPrivateRoots: options.hostPrivateRoots,
        };
  const store: OpenResearchStore = await openResearchStore(storeOptions);
  const db = store.db;
  const instanceId = Bun.randomUUIDv7();
  const privateNeedles = privatePathForms(
    store.rootDir,
    options.hostPrivateRoots ?? [],
  );
  const localRuns = new Map<string, LocalRun>();
  const waiters = new Set<() => void>();
  let state: "open" | "closing" | "closed" = "open";
  let dbOpen = true;
  let autoPump: ReturnType<typeof setInterval> | undefined;
  let pumping = false;
  let flushInFlight: Promise<void> | null = null;
  let closePromise: Promise<void> | undefined;

  const currentTime = (): number => configured.now();
  const checkOpen = (): void => {
    if (state !== "open") throw new ResearchError("closed", CLOSED_MESSAGE);
  };
  const parseContext = (value: unknown): ParsedContext => {
    const context = safeContext(value);
    const scopeJson = canonicalJson(context.scope);
    return {
      context,
      scopeKey: sha256(scopeJson),
      scopeJson,
    };
  };
  const scopeCanonicalContext = (scopeJson: string, requestId: string) => {
    let scope: RequestContext["scope"];
    try {
      const parsed = ScopeSchema.safeParse(JSON.parse(scopeJson));
      if (!parsed.success) throw new Error();
      scope = parsed.data;
    } catch {
      throw new ResearchError("corrupt_record", "Corrupt stored scope");
    }
    return storedContext(scope, requestId);
  };
  const assertPrivate = (text: string): void => {
    if (containsPrivateText(text, privateNeedles)) {
      throw new ResearchError("invalid_input", "Input contains private data");
    }
  };
  assertPrivate(options.worker.id);
  assertPrivate(options.worker.version);
  const wake = (): void => {
    for (const resolve of [...waiters]) resolve();
  };
  const waitForChange = (): Promise<void> =>
    new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const finish = () => {
        clearTimeout(timer);
        waiters.delete(finish);
        resolve();
      };
      timer = setTimeout(finish, configured.pollMs);
      waiters.add(finish);
    });

  const toJob = (row: RequestRow): ResearchJob => {
    const request = verifiedRequest(row);
    const count = db
      .query(
        "SELECT COUNT(*) AS count FROM findings WHERE scope_key = ? AND request_id = ?",
      )
      .get(row.scope_key, row.request_id) as { count: number };
    return {
      request_id: row.request_id,
      task_id: row.task_id,
      task_revision: row.task_revision,
      question: request.question,
      status: row.status,
      stale: row.stale === 1,
      cancel_requested: row.cancel_requested === 1,
      attempts: row.attempts,
      max_attempts: row.max_attempts,
      submitted_at: row.submitted_at,
      deadline: row.deadline,
      requested_deadline: row.requested_deadline,
      finished_at: row.finished_at,
      error_code: row.error_code,
      budget: request.budget,
      usage: usageFromJson(row.usage_json),
      enforcement: {
        deadline: "enforced",
        duration: "enforced",
        concurrency: "enforced",
        tokens: "reported_usage_only",
        usd: "reported_usage_only",
      },
      worker: rowWorker(row),
      finding_count: count.count,
    };
  };

  const allFindings = (
    scopeKey: string,
    requestId: string,
    afterSeq = 0,
  ): FindingRow[] =>
    db
      .query(
        `SELECT * FROM findings
         WHERE scope_key = ? AND request_id = ? AND seq > ?
         ORDER BY seq`,
      )
      .all(scopeKey, requestId, afterSeq) as FindingRow[];

  const flushEventsWork = async (): Promise<void> => {
    if (!options.events || !dbOpen) return;
    const pending = db
      .query(
        `SELECT * FROM findings WHERE event_state = 'pending'
         ORDER BY scope_key, request_id, seq`,
      )
      .all() as FindingRow[];
    for (const row of pending) {
      if (!dbOpen) return;
      try {
        const eventInput = parseStoredEventInput(row.event_json);
        if (!eventInput || row.event_request_id === null) continue;
        verifiedFinding(row);
        const request = findRequest(db, row.scope_key, row.request_id);
        const scopeContext = scopeCanonicalContext(
          request.scope_json,
          row.event_request_id,
        );
        await options.events.appendEvent(
          scopeContext,
          request.task_id,
          eventInput,
        );
        if (!dbOpen) return;
        immediate(db, () => {
          db.query(
            `UPDATE findings SET event_state = 'sent'
             WHERE scope_key = ? AND request_id = ? AND seq = ?
               AND event_state = 'pending'`,
          ).run(row.scope_key, row.request_id, row.seq);
        });
      } catch {
        // Pending outbox records are retried on a later pump.
      }
    }

    if (!dbOpen) return;
    const staleRows = db
      .query(
        `SELECT * FROM requests WHERE stale_event_state = 'pending'
         ORDER BY seq`,
      )
      .all() as RequestRow[];
    for (const row of staleRows) {
      if (!dbOpen) return;
      try {
        const eventInput = parseStoredEventInput(row.stale_event_json);
        if (!eventInput || row.stale_event_request_id === null) continue;
        const context = scopeCanonicalContext(
          row.scope_json,
          row.stale_event_request_id,
        );
        await options.events.appendEvent(context, row.task_id, eventInput);
        if (!dbOpen) return;
        immediate(db, () => {
          db.query(
            `UPDATE requests SET stale_event_state = 'sent'
             WHERE scope_key = ? AND request_id = ?
               AND stale_event_state = 'pending'`,
          ).run(row.scope_key, row.request_id);
        });
      } catch {
        // Pending outbox records are retried on a later pump.
      }
    }
  };

  const flushEvents = (): Promise<void> => {
    if (!options.events || !dbOpen) return Promise.resolve();
    if (flushInFlight) return flushInFlight;
    let inFlight!: Promise<void>;
    inFlight = Promise.resolve()
      .then(flushEventsWork)
      .finally(() => {
        if (flushInFlight === inFlight) flushInFlight = null;
      });
    flushInFlight = inFlight;
    return inFlight;
  };

  const markExpired = (entry: LocalRun): void => {
    if (
      !dbOpen ||
      entry.controller.signal.aborted ||
      localRuns.get(entry.key) !== entry
    ) {
      return;
    }
    const row = db
      .query(
        `SELECT deadline FROM requests
         WHERE scope_key = ? AND request_id = ? AND lease_token = ?
           AND status IN ('queued', 'running')`,
      )
      .get(entry.scopeKey, entry.requestId, entry.token) as {
      deadline: string;
    } | null;
    if (!row) return;
    const deadline = Date.parse(row.deadline);
    const remaining = deadline - currentTime();
    if (remaining > 0) {
      clearTimeout(entry.deadlineTimer);
      entry.deadlineTimer = setTimeout(
        () => markExpired(entry),
        Math.max(0, Math.min(maxTimerMs, remaining)),
      );
      entry.deadlineTimer.unref?.();
      return;
    }
    const changed = immediate(db, () =>
      db
        .query(
          `UPDATE requests
           SET status = 'expired', error_code = 'deadline_exceeded',
               finished_at = ?, lease_owner = NULL, lease_token = NULL,
               lease_expires_at = NULL
           WHERE scope_key = ? AND request_id = ? AND lease_token = ?
             AND status IN ('queued', 'running')`,
        )
        .run(
          timestamp(currentTime()),
          entry.scopeKey,
          entry.requestId,
          entry.token,
        ),
    );
    if (changed.changes === 1) {
      clearTimeout(entry.deadlineTimer);
      entry.controller.abort("deadline_exceeded");
      wake();
    }
  };

  const abortForRowState = (entry: LocalRun): void => {
    if (entry.controller.signal.aborted || !dbOpen) return;
    const row = db
      .query(
        `SELECT status, cancel_requested, deadline, error_code FROM requests
         WHERE scope_key = ? AND request_id = ?`,
      )
      .get(entry.scopeKey, entry.requestId) as {
      status: ResearchJobStatus;
      cancel_requested: number;
      deadline: string;
      error_code: ResearchJob["error_code"];
    } | null;
    if (!row) {
      entry.controller.abort("lease_lost");
    } else if (row.cancel_requested === 1 || row.status === "cancelled") {
      entry.controller.abort("cancelled");
    } else if (row.error_code === "budget_exceeded") {
      entry.controller.abort("budget_exceeded");
    } else if (
      row.status === "expired" ||
      currentTime() >= Date.parse(row.deadline)
    ) {
      entry.controller.abort("deadline_exceeded");
    } else {
      entry.controller.abort("lease_lost");
    }
  };

  const heartbeat = (entry: LocalRun): void => {
    if (!dbOpen || entry.controller.signal.aborted) return;
    const row = db
      .query(
        `SELECT deadline FROM requests
         WHERE scope_key = ? AND request_id = ? AND lease_token = ?`,
      )
      .get(entry.scopeKey, entry.requestId, entry.token) as {
      deadline: string;
    } | null;
    if (!row) {
      abortForRowState(entry);
      return;
    }
    if (currentTime() >= Date.parse(row.deadline)) {
      markExpired(entry);
      return;
    }
    const updated = immediate(db, () =>
      db
        .query(
          `UPDATE requests SET lease_expires_at = ?
           WHERE scope_key = ? AND request_id = ? AND lease_token = ?
             AND status = 'running' AND lease_expires_at > ?
             AND cancel_requested = 0`,
        )
        .run(
          currentTime() + configured.leaseMs,
          entry.scopeKey,
          entry.requestId,
          entry.token,
          currentTime(),
        ),
    );
    if (updated.changes !== 1) abortForRowState(entry);
  };

  const workerGuard = (entry: LocalRun, requireDb = true): RequestRow => {
    if (entry.forced || !dbOpen || !requireDb) {
      throw new ResearchError("lease_lost", "Research worker lease was lost");
    }
    const row = db
      .query("SELECT * FROM requests WHERE scope_key = ? AND request_id = ?")
      .get(entry.scopeKey, entry.requestId) as RequestRow | null;
    if (!row)
      throw new ResearchError("lease_lost", "Research worker lease was lost");
    if (row.cancel_requested === 1 || row.status === "cancelled") {
      throw new ResearchError("cancelled", "Research request was cancelled");
    }
    if (row.error_code === "budget_exceeded") {
      throw new ResearchError("budget_exceeded", "Research budget exceeded");
    }
    if (row.status === "expired" || currentTime() >= Date.parse(row.deadline)) {
      throw new ResearchError(
        "deadline_exceeded",
        "Research request deadline was exceeded",
      );
    }
    if (
      row.lease_token !== entry.token ||
      row.status !== "running" ||
      row.lease_expires_at === null ||
      row.lease_expires_at <= currentTime() ||
      entry.controller.signal.aborted
    ) {
      throw new ResearchError("lease_lost", "Research worker lease was lost");
    }
    return row;
  };

  const guarded = <T>(entry: LocalRun, operation: (row: RequestRow) => T): T =>
    immediate(db, () => operation(workerGuard(entry)));

  const claimNext = (): ClaimedJob | null => {
    return immediate(db, () => {
      const now = currentTime();
      db.query(
        `UPDATE requests
         SET status = 'expired', error_code = 'deadline_exceeded',
             finished_at = ?, lease_owner = NULL, lease_token = NULL,
             lease_expires_at = NULL
         WHERE status IN ('queued', 'running') AND deadline <= ?`,
      ).run(timestamp(now), timestamp(now));
      db.query(
        `UPDATE requests
         SET status = 'cancelled', error_code = 'cancelled', finished_at = ?,
             lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
         WHERE status IN ('queued', 'running') AND status = 'queued'
           AND cancel_requested = 1`,
      ).run(timestamp(now));
      const candidates = db
        .query(
          `SELECT * FROM requests
           WHERE (status = 'queued' AND cancel_requested = 0 AND available_at <= ?)
              OR (status = 'running' AND lease_expires_at <= ?)
           ORDER BY seq`,
        )
        .all(now, now) as RequestRow[];
      for (const candidate of candidates) {
        const key = `${candidate.scope_key}\n${candidate.request_id}`;
        if (localRuns.has(key)) continue;
        const request = verifiedRequest(candidate);
        if (now >= Date.parse(candidate.deadline)) {
          db.query(
            `UPDATE requests
             SET status = 'expired', error_code = 'deadline_exceeded',
                 finished_at = ?, lease_owner = NULL, lease_token = NULL,
                 lease_expires_at = NULL
             WHERE scope_key = ? AND request_id = ?
               AND status IN ('queued', 'running')`,
          ).run(timestamp(now), candidate.scope_key, candidate.request_id);
          wake();
          continue;
        }
        if (candidate.attempts >= candidate.max_attempts) {
          db.query(
            `UPDATE requests
             SET status = 'failed', error_code = 'attempts_exhausted',
                 finished_at = ?, lease_owner = NULL, lease_token = NULL,
                 lease_expires_at = NULL
             WHERE scope_key = ? AND request_id = ?
               AND status IN ('queued', 'running')`,
          ).run(timestamp(now), candidate.scope_key, candidate.request_id);
          wake();
          continue;
        }
        const token = randomUUID();
        const attempt = candidate.attempts + 1;
        const workerJson = JSON.stringify({
          id: options.worker.id,
          version: options.worker.version,
        });
        db.query(
          `UPDATE requests
           SET status = 'running', attempts = ?, lease_owner = ?,
               lease_token = ?, lease_expires_at = ?, worker_json = ?
           WHERE scope_key = ? AND request_id = ?
             AND status IN ('queued', 'running')`,
        ).run(
          attempt,
          instanceId,
          token,
          now + configured.leaseMs,
          workerJson,
          candidate.scope_key,
          candidate.request_id,
        );
        return {
          row: {
            ...candidate,
            status: "running",
            attempts: attempt,
            lease_owner: instanceId,
            lease_token: token,
            lease_expires_at: now + configured.leaseMs,
            worker_json: workerJson,
          },
          request,
          token,
          attempt,
        };
      }
      return null;
    });
  };

  const finishSuccess = (entry: LocalRun): void => {
    if (!dbOpen || entry.forced || entry.controller.signal.aborted) return;
    const row = db
      .query(
        "SELECT deadline FROM requests WHERE scope_key = ? AND request_id = ? AND lease_token = ?",
      )
      .get(entry.scopeKey, entry.requestId, entry.token) as {
      deadline: string;
    } | null;
    if (!row) return;
    if (currentTime() >= Date.parse(row.deadline)) {
      markExpired(entry);
      return;
    }
    immediate(db, () => {
      db.query(
        `UPDATE requests
         SET status = 'completed', finished_at = ?, lease_owner = NULL,
             lease_token = NULL, lease_expires_at = NULL
         WHERE scope_key = ? AND request_id = ? AND lease_token = ?
           AND status IN ('queued', 'running') AND status = 'running'
           AND cancel_requested = 0
           AND lease_expires_at > ?`,
      ).run(
        timestamp(currentTime()),
        entry.scopeKey,
        entry.requestId,
        entry.token,
        currentTime(),
      );
    });
    wake();
  };

  const finishFailure = (entry: LocalRun, error: unknown): void => {
    if (!dbOpen || entry.forced || entry.controller.signal.aborted) return;
    const nonRetryable = error instanceof ResearchError;
    const failed = immediate(db, () => {
      const row = db
        .query(
          `SELECT attempts, max_attempts, lease_token, lease_expires_at, status
           FROM requests WHERE scope_key = ? AND request_id = ?`,
        )
        .get(entry.scopeKey, entry.requestId) as {
        attempts: number;
        max_attempts: number;
        lease_token: string | null;
        lease_expires_at: number | null;
        status: ResearchJobStatus;
      } | null;
      if (
        !row ||
        row.lease_token !== entry.token ||
        row.status !== "running" ||
        row.lease_expires_at === null ||
        row.lease_expires_at <= currentTime()
      ) {
        return false;
      }
      if (!nonRetryable && row.attempts < row.max_attempts) {
        db.query(
          `UPDATE requests SET status = 'queued', available_at = ?,
             lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
           WHERE scope_key = ? AND request_id = ? AND lease_token = ?
             AND status IN ('queued', 'running') AND status = 'running'
             AND lease_expires_at > ?`,
        ).run(
          currentTime() + configured.retryBackoffMs * row.attempts,
          entry.scopeKey,
          entry.requestId,
          entry.token,
          currentTime(),
        );
      } else {
        db.query(
          `UPDATE requests SET status = 'failed', error_code = ?,
             finished_at = ?, lease_owner = NULL, lease_token = NULL,
             lease_expires_at = NULL
           WHERE scope_key = ? AND request_id = ? AND lease_token = ?
             AND status IN ('queued', 'running') AND status = 'running'
             AND lease_expires_at > ?`,
        ).run(
          nonRetryable ? "worker_failed" : "attempts_exhausted",
          timestamp(currentTime()),
          entry.scopeKey,
          entry.requestId,
          entry.token,
          currentTime(),
        );
      }
      return true;
    });
    if (failed) wake();
  };

  const workerContext = (
    entry: LocalRun,
    parsedContext: RequestContext,
    request: ResearchRequest,
  ): ResearchWorkerContext => {
    const allowed = new Map(
      request.known_context.map((ref) => [ref.artifact_id, ref]),
    );
    return {
      signal: entry.controller.signal,
      async readKnownContext(ref) {
        const known = allowed.get(ref.artifact_id);
        if (!known || canonicalJson(known) !== canonicalJson(ref)) {
          throw new ResearchError("not_found", NOT_FOUND_MESSAGE);
        }
        try {
          return await options.artifacts.get(
            storedContext(
              parsedContext.scope,
              `research:${entry.requestId}:known-context`,
            ),
            known,
          );
        } catch {
          throw new ResearchError("not_found", NOT_FOUND_MESSAGE);
        }
      },
      async captureEvidence(capture) {
        guarded(entry, () => undefined);
        if (
          !capture ||
          typeof capture !== "object" ||
          typeof capture.media_type !== "string" ||
          capture.media_type.length === 0 ||
          capture.media_type.length > 128 ||
          !/^[\w.+-]+\/[\w.+-]+$/.test(capture.media_type) ||
          !(capture.data instanceof Uint8Array) ||
          capture.data.byteLength === 0 ||
          capture.data.byteLength > configured.maxEvidenceBytes
        ) {
          throw new ResearchError(
            "citation_rejected",
            "Evidence capture is not valid",
          );
        }
        const url = validateCitationUrl(capture.url);
        const retrievedTimestamp = ResearchTimestampSchema.safeParse(
          capture.retrieved_at,
        );
        const retrievedAt = Date.parse(capture.retrieved_at);
        const submittedAt = Date.parse(
          findRequest(db, entry.scopeKey, entry.requestId).submitted_at,
        );
        if (
          !retrievedTimestamp.success ||
          !Number.isFinite(retrievedAt) ||
          retrievedAt > currentTime() ||
          retrievedAt < submittedAt
        ) {
          throw new ResearchError(
            "citation_rejected",
            "Evidence timestamp is not valid",
          );
        }
        if (
          containsPrivateText(
            new TextDecoder().decode(capture.data),
            privateNeedles,
          )
        ) {
          throw new ResearchError(
            "invalid_input",
            "Evidence contains private data",
          );
        }
        const digest = sha256(capture.data);
        let ref: ArtifactRef;
        try {
          ref = await options.artifacts.put(
            storedContext(
              parsedContext.scope,
              `research:${entry.requestId}:evidence:${digest}`,
            ),
            capture.data,
            capture.media_type,
          );
        } catch {
          throw new ResearchError("invalid_state", "Evidence storage failed");
        }
        const parsedRef = ArtifactRefSchema.safeParse(ref);
        if (!parsedRef.success) {
          throw new ResearchError("invalid_state", "Evidence storage failed");
        }
        ref = parsedRef.data;
        return guarded(entry, (_row) => {
          db.query(
            `INSERT OR IGNORE INTO evidence
             (scope_key, request_id, artifact_id, sha256, media_type,
              byte_length, url, retrieved_at, captured_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            entry.scopeKey,
            entry.requestId,
            ref.artifact_id,
            ref.sha256,
            ref.media_type,
            ref.byte_length,
            url,
            capture.retrieved_at,
            timestamp(currentTime()),
          );
          return ref;
        });
      },
      async publish(proposal) {
        if (
          proposal !== null &&
          typeof proposal === "object" &&
          Array.isArray((proposal as FindingProposal).sources) &&
          (proposal as FindingProposal).sources.length === 0
        ) {
          throw new ResearchError(
            "citation_rejected",
            "A finding requires captured evidence",
          );
        }
        const parsed = FindingProposalSchema.safeParse(proposal);
        if (!parsed.success) {
          throw new ResearchError("invalid_input", "Invalid finding proposal");
        }
        const value = parsed.data;
        for (const text of [
          value.claim,
          value.recommendation,
          ...value.remaining_uncertainty,
          ...value.sources.map((source) => source.url),
        ]) {
          assertPrivate(text);
        }
        if (value.sources.length === 0) {
          throw new ResearchError(
            "citation_rejected",
            "A finding requires captured evidence",
          );
        }
        const seenSources = new Set<string>();
        for (const source of value.sources) {
          validateCitationUrl(source.url);
          const sourceKey = `${source.url}\n${source.evidence.artifact_id}`;
          if (seenSources.has(sourceKey)) {
            throw new ResearchError(
              "invalid_input",
              "Duplicate finding source",
            );
          }
          seenSources.add(sourceKey);
          const evidence = db
            .query(
              `SELECT 1 AS present FROM evidence
               WHERE scope_key = ? AND request_id = ? AND artifact_id = ?
                 AND sha256 = ? AND media_type = ? AND byte_length = ?
                 AND url = ? AND retrieved_at = ?`,
            )
            .get(
              entry.scopeKey,
              entry.requestId,
              source.evidence.artifact_id,
              source.evidence.sha256,
              source.evidence.media_type,
              source.evidence.byte_length,
              source.url,
              source.retrieved_at,
            ) as { present: number } | null;
          if (!evidence) {
            throw new ResearchError(
              "citation_rejected",
              "Finding source was not captured for this request",
            );
          }
        }
        const canonicalContent = {
          claim: value.claim,
          recommendation: value.recommendation,
          confidence: value.confidence,
          remaining_uncertainty: value.remaining_uncertainty,
          sources: value.sources,
        };
        return guarded(entry, (row) => {
          const prior = db
            .query(
              `SELECT * FROM findings
               WHERE scope_key = ? AND request_id = ? AND finding_key = ?`,
            )
            .get(
              entry.scopeKey,
              entry.requestId,
              value.finding_key,
            ) as FindingRow | null;
          if (prior) {
            const existing = verifiedFinding(prior);
            const priorContent = {
              claim: existing.claim,
              recommendation: existing.recommendation,
              confidence: existing.confidence,
              remaining_uncertainty: existing.remaining_uncertainty,
              sources: existing.sources,
            };
            if (
              JSON.stringify(canonicalRecord(priorContent).record_json) ===
              JSON.stringify(canonicalRecord(canonicalContent).record_json)
            ) {
              return existing;
            }
            throw new ResearchError(
              "conflict",
              "Finding key has different content",
            );
          }
          const count = db
            .query(
              "SELECT COUNT(*) AS count FROM findings WHERE scope_key = ? AND request_id = ?",
            )
            .get(entry.scopeKey, entry.requestId) as { count: number };
          if (count.count >= configured.maxFindingsPerRequest) {
            throw new ResearchError("finding_limit", "Finding limit reached");
          }
          const seqRow = db
            .query(
              "SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM findings WHERE scope_key = ? AND request_id = ?",
            )
            .get(entry.scopeKey, entry.requestId) as { next_seq: number };
          const findingId = `rf_${sha256(
            `${entry.scopeKey}\n${entry.requestId}\n${value.finding_key}`,
          ).slice(0, 32)}`;
          const record: ResearchFinding = {
            finding_id: findingId,
            request_id: entry.requestId,
            task_revision: row.task_revision,
            claim: value.claim,
            sources: value.sources,
            recommendation: value.recommendation,
            confidence: value.confidence,
            remaining_uncertainty: value.remaining_uncertainty,
            status: "proposed",
          };
          const canonical = canonicalRecord(record);
          let eventRequestId: string | null = null;
          let eventJson: string | null = null;
          if (options.events) {
            const worker = rowWorker(row) ?? {
              id: options.worker.id,
              version: options.worker.version,
            };
            eventRequestId = `research:${findingId}:proposed`;
            eventJson = canonicalJson({
              event_type: "research.proposed",
              run_id: entry.requestId,
              producer: "mars-research",
              versions: [
                {
                  component: "@mars/research",
                  revision: String(RESEARCH_STORE_FORMAT_VERSION),
                },
                {
                  component: `worker:${worker.id}`,
                  revision: worker.version,
                },
              ],
              payload: {
                request_id: entry.requestId,
                finding_id: findingId,
                task_revision: record.task_revision,
                confidence: record.confidence,
                source_count: record.sources.length,
              },
              source_event_ids: [],
            } satisfies AppendEventInput);
          }
          db.query(
            `INSERT INTO findings
             (scope_key, request_id, seq, finding_id, finding_key, record_json,
              record_sha256, status, attempt, event_state, event_request_id,
              event_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?)`,
          ).run(
            entry.scopeKey,
            entry.requestId,
            seqRow.next_seq,
            findingId,
            value.finding_key,
            canonical.record_json,
            canonical.record_sha256,
            row.attempts,
            options.events ? "pending" : "none",
            eventRequestId,
            eventJson,
          );
          wake();
          return record;
        });
      },
      async reportUsage(delta) {
        if (
          !delta ||
          !Number.isSafeInteger(delta.input_tokens) ||
          delta.input_tokens < 0 ||
          !Number.isSafeInteger(delta.output_tokens) ||
          delta.output_tokens < 0 ||
          (delta.cost_usd !== undefined &&
            delta.cost_usd !== null &&
            (!Number.isFinite(delta.cost_usd) || delta.cost_usd < 0))
        ) {
          throw new ResearchError("invalid_input", "Invalid reported usage");
        }
        let exceeded = false;
        guarded(entry, (row) => {
          const request = verifiedRequest(row);
          const usage = usageFromJson(row.usage_json);
          const inputTokens = usage.input_tokens + delta.input_tokens;
          const outputTokens = usage.output_tokens + delta.output_tokens;
          const reportedCost =
            delta.cost_usd === undefined || delta.cost_usd === null
              ? usage.cost_usd
              : (usage.cost_usd ?? 0) + delta.cost_usd;
          const nextUsage: ResearchUsage = {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cost_usd: reportedCost,
            reported: true,
          };
          exceeded =
            inputTokens + outputTokens > request.budget.max_tokens ||
            (reportedCost !== null && reportedCost > request.budget.max_usd);
          if (exceeded) {
            db.query(
              `UPDATE requests SET usage_json = ?, status = 'failed',
                 error_code = 'budget_exceeded', finished_at = ?,
                 lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
               WHERE scope_key = ? AND request_id = ? AND lease_token = ?
                 AND status IN ('queued', 'running') AND status = 'running'`,
            ).run(
              JSON.stringify(nextUsage),
              timestamp(currentTime()),
              entry.scopeKey,
              entry.requestId,
              entry.token,
            );
          } else {
            db.query(
              `UPDATE requests SET usage_json = ?
               WHERE scope_key = ? AND request_id = ? AND lease_token = ?`,
            ).run(
              JSON.stringify(nextUsage),
              entry.scopeKey,
              entry.requestId,
              entry.token,
            );
          }
        });
        if (exceeded) {
          entry.controller.abort("budget_exceeded");
          wake();
          throw new ResearchError(
            "budget_exceeded",
            "Research budget exceeded",
          );
        }
      },
    };
  };

  const executeClaim = async (claim: ClaimedJob): Promise<void> => {
    const key = `${claim.row.scope_key}\n${claim.row.request_id}`;
    const controller = new AbortController();
    const heartbeatMs = Math.max(10, Math.floor(configured.leaseMs / 3));
    const entry: LocalRun = {
      key,
      scopeKey: claim.row.scope_key,
      requestId: claim.row.request_id,
      token: claim.token,
      controller,
      heartbeat: setInterval(() => heartbeat(entry), heartbeatMs),
      deadlineTimer: setTimeout(
        () => markExpired(entry),
        Math.max(
          0,
          Math.min(maxTimerMs, Date.parse(claim.row.deadline) - currentTime()),
        ),
      ),
      forced: false,
      settled: Promise.resolve(),
    };
    entry.heartbeat.unref?.();
    entry.deadlineTimer.unref?.();
    localRuns.set(key, entry);
    const context = scopeCanonicalContext(
      claim.row.scope_json,
      `research:${claim.row.request_id}:worker`,
    );
    const findingKeys = db
      .query(
        "SELECT finding_key FROM findings WHERE scope_key = ? AND request_id = ? ORDER BY seq",
      )
      .all(claim.row.scope_key, claim.row.request_id) as Array<{
      finding_key: string;
    }>;
    const input: ResearchWorkerInput = {
      request_id: claim.row.request_id,
      attempt: claim.attempt,
      question: claim.request.question,
      task_id: claim.request.task_id,
      task_revision: claim.request.task_revision,
      known_context: claim.request.known_context,
      source_requirements: claim.request.source_requirements,
      deadline: claim.row.deadline,
      budget: claim.request.budget,
      published_finding_keys: findingKeys.map((finding) => finding.finding_key),
    };
    const task = Promise.resolve().then(() =>
      options.worker.run(input, workerContext(entry, context, claim.request)),
    );
    entry.settled = task
      .then(
        () => finishSuccess(entry),
        (error: unknown) => finishFailure(entry, error),
      )
      .then(async () => {
        clearInterval(entry.heartbeat);
        clearTimeout(entry.deadlineTimer);
        localRuns.delete(key);
        wake();
        await flushEvents();
        if (state === "open" && configured.autoStart) await pump();
      })
      .catch(() => {
        clearInterval(entry.heartbeat);
        clearTimeout(entry.deadlineTimer);
        localRuns.delete(key);
        wake();
      });
    void entry.settled;
  };

  const pump = async (): Promise<void> => {
    if (state !== "open" || pumping) return;
    pumping = true;
    try {
      const now = currentTime();
      immediate(db, () => {
        db.query(
          `UPDATE requests
           SET status = 'expired', error_code = 'deadline_exceeded',
               finished_at = ?, lease_owner = NULL, lease_token = NULL,
               lease_expires_at = NULL
           WHERE status IN ('queued', 'running') AND deadline <= ?`,
        ).run(timestamp(now), timestamp(now));
      });
      await flushEvents();
      while (localRuns.size < configured.maxConcurrency && state === "open") {
        const claim = claimNext();
        if (!claim) break;
        void executeClaim(claim).catch(() => {});
      }
      wake();
    } finally {
      pumping = false;
    }
  };

  const schedulePump = (): void => {
    if (configured.autoStart && state === "open") {
      queueMicrotask(() => {
        void pump().catch(() => {});
      });
    }
  };

  const markStaleInternal = (scopeKey: string, requestId: string): boolean => {
    const changed = immediate(db, () => {
      const row = findRequest(db, scopeKey, requestId);
      if (row.stale === 1) return false;
      const findings = db
        .query(
          `SELECT * FROM findings WHERE scope_key = ? AND request_id = ?
           ORDER BY seq`,
        )
        .all(scopeKey, requestId) as FindingRow[];
      for (const findingRow of findings) {
        const finding = verifiedFinding(findingRow);
        if (finding.status === "proposed") {
          updateFindingRecord(
            db,
            findingRow,
            { ...finding, status: "stale" },
            options.events ? findingRow.event_state : "none",
          );
        }
      }
      let staleEventRequestId: string | null = null;
      let staleEventJson: string | null = null;
      if (options.events) {
        const worker = rowWorker(row);
        const staleFindingIds = db
          .query(
            `SELECT finding_id FROM findings
             WHERE scope_key = ? AND request_id = ? AND status = 'stale'
             ORDER BY seq`,
          )
          .all(scopeKey, requestId) as Array<{ finding_id: string }>;
        staleEventRequestId = `research:${row.request_id}:stale`;
        staleEventJson = canonicalJson({
          event_type: "research.stale",
          run_id: row.request_id,
          producer: "mars-research",
          versions: [
            {
              component: "@mars/research",
              revision: String(RESEARCH_STORE_FORMAT_VERSION),
            },
            worker
              ? {
                  component: `worker:${worker.id}`,
                  revision: worker.version,
                }
              : { component: "worker:none", revision: "0" },
          ],
          payload: {
            request_id: row.request_id,
            task_revision: row.task_revision,
            stale_finding_ids: staleFindingIds.map(
              (finding) => finding.finding_id,
            ),
          },
          source_event_ids: [],
        } satisfies AppendEventInput);
      }
      const active = ACTIVE_STATUSES.includes(
        row.status as "queued" | "running",
      );
      if (active) {
        db.query(
          `UPDATE requests SET stale = 1,
             stale_event_state = ?, stale_event_request_id = ?,
             stale_event_json = ?, cancel_requested = 1,
             status = 'cancelled', error_code = 'cancelled', finished_at = ?,
             lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
           WHERE scope_key = ? AND request_id = ?
             AND status IN ('queued', 'running')`,
        ).run(
          options.events ? "pending" : "none",
          staleEventRequestId,
          staleEventJson,
          timestamp(currentTime()),
          scopeKey,
          requestId,
        );
      } else {
        db.query(
          `UPDATE requests SET stale = 1, stale_event_state = ?,
             stale_event_request_id = ?, stale_event_json = ?
           WHERE scope_key = ? AND request_id = ?
             AND status NOT IN ('queued', 'running')`,
        ).run(
          options.events ? "pending" : "none",
          staleEventRequestId,
          staleEventJson,
          scopeKey,
          requestId,
        );
      }
      return true;
    });
    const run = localRuns.get(`${scopeKey}\n${requestId}`);
    if (run) run.controller.abort("cancelled");
    wake();
    return changed;
  };

  const api: DurableResearchService = {
    async submit(contextInput, requestInput) {
      checkOpen();
      const parsedContext = parseContext(contextInput);
      const requestParsed = ResearchRequestSchema.safeParse(requestInput);
      if (!requestParsed.success) {
        throw new ResearchError("invalid_input", "Invalid research request");
      }
      const request = requestParsed.data;
      assertPrivate(request.question);
      assertPrivate(request.task_id);
      for (const requirement of request.source_requirements) {
        assertPrivate(requirement);
      }
      const inputHash = sha256(canonicalRecord(request).record_json);
      const requestId = `rr_${sha256(
        `${parsedContext.scopeKey}\n${parsedContext.context.request_id}`,
      ).slice(0, 32)}`;
      const replay = db
        .query(
          `SELECT request_id, input_sha256 FROM requests
           WHERE scope_key = ? AND idem_request_id = ?`,
        )
        .get(parsedContext.scopeKey, parsedContext.context.request_id) as {
        request_id: string;
        input_sha256: string;
      } | null;
      if (replay) {
        if (replay.input_sha256 !== inputHash) {
          throw new ResearchError(
            "conflict",
            "Request id was already used with different input",
          );
        }
        return replay.request_id;
      }
      let task: Task;
      try {
        task = await options.tasks.inspect(
          parsedContext.context,
          request.task_id,
        );
      } catch (error) {
        throw mapTaskError(error);
      }
      if (task.revision !== request.task_revision) {
        throw new ResearchError("stale_revision", "Task revision is stale");
      }
      if (isTerminalTask(task)) {
        throw new ResearchError("invalid_state", "Task is not active");
      }
      for (const field of [
        "max_tokens",
        "max_usd",
        "max_duration_ms",
        "max_concurrency",
        "max_depth",
      ] as const) {
        if (request.budget[field] > task.budget[field]) {
          throw new ResearchError(
            "invalid_input",
            "Research budget exceeds task budget",
          );
        }
      }
      const now = currentTime();
      const deadlineTime = Date.parse(request.deadline);
      if (!Number.isFinite(deadlineTime) || deadlineTime <= now) {
        throw new ResearchError(
          "invalid_input",
          "Research deadline is not in the future",
        );
      }
      const effectiveDeadline = Math.min(
        deadlineTime,
        now + request.budget.max_duration_ms,
      );
      for (const ref of request.known_context) {
        try {
          await options.artifacts.get(parsedContext.context, ref);
        } catch {
          throw new ResearchError("not_found", NOT_FOUND_MESSAGE);
        }
      }
      const record = canonicalRecord(request);
      const insertResult = immediate(db, () => {
        const existing = db
          .query(
            `SELECT request_id, input_sha256 FROM requests
             WHERE scope_key = ? AND idem_request_id = ?`,
          )
          .get(parsedContext.scopeKey, parsedContext.context.request_id) as {
          request_id: string;
          input_sha256: string;
        } | null;
        if (existing) {
          if (existing.input_sha256 !== inputHash) {
            throw new ResearchError(
              "conflict",
              "Request id was already used with different input",
            );
          }
          return { request_id: existing.request_id, inserted: false };
        }
        const scopeActive = db
          .query(
            `SELECT COUNT(*) AS count FROM requests
             WHERE scope_key = ? AND status IN ('queued', 'running')`,
          )
          .get(parsedContext.scopeKey) as { count: number };
        const totalActive = db
          .query(
            "SELECT COUNT(*) AS count FROM requests WHERE status IN ('queued', 'running')",
          )
          .get() as { count: number };
        if (
          scopeActive.count >= configured.maxActivePerScope ||
          totalActive.count >= configured.maxActiveTotal
        ) {
          throw new ResearchError("backpressure", "Research queue is full");
        }
        db.query(
          `INSERT INTO requests
           (scope_key, request_id, scope_json, idem_request_id, input_sha256,
            record_json, record_sha256, task_id, task_revision, status, stale,
            cancel_requested, attempts, max_attempts, submitted_at,
            requested_deadline, deadline, available_at, lease_owner, lease_token,
            lease_expires_at, usage_json, error_code, worker_json, finished_at,
            stale_event_state)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, 0, 0, ?, ?, ?, ?,
                   ?, NULL, NULL, NULL, ?, NULL, NULL, NULL, ?)`,
        ).run(
          parsedContext.scopeKey,
          requestId,
          parsedContext.scopeJson,
          parsedContext.context.request_id,
          inputHash,
          record.record_json,
          record.record_sha256,
          request.task_id,
          request.task_revision,
          configured.maxAttempts,
          timestamp(now),
          request.deadline,
          new Date(effectiveDeadline).toISOString(),
          now,
          JSON.stringify({
            input_tokens: 0,
            output_tokens: 0,
            cost_usd: null,
            reported: false,
          } satisfies ResearchUsage),
          "none",
        );
        return { request_id: requestId, inserted: true };
      });
      wake();
      if (insertResult.inserted) schedulePump();
      return insertResult.request_id;
    },
    async inspect(contextInput, requestId) {
      checkOpen();
      const parsedContext = parseContext(contextInput);
      if (typeof requestId !== "string" || requestId.length === 0) {
        throw new ResearchError("invalid_input", "Invalid research request id");
      }
      return toJob(findRequest(db, parsedContext.scopeKey, requestId));
    },
    async list(contextInput, filter) {
      checkOpen();
      const parsedContext = parseContext(contextInput);
      if (
        filter !== undefined &&
        (filter === null ||
          typeof filter !== "object" ||
          (filter.task_id !== undefined &&
            (typeof filter.task_id !== "string" ||
              filter.task_id.length === 0)) ||
          Object.keys(filter).some((key) => key !== "task_id"))
      ) {
        throw new ResearchError(
          "invalid_input",
          "Invalid research list filter",
        );
      }
      const rows = filter?.task_id
        ? (db
            .query(
              "SELECT * FROM requests WHERE scope_key = ? AND task_id = ? ORDER BY seq",
            )
            .all(parsedContext.scopeKey, filter.task_id) as RequestRow[])
        : (db
            .query("SELECT * FROM requests WHERE scope_key = ? ORDER BY seq")
            .all(parsedContext.scopeKey) as RequestRow[]);
      return rows.map(toJob);
    },
    async readFindings(contextInput, requestId) {
      checkOpen();
      const parsedContext = parseContext(contextInput);
      findRequest(db, parsedContext.scopeKey, requestId);
      return allFindings(parsedContext.scopeKey, requestId).map(
        verifiedFinding,
      );
    },
    async *findings(contextInput, requestId) {
      checkOpen();
      const parsedContext = parseContext(contextInput);
      let cursor = 0;
      findRequest(db, parsedContext.scopeKey, requestId);
      while (dbOpen) {
        const rows = allFindings(parsedContext.scopeKey, requestId, cursor);
        for (const row of rows) {
          const finding = verifiedFinding(row);
          cursor = row.seq;
          yield finding;
        }
        const row = findRequest(db, parsedContext.scopeKey, requestId);
        if (
          state !== "open" ||
          (TERMINAL_JOB_STATUSES.has(row.status) &&
            allFindings(parsedContext.scopeKey, requestId, cursor).length === 0)
        ) {
          return;
        }
        await waitForChange();
      }
    },
    async cancel(contextInput, requestId) {
      checkOpen();
      const parsedContext = parseContext(contextInput);
      const changed = immediate(db, () => {
        const row = findRequest(db, parsedContext.scopeKey, requestId);
        if (TERMINAL_JOB_STATUSES.has(row.status)) return false;
        db.query(
          `UPDATE requests SET cancel_requested = 1, status = 'cancelled',
             error_code = 'cancelled', finished_at = ?, lease_owner = NULL,
             lease_token = NULL, lease_expires_at = NULL
           WHERE scope_key = ? AND request_id = ?
             AND status IN ('queued', 'running')`,
        ).run(timestamp(currentTime()), parsedContext.scopeKey, requestId);
        return true;
      });
      if (changed) {
        localRuns
          .get(`${parsedContext.scopeKey}\n${requestId}`)
          ?.controller.abort("cancelled");
        wake();
      }
    },
    async markStale(contextInput, requestId) {
      checkOpen();
      const parsedContext = parseContext(contextInput);
      findRequest(db, parsedContext.scopeKey, requestId);
      if (markStaleInternal(parsedContext.scopeKey, requestId)) {
        await flushEvents();
      }
    },
    async markUsed(contextInput, findingId, expectedTaskRevision) {
      checkOpen();
      const parsedContext = parseContext(contextInput);
      if (
        !Number.isSafeInteger(expectedTaskRevision) ||
        expectedTaskRevision < 0
      ) {
        throw new ResearchError("invalid_input", "Invalid task revision");
      }
      const findingRow = findFindingById(db, parsedContext.scopeKey, findingId);
      const finding = verifiedFinding(findingRow);
      const job = findRequest(db, parsedContext.scopeKey, finding.request_id);
      let task: Task;
      try {
        task = await options.tasks.inspect(parsedContext.context, job.task_id);
      } catch (error) {
        throw mapTaskError(error);
      }
      if (
        finding.status === "used" &&
        finding.task_revision === task.revision &&
        task.revision === expectedTaskRevision
      ) {
        return finding;
      }
      if (
        finding.status === "stale" ||
        job.stale === 1 ||
        task.revision !== finding.task_revision ||
        expectedTaskRevision !== finding.task_revision
      ) {
        if (task.revision !== finding.task_revision) {
          markStaleInternal(parsedContext.scopeKey, finding.request_id);
        }
        throw new ResearchError(
          "stale_revision",
          "Finding task revision is stale",
        );
      }
      const updated = immediate(db, () => {
        const current = findFindingById(db, parsedContext.scopeKey, findingId);
        const record = verifiedFinding(current);
        if (record.status === "used") return record;
        if (record.status !== "proposed") {
          throw new ResearchError(
            "stale_revision",
            "Finding task revision is stale",
          );
        }
        const used = { ...record, status: "used" as const };
        updateFindingRecord(db, current, used);
        return used;
      });
      wake();
      return updated;
    },
    async reconcileTask(contextInput, taskId) {
      checkOpen();
      const parsedContext = parseContext(contextInput);
      let task: Task;
      try {
        task = await options.tasks.inspect(parsedContext.context, taskId);
      } catch (error) {
        throw mapTaskError(error);
      }
      const rows = db
        .query(
          `SELECT * FROM requests WHERE scope_key = ? AND task_id = ?
           ORDER BY seq`,
        )
        .all(parsedContext.scopeKey, taskId) as RequestRow[];
      const staleRequestIds: string[] = [];
      for (const row of rows) {
        if (
          row.stale === 0 &&
          (row.task_revision !== task.revision || isTerminalTask(task))
        ) {
          if (markStaleInternal(parsedContext.scopeKey, row.request_id)) {
            staleRequestIds.push(row.request_id);
          }
        }
      }
      await flushEvents();
      return {
        task_revision: task.revision,
        stale_request_ids: staleRequestIds,
      };
    },
    async pump() {
      checkOpen();
      await pump();
    },
    async close(closeOptions) {
      if (closePromise) return closePromise;
      if (state === "closed") return;
      if (
        closeOptions !== undefined &&
        (closeOptions === null ||
          typeof closeOptions !== "object" ||
          (closeOptions.drainMs !== undefined &&
            (!Number.isSafeInteger(closeOptions.drainMs) ||
              closeOptions.drainMs < 0)) ||
          Object.keys(closeOptions).some((key) => key !== "drainMs"))
      ) {
        throw new ResearchError("invalid_input", "Invalid close options");
      }
      const drainMs = closeOptions?.drainMs ?? 5000;
      const drainDeadline = Date.now() + drainMs;
      state = "closing";
      if (autoPump) clearInterval(autoPump);
      wake();
      closePromise = (async () => {
        const runDrainMs = Math.max(0, drainDeadline - Date.now());
        if (localRuns.size > 0 && runDrainMs > 0) {
          let drainTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              Promise.all([...localRuns.values()].map((run) => run.settled)),
              new Promise<void>((resolve) => {
                drainTimer = setTimeout(resolve, runDrainMs);
              }),
            ]);
          } finally {
            if (drainTimer !== undefined) clearTimeout(drainTimer);
          }
        }
        for (const run of [...localRuns.values()]) {
          run.forced = true;
          run.controller.abort("shutdown");
          if (dbOpen) {
            immediate(db, () => {
              db.query(
                `UPDATE requests SET status = 'queued', available_at = ?,
                   lease_owner = NULL, lease_token = NULL,
                   lease_expires_at = NULL
                 WHERE scope_key = ? AND request_id = ? AND lease_token = ?
                   AND status IN ('queued', 'running') AND status = 'running'`,
              ).run(currentTime(), run.scopeKey, run.requestId, run.token);
            });
          }
          clearInterval(run.heartbeat);
          clearTimeout(run.deadlineTimer);
        }
        state = "closed";
        wake();
        dbOpen = false;
        const pendingFlush = flushInFlight;
        if (pendingFlush) {
          const safeFlush = pendingFlush.catch(() => {});
          const remainingMs = Math.max(0, drainDeadline - Date.now());
          if (remainingMs > 0) {
            let flushTimer: ReturnType<typeof setTimeout> | undefined;
            try {
              await Promise.race([
                safeFlush,
                new Promise<void>((resolve) => {
                  flushTimer = setTimeout(resolve, remainingMs);
                }),
              ]);
            } finally {
              if (flushTimer !== undefined) clearTimeout(flushTimer);
            }
          }
        }
        store.close();
      })();
      return closePromise;
    },
  };

  if (configured.autoStart) {
    autoPump = setInterval(() => {
      void pump().catch(() => {});
    }, configured.pollMs);
    autoPump.unref?.();
    schedulePump();
    void pump().catch(() => {});
  }

  return api;
}
