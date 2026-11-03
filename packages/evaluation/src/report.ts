import { z } from "zod";
import { type TrialRecord, TrialRecordSchema } from "./harbor-records";
import type { ComparisonManifest } from "./manifest";

export const EVALUATION_REPORT_SCHEMA = "mars.evaluation-report/v1";
export const EVALUATION_REPORT_MEDIA_TYPE =
  "application/vnd.mars.evaluation-report+json";

export const ArmName = z.enum(["baseline", "candidate"]);
export type ArmName = z.infer<typeof ArmName>;

const nullableNumber = z.number().nullable();

export const ArmAggregateSchema = z
  .object({
    agent: z.object({ name: z.string(), version: z.string() }).strict(),
    n_trials: z.number().int().nonnegative(),
    n_valid: z.number().int().nonnegative(),
    n_invalid: z.number().int().nonnegative(),
    /** Mean over valid rewards only; null when no trial produced a valid reward. */
    mean_reward_valid: nullableNumber,
    /** Mean where every invalid or missing trial counts as 0 (GEPA-style fallback). */
    mean_reward_strict: z.number(),
    total_cost_usd: nullableNumber,
    total_runtime_ms: z.number().int().nonnegative(),
    n_input_tokens: nullableNumber,
    n_output_tokens: nullableNumber,
    exceptions: z.record(z.number().int().positive()),
  })
  .strict();
export type ArmAggregate = z.infer<typeof ArmAggregateSchema>;

export const TaskArmStatsSchema = z
  .object({
    n_trials: z.number().int().nonnegative(),
    n_valid: z.number().int().nonnegative(),
    rewards: z.array(z.number()),
    mean_valid: nullableNumber,
    mean_strict: z.number(),
    variance: nullableNumber,
    min: nullableNumber,
    max: nullableNumber,
    /** Repeated identical trials disagreed (reward or validity differs). */
    disagree: z.boolean(),
    cost_usd: nullableNumber,
    runtime_ms: z.number().int().nonnegative(),
  })
  .strict();
export type TaskArmStats = z.infer<typeof TaskArmStatsSchema>;

export const EvaluationReportSchema = z
  .object({
    schema: z.literal(EVALUATION_REPORT_SCHEMA),
    comparison_id: z.string(),
    generated_at: z.string().datetime({ offset: true }),
    dataset: z
      .object({
        name: z.string(),
        version: z.string(),
        registry_revision: z.string(),
        git_url: z.string(),
        git_commit_id: z.string(),
      })
      .strict(),
    model_id: z.string(),
    repeats: z.number().int().positive(),
    tasks: z.array(z.string()),
    arms: z
      .object({ baseline: ArmAggregateSchema, candidate: ArmAggregateSchema })
      .strict(),
    per_task: z.array(
      z
        .object({
          task_id: z.string(),
          final_holdout: z.boolean(),
          baseline: TaskArmStatsSchema,
          candidate: TaskArmStatsSchema,
          /** candidate.mean_strict - baseline.mean_strict */
          delta_strict: z.number(),
          regression: z.boolean(),
        })
        .strict(),
    ),
    /** Tasks where the candidate's strict mean reward is below the baseline's. */
    regressions: z.array(z.string()),
    repeatability: z.array(
      z
        .object({
          task_id: z.string(),
          arm: ArmName,
          n: z.number().int().nonnegative(),
          mean: nullableNumber,
          variance: nullableNumber,
          min: nullableNumber,
          max: nullableNumber,
          disagree: z.boolean(),
        })
        .strict(),
    ),
    /** Tasks (any arm) whose repeated identical trials disagreed. */
    unstable_tasks: z.array(z.string()),
    trials: z
      .object({
        baseline: z.array(TrialRecordSchema),
        candidate: z.array(TrialRecordSchema),
      })
      .strict(),
    /** Trials rejected because their task pin did not match the manifest. */
    pin_mismatches: z.array(
      z
        .object({ arm: ArmName, trial_name: z.string(), reason: z.string() })
        .strict(),
    ),
    unreadable_trials: z.array(
      z
        .object({ arm: ArmName, trial_dir: z.string(), error: z.string() })
        .strict(),
    ),
    /** Harbor's own counters, for cross-checking; never the basis of a verdict. */
    harbor: z
      .object({
        baseline: z
          .object({
            n_completed_trials: z.number(),
            n_errored_trials: z.number(),
          })
          .strict(),
        candidate: z
          .object({
            n_completed_trials: z.number(),
            n_errored_trials: z.number(),
          })
          .strict(),
      })
      .strict(),
    verdict: z
      .object({
        candidate_mean_strict: z.number(),
        baseline_mean_strict: z.number(),
        improvement_strict: z.number(),
        n_regressions: z.number().int().nonnegative(),
        n_unstable_tasks: z.number().int().nonnegative(),
        /** True only when every expected trial of both arms produced a valid reward. */
        complete: z.boolean(),
        notes: z.array(z.string()),
      })
      .strict(),
  })
  .strict();
