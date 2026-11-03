import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ArtifactRef, Budget, RequestContext } from "@mars/contracts";
import {
  bounded,
  CANDIDATE_SCHEMA,
  candidateId,
  canTransitionCandidate,
  constantScore,
  createCommandWorkerLauncher,
  createFixtureScoringBackend,
  createMemoryArtifactStore,
  createOptimizationService,
  createPythonWorkerLauncher,
  createScriptedReflectionResponder,
  DRAIN_GRACE_MS,
  EVALUATE_REQUEST_SCHEMA,
  keywordScore,
  OPTIMIZATION_PINS,
  OptimizationError,
  PROPOSAL_REPORT_SCHEMA,
  PROPOSAL_REQUEST_SCHEMA,
  type PromptTargetRegistration,
  ProposalReportSchema,
  runGepaWorker,
  scrubSecrets,
  splitInstances,
  TARGET_SCHEMA,
  TRUNCATION_MARKER,
  type WorkerLauncher,
  type WorkerStart,
  workerAvailable,
} from "./index";

const context: RequestContext = {
  schema_version: 1,
  scope: { owner_id: "owner-1", project_id: "project-1" },
  request_id: "req-1",
};
const otherScope: RequestContext = {
  ...context,
  scope: { owner_id: "owner-2", project_id: "project-1" },
};
const budget: Budget = {
  max_tokens: 200_000,
  max_usd: 5,
  max_duration_ms: 60_000,
  max_depth: 1,
  max_concurrency: 2,
};
const KEYWORD = "double-check";
const SEED = "Answer the task.";
const REFLECTION_TEXT = `\`\`\`\n${SEED} Always ${KEYWORD} your work before answering.\n\`\`\``;
const FAKE_WORKER = path.join(import.meta.dir, "..", "tests", "fake-worker.ts");

const haveWorker = workerAvailable();
const workerTest = haveWorker ? test : test.skip;
if (!haveWorker) {
  console.warn(
    "SKIPPING real GEPA worker tests: packages/optimization/python/.venv is missing (see README setup).",
  );
}

const roots: string[] = [];
let restoreFetch: (() => void) | undefined;
beforeAll(() => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("network disabled in optimization tests");
  }) as unknown as typeof fetch;
  restoreFetch = () => {
    globalThis.fetch = original;
  };
});
afterAll(() => restoreFetch?.());
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function newRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "mars-optimization-"));
  roots.push(root);
  return root;
}

function registration(
  count = 10,
  seed = "split-seed",
): PromptTargetRegistration {
  return {
    schema: TARGET_SCHEMA,
    target_id: "target-demo",
    description: "fixture target",
    components: { system_prompt: SEED },
    instances: Array.from({ length: count }, (_, index) => ({
      instance_id: `inst-${String(index).padStart(2, "0")}`,
      summary: `fixture task ${index} (api_key=notasecret${index}00)`,
    })),
    split: {
      seed,
      train_fraction: 0.5,
      validation_fraction: 0.3,
      min_final_holdout: 2,
    },
  };
}

function fakeLauncher(mode: string): WorkerLauncher {
  return createCommandWorkerLauncher([process.execPath, FAKE_WORKER, mode], {
    cwd: path.dirname(FAKE_WORKER),
    id: `fake:${mode}`,
  });
}

/** Records every line the host writes to the worker so tests can inspect it. */
function recordingLauncher(
  inner: WorkerLauncher,
  written: string[],
): WorkerLauncher {
  return {
    id: inner.id,
    spawn() {
      const child = inner.spawn();
      return {
        ...child,
        write(line) {
          written.push(line);
          child.write(line);
        },
      };
    },
  };
}

