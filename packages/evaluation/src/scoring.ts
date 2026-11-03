import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type {
  InstanceScore,
  PromptScoringBackend,
  PromptScoringOptions,
  RequestContext,
  ScoringRequest,
  ScoringResult,
} from "@mars/contracts";
import { ScoringRequestSchema, ScoringResultSchema } from "@mars/contracts";
import { readHarborJob, type TrialRecord } from "./harbor-records";
import { type ComparisonManifest, canonicalJson, sha256Hex } from "./manifest";
import { MARS_AGENT_NAME } from "./pins";
import type { HarborRunner } from "./runner";
import {
  type ArtifactSink,
  packTrialDir,
  renderTrialFeedback,
} from "./trajectory";

export interface HarborScoringBackendOptions {
  /** Base manifest: dataset, model, images, budget, holdout. Its candidate arm is replaced per request. */
  manifest: ComparisonManifest;
  runner: HarborRunner;
  artifacts: ArtifactSink;
  /** Absolute directory where candidate component files are written. */
  candidateDir: string;
  /** Instance ids available to each split; final holdout ids are always rejected. */
  splits: { train: readonly string[]; validation: readonly string[] };
  now?: () => number;
}

export function requestSha256(request: ScoringRequest): string {
  return sha256Hex(new TextEncoder().encode(canonicalJson(request)));
}

