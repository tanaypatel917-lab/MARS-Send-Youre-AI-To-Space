import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, sha256 } from "@mars/contracts/canonical";
import { createHeldOutGuard, HELD_OUT_SPLIT_SCHEMA } from "@mars/datasets";
import { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { scriptedModelRegistry } from "./edit-benchmark/fake-models";
import { MIN_POWERED_TASKS } from "./edit-benchmark/power";
import { EDIT_BENCHMARK_TASK_SCHEMA } from "./edit-benchmark/tasks";
import {
  learningRouteEvidence,
  runLearningBenchmark,
} from "./learning-benchmark";
import type { LearningSuite } from "./learning-suite";

test("a powered, positive sign test recommends review even when the lift interval includes zero", () => {
  const win = {
    baseline: { solved: false, provider_failure: null },
    specialist: { solved: true, provider_failure: null },
  };
  const loss = { baseline: win.specialist, specialist: win.baseline };
  const tie = { baseline: win.baseline, specialist: win.baseline };
  const pairs = [
    ...Array.from({ length: 35 }, () => win),
    ...Array.from({ length: 18 }, () => loss),
    ...Array.from({ length: MIN_POWERED_TASKS - 53 }, () => tie),
  ];
  const positive = learningRouteEvidence("live", pairs);
  expect(positive.pairs).toBe(129);
  expect(positive.sign_test_p_two_sided ?? 1).toBeLessThan(0.05);
  expect(positive.ci_95?.lower ?? 1).toBeLessThanOrEqual(0);
  expect(positive.recommendation).toBe("review_specialist");
  expect(learningRouteEvidence("live", pairs.slice(1)).reason).toBe(
    "insufficient_complete_pairs",
  );
  const negative = learningRouteEvidence(
    "live",
    pairs.map(({ baseline, specialist }) => ({
      baseline: specialist,
      specialist: baseline,
    })),
  );
  expect(negative.sign_test_p_two_sided).toBe(positive.sign_test_p_two_sided);
  expect(negative.reason).toBe("positive_lift_not_established");
});

test("SDK startup errors and empty replies remain eligible failed learning trials", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-learning-eligibility-"));
  const originalPrompt = AgentSession.prototype.prompt;
  const specialistId = "scripted/specialist";
  const prompt = spyOn(AgentSession.prototype, "prompt").mockImplementation(
    async function (this: AgentSession, ...args) {
      if (this.model?.id !== specialistId)
        return originalPrompt.apply(this, args);
      const stream = this.agent.streamFn;
      this.agent.streamFn = () => {
        throw new Error("SDK stream setup failed");
      };
      try {
        return await originalPrompt.apply(this, args);
      } finally {
        this.agent.streamFn = stream;
      }
    },
  );
  try {
    const heldOutTask = {
      task_id: "correct-count",
      domain: "code/backend",
      complexity: "light",
      request: "Change the exported count in a.ts to 1.",
    } as const;
    const pin = {
      ...heldOutTask,
      parent: "1".repeat(40),
      fix: "2".repeat(40),
      paths: ["a.ts"],
    };
    const manifest: LearningSuite["manifest"] = {
      schema: "mars.learning-suite/v1",
      split_id: "eligibility-test",
      repository: "https://example.test/code",
      tasks: [pin],
    };
    const suite: LearningSuite = {
      manifest,
      sha256: sha256(canonicalJson(manifest)),
      guard: createHeldOutGuard({
        schema: HELD_OUT_SPLIT_SCHEMA,
        split_id: manifest.split_id,
        tasks: [{ ...heldOutTask, role: "worker" }],
      }),
      tasks: [
        {
          pin,
          task: {
            schema: EDIT_BENCHMARK_TASK_SCHEMA,
            task_id: pin.task_id,
            category: "multi_site",
            complexity: pin.complexity,
            instruction: pin.request,
            provenance: { origin: "derived", created: "2026-01-01" },
            before: new Map([
              ["a.ts", Buffer.from("export const count = 0;\n")],
            ]),
            after: new Map([
              ["a.ts", Buffer.from("export const count = 1;\n")],
            ]),
          },
        },
      ],
    };
    const baseline = await scriptedModelRegistry(join(root, "baseline"));
    const specialist = await scriptedModelRegistry(
      join(root, "specialist"),
      specialistId,
    );
    const report = await runLearningBenchmark({
      suite,
      outDir: join(root, "out"),
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
          baseline: { model: baseline.modelId },
          specialist: {
            model: specialist.modelId,
            lineage_sha256: "0".repeat(64),
          },
        },
      },
      bindings: {
        baseline: {
          ...baseline,
          fetch: async () =>
            new Response(
              'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
              { headers: { "content-type": "text/event-stream" } },
            ),
        },
        specialist: {
          ...specialist,
          fetch: async () => {
            throw new Error("Unexpected transport dispatch");
          },
        },
      },
    });
    expect(report.tasks[0]?.outcomes).toMatchObject({
      baseline: {
        status: "failed",
        failure: "no_response",
        provider_failure: null,
        turns: 4,
      },
      specialist: {
        status: "failed",
        failure: "sdk_error",
        provider_failure: null,
        turns: 0,
      },
    });
    for (const arm of Object.values(report.arms))
      expect(arm).toMatchObject({
        eligible: 1,
        solved: 0,
        failures: { runtime: 1 },
      });
    const pairCounts = {
      pairs: 1,
      excluded_provider_pairs: 0,
      ties: 1,
    };
    expect(report.paired).toMatchObject(pairCounts);
    expect(report.routing).toEqual([expect.objectContaining(pairCounts)]);
  } finally {
    prompt.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