async function setup(options: {
  score?: Parameters<typeof createFixtureScoringBackend>[0]["score"];
  costPerInstance?: number | null;
  launcher?: WorkerLauncher;
  count?: number;
}) {
  const root = await newRoot();
  const artifacts = createMemoryArtifactStore();
  const backend = createFixtureScoringBackend({
    score: options.score ?? keywordScore([KEYWORD]),
    cost_usd_per_instance: options.costPerInstance ?? 0.001,
  });
  const reflection = createScriptedReflectionResponder(() => REFLECTION_TEXT);
  const service = createOptimizationService({
    rootDir: root,
    backend,
    backendId: backend.id,
    reflection,
    artifacts,
    ...(options.launcher ? { launcher: options.launcher } : {}),
  });
  const put = (value: unknown): Promise<ArtifactRef> =>
    artifacts.put(
      context,
      new TextEncoder().encode(JSON.stringify(value)),
      "application/json",
    );
  const reg = registration(options.count);
  const targetId = await service.registerTarget(context, await put(reg));
  const manifest = await put({
    schema: PROPOSAL_REQUEST_SCHEMA,
    max_metric_calls: 16,
    reflection_minibatch_size: 2,
    seed: 0,
  });
  const readJson = async (ref: ArtifactRef) =>
    JSON.parse(
      new TextDecoder().decode(await artifacts.get(context, ref)),
    ) as unknown;
  return {
    service,
    backend,
    reflection,
    targetId,
    manifest,
    put,
    readJson,
    registration: reg,
  };
}

describe("split", () => {
  test("is deterministic, disjoint and keeps a minimum holdout", () => {
    const ids = Array.from({ length: 11 }, (_, i) => `i${i}`);
    const policy = {
      seed: "a",
      train_fraction: 0.6,
      validation_fraction: 0.2,
      min_final_holdout: 3,
    };
    const first = splitInstances(ids, policy);
    const second = splitInstances([...ids].reverse(), policy);
    expect(second).toEqual(first);
    expect(first.final_holdout.length).toBeGreaterThanOrEqual(3);
    const all = [...first.train, ...first.validation, ...first.final_holdout];
    expect(new Set(all).size).toBe(ids.length);
    expect(splitInstances(ids, { ...policy, seed: "b" })).not.toEqual(first);
    expect(() =>
      splitInstances(ids, { ...policy, min_final_holdout: 10 }),
    ).toThrow("minimum final holdout");
  });
});

describe("scrub", () => {
  test("redacts secret shapes and truncates with a marker", () => {
    expect(
      scrubSecrets("x api_key=supersecretvalue99 y Bearer abcdefghijklmnop"),
    ).toBe("x [redacted] y [redacted]");
    const clipped = bounded("a".repeat(100), 20);
    expect(clipped.length).toBe(20);
    expect(clipped.endsWith(TRUNCATION_MARKER)).toBe(true);
  });
});

