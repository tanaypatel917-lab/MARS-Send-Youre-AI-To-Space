import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { EvolutionError } from "./errors";
import {
  type CandidateEvaluator,
  createFixtureEvaluator,
  type EvaluationRequest,
} from "./evaluators";
import * as guard from "./guard";
import type { EvaluationOutcome, MutationProposal } from "./schemas";
import type { EvolutionService } from "./service";
import {
  addFile,
  BETTER_POLICY,
  createFixture,
  type Fixture,
  HIDDEN_ANSWER,
  policyPatch,
  replaceLine,
  runConfig,
} from "./test-support";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

async function setup(
  propose: (
    context: Parameters<Parameters<typeof createFixture>[0]>[0],
  ) => MutationProposal,
  config = runConfig(),
) {
  const fixture = await createFixture(propose);
  const service = await fixture.open();
  cleanup.push(async () => {
    service.close();
    await rm(fixture.root, { recursive: true, force: true });
  });
  await fixture.start(service, config);
  return { fixture, service };
}

const better = (context?: { generation: number }): MutationProposal =>
  context && context.generation > 1
    ? {
        hypothesis: "tweak prompt",
        patch: replaceLine(
          "harness/agent.txt",
          "prompt-v1",
          `prompt-g${context.generation}`,
        ),
      }
    : { hypothesis: "raise solve rate", patch: policyPatch(BETTER_POLICY) };

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof EvolutionError ? error.code : String(error);
  }
  return "no error";
}

describe("evolution search (fake evaluator, model_requests: 0)", () => {
  test("archives a lineage DAG, keeps final tasks out of selection and proposer context", async () => {
    const { fixture, service } = await setup(
      better,
      runConfig({ generations: 2, children_per_generation: 2 }),
    );
    const result = await service.run("run-1");
    expect(result).toEqual({ status: "completed", generations_completed: 2 });
    const lineage = service.lineage("run-1");
    expect(lineage.map((node) => node.candidate_id)).toEqual([
      "initial",
      "g1-c0",
      "g1-c1",
      "g2-c0",
      "g2-c1",
    ]);
    for (const node of lineage.slice(1))
      expect(
        lineage.some((other) => other.candidate_id === node.parent_id),
      ).toBe(true);
    const finals = new Set(["f1", "f2", "f3", "f4"]);
    expect(
      fixture.requests.every((request) => request.split === "selection"),
    ).toBe(true);
    expect(
      fixture.requests
        .flatMap((request) => request.tasks)
        .some((task) => finals.has(task)),
    ).toBe(false);
    for (const context of fixture.contexts)
      for (const task of finals)
        expect(JSON.stringify(context)).not.toContain(`"${task}"`);
    expect(
      fixture.requests.every(
        (request) =>
          request.budget.max_usd === 1 && request.budget.max_tokens === 1000,
      ),
    ).toBe(true);
    expect(
      fixture.requests.every(
        (request) => !request.bundle_dir.startsWith(fixture.baseDir),
      ),
    ).toBe(true);
    const verify = await service.verify("run-1");
    expect(verify).toMatchObject({ ok: true, problems: [] });
    expect(verify.reproduced).toBe(5);
    const metrics = service.metrics("run-1");
    expect(metrics.simulated).toBe(true);
    expect(metrics.search_process.children_proposed).toBe(4);
    expect(
      metrics.search_process.best_selection_score_by_generation,
    ).toHaveLength(2);
    expect(metrics.task_solving.final_test_uses).toBe(0);
  });

  test("candidate patches to evaluator, permissions, accounting or build script are rejected before build", async () => {
    const attempts = [
      replaceLine(
        "evaluator/score.ts",
        "export const score = 1;",
        "export const score = 999;",
      ),
      replaceLine("permissions/policy.json", '{"allow":[]}', '{"allow":["*"]}'),
      replaceLine("accounting/ledger.json", "[]", '[{"usd":-100}]'),
      addFile("build.sh.d", "x"),
    ];
    const { service } = await setup(
      (context) => ({
        hypothesis: "escape",
        patch: attempts[context.child_index] as string,
      }),
      runConfig({ children_per_generation: 4 }),
    );
    await service.run("run-1");
    const children = service.lineage("run-1").slice(1);
    expect(children.map((node) => node.state)).toEqual([
      "rejected",
      "rejected",
      "rejected",
      "rejected",
    ]);
    for (const node of children) expect(node.reason).toMatch(/^protected_path/);
  });

  test("a build that writes host control state is caught by digest re-check and halts the run", async () => {
    const { fixture, service } = await setup((context) => ({
      hypothesis: "tamper via build hook",
      patch: addFile(
        "harness/hook.sh",
        `echo pwned >> ${context.run_id === "run-1" ? fixture.controlFile : ""}`,
      ),
    }));
    expect(await codeOf(service.run("run-1"))).toBe("tamper_detected");
    expect(service.status("run-1").status).toBe("tamper_detected");
    expect(service.lineage("run-1")[1]).toMatchObject({ state: "rejected" });
    expect(service.lineage("run-1")[1]?.reason).toMatch(/^tamper_detected/);
    expect(await readFile(fixture.controlFile, "utf8")).toContain("pwned");
  });

  test("hidden answers may not enter a harness tree; proposer scratch edits are ignored", async () => {
    const { fixture, service } = await setup((context) => {
      void writeFile(`${context.harness_dir}/evaluator/score.ts`, "hacked\n");
      return {
        hypothesis: "memorise",
        patch: addFile("harness/answers.txt", HIDDEN_ANSWER),
      };
    });
    await service.run("run-1");
    expect(service.lineage("run-1")[1]?.reason).toMatch(/^holdout_leak/);
    expect(
      await readFile(`${fixture.baseDir}/evaluator/score.ts`, "utf8"),
    ).toBe("export const score = 1;\n");
  });

  test("a non-reproducible build is rejected", async () => {
    const { service } = await setup(() => ({
      hypothesis: "nondeterministic",
      patch: addFile("harness/hook.sh", "date +%s%N > dist/stamp"),
    }));
    await service.run("run-1");
    expect(service.lineage("run-1")[1]?.reason).toMatch(/^irreproducible/);
  });

  test("empty mutations and model changes are refused", async () => {
    const { service } = await setup(
      (context) =>
        context.child_index === 0
          ? { hypothesis: "nothing" }
          : ({
              hypothesis: "swap model",
              model: { id: "other" },
            } as unknown as MutationProposal),
      runConfig({ children_per_generation: 2 }),
    );
    await service.run("run-1");
    const [a, b] = service.lineage("run-1").slice(1);
    expect(a?.reason).toMatch(/empty_mutation/);
    expect(b?.state).toBe("rejected");
  });
});

