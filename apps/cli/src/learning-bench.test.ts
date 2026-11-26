import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { sha256 } from "@mars/contracts/canonical";
import { requestSha256 } from "@mars/datasets";
import {
  assertLearningHoldout,
  createScriptedEditModel,
  loadLearningSuite,
  renderLearningReport,
  runLearningBenchmark,
  SCRIPTED_PROFILES,
  scriptedModelRegistry,
} from "@mars/evaluation";
import { runBench } from "./bench";

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function setup(fileChanges = false) {
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
  if (fileChanges) {
    await Bun.write(join(repo, "gone.ts"), "");
    git("add", "gone.ts");
    paths.push("gone.ts", "new.ts");
  }
  git("commit", "-qm", "initial");
  const parent = git("rev-parse", "HEAD");
  await Bun.write(join(repo, "a.ts"), "export const count = 1;\n");
  if (fileChanges) {
    git("rm", "gone.ts");
    await Bun.write(join(repo, "new.ts"), "\uFEFFexport const newCount = 1;");
    git("add", "new.ts");
  }
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
  const journal = join(
    repo,
    "first",
    "transcripts",
    "baseline",
    "mars_apply_patch",
    "correct-count",
    "0.jsonl",
  );
  const originalJournal = await readFile(journal, "utf8");
  await expect(run("first")).rejects.toThrow(
    "Use a fresh benchmark output directory",
  );
  expect(await readFile(journal, "utf8")).toBe(originalJournal);
  const report = JSON.parse(first.json);
  const { baseline, specialist } = report.tasks[0].outcomes;
  expect(baseline.transcript).not.toBe(specialist.transcript);
  for (const { transcript } of [baseline, specialist])
    expect(await readFile(join(repo, "first", transcript), "utf8")).not.toBe(
      "",
    );
  expect(report).toMatchObject({
    simulated: true,
    arms: {
      baseline: { solved: 0, eligible: 1, failures: { edit_tool: 1 } },
      specialist: { solved: 1, eligible: 1, wilson_95: { upper: 1 } },
    },
    paired: { pairs: 1, difference: 1, underpowered: true },
    routing: [
      {
        route: "code/backend:worker:light",
        sign_test_p_two_sided: 1,
        recommendation: "stay_on_base",
        reason: "simulated",
      },
    ],
  });
  expect(first.markdown).toContain("SIMULATED");
  expect(first.markdown).toContain("Underpowered");
  expect(first.markdown).toContain("Exact sign-test p (two-sided)");
  expect(first.markdown).toMatch(
    /\| code\/backend:worker:light \| 1 \| [^|]+ \| 1 \| stay_on_base \| simulated \|/,
  );
});

test("learning offline specialist verifies added and deleted files byte for byte", async () => {
  const { repo, file } = await setup(true);
  const out = join(repo, "out");
  await runBench(
    ["learning", "--repo", repo, "--suite", file, "--offline", "--out", out],
    () => {},
  );
  const report = JSON.parse(await readFile(join(out, "report.json"), "utf8"));
  expect(report.tasks[0].outcomes.specialist.verification).toMatchObject({
    solved: true,
    missing: [],
    unexpected: [],
    mismatched: [],
  });
});

