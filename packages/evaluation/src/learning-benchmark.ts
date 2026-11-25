import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, sha256 } from "@mars/contracts/canonical";
import {
  EXECUTION_PACKAGE_VERSION,
  selectExecutionModel,
} from "@mars/execution";
import type { ModelProviderRegistry } from "@mars/providers";
import { z } from "zod";
import { runEditTrial, type TrialResult } from "./edit-benchmark/arms";
import { MIN_POWERED_TASKS, POWER_DESIGN } from "./edit-benchmark/power";
import { exactSignTest, wilsonInterval } from "./edit-benchmark/stats";
import type { EditBenchmarkTask } from "./edit-benchmark/tasks";
import { assertLearningHoldout, type LearningSuite } from "./learning-suite";
import { servingSeed } from "./serving-arm";

const Arms = ["baseline", "specialist"] as const;
type Arm = (typeof Arms)[number];
const ModelId = z.string().min(1);
const Sha = z.string().regex(/^[a-f0-9]{64}$/);
const Usd = z.number().finite().nonnegative();
const PositiveInt = z.number().int().positive().safe();

export const LearningPlanSchema = z
  .object({
    schema: z.literal("mars.learning-plan/v1"),
    suite_sha256: Sha,
    seed: z.string().min(1),
    budget_per_task: z
      .object({
        max_tokens: PositiveInt,
        max_usd: Usd,
        max_duration_ms: PositiveInt,
      })
      .strict(),
    max_total_usd: Usd,
    arms: z
      .object({
        baseline: z.object({ model: ModelId }).strict(),
        specialist: z.object({ model: ModelId, lineage_sha256: Sha }).strict(),
      })
      .strict(),
  })
  .strict();

type Plan = z.infer<typeof LearningPlanSchema>;
type Transport = (url: string, init?: RequestInit) => Promise<Response>;
type Binding = {
  registry: ModelProviderRegistry;
  fetch: Transport;
  env?: Record<string, string | undefined>;
};
type ProviderFailure =
  | "timeout"
  | "rate_limit"
  | "server_error"
  | "other_provider";
type Failure =
  | "budget"
  | "edit_tool"
  | "runtime"
  | "unreadable_patch"
  | "no_patch"
  | "wrong_patch";
type Outcome = Pick<
  TrialResult,
  | "solved"
  | "status"
  | "failure"
  | "verification"
  | "turns"
  | "cost_usd"
  | "wall_ms"
  | "edit_failures"
  | "transcript"
> & {
  category: Failure | null;
  provider_failure: ProviderFailure | null;
  http_errors: Partial<Record<ProviderFailure, number>>;
};

function failureCategory(
  trial: TrialResult,
  task: EditBenchmarkTask,
): Failure | null {
  if (trial.solved) return null;
  if (trial.verification.unreadable) return "unreadable_patch";
  if (
    trial.failure === "budget_exhausted" ||
    trial.failure === "deadline_exceeded"
  )
    return "budget";
  if (trial.edit_failures > 0) return "edit_tool";
  if (trial.status !== "completed") return "runtime";
  return trial.verification.changed.length ||
    trial.verification.missing.some((path) => task.before.has(path)) ||
    [...task.before.keys()].some(
      (path) =>
        !task.after.has(path) && !trial.verification.unexpected.includes(path),
    )
    ? "wrong_patch"
    : "no_patch";
}

function statusCategory(status: number): ProviderFailure {
  if (status === 408) return "timeout";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "server_error";
  return "other_provider";
}

function nearestRank(sorted: number[], q: number) {
  return sorted[Math.ceil(q * sorted.length) - 1] ?? null;
}

function summarize(outcomes: Outcome[]) {
  const eligible = outcomes.filter((item) => item.provider_failure === null);
  const solved = eligible.filter((item) => item.solved);
  const provider_errors = {
    timeout: 0,
    rate_limit: 0,
    server_error: 0,
    other_provider: 0,
  };
  const http_errors = { ...provider_errors };
  const failures: Partial<Record<Failure, number>> = {};
  for (const item of outcomes) {
    if (item.provider_failure) provider_errors[item.provider_failure]++;
    if (item.category)
      failures[item.category] = (failures[item.category] ?? 0) + 1;
    for (const key of Object.keys(http_errors) as ProviderFailure[])
      http_errors[key] += item.http_errors[key] ?? 0;
  }
  const durations = solved.map((item) => item.wall_ms).sort((a, b) => a - b);
  const metered_cost_usd = outcomes.reduce(
    (sum, item) => sum + item.cost_usd,
    0,
  );
  return {
    attempted: outcomes.length,
    eligible: eligible.length,
    solved: solved.length,
    solve_rate: eligible.length ? solved.length / eligible.length : null,
    wilson_95: eligible.length
      ? wilsonInterval(solved.length, eligible.length)
      : null,
    provider_errors,
    http_errors,
    failures,
    metered_cost_usd,
    metered_cost_per_verified_solve_usd: solved.length
      ? metered_cost_usd / solved.length
      : null,
    median_time_to_verified_patch_ms:
      durations.length % 2
        ? nearestRank(durations, 0.5)
        : durations.length
          ? ((durations[durations.length / 2 - 1] ?? 0) +
              (durations[durations.length / 2] ?? 0)) /
            2
          : null,
    p90_time_to_verified_patch_ms: nearestRank(durations, 0.9),
  };
}

