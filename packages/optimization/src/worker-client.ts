import type {
  Budget,
  PromptScoringBackend,
  RequestContext,
  ScoringRequest,
  ScoringResult,
} from "@mars/contracts";
import { ScoringResultSchema } from "@mars/contracts";
import { candidateId } from "./canonical";
import { OptimizationError } from "./errors";
import {
  defaultWorkerPython,
  OPTIMIZATION_PINS,
  PYTHON_DIR,
  WORKER_MODULE,
  WORKER_SETUP_HINT,
  workerAvailable,
} from "./pins";
import type { ReflectionResponder } from "./reflection";
import { estimateTokens } from "./reflection";
import {
  type HostMessage,
  type StopReason,
  type WorkerMessage,
  WorkerMessageSchema,
  type WorkerStart,
} from "./schemas";

export interface WorkerProcess {
  write(line: string): void;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array> | null;
  readonly exited: Promise<number>;
  kill(): void;
}

export interface WorkerLauncher {
  readonly id: string;
  spawn(): WorkerProcess;
}

const MAX_LINE_BYTES = 4 * 1024 * 1024;
const LOG_TAIL = 200;
/** Worker environment is minimal: it never sees host secrets. */
function workerEnvironment(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? "/tmp",
    LANG: "C.UTF-8",
    PYTHONUNBUFFERED: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONIOENCODING: "utf-8",
  };
}

export function createCommandWorkerLauncher(
  argv: readonly string[],
  options: { cwd?: string; id?: string } = {},
): WorkerLauncher {
  return {
    id: options.id ?? argv.join(" "),
    spawn() {
      const child = Bun.spawn([...argv], {
        cwd: options.cwd ?? PYTHON_DIR,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: workerEnvironment(),
      });
      return {
        write(line) {
          child.stdin.write(line);
          void child.stdin.flush();
        },
        stdout: child.stdout,
        stderr: child.stderr,
        exited: child.exited,
        kill() {
          try {
            child.kill("SIGKILL");
          } catch {}
        },
      };
    },
  };
}

/** Launches `python -m mars_gepa_worker` from the pinned venv; refuses if the venv is missing. */
export function createPythonWorkerLauncher(
  pythonPath = defaultWorkerPython(),
): WorkerLauncher {
  if (!workerAvailable(pythonPath)) {
    throw new OptimizationError("worker_unavailable", WORKER_SETUP_HINT);
  }
  return createCommandWorkerLauncher([pythonPath, "-m", WORKER_MODULE], {
    cwd: PYTHON_DIR,
    id: `python:${pythonPath}`,
  });
}

export interface DoneResult {
  candidates: Record<string, string>[];
  parents: (number | null)[][];
  val_aggregate_scores: number[];
  best_idx: number;
  total_metric_calls: number | null;
}

export interface WorkerUsage {
  metric_calls: number;
  reflection_calls: number;
  cost_usd: number;
  cost_unmeasured_scores: number;
  tokens: number;
  simulated: boolean;
}

export interface RunWorkerOutcome extends WorkerUsage {
  status: "completed" | "stopped" | "cancelled" | "failed";
  stop_reason: StopReason;
  error: string | null;
  result: DoneResult | null;
  worker: {
    gepa_version: string | null;
    python_version: string | null;
    exit_code: number | null;
    log_tail: string[];
  };
}

export interface RunWorkerOptions {
  launcher: WorkerLauncher;
  context: RequestContext;
  start: WorkerStart;
  budget: Budget;
  backend: PromptScoringBackend;
  reflection: ReflectionResponder;
  /** Hard ceiling on scored instances; GEPA gets the softer `start.max_metric_calls`. */
  hardMetricCalls: number;
  maxReflectionTokens: number;
  signal?: AbortSignal;
  now?: () => number;
  /** Resolves candidate identity for a score request so stored records line up. */
  candidateMeta(id: string): {
    parent_candidate_id: string | null;
    created_at: string;
  };
  onScore?(request: ScoringRequest, result: ScoringResult): Promise<void>;
  onCandidate?(event: {
    candidate_idx: number;
    parent_idx: number | null;
    components: Record<string, string>;
    validation_mean_score: number | null;
  }): Promise<void>;
}

async function* lines(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > MAX_LINE_BYTES)
        throw new Error("worker line exceeds 4 MiB");
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        yield buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
      }
    }
    if (buffer.trim()) yield buffer;
  } finally {
    reader.releaseLock();
  }
}

class Semaphore {
  private readonly waiters: (() => void)[] = [];
  private active = 0;
  constructor(private readonly limit: number) {}
  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.waiters.shift()?.();
    };
  }
}

/**
 * Drives one worker run. Every bound (deadline, USD, tokens, metric calls,
 * concurrency, cancel) is enforced here; the worker is untrusted and is killed
 * as soon as a bound is crossed.
 */