test("learning live CLI dispatches both pinned checkpoints through one registry after validating lineage", async () => {
  const { repo, file, suite } = await setup();
  const marsHome = join(repo, "registry");
  await mkdir(marsHome);
  const checkpoints = { baseline: "base-pinned", specialist: "adapter-pinned" };
  const modelId = (arm: string) => `fixture/${arm}`;
  await Bun.write(
    join(marsHome, "models.json"),
    JSON.stringify({
      version: 1,
      providers: [
        {
          id: "fixture",
          kind: "openai-compatible",
          baseUrl: "https://models.invalid/v1",
          apiKeyEnv: "MARS_FIXTURE_KEY",
        },
      ],
      models: Object.entries(checkpoints).map(([arm, model]) => ({
        id: modelId(arm),
        providerId: "fixture",
        model,
        capabilities: { tools: true, vision: false, contextWindow: 1_000_000 },
        pricing: { free: true, inputPerMTokUsd: 0, outputPerMTokUsd: 0 },
      })),
      routes: { default: [modelId("baseline")] },
    }),
  );
  const lineage = JSON.stringify({
    schema: "mars.specialist-dataset-lineage/v1",
    train_task_ids: ["other-task"],
    validation_task_ids: [],
    datasets: [{ sha256: "f".repeat(64) }],
    request_sha256s: [requestSha256("Unrelated training request")],
    provenance: { synthetic_fixture: false },
  });
  const lineagePath = join(repo, "lineage.json");
  const planPath = join(repo, "plan.json");
  const out = join(repo, "live");
  await Bun.write(lineagePath, lineage);
  await Bun.write(
    planPath,
    JSON.stringify({
      schema: "mars.learning-plan/v1",
      suite_sha256: suite.sha256,
      seed: "live-test",
      budget_per_task: {
        max_tokens: 10_000,
        max_usd: 1,
        max_duration_ms: 30_000,
      },
      max_total_usd: 2,
      arms: {
        baseline: { model: modelId("baseline") },
        specialist: {
          model: modelId("specialist"),
          lineage_sha256: sha256(lineage),
        },
      },
    }),
  );
  const profile = SCRIPTED_PROFILES.oracle;
  if (!profile) throw new Error("Missing oracle fixture");
  const mock = createScriptedEditModel({
    tasks: suite.tasks.map(({ task }) => task),
    profile,
  });
  const requested = new Set<string>();
  await runBench(
    [
      "learning",
      "--live",
      "--repo",
      repo,
      "--suite",
      file,
      "--plan",
      planPath,
      "--training-lineage",
      lineagePath,
      "--out",
      out,
    ],
    () => {},
    {
      env: { MARS_HOME: marsHome, MARS_FIXTURE_KEY: "not-a-secret" },
      fetch: async (url, init) => {
        expect(url).toBe("https://models.invalid/v1/chat/completions");
        requested.add(JSON.parse(String(init?.body)).model);
        return mock.fetch(url, init);
      },
    },
  );
  expect(requested).toEqual(new Set(Object.values(checkpoints)));
  expect(
    JSON.parse(await readFile(join(out, "report.json"), "utf8")),
  ).toMatchObject({
    simulated: false,
    arms: { baseline: { solved: 1 }, specialist: { solved: 1 } },
    paired: { pairs: 1, excluded_provider_pairs: 0 },
  });
});

