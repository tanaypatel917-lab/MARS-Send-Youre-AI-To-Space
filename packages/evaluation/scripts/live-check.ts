/**
 * Live verification against a real Harbor venv + Docker. Not part of `bun test`.
 *
 *   bun packages/evaluation/scripts/live-check.ts --venv /abs/.venv --jobs /abs/jobs \
 *     --image ghcr.io/laude-institute/terminal-bench/regex-log:2.0@sha256:<digest> \
 *     [--task regex-log] [--repeats 2] [--run]
 *
 * Without `--run` it only performs the `nop --dry-run` through the runner.
 * With `--run` it executes `nop` and `oracle` control arms for one task with
 * `-k <repeats>`, parses the real result.json files and prints an
 * EvaluationReport (control arms: nop stands in the baseline slot, oracle in
 * the candidate slot — they are verifier checks, NOT an agent comparison).
 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  buildEvaluationReport,
  createHarborRunner,
  DATASET_PINS,
  HARBOR_REGISTRY_REVISION,
  HARBOR_REGISTRY_SHA256,
  parseComparisonManifest,
  readHarborJob,
  sha256Hex,
} from "../src/index";

function arg(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`--${name} is required`);
  }
  return value;
}

const venv = resolve(arg("venv"));
const jobsDir = resolve(arg("jobs"));
const task = arg("task", "regex-log");
const repeats = Number(arg("repeats", "2"));
const image = arg("image");
const run = process.argv.includes("--run");
const registryPath = resolve(
  import.meta.dir,
  "..",
  "fixtures",
  "registry.tb2.json",
);
const pin = DATASET_PINS["terminal-bench-sample@2.0"];
const stamp = Date.now();

const manifest = parseComparisonManifest({
  schema: "mars.evaluation-comparison/v1",
  comparison_id: `live-${stamp}`,
  created_at: new Date(stamp).toISOString(),
  dataset: {
    name: pin.name,
    version: pin.version,
    registry: {
      url: "https://raw.githubusercontent.com/laude-institute/harbor/main/registry.json",
      revision: HARBOR_REGISTRY_REVISION,
      upstream_sha256: HARBOR_REGISTRY_SHA256,
      path: registryPath,
      sha256: sha256Hex(new Uint8Array(await readFile(registryPath))),
    },
    tasks_source: { git_url: pin.git_url, git_commit_id: pin.git_commit_id },
  },
  tasks: [task],
  repeats,
  arms: {
    baseline: { agent: "mini-swe-agent", version: "2.4.6" },
    candidate: {
      agent: "mars-oh-my-pi",
      candidate: {
        candidate_id: "live-control",
        components: {},
        parent_candidate_id: null,
        created_at: new Date(stamp).toISOString(),
      },
      bundle: { path: "/nonexistent", sha256: "0".repeat(64) },
    },
  },
  model: {
    id: "none",
    base_url: "http://127.0.0.1:9/v1",
    api_key_env: "MARS_EVAL_API_KEY",
    api_format: "openai_chat_completions",
  },
  environment: {
    type: "docker",
    images: [{ task_id: null, reference: image }],
  },
  python: { harbor_version: "0.25.0", mini_swe_agent_version: "2.4.6" },
  timeouts: { trial_timeout_ms: 1_800_000 },
  budget: {
    max_tokens: 1_000_000,
    max_usd: 0,
    max_duration_ms: 3_600_000,
    max_depth: 0,
    max_concurrency: 1,
  },
  per_trial: { max_tokens: 100_000, max_usd: 0 },
});

const runner = createHarborRunner({
  pythonPath: join(venv, "bin", "python"),
  harborPath: join(venv, "bin", "harbor"),
  agentPythonPath: resolve(import.meta.dir, "..", "python"),
  jobsDir,
});

console.log("probe:", JSON.stringify(await runner.probe()));
const dry = await runner.run({
  manifest,
  arm: "baseline",
  tasks: [task],
  repeats,
  jobName: `dry-${stamp}`,
  deadlineMs: Date.now() + 300_000,
  maxConcurrency: 1,
  controlAgent: "nop",
  dryRun: true,
});
console.log("dry-run argv:", dry.argv.slice(1).join(" "));
console.log(
  "dry-run exit:",
  dry.exit_code,
  "stdout:",
  dry.stdout_tail.trim().split("\n").slice(-3).join(" | "),
);
if (dry.exit_code !== 0) process.exit(1);
if (!run) process.exit(0);

const arms = { baseline: "nop", candidate: "oracle" } as const;
const outcomes = {} as Record<
  keyof typeof arms,
  Awaited<ReturnType<typeof runner.run>>
>;
for (const arm of ["baseline", "candidate"] as const) {
  outcomes[arm] = await runner.run({
    manifest,
    arm,
    tasks: [task],
    repeats,
    jobName: `${arms[arm]}-${stamp}`,
    deadlineMs: Date.now() + 1_800_000,
    maxConcurrency: 1,
    controlAgent: arms[arm],
  });
  console.log(
    `${arms[arm]}: exit=${outcomes[arm].exit_code} killed=${outcomes[arm].killed} dir=${outcomes[arm].job_dir}`,
  );
}
const parsed = {
  baseline: await readHarborJob(outcomes.baseline.job_dir),
  candidate: await readHarborJob(outcomes.candidate.job_dir),
};
const report = buildEvaluationReport(manifest, {
  baseline: {
    agent: {
      name: "nop",
      version: parsed.baseline.trials[0]?.agent.version ?? "?",
    },
    trials: parsed.baseline.trials,
    harbor: parsed.baseline.job.stats,
    unreadable_trials: parsed.baseline.unreadable_trials,
  },
  candidate: {
    agent: {
      name: "oracle",
      version: parsed.candidate.trials[0]?.agent.version ?? "?",
    },
    trials: parsed.candidate.trials,
    harbor: parsed.candidate.job.stats,
    unreadable_trials: parsed.candidate.unreadable_trials,
  },
});
const { trials: _trials, ...summary } = report;
console.log(JSON.stringify(summary, null, 2));