function clampScore(value: number | null): number {
  if (value === null || !Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Scores a prompt candidate by running ONLY the MARS arm on the requested
 * instances. Final-holdout tasks are refused regardless of the split name so
 * the optimiser can never fit to them.
 */
export function createHarborScoringBackend(
  options: HarborScoringBackendOptions,
): PromptScoringBackend {
  if (!isAbsolute(options.candidateDir))
    throw new TypeError("candidateDir must be absolute.");
  const now = options.now ?? Date.now;
  const holdout = new Set(options.manifest.final_holdout_tasks);
  for (const split of ["train", "validation"] as const)
    for (const instance of options.splits[split]) {
      if (holdout.has(instance))
        throw new TypeError(
          `Split ${split} contains final holdout task ${instance}.`,
        );
      if (!options.manifest.tasks.includes(instance))
        throw new TypeError(
          `Split ${split} instance ${instance} is not in the manifest.`,
        );
    }
  return {
    async score(
      context: RequestContext,
      rawRequest: ScoringRequest,
      scoringOptions?: PromptScoringOptions,
    ): Promise<ScoringResult> {
      scoringOptions?.signal?.throwIfAborted();
      const request = ScoringRequestSchema.parse(rawRequest);
      const allowed = new Set(options.splits[request.split]);
      for (const instance of request.instance_ids) {
        if (holdout.has(instance))
          throw new Error(
            `Instance ${instance} is a final holdout task and cannot be scored.`,
          );
        if (!allowed.has(instance))
          throw new Error(
            `Instance ${instance} is not in the ${request.split} split.`,
          );
      }
      if (request.budget.max_usd > options.manifest.budget.max_usd)
        throw new Error("Scoring budget exceeds the manifest budget.");
      const hash = requestSha256(request);
      const manifest: ComparisonManifest = {
        ...options.manifest,
        repeats: request.repeats,
        arms: {
          ...options.manifest.arms,
          candidate: {
            ...options.manifest.arms.candidate,
            candidate: request.candidate,
          },
        },
      };
      await mkdir(options.candidateDir, { recursive: true, mode: 0o700 });
      const candidatePath = join(options.candidateDir, `${hash}.json`);
      await writeFile(
        candidatePath,
        canonicalJson({
          schema: "mars.prompt-candidate/v1",
          ...request.candidate,
        }),
        {
          mode: 0o600,
        },
      );
      const started = now();
      const outcome = await options.runner.run({
        manifest,
        arm: "candidate",
        tasks: request.instance_ids,
        repeats: request.repeats,
        jobName: `score-${hash.slice(0, 16)}-${started}-${randomUUID().slice(0, 8)}`,
        deadlineMs:
          started +
          Math.min(
            request.budget.max_duration_ms,
            manifest.budget.max_duration_ms,
          ),
        maxConcurrency: Math.min(
          request.budget.max_concurrency,
          manifest.budget.max_concurrency,
        ),
        candidatePath,
        ...(scoringOptions?.signal ? { signal: scoringOptions.signal } : {}),
      });
      const parsed = outcome.killed
        ? null
        : await readHarborJob(outcome.job_dir).catch(() => null);
      const byTask = new Map<string, TrialRecord[]>();
      const requested = new Set(request.instance_ids);
      for (const trial of parsed?.trials ?? []) {
        // Same acceptance rule as buildEvaluationReport: only MARS trials of
        // the requested tasks from the pinned source may contribute a score.
        if (
          !requested.has(trial.task_id) ||
          trial.task_source.git_url !== manifest.dataset.tasks_source.git_url ||
          trial.task_source.git_commit_id !==
            manifest.dataset.tasks_source.git_commit_id ||
          trial.agent.name !== MARS_AGENT_NAME
        )
          continue;
        byTask.set(trial.task_id, [
          ...(byTask.get(trial.task_id) ?? []),
          trial,
        ]);
      }
      const scores: InstanceScore[] = [];
      for (const instance of request.instance_ids) {
        const trials = byTask.get(instance) ?? [];
        if (trials.length === 0) {
          scores.push({
            instance_id: instance,
            score: 0,
            reward_valid: false,
            runtime_ms: 0,
            cost_usd: null,
            error: outcome.killed
              ? `Harbor run ${outcome.killed}; no trial record`
              : `No trial record for ${instance} (harbor exit ${outcome.exit_code ?? "unknown"})`,
            trajectory: null,
            feedback: `[untrusted evaluation evidence · task ${instance}] No Harbor trial record was produced. Harbor stderr tail: ${outcome.stderr_tail.slice(-1024)}`,
          });
          continue;
        }
        const valid = trials.filter(
          (trial) => trial.reward_valid && trial.reward !== null,
        );
        const meanScore =
          valid.reduce((sum, trial) => sum + clampScore(trial.reward), 0) /
          Math.max(request.repeats, trials.length);
        const costs = trials
          .map((trial) => trial.cost_usd)
          .filter((cost): cost is number => cost !== null);
        const feedback: string[] = [];
        let trajectory: InstanceScore["trajectory"] = null;
        for (const trial of trials) {
          const bundle = await packTrialDir(
            join(outcome.job_dir, trial.trial_name),
            trial,
          );
          feedback.push(renderTrialFeedback(trial, bundle));
          const ref = await options.artifacts.put(
            context,
            new TextEncoder().encode(JSON.stringify(bundle)),
            "application/vnd.mars.harbor-trial+json",
          );
          trajectory ??= ref;
        }
        const firstError = trials.find((trial) => trial.exception)?.exception;
        scores.push({
          instance_id: instance,
          score: clampScore(meanScore),
          reward_valid:
            valid.length === trials.length && trials.length >= request.repeats,
          runtime_ms: trials.reduce(
            (sum, trial) => sum + (trial.runtime_ms ?? 0),
            0,
          ),
          cost_usd: costs.length
            ? costs.reduce((sum, cost) => sum + cost, 0)
            : null,
          error: firstError
            ? `${firstError.type}: ${firstError.message.slice(0, 512)}`
            : null,
          trajectory,
          feedback: feedback.join("\n\n").slice(0, 16_000),
        });
      }
      const costs = scores
        .map((score) => score.cost_usd)
        .filter((cost): cost is number => cost !== null);
      return ScoringResultSchema.parse({
        request_sha256: hash,
        split: request.split,
        scores,
        mean_score:
          scores.reduce((sum, score) => sum + score.score, 0) / scores.length,
        cost_usd: costs.length
          ? costs.reduce((sum, cost) => sum + cost, 0)
          : null,
        runtime_ms: Math.max(0, now() - started),
        simulated: false,
      } satisfies ScoringResult);
    },
  };
}

export interface ScoringFixture {
  /** reward in [0,1] or null for an invalid/errored trial. */
  reward: number | null;
  runtime_ms?: number;
  cost_usd?: number | null;
  error?: string | null;
  feedback?: string;
}

/**
 * Deterministic offline backend. Every result is labelled `simulated: true`,
 * performs no model requests and never touches Harbor or Docker. Scores are
 * looked up by `(candidate component text hash, instance id)` or by instance
 * id alone, so tests can shape how candidates compare.
 */
export function createFixtureScoringBackend(
  fixtures: Record<string, ScoringFixture>,
  options: {
    holdout?: readonly string[];
    perCandidate?: Record<string, Record<string, ScoringFixture>>;
  } = {},
): PromptScoringBackend {
  const holdout = new Set(options.holdout ?? []);
  return {
    async score(_context, rawRequest) {
      const request = ScoringRequestSchema.parse(rawRequest);
      const candidateKey = sha256Hex(
        new TextEncoder().encode(canonicalJson(request.candidate.components)),
      );
      const scores: InstanceScore[] = request.instance_ids.map((instance) => {
        if (holdout.has(instance))
          throw new Error(
            `Instance ${instance} is a final holdout task and cannot be scored.`,
          );
        const fixture =
          options.perCandidate?.[candidateKey]?.[instance] ??
          fixtures[instance];
        if (!fixture) throw new Error(`No fixture for instance ${instance}`);
        const valid = fixture.reward !== null;
        return {
          instance_id: instance,
          score: clampScore(fixture.reward),
          reward_valid: valid,
          runtime_ms: fixture.runtime_ms ?? 0,
          cost_usd: fixture.cost_usd ?? null,
          error: fixture.error ?? (valid ? null : "fixture: invalid reward"),
          trajectory: null,
          feedback: `[simulated fixture evidence · task ${instance}] ${fixture.feedback ?? (valid ? `reward ${fixture.reward}` : "no valid reward")}`,
        };
      });
      const costs = scores
        .map((score) => score.cost_usd)
        .filter((cost): cost is number => cost !== null);
      return ScoringResultSchema.parse({
        request_sha256: requestSha256(request),
        split: request.split,
        scores,
        mean_score:
          scores.reduce((sum, score) => sum + score.score, 0) / scores.length,
        cost_usd: costs.length
          ? costs.reduce((sum, cost) => sum + cost, 0)
          : null,
        runtime_ms: scores.reduce((sum, score) => sum + score.runtime_ms, 0),
        simulated: true,
      });
    },
  };
}