describe("targets and holdout", () => {
  test("registers a target, isolates the holdout and stores the seed as a draft", async () => {
    const { service, targetId, put, registration: reg } = await setup({});
    const target = await service.target(context, targetId);
    const holdout = await service.finalHoldoutInstances(context, targetId);
    expect(holdout.length).toBeGreaterThanOrEqual(2);
    const trainValidation = new Set([
      ...target.split.train,
      ...target.split.validation,
    ]);
    for (const id of holdout) expect(trainValidation.has(id)).toBe(false);
    expect(JSON.stringify(target)).not.toContain(holdout[0] as string);
    expect("registration" in target).toBe(false);
    expect(target.registration_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(target.instances.some((i) => holdout.includes(i.instance_id))).toBe(
      false,
    );
    const [seed] = await service.candidates(context, targetId);
    expect(seed?.schema).toBe(CANDIDATE_SCHEMA);
    expect(seed?.origin).toBe("seed");
    expect(seed?.status).toBe("draft");
    expect(seed?.candidate.candidate_id).toBe(candidateId(reg.components));
    expect(await service.registerTarget(context, await put(reg))).toBe(
      targetId,
    );
    await expect(
      service.registerTarget(
        context,
        await put({ ...reg, description: "changed" }),
      ),
    ).rejects.toThrow("target_exists");
    await expect(service.target(otherScope, targetId)).rejects.toThrow(
      "target_not_found",
    );
  });
});

describe("propose with the real GEPA worker (gepa 0.1.4 in the pinned venv)", () => {
  workerTest(
    "improves validation score with fixture scores and scripted reflection",
    async () => {
      const written: string[] = [];
      const launcher = recordingLauncher(createPythonWorkerLauncher(), written);
      const { service, backend, reflection, targetId, manifest, readJson } =
        await setup({ launcher });
      const holdout = await service.finalHoldoutInstances(context, targetId);
      const target = await service.target(context, targetId);
      const allowed = new Set([
        ...target.split.train,
        ...target.split.validation,
      ]);

      const job = await service.propose(context, targetId, manifest, budget);
      const finished = await service.waitForJob(context, job.job_id);
      expect(finished.status).toBe("completed");
      expect(finished.stop_reason).toBe("finished");
      expect(finished.worker.gepa_version).toBe(OPTIMIZATION_PINS.gepa_version);
      expect(finished.worker.python_version?.startsWith("3.12.")).toBe(true);
      expect(finished.reflection_calls).toBeGreaterThan(0);
      expect(reflection.prompts.length).toBe(finished.reflection_calls);
      expect(reflection.prompts[0]).toContain("[untrusted evidence");

      // Holdout isolation: nothing sent to the worker or the backend names a holdout id.
      expect(written.length).toBeGreaterThan(1);
      for (const line of written)
        for (const id of holdout) expect(line).not.toContain(id);
      expect(backend.requests.length).toBeGreaterThan(0);
      for (const request of backend.requests) {
        expect(["train", "validation"]).toContain(request.split);
        for (const id of request.instance_ids) {
          expect(allowed.has(id)).toBe(true);
          expect(holdout).not.toContain(id);
        }
      }
      expect(written[0]).not.toContain("notasecret");
      expect(written[0]).toContain("[redacted]");

      const candidates = await service.candidates(context, targetId);
      const proposed = candidates.filter((c) => c.origin === "proposed");
      expect(proposed.length).toBeGreaterThan(0);
      expect(proposed.every((c) => c.status === "proposed")).toBe(true);
      expect(
        proposed.some(
          (c) => c.candidate.parent_candidate_id === finished.seed_candidate_id,
        ),
      ).toBe(true);

      const ref = await service.publish(context, job.job_id);
      expect(await service.publish(context, job.job_id)).toEqual(ref);
      const report = ProposalReportSchema.parse(await readJson(ref));
      expect(report.schema).toBe(PROPOSAL_REPORT_SCHEMA);
      expect(report.recommendation).toBe("candidate_improved_validation");
      expect(report.promotion).toBe("none_automatic");
      expect(report.best.candidate.components.system_prompt).toContain(KEYWORD);
      expect(report.best.validation_mean_score ?? 0).toBeGreaterThan(
        report.seed.validation_mean_score ?? 1,
      );
      expect(report.per_instance_deltas.every((d) => (d.delta ?? 0) > 0)).toBe(
        true,
      );
      expect(report.simulated).toBe(true);
      expect(report.score_provenance.length).toBe(backend.requests.length);
      expect(report.pins.worker_gepa_version).toBe("0.1.4");
      expect(report.validation_instance_ids).toEqual(target.split.validation);
      const inspected = await service.inspect(context, job.job_id);
      expect(inspected.status).toBe("completed");
      expect(inspected.artifacts).toEqual([ref]);
      // Nothing was promoted: the seed is still a draft and no candidate is accepted.
      expect(candidates.find((c) => c.origin === "seed")?.status).toBe("draft");
      expect(candidates.some((c) => c.status === "accepted")).toBe(false);
    },
    120_000,
  );

  workerTest(
    "reports no_improvement when scores never change",
    async () => {
      const { service, targetId, manifest, readJson } = await setup({
        launcher: createPythonWorkerLauncher(),
        score: constantScore(0.5),
      });
      const job = await service.propose(context, targetId, manifest, budget);
      const finished = await service.waitForJob(context, job.job_id);
      expect(finished.status).toBe("completed");
      const report = ProposalReportSchema.parse(
        await readJson(await service.publish(context, job.job_id)),
      );
      expect(report.recommendation).toBe("no_improvement");
      expect(report.best.candidate.candidate_id).toBe(
        report.seed.candidate.candidate_id,
      );
      expect(report.per_instance_deltas.every((d) => d.delta === 0)).toBe(true);
    },
    120_000,
  );

  workerTest(
    "refuses a worker whose pins do not match",
    async () => {
      const backend = createFixtureScoringBackend({
        score: constantScore(0.5),
      });
      const outcome = await runGepaWorker({
        launcher: createPythonWorkerLauncher(),
        context,
        start: start({
          expected: { gepa_version: "9.9.9", python_version_prefix: "3.12" },
        }),
        budget,
        backend,
        reflection: createScriptedReflectionResponder(() => REFLECTION_TEXT),
        hardMetricCalls: 100,
        maxReflectionTokens: 512,
        estimatedUsdPerMetricCall: null,
        candidateMeta: () => ({
          parent_candidate_id: null,
          created_at: "2026-01-01T00:00:00.000Z",
        }),
      });
      expect(outcome.status).toBe("failed");
      expect(outcome.stop_reason).toBe("pin_mismatch");
      expect(outcome.error).toContain("9.9.9");
      expect(backend.requests).toEqual([]);
    },
    60_000,
  );
});

function start(overrides: Partial<WorkerStart> = {}): WorkerStart {
  return {
    type: "start",
    expected: {
      gepa_version: OPTIMIZATION_PINS.gepa_version,
      python_version_prefix: OPTIMIZATION_PINS.python_version_prefix,
    },
    seed_candidate: { system_prompt: SEED },
    train: ["t1", "t2", "t3"].map((instance_id) => ({
      instance_id,
      split: "train" as const,
      summary: "",
    })),
    validation: ["v1", "v2"].map((instance_id) => ({
      instance_id,
      split: "validation" as const,
      summary: "",
    })),
    max_metric_calls: 10,
    reflection_minibatch_size: 2,
    seed: 0,
    repeats: 1,
    budget,
    max_feedback_chars: 500,
    max_records_per_component: 3,
    ...overrides,
  };
}

describe("bounds against a misbehaving worker", () => {
  const meta = () => ({
    parent_candidate_id: null,
    created_at: "2026-01-01T00:00:00.000Z",
  });

  test("kills a stalled worker at the deadline", async () => {
    const backend = createFixtureScoringBackend({ score: constantScore(0.5) });
    const began = Date.now();
    const outcome = await runGepaWorker({
      launcher: fakeLauncher("stall"),
      context,
      start: start(),
      budget: { ...budget, max_duration_ms: 400 },
      backend,
      reflection: createScriptedReflectionResponder(() => REFLECTION_TEXT),
      hardMetricCalls: 100,
      maxReflectionTokens: 512,
      estimatedUsdPerMetricCall: null,
      candidateMeta: meta,
    });
    expect(outcome.status).toBe("stopped");
    expect(outcome.stop_reason).toBe("deadline");
    expect(outcome.worker.exit_code).not.toBeNull();
    expect(Date.now() - began).toBeLessThan(10_000);
  }, 20_000);

  test("stops when scoring cost exceeds max_usd", async () => {
    const backend = createFixtureScoringBackend({
      score: constantScore(0.5),
      cost_usd_per_instance: 0.1,
    });
    const outcome = await runGepaWorker({
      launcher: fakeLauncher("loop"),
      context,
      start: start(),
      budget: { ...budget, max_usd: 0.5 },
      backend,
      reflection: createScriptedReflectionResponder(() => REFLECTION_TEXT),
      hardMetricCalls: 10_000,
      maxReflectionTokens: 512,
      estimatedUsdPerMetricCall: null,
      candidateMeta: meta,
    });
    expect(outcome.stop_reason).toBe("budget_usd");
    expect(outcome.status).toBe("stopped");
    expect(outcome.cost_usd).toBeGreaterThanOrEqual(0.5);
    expect(backend.requests.length).toBe(3);
  }, 20_000);

  test("stops at the hard metric-call ceiling", async () => {
    const backend = createFixtureScoringBackend({ score: constantScore(0.5) });
    const outcome = await runGepaWorker({
      launcher: fakeLauncher("loop"),
      context,
      start: start(),
      budget,
      backend,
      reflection: createScriptedReflectionResponder(() => REFLECTION_TEXT),
      hardMetricCalls: 5,
      maxReflectionTokens: 512,
      estimatedUsdPerMetricCall: null,
      candidateMeta: meta,
    });
    expect(outcome.stop_reason).toBe("metric_calls");
    expect(outcome.metric_calls).toBe(4);
  }, 20_000);

  test("rejects score requests for instances outside train/validation", async () => {
    const backend = createFixtureScoringBackend({ score: constantScore(0.5) });
    const outcome = await runGepaWorker({
      launcher: fakeLauncher("foreign"),
      context,
      start: start(),
      budget,
      backend,
      reflection: createScriptedReflectionResponder(() => REFLECTION_TEXT),
      hardMetricCalls: 100,
      maxReflectionTokens: 512,
      estimatedUsdPerMetricCall: null,
      candidateMeta: meta,
    });
    expect(outcome.stop_reason).toBe("protocol_error");
    expect(outcome.error).toContain("not-in-any-split");
    expect(backend.requests).toEqual([]);
  }, 20_000);

  test("treats non-JSON output and bad pins as failures", async () => {
    const backend = createFixtureScoringBackend({ score: constantScore(0.5) });
    const common = {
      context,
      start: start(),
      budget,
      backend,
      reflection: createScriptedReflectionResponder(() => REFLECTION_TEXT),
      hardMetricCalls: 100,
      maxReflectionTokens: 512,
      estimatedUsdPerMetricCall: null,
      candidateMeta: meta,
    };
    const garbage = await runGepaWorker({
      ...common,
      launcher: fakeLauncher("garbage"),
    });
    expect(garbage.stop_reason).toBe("protocol_error");
    const badPin = await runGepaWorker({
      ...common,
      launcher: fakeLauncher("bad-pin"),
    });
    expect(badPin.stop_reason).toBe("pin_mismatch");
    expect(badPin.worker.gepa_version).toBe("9.9.9");
  }, 20_000);

  test("cancel aborts a running propose job", async () => {
    const { service, targetId, manifest } = await setup({
      launcher: fakeLauncher("stall"),
    });
    const job = await service.propose(context, targetId, manifest, budget);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await service.cancel(context, job.job_id);
    const record = await service.job(context, job.job_id);
    expect(record.status).toBe("cancelled");
    expect(record.stop_reason).toBe("cancelled");
    await expect(service.publish(context, job.job_id)).rejects.toThrow(
      "job_not_finished",
    );
  }, 20_000);

  test("propose completes with a stop reason when the budget runs out after the seed is scored", async () => {
    const { service, targetId, manifest, readJson } = await setup({
      launcher: fakeLauncher("loop"),
      costPerInstance: 0.1,
    });
    const job = await service.propose(context, targetId, manifest, {
      ...budget,
      max_usd: 0.5,
    });
    const finished = await service.waitForJob(context, job.job_id);
    expect(finished.status).toBe("completed");
    expect(finished.stop_reason).toBe("budget_usd");
    const report = ProposalReportSchema.parse(
      await readJson(await service.publish(context, job.job_id)),
    );
    expect(report.stop_reason).toBe("budget_usd");
    expect(report.limitations.some((l) => l.includes("stopped early"))).toBe(
      true,
    );
    expect(report.recommendation).toBe("no_improvement");
  }, 20_000);
});

describe("evaluate, lifecycle and reports without a worker", () => {
  test("evaluate scores seed and candidate on validation only, then lifecycle gates apply", async () => {
    const { service, backend, targetId, put, readJson } = await setup({});
    const target = await service.target(context, targetId);
    const holdout = await service.finalHoldoutInstances(context, targetId);
    const components = { system_prompt: `${SEED} Always ${KEYWORD}.` };
    const candidate = {
      candidate_id: candidateId(components),
      components,
      parent_candidate_id: target.seed_candidate_id,
      created_at: "2026-01-01T00:00:00.000Z",
    };
    const job = await service.evaluate(
      context,
      await put({
        schema: EVALUATE_REQUEST_SCHEMA,
        target_id: targetId,
        candidate,
        budget,
      }),
    );
    const finished = await service.waitForJob(context, job.job_id);
    expect(finished.status).toBe("completed");
    expect(finished.kind).toBe("evaluate");
    expect(backend.requests.length).toBe(2);
    for (const request of backend.requests) {
      expect(request.split).toBe("validation");
      expect(request.instance_ids).toEqual(target.split.validation);
      for (const id of request.instance_ids) expect(holdout).not.toContain(id);
    }
    const report = ProposalReportSchema.parse(
      await readJson(await service.publish(context, job.job_id)),
    );
    expect(report.job_kind).toBe("evaluate");
    expect(report.recommendation).toBe("candidate_improved_validation");
    expect(report.best.candidate.candidate_id).toBe(candidate.candidate_id);
    expect(report.candidates_total).toBe(2);

    const record = (await service.candidates(context, targetId)).find(
      (c) => c.candidate.candidate_id === candidate.candidate_id,
    );
    expect(record?.origin).toBe("submitted");
    expect(record?.status).toBe("proposed");
    expect(record?.scores.length).toBe(1);
    expect(record?.scores[0]?.split).toBe("validation");

    // draft -> accepted is not allowed; proposed -> accepted -> archived is; archived is terminal.
    expect(canTransitionCandidate("draft", "accepted")).toBe(false);
    await expect(
      service.decide(context, targetId, target.seed_candidate_id, {
        status: "accepted",
        reason: "x",
      }),
    ).rejects.toThrow("invalid_transition");
    const accepted = await service.decide(
      context,
      targetId,
      candidate.candidate_id,
      {
        status: "accepted",
        reason: "reviewer accepted the proposal (no promotion implied)",
      },
    );
    expect(accepted.status).toBe("accepted");
    expect(accepted.history.map((h) => h.to)).toEqual([
      "draft",
      "proposed",
      "accepted",
    ]);
    const archived = await service.decide(
      context,
      targetId,
      candidate.candidate_id,
      {
        status: "archived",
        reason: "superseded",
      },
    );
    expect(archived.status).toBe("archived");
    await expect(
      service.decide(context, targetId, candidate.candidate_id, {
        status: "rejected",
        reason: "late",
      }),
    ).rejects.toThrow("invalid_transition");
    // The live seed prompt is untouched by any of this.
    expect((await service.target(context, targetId)).components).toEqual({
      system_prompt: SEED,
    });
  });

  test("rejects malformed artifacts and mismatched candidate ids", async () => {
    const { service, put, targetId } = await setup({});
    await expect(
      service.registerTarget(context, await put({ schema: "nope" })),
    ).rejects.toBeInstanceOf(OptimizationError);
    const components = { system_prompt: "x" };
    await expect(
      service.evaluate(
        context,
        await put({
          schema: EVALUATE_REQUEST_SCHEMA,
          target_id: targetId,
          candidate: {
            candidate_id: "cand-wrong",
            components,
            parent_candidate_id: null,
            created_at: "2026-01-01T00:00:00.000Z",
          },
          budget,
        }),
      ),
    ).rejects.toThrow("candidate_id does not match");
  });
});

describe("reservations and stalled backends", () => {
  const meta = () => ({
    parent_candidate_id: null,
    created_at: "2026-01-01T00:00:00.000Z",
  });

  test("overlapping score requests never exceed the hard ceiling or max_usd", async () => {
    const seen: number[] = [];
    const backend = createFixtureScoringBackend({
      score: constantScore(0.5),
      cost_usd_per_instance: 0.1,
    });
    const slow = {
      ...backend,
      async score(
        ctx: RequestContext,
        request: Parameters<typeof backend.score>[1],
      ) {
        seen.push(request.instance_ids.length);
        await new Promise((resolve) => setTimeout(resolve, 50));
        return backend.score(ctx, request);
      },
    };
    const outcome = await runGepaWorker({
      launcher: fakeLauncher("burst"),
      context,
      start: start(),
      budget: { ...budget, max_usd: 0.5, max_concurrency: 8 },
      backend: slow,
      reflection: createScriptedReflectionResponder(() => REFLECTION_TEXT),
      hardMetricCalls: 100,
      maxReflectionTokens: 512,
      estimatedUsdPerMetricCall: 0.1,
      candidateMeta: meta,
    });
    expect(outcome.stop_reason).toBe("budget_usd");
    // 0.1 USD per instance, 2 instances per request, 0.5 USD: at most 2 requests admitted.
    expect(seen.length).toBe(2);
    expect(outcome.cost_usd).toBeLessThanOrEqual(0.5);

    const ceiling = await runGepaWorker({
      launcher: fakeLauncher("burst"),
      context,
      start: start(),
      budget: { ...budget, max_usd: 0, max_concurrency: 8 },
      backend: slow,
      reflection: createScriptedReflectionResponder(() => REFLECTION_TEXT),
      hardMetricCalls: 5,
      maxReflectionTokens: 512,
      estimatedUsdPerMetricCall: null,
      candidateMeta: meta,
    });
    expect(ceiling.stop_reason).toBe("metric_calls");
    expect(ceiling.metric_calls).toBeLessThanOrEqual(5);
  }, 20_000);

  test("a stalled scoring backend cannot keep the run alive past the deadline", async () => {
    const backend = {
      async score() {
        return new Promise<never>(() => undefined);
      },
    };
    const began = Date.now();
    const outcome = await runGepaWorker({
      launcher: fakeLauncher("loop"),
      context,
      start: start(),
      budget: { ...budget, max_duration_ms: 300 },
      backend,
      reflection: createScriptedReflectionResponder(() => REFLECTION_TEXT),
      hardMetricCalls: 100,
      maxReflectionTokens: 512,
      estimatedUsdPerMetricCall: null,
      candidateMeta: meta,
    });
    expect(outcome.stop_reason).toBe("deadline");
    expect(outcome.abandoned_calls).toBe(1);
    expect(outcome.metric_calls).toBe(0);
    expect(Date.now() - began).toBeLessThan(300 + DRAIN_GRACE_MS + 3000);
  }, 20_000);

  test("reflection prompts are scrubbed before reaching the responder", async () => {
    const SECRET = "api_key=supersecretvalue99";
    const root = await newRoot();
    const artifacts = createMemoryArtifactStore();
    const backend = createFixtureScoringBackend({
      score: keywordScore([KEYWORD]),
    });
    const reflection = createScriptedReflectionResponder(() => REFLECTION_TEXT);
    const service = createOptimizationService({
      rootDir: root,
      backend,
      backendId: backend.id,
      reflection,
      artifacts,
      launcher: createPythonWorkerLauncher(),
    });
    const put = (value: unknown) =>
      artifacts.put(
        context,
        new TextEncoder().encode(JSON.stringify(value)),
        "application/json",
      );
    const reg = registration();
    const targetId = await service.registerTarget(
      context,
      await put({
        ...reg,
        components: { system_prompt: `${SEED} Use ${SECRET}.` },
      }),
    );
    const manifest = await put({
      schema: PROPOSAL_REQUEST_SCHEMA,
      max_metric_calls: 12,
    });
    const job = await service.propose(context, targetId, manifest, budget);
    const finished = await service.waitForJob(context, job.job_id);
    expect(finished.status).toBe("completed");
    expect(reflection.prompts.length).toBeGreaterThan(0);
    for (const prompt of reflection.prompts) {
      expect(prompt).not.toContain("supersecretvalue99");
      expect(prompt).toContain("[redacted]");
    }
  }, 60_000);
});

describe("evaluate bounds", () => {
  test("gates the whole validation batch on the remaining budget before calling the backend", async () => {
    const { service, backend, targetId, put } = await setup({
      costPerInstance: 1,
    });
    const target = await service.target(context, targetId);
    const components = { system_prompt: `${SEED} v2` };
    const job = await service.evaluate(
      context,
      await put({
        schema: EVALUATE_REQUEST_SCHEMA,
        target_id: targetId,
        candidate: {
          candidate_id: candidateId(components),
          components,
          parent_candidate_id: target.seed_candidate_id,
          created_at: "2026-01-01T00:00:00.000Z",
        },
        budget: { ...budget, max_usd: 1 },
        estimated_usd_per_metric_call: 1,
      }),
    );
    const finished = await service.waitForJob(context, job.job_id);
    expect(finished.status).toBe("failed");
    expect(finished.stop_reason).toBe("budget_usd");
    expect(backend.requests).toEqual([]);
  });

  test("cancel during a stalled validation call returns promptly as cancelled", async () => {
    const root = await newRoot();
    const artifacts = createMemoryArtifactStore();
    let calls = 0;
    const backend = {
      async score() {
        calls += 1;
        return new Promise<never>(() => undefined);
      },
    };
    const service = createOptimizationService({
      rootDir: root,
      backend,
      backendId: "stalled",
      reflection: createScriptedReflectionResponder(() => REFLECTION_TEXT),
      artifacts,
    });
    const put = (value: unknown) =>
      artifacts.put(
        context,
        new TextEncoder().encode(JSON.stringify(value)),
        "application/json",
      );
    const targetId = await service.registerTarget(
      context,
      await put(registration()),
    );
    const target = await service.target(context, targetId);
    const components = { system_prompt: `${SEED} v3` };
    const job = await service.evaluate(
      context,
      await put({
        schema: EVALUATE_REQUEST_SCHEMA,
        target_id: targetId,
        candidate: {
          candidate_id: candidateId(components),
          components,
          parent_candidate_id: target.seed_candidate_id,
          created_at: "2026-01-01T00:00:00.000Z",
        },
        budget,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const began = Date.now();
    await service.cancel(context, job.job_id);
    expect(Date.now() - began).toBeLessThan(2000);
    const record = await service.job(context, job.job_id);
    expect(record.status).toBe("cancelled");
    expect(calls).toBe(1);
    expect(record.metric_calls).toBe(0);

    const deadlineJob = await service.evaluate(
      context,
      await put({
        schema: EVALUATE_REQUEST_SCHEMA,
        target_id: targetId,
        candidate: {
          candidate_id: candidateId(components),
          components,
          parent_candidate_id: target.seed_candidate_id,
          created_at: "2026-01-01T00:00:00.000Z",
        },
        budget: { ...budget, max_duration_ms: 200 },
      }),
    );
    const finished = await service.waitForJob(context, deadlineJob.job_id);
    expect(finished.status).toBe("failed");
    expect(finished.stop_reason).toBe("deadline");
  }, 20_000);

  test("a reused seed baseline still wins over a worse candidate", async () => {
    const { service, targetId, put, readJson } = await setup({
      score: (candidate) =>
        candidate.components.system_prompt === SEED ? 0.8 : 0.3,
    });
    const target = await service.target(context, targetId);
    const evaluate = async (suffix: string) => {
      const components = { system_prompt: `${SEED} ${suffix}` };
      const job = await service.evaluate(
        context,
        await put({
          schema: EVALUATE_REQUEST_SCHEMA,
          target_id: targetId,
          candidate: {
            candidate_id: candidateId(components),
            components,
            parent_candidate_id: target.seed_candidate_id,
            created_at: "2026-01-01T00:00:00.000Z",
          },
          budget,
        }),
      );
      await service.waitForJob(context, job.job_id);
      return ProposalReportSchema.parse(
        await readJson(await service.publish(context, job.job_id)),
      );
    };
    const first = await evaluate("first");
    expect(first.recommendation).toBe("no_improvement");
    expect(first.best.candidate.candidate_id).toBe(target.seed_candidate_id);
    const second = await evaluate("second");
    expect(second.seed.validation_mean_score).toBeCloseTo(0.8);
    expect(second.best.candidate.candidate_id).toBe(target.seed_candidate_id);
    expect(second.best.validation_mean_score).toBeCloseTo(0.8);
    expect(second.recommendation).toBe("no_improvement");
    expect(second.per_instance_deltas.every((d) => d.delta === 0)).toBe(true);
    expect(second.limitations.some((l) => l.includes("earlier job"))).toBe(
      true,
    );
  });
});
