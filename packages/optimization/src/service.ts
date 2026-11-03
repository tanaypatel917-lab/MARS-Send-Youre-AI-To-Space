import { randomUUID } from "node:crypto";
import type {
  ArtifactRef,
  Budget,
  JobResult,
  OptimizationService,
  PromptCandidate,
  PromptScoringBackend,
  RequestContext,
  ScoringRequest,
  ScoringResult,
} from "@mars/contracts";
import {
  BudgetSchema,
  ScoringRequestSchema,
  ScoringResultSchema,
} from "@mars/contracts";
import { z } from "zod";
import { candidateId, canonicalJson, sha256 } from "./canonical";
import { OptimizationError } from "./errors";
import { OPTIMIZATION_PINS } from "./pins";
import type { ReflectionResponder } from "./reflection";
import {
  CANDIDATE_SCHEMA,
  type CandidateRecord,
  type CandidateStatus,
  canTransitionCandidate,
  type EvaluateRequest,
  EvaluateRequestSchema,
  type HoldoutRecord,
  type JobRecord,
  PROPOSAL_REPORT_SCHEMA,
  PromptTargetRegistrationSchema,
  type ProposalReport,
  ProposalReportSchema,
  type ProposalRequest,
  ProposalRequestSchema,
  type Recommendation,
  RequestContextSchema,
  type ScoreProvenance,
  type StopReason,
  type StoredTarget,
  TARGET_SCHEMA,
  type WorkerStart,
} from "./schemas";
import { scrubSecrets } from "./scrub";
import { splitInstances } from "./split";

const StoredScoreSchema = z
  .object({ request: ScoringRequestSchema, result: ScoringResultSchema })
  .strict();

import {
  type ArtifactStore,
  createFileArtifactStore,
  OptimizationStore,
} from "./store";
import {
  createPythonWorkerLauncher,
  type RunWorkerOutcome,
  runGepaWorker,
  type WorkerLauncher,
} from "./worker-client";

const JSON_MEDIA = "application/json";
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;

export interface OptimizationServiceOptions {
  /** Absolute directory for targets, candidates, jobs and (by default) artifacts. */
  rootDir: string;
  /** The only source of scores. Built by `@mars/evaluation` in production; a fixture in tests. */
  backend: PromptScoringBackend;
  backendId: string;
  /** Answers GEPA reflection prompts; may vary per proposal manifest (model choice, consent). */
  reflection:
    | ReflectionResponder
    | ((manifest: ProposalRequest) => ReflectionResponder);
  launcher?: WorkerLauncher;
  artifacts?: ArtifactStore;
  now?: () => number;
  maxFeedbackChars?: number;
  maxRecordsPerComponent?: number;
}

export interface CandidateDecision {
  status: Extract<CandidateStatus, "accepted" | "rejected" | "archived">;
  reason: string;
}

/** Contract surface plus the inspection and lifecycle methods the host needs. */
export interface PromptOptimizationService extends OptimizationService {
  inspect(context: RequestContext, jobId: string): Promise<JobResult>;
  cancel(context: RequestContext, jobId: string): Promise<void>;
  job(context: RequestContext, jobId: string): Promise<JobRecord>;
  waitForJob(context: RequestContext, jobId: string): Promise<JobRecord>;
  target(context: RequestContext, targetId: string): Promise<StoredTarget>;
  candidates(
    context: RequestContext,
    targetId: string,
  ): Promise<CandidateRecord[]>;
  /**
   * Explicit, human-driven lifecycle step. Accepting a candidate records a
   * decision; it never changes any live prompt.
   */
  decide(
    context: RequestContext,
    targetId: string,
    candidateId: string,
    decision: CandidateDecision,
  ): Promise<CandidateRecord>;
  /** Only reader of the final holdout, for the evaluation service's final report. */
  finalHoldoutInstances(
    context: RequestContext,
    targetId: string,
  ): Promise<string[]>;
  report(context: RequestContext, jobId: string): Promise<ProposalReport>;
}

interface RunningJob {
  abort: AbortController;
  done: Promise<void>;
}

function isoNow(now: () => number): string {
  return new Date(now()).toISOString();
}

function jobResultStatus(job: JobRecord): JobResult["status"] {
  return job.status;
}