export type EvaluationReport = z.infer<typeof EvaluationReportSchema>;

export interface ArmInput {
  agent: { name: string; version: string };
  trials: TrialRecord[];
  harbor: { n_completed_trials: number; n_errored_trials: number };
  unreadable_trials?: { trial_dir: string; error: string }[];
}

function harborCounters(stats: ArmInput["harbor"]) {
  return {
    n_completed_trials: stats.n_completed_trials,
    n_errored_trials: stats.n_errored_trials,
  };
}

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
export function populationVariance(values: readonly number[]): number | null {
  const average = mean(values);
  if (average === null) return null;
  return (
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) /
    values.length
  );
}

function sumNullable(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length ? present.reduce((sum, value) => sum + value, 0) : null;
}

export function taskArmStats(
  trials: readonly TrialRecord[],
  expected: number,
): TaskArmStats {
  const valid = trials.filter(
    (trial) => trial.reward_valid && trial.reward !== null,
  );
  const rewards = valid.map((trial) => trial.reward as number);
  const strictTotal = rewards.reduce((sum, value) => sum + value, 0);
  const denominator = Math.max(expected, trials.length, 1);
  const disagree =
    trials.length > 1 &&
    (valid.length !== trials.length && valid.length !== 0
      ? true
      : rewards.length > 1 && new Set(rewards).size > 1);
  return {
    n_trials: trials.length,
    n_valid: valid.length,
    rewards,
    mean_valid: mean(rewards),
    mean_strict: strictTotal / denominator,
    variance: populationVariance(rewards),
    min: rewards.length ? Math.min(...rewards) : null,
    max: rewards.length ? Math.max(...rewards) : null,
    disagree,
    cost_usd: sumNullable(trials.map((trial) => trial.cost_usd)),
    runtime_ms: trials.reduce((sum, trial) => sum + (trial.runtime_ms ?? 0), 0),
  };
}

function armAggregate(
  agent: { name: string; version: string },
  trials: readonly TrialRecord[],
  expected: number,
): ArmAggregate {
  const valid = trials.filter(
    (trial) => trial.reward_valid && trial.reward !== null,
  );
  const rewards = valid.map((trial) => trial.reward as number);
  const exceptions: Record<string, number> = {};
  for (const trial of trials)
    if (trial.exception)
      exceptions[trial.exception.type] =
        (exceptions[trial.exception.type] ?? 0) + 1;
  return {
    agent,
    n_trials: trials.length,
    n_valid: valid.length,
    n_invalid: trials.length - valid.length,
    mean_reward_valid: mean(rewards),
    mean_reward_strict:
      rewards.reduce((sum, value) => sum + value, 0) /
      Math.max(expected, trials.length, 1),
    total_cost_usd: sumNullable(trials.map((trial) => trial.cost_usd)),
    total_runtime_ms: trials.reduce(
      (sum, trial) => sum + (trial.runtime_ms ?? 0),
      0,
    ),
    n_input_tokens: sumNullable(trials.map((trial) => trial.n_input_tokens)),
    n_output_tokens: sumNullable(trials.map((trial) => trial.n_output_tokens)),
    exceptions,
  };
}

/**
 * Builds the comparison report. Trials whose task pin (git url/commit) differs
 * from the manifest are excluded and listed under `pin_mismatches`; trials for
 * tasks outside the manifest are excluded the same way.
 */
