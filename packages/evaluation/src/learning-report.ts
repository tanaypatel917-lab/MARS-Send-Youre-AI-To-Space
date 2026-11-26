import type { LearningReport } from "./learning-benchmark";

const pct = (value: number | null) =>
  value === null ? "—" : `${(100 * value).toFixed(1)}%`;
const value = (n: number | null) =>
  n === null ? "—" : String(Number(n.toPrecision(5)));
const ci = (range: { lower: number; upper: number } | null) =>
  range ? `[${pct(range.lower)}, ${pct(range.upper)}]` : "—";

export function renderLearningReport(report: LearningReport): string {
  const { paired, power } = report;
  return [
    "# Baseline vs. specialist learning benchmark",
    ...(report.simulated
      ? [
          "",
          "**SIMULATED — zero real model calls. Not quality, cost, or latency evidence.**",
        ]
      : []),
    "",
    `Suite: \`${report.suite.split_id}\` (\`${report.suite.sha256}\`). Run seed: \`${report.job_seed}\`.`,
    "",
    `Planning target: ${power.minimum_complete_pairs} complete task pairs (80% power at a 16 percentage point lift under the assumed paired sign-test model). Planned tasks: ${report.tasks.length}. Complete pairs: ${paired.pairs}. **${paired.underpowered ? "Underpowered: exploratory only." : "Meets planned complete-pair count."}**`,
    "",
    "| Arm | Verified / eligible | Solve rate (Wilson 95% CI) | Metered USD / verified solve | Median / p90 ms to verified patch |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...Object.entries(report.arms).map(
      ([arm, stats]) =>
        `| ${arm} | ${stats.solved} / ${stats.eligible} | ${pct(stats.solve_rate)} ${ci(stats.wilson_95)} | ${value(stats.metered_cost_per_verified_solve_usd)} | ${value(stats.median_time_to_verified_patch_ms)} / ${value(stats.p90_time_to_verified_patch_ms)} |`,
    ),
    "",
    `Paired difference (specialist − baseline): ${pct(paired.difference)} (approx. 95% CI ${ci(paired.ci_95)}, exact sign-test p = ${value(paired.sign_test_p_two_sided)}); ${paired.wins} wins, ${paired.losses} losses, ${paired.ties} ties; ${paired.excluded_provider_pairs} pairs excluded for provider failures.`,
    "",
    "## Failure and provider accounting",
    "",
    "An eligible trial is solved if the final tree verifies, even if the runtime fails or pauses afterward. The task table shows those runtime outcomes beside the verified patch.",
    "",
    "The solve-rate denominator excludes terminal provider failures; paired analysis excludes either-arm provider failures. Transient HTTP errors (including recovered retries) are counted separately in JSON. Metered cost includes successful and unsuccessful attempts, based on recorded runtime token counts (which may include estimates). Charges missing from the runtime ledger and hosting costs are not included. Times cover inference through the exact-tree check for solves only.",
    "",
    "| Arm | Attempts | Timeout | Rate limit | Server | Other provider | Other failures |",
    "| --- | ---: | ---: | ---: | ---: | ---: | --- |",
    ...Object.entries(report.arms).map(
      ([arm, stats]) =>
        `| ${arm} | ${stats.attempted} | ${stats.provider_errors.timeout} | ${stats.provider_errors.rate_limit} | ${stats.provider_errors.server_error} | ${stats.provider_errors.other_provider} | ${
          Object.entries(stats.failures)
            .map(([category, count]) => `${category}: ${count}`)
            .join(", ") || "—"
        } |`,
    ),
    "",
    "| Task | Baseline | Specialist |",
    "| --- | --- | --- |",
    ...report.tasks.map(({ task_id, outcomes }) => {
      const outcome = (result: typeof outcomes.baseline) => {
        if (result.solved)
          return result.status === "completed"
            ? "verified"
            : `verified (${result.failure ?? result.status})`;
        return result.provider_failure
          ? `provider: ${result.provider_failure}`
          : (result.category ?? "unsolved");
      };
      return `| ${task_id} | ${outcome(outcomes.baseline)} | ${outcome(outcomes.specialist)} |`;
    }),
    "",
    "## Routing recommendations (not production routing decisions)",
    "",
    "| Route (domain:role:complexity) | Complete pairs | Paired lift (95% CI) | Exact sign-test p (two-sided) | Recommendation | Reason |",
    "| --- | ---: | ---: | ---: | --- | --- |",
    ...report.routing.map(
      (row) =>
        `| ${row.route} | ${row.pairs} | ${pct(row.difference)} ${ci(row.ci_95)} | ${row.sign_test_p_two_sided ?? "—"} | ${row.recommendation} | ${row.reason} |`,
    ),
    "",
    "Untested routes stay on base. Review recommendations are exploratory by route and do not substitute for the registry's promotion gates.",
    "",
  ].join("\n");
}