test("learning suite refuses missing objects rather than fetching from a promisor remote", async () => {
  const { repo, file, pin } = await setup();
  const partial = join(repo, "partial");
  const clone = Bun.spawnSync([
    "git",
    "-c",
    "protocol.file.allow=always",
    "clone",
    "--no-checkout",
    "--filter=blob:none",
    "--upload-pack=git -c uploadpack.allowFilter=true upload-pack",
    pathToFileURL(repo).href,
    partial,
  ]);
  if (clone.exitCode !== 0) throw new Error(clone.stderr.toString());
  const blob = Bun.spawnSync(["git", "rev-parse", `${pin.parent}:a.ts`], {
    cwd: repo,
  })
    .stdout.toString()
    .trim();
  const hasBlobLocally = () =>
    Bun.spawnSync(["git", "cat-file", "-e", blob], {
      cwd: partial,
      env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "" },
    }).exitCode === 0;
  expect(hasBlobLocally()).toBe(false);
  await expect(loadLearningSuite(file, partial)).rejects.toThrow(
    "Cannot read pinned Git object (cat-file)",
  );
  expect(hasBlobLocally()).toBe(false);
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
  const run = (
    status: number,
    fetch = transport(status),
    baselineFetch = transport(429),
  ) =>
    runLearningBenchmark({
      suite,
      plan,
      outDir: join(repo, `out-${status}`),
      mode: "offline",
      bindings: {
        baseline: { ...binding, fetch: baselineFetch },
        specialist: { ...binding, fetch },
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
  expect(renderLearningReport(report)).toContain(
    "| code/backend:worker:light | 0 | — — | — | stay_on_base | simulated |",
  );
  expect((await run(408)).arms.specialist.provider_errors.timeout).toBe(1);
  const truncated = await run(
    200,
    async () => {
      const frame = JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  function: {
                    name: "mars_apply_patch",
                    arguments: '{"patch":',
                  },
                },
              ],
            },
            finish_reason: "length",
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 100 },
      });
      return new Response(`data: ${frame}\n\ndata: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    },
    async () =>
      new Response(
        'data: {"choices":[{"delta":{"content":"No changes"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } },
      ),
  );
  expect(truncated.arms.specialist).toMatchObject({
    eligible: 1,
    solved: 0,
  });
  expect(truncated.tasks[0]?.outcomes.specialist).toMatchObject({
    status: "paused",
    failure: null,
    provider_failure: null,
    turns: 1,
  });
  expect(truncated.paired).toMatchObject({
    pairs: 1,
    excluded_provider_pairs: 0,
  });
});

test.each(["stop", "length"] as const)(
  "learning reports a verified patch separately from a final empty %s",
  async (finishReason) => {
    const { repo, suite } = await setup();
    const binding = await scriptedModelRegistry(join(repo, "binding"));
    const stream = (delta: object, finish: string) =>
      new Response(
        `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    const trial = (complete: boolean) => ({
      ...binding,
      fetch: async (_url: string, init?: RequestInit) => {
        const { messages } = JSON.parse(String(init?.body)) as {
          messages: { role: string }[];
        };
        if (messages.some(({ role }) => role === "tool")) {
          return complete
            ? stream({ content: "Done." }, "stop")
            : stream({}, finishReason);
        }
        return stream(
          {
            tool_calls: [
              {
                index: 0,
                id: "correct_patch",
                type: "function",
                function: {
                  name: "mars_apply_patch",
                  arguments: JSON.stringify({
                    patch: [
                      "*** Begin Patch",
                      "*** Update File: a.ts",
                      "@@",
                      "-export const count = 0;",
                      "+export const count = 1;",
                      "*** End Patch",
                    ].join("\n"),
                  }),
                },
              },
            ],
          },
          "tool_calls",
        );
      },
    });
    const report = await runLearningBenchmark({
      suite,
      outDir: join(repo, "out"),
      mode: "offline",
      plan: {
        schema: "mars.learning-plan/v1",
        suite_sha256: suite.sha256,
        seed: "test",
        budget_per_task: {
          max_tokens: 100_000,
          max_usd: 1,
          max_duration_ms: 30_000,
        },
        max_total_usd: 2,
        arms: {
          baseline: { model: binding.modelId },
          specialist: {
            model: binding.modelId,
            lineage_sha256: "0".repeat(64),
          },
        },
      },
      bindings: { baseline: trial(true), specialist: trial(false) },
    });
    expect(report.tasks[0]?.outcomes).toMatchObject({
      baseline: {
        status: "completed",
        solved: true,
        verification: { solved: true },
      },
      specialist: {
        status: finishReason === "stop" ? "failed" : "paused",
        failure: finishReason === "stop" ? "no_response" : null,
        turns: finishReason === "stop" ? 5 : 2,
        solved: true,
        verification: { solved: true, changed: ["a.ts"] },
        category: null,
        provider_failure: null,
      },
    });
    expect(report.arms.baseline).toMatchObject({ eligible: 1, solved: 1 });
    expect(report.arms.specialist).toMatchObject({ eligible: 1, solved: 1 });
    expect(report.paired).toMatchObject({
      pairs: 1,
      excluded_provider_pairs: 0,
      ties: 1,
    });
    const runtime = finishReason === "stop" ? "no_response" : "paused";
    expect(renderLearningReport(report)).toContain(
      `| correct-count | verified | verified (${runtime}) |`,
    );
  },
);