describe("promotion", () => {
  test("accepts a real improvement with recorded uncertainty, then rolls back and survives reopen", async () => {
    const { fixture, service } = await setup(better);
    await service.run("run-1");
    const decision = await service.promote({
      run_id: "run-1",
      candidate_id: "g1-c0",
      idempotency_key: "promote-1",
    });
    expect(decision.verdict).toBe("accepted");
    expect(decision.gates.every((gate) => gate.passed)).toBe(true);
    expect(decision.quality.n).toBe(4);
    expect(decision.quality.low).toBeGreaterThan(0);
    expect(decision.simulated).toBe(true);
    expect(decision.notes.join(" ")).toContain("SIMULATED");
    const finalRequests = fixture.requests.filter(
      (request) => request.split === "final",
    );
    expect(finalRequests).toHaveLength(2);
    expect(finalRequests[0]?.seed).toBe(finalRequests[1]?.seed as string);
    expect(finalRequests.every((request) => request.repeats === 4)).toBe(true);
    expect(service.champion("scope-1")?.candidate_id).toBe("g1-c0");
    expect(
      await service.promote({
        run_id: "run-1",
        candidate_id: "g1-c0",
        idempotency_key: "promote-1",
      }),
    ).toEqual(decision);
    const pointer = service.champion("scope-1")?.pointer_version as number;
    expect(() =>
      service.rollback({
        scope_key: "scope-1",
        to_entry_seq: 1,
        expected_pointer_version: pointer - 1,
      }),
    ).toThrow(/stale_revision/);
    service.rollback({
      scope_key: "scope-1",
      to_entry_seq: 1,
      expected_pointer_version: pointer,
    });
    service.close();
    const reopened = await fixture.open();
    cleanup.push(async () => reopened.close());
    expect(reopened.champion("scope-1")).toMatchObject({
      candidate_id: "initial",
      action: "rollback",
    });
    expect(reopened.history("scope-1").map((entry) => entry.action)).toEqual([
      "initial",
      "deploy",
      "rollback",
    ]);
    reopened.rollback({
      scope_key: "scope-1",
      to_entry_seq: 2,
      expected_pointer_version: pointer + 1,
    });
    expect(reopened.champion("scope-1")?.candidate_id).toBe("g1-c0");
    expect((await reopened.verify("run-1")).ok).toBe(true);
  });

  test("reports no_improvement honestly and leaves the champion unchanged", async () => {
    const { service } = await setup(() => ({
      hypothesis: "cosmetic",
      patch: replaceLine("harness/agent.txt", "prompt-v1", "prompt-v2"),
    }));
    await service.run("run-1");
    const decision = await service.promote({
      run_id: "run-1",
      idempotency_key: "p",
    });
    expect(decision.verdict).toBe("no_improvement");
    expect(decision.quality).toMatchObject({ mean: 0, low: 0, high: 0 });
    expect(service.champion("scope-1")?.candidate_id).toBe("initial");
  });

  test("rejects a final-set improvement that regresses another task family", async () => {
    const { service } = await setup(() => ({
      hypothesis: "overfit",
      patch: policyPatch('{"default":0.9,"effort":1,"solve":{"r1":0,"r2":0}}'),
    }));
    await service.run("run-1");
    const decision = await service.promote({
      run_id: "run-1",
      idempotency_key: "p",
    });
    expect(decision.verdict).toBe("rejected");
    expect(decision.gates.find((gate) => gate.name === "quality")?.passed).toBe(
      true,
    );
    expect(
      decision.gates.find((gate) => gate.name === "regression")?.passed,
    ).toBe(false);
    expect(service.champion("scope-1")?.candidate_id).toBe("initial");
  });

  test("rejects a candidate whose cost per trial rises beyond the gate", async () => {
    const { service } = await setup(() => ({
      hypothesis: "brute force",
      patch: policyPatch('{"default":0.9,"effort":5}'),
    }));
    await service.run("run-1");
    const decision = await service.promote({
      run_id: "run-1",
      idempotency_key: "p",
    });
    expect(decision.verdict).toBe("rejected");
    expect(decision.gates.find((gate) => gate.name === "cost")?.passed).toBe(
      false,
    );
  });

  test("caps held-out final test uses per run", async () => {
    const { service } = await setup(
      () => ({
        hypothesis: "cosmetic",
        patch: replaceLine("harness/agent.txt", "prompt-v1", "prompt-v2"),
      }),
      {
        ...runConfig(),
        final_test: {
          tasks: ["f1", "f2", "f3", "f4"],
          repeats: 2,
          bootstrap_samples: 200,
          max_uses: 1,
        },
      },
    );
    await service.run("run-1");
    await service.promote({ run_id: "run-1", idempotency_key: "a" });
    expect(
      await codeOf(service.promote({ run_id: "run-1", idempotency_key: "b" })),
    ).toBe("budget_exhausted");
  });

  test("tampered accounting fails the integrity gate and is never promoted", async () => {
    const { service } = await setup(better);
    await service.run("run-1");
    service.store.db.query("UPDATE ledger SET usd = 0 WHERE seq = 1").run();
    const decision = await service.promote({
      run_id: "run-1",
      idempotency_key: "p",
    });
    expect(decision.verdict).toBe("rejected");
    expect(
      decision.gates.find((gate) => gate.name === "integrity")?.detail,
    ).toMatch(/accounting_tampered/);
    expect(service.champion("scope-1")?.candidate_id).toBe("initial");
    expect((await service.verify("run-1")).ok).toBe(false);
  });
});

