import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findHeldOutLeakage } from "@mars/datasets";
import { selectEditFormat } from "@mars/execution";
import {
  bootstrapRatio,
  createScriptedEditModel,
  EDIT_BENCHMARK_SUITE_V1_DIR,
  EDIT_BENCHMARK_SUITE_V2_DIR,
  EDIT_TASK_CATEGORIES,
  type EditBenchmarkArm,
  type EditBenchmarkSuite,
  editBenchmarkArms,
  editFormatEvidenceFromReport,
  exactSignTest,
  holmAdjust,
  loadEditBenchmarkSuite,
  MIN_POWERED_TASKS,
  minimumPoweredTasks,
  POWER_DESIGN,
  parseEditBenchmarkArm,
  parseReadResult,
  runEditBenchmark,
  runEditTrial,
  SCRIPTED_PROFILES,
  type ScriptedModelProfile,
  scriptedModelRegistry,
  signTestPower,
  stockToolPaths,
  verifyEditBenchmarkReport,
  verifyWorkspace,
  wilsonInterval,
} from "./index";

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});
const scratch = async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-edit-bench-"));
  roots.push(root);
  return root;
};
const suite = await loadEditBenchmarkSuite(EDIT_BENCHMARK_SUITE_V1_DIR);
const budget = { max_tokens: 400_000, max_usd: 1, max_duration_ms: 60_000 };

async function offlineRun(
  profile: string,
  options: {
    repeats?: number;
    tasks?: number;
    signer?: { key_id: string; secret: Uint8Array };
    arms?: EditBenchmarkArm[];
    suite?: EditBenchmarkSuite;
  } = {},
) {
  const root = await scratch();
  const { registry, env, modelId } = await scriptedModelRegistry(root);
  const from = options.suite ?? suite;
  const picked = {
    ...from,
    tasks: from.tasks.slice(0, options.tasks ?? from.tasks.length),
  };
  const model = createScriptedEditModel({
    tasks: from.tasks,
    profile: SCRIPTED_PROFILES[profile] as ScriptedModelProfile,
  });
  const repeats = options.repeats ?? 1;
  const arms = options.arms ?? ["mars:apply_patch", "omp-stock"];
  const run = await runEditBenchmark({
    suite: picked,
    arms,
    registry,
    env,
    modelId,
    fetch: model.fetch,
    repeats,
    budgetPerTask: budget,
    maxTotalUsd: picked.tasks.length * repeats * arms.length,
    repository: "mars-repo",
    outDir: join(root, "out"),
    simulated: true,
    ...(options.signer ? { signer: options.signer } : {}),
    now: () => new Date("2026-11-14T12:00:00.000Z"),
  });
  return { run, model, root };
}

test("the curated suite loads as a held-out split covering every category with provenance", () => {
  expect(suite.tasks).toHaveLength(10);
  expect(new Set(suite.tasks.map((task) => task.category))).toEqual(
    new Set(EDIT_TASK_CATEGORIES),
  );
  expect(suite.split.schema).toBe("mars.held-out-split/v1");
  expect(suite.split.tasks.map((task) => task.request)).toEqual(
    suite.tasks.map((task) => task.instruction),
  );
  for (const task of suite.tasks)
    expect(task.provenance.origin).toBe("authored");
  expect(suite.sha256).toMatch(/^[a-f0-9]{64}$/);
});

test("statistics: exact sign test, Wilson interval and seeded bootstrap", () => {
  expect(exactSignTest(10, 0).p_two_sided).toBeCloseTo(2 / 1024, 12);
  expect(exactSignTest(5, 5).p_two_sided).toBe(1);
  expect(exactSignTest(0, 0).p_two_sided).toBe(1);
  expect(exactSignTest(8, 2).p_two_sided).toBeCloseTo(0.109375, 9);
  const w = wilsonInterval(7, 10);
  expect(w.lower).toBeGreaterThan(0.39);
  expect(w.upper).toBeLessThan(0.9);
  const units = [
    { numerator: 3, denominator: 1 },
    { numerator: 5, denominator: 1 },
    { numerator: 4, denominator: 0 },
  ];
  const a = bootstrapRatio(units, { seed: "s" });
  expect(a).toEqual(bootstrapRatio(units, { seed: "s" }));
  expect(a.estimate).toBe(6);
  expect(a.low as number).toBeLessThanOrEqual(6);
  expect(a.high as number).toBeGreaterThanOrEqual(6);
  expect(
    bootstrapRatio([{ numerator: 1, denominator: 0 }], { seed: "s" }).estimate,
  ).toBeNull();
});