export async function runGepaWorker(
  options: RunWorkerOptions,
): Promise<RunWorkerOutcome> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const deadline = startedAt + options.budget.max_duration_ms;
  const usage: WorkerUsage = {
    metric_calls: 0,
    reflection_calls: 0,
    cost_usd: 0,
    cost_unmeasured_scores: 0,
    tokens: 0,
    simulated: options.reflection.simulated,
  };
  const worker: RunWorkerOutcome["worker"] = {
    gepa_version: null,
    python_version: null,
    exit_code: null,
    log_tail: [],
  };
  const log = (message: string) => {
    worker.log_tail.push(message.slice(0, 2000));
    if (worker.log_tail.length > LOG_TAIL) worker.log_tail.shift();
  };

  const state: { reason: StopReason | null } = { reason: null };
  let error: string | null = null;
  let result: DoneResult | null = null;
  const inflight = new AbortController();
  const process = options.launcher.spawn();
  const stop = (reason: StopReason, detail?: string) => {
    if (state.reason !== null) return;
    state.reason = reason;
    if (detail) error = detail;
    inflight.abort(new Error(reason));
    process.kill();
  };
  const timer = setTimeout(
    () => stop("deadline", "max_duration_ms elapsed"),
    Math.max(0, deadline - now()),
  );
  const onAbort = () => stop("cancelled", "cancelled by caller");
  if (options.signal?.aborted) onAbort();
  options.signal?.addEventListener("abort", onAbort, { once: true });

  const send = (message: HostMessage) => {
    if (state.reason !== null) return;
    try {
      process.write(`${JSON.stringify(message)}\n`);
    } catch (cause) {
      stop("protocol_error", `failed to write to worker: ${String(cause)}`);
    }
  };
  const remainingBudget = (): Budget => ({
    max_tokens: Math.max(1, options.budget.max_tokens - usage.tokens),
    max_usd: Math.max(0, options.budget.max_usd - usage.cost_usd),
    max_duration_ms: Math.max(1, deadline - now()),
    max_depth: options.budget.max_depth,
    max_concurrency: options.budget.max_concurrency,
  });
  const allowed = {
    train: new Set(options.start.train.map((item) => item.instance_id)),
    validation: new Set(
      options.start.validation.map((item) => item.instance_id),
    ),
  };
  const scoring = new Semaphore(Math.max(1, options.budget.max_concurrency));
  const pending = new Set<Promise<void>>();
  const track = (task: Promise<void>) => {
    pending.add(task);
    void task.finally(() => pending.delete(task));
  };

  const handleScore = async (
    message: Extract<WorkerMessage, { type: "score" }>,
  ) => {
    const release = await scoring.acquire();
    try {
      if (state.reason !== null) return;
      const { request } = message;
      const permitted = allowed[request.split];
      const foreign = request.instance_ids.filter((id) => !permitted.has(id));
      if (foreign.length) {
        stop(
          "protocol_error",
          `worker requested instances outside ${request.split}: ${foreign.slice(0, 5).join(", ")}`,
        );
        return;
      }
      if (
        usage.metric_calls + request.instance_ids.length >
        options.hardMetricCalls
      ) {
        stop(
          "metric_calls",
          `hard metric-call ceiling ${options.hardMetricCalls} reached`,
        );
        return;
      }
      const id = candidateId(request.candidate.components);
      const meta = options.candidateMeta(id);
      const hostRequest: ScoringRequest = {
        candidate: {
          candidate_id: id,
          components: request.candidate.components,
          parent_candidate_id: meta.parent_candidate_id,
          created_at: meta.created_at,
        },
        split: request.split,
        instance_ids: [...request.instance_ids],
        repeats: options.start.repeats,
        budget: remainingBudget(),
      };
      if (hostRequest.budget.max_usd <= 0 && options.budget.max_usd > 0) {
        stop("budget_usd", "max_usd exhausted before scoring");
        return;
      }
      let scored: ScoringResult;
      try {
        scored = ScoringResultSchema.parse(
          await options.backend.score(options.context, hostRequest),
        );
      } catch (cause) {
        stop(
          "backend_error",
          `scoring backend failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
        return;
      }
      const returned = new Set(scored.scores.map((score) => score.instance_id));
      if (
        scored.split !== request.split ||
        hostRequest.instance_ids.some((id) => !returned.has(id))
      ) {
        stop("backend_error", "scoring backend returned an incomplete result");
        return;
      }
      usage.metric_calls += hostRequest.instance_ids.length;
      if (scored.cost_usd === null) usage.cost_unmeasured_scores += 1;
      else usage.cost_usd += scored.cost_usd;
      usage.simulated ||= scored.simulated;
      await options.onScore?.(hostRequest, scored);
      if (state.reason !== null) return;
      send({ type: "score_result", id: message.id, result: scored });
      if (
        options.budget.max_usd > 0 &&
        usage.cost_usd >= options.budget.max_usd
      ) {
        stop(
          "budget_usd",
          `cost ${usage.cost_usd.toFixed(6)} reached max_usd ${options.budget.max_usd}`,
        );
      }
    } finally {
      release();
    }
  };

  const handleReflect = async (
    message: Extract<WorkerMessage, { type: "reflect" }>,
  ) => {
    if (state.reason !== null) return;
    const inputTokens = estimateTokens(message.prompt);
    const remainingTokens = options.budget.max_tokens - usage.tokens;
    if (remainingTokens <= inputTokens) {
      stop("budget_tokens", "max_tokens exhausted before reflection");
      return;
    }
    const maxTokens = Math.min(
      options.maxReflectionTokens,
      remainingTokens - inputTokens,
    );
    const worstCase = options.reflection.estimateCostUsd(
      inputTokens,
      maxTokens,
    );
    if (
      worstCase !== null &&
      usage.cost_usd + worstCase > options.budget.max_usd
    ) {
      stop("budget_usd", "reflection would exceed max_usd");
      return;
    }
    let reply: Awaited<ReturnType<ReflectionResponder["complete"]>>;
    try {
      reply = await options.reflection.complete({
        prompt: message.prompt,
        maxTokens,
        timeoutMs: Math.max(1, deadline - now()),
        signal: inflight.signal,
      });
    } catch (cause) {
      if (state.reason === null)
        stop(
          "worker_error",
          `reflection failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      return;
    }
    usage.reflection_calls += 1;
    usage.tokens += reply.input_tokens + reply.output_tokens;
    if (reply.cost_usd === null) usage.cost_unmeasured_scores += 0;
    else usage.cost_usd += reply.cost_usd;
    if (options.budget.max_usd > 0 && usage.cost_usd > options.budget.max_usd) {
      stop(
        "budget_usd",
        `reflection cost pushed total to ${usage.cost_usd.toFixed(6)}`,
      );
      return;
    }
    if (usage.tokens >= options.budget.max_tokens) {
      stop("budget_tokens", "max_tokens reached");
      return;
    }
    send({ type: "reflect_result", id: message.id, text: reply.text });
  };

  const stderrDrain = process.stderr
    ? (async () => {
        for await (const line of lines(
          process.stderr as ReadableStream<Uint8Array>,
        )) {
          if (line.trim()) log(`stderr: ${line}`);
        }
      })().catch(() => undefined)
    : Promise.resolve();

  send(options.start);
  try {
    for await (const line of lines(process.stdout)) {
      if (state.reason !== null) break;
      if (!line.trim()) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        stop(
          "protocol_error",
          `worker emitted non-JSON output: ${line.slice(0, 200)}`,
        );
        break;
      }
      const parsed = WorkerMessageSchema.safeParse(raw);
      if (!parsed.success) {
        stop(
          "protocol_error",
          `worker emitted an unknown message: ${line.slice(0, 200)}`,
        );
        break;
      }
      const message = parsed.data;
      switch (message.type) {
        case "ready":
          worker.gepa_version = message.gepa_version;
          worker.python_version = message.python_version;
          if (
            message.gepa_version !== OPTIMIZATION_PINS.gepa_version ||
            !message.python_version.startsWith(
              `${OPTIMIZATION_PINS.python_version_prefix}.`,
            )
          ) {
            stop(
              "pin_mismatch",
              `worker reported gepa ${message.gepa_version} / python ${message.python_version}`,
            );
          }
          break;
        case "score":
          track(handleScore(message));
          break;
        case "reflect":
          track(handleReflect(message));
          break;
        case "candidate":
          await options.onCandidate?.(message);
          break;
        case "log":
          log(message.message);
          break;
        case "done":
          result = message.result;
          break;
        case "error":
          if (message.code === "pin_mismatch")
            stop("pin_mismatch", message.message);
          else if (message.code === "protocol_error")
            stop("protocol_error", message.message);
          else stop("worker_error", message.message);
          break;
      }
      if (result) break;
    }
  } catch (cause) {
    stop(
      "protocol_error",
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  await Promise.allSettled([...pending]);
  if (result && state.reason === null) {
    state.reason = "finished";
  } else if (state.reason === null) {
    state.reason = "protocol_error";
    error = error ?? "worker exited without a done message";
  }
  process.kill();
  clearTimeout(timer);
  options.signal?.removeEventListener("abort", onAbort);
  worker.exit_code = await Promise.race([
    process.exited,
    new Promise<number | null>((resolve) =>
      setTimeout(() => resolve(null), 5000),
    ),
  ]);
  await Promise.race([
    stderrDrain,
    new Promise((resolve) => setTimeout(resolve, 1000)),
  ]);

  const finalReason: StopReason = state.reason ?? "protocol_error";
  const status: RunWorkerOutcome["status"] =
    finalReason === "finished"
      ? "completed"
      : finalReason === "cancelled"
        ? "cancelled"
        : ["deadline", "budget_usd", "budget_tokens", "metric_calls"].includes(
              finalReason,
            )
          ? "stopped"
          : "failed";
  return { ...usage, status, stop_reason: finalReason, error, result, worker };
}