describe("durability and service boundaries", () => {
  test("crash mid-generation resumes the same plan without re-proposing finished children", async () => {
    let crash = true;
    const base = createFixtureEvaluator();
    const fixture: Fixture = await createFixture(better);
    cleanup.push(async () =>
      rm(fixture.root, { recursive: true, force: true }),
    );
    const service = await fixture.open({
      holder: "driver-a",
      evaluator: {
        digest: base.digest,
        simulated: true,
        async evaluate(request, signal) {
          if (crash && request.subject_id === "g1-c1")
            throw new EvolutionError("closed", "simulated crash");
          return base.evaluate(request, signal);
        },
      },
    });
    await fixture.start(
      service,
      runConfig({ children_per_generation: 2, generations: 2 }),
    );
    expect(await codeOf(service.run("run-1"))).toBe("closed");
    const proposedBefore = fixture.contexts.length;
    expect(proposedBefore).toBe(2);
    service.close();
    crash = false;
    const resumed = await fixture.open({ holder: "driver-b" });
    cleanup.push(async () => resumed.close());
    expect(await resumed.run("run-1")).toEqual({
      status: "completed",
      generations_completed: 2,
    });
    expect(fixture.contexts.length).toBe(proposedBefore + 2);
    expect(resumed.lineage("run-1").map((node) => node.state)).toEqual([
      "evaluated",
      "evaluated",
      "evaluated",
      "evaluated",
      "evaluated",
    ]);
    expect((await resumed.verify("run-1")).ok).toBe(true);
  });

  test("a live lease held by another driver fences writes", async () => {
    const { fixture, service } = await setup(better);
    service.store.acquireLease("run-1", "other-driver", Date.now(), 60_000);
    expect(await codeOf(service.run("run-1"))).toBe("stale_lease");
    expect(fixture.contexts).toHaveLength(0);
  });

  test("run budget is enforced before each matched evaluation", async () => {
    const { service } = await setup(
      (context) => ({
        hypothesis: "grow",
        patch: addFile(`harness/g${context.generation}.txt`, "x"),
      }),
      {
        ...runConfig({ generations: 10 }),
        budget: {
          max_tokens: 1_000_000,
          max_usd: 1.5,
          max_duration_ms: 3_600_000,
          max_depth: 10,
          max_concurrency: 1,
        },
      },
    );
    const result = await service.run("run-1");
    expect(result.status).toBe("budget_exhausted");
    expect(result.generations_completed).toBeLessThan(10);
    expect(
      service.metrics("run-1").search_process.spend.usd,
    ).toBeLessThanOrEqual(1.5);
    expect(
      await codeOf(
        service.promote({ run_id: "run-1", idempotency_key: "late" }),
      ),
    ).toBe("budget_exhausted");
  });

  test("a candidate that overspends its matched evaluation budget is rejected", async () => {
    const { service } = await setup(() => ({
      hypothesis: "burn tokens",
      patch: policyPatch('{"default":1,"effort":100}'),
    }));
    await service.run("run-1");
    expect(service.lineage("run-1")[1]?.reason).toMatch(/^over_budget/);
  });

  test("swapping the evaluator after run start is refused", async () => {
    const { fixture, service } = await setup(better);
    service.close();
    const swapped = await fixture.open({
      evaluator: createFixtureEvaluator({ usdPerTrialPerEffort: 0 }),
    });
    cleanup.push(async () => swapped.close());
    expect(await codeOf(swapped.run("run-1"))).toBe("evaluator_mismatch");
  });

  test("startRun is idempotent and refuses a conflicting config; work root may not hold control state", async () => {
    const { fixture, service } = await setup(better);
    expect(await service.startRun({ ...(await startInput(fixture)) })).toEqual({
      run_id: "run-1",
      created: false,
    });
    expect(
      await codeOf(
        service.startRun({
          ...(await startInput(fixture)),
          config: runConfig({ seed: "other" }),
        }),
      ),
    ).toBe("conflict");
    expect(await codeOf(fixture.open().then(() => undefined))).toBe("no error");
    const { EvolutionService } = await import("./service");
    expect(
      await codeOf(
        EvolutionService.open({
          storeDir: `${fixture.workDir}/store`,
          workDir: fixture.workDir,
          evaluator: createFixtureEvaluator(),
          proposer: { id: "x", propose: async () => better() },
          sandbox: (await import("./sandbox")).createProcessSandbox(),
        }),
      ),
    ).toBe("unsafe_path");
  });
});