test("arms derive from the MARS format table plus omp-stock", () => {
  expect(editBenchmarkArms()).toEqual([
    "mars:hashline",
    "mars:replace",
    "mars:apply_patch",
    "omp-stock",
  ]);
  expect(parseEditBenchmarkArm("omp-stock")).toBe("omp-stock");
  expect(() => parseEditBenchmarkArm("mars:sed")).toThrow("Unknown arm");
});

test("offline end to end: scripted small model, both arms, sealed report, transcripts, zero real calls", async () => {
  const signer = {
    key_id: "bench",
    secret: new TextEncoder().encode("bench-secret-not-real"),
  };
  const { run, model } = await offlineRun("small-model", { signer });
  expect(run.trials).toHaveLength(20);
  expect(model.requests()).toBeGreaterThan(40);
  const arms = run.report.arms as Array<Record<string, unknown>>;
  expect(arms.map((arm) => arm.arm)).toEqual(["mars:apply_patch", "omp-stock"]);
  for (const arm of arms) {
    expect(arm.trials).toBe(10);
    expect(arm).toHaveProperty("solve_rate_wilson95");
    expect(arm).toHaveProperty("edit_failure_rate");
    expect(arm).toHaveProperty("cost_per_verified_solve_usd");
    expect(arm.network_refusals).toBe(0);
  }
  expect(arms[1]?.edit_modes as string[]).toEqual(["hashline"]);
  expect(run.trials.some((trial) => trial.edit_failures > 0)).toBe(true);
  // Every request of both arms for one (task, repeat) carried the same seed.
  for (const task of suite.tasks) {
    const seeds = new Set(
      run.trials.filter((t) => t.task_id === task.task_id).map((t) => t.seed),
    );
    expect(seeds.size).toBe(1);
  }
  expect(model.seeds().every((seed) => Number.isSafeInteger(seed))).toBe(true);
  // Sealed: digest and HMAC verify; any edit breaks them.
  const onDisk = JSON.parse(await readFile(run.files.report, "utf8"));
  expect(verifyEditBenchmarkReport(onDisk, signer).report_sha256).toBe(
    run.report.report_sha256,
  );
  expect(() => verifyEditBenchmarkReport({ ...onDisk, repeats: 9 })).toThrow(
    "report_digest_mismatch",
  );
  expect(() =>
    verifyEditBenchmarkReport(onDisk, {
      ...signer,
      secret: new TextEncoder().encode("other"),
    }),
  ).toThrow("report_signature_invalid");
  expect(run.markdown).toContain("SIMULATED");
  expect(run.markdown).toContain("Pre-registered bar");
  for (const trial of run.trials) {
    expect(trial.transcript).not.toBeNull();
    expect(
      (await stat(join(run.files.transcripts, trial.transcript as string)))
        .size,
    ).toBeGreaterThan(0);
  }
  expect(
    (await readFile(run.files.trials, "utf8")).trim().split("\n"),
  ).toHaveLength(20);
}, 120_000);

test("scripted reads recognize outlines and plain or anchored MARS pages", () => {
  const outline = parseReadResult(
    "a.ts: 100 lines, 25000 bytes. Outlined because file exceeds the 24576-byte summary threshold.\nHeuristic outline (not AST-exact):\n1-100: export class A\n\nHead (1 requested lines; bounded preview):\n1: export class A {\n\nCall mars_read with path, offset",
  );
  expect(outline.complete).toBe(false);
  expect(outline.content).toBeNull();
  expect(outline.lines.get(1)).toBe("export class A {");
  const plain = parseReadResult(
    "a.ts · lines 2-2 of 3\nbody\n[continue with offset=3]",
  );
  expect(plain.complete).toBe(false);
  expect(plain.lines.get(2)).toBe("body");
  const anchored = parseReadResult("a.ts · lines 1-1 of 1\n1:abc|body");
  expect(anchored.complete).toBe(true);
  expect(anchored.content).toBe("body\n");
  expect(parseReadResult("").content).toBe("");
  expect(parseReadResult("a.ts · lines 1-0 of 0\n").complete).toBe(false);
});