export function buildEvaluationReport(
  manifest: ComparisonManifest,
  arms: { baseline: ArmInput; candidate: ArmInput },
  now: () => number = Date.now,
): EvaluationReport {
  const pinMismatches: EvaluationReport["pin_mismatches"] = [];
  const accepted: Record<ArmName, TrialRecord[]> = {
    baseline: [],
    candidate: [],
  };
  const taskSet = new Set(manifest.tasks);
  for (const arm of ArmName.options) {
    for (const trial of arms[arm].trials) {
      const reason = !taskSet.has(trial.task_id)
        ? `task ${trial.task_id} is not in the manifest`
        : trial.task_source.git_url !== manifest.dataset.tasks_source.git_url
          ? `git_url ${trial.task_source.git_url ?? "null"} differs from the pinned dataset`
          : trial.task_source.git_commit_id !==
              manifest.dataset.tasks_source.git_commit_id
            ? `git_commit_id ${trial.task_source.git_commit_id ?? "null"} differs from the pinned dataset`
            : trial.agent.name !== arms[arm].agent.name
              ? `agent ${trial.agent.name} is not the ${arm} agent`
              : null;
      if (reason)
        pinMismatches.push({ arm, trial_name: trial.trial_name, reason });
      else accepted[arm].push(trial);
    }
  }
  const holdout = new Set(manifest.final_holdout_tasks);
  const perTask: EvaluationReport["per_task"] = [];
  const repeatability: EvaluationReport["repeatability"] = [];
  const unstable = new Set<string>();
  for (const task of manifest.tasks) {
    const stats = {
      baseline: taskArmStats(
        accepted.baseline.filter((trial) => trial.task_id === task),
        manifest.repeats,
      ),
      candidate: taskArmStats(
        accepted.candidate.filter((trial) => trial.task_id === task),
        manifest.repeats,
      ),
    };
    for (const arm of ArmName.options) {
      const s = stats[arm];
      repeatability.push({
        task_id: task,
        arm,
        n: s.n_trials,
        mean: s.mean_valid,
        variance: s.variance,
        min: s.min,
        max: s.max,
        disagree: s.disagree,
      });
      if (s.disagree) unstable.add(task);
    }
    const delta = stats.candidate.mean_strict - stats.baseline.mean_strict;
    perTask.push({
      task_id: task,
      final_holdout: holdout.has(task),
      baseline: stats.baseline,
      candidate: stats.candidate,
      delta_strict: delta,
      regression: delta < 0,
    });
  }
  const expected = manifest.tasks.length * manifest.repeats;
  const aggregates = {
    baseline: armAggregate(arms.baseline.agent, accepted.baseline, expected),
    candidate: armAggregate(arms.candidate.agent, accepted.candidate, expected),
  };
  const notes: string[] = [];
  for (const arm of ArmName.options) {
    const aggregate = aggregates[arm];
    if (aggregate.n_trials !== expected)
      notes.push(
        `${arm}: expected ${expected} trials, parsed ${aggregate.n_trials}.`,
      );
    if (aggregate.n_invalid > 0)
      notes.push(
        `${arm}: ${aggregate.n_invalid} trial(s) have no valid reward (counted as 0 in strict means).`,
      );
    if (arms[arm].harbor.n_errored_trials > 0)
      notes.push(
        `${arm}: Harbor reported ${arms[arm].harbor.n_errored_trials} errored trial(s).`,
      );
  }
  if (pinMismatches.length)
    notes.push(`${pinMismatches.length} trial(s) excluded for pin mismatches.`);
  // Completeness is judged per task: every manifest task needs exactly
  // `repeats` valid trials in each arm, so a surplus on one task can never
  // mask a task that produced no records.
  const complete =
    perTask.every(
      (entry) =>
        entry.baseline.n_valid === manifest.repeats &&
        entry.candidate.n_valid === manifest.repeats,
    ) &&
    pinMismatches.length === 0 &&
    (arms.baseline.unreadable_trials?.length ?? 0) === 0 &&
    (arms.candidate.unreadable_trials?.length ?? 0) === 0;
  const regressions = perTask
    .filter((entry) => entry.regression)
    .map((entry) => entry.task_id);
  return EvaluationReportSchema.parse({
    schema: EVALUATION_REPORT_SCHEMA,
    comparison_id: manifest.comparison_id,
    generated_at: new Date(now()).toISOString(),
    dataset: {
      name: manifest.dataset.name,
      version: manifest.dataset.version,
      registry_revision: manifest.dataset.registry.revision,
      git_url: manifest.dataset.tasks_source.git_url,
      git_commit_id: manifest.dataset.tasks_source.git_commit_id,
    },
    model_id: manifest.model.id,
    repeats: manifest.repeats,
    tasks: manifest.tasks,
    arms: aggregates,
    per_task: perTask,
    regressions,
    repeatability,
    unstable_tasks: [...unstable],
    trials: accepted,
    pin_mismatches: pinMismatches,
    unreadable_trials: ArmName.options.flatMap((arm) =>
      (arms[arm].unreadable_trials ?? []).map((entry) => ({ arm, ...entry })),
    ),
    harbor: {
      baseline: harborCounters(arms.baseline.harbor),
      candidate: harborCounters(arms.candidate.harbor),
    },
    verdict: {
      candidate_mean_strict: aggregates.candidate.mean_reward_strict,
      baseline_mean_strict: aggregates.baseline.mean_reward_strict,
      improvement_strict:
        aggregates.candidate.mean_reward_strict -
        aggregates.baseline.mean_reward_strict,
      n_regressions: regressions.length,
      n_unstable_tasks: unstable.size,
      complete,
      notes,
    },
  });
}
