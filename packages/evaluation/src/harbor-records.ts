import { z } from "zod";

/**
 * Parsers for Harbor 0.25.0 on-disk records. Shapes were taken from real
 * `result.json` files produced by `harbor run` (job and trial level) and from
 * `harbor/models/trial/result.py` / `harbor/models/job/result.py`. Harbor's
 * process exit code is NOT a success signal: trials can error with exit 0, so
 * every judgement below is derived from these records only.
 */
const timing = z
  .object({
    started_at: z.string().nullable().optional(),
    finished_at: z.string().nullable().optional(),
  })
  .passthrough();

export const HarborExceptionInfoSchema = z
  .object({
    exception_type: z.string(),
    exception_message: z.string(),
    exception_traceback: z.string().optional().default(""),
    occurred_at: z.string().optional(),
  })
  .passthrough();

export const HarborTrialResultSchema = z
  .object({
    id: z.string().optional(),
    task_name: z.string().min(1),
    trial_name: z.string().min(1),
    task_id: z
      .object({
        git_url: z.string().optional().nullable(),
        git_commit_id: z.string().optional().nullable(),
        path: z.string(),
      })
      .passthrough(),
    source: z.string().nullable().optional(),
    task_checksum: z.string().optional(),
    agent_info: z
      .object({
        name: z.string(),
        version: z.string(),
        model_info: z
          .object({
            name: z.string(),
            provider: z.string().nullable().optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
      })
      .passthrough(),
    agent_result: z
      .object({
        n_input_tokens: z.number().int().nullable().optional(),
        n_cache_tokens: z.number().int().nullable().optional(),
        n_output_tokens: z.number().int().nullable().optional(),
        cost_usd: z.number().nullable().optional(),
        metadata: z.record(z.unknown()).nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    verifier_result: z
      .object({ rewards: z.record(z.number()).nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
    exception_info: HarborExceptionInfoSchema.nullable().optional(),
    started_at: z.string().nullable().optional(),
    finished_at: z.string().nullable().optional(),
    agent_execution: timing.nullable().optional(),
    verifier: timing.nullable().optional(),
    step_results: z
      .array(
        z
          .object({
            step_name: z.string(),
            exception_info: HarborExceptionInfoSchema.nullable().optional(),
          })
          .passthrough(),
      )
      .nullable()
      .optional(),
  })
  .passthrough();
export type HarborTrialResult = z.infer<typeof HarborTrialResultSchema>;

export const HarborJobStatsSchema = z
  .object({
    n_completed_trials: z.number().int().nonnegative(),
    n_errored_trials: z.number().int().nonnegative(),
    n_cancelled_trials: z.number().int().nonnegative().optional().default(0),
    evals: z.record(
      z
        .object({
          n_trials: z.number().int().nonnegative(),
          n_errors: z.number().int().nonnegative(),
          reward_stats: z
            .record(z.record(z.array(z.string())))
            .optional()
            .default({}),
          exception_stats: z.record(z.array(z.string())).optional().default({}),
        })
        .passthrough(),
    ),
    n_input_tokens: z.number().int().nullable().optional(),
    n_cache_tokens: z.number().int().nullable().optional(),
    n_output_tokens: z.number().int().nullable().optional(),
    cost_usd: z.number().nullable().optional(),
  })
  .passthrough();

export const HarborJobResultSchema = z
  .object({
    id: z.string(),
    started_at: z.string(),
    finished_at: z.string().nullable().optional(),
    n_total_trials: z.number().int().nonnegative(),
    stats: HarborJobStatsSchema,
  })
  .passthrough();
export type HarborJobResult = z.infer<typeof HarborJobResultSchema>;

/**
 * Harbor's `ErrorPolicy.reward_valid` table (harbor/models/trial/error_policy.py,
 * 0.25.0): only failures attributable to the agent itself leave the verifier
 * reward meaningful. Every other recorded exception invalidates the reward.
 */
const AGENT_EXHAUSTED_BUDGET = new Set([
  "AgentTimeoutError",
  "ContextWindowExceededError",
  "OutputTokenExceededError",
  "ContextLengthExceededError",
  "OutputLengthExceededError",
]);
const AGENT_REFUSED_TASK = new Set([
  "AgentSafetyRefusalError",
  "ContentPolicyViolationError",
]);
export function exceptionKeepsRewardValid(exceptionType: string): boolean {
  return (
    AGENT_EXHAUSTED_BUDGET.has(exceptionType) ||
    AGENT_REFUSED_TASK.has(exceptionType)
  );
}

export const TrialRecordSchema = z
  .object({
    trial_name: z.string(),
    task_id: z.string(),
    task_source: z
      .object({
        git_url: z.string().nullable(),
        git_commit_id: z.string().nullable(),
        path: z.string(),
        checksum: z.string().nullable(),
      })
      .strict(),
    dataset: z.string().nullable(),
    agent: z.object({ name: z.string(), version: z.string() }).strict(),
    model: z
      .object({ name: z.string(), provider: z.string().nullable() })
      .strict()
      .nullable(),
    /** Primary metric (`rewards.reward`, else the first numeric reward), or null. */
    reward: z.number().nullable(),
    rewards: z.record(z.number()).nullable(),
    reward_valid: z.boolean(),
    exception: z
      .object({ type: z.string(), message: z.string() })
      .strict()
      .nullable(),
    cost_usd: z.number().nullable(),
    n_input_tokens: z.number().int().nullable(),
    n_output_tokens: z.number().int().nullable(),
    n_cache_tokens: z.number().int().nullable(),
    /** Agent execution phase duration; null when Harbor recorded no timing. */
    runtime_ms: z.number().int().nonnegative().nullable(),
    /** Whole trial (environment build through verifier). */
    total_ms: z.number().int().nonnegative().nullable(),
    started_at: z.string().nullable(),
    finished_at: z.string().nullable(),
  })
  .strict();
export type TrialRecord = z.infer<typeof TrialRecordSchema>;

function durationMs(
  phase:
    | {
        started_at?: string | null | undefined;
        finished_at?: string | null | undefined;
      }
    | null
    | undefined,
): number | null {
  if (!phase?.started_at || !phase.finished_at) return null;
  const start = Date.parse(phase.started_at);
  const end = Date.parse(phase.finished_at);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
    return null;
  return Math.round(end - start);
}

function primaryReward(
  rewards: Record<string, number> | null | undefined,
): number | null {
  if (!rewards) return null;
  const direct = rewards.reward;
  if (typeof direct === "number" && Number.isFinite(direct)) return direct;
  for (const value of Object.values(rewards))
    if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

/** Maps a Harbor TrialResult to the flat, schema-checked `TrialRecord`. */
export function toTrialRecord(input: unknown): TrialRecord {
  const trial = HarborTrialResultSchema.parse(input);
  const exceptions = [
    ...(trial.exception_info ? [trial.exception_info] : []),
    ...(trial.step_results ?? []).flatMap((step) =>
      step.exception_info ? [step.exception_info] : [],
    ),
  ];
  const rewards = trial.verifier_result?.rewards ?? null;
  const reward = primaryReward(rewards);
  const rewardValid =
    rewards !== null &&
    Object.keys(rewards).length > 0 &&
    reward !== null &&
    exceptions.every((exception) =>
      exceptionKeepsRewardValid(exception.exception_type),
    );
  const first = exceptions[0];
  const result = trial.agent_result ?? null;
  return TrialRecordSchema.parse({
    trial_name: trial.trial_name,
    task_id: trial.task_name,
    task_source: {
      git_url: trial.task_id.git_url ?? null,
      git_commit_id: trial.task_id.git_commit_id ?? null,
      path: trial.task_id.path,
      checksum: trial.task_checksum ?? null,
    },
    dataset: trial.source ?? null,
    agent: { name: trial.agent_info.name, version: trial.agent_info.version },
    model: trial.agent_info.model_info
      ? {
          name: trial.agent_info.model_info.name,
          provider: trial.agent_info.model_info.provider ?? null,
        }
      : null,
    reward,
    rewards,
    reward_valid: rewardValid,
    exception: first
      ? {
          type: first.exception_type,
          message: first.exception_message.slice(0, 4096),
        }
      : null,
    cost_usd: result?.cost_usd ?? null,
    n_input_tokens: result?.n_input_tokens ?? null,
    n_output_tokens: result?.n_output_tokens ?? null,
    n_cache_tokens: result?.n_cache_tokens ?? null,
    runtime_ms: durationMs(trial.agent_execution),
    total_ms: durationMs({
      started_at: trial.started_at,
      finished_at: trial.finished_at,
    }),
    started_at: trial.started_at ?? null,
    finished_at: trial.finished_at ?? null,
  });
}

export interface ParsedHarborJob {
  job: HarborJobResult;
  trials: TrialRecord[];
  /** Trial directories whose result.json was missing or unparseable. */
  unreadable_trials: { trial_dir: string; error: string }[];
}

/**
 * Reads `<jobDir>/result.json` and every `<jobDir>/<trial>/result.json`.
 * Never trusts Harbor's exit status; a job with `n_errored_trials > 0` or
 * unreadable trial records is still returned so the caller can report it.
 */
export async function readHarborJob(jobDir: string): Promise<ParsedHarborJob> {
  const { readdir, readFile, stat } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const jobJson = JSON.parse(
    await readFile(join(jobDir, "result.json"), "utf8"),
  );
  const job = HarborJobResultSchema.parse(jobJson);
  const trials: TrialRecord[] = [];
  const unreadable: { trial_dir: string; error: string }[] = [];
  const entries = (await readdir(jobDir)).sort();
  for (const entry of entries) {
    const dir = join(jobDir, entry);
    if (!(await stat(dir)).isDirectory()) continue;
    try {
      const text = await readFile(join(dir, "result.json"), "utf8");
      if (!text.trim()) throw new Error("empty result.json");
      trials.push(toTrialRecord(JSON.parse(text)));
    } catch (error) {
      unreadable.push({
        trial_dir: entry,
        error:
          error instanceof Error ? error.message.slice(0, 512) : "unreadable",
      });
    }
  }
  return { job, trials, unreadable_trials: unreadable };
}