test("below the power minimum the run is exploratory and no verdict is computed", async () => {
  // The scripted model's static default format is hashline: the confirmatory arm.
  const fluent = await offlineRun("default-fluent", {
    arms: ["mars:hashline", "omp-stock"],
  });
  expect(fluent.run.report.verdict).toMatchObject({
    candidate: "mars:hashline",
    confirmatory_arm: "mars:hashline",
    confirmatory_reason: "static_default",
    exploratory: true,
    suite_tasks: 10,
    min_powered_tasks: MIN_POWERED_TASKS,
    solve_rate_better: true,
    significant: false,
    met: false,
  });
  expect(fluent.run.markdown).toContain("EXPLORATORY (no verdict)");
  expect(
    (fluent.run.report.paired as { candidate_only: string[] }).candidate_only,
  ).toHaveLength(10);
  const hostile = await offlineRun("default-hostile", {
    arms: ["mars:hashline", "omp-stock"],
  });
  expect(hostile.run.report.verdict).toMatchObject({
    met: false,
    solve_rate_better: false,
  });
  expect(
    (hostile.run.report.paired as { baseline_only: string[] }).baseline_only,
  ).toHaveLength(10);
  const oracle = await offlineRun("oracle", {
    tasks: 3,
    repeats: 2,
    arms: ["mars:hashline", "omp-stock"],
  });
  expect(oracle.run.report.verdict).toMatchObject({ met: false });
  expect(
    (oracle.run.report.paired as { both_solved: number }).both_solved,
  ).toBe(3);
}, 180_000);

const suiteV2 = await loadEditBenchmarkSuite(EDIT_BENCHMARK_SUITE_V2_DIR);

test("on the powered v2 suite the pre-registered verdict is computed whichever way it goes", async () => {
  const fluent = await offlineRun("default-fluent", {
    suite: suiteV2,
    arms: ["mars:hashline", "omp-stock"],
  });
  expect(fluent.run.report.verdict).toMatchObject({
    candidate: "mars:hashline",
    confirmatory_arm: "mars:hashline",
    exploratory: false,
    suite_tasks: suiteV2.tasks.length,
    met: true,
    significant: true,
  });
  expect(fluent.run.markdown).not.toContain("EXPLORATORY");
}, 240_000);

test("exact sign-test power and the pre-registered minimum suite size", () => {
  // Every task discordant and favouring MARS: 10-0 rejects (p = 0.00195),
  // 5-0 cannot (p = 0.0625).
  expect(signTestPower(10, 1, 1)).toBeCloseTo(1, 12);
  expect(signTestPower(5, 1, 1)).toBe(0);
  // 6 tasks all discordant at a 70% share: only 6-0 rejects (p = 0.03125).
  expect(signTestPower(6, 1, 0.7)).toBeCloseTo(0.7 ** 6, 12);
  expect(signTestPower(129, 0.4, 0.7)).toBeGreaterThanOrEqual(0.8);
  expect(
    minimumPoweredTasks(POWER_DESIGN.discordance, POWER_DESIGN.share, {
      alpha: POWER_DESIGN.alpha,
      target: POWER_DESIGN.target,
    }),
  ).toBe(MIN_POWERED_TASKS);
});

test("v2 is a powered, disjoint, provenance-recorded suite of real public code", () => {
  expect(suiteV2.tasks.length).toBeGreaterThanOrEqual(MIN_POWERED_TASKS);
  expect(new Set(suiteV2.tasks.map((task) => task.category))).toEqual(
    new Set(EDIT_TASK_CATEGORIES),
  );
  expect(
    new Set(suiteV2.sources.map((source) => source.language)).size,
  ).toBeGreaterThanOrEqual(5);
  const sources = new Map(
    suiteV2.sources.map((source) => [source.repository, source]),
  );
  for (const task of suiteV2.tasks) {
    const source = task.provenance.source;
    expect(source).toBeDefined();
    expect(sources.get(source?.repository ?? "")).toMatchObject({
      commit: source?.commit,
      license: source?.license,
    });
    expect(task.before.has(source?.path ?? "")).toBe(true);
  }
  const v1Ids = new Set(suite.tasks.map((task) => task.task_id));
  expect(suiteV2.tasks.some((task) => v1Ids.has(task.task_id))).toBe(false);
  expect(
    findHeldOutLeakage((({ sha256: _, ...split }) => split)(suiteV2.split), {
      task_ids: suite.tasks.map((task) => task.task_id),
    }),
  ).toEqual([]);
});