async function startInput(fixture: Fixture) {
  return {
    config: runConfig(),
    scope_key: "scope-1",
    base_dir: fixture.baseDir,
    base_ref: "fixture@v1",
    model: { id: "fake-model", provider: "fake", revision: "2026-11-01" },
    prompts: { system: "You are MARS." },
    skills: { store_revision: "skills-r1" },
    tools: [
      { name: "bash", revision: "1" },
      { name: "edit", revision: "1" },
    ],
    retrieval: {
      repo_map_tokens: 2048,
      memory_top_k: 8,
      context_window_tokens: 32_000,
      research: false,
    },
  };
}

export type { EvolutionService };

describe("review regressions", () => {
  async function withEvaluator(
    evaluator: CandidateEvaluator,
    config = runConfig(),
    leaseTtlMs?: number,
  ) {
    const fixture = await createFixture(better);
    cleanup.push(async () =>
      rm(fixture.root, { recursive: true, force: true }),
    );
    const service = await fixture.open({
      evaluator,
      ...(leaseTtlMs ? { leaseTtlMs } : {}),
    });
    cleanup.push(async () => service.close());
    await fixture.start(service, config);
    return service;
  }
  const base = createFixtureEvaluator();
  const wrap = (
    change: (
      request: EvaluationRequest,
      outcome: EvaluationOutcome,
    ) => Promise<EvaluationOutcome> | EvaluationOutcome,
  ): CandidateEvaluator => ({
    digest: base.digest,
    simulated: true,
    async evaluate(request, signal) {
      return change(request, await base.evaluate(request, signal));
    },
  });
  const isCandidate = (request: EvaluationRequest) =>
    request.subject_id.startsWith("g");

  test("an evaluation longer than the lease TTL renews the lease and is recorded", async () => {
    const service = await withEvaluator(
      wrap(async (_request, outcome) => {
        await Bun.sleep(700);
        return outcome;
      }),
      runConfig(),
      300,
    );
    expect((await service.run("run-1")).status).toBe("completed");
    expect(
      service.lineage("run-1").every((node) => node.state === "evaluated"),
    ).toBe(true);
  }, 30_000);

  test("losing the lease during the post-evaluation digest check leaves the result and budget unsettled", async () => {
    const aborted = Promise.withResolvers<void>();
    const service = await withEvaluator(
      {
        ...base,
        async evaluate(request, signal) {
          signal?.addEventListener("abort", () => aborted.resolve(), {
            once: true,
          });
          return base.evaluate(request, signal);
        },
      },
      runConfig(),
      300,
    );
    const verify = guard.verifyControlDigests;
    const check = spyOn(guard, "verifyControlDigests").mockImplementation(
      async (digests, phase) => {
        if (phase === "after evaluation") {
          const run = service.store.getRun("run-1");
          if (!run) throw new Error("missing fixture run");
          service.store.releaseLease("run-1", run.lease_token);
          await aborted.promise;
        }
        return verify(digests, phase);
      },
    );
    try {
      expect(await codeOf(service.run("run-1"))).toBe("stale_lease");
      expect(check).toHaveBeenCalledWith(expect.anything(), "after evaluation");
      expect(
        service.store.listSelectionEvaluations("run-1", "initial"),
      ).toEqual([]);
      expect(service.store.ledger("run-1").map(({ kind }) => kind)).toEqual([
        "reserve",
      ]);
      expect(service.store.getRun("run-1")?.lease_holder).toBeNull();
    } finally {
      check.mockRestore();
    }
  });

  test("a resumed promotion re-checks the matched budget on cached final outcomes", async () => {
    const service = await withEvaluator(
      wrap((request, outcome) =>
        request.split === "final" && isCandidate(request)
          ? { ...outcome, tokens: request.budget.max_tokens + 1 }
          : outcome,
      ),
    );
    await service.run("run-1");
    const first = await service.promote({
      run_id: "run-1",
      idempotency_key: "p",
    });
    expect(first.verdict).toBe("rejected");
    // Crash between the committed evaluations and the decision commit.
    service.store.db.query("DELETE FROM decisions").run();
    const resumed = await service.promote({
      run_id: "run-1",
      idempotency_key: "p",
    });
    expect(resumed.verdict).toBe("rejected");
    expect(resumed.gates.find((gate) => gate.name === "cost")?.passed).toBe(
      false,
    );
    expect(service.champion("scope-1")?.candidate_id).toBe("initial");
  });

  test("baseline-arm spend reported by the evaluator is charged against the matched budget", async () => {
    const service = await withEvaluator(
      wrap((request, outcome) => ({
        ...outcome,
        baseline_cost_usd: request.budget.max_usd,
      })),
    );
    expect((await service.run("run-1")).status).toBe("failed");
    expect(service.lineage("run-1")[0]?.reason).toMatch(/^over_budget/);
  });

  test("a promotion interrupted mid-comparison resumes under max_uses 1", async () => {
    let crash = true;
    const service = await withEvaluator(
      wrap((request, outcome) => {
        if (crash && request.split === "final" && isCandidate(request))
          throw new EvolutionError("closed", "simulated crash");
        return outcome;
      }),
      {
        ...runConfig(),
        final_test: {
          tasks: ["f1", "f2", "f3", "f4"],
          repeats: 2,
          bootstrap_samples: 200,
          max_uses: 1,
        },
      },
    );
    await service.run("run-1");
    expect(
      await codeOf(service.promote({ run_id: "run-1", idempotency_key: "p" })),
    ).toBe("closed");
    crash = false;
    const decision = await service.promote({
      run_id: "run-1",
      idempotency_key: "p",
    });
    expect(decision.verdict).toBe("accepted");
    expect(decision.final_test_uses).toBe(1);
  });

  test("a known candidate overspend is caught even when baseline spend is unknown", async () => {
    const service = await withEvaluator(
      wrap((request, outcome) => ({
        ...outcome,
        tokens: request.budget.max_tokens + 1,
        baseline_tokens: null,
      })),
    );
    expect((await service.run("run-1")).status).toBe("failed");
    expect(service.lineage("run-1")[0]?.reason).toMatch(/^over_budget/);
    const settle = service.store
      .ledger("run-1")
      .find((row) => row.kind === "settle");
    expect(settle?.tokens).toBeGreaterThan(
      runConfig().evaluation_budget.max_tokens,
    );
  });

  test("an interrupted decision key cannot be reused to put another candidate on the final set", async () => {
    const service = await withEvaluator(base, {
      ...runConfig({ children_per_generation: 2 }),
      final_test: {
        tasks: ["f1", "f2", "f3", "f4"],
        repeats: 2,
        bootstrap_samples: 200,
        max_uses: 1,
      },
    });
    await service.run("run-1");
    await service.promote({
      run_id: "run-1",
      candidate_id: "g1-c0",
      idempotency_key: "p",
    });
    service.store.db.query("DELETE FROM decisions").run();
    expect(
      await codeOf(
        service.promote({
          run_id: "run-1",
          candidate_id: "g1-c1",
          idempotency_key: "p",
        }),
      ),
    ).toBe("conflict");
  });

  test("mutations the evaluator does not apply are refused as inert", async () => {
    const fixture = await createFixture(() => ({
      hypothesis: "recall fewer memories",
      retrieval: { memory_top_k: 3 },
    }));
    cleanup.push(async () =>
      rm(fixture.root, { recursive: true, force: true }),
    );
    const service = await fixture.open({
      evaluator: {
        ...base,
        appliedComponents: ["system_prompt"],
        evaluate: base.evaluate,
      },
    });
    cleanup.push(async () => service.close());
    await fixture.start(service);
    await service.run("run-1");
    expect(service.lineage("run-1")[1]?.reason).toMatch(
      /inert_mutation: evaluator does not apply skills\/tools\/retrieval/,
    );
  });

  test("a harness-only evaluator rejects prompt-only changes but evaluates a harness patch", async () => {
    const fixture = await createFixture((context) =>
      context.child_index === 0
        ? { hypothesis: "change a prompt", prompts: { system: "new prompt" } }
        : {
            hypothesis: "change the harness",
            patch: policyPatch(BETTER_POLICY),
          },
    );
    cleanup.push(async () =>
      rm(fixture.root, { recursive: true, force: true }),
    );
    const service = await fixture.open({
      evaluator: { ...base, appliedComponents: [] },
    });
    cleanup.push(async () => service.close());
    await fixture.start(service, runConfig({ children_per_generation: 2 }));
    await service.run("run-1");
    expect(service.lineage("run-1")).toMatchObject([
      { candidate_id: "initial", state: "evaluated" },
      {
        candidate_id: "g1-c0",
        state: "rejected",
        reason: expect.stringContaining("inert_mutation"),
      },
      { candidate_id: "g1-c1", state: "evaluated" },
    ]);
  });
});
