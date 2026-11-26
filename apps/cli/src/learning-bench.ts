import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  createScriptedEditModel,
  LEARNING_FIXTURE_SUITE,
  loadLearningSuite,
  renderLearningReport,
  runLearningBenchmark,
  SCRIPTED_PROFILES,
  scriptedModelRegistry,
} from "@mars/evaluation";
import { loadModelRegistry } from "@mars/providers";
import { CliUsageError } from "./cli-errors";

export const LEARNING_BENCH_USAGE = [
  "Usage: mars bench learning --offline --out DIR [--seed TEXT] [--repo CHECKOUT]",
  "       mars bench learning --live --out DIR --repo CHECKOUT --suite FILE --plan FILE --training-lineage FILE",
  "       mars bench learning --print-suite-pin --repo CHECKOUT --suite FILE",
].join("\n");

export async function runLearningBench(
  args: string[],
  out: (line: string) => void,
  io: {
    env?: Record<string, string | undefined>;
    fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  },
) {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: "boolean" },
      offline: { type: "boolean" },
      live: { type: "boolean" },
      "print-suite-pin": { type: "boolean" },
      out: { type: "string" },
      repo: { type: "string" },
      suite: { type: "string" },
      plan: { type: "string" },
      "training-lineage": { type: "string" },
      seed: { type: "string" },
    },
  });
  if (values.help || args.length === 0) {
    out(LEARNING_BENCH_USAGE);
    return;
  }
  if (
    [values.offline, values.live, values["print-suite-pin"]].filter(Boolean)
      .length !== 1 ||
    ((values.live || values["print-suite-pin"]) &&
      (!values.repo || !values.suite || values.seed !== undefined)) ||
    (values.live && (!values.plan || !values["training-lineage"])) ||
    (!values.live &&
      (values.plan !== undefined ||
        values["training-lineage"] !== undefined)) ||
    (!values["print-suite-pin"] && !values.out)
  )
    throw new CliUsageError(LEARNING_BENCH_USAGE);

  let suite: Awaited<ReturnType<typeof loadLearningSuite>>;
  try {
    suite = await loadLearningSuite(
      values.suite ?? LEARNING_FIXTURE_SUITE,
      resolve(values.repo ?? process.cwd()),
    );
  } catch (error) {
    throw new CliUsageError(
      `Could not validate the learning suite: ${error instanceof Error ? error.message : "invalid suite"}`,
    );
  }
  if (values["print-suite-pin"]) {
    out(suite.sha256);
    return;
  }
  const outDir = resolve(values.out as string);
  const common = { suite, outDir };
  const report = values.live
    ? await runLearningBenchmark({
        ...common,
        mode: "live",
        plan: JSON.parse(await readFile(values.plan as string, "utf8")),
        lineage: await readFile(values["training-lineage"] as string, "utf8"),
        binding: {
          registry: await loadModelRegistry({ env: io.env ?? process.env }),
          fetch: io.fetch ?? globalThis.fetch.bind(globalThis),
          ...(io.env ? { env: io.env } : {}),
        },
      })
    : await runOffline(common, values.seed ?? "mars-learning-offline-v1");
  const reportFile = join(outDir, "report.json");
  const markdownFile = join(outDir, "report.md");
  await Promise.all([
    writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, {
      mode: 0o600,
    }),
    writeFile(markdownFile, renderLearningReport(report), { mode: 0o600 }),
  ]);
  out(`Wrote ${reportFile} and ${markdownFile}`);
}

async function runOffline(
  common: {
    suite: Awaited<ReturnType<typeof loadLearningSuite>>;
    outDir: string;
  },
  seed: string,
) {
  const tasks = common.suite.tasks.map(({ task }) => task);
  const baseline = await scriptedModelRegistry(
    join(common.outDir, "fixture-baseline"),
    "scripted/base",
  );
  const specialist = await scriptedModelRegistry(
    join(common.outDir, "fixture-specialist"),
    "scripted/specialist",
  );
  const mock = (id: "patch-hostile" | "oracle") => {
    const profile = SCRIPTED_PROFILES[id];
    if (!profile) throw new Error("Missing learning fixture model.");
    return createScriptedEditModel({ tasks, profile }).fetch;
  };
  return runLearningBenchmark({
    ...common,
    mode: "offline",
    plan: {
      schema: "mars.learning-plan/v1",
      suite_sha256: common.suite.sha256,
      seed,
      budget_per_task: {
        max_tokens: 1_000_000,
        max_usd: 1,
        max_duration_ms: 30_000,
      },
      max_total_usd: 2 * tasks.length,
      arms: {
        baseline: { model: baseline.modelId },
        specialist: {
          model: specialist.modelId,
          lineage_sha256: "0".repeat(64),
        },
      },
    },
    bindings: {
      baseline: { ...baseline, fetch: mock("patch-hostile") },
      specialist: { ...specialist, fetch: mock("oracle") },
    },
  });
}