// Bonferroni difference of marginal 97.5% Wilson intervals for the two
// discordance probabilities; useful even when all observed pairs are ties.
function pairedInterval(wins: number, losses: number, n: number) {
  const interval = (count: number) => {
    const z = 2.2414027276;
    const p = count / n;
    const denominator = 1 + (z * z) / n;
    const center = (p + (z * z) / (2 * n)) / denominator;
    const half =
      (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator;
    return {
      lower: Math.max(0, center - half),
      upper: Math.min(1, center + half),
    };
  };
  const win = interval(wins);
  const loss = interval(losses);
  return { lower: win.lower - loss.upper, upper: win.upper - loss.lower };
}

type Pair = Record<Arm, Outcome>;

function paired(pairs: Pair[]) {
  const complete = pairs.filter(
    ({ baseline, specialist }) =>
      !baseline.provider_failure && !specialist.provider_failure,
  );
  const wins = complete.filter(
    ({ baseline, specialist }) => !baseline.solved && specialist.solved,
  ).length;
  const losses = complete.filter(
    ({ baseline, specialist }) => baseline.solved && !specialist.solved,
  ).length;
  const n = complete.length;
  return {
    pairs: n,
    excluded_provider_pairs: pairs.length - n,
    wins,
    losses,
    ties: n - wins - losses,
    difference: n ? (wins - losses) / n : null,
    ci_95: n ? pairedInterval(wins, losses, n) : null,
    sign_test_p_two_sided: n ? exactSignTest(wins, losses).p_two_sided : null,
    underpowered: n < MIN_POWERED_TASKS,
  };
}

export type LearningReport = Awaited<ReturnType<typeof runLearningBenchmark>>;

export async function runLearningBenchmark(
  options: {
    plan: unknown;
    suite: LearningSuite;
    outDir: string;
  } & (
    | { mode: "live"; binding: Binding; lineage: string }
    | { mode: "offline"; bindings: Record<Arm, Binding> }
  ),
) {
  const plan: Plan = LearningPlanSchema.parse(options.plan);
  const { suite } = options;
  if (plan.suite_sha256 !== suite.sha256)
    throw new Error("Held-out suite digest mismatch.");
  const count = suite.tasks.length * 2;
  if (count * plan.budget_per_task.max_usd > plan.max_total_usd + 1e-12)
    throw new Error("Matched trial budgets exceed the total USD cap.");
  if (options.mode === "live") {
    assertLearningHoldout(
      suite,
      options.lineage,
      plan.arms.specialist.lineage_sha256,
    );
    if (plan.arms.baseline.model === plan.arms.specialist.model)
      throw new Error("Live arms must select distinct models.");
  }
  const bindingFor = (arm: Arm) =>
    options.mode === "live" ? options.binding : options.bindings[arm];
  const [baseline, specialist] = Arms.map((arm) =>
    selectExecutionModel(bindingFor(arm).registry, plan.arms[arm].model, true),
  ) as [
    ReturnType<typeof selectExecutionModel>,
    ReturnType<typeof selectExecutionModel>,
  ];
  if (
    options.mode === "live" &&
    (baseline.model === specialist.model ||
      baseline.providerId !== specialist.providerId ||
      canonicalJson(baseline.capabilities) !==
        canonicalJson(specialist.capabilities) ||
      baseline.requestTimeoutMs !== specialist.requestTimeoutMs ||
      baseline.maxOutputTokens !== specialist.maxOutputTokens)
  )
    throw new Error(
      "Live models must name different served checkpoints under the same provider, capabilities, timeout and output cap.",
    );

  const { outDir } = options;
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  const transcriptRoot = join(outDir, "transcripts");
  try {
    await mkdir(transcriptRoot, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new Error(
      "Use a fresh benchmark output directory; transcripts already exist.",
    );
  }
  const jobSeed = sha256(canonicalJson([plan.schema, suite.sha256, plan.seed]));
  const matches = [...suite.tasks]
    .map(({ task, pin }) => ({
      task,
      pin,
      order: sha256(canonicalJson([jobSeed, pin.task_id])),
    }))
    .sort((left, right) => left.order.localeCompare(right.order));
  const rows = [];
  for (const { task, pin, order } of matches) {
    const seed = servingSeed(order);
    const orderOfArms =
      Number.parseInt(order.slice(-1), 16) % 2 ? [...Arms].reverse() : Arms;
    const outcomes = {} as Pair;
    for (const arm of orderOfArms) {
      const binding = bindingFor(arm);
      let lastStatus: number | undefined;
      const http_errors: Outcome["http_errors"] = {};
      const result = await runEditTrial({
        arm: "mars:apply_patch",
        task,
        repeat: 0,
        registry: binding.registry,
        modelId: plan.arms[arm].model,
        seed,
        budget: plan.budget_per_task,
        ...(binding.env ? { env: binding.env } : {}),
        workRoot: join(outDir, "work"),
        transcriptRoot: join(transcriptRoot, arm),
        async fetch(url, init) {
          lastStatus = undefined;
          const response = await binding.fetch(url, init);
          lastStatus = response.status;
          if (!response.ok) {
            const key = statusCategory(response.status);
            http_errors[key] = (http_errors[key] ?? 0) + 1;
          }
          return response;
        },
      });
      const provider_failure =
        result.failure === "provider_timeout"
          ? "timeout"
          : result.failure === "provider_error"
            ? lastStatus !== undefined && lastStatus >= 400
              ? statusCategory(lastStatus)
              : "other_provider"
            : null;
      outcomes[arm] = {
        solved: result.solved && !provider_failure,
        failure: result.failure,
        status: result.status,
        verification: result.verification,
        turns: result.turns,
        cost_usd: result.cost_usd,
        wall_ms:
          options.mode === "offline" ? 100 * result.turns : result.wall_ms,
        edit_failures: result.edit_failures,
        transcript: result.transcript
          ? join("transcripts", arm, result.transcript)
          : null,
        category: provider_failure ? null : failureCategory(result, task),
        provider_failure,
        http_errors,
      };
    }
    rows.push({
      task_id: pin.task_id,
      route: `${pin.domain}:worker:${pin.complexity}`,
      seed,
      arm_order: orderOfArms,
      outcomes,
    });
  }
  const routes = new Map<string, Pair[]>();
  for (const row of rows) {
    const group = routes.get(row.route) ?? [];
    group.push(row.outcomes);
    routes.set(row.route, group);
  }
  return {
    schema: "mars.learning-report/v1",
    simulated: options.mode === "offline",
    plan,
    job_seed: jobSeed,
    models: { baseline, specialist },
    policy: {
      runtime: "mars",
      runtime_revision: EXECUTION_PACKAGE_VERSION,
      edit_format: "apply_patch",
      execute: false,
      check: "exact-pinned-tree",
      repeats: 1,
    },
    suite: {
      ...suite.manifest,
      sha256: suite.sha256,
      split_sha256: suite.guard.split().sha256,
    },
    power: {
      ...POWER_DESIGN,
      minimum_complete_pairs: MIN_POWERED_TASKS,
      detectable_lift: 0.16,
      planned_underpowered: suite.tasks.length < MIN_POWERED_TASKS,
    },
    arms: {
      baseline: summarize(rows.map(({ outcomes }) => outcomes.baseline)),
      specialist: summarize(rows.map(({ outcomes }) => outcomes.specialist)),
    },
    paired: paired(rows.map(({ outcomes }) => outcomes)),
    routing: [...routes]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([route, group]) => {
        const evidence = paired(group);
        const reason =
          options.mode === "offline"
            ? "simulated"
            : evidence.underpowered
              ? "insufficient_complete_pairs"
              : evidence.excluded_provider_pairs
                ? "incomplete_provider_coverage"
                : (evidence.ci_95?.lower ?? 0) <= 0 ||
                    (evidence.sign_test_p_two_sided ?? 1) >= POWER_DESIGN.alpha
                  ? "positive_lift_not_established"
                  : "positive_lift_candidate_for_review";
        return {
          route,
          recommendation:
            reason === "positive_lift_candidate_for_review"
              ? "review_specialist"
              : "stay_on_base",
          reason,
          ...evidence,
        };
      }),
    tasks: rows,
  };
}
