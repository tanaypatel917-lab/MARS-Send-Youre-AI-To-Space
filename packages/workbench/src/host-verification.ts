import { createHash } from "node:crypto";
import {
  REQUIRED_CHECK_DEFAULT_TIMEOUT_MS,
  type RequestContext,
  type RequiredCheck,
  RequiredCheckSchema,
  type Scope,
  type Task,
  VERIFICATION_EVIDENCE_OPERATION,
  type VerificationCheckLogs,
  VerificationCheckLogsSchema,
  type VerificationCheckResult,
  type VerificationEvidenceRecord,
  VerificationEvidenceRecordSchema,
  type WorkspaceRef,
} from "@mars/contracts";
import type { RuntimeSession } from "@mars/execution";
import type { DurableTaskStore } from "@mars/tasks";
import type { CheckRunRequest, CheckRunResult } from "@mars/workspaces";
import type { WorkspaceHost } from "./host";
import {
  checkOwnsPath,
  type HostCheckDefinition,
  resolveHostCheck,
} from "./host-checks";
import {
  errorCodeOf,
  internalContext,
  WORKBENCH_PRODUCER,
  workbenchEvent,
} from "./host-shared";
import { WorkspaceRefSchema } from "./protocol";

const MAX_VERIFICATION_RECORDS = 50;
const CHECK_LOGS_OPERATION = "verification.check_logs";
/** Fragments of the text-form tool-call syntax some models emit instead of a structured call. */
const TEXTUAL_TOOL_CALL = /<function=[A-Za-z0-9_]+>|<\/?tool_call>/;

function textualToolCallDiagnostic(content: string): string | null {
  const match = TEXTUAL_TOOL_CALL.exec(content);
  if (!match) return null;
  return `Assistant text contains a tool call written as text (${match[0]}); it was never executed. Tools run only through validated structured calls.`;
}

type FileContentCheck = Extract<RequiredCheck, { kind: "file_content" }>;
type HostTestCheck = Extract<RequiredCheck, { kind: "host_test" }>;

function expectedDigest(check: FileContentCheck): string {
  return (
    check.sha256 ??
    createHash("sha256")
      .update(check.content ?? "", "utf8")
      .digest("hex")
  );
}

const sha256 = (data: Uint8Array | string) =>
  createHash("sha256").update(data).digest("hex");

/** Raw SHA-256 of a candidate's exact patch bytes (file patches concatenated, no normalisation). */
export function patchSha256(diff: {
  files: readonly { patch: string }[];
}): string {
  return sha256(diff.files.map((file) => file.patch).join(""));
}

/** Thrown at Start when a client names a check the host cannot run. */
export class RequiredCheckRejected extends Error {
  constructor(
    readonly code: "invalid_request" | "forbidden",
    message: string,
  ) {
    super(message);
    this.name = "RequiredCheckRejected";
  }
}

/**
 * Launch metadata keeps only the digest form of each required check, so a
 * start that was accepted can never write a launch the host refuses to read
 * (expected bytes travel in the request, not in `launch.json`). A
 * `host_test` check is resolved against the host's own definitions here; a
 * client-supplied `definition_sha256` is ignored and replaced.
 */
export async function freezeRequiredChecks(
  checks: readonly RequiredCheck[],
  hostChecks: readonly HostCheckDefinition[] = [],
  canRunHostChecks = false,
): Promise<RequiredCheck[]> {
  const frozen: RequiredCheck[] = [];
  for (const check of checks) {
    if (check.kind === "file_content") {
      frozen.push(
        RequiredCheckSchema.parse({
          kind: check.kind,
          path: check.path,
          sha256: expectedDigest(check),
          ...(check.timeout_ms !== undefined
            ? { timeout_ms: check.timeout_ms }
            : {}),
        }),
      );
      continue;
    }
    const definition = hostChecks.find((entry) => entry.id === check.check_id);
    if (!definition)
      throw new RequiredCheckRejected(
        "invalid_request",
        `Unknown host check: ${check.check_id}`,
      );
    if (!canRunHostChecks)
      throw new RequiredCheckRejected(
        "forbidden",
        "Host checks need execute approval and a configured sandbox",
      );
    const resolved = await resolveHostCheck(definition);
    frozen.push(
      RequiredCheckSchema.parse({
        kind: "host_test",
        check_id: check.check_id,
        definition_sha256: resolved.sha256,
        ...(check.timeout_ms !== undefined
          ? { timeout_ms: check.timeout_ms }
          : {}),
      }),
    );
  }
  return frozen;
}

class CheckTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Required check timed out after ${timeoutMs} ms`);
    this.name = "CheckTimeoutError";
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new CheckTimeoutError(timeoutMs)),
        timeoutMs,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

/** What host-run required-check verification reads and writes. */
export interface VerificationHost {
  scope: Scope;
  store: DurableTaskStore;
  workspace: Pick<WorkspaceHost, "reopen" | "read"> &
    Partial<Pick<WorkspaceHost, "diff">> & {
      runCheck?(
        context: RequestContext,
        workspace: WorkspaceRef,
        request: CheckRunRequest,
      ): Promise<CheckRunResult>;
    };
  /** Host-defined protected checks; resolved again at verification time. */
  checks?: readonly HostCheckDefinition[];
  scrubOutput?(
    context: RequestContext,
    taskId: string,
    output: string,
  ): Promise<string>;
}

/**
 * The host-owned verdict: re-reads the candidate (the workspace revision
 * after the agent stopped), runs every required check against it with a
 * bounded timeout, confirms the revision did not move meanwhile, and
 * persists the result as task evidence. Never throws; an unavailable
 * verifier is `inconclusive`, never `passed`.
 */
export async function verifyCandidate(
  host: VerificationHost,
  task: Task,
  runtime: Pick<RuntimeSession, "sessionId">,
  requiredChecks: readonly RequiredCheck[],
  content: string,
): Promise<VerificationEvidenceRecord | null> {
  const context = internalContext(host.scope);
  const textual = textualToolCallDiagnostic(content);
  if (requiredChecks.length === 0) {
    // No verdict to attach it to, but the diagnostic is still evidence.
    if (textual)
      await host.store
        .appendEvent(
          context,
          task.task_id,
          workbenchEvent(
            { operation: "runtime.diagnostic", diagnostics: [textual] },
            runtime.sessionId,
          ),
        )
        .catch(() => undefined);
    return null;
  }
  const startedAt = Date.now();
  const diagnostics: string[] = [];
  const checkLogs: VerificationCheckLogs["checks"] = [];
  if (textual) diagnostics.push(textual);
  // An unstored verdict is no verdict: it must not feed review or the badge.
  const persist = async (record: VerificationEvidenceRecord) => {
    try {
      await host.store.appendEvent(
        context,
        task.task_id,
        workbenchEvent(record, runtime.sessionId),
      );
    } catch {
      return null;
    }
    if (checkLogs.length)
      await host.store
        .appendEvent(
          context,
          task.task_id,
          workbenchEvent(
            {
              operation: CHECK_LOGS_OPERATION,
              logs: { run_id: record.run_id, checks: checkLogs },
            },
            runtime.sessionId,
          ),
        )
        .catch(() => undefined);
    return record;
  };
  let candidate: WorkspaceRef;
  try {
    candidate = WorkspaceRefSchema.parse(
      await withTimeout(
        host.workspace.reopen(context, task.task_id),
        REQUIRED_CHECK_DEFAULT_TIMEOUT_MS,
      ),
    );
  } catch {
    // No candidate can be named, so no check can run; the failure is still
    // evidence (inconclusive), never silence that reads as "unverified".
    return persist(
      VerificationEvidenceRecordSchema.parse({
        schema_version: 1,
        operation: VERIFICATION_EVIDENCE_OPERATION,
        run_id: runtime.sessionId,
        task_id: task.task_id,
        task_revision: task.revision,
        candidate: null,
        verdict: "inconclusive",
        verified: false,
        checks: [],
        reasons: [
          "Candidate revision could not be acquired; required checks did not run",
        ],
        diagnostics,
        duration_ms: Math.max(0, Date.now() - startedAt),
        recorded_at: new Date().toISOString(),
      } satisfies VerificationEvidenceRecord),
    );
  }
  const checks: VerificationCheckResult[] = [];
  const reasons: string[] = [];
  let patch: { sha256: string; paths: string[] } | null = null;
  try {
    if (host.workspace.diff) {
      const diff = await withTimeout(
        host.workspace.diff(context, candidate),
        REQUIRED_CHECK_DEFAULT_TIMEOUT_MS,
      );
      patch = {
        sha256: patchSha256(diff),
        paths: diff.files.map((file) => file.path),
      };
    }
  } catch {
    patch = null;
  }
  for (const [checkIndex, check] of requiredChecks.entries()) {
    const result =
      check.kind === "file_content"
        ? await runFileContentCheck(host, context, candidate, check)
        : await runHostTestCheck(
            host,
            context,
            candidate,
            check,
            patch,
            task.task_id,
            (log) => checkLogs.push({ check_index: checkIndex, ...log }),
          );
    if (result.reason) reasons.push(result.reason);
    checks.push(result);
  }
  const patchUnreadable = Boolean(host.workspace.diff) && patch === null;
  if (patchUnreadable) {
    reasons.push(
      "Candidate patch could not be read; the verdict cannot name its bytes",
    );
  }
  let verdict: VerificationEvidenceRecord["verdict"] = checks.some(
    (check) => check.status === "failed",
  )
    ? "failed"
    : checks.some((check) => check.status === "inconclusive")
      ? "inconclusive"
      : "passed";
  if (patchUnreadable) verdict = "inconclusive";
  try {
    const after = await withTimeout(
      host.workspace.reopen(context, task.task_id),
      REQUIRED_CHECK_DEFAULT_TIMEOUT_MS,
    );
    if (after.revision !== candidate.revision) {
      verdict = "inconclusive";
      reasons.push("Workspace revision changed while checks were running");
    }
  } catch {
    verdict = "inconclusive";
    reasons.push("Candidate revision could not be confirmed after checks");
  }
  return persist(
    VerificationEvidenceRecordSchema.parse({
      schema_version: 1,
      operation: VERIFICATION_EVIDENCE_OPERATION,
      run_id: runtime.sessionId,
      task_id: task.task_id,
      task_revision: task.revision,
      candidate,
      verdict,
      verified:
        verdict === "passed" &&
        checks.every((check) => check.status === "passed"),
      checks,
      reasons,
      diagnostics,
      duration_ms: Math.max(0, Date.now() - startedAt),
      recorded_at: new Date().toISOString(),
      ...(patch ? { patch_sha256: patch.sha256 } : {}),
      check_manifest_sha256: sha256(JSON.stringify(requiredChecks)),
    } satisfies VerificationEvidenceRecord),
  );
}

async function runFileContentCheck(
  host: VerificationHost,
  context: RequestContext,
  candidate: WorkspaceRef,
  check: FileContentCheck,
): Promise<VerificationCheckResult> {
  const expected = expectedDigest(check);
  const timeoutMs = check.timeout_ms ?? REQUIRED_CHECK_DEFAULT_TIMEOUT_MS;
  const began = Date.now();
  let status: VerificationCheckResult["status"];
  let reason: string | null = null;
  let observed: string | null = null;
  try {
    const artifact = await withTimeout(
      host.workspace.read(context, candidate, check.path),
      timeoutMs,
    );
    observed = artifact.sha256;
    if (artifact.sha256 === expected) status = "passed";
    else {
      status = "failed";
      reason = `Required file content mismatch: ${check.path}`;
    }
  } catch (error) {
    if (error instanceof CheckTimeoutError) {
      status = "inconclusive";
      reason = `${error.message}: ${check.path}`;
    } else if (error instanceof Error && errorCodeOf(error) === "not_found") {
      status = "failed";
      reason = `Required file missing: ${check.path}`;
    } else {
      status = "inconclusive";
      reason = `Verifier unavailable for ${check.path}`;
    }
  }
  return {
    kind: check.kind,
    path: check.path,
    expected_sha256: expected,
    observed_sha256: observed,
    status,
    reason,
    duration_ms: Math.max(0, Date.now() - began),
  };
}

const OUTPUT_TAIL = 600;

/**
 * Runs one protected host check in the sandbox against a disposable copy of
 * the candidate. Every path short of a clean exit 0 is non-passing: a
 * changed definition, a candidate edit to a path the check owns, a missing
 * sandbox, a timeout or a cancellation is `inconclusive` or `failed`.
 */
async function runHostTestCheck(
  host: VerificationHost,
  context: RequestContext,
  candidate: WorkspaceRef,
  check: HostTestCheck,
  patch: { paths: string[] } | null,
  taskId: string,
  captureTail: (
    log: Omit<VerificationCheckLogs["checks"][number], "check_index">,
  ) => void,
): Promise<VerificationCheckResult> {
  const began = Date.now();
  const result = (
    status: VerificationCheckResult["status"],
    reason: string | null,
    extra: Partial<VerificationCheckResult> = {},
  ): VerificationCheckResult => ({
    kind: "host_test",
    path: check.check_id,
    check_id: check.check_id,
    expected_sha256: check.definition_sha256 ?? sha256(JSON.stringify(check)),
    observed_sha256: null,
    status,
    reason: reason?.slice(0, 1024) ?? null,
    duration_ms: Math.max(0, Date.now() - began),
    ...extra,
  });
  const definition = host.checks?.find((entry) => entry.id === check.check_id);
  if (!definition)
    return result(
      "inconclusive",
      `Host check ${check.check_id} is no longer defined`,
    );
  let resolved: Awaited<ReturnType<typeof resolveHostCheck>>;
  try {
    resolved = await resolveHostCheck(definition);
  } catch {
    return result(
      "inconclusive",
      `Host check ${check.check_id} protected files are unreadable`,
    );
  }
  if (check.definition_sha256 && resolved.sha256 !== check.definition_sha256)
    return result(
      "inconclusive",
      `Host check ${check.check_id} changed since launch`,
    );
  const touched = (patch?.paths ?? []).filter((path) =>
    checkOwnsPath(definition, path),
  );
  if (touched.length)
    return result(
      "failed",
      `Candidate changed paths owned by host check ${check.check_id}: ${touched.slice(0, 10).join(", ")}`,
    );
  if (!host.workspace.runCheck)
    return result(
      "inconclusive",
      `Sandbox unavailable for host check ${check.check_id}`,
    );
  const timeoutMs = Math.min(
    check.timeout_ms ?? definition.timeout_ms,
    definition.timeout_ms,
  );
  const controller = new AbortController();
  try {
    const run = await withTimeout(
      host.workspace.runCheck(context, candidate, {
        argv: definition.argv,
        overlay: resolved.overlay,
        exclude: definition.exclude_paths,
        timeoutMs,
        signal: controller.signal,
      }),
      timeoutMs + 5_000,
    );
    const digest = createHash("sha256")
      .update(run.stdout)
      .update(run.stderr)
      .digest("hex");
    const decoder = new TextDecoder();
    const output = [decoder.decode(run.stdout), decoder.decode(run.stderr)]
      .filter(Boolean)
      .join("\n");
    const tail = (
      await host.scrubOutput?.(context, taskId, output).catch(() => "")
    )?.slice(-OUTPUT_TAIL);
    if (tail)
      captureTail({
        output_tail: tail,
        ...(run.output_truncated ? { capture_truncated: true } : {}),
      });
    const extra = {
      exit_code: run.exit_code,
      output_sha256: digest,
      observed_sha256: digest,
    };
    if (run.workspace.revision !== candidate.revision)
      return result(
        "inconclusive",
        "Check ran against another revision",
        extra,
      );
    if (run.timed_out)
      return result(
        "inconclusive",
        `Host check ${check.check_id} timed out after ${timeoutMs} ms`,
        extra,
      );
    if (run.cancelled)
      return result(
        "inconclusive",
        `Host check ${check.check_id} was cancelled`,
        extra,
      );
    if (run.exit_code === 0) return result("passed", null, extra);
    return result(
      "failed",
      `Host check ${check.check_id} exited ${run.exit_code}`,
      extra,
    );
  } catch (error) {
    controller.abort();
    if (error instanceof CheckTimeoutError)
      return result(
        "inconclusive",
        `Host check ${check.check_id} timed out after ${timeoutMs} ms`,
      );
    const code = errorCodeOf(error);
    return result(
      "inconclusive",
      code === "sandbox_unavailable"
        ? `Sandbox unavailable for host check ${check.check_id}`
        : `Verifier unavailable for host check ${check.check_id}`,
    );
  }
}

export async function verificationRecords(
  host: VerificationHost,
  context: RequestContext,
  taskId: string,
  checkLogs?: Map<string, VerificationCheckLogs>,
): Promise<VerificationEvidenceRecord[]> {
  const records: VerificationEvidenceRecord[] = [];
  for await (const event of host.store.events(context, taskId)) {
    if (
      event.event_type !== "tool.completed" ||
      event.producer !== WORKBENCH_PRODUCER
    )
      continue;
    const bytes = await host.store.artifacts.get(context, event.payload);
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      continue;
    }
    if (!payload || typeof payload !== "object") continue;
    const { operation, logs } = payload as {
      operation?: unknown;
      logs?: unknown;
    };
    if (operation === CHECK_LOGS_OPERATION && checkLogs) {
      const parsed = VerificationCheckLogsSchema.safeParse(logs);
      if (parsed.success) {
        checkLogs.set(parsed.data.run_id, parsed.data);
        const firstRunId = checkLogs.keys().next().value;
        if (
          checkLogs.size > MAX_VERIFICATION_RECORDS &&
          firstRunId !== undefined
        )
          checkLogs.delete(firstRunId);
      }
    }
    if (operation !== VERIFICATION_EVIDENCE_OPERATION) continue;
    const parsed = VerificationEvidenceRecordSchema.safeParse(payload);
    if (parsed.success && parsed.data.task_id === taskId)
      records.push(parsed.data);
  }
  return records.slice(-MAX_VERIFICATION_RECORDS);
}