test("mars:hashline and mars:replace drive the real mars_edit / mars_replace tools", async () => {
  const { run } = await offlineRun("oracle", {
    tasks: 4,
    arms: ["mars:hashline", "mars:replace", "omp-stock"],
  });
  const arms = run.report.arms as Array<Record<string, unknown>>;
  expect(arms.map((arm) => [arm.arm, arm.verified_solves])).toEqual([
    ["mars:hashline", 4],
    ["mars:replace", 4],
    ["omp-stock", 4],
  ]);
  expect(arms[0]?.edit_modes).toEqual(["hashline"]);
  expect(arms[1]?.edit_modes).toEqual(["replace"]);
  for (const trial of run.trials.filter((t) => t.arm !== "omp-stock")) {
    expect(trial.edit_calls).toBeGreaterThan(0);
    const transcript = await readFile(
      join(run.files.transcripts, trial.transcript as string),
      "utf8",
    );
    const tool = trial.arm === "mars:hashline" ? "mars_edit" : "mars_replace";
    expect(transcript).toContain(`"toolName":"${tool}"`);
  }
}, 180_000);

test("replace oracle preserves a UTF-8 BOM when editing a later line", async () => {
  const root = await scratch();
  const starter = suite.tasks[0];
  if (!starter) throw new Error("Missing starter task");
  const encoder = new TextEncoder();
  const path = "bom.ts";
  const task = {
    ...starter,
    instruction: "In bom.ts, change the count to 2.",
    before: new Map([
      [
        path,
        encoder.encode(
          "\uFEFF// Keep this header\nconst other = 0;\nconst count = 1;\n",
        ),
      ],
    ]),
    after: new Map([
      [
        path,
        encoder.encode(
          "\uFEFF// Keep this header\nconst other = 0;\nconst count = 2;\n",
        ),
      ],
    ]),
  };
  const binding = await scriptedModelRegistry(root);
  const model = createScriptedEditModel({
    tasks: [task],
    profile: SCRIPTED_PROFILES.oracle as ScriptedModelProfile,
  });
  const trial = await runEditTrial({
    ...binding,
    arm: "mars:replace",
    task,
    repeat: 0,
    seed: 1,
    budget,
    fetch: model.fetch,
    workRoot: join(root, "work"),
    transcriptRoot: join(root, "tx"),
  });
  expect(trial.verification).toMatchObject({ solved: true, mismatched: [] });
});

test("hashline oracle pages for anchors even when outline preview text includes the edit", async () => {
  const root = await scratch();
  const task = suiteV2.tasks.find((task) => task.task_id === "sds-rename-2");
  if (!task) throw new Error("Missing outline-preview regression task");
  const { registry, env, modelId } = await scriptedModelRegistry(root);
  const model = createScriptedEditModel({
    tasks: [task],
    profile: SCRIPTED_PROFILES.oracle as (typeof SCRIPTED_PROFILES)[string],
  });
  const transcriptRoot = join(root, "tx");
  const result = await runEditTrial({
    arm: "mars:hashline",
    task,
    repeat: 0,
    registry,
    env,
    modelId,
    seed: 1,
    budget,
    fetch: model.fetch,
    workRoot: join(root, "work"),
    transcriptRoot,
  });
  expect(result.solved).toBe(true);
  expect(result.edit_failures).toBe(0);
  if (!result.transcript) throw new Error("Missing oracle transcript");
  const transcript = await readFile(
    join(transcriptRoot, result.transcript),
    "utf8",
  );
  expect(transcript).toContain("Outlined because file exceeds");
  expect(transcript).toContain('"offset":');
}, 60_000);