export function createOptimizationService(
  options: OptimizationServiceOptions,
): PromptOptimizationService {
  const now = options.now ?? Date.now;
  const store = new OptimizationStore(options.rootDir);
  const artifacts =
    options.artifacts ?? createFileArtifactStore(options.rootDir);
  const running = new Map<string, RunningJob>();
  const maxFeedbackChars = options.maxFeedbackChars ?? 1500;
  const maxRecords = options.maxRecordsPerComponent ?? 6;
  let launcher: WorkerLauncher | undefined = options.launcher;
  const resolveLauncher = () => {
    launcher ??= createPythonWorkerLauncher();
    return launcher;
  };
  const resolveReflection = (manifest: ProposalRequest) =>
    typeof options.reflection === "function"
      ? options.reflection(manifest)
      : options.reflection;

  const checkContext = (context: RequestContext) => {
    if (!RequestContextSchema.safeParse(context).success)
      throw new OptimizationError("invalid_input", "request_context");
  };

  async function loadJson<T>(
    context: RequestContext,
    ref: ArtifactRef,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  ): Promise<T> {
    if (ref.media_type !== JSON_MEDIA || ref.byte_length > MAX_ARTIFACT_BYTES)
      throw new OptimizationError("artifact_malformed", ref.artifact_id);
    const bytes = await artifacts.get(context, ref);
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new OptimizationError("artifact_malformed", ref.artifact_id);
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success)
      throw new OptimizationError(
        "artifact_malformed",
        `${ref.artifact_id}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
      );
    return parsed.data;
  }

  const putJson = (context: RequestContext, value: unknown) =>
    artifacts.put(
      context,
      new TextEncoder().encode(canonicalJson(value)),
      JSON_MEDIA,
    );

  async function upsertCandidate(
    context: RequestContext,
    targetId: string,
    components: Record<string, string>,
    origin: CandidateRecord["origin"],
    jobId: string | null,
    parent: string | null,
  ): Promise<CandidateRecord> {
    const id = candidateId(components);
    try {
      const existing = await store.readCandidate(context, targetId, id);
      if (
        existing.candidate.parent_candidate_id === null &&
        parent !== null &&
        existing.origin !== "seed"
      ) {
        existing.candidate.parent_candidate_id = parent;
        existing.updated_at = isoNow(now);
        await store.writeCandidate(context, existing);
      }
      return existing;
    } catch (error) {
      if (
        !(error instanceof OptimizationError) ||
        error.code !== "candidate_not_found"
      )
        throw error;
    }
    const at = isoNow(now);
    const record: CandidateRecord = {
      schema: CANDIDATE_SCHEMA,
      target_id: targetId,
      candidate: {
        candidate_id: id,
        components,
        parent_candidate_id: parent,
        created_at: at,
      },
      origin,
      status: "draft",
      job_id: jobId,
      scores: [],
      history: [
        {
          from: null,
          to: "draft",
          at,
          reason: `created by ${origin === "seed" ? "registration" : (jobId ?? "submission")}`,
        },
      ],
      updated_at: at,
    };
    await store.writeCandidate(context, record);
    return record;
  }

  async function transition(
    context: RequestContext,
    record: CandidateRecord,
    to: CandidateStatus,
    reason: string,
  ): Promise<CandidateRecord> {
    if (!canTransitionCandidate(record.status, to))
      throw new OptimizationError(
        "invalid_transition",
        `${record.status} -> ${to}`,
      );
    const at = isoNow(now);
    record.history.push({
      from: record.status,
      to,
      at,
      reason: reason.slice(0, 500),
    });
    record.status = to;
    record.updated_at = at;
    await store.writeCandidate(context, record);
    return record;
  }

  async function recordScore(
    context: RequestContext,
    targetId: string,
    jobId: string,
    request: ScoringRequest,
    result: ScoringResult,
  ): Promise<ScoreProvenance> {
    const scrubbed: ScoringResult = {
      ...result,
      scores: result.scores.map((score) => ({
        ...score,
        feedback: scrubSecrets(score.feedback),
        error: score.error === null ? null : scrubSecrets(score.error),
      })),
    };
    const ref = await putJson(context, { request, result: scrubbed });
    const provenance: ScoreProvenance = {
      job_id: jobId,
      split: result.split,
      backend_id: options.backendId,
      request_sha256: result.request_sha256,
      host_request_sha256: sha256(canonicalJson(request)),
      result: ref,
      mean_score: result.mean_score,
      cost_usd: result.cost_usd,
      runtime_ms: result.runtime_ms,
      simulated: result.simulated,
      instance_count: request.instance_ids.length,
      recorded_at: isoNow(now),
    };
    const record = await upsertCandidate(
      context,
      targetId,
      request.candidate.components,
      "proposed",
      jobId,
      request.candidate.parent_candidate_id,
    );
    record.scores.push(provenance);
    record.updated_at = provenance.recorded_at;
    await store.writeCandidate(context, record);
    return provenance;
  }

  async function finishJob(
    context: RequestContext,
    job: JobRecord,
    outcome: RunWorkerOutcome | null,
    status: JobRecord["status"],
    stopReason: StopReason | null,
    error: string | null,
  ): Promise<void> {
    job.status = status;
    job.stop_reason = stopReason;
    job.error = error;
    job.finished_at = isoNow(now);
    if (outcome) {
      job.metric_calls = outcome.metric_calls;
      job.reflection_calls = outcome.reflection_calls;
      job.cost_usd = outcome.cost_usd;
      job.cost_unmeasured_scores = outcome.cost_unmeasured_scores;
      job.tokens = outcome.tokens;
      job.simulated = outcome.simulated;
      job.worker = outcome.worker;
    }
    await store.writeJob(context, job);
  }

  function latestValidation(
    record: CandidateRecord,
    jobId?: string,
  ): ScoreProvenance | null {
    const validation = record.scores.filter(
      (score) =>
        score.split === "validation" &&
        (jobId === undefined || score.job_id === jobId),
    );
    return validation.at(-1) ?? null;
  }

  /** Latest validation score for a record in this job; the seed may fall back to an earlier job's baseline. */
  function jobValidation(
    record: CandidateRecord,
    job: JobRecord,
  ): ScoreProvenance | null {
    const own = latestValidation(record, job.job_id);
    if (own || record.candidate.candidate_id !== job.seed_candidate_id)
      return own;
    return latestValidation(record);
  }

  async function bestCandidateId(
    context: RequestContext,
    job: JobRecord,
  ): Promise<string | null> {
    const records = await store.listCandidates(context, job.target_id);
    let best: { id: string; mean: number } | null = null;
    for (const record of records) {
      const score = jobValidation(record, job);
      if (!score) continue;
      const isSeed = record.candidate.candidate_id === job.seed_candidate_id;
      if (
        !best ||
        score.mean_score > best.mean ||
        (score.mean_score === best.mean && isSeed)
      ) {
        best = { id: record.candidate.candidate_id, mean: score.mean_score };
      }
    }
    return best?.id ?? null;
  }

  async function runPropose(
    context: RequestContext,
    job: JobRecord,
    target: StoredTarget,
    manifest: ProposalRequest,
    abort: AbortController,
  ): Promise<void> {
    job.status = "running";
    job.started_at = isoNow(now);
    await store.writeJob(context, job);
    let launcherInstance: WorkerLauncher;
    try {
      launcherInstance = resolveLauncher();
    } catch (error) {
      await finishJob(
        context,
        job,
        null,
        "failed",
        "worker_error",
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
    const reflection = resolveReflection(manifest);
    job.reflection_responder_id = reflection.id;
    const caps = [manifest.max_metric_calls];
    if (
      manifest.estimated_usd_per_metric_call &&
      manifest.estimated_usd_per_metric_call > 0
    )
      caps.push(
        Math.floor(job.budget.max_usd / manifest.estimated_usd_per_metric_call),
      );
    if (manifest.estimated_ms_per_metric_call)
      caps.push(
        Math.floor(
          job.budget.max_duration_ms / manifest.estimated_ms_per_metric_call,
        ),
      );
    const cap = Math.min(...caps);
    if (cap < target.split.validation.length) {
      await finishJob(
        context,
        job,
        null,
        "failed",
        "metric_calls",
        `budget allows ${cap} metric calls but the seed validation alone needs ${target.split.validation.length}`,
      );
      return;
    }
    const summaries = new Map(
      target.instances.map((item) => [item.instance_id, item.summary]),
    );
    const instancesFor = (ids: string[], split: "train" | "validation") =>
      ids.map((instance_id) => ({
        instance_id,
        split,
        summary: scrubSecrets(summaries.get(instance_id) ?? ""),
      }));
    const start: WorkerStart = {
      type: "start",
      expected: {
        gepa_version: OPTIMIZATION_PINS.gepa_version,
        python_version_prefix: OPTIMIZATION_PINS.python_version_prefix,
      },
      seed_candidate: target.components,
      train: instancesFor(target.split.train, "train"),
      validation: instancesFor(target.split.validation, "validation"),
      max_metric_calls: cap,
      reflection_minibatch_size: Math.min(
        manifest.reflection_minibatch_size,
        target.split.train.length,
      ),
      seed: manifest.seed,
      repeats: manifest.repeats,
      budget: job.budget,
      max_feedback_chars: maxFeedbackChars,
      max_records_per_component: maxRecords,
    };
    const idByIdx = new Map<number, string>([[0, job.seed_candidate_id]]);
    const parentById = new Map<string, string | null>();
    const createdAt = new Map<string, string>();
    const outcome = await runGepaWorker({
      launcher: launcherInstance,
      context,
      start,
      budget: job.budget,
      backend: options.backend,
      reflection,
      hardMetricCalls:
        cap + target.split.validation.length + start.reflection_minibatch_size,
      maxReflectionTokens: manifest.max_reflection_tokens,
      estimatedUsdPerMetricCall: manifest.estimated_usd_per_metric_call,
      signal: abort.signal,
      now,
      candidateMeta(id) {
        if (id === job.seed_candidate_id)
          return {
            parent_candidate_id: null,
            created_at: target.registered_at,
          };
        let at = createdAt.get(id);
        if (!at) {
          at = isoNow(now);
          createdAt.set(id, at);
        }
        return {
          parent_candidate_id: parentById.get(id) ?? null,
          created_at: at,
        };
      },
      async onScore(request, result) {
        await recordScore(
          context,
          target.target_id,
          job.job_id,
          request,
          result,
        );
        if (!job.candidate_ids.includes(request.candidate.candidate_id)) {
          job.candidate_ids.push(request.candidate.candidate_id);
          job.metric_calls += request.instance_ids.length;
          await store.writeJob(context, job);
        }
      },
      async onCandidate(event) {
        const id = candidateId(event.components);
        idByIdx.set(event.candidate_idx, id);
        const parent =
          event.parent_idx === null
            ? null
            : (idByIdx.get(event.parent_idx) ?? null);
        parentById.set(id, parent);
        await upsertCandidate(
          context,
          target.target_id,
          event.components,
          event.candidate_idx === 0 ? "seed" : "proposed",
          job.job_id,
          parent,
        );
      },
    });
    const records = await store.listCandidates(context, target.target_id);
    for (const record of records) {
      if (
        record.origin === "proposed" &&
        record.status === "draft" &&
        record.job_id === job.job_id &&
        latestValidation(record, job.job_id)
      ) {
        await transition(
          context,
          record,
          "proposed",
          `validation-scored by job ${job.job_id}`,
        );
      }
    }
    job.best_candidate_id = await bestCandidateId(context, job);
    const seedScored = records.some(
      (record) =>
        record.candidate.candidate_id === job.seed_candidate_id &&
        latestValidation(record, job.job_id),
    );
    if (outcome.status === "completed") {
      await finishJob(context, job, outcome, "completed", "finished", null);
    } else if (outcome.status === "cancelled") {
      await finishJob(
        context,
        job,
        outcome,
        "cancelled",
        "cancelled",
        outcome.error,
      );
    } else if (outcome.status === "stopped" && seedScored) {
      await finishJob(
        context,
        job,
        outcome,
        "completed",
        outcome.stop_reason,
        outcome.error,
      );
    } else {
      await finishJob(
        context,
        job,
        outcome,
        "failed",
        outcome.stop_reason,
        outcome.error,
      );
    }
  }

  class EvaluateStop extends Error {
    constructor(
      readonly reason: StopReason,
      message: string,
    ) {
      super(message);
    }
  }

  /**
   * Scores one candidate on the validation split with the budget gated before
   * the call (worst-case USD when an estimate is known), a hard deadline, and
   * cancellation; a stalled or late backend result is abandoned, not recorded.
   */
  async function scoreValidation(
    context: RequestContext,
    job: JobRecord,
    target: StoredTarget,
    candidate: PromptCandidate,
    request: EvaluateRequest,
    startedAt: number,
    abort: AbortController,
  ): Promise<ScoringResult> {
    const count = target.split.validation.length;
    const remainingUsd = job.budget.max_usd - job.cost_usd;
    const remainingMs = job.budget.max_duration_ms - (now() - startedAt);
    if (abort.signal.aborted)
      throw new EvaluateStop("cancelled", "cancelled by caller");
    if (remainingMs <= 0)
      throw new EvaluateStop("deadline", "max_duration_ms elapsed");
    if (job.budget.max_usd > 0) {
      const estimate = request.estimated_usd_per_metric_call;
      const worstCase = estimate === null ? null : estimate * count;
      if (remainingUsd <= 0 || (worstCase !== null && worstCase > remainingUsd))
        throw new EvaluateStop(
          "budget_usd",
          `scoring ${count} validation instance(s) would exceed the remaining ${remainingUsd.toFixed(6)} USD`,
        );
    }
    const scoringRequest: ScoringRequest = {
      candidate,
      split: "validation",
      instance_ids: [...target.split.validation],
      repeats: request.repeats,
      budget: {
        ...job.budget,
        max_usd: Math.max(0, remainingUsd),
        max_duration_ms: Math.max(1, remainingMs),
      },
    };
    const result = await new Promise<ScoringResult>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new EvaluateStop(
              "deadline",
              "max_duration_ms elapsed during scoring",
            ),
          ),
        remainingMs,
      );
      const onAbort = () =>
        reject(new EvaluateStop("cancelled", "cancelled during scoring"));
      abort.signal.addEventListener("abort", onAbort, { once: true });
      options.backend
        .score(context, scoringRequest)
        .then(
          (value) => resolve(ScoringResultSchema.parse(value)),
          (cause) => reject(cause),
        )
        .finally(() => {
          clearTimeout(timer);
          abort.signal.removeEventListener("abort", onAbort);
        });
    });
    if (abort.signal.aborted)
      throw new EvaluateStop("cancelled", "cancelled during scoring");
    await recordScore(
      context,
      target.target_id,
      job.job_id,
      scoringRequest,
      result,
    );
    job.metric_calls += count;
    if (result.cost_usd === null) job.cost_unmeasured_scores += 1;
    else job.cost_usd += result.cost_usd;
    job.simulated ||= result.simulated;
    return result;
  }

  async function runEvaluate(
    context: RequestContext,
    job: JobRecord,
    target: StoredTarget,
    request: EvaluateRequest,
    abort: AbortController,
  ): Promise<void> {
    job.status = "running";
    job.started_at = isoNow(now);
    await store.writeJob(context, job);
    const startedAt = now();
    try {
      const seed = await store.readCandidate(
        context,
        target.target_id,
        job.seed_candidate_id,
      );
      if (!latestValidation(seed))
        await scoreValidation(
          context,
          job,
          target,
          seed.candidate,
          request,
          startedAt,
          abort,
        );
      const record = await store.readCandidate(
        context,
        target.target_id,
        request.candidate.candidate_id,
      );
      await scoreValidation(
        context,
        job,
        target,
        record.candidate,
        request,
        startedAt,
        abort,
      );
      const refreshed = await store.readCandidate(
        context,
        target.target_id,
        record.candidate.candidate_id,
      );
      if (refreshed.status === "draft" && refreshed.origin !== "seed")
        await transition(
          context,
          refreshed,
          "proposed",
          `validation-scored by job ${job.job_id}`,
        );
      if (abort.signal.aborted)
        throw new EvaluateStop("cancelled", "cancelled before completion");
      job.best_candidate_id = await bestCandidateId(context, job);
      const stop: StopReason =
        job.budget.max_usd > 0 && job.cost_usd > job.budget.max_usd
          ? "budget_usd"
          : "finished";
      await finishJob(context, job, null, "completed", stop, null);
    } catch (error) {
      if (error instanceof EvaluateStop) {
        await finishJob(
          context,
          job,
          null,
          error.reason === "cancelled" ? "cancelled" : "failed",
          error.reason,
          error.message,
        );
        return;
      }
      await finishJob(
        context,
        job,
        null,
        abort.signal.aborted ? "cancelled" : "failed",
        abort.signal.aborted ? "cancelled" : "backend_error",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  function launch(
    context: RequestContext,
    job: JobRecord,
    body: (abort: AbortController) => Promise<void>,
  ): void {
    const abort = new AbortController();
    const done = body(abort)
      .catch(async (error) => {
        await finishJob(
          context,
          job,
          null,
          "failed",
          "worker_error",
          error instanceof Error ? error.message : String(error),
        ).catch(() => undefined);
      })
      .finally(() => running.delete(job.job_id));
    running.set(job.job_id, { abort, done });
  }

  function newJob(
    context: RequestContext,
    kind: JobRecord["kind"],
    target: StoredTarget,
    manifest: ArtifactRef,
    budget: Budget,
  ): JobRecord {
    void context;
    return {
      schema: "mars.optimization-job/v1",
      job_id: `job-${randomUUID()}`,
      kind,
      target_id: target.target_id,
      input_manifest: manifest,
      budget,
      status: "pending",
      stop_reason: null,
      error: null,
      seed_candidate_id: target.seed_candidate_id,
      candidate_ids: [],
      best_candidate_id: null,
      metric_calls: 0,
      reflection_calls: 0,
      cost_usd: 0,
      cost_unmeasured_scores: 0,
      tokens: 0,
      simulated: false,
      scoring_backend_id: options.backendId,
      reflection_responder_id: null,
      worker: {
        gepa_version: null,
        python_version: null,
        exit_code: null,
        log_tail: [],
      },
      started_at: null,
      finished_at: null,
      created_at: isoNow(now),
      report: null,
    };
  }

  async function buildReport(
    context: RequestContext,
    job: JobRecord,
  ): Promise<ProposalReport> {
    const target = await store.readTarget(context, job.target_id);
    const records = await store.listCandidates(context, job.target_id);
    const byId = new Map(
      records.map((record) => [record.candidate.candidate_id, record]),
    );
    const seed = byId.get(job.seed_candidate_id);
    if (!seed)
      throw new OptimizationError("candidate_not_found", job.seed_candidate_id);
    const best =
      (job.best_candidate_id ? byId.get(job.best_candidate_id) : undefined) ??
      seed;
    const seedScore = jobValidation(seed, job);
    const bestScore = jobValidation(best, job);
    const view = (record: CandidateRecord, score: ScoreProvenance | null) => ({
      candidate: record.candidate,
      status: record.status,
      validation_mean_score: score?.mean_score ?? null,
      validation: score,
    });
    const perInstance = async (score: ScoreProvenance | null) => {
      const map = new Map<string, number>();
      if (!score) return map;
      const stored = await loadJson(context, score.result, StoredScoreSchema);
      for (const item of stored.result.scores)
        map.set(item.instance_id, item.score);
      return map;
    };
    const [seedMap, bestMap] = await Promise.all([
      perInstance(seedScore),
      perInstance(bestScore),
    ]);
    const per_instance_deltas = target.split.validation.map((instance_id) => {
      const seed_score = seedMap.get(instance_id) ?? null;
      const best_score = bestMap.get(instance_id) ?? null;
      return {
        instance_id,
        seed_score,
        best_score,
        delta:
          seed_score === null || best_score === null
            ? null
            : Math.max(-1, Math.min(1, best_score - seed_score)),
      };
    });
    const improved =
      best.candidate.candidate_id !== seed.candidate.candidate_id &&
      seedScore !== null &&
      bestScore !== null &&
      bestScore.mean_score > seedScore.mean_score;
    const recommendation: Recommendation = improved
      ? "candidate_improved_validation"
      : "no_improvement";
    const jobRecords = records.filter(
      (record) =>
        record.candidate.candidate_id === seed.candidate.candidate_id ||
        record.scores.some((s) => s.job_id === job.job_id),
    );
    const provenance = jobRecords.flatMap((record) =>
      record.scores.filter((s) => s.job_id === job.job_id),
    );
    const simulated = job.simulated || provenance.some((s) => s.simulated);
    const limitations: string[] = [
      "Nothing is promoted by this report; a human or the evaluation service must decide, and the final holdout has not been scored here.",
      `Validation set has ${target.split.validation.length} instance(s); small differences may be noise.`,
    ];
    if (simulated)
      limitations.push(
        "SIMULATED: at least one score or reflection came from a fixture, not a live model or benchmark.",
      );
    if (job.stop_reason && job.stop_reason !== "finished")
      limitations.push(
        `The run stopped early: ${job.stop_reason}${job.error ? ` (${job.error})` : ""}.`,
      );
    if (job.cost_unmeasured_scores > 0)
      limitations.push(
        `${job.cost_unmeasured_scores} scoring result(s) reported no cost; cost_usd is a lower bound.`,
      );
    if (seedScore === null)
      limitations.push(
        "The seed candidate has no validation score; no comparison is possible.",
      );
    if (seedScore && seedScore.job_id !== job.job_id)
      limitations.push(
        `Seed validation score comes from earlier job ${seedScore.job_id}.`,
      );
    const runtime_ms =
      job.started_at && job.finished_at
        ? Math.max(0, Date.parse(job.finished_at) - Date.parse(job.started_at))
        : 0;
    const report: ProposalReport = {
      schema: PROPOSAL_REPORT_SCHEMA,
      report_id: `report-${job.job_id.replace(/^job-/, "")}`,
      job_id: job.job_id,
      job_kind: job.kind,
      target_id: job.target_id,
      scope: {
        owner_id: context.scope.owner_id,
        project_id: context.scope.project_id,
      },
      recommendation,
      promotion: "none_automatic",
      seed: view(seed, seedScore),
      best: view(best, bestScore),
      per_instance_deltas,
      validation_instance_ids: [...target.split.validation],
      candidates_total: jobRecords.length,
      candidates: jobRecords.map((record) =>
        view(record, latestValidation(record, job.job_id)),
      ),
      metric_calls: job.metric_calls,
      reflection_calls: job.reflection_calls,
      cost_usd: job.cost_usd,
      cost_unmeasured_scores: job.cost_unmeasured_scores,
      runtime_ms,
      stop_reason: job.stop_reason,
      simulated,
      score_provenance: provenance,
      limitations,
      pins: {
        gepa_version: OPTIMIZATION_PINS.gepa_version,
        gepa_source_revision: OPTIMIZATION_PINS.gepa_source_revision,
        python_version_prefix: OPTIMIZATION_PINS.python_version_prefix,
        worker_gepa_version: job.worker.gepa_version,
        worker_python_version: job.worker.python_version,
      },
      produced_at: isoNow(now),
    };
    return ProposalReportSchema.parse(report);
  }

  const service: PromptOptimizationService = {
    async registerTarget(context, ref) {
      checkContext(context);
      const registration = await loadJson(
        context,
        ref,
        PromptTargetRegistrationSchema,
      );
      if (await store.hasTarget(context, registration.target_id)) {
        const existing = await store.readTarget(
          context,
          registration.target_id,
        );
        if (existing.registration_sha256 === ref.sha256)
          return existing.target_id;
        throw new OptimizationError("target_exists", registration.target_id);
      }
      let split: ReturnType<typeof splitInstances>;
      try {
        split = splitInstances(
          registration.instances.map((item) => item.instance_id),
          registration.split,
        );
      } catch (cause) {
        throw new OptimizationError(
          "invalid_input",
          cause instanceof Error ? cause.message : "split_failed",
        );
      }
      const split_sha256 = sha256(canonicalJson(split));
      const seedId = candidateId(registration.components);
      const target: StoredTarget = {
        schema: TARGET_SCHEMA,
        target_id: registration.target_id,
        description: registration.description,
        components: registration.components,
        instances: registration.instances.filter(
          (item) => !split.final_holdout.includes(item.instance_id),
        ),
        split_policy: registration.split,
        split: { train: split.train, validation: split.validation },
        split_sha256,
        seed_candidate_id: seedId,
        registration_sha256: ref.sha256,
        registered_at: isoNow(now),
      };
      const holdout: HoldoutRecord = {
        schema: "mars.optimization-final-holdout/v1",
        target_id: registration.target_id,
        final_holdout: split.final_holdout,
        split_sha256,
        note: "Final holdout. Never sent to the optimisation worker; read only through finalHoldoutInstances for the final evaluation report.",
      };
      await store.writeTarget(context, target, holdout);
      await upsertCandidate(
        context,
        target.target_id,
        registration.components,
        "seed",
        null,
        null,
      );
      return target.target_id;
    },

    async propose(context, targetId, manifestRef, budget) {
      checkContext(context);
      const parsedBudget = BudgetSchema.parse(budget);
      const target = await store.readTarget(context, targetId);
      const manifest = await loadJson(
        context,
        manifestRef,
        ProposalRequestSchema,
      );
      const job = newJob(context, "propose", target, manifestRef, parsedBudget);
      await store.writeJob(context, job);
      launch(context, job, (abort) =>
        runPropose(context, job, target, manifest, abort),
      );
      return { job_id: job.job_id, input_manifest: manifestRef };
    },

    async evaluate(context, candidateRef) {
      checkContext(context);
      const request = await loadJson(
        context,
        candidateRef,
        EvaluateRequestSchema,
      );
      const target = await store.readTarget(context, request.target_id);
      if (
        candidateId(request.candidate.components) !==
        request.candidate.candidate_id
      )
        throw new OptimizationError(
          "invalid_input",
          "candidate_id does not match its components",
        );
      const job = newJob(
        context,
        "evaluate",
        target,
        candidateRef,
        request.budget,
      );
      await upsertCandidate(
        context,
        target.target_id,
        request.candidate.components,
        request.candidate.candidate_id === target.seed_candidate_id
          ? "seed"
          : "submitted",
        job.job_id,
        request.candidate.parent_candidate_id,
      );
      job.candidate_ids.push(request.candidate.candidate_id);
      await store.writeJob(context, job);
      launch(context, job, (abort) =>
        runEvaluate(context, job, target, request, abort),
      );
      return { job_id: job.job_id, input_manifest: candidateRef };
    },

    async publish(context, jobId) {
      checkContext(context);
      const job = await store.readJob(context, jobId);
      if (job.report) return job.report;
      if (job.status !== "completed")
        throw new OptimizationError(
          "job_not_finished",
          `${jobId} is ${job.status}`,
        );
      const report = await buildReport(context, job);
      const ref = await putJson(context, report);
      job.report = ref;
      await store.writeJob(context, job);
      return ref;
    },

    async inspect(context, jobId) {
      checkContext(context);
      const job = await store.readJob(context, jobId);
      return {
        job: { job_id: job.job_id, input_manifest: job.input_manifest },
        status: jobResultStatus(job),
        artifacts: job.report ? [job.report] : [],
        cost_usd:
          job.cost_unmeasured_scores > 0 && job.cost_usd === 0
            ? null
            : job.cost_usd,
      };
    },

    async cancel(context, jobId) {
      checkContext(context);
      const job = await store.readJob(context, jobId);
      const active = running.get(jobId);
      if (active) {
        active.abort.abort();
        await active.done;
        return;
      }
      if (job.status === "pending" || job.status === "running") {
        await finishJob(
          context,
          job,
          null,
          "cancelled",
          "cancelled",
          "cancelled before start",
        );
      }
    },

    async job(context, jobId) {
      checkContext(context);
      return store.readJob(context, jobId);
    },

    async waitForJob(context, jobId) {
      checkContext(context);
      await running.get(jobId)?.done;
      return store.readJob(context, jobId);
    },

    async target(context, targetId) {
      checkContext(context);
      return store.readTarget(context, targetId);
    },

    async candidates(context, targetId) {
      checkContext(context);
      return store.listCandidates(context, targetId);
    },

    async decide(context, targetId, id, decision) {
      checkContext(context);
      const record = await store.readCandidate(context, targetId, id);
      return transition(context, record, decision.status, decision.reason);
    },

    async finalHoldoutInstances(context, targetId) {
      checkContext(context);
      return [...(await store.readHoldout(context, targetId)).final_holdout];
    },

    async report(context, jobId) {
      checkContext(context);
      const job = await store.readJob(context, jobId);
      if (!job.report)
        throw new OptimizationError(
          "job_not_finished",
          `${jobId} has not been published`,
        );
      return loadJson(context, job.report, ProposalReportSchema);
    },
  };
  return service;
}
