import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "@mars/contracts/canonical";
import { requestSha256 } from "@mars/datasets";
import {
  assertLearningHoldout,
  loadLearningSuite,
  runLearningBenchmark,
  scriptedModelRegistry,
} from "@mars/evaluation";
import { runBench } from "./bench";

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function setup() {
  const repo = await mkdtemp(join(tmpdir(), "mars-learning-"));
  roots.push(repo);
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(
      [
        "git",
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        ...args,
      ],
      { cwd: repo },
    );
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  git("init", "-q");
  const paths = ["a.ts"];
  await Bun.write(join(repo, "a.ts"), "export const count = 0;\n");
  git("add", "a.ts");
  git("commit", "-qm", "initial");
  const parent = git("rev-parse", "HEAD");
  await Bun.write(join(repo, "a.ts"), "export const count = 1;\n");
  git("commit", "-qam", "correct initial count");
  const fix = git("rev-parse", "HEAD");
  const pin = {
    task_id: "correct-count",
    domain: "code/backend",
    complexity: "light",
    request: "Change the exported count in a.ts to 1.",
    paths,
    parent,
    fix,
  };
  const file = join(repo, "suite.json");
  await Bun.write(
    file,
    JSON.stringify({
      schema: "mars.learning-suite/v1",
      split_id: "learning-test",
      repository: "https://example.test/code",
      tasks: [pin],
    }),
  );
  return { repo, file, pin, suite: await loadLearningSuite(file, repo) };
}

test("learning CLI verifies the pinned fix and emits deterministic JSON and Markdown", async () => {
  const { repo, file, suite } = await setup();
  const args = ["learning", "--repo", repo, "--suite", file];
  const printed: string[] = [];
  await runBench([...args, "--print-suite-pin"], (line) => printed.push(line));
  expect(printed).toEqual([suite.sha256]);
  const run = async (name: string) => {
    const out = join(repo, name);
    await runBench(
      [...args, "--offline", "--seed", "test", "--out", out],
      () => {},
      {
        fetch: async () => {
          throw new Error("Unexpected network");
        },
      },
    );
    return {
      json: await readFile(join(out, "report.json"), "utf8"),
      markdown: await readFile(join(out, "report.md"), "utf8"),
    };
  };
  const first = await run("first");
  expect(await run("second")).toEqual(first);
  expect(JSON.parse(first.json)).toMatchObject({
    simulated: true,
    arms: {
      baseline: { solved: 0, eligible: 1, failures: { edit_tool: 1 } },
      specialist: { solved: 1, eligible: 1, wilson_95: { upper: 1 } },
    },
    paired: { pairs: 1, difference: 1, underpowered: true },
    routing: [
      {
        route: "code/backend:worker:light",
        recommendation: "stay_on_base",
        reason: "simulated",
      },
    ],
  });
  expect(first.markdown).toContain("SIMULATED");
  expect(first.markdown).toContain("Underpowered");
});

test("learning refuses condition overrides and normalized request leakage before dispatch", async () => {
  const { repo, suite, pin } = await setup();
  const binding = await scriptedModelRegistry(join(repo, "binding"));
  let calls = 0;
  const unused = {
    ...binding,
    fetch: async () => {
      calls++;
      throw new Error("should not run");
    },
  };
  const lineage = JSON.stringify({
    schema: "mars.specialist-dataset-lineage/v1",
    train_task_ids: ["different-id"],
    validation_task_ids: [],
    datasets: [{ sha256: "f".repeat(64) }],
    request_sha256s: [requestSha256(` ${pin.request.toUpperCase()}  `)],
    provenance: { synthetic_fixture: false },
  });
  const plan = {
    schema: "mars.learning-plan/v1",
    suite_sha256: suite.sha256,
    seed: "test",
    budget_per_task: {
      max_tokens: 10_000,
      max_usd: 1,
      max_duration_ms: 30_000,
    },
    max_total_usd: 2,
    arms: {
      baseline: { model: binding.modelId },
      specialist: {
        model: "scripted/adapter",
        lineage_sha256: sha256(lineage),
      },
    },
  };
  const run = (value: unknown) =>
    runLearningBenchmark({
      suite,
      plan: value,
      outDir: join(repo, "out"),
      mode: "live",
      binding: unused,
      lineage,
    });
  await expect(
    run({
      ...plan,
      arms: {
        ...plan.arms,
        baseline: { ...plan.arms.baseline, budget_per_task: {} },
      },
    }),
  ).rejects.toThrow("budget_per_task");
  await expect(run({ ...plan, max_total_usd: 1 })).rejects.toThrow(
    "total USD cap",
  );
  await expect(run({ ...plan, suite_sha256: "0".repeat(64) })).rejects.toThrow(
    "suite digest mismatch",
  );
  await expect(run(plan)).rejects.toThrow("correct-count:training-request");
  expect(() => assertLearningHoldout(suite, lineage, "0".repeat(64))).toThrow(
    "lineage digest mismatch",
  );
  expect(calls).toBe(0);
});

test("learning reports rate limits, 5xx and provider timeouts independently of patch failures", async () => {
  const { repo, suite } = await setup();
  const binding = await scriptedModelRegistry(join(repo, "binding"));
  const plan = {
    schema: "mars.learning-plan/v1",
    suite_sha256: suite.sha256,
    seed: "test",
    budget_per_task: {
      max_tokens: 10_000,
      max_usd: 1,
      max_duration_ms: 30_000,
    },
    max_total_usd: 2,
    arms: {
      baseline: { model: binding.modelId },
      specialist: { model: binding.modelId, lineage_sha256: "0".repeat(64) },
    },
  };
  const transport = (status: number) => async () =>
    new Response("mock unavailable", {
      status,
      headers: { "retry-after": "999" },
    });
  const run = (status: number) =>
    runLearningBenchmark({
      suite,
      plan,
      outDir: join(repo, "out"),
      mode: "offline",
      bindings: {
        baseline: { ...binding, fetch: transport(429) },
        specialist: { ...binding, fetch: transport(status) },
      },
    });
  const report = await run(503);
  expect(report.arms.baseline).toMatchObject({
    provider_errors: { rate_limit: 1 },
    eligible: 0,
    solve_rate: null,
    wilson_95: null,
    failures: {},
  });
  expect(report.arms.specialist).toMatchObject({
    provider_errors: { server_error: 1 },
    eligible: 0,
  });
  expect(report.paired).toMatchObject({
    pairs: 0,
    excluded_provider_pairs: 1,
    ci_95: null,
  });
  expect((await run(408)).arms.specialist.provider_errors.timeout).toBe(1);
});