test("a rejected edit the model then retries counts as an edit failure, not a lost solve", async () => {
  const { run } = await offlineRun("recovering", {
    arms: ["mars:hashline", "mars:replace", "mars:apply_patch", "omp-stock"],
  });
  const hashline = run.trials.filter((t) => t.arm === "mars:hashline");
  expect(hashline).toHaveLength(suite.tasks.length);
  for (const trial of hashline) {
    // A stale anchor is rejected with recovery anchors; the retry solves.
    expect(trial.solved).toBe(true);
    expect(trial.edit_failures).toBeGreaterThanOrEqual(1);
    expect(trial.edit_calls).toBeGreaterThan(trial.edit_failures);
  }
  const summary = (run.report.arms as Array<Record<string, unknown>>).find(
    (arm) => arm.arm === "mars:hashline",
  );
  expect(summary?.verified_solves).toBe(suite.tasks.length);
  expect(summary?.edit_failure_rate).toBeGreaterThan(0);
  for (const arm of ["mars:replace", "mars:apply_patch"])
    expect(
      run.trials.filter((t) => t.arm === arm && t.solved).length,
    ).toBeGreaterThan(0);
}, 240_000);

test("selection evidence comes from a verified report; simulated reports only decide when allowed", async () => {
  const { run } = await offlineRun("patch-fluent", { tasks: 2 });
  const evidence = editFormatEvidenceFromReport(
    verifyEditBenchmarkReport(run.report),
  );
  expect(evidence).toMatchObject({
    model_id: "scripted/small",
    repository: "mars-repo",
    simulated: true,
  });
  expect(evidence.arms.map((arm) => arm.format)).toEqual(["apply_patch"]);
  const input = {
    modelId: "scripted/small",
    repository: "mars-repo",
    evidence: [evidence],
  };
  expect(selectEditFormat(input).source).toBe("static_default");
  expect(selectEditFormat({ ...input, allowSimulated: true })).toMatchObject({
    source: "benchmark",
    format: "apply_patch",
    report_sha256: run.report.report_sha256,
  });
}, 60_000);

test("refusals: missing baseline, budget cap too low, held-out leakage", async () => {
  const root = await scratch();
  const { registry, env, modelId } = await scriptedModelRegistry(root);
  const model = createScriptedEditModel({
    tasks: suite.tasks,
    profile: SCRIPTED_PROFILES.oracle as (typeof SCRIPTED_PROFILES)[string],
  });
  const base = {
    suite,
    registry,
    env,
    modelId,
    fetch: model.fetch,
    repeats: 1,
    budgetPerTask: budget,
    repository: "r",
    outDir: join(root, "out"),
    simulated: true,
  };
  await expect(
    runEditBenchmark({ ...base, arms: ["mars:apply_patch"], maxTotalUsd: 100 }),
  ).rejects.toThrow("omp-stock baseline arm is required");
  await expect(
    runEditBenchmark({ ...base, arms: editBenchmarkArms(), maxTotalUsd: 5 }),
  ).rejects.toThrow("budget_cap_too_low");
  await expect(
    runEditBenchmark({
      ...base,
      arms: editBenchmarkArms(),
      maxTotalUsd: 100,
      lineages: [
        { task_ids: [], requests: [suite.tasks[3]?.instruction as string] },
      ],
    }),
  ).rejects.toThrow("heldout_leakage");
  expect(model.requests()).toBe(0);
});

test("omp-stock tool calls naming paths outside the throwaway workspace are refused", async () => {
  expect(stockToolPaths("read", { path: "src/a.ts:10-20" })).toEqual([
    "src/a.ts",
  ]);
  expect(
    stockToolPaths("edit", {
      input: "[../escape.ts#ABCD]\nPUT 1.=1:\n+x\nMV /tmp/x",
    }),
  ).toEqual(["../escape.ts", "/tmp/x"]);
  const root = await scratch();
  const { registry, env, modelId } = await scriptedModelRegistry(root);
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    const delta =
      calls === 1
        ? {
            tool_calls: [
              {
                index: 0,
                id: "c1",
                type: "function",
                function: {
                  name: "read",
                  arguments: JSON.stringify({ path: "/etc/hostname" }),
                },
              },
            ],
          }
        : { content: "Done." };
    return new Response(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: calls === 1 ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    );
  };
  const result = await runEditTrial({
    arm: "omp-stock",
    task: suite.tasks[2] as (typeof suite.tasks)[number],
    repeat: 0,
    registry,
    env,
    modelId,
    seed: 1,
    budget,
    fetch,
    workRoot: join(root, "work"),
    transcriptRoot: join(root, "tx"),
  });
  expect(result.path_refusals).toBe(1);
  expect(result.solved).toBe(false);
}, 60_000);

