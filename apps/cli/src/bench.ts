import { readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { TrainingLineageView } from "@mars/datasets";
import {
  createScriptedEditModel,
  EDIT_BENCHMARK_SUITE_V2_DIR,
  type EditBenchmarkArm,
  editBenchmarkArms,
  editFormatEvidenceFromReport,
  loadEditBenchmarkSuite,
  parseEditBenchmarkArm,
  runEditBenchmark,
  SCRIPTED_PROFILES,
  scriptedModelRegistry,
  verifyEditBenchmarkReport,
} from "@mars/evaluation";
import type { EditFormatEvidence } from "@mars/execution";
import { loadModelRegistry } from "@mars/providers";
import { z } from "zod";
import { CliUsageError } from "./cli-errors";
import { LEARNING_BENCH_USAGE, runLearningBench } from "./learning-bench";

export const BENCH_USAGE = [
  "Usage: mars bench edit-formats (--offline [--profile small-model|oracle|patch-fluent|patch-hostile] | --live --model ID --max-usd N)",
  "         --out DIR [--arms mars:hashline,mars:replace,mars:apply_patch,omp-stock] [--repeats 3] [--suite DIR] [--repository NAME]",
  "         [--max-tokens N] [--max-tokens-per-task 1000000] [--max-usd-per-task N] [--max-duration-ms-per-task 300000]",
  "         [--training-lineage FILE]... [--signing-key-env NAME --signing-key-id ID] [--seed-salt TEXT]",
  "  Runs every task of the held-out edit suite in each MARS edit-format arm and in stock Oh My Pi (omp-stock)",
  "  with the same model, seed and per-task budget, then writes report.json (sha256, HMAC with a signing key),",
  "  report.md, trials.jsonl and raw transcripts under --out.",
  "  --offline uses deterministic scripted models (zero real model calls). --live calls the configured model",
  "  (~/.mars/models.json or $MARS_HOME/models.json: Ollama, OpenRouter, any OpenAI-compatible endpoint) and is",
  "  refused without --max-usd; the run is refused up front unless trials x per-task USD fits under it.",
  "",
  LEARNING_BENCH_USAGE,
].join("\n");

export class BenchUsageError extends CliUsageError {
  constructor(
    readonly code:
      | "usage"
      | "mode_required"
      | "budget_cap_required"
      | "model_required"
      | "model_unavailable"
      | "signing_key_missing"
      | "lineage_invalid",
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

const positiveInt = (
  flag: string,
  value: string | undefined,
  fallback?: number,
) => {
  if (value === undefined) {
    if (fallback === undefined)
      throw new BenchUsageError("usage", `${flag} is required.`);
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new BenchUsageError("usage", `${flag} must be a positive integer.`);
  return parsed;
};
const nonNegative = (flag: string, value: string) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0)
    throw new BenchUsageError(
      "usage",
      `${flag} must be a non-negative number.`,
    );
  return parsed;
};

const LineageSchema = z
  .object({
    task_ids: z.array(z.string()),
    requests: z.array(z.string()).optional(),
    request_sha256s: z.array(z.string()).optional(),
    dataset_sha256s: z.array(z.string()).optional(),
  })
  .passthrough();

/** `mars bench edit-formats`: the MARS-vs-omp edit-format benchmark. */
export async function runBench(
  args: string[],
  out: (line: string) => void = (line) => console.log(line),
  io: {
    env?: Record<string, string | undefined>;
    fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  } = {},
): Promise<void> {
  if (args[0] === "learning") return runLearningBench(args.slice(1), out, io);
  const env = io.env ?? process.env;
  const { values, positionals } = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: {
      offline: { type: "boolean" },
      live: { type: "boolean" },
      profile: { type: "string" },
      model: { type: "string" },
      "max-usd": { type: "string" },
      "max-tokens": { type: "string" },
      "max-usd-per-task": { type: "string" },
      "max-tokens-per-task": { type: "string" },
      "max-duration-ms-per-task": { type: "string" },
      repeats: { type: "string" },
      arms: { type: "string" },
      suite: { type: "string" },
      out: { type: "string" },
      repository: { type: "string" },
      "training-lineage": { type: "string", multiple: true },
      "signing-key-env": { type: "string" },
      "signing-key-id": { type: "string" },
      "seed-salt": { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help || positionals[0] !== "edit-formats") {
    out(BENCH_USAGE);
    if (!values.help && positionals.length > 0)
      throw new BenchUsageError("usage", `Unknown bench "${positionals[0]}".`);
    return;
  }
  if (values.live === values.offline)
    throw new BenchUsageError(
      "mode_required",
      "pass exactly one of --offline (scripted models) or --live (real model calls).",
    );
  if (!values.out) throw new BenchUsageError("usage", "--out DIR is required.");
  const live = values.live === true;
  if (live && values["max-usd"] === undefined)
    throw new BenchUsageError(
      "budget_cap_required",
      "--live needs an explicit --max-usd budget cap (use 0 for free models).",
    );
  if (live && !values.model)
    throw new BenchUsageError("model_required", "--live needs --model ID.");
  const signingKeyEnv = values["signing-key-env"];
  if (
    (signingKeyEnv === undefined) !==
    (values["signing-key-id"] === undefined)
  )
    throw new BenchUsageError(
      "usage",
      "--signing-key-env and --signing-key-id go together.",
    );
  let signer: { key_id: string; secret: Uint8Array } | undefined;
  if (signingKeyEnv && values["signing-key-id"]) {
    const secret = env[signingKeyEnv];
    if (!secret)
      throw new BenchUsageError(
        "signing_key_missing",
        `environment variable ${signingKeyEnv} is unset.`,
      );
    signer = {
      key_id: values["signing-key-id"],
      secret: new TextEncoder().encode(secret),
    };
  }
  const suite = await loadEditBenchmarkSuite(
    resolve(values.suite ?? EDIT_BENCHMARK_SUITE_V2_DIR),
  );
  const arms: EditBenchmarkArm[] = values.arms
    ? values.arms.split(",").map((arm) => {
        try {
          return parseEditBenchmarkArm(arm.trim());
        } catch (error) {
          throw new BenchUsageError("usage", (error as Error).message);
        }
      })
    : editBenchmarkArms();
  const repeats = positiveInt("--repeats", values.repeats, 3);
  const lineages: TrainingLineageView[] = [];
  for (const file of values["training-lineage"] ?? []) {
    try {
      const parsed = LineageSchema.parse(
        JSON.parse(await readFile(resolve(file), "utf8")),
      );
      lineages.push({
        task_ids: parsed.task_ids,
        ...(parsed.requests ? { requests: parsed.requests } : {}),
        ...(parsed.request_sha256s
          ? { request_sha256s: parsed.request_sha256s }
          : {}),
        ...(parsed.dataset_sha256s
          ? { dataset_sha256s: parsed.dataset_sha256s }
          : {}),
      });
    } catch {
      throw new BenchUsageError(
        "lineage_invalid",
        "--training-lineage must name JSON with task_ids (and optional requests, request_sha256s, dataset_sha256s).",
      );
    }
  }
  const outDir = resolve(values.out);
  const trials = suite.tasks.length * repeats * arms.length;
  let model: {
    registry: Awaited<ReturnType<typeof loadModelRegistry>>;
    env: Record<string, string | undefined>;
    modelId: string;
    fetch: (input: string, init?: RequestInit) => Promise<Response>;
    requests?: () => number;
  };
  let maxUsd: number;
  if (live) {
    maxUsd = nonNegative("--max-usd", values["max-usd"] as string);
    const registry = await loadModelRegistry({ cwd: process.cwd(), env });
    const modelId = values.model as string;
    const config = registry.getModel(modelId);
    if (!config)
      throw new BenchUsageError(
        "model_unavailable",
        `model ${modelId} is not in the model registry.`,
      );
    const unavailable = registry.unavailableReason(config.providerId);
    if (unavailable !== undefined)
      throw new BenchUsageError(
        "model_unavailable",
        `provider ${config.providerId} is unavailable (${unavailable}); set its API key variable or start its endpoint.`,
      );
    const transport = io.fetch ?? globalThis.fetch.bind(globalThis);
    model = { registry, env, modelId, fetch: transport };
  } else {
    const profile = SCRIPTED_PROFILES[values.profile ?? "small-model"];
    if (!profile)
      throw new BenchUsageError(
        "usage",
        `--profile must be one of ${Object.keys(SCRIPTED_PROFILES).join(", ")}.`,
      );
    const scripted = await scriptedModelRegistry(
      join(outDir, "scripted-model"),
      values.model ?? "scripted/small",
    );
    const fake = createScriptedEditModel({ tasks: suite.tasks, profile });
    model = { ...scripted, fetch: fake.fetch, requests: fake.requests };
    maxUsd =
      values["max-usd"] === undefined
        ? trials * 1
        : nonNegative("--max-usd", values["max-usd"]);
  }
  const perTaskUsd =
    values["max-usd-per-task"] === undefined
      ? maxUsd / trials
      : nonNegative("--max-usd-per-task", values["max-usd-per-task"]);
  const run = await runEditBenchmark({
    suite,
    arms,
    registry: model.registry,
    modelId: model.modelId,
    env: model.env,
    fetch: model.fetch,
    repeats,
    budgetPerTask: {
      max_tokens: positiveInt(
        "--max-tokens-per-task",
        values["max-tokens-per-task"],
        1_000_000,
      ),
      max_usd: perTaskUsd,
      max_duration_ms: positiveInt(
        "--max-duration-ms-per-task",
        values["max-duration-ms-per-task"],
        300_000,
      ),
    },
    maxTotalUsd: maxUsd,
    ...(values["max-tokens"] !== undefined
      ? { maxTotalTokens: positiveInt("--max-tokens", values["max-tokens"]) }
      : {}),
    repository: values.repository ?? basename(process.cwd()),
    outDir,
    simulated: !live,
    lineages,
    ...(signer ? { signer } : {}),
    ...(values["seed-salt"] !== undefined
      ? { seedSalt: values["seed-salt"] }
      : {}),
  });
  const verdict = run.report.verdict as {
    met: boolean;
    exploratory: boolean;
    summary: string;
  };
  out(
    JSON.stringify(
      {
        status: "completed",
        simulated: !live,
        report: run.files.report,
        markdown: run.files.markdown,
        report_sha256: run.report.report_sha256,
        signed: run.report.attestation !== undefined,
        trials: run.trials.length,
        model_requests: model.requests ? model.requests() : null,
        bar_met: verdict.met,
        exploratory: verdict.exploratory,
        verdict: verdict.summary,
      },
      null,
      2,
    ),
  );
}

/**
 * Loads every `*.json` benchmark report in `dir` for `mars serve`: each must
 * re-derive its digest (and verify its HMAC when `trust` is given) and is
 * reduced to edit-format selection evidence.
 */
export async function loadEditFormatEvidence(
  dir: string,
  trust?: { key_id: string; secret: Uint8Array },
): Promise<EditFormatEvidence[]> {
  const evidence: EditFormatEvidence[] = [];
  const names = (await readdir(dir))
    .filter((name) => name.endsWith(".json"))
    .sort();
  for (const name of names) {
    const report = verifyEditBenchmarkReport(
      JSON.parse(await readFile(join(dir, name), "utf8")),
      trust,
    );
    evidence.push(editFormatEvidenceFromReport(report));
  }
  return evidence;
}