test("omp-stock classifies a tool-only capped turn as paused without executing the tool", async () => {
  const root = await scratch();
  const { registry, env, modelId } = await scriptedModelRegistry(root);
  const trial = await runEditTrial({
    arm: "omp-stock",
    task: suite.tasks[2] as (typeof suite.tasks)[number],
    repeat: 0,
    registry,
    env,
    modelId,
    seed: 1,
    budget,
    fetch: async () => {
      const frame = JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "capped_read",
                  type: "function",
                  function: {
                    name: "read",
                    arguments: JSON.stringify({
                      path: join(root, "outside-workspace.txt"),
                    }),
                  },
                },
              ],
            },
            finish_reason: "length",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
      return new Response(`data: ${frame}\n\ndata: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    },
    workRoot: join(root, "work"),
    transcriptRoot: join(root, "tx"),
  });
  expect(trial).toMatchObject({
    status: "paused",
    failure: null,
    turns: 1,
    path_refusals: 0,
  });
});

for (const succeeds of [false, true]) {
  test(`omp-stock ${succeeds ? "completes after a successful retry" : "fails after exhausting empty-stop recovery"}`, async () => {
    const root = await scratch();
    const { registry, env, modelId } = await scriptedModelRegistry(root);
    let requests = 0;
    const trial = await runEditTrial({
      arm: "omp-stock",
      task: suite.tasks[2] as (typeof suite.tasks)[number],
      repeat: 0,
      registry,
      env,
      modelId,
      seed: 1,
      budget,
      fetch: async () => {
        requests++;
        const frame = JSON.stringify({
          choices: [
            {
              delta: succeeds && requests === 2 ? { content: "Done." } : {},
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        });
        return new Response(`data: ${frame}\n\ndata: [DONE]\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      },
      workRoot: join(root, "work"),
      transcriptRoot: join(root, "tx"),
    });
    expect(trial).toMatchObject(
      succeeds
        ? { status: "completed", failure: null, turns: 2 }
        : { status: "failed", failure: "provider_error", turns: 4 },
    );
    expect(requests).toBe(succeeds ? 2 : 4);
  });
}

test("omp-stock resolves its edit mode from the upstream model name, not the MARS alias", async () => {
  const root = await scratch();
  const { registry, env, modelId } = await scriptedModelRegistry(
    root,
    "local/coder",
    "kimi-k2",
  );
  const model = createScriptedEditModel({
    tasks: suite.tasks,
    profile: SCRIPTED_PROFILES.oracle as (typeof SCRIPTED_PROFILES)[string],
  });
  const result = await runEditTrial({
    arm: "omp-stock",
    task: suite.tasks[3] as (typeof suite.tasks)[number],
    repeat: 0,
    registry,
    env,
    modelId,
    seed: 1,
    budget,
    fetch: model.fetch,
    workRoot: join(root, "work"),
    transcriptRoot: join(root, "tx"),
  });
  expect(result.edit_mode).toBe("replace");
  expect(result.solved).toBe(true);
}, 60_000);

test("an uninspectable workspace never verifies, even when the expected tree is empty", async () => {
  const root = await scratch();
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(root, "big.txt"), "x".repeat(129 * 1024));
  const task = {
    ...(suite.tasks[0] as (typeof suite.tasks)[number]),
    after: new Map<string, Uint8Array>(),
  };
  const verification = await verifyWorkspace(root, task);
  expect(verification).toMatchObject({ solved: false, unreadable: true });
});

test("duplicate arms are refused before any trial runs", async () => {
  const root = await scratch();
  const { registry, env, modelId } = await scriptedModelRegistry(root);
  const model = createScriptedEditModel({
    tasks: suite.tasks,
    profile: SCRIPTED_PROFILES.oracle as (typeof SCRIPTED_PROFILES)[string],
  });
  await expect(
    runEditBenchmark({
      suite,
      arms: ["mars:apply_patch", "mars:apply_patch", "omp-stock"],
      registry,
      env,
      modelId,
      fetch: model.fetch,
      repeats: 1,
      budgetPerTask: budget,
      maxTotalUsd: 100,
      repository: "r",
      outDir: join(root, "out"),
      simulated: true,
    }),
  ).rejects.toThrow("Benchmark arms must be distinct.");
  expect(model.requests()).toBe(0);
});

test("the confirmatory arm is the static default even when another MARS arm wins by more", async () => {
  const { run } = await offlineRun("secondary-wins", {
    arms: ["mars:hashline", "mars:apply_patch", "omp-stock"],
  });
  const arms = run.report.arms as Array<{
    arm: string;
    verified_solves: number;
  }>;
  const solves = (arm: string) =>
    arms.find((a) => a.arm === arm)?.verified_solves ?? 0;
  expect(solves("mars:apply_patch")).toBeGreaterThan(solves("mars:hashline"));
  expect(run.report.verdict).toMatchObject({
    candidate: "mars:hashline",
    confirmatory_arm: "mars:hashline",
    confirmatory_reason: "static_default",
  });
  expect((run.report.paired as { candidate: string }).candidate).toBe(
    "mars:hashline",
  );
  const secondary = run.report.secondary as {
    label: string;
    best_arm: string;
    comparisons: Array<{
      arm: string;
      confirmatory: boolean;
      p_raw: number;
      p_holm: number;
    }>;
  };
  expect(secondary.label).toBe(
    "secondary (exploratory, not adjusted for multiple comparisons)",
  );
  expect(secondary.best_arm).toBe("mars:apply_patch");
  expect(secondary.comparisons.map((c) => [c.arm, c.confirmatory])).toEqual([
    ["mars:hashline", true],
    ["mars:apply_patch", false],
  ]);
  for (const c of secondary.comparisons)
    expect(c.p_holm).toBeGreaterThanOrEqual(c.p_raw);
  expect(run.markdown).toContain(
    "Secondary comparisons: secondary (exploratory, not adjusted for multiple comparisons)",
  );
  expect(run.markdown).toContain("Pre-registered arm: mars:hashline");
}, 180_000);

test("without the confirmatory arm the bar is not evaluable and never falls back", async () => {
  const { run } = await offlineRun("patch-fluent", {
    suite: suiteV2,
    tasks: MIN_POWERED_TASKS,
    arms: ["mars:apply_patch", "omp-stock"],
  });
  expect(run.report.verdict).toMatchObject({
    candidate: null,
    confirmatory_arm: "mars:hashline",
    exploratory: false,
    met: false,
    significant: false,
    summary: "Not evaluable: confirmatory arm mars:hashline not run.",
  });
  expect(run.report.paired).toBeNull();
  // The winning non-default arm is still reported, only as secondary.
  const secondary = run.report.secondary as {
    best_arm: string;
    comparisons: Array<{ arm: string; p_raw: number }>;
  };
  expect(secondary.best_arm).toBe("mars:apply_patch");
  expect(secondary.comparisons[0]?.p_raw).toBeLessThan(0.05);
}, 240_000);

test("Holm adjustment matches hand-computed values", () => {
  // Sorted 0.01, 0.03, 0.04 -> 3*0.01 = 0.03, 2*0.03 = 0.06, max(0.06, 1*0.04) = 0.06.
  const adjusted = holmAdjust([0.01, 0.04, 0.03]);
  expect(adjusted[0]).toBeCloseTo(0.03, 12);
  expect(adjusted[1]).toBeCloseTo(0.06, 12);
  expect(adjusted[2]).toBeCloseTo(0.06, 12);
  expect(holmAdjust([0.5, 0.9, 0.6])).toEqual([1, 1, 1]);
  expect(holmAdjust([])).toEqual([]);
});

test("both arms keep the host workspace path out of every model request", async () => {
  const root = await scratch();
  const { registry, env, modelId } = await scriptedModelRegistry(root);
  const model = createScriptedEditModel({
    tasks: suite.tasks,
    profile: SCRIPTED_PROFILES.oracle as ScriptedModelProfile,
  });
  for (const arm of ["mars:hashline", "omp-stock"] as const) {
    const bodies: string[] = [];
    const result = await runEditTrial({
      arm,
      task: suite.tasks[0] as (typeof suite.tasks)[number],
      repeat: 0,
      registry,
      env,
      modelId,
      seed: 1,
      budget,
      fetch: async (url, init) => {
        bodies.push(String(init?.body ?? ""));
        return model.fetch(url, init);
      },
      workRoot: join(root, `work-${arm}`),
      transcriptRoot: join(root, `tx-${arm}`),
    });
    expect(result.solved).toBe(true);
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(body).not.toContain(root);
      expect(JSON.parse(body).max_tokens).toBe(4096);
    }
  }
}, 60_000);

test("mars:apply_patch solves >50 KiB v2 files without omp middle-elision", async () => {
  const largeTasks = suiteV2.tasks.filter(
    (task) => task.task_id === "cobra-large-1" || task.task_id === "ky-large-1",
  );
  expect(largeTasks.length).toBe(2);
  const root = await scratch();
  const { registry, env, modelId } = await scriptedModelRegistry(root);
  const model = createScriptedEditModel({
    tasks: largeTasks,
    profile: SCRIPTED_PROFILES.oracle as ScriptedModelProfile,
  });
  for (const task of largeTasks) {
    const result = await runEditTrial({
      arm: "mars:apply_patch",
      task,
      repeat: 0,
      registry,
      env,
      modelId,
      seed: 1,
      budget,
      fetch: model.fetch,
      workRoot: join(root, `work-${task.task_id}`),
      transcriptRoot: join(root, `tx-${task.task_id}`),
    });
    expect(result.solved).toBe(true);
    expect(result.edit_failures).toBe(0);
  }
}, 60_000);

test("transient HTTP 429/503 responses are retried cleanly without double-counting turns", async () => {
  const root = await scratch();
  const { registry, env, modelId } = await scriptedModelRegistry(root);
  const model = createScriptedEditModel({
    tasks: suite.tasks,
    profile: SCRIPTED_PROFILES.oracle as ScriptedModelProfile,
  });
  let transientLeft = 2;
  let totalCalls = 0;
  const result = await runEditTrial({
    arm: "mars:apply_patch",
    task: suite.tasks[0] as (typeof suite.tasks)[number],
    repeat: 0,
    registry,
    env,
    modelId,
    seed: 1,
    budget,
    fetch: async (url, init) => {
      totalCalls += 1;
      if (transientLeft > 0) {
        const status = transientLeft === 2 ? 429 : 503;
        transientLeft -= 1;
        return new Response("rate limited", {
          status,
          headers: { "retry-after": "0" },
        });
      }
      return model.fetch(url, init);
    },
    workRoot: join(root, "work-retry"),
    transcriptRoot: join(root, "tx-retry"),
  });
  expect(result.solved).toBe(true);
  expect(transientLeft).toBe(0);
  expect(totalCalls).toBe(result.turns + 2);
}, 60_000);

test("daily quota 429 with far-future x-ratelimit-reset fails fast without retrying", async () => {
  const root = await scratch();
  const { registry, env, modelId } = await scriptedModelRegistry(root);
  let totalCalls = 0;
  const result = await runEditTrial({
    arm: "mars:apply_patch",
    task: suite.tasks[0] as (typeof suite.tasks)[number],
    repeat: 0,
    registry,
    env,
    modelId,
    seed: 1,
    budget,
    fetch: async () => {
      totalCalls += 1;
      return new Response("Rate limit exceeded: free-models-per-day", {
        status: 429,
        headers: {
          "x-ratelimit-limit": "50",
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(Date.now() + 3_600_000),
        },
      });
    },
    workRoot: join(root, "work-quota"),
    transcriptRoot: join(root, "tx-quota"),
  });
  expect(result.solved).toBe(false);
  expect(result.failure).toBe("provider_error");
  expect(totalCalls).toBe(1);
}, 60_000);

test("Retry-After above 30s is not clamped below the provider cooldown", async () => {
  const root = await scratch();
  const { registry, env, modelId } = await scriptedModelRegistry(root);
  const trialBudget = { ...budget, max_duration_ms: 45_000 };
  for (const [label, header] of [
    ["numeric", "60"],
    ["http-date", new Date(Date.now() + 60_000).toUTCString()],
  ] as const) {
    let totalCalls = 0;
    const result = await runEditTrial({
      arm: "mars:apply_patch",
      task: suite.tasks[0] as (typeof suite.tasks)[number],
      repeat: 0,
      registry,
      env,
      modelId,
      seed: 1,
      budget: trialBudget,
      fetch: async () => {
        totalCalls += 1;
        return new Response("Too Many Requests", {
          status: 429,
          headers: { "retry-after": header },
        });
      },
      workRoot: join(root, `work-ra-${label}`),
      transcriptRoot: join(root, `tx-ra-${label}`),
    });
    expect(result.solved).toBe(false);
    expect(result.failure).toBe("provider_error");
    expect(totalCalls).toBe(1);
  }
}, 60_000);
