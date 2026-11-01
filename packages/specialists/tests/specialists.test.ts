import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import path from "node:path";
import type {
  EvaluationService,
  JobRef,
  RequestContext,
  Task,
} from "@mars/contracts";
import { loadModelRegistry } from "@mars/providers";
import {
  candidateDigest,
  canonicalJson,
  checkSpecialistBindings,
  formatRef,
  type ModelCatalog,
  type ReasonCode,
  rankCandidates,
  resolveFallbackChain,
  SpecialistRegistryError,
  sha256,
  verifyEvidence,
} from "../src/index";
import { makeSyntheticTeamFixture } from "./fixtures/team";
import {
  artifactRef,
  context,
  createRegistry,
  createTempRoot,
  evidenceVerifier,
  fakeCatalog,
  fakeModel,
  installNoNetworkStub,
  MemoryArtifacts,
  makeBaseline,
  makeLineageArtifact,
  makeSpecialistFixture,
  removeTempRoot,
  routingRequest,
  SYNTHETIC_FIXTURE_NOTICE,
} from "./helpers";

const temporaryRoots: string[] = [];
let restoreFetch: (() => void) | undefined;

beforeAll(() => {
  restoreFetch = installNoNetworkStub();
});

afterAll(() => {
  restoreFetch?.();
});

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(removeTempRoot));
});

async function newRoot(): Promise<string> {
  const root = await createTempRoot();
  temporaryRoots.push(root);
  return root;
}

async function expectCode(
  callback: () => unknown | Promise<unknown>,
  code: SpecialistRegistryError["code"],
  detail?: string,
): Promise<SpecialistRegistryError> {
  try {
    await callback();
  } catch (error) {
    expect(error).toBeInstanceOf(SpecialistRegistryError);
    const registryError = error as SpecialistRegistryError;
    expect(registryError.code).toBe(code);
    if (detail !== undefined) expect(registryError.detail).toBe(detail);
    return registryError;
  }
  throw new Error(`expected SpecialistRegistryError(${code})`);
}

async function setupRegistry(
  overrides: Parameters<typeof createRegistry>[2] = {},
) {
  const root = await newRoot();
  const artifacts = new MemoryArtifacts();
  const registry = createRegistry(root, artifacts, overrides);
  await registry.registerBaseline(context, makeBaseline());
  return { root, artifacts, registry };
}

describe("specialist evidence and persistence", () => {
  test("registers, promotes, routes, and reopens persisted synthetic evidence", async () => {
    const root = await newRoot();
    const childPath = path.join(import.meta.dir, "fixtures", "child.ts");
    const child = Bun.spawn([process.execPath, childPath, root], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(await child.exited).toBe(0);
    expect(stderr).toBe("");
    const childResult = JSON.parse(stdout) as {
      registration: {
        evaluation: ReturnType<typeof artifactRef>;
      };
      reportBytes: number[];
      pointer: {
        specialist_id: string;
        production_revision: string | null;
        history: string[];
        retired: boolean;
        pointer_version: number;
      };
      decision_sha256: string;
    };

    const artifacts = new MemoryArtifacts();
    artifacts.set(
      childResult.registration.evaluation,
      Uint8Array.from(childResult.reportBytes),
    );
    const reopened = createRegistry(root, artifacts);
    const inspection = await reopened.inspect(
      context,
      "fresh-process-specialist",
    );
    expect(inspection.pointer).toEqual(childResult.pointer);
    expect(inspection.pointer.production_revision).toBe("1");
    expect(inspection.revisions[0]?.verdict.synthetic_fixture).toBe(true);
    const decision = await reopened.route(context, routingRequest());
    expect(decision.decision_sha256).toBe(childResult.decision_sha256);
    expect(decision.explanation).toContain(
      "Evidence is a synthetic fixture; it is not a real evaluation and supports no quality claim.",
    );
    expect(decision.selected?.evidence?.synthetic_fixture).toBe(true);
    expect((await reopened.audit(context)).length).toBeGreaterThan(0);
    const journal = reopened.store.db.query("PRAGMA journal_mode").get() as {
      journal_mode: string;
    };
    expect(journal.journal_mode.toLowerCase()).toBe("wal");
    reopened.close();
    await expectCode(() => reopened.list(context), "closed");
  });

  test("detects tampered records and audit events", async () => {
    const { registry, artifacts } = await setupRegistry();
    const fixture = await makeSpecialistFixture(artifacts);
    await registry.registerSpecialist(context, fixture.registration);
    registry.store.db
      .query(
        "UPDATE specialist_revisions SET record_json = '{}' WHERE specialist_id = ?",
      )
      .run(fixture.registration.specialist_id);
    await expectCode(
      () => registry.inspect(context, fixture.registration.specialist_id),
      "corrupt_record",
    );

    const second = await setupRegistry();
    second.registry.store.db
      .query("UPDATE audit_events SET detail_json = '{}' WHERE seq = 1")
      .run();
    await expectCode(() => second.registry.audit(context), "corrupt_record");
  });

  test("enforces scope isolation while allowing workspace reads of project profiles", async () => {
    const { registry, artifacts } = await setupRegistry();
    const fixture = await makeSpecialistFixture(artifacts);
    await registry.registerSpecialist(context, fixture.registration);
    await registry.promote(context, "specialist-1", "1", null);
    const otherContext: RequestContext = {
      ...context,
      scope: { owner_id: "other-owner", project_id: "other-project" },
      request_id: "other-request",
    };
    await expectCode(
      () => registry.inspect(otherContext, "specialist-1"),
      "not_found",
    );
    const workspaceContext: RequestContext = {
      ...context,
      scope: { ...context.scope, workspace_id: "workspace-1" },
      request_id: "workspace-request",
    };
    expect(
      (await registry.route(workspaceContext, routingRequest())).outcome,
    ).toBe("specialist");
    await expectCode(
      () => registry.promote(workspaceContext, "specialist-1", "1", "1"),
      "not_found",
    );
    await expectCode(
      () =>
        registry.registerBaseline(otherContext, makeBaseline(context.scope)),
      "scope_denied",
    );
    const mismatchedScope = await makeSpecialistFixture(artifacts, {
      specialistId: "mismatched-scope",
      scope: otherContext.scope,
    });
    await expectCode(
      () => registry.registerSpecialist(context, mismatchedScope.registration),
      "scope_denied",
    );
  });

  test("requires exact-scope fallback targets and immutable revisions", async () => {
    const { registry, artifacts } = await setupRegistry();
    const foreignContext: RequestContext = {
      ...context,
      scope: { owner_id: "other-owner", project_id: "other-project" },
      request_id: "foreign-request",
    };
    await registry.registerBaseline(
      foreignContext,
      makeBaseline(foreignContext.scope, { baseline_id: "foreign-base" }),
    );
    const invalid = await makeSpecialistFixture(artifacts, {
      fallbackRef: "baseline:foreign-base@1",
    });
    await expectCode(
      () => registry.registerSpecialist(context, invalid.registration),
      "invalid_input",
      "fallback_target_missing",
    );
    const fixture = await makeSpecialistFixture(artifacts);
    await registry.registerSpecialist(context, fixture.registration);
    const selfReference = await makeSpecialistFixture(artifacts, {
      specialistId: "self-reference",
      fallbackRef: "specialist:self-reference@1",
    });
    await expectCode(
      () => registry.registerSpecialist(context, selfReference.registration),
      "invalid_input",
      "fallback_self_reference",
    );
    const missingFallback = await makeSpecialistFixture(artifacts, {
      specialistId: "missing-fallback",
      fallbackRef: "baseline:missing@1",
    });
    await expectCode(
      () => registry.registerSpecialist(context, missingFallback.registration),
      "invalid_input",
      "fallback_target_missing",
    );
    await registry.registerSpecialist(context, fixture.registration);
    await expectCode(
      () =>
        registry.registerSpecialist(context, {
          ...fixture.registration,
          profile: {
            ...fixture.registration.profile,
            display_name: "conflicting immutable revision",
          },
        }),
      "conflict",
      "revision_immutable",
    );
  });

  test("uses an immediate compare-and-swap across concurrent registries", async () => {
    const root = await newRoot();
    const artifacts = new MemoryArtifacts();
    const first = createRegistry(root, artifacts);
    const second = createRegistry(root, artifacts);
    await first.registerBaseline(context, makeBaseline());
    const fixture = await makeSpecialistFixture(artifacts, {
      specialistId: "cas-specialist",
    });
    await first.registerSpecialist(context, fixture.registration);
    const results = await Promise.allSettled([
      first.promote(context, "cas-specialist", "1", null),
      second.promote(context, "cas-specialist", "1", null),
    ]);
    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(
      1,
    );
    expect(results.filter((item) => item.status === "rejected")).toHaveLength(
      1,
    );
    const failed = results.find((item) => item.status === "rejected");
    expect(failed?.status).toBe("rejected");
    if (failed?.status === "rejected") {
      expect(failed.reason).toBeInstanceOf(SpecialistRegistryError);
      expect((failed.reason as SpecialistRegistryError).code).toBe(
        "stale_revision",
      );
    }
    await expectCode(
      () => second.promote(context, "cas-specialist", "1", null),
      "stale_revision",
    );
    second.close();
    first.close();
  });

  test("serializes concurrent identical and conflicting registrations", async () => {
    const baselineRoot = await newRoot();
    const baselineArtifacts = new MemoryArtifacts();
    const baselineRegistryA = createRegistry(baselineRoot, baselineArtifacts);
    const baselineRegistryB = createRegistry(baselineRoot, baselineArtifacts);
    const baseline = makeBaseline();
    const sameBaselines = await Promise.all([
      baselineRegistryA.registerBaseline(context, baseline),
      baselineRegistryB.registerBaseline(context, baseline),
    ]);
    expect(sameBaselines[0]).toEqual(sameBaselines[1]);

    const conflictingBaselineRoot = await newRoot();
    const conflictingBaselineArtifacts = new MemoryArtifacts();
    const conflictingBaselineA = createRegistry(
      conflictingBaselineRoot,
      conflictingBaselineArtifacts,
    );
    const conflictingBaselineB = createRegistry(
      conflictingBaselineRoot,
      conflictingBaselineArtifacts,
    );
    const baselineResults = await Promise.allSettled([
      conflictingBaselineA.registerBaseline(context, makeBaseline()),
      conflictingBaselineB.registerBaseline(
        context,
        makeBaseline(context.scope, { display_name: "different" }),
      ),
    ]);
    expect(
      baselineResults.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const baselineFailure = baselineResults.find(
      (result) => result.status === "rejected",
    );
    expect(baselineFailure?.status).toBe("rejected");
    if (baselineFailure?.status === "rejected") {
      expect(baselineFailure.reason).toBeInstanceOf(SpecialistRegistryError);
      expect((baselineFailure.reason as SpecialistRegistryError).code).toBe(
        "conflict",
      );
    }

    const root = await newRoot();
    const artifacts = new MemoryArtifacts();
    const registryA = createRegistry(root, artifacts);
    const registryB = createRegistry(root, artifacts);
    await registryA.registerBaseline(context, makeBaseline());
    const identical = await makeSpecialistFixture(artifacts);
    const sameSpecialists = await Promise.all([
      registryA.registerSpecialist(context, identical.registration),
      registryB.registerSpecialist(context, identical.registration),
    ]);
    expect(sameSpecialists[0].candidate_sha256).toBe(
      sameSpecialists[1].candidate_sha256,
    );

    const conflictRoot = await newRoot();
    const conflictArtifacts = new MemoryArtifacts();
    const conflictA = createRegistry(conflictRoot, conflictArtifacts);
    const conflictB = createRegistry(conflictRoot, conflictArtifacts);
    await conflictA.registerBaseline(context, makeBaseline());
    const candidateA = await makeSpecialistFixture(conflictArtifacts, {
      specialistId: "concurrent",
    });
    const candidateB = await makeSpecialistFixture(conflictArtifacts, {
      specialistId: "concurrent",
      modelId: "specialist-model-2",
      providerModel: "specialist-upstream-2",
    });
    const specialistResults = await Promise.allSettled([
      conflictA.registerSpecialist(context, candidateA.registration),
      conflictB.registerSpecialist(context, candidateB.registration),
    ]);
    expect(
      specialistResults.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const specialistFailure = specialistResults.find(
      (result) => result.status === "rejected",
    );
    expect(specialistFailure?.status).toBe("rejected");
    if (specialistFailure?.status === "rejected") {
      expect(specialistFailure.reason).toBeInstanceOf(SpecialistRegistryError);
      expect((specialistFailure.reason as SpecialistRegistryError).detail).toBe(
        "revision_immutable",
      );
    }
  });

  test("reverifies a proposed report when a host verifier becomes available", async () => {
    const root = await newRoot();
    const artifacts = new MemoryArtifacts();
    const proposedRegistry = createRegistry(root, artifacts, {
      evidenceVerifier: null,
    });
    await proposedRegistry.registerBaseline(context, makeBaseline());
    const fixture = await makeSpecialistFixture(artifacts);
    const proposed = await proposedRegistry.registerSpecialist(
      context,
      fixture.registration,
    );
    expect(proposed.status).toBe("proposed");
    expect(proposed.verdict.codes).toContain("evidence_unverified");
    proposedRegistry.close();

    const verifiedRegistry = createRegistry(root, artifacts);
    const verified = await verifiedRegistry.reverify(
      context,
      "specialist-1",
      "1",
    );
    expect(verified.status).toBe("evaluated");
  });

  test("rejects malformed reports, invalid signatures, and synthetic fixtures when disabled", async () => {
    const cases: Array<{
      label: string;
      fixtureOptions?: Parameters<typeof makeSpecialistFixture>[1];
      registryOptions?: Parameters<typeof createRegistry>[2];
      expected: ReasonCode;
    }> = [
      {
        label: "training-job JSON instead of report",
        fixtureOptions: {
          reportTransform: () => ({ training_completed: true }),
        },
        expected: "evidence_malformed",
      },
      {
        label: "missing prompt-optimized arm result",
        fixtureOptions: {
          reportTransform: (report) => ({
            ...report,
            results: (report.results as Array<{ arm: string }>).filter(
              (result) => result.arm !== "prompt_optimized_baseline",
            ),
          }),
        },
        expected: "evidence_malformed",
      },
      {
        label: "unequal arm task sets",
        fixtureOptions: {
          reportTransform: (report) => ({
            ...report,
            heldout: {
              ...(report.heldout as Record<string, unknown>),
              task_ids: ["heldout-task-1", "heldout-task-2"],
            },
            results: (report.results as Array<Record<string, unknown>>).map(
              (result) =>
                result.arm === "candidate"
                  ? { ...result, task_ids: ["heldout-task-2"] }
                  : { ...result, task_ids: ["heldout-task-1"] },
            ),
          }),
        },
        expected: "evidence_malformed",
      },
      {
        label: "bad mac",
        fixtureOptions: {
          tamperSignature: "bad_mac",
        },
        expected: "evidence_unverified",
      },
      {
        label: "unknown key",
        fixtureOptions: { tamperSignature: "unknown_key" },
        expected: "evidence_unverified",
      },
      {
        label: "unauthorized owner",
        registryOptions: {
          evidenceVerifier: evidenceVerifier({ ownerIds: [] }),
        },
        expected: "evidence_unverified",
      },
      {
        label: "unauthorized evaluator",
        registryOptions: {
          evidenceVerifier: evidenceVerifier({ evaluatorIds: [] }),
        },
        expected: "evidence_unverified",
      },
      {
        label: "synthetic evidence disabled",
        registryOptions: { allowSyntheticFixtures: false },
        expected: "evidence_synthetic_fixture",
      },
    ];
    for (const item of cases) {
      const root = await newRoot();
      const artifacts = new MemoryArtifacts();
      const registry = createRegistry(root, artifacts, item.registryOptions);
      await registry.registerBaseline(context, makeBaseline());
      const fixture = await makeSpecialistFixture(
        artifacts,
        item.fixtureOptions,
      );
      const view = await registry.registerSpecialist(
        context,
        fixture.registration,
      );
      expect(view.verdict.codes, item.label).toContain(item.expected);
      expect(view.status, item.label).toBe(
        [
          "evidence_missing",
          "evidence_unverified",
          "lineage_missing",
          "lineage_unverified",
        ].includes(item.expected)
          ? "proposed"
          : "rejected",
      );
    }
  });

  test("binds the report base arm and verifies report and lineage digests", async () => {
    const { registry, artifacts } = await setupRegistry();
    const wrongBase = await makeSpecialistFixture(artifacts, {
      specialistId: "wrong-report-base",
      reportTransform: (report) => ({
        ...report,
        arms: (report.arms as Array<Record<string, unknown>>).map((arm) =>
          arm.arm === "base"
            ? {
                ...arm,
                model: {
                  component: "model/not-the-manifest-base",
                  revision: "1",
                },
              }
            : arm,
        ),
      }),
    });
    const wrongBaseView = await registry.registerSpecialist(
      context,
      wrongBase.registration,
    );
    expect(wrongBaseView.verdict.codes).toContain("evidence_subject_mismatch");

    const reportMismatch = await makeSpecialistFixture(artifacts, {
      specialistId: "report-digest-mismatch",
    });
    const alteredReport = Uint8Array.from(reportMismatch.reportBytes);
    alteredReport[0] = (alteredReport[0] ?? 0) ^ 1;
    artifacts.set(reportMismatch.registration.evaluation, alteredReport);
    const reportMismatchView = await registry.registerSpecialist(
      context,
      reportMismatch.registration,
    );
    expect(reportMismatchView.verdict.codes).toContain(
      "evidence_digest_mismatch",
    );

    const lineageRoot = await newRoot();
    const lineageArtifacts = new MemoryArtifacts();
    const lineageRegistry = createRegistry(lineageRoot, lineageArtifacts);
    await lineageRegistry.registerBaseline(context, makeBaseline());
    const lineage = await makeLineageArtifact(lineageArtifacts);
    const alteredLineage = new TextEncoder().encode("{}");
    lineageArtifacts.set(lineage, alteredLineage);
    const lineageFixture = await makeSpecialistFixture(lineageArtifacts, {
      datasetLineage: lineage,
    });
    const lineageView = await lineageRegistry.registerSpecialist(
      context,
      lineageFixture.registration,
    );
    expect(lineageView.verdict.codes).toContain("lineage_digest_mismatch");
  });

  test("rejects held-out leakage, non-independent evaluators, and non-improving candidates", async () => {
    const { registry, artifacts } = await setupRegistry();
    const leakedLineage = await makeLineageArtifact(artifacts, context.scope, {
      trainTaskIds: ["heldout-task-1"],
    });
    const leaked = await makeSpecialistFixture(artifacts, {
      datasetLineage: leakedLineage,
    });
    const leakedView = await registry.registerSpecialist(
      context,
      leaked.registration,
    );
    expect(leakedView.verdict.codes).toContain("lineage_leakage");
    const leakedSplit = await makeLineageArtifact(artifacts, context.scope, {
      specialistId: "split-leak",
      datasetSha256: "a".repeat(64),
    });
    const splitLeak = await makeSpecialistFixture(artifacts, {
      specialistId: "split-leak",
      datasetLineage: leakedSplit,
    });
    const splitLeakView = await registry.registerSpecialist(
      context,
      splitLeak.registration,
    );
    expect(splitLeakView.verdict.codes).toContain("lineage_leakage");

    const dependentLineage = await makeLineageArtifact(
      artifacts,
      context.scope,
      {
        specialistId: "dependent-evaluator",
        producerId: "eval-1",
      },
    );
    const dependent = await makeSpecialistFixture(artifacts, {
      specialistId: "dependent-evaluator",
      datasetLineage: dependentLineage,
    });
    const dependentView = await registry.registerSpecialist(
      context,
      dependent.registration,
    );
    expect(dependentView.verdict.codes).toContain("evidence_not_independent");

    const noImprovement = await makeSpecialistFixture(artifacts, {
      specialistId: "no-improvement",
      candidatePassed: 0,
      promptPassed: 1,
    });
    const noImprovementView = await registry.registerSpecialist(
      context,
      noImprovement.registration,
    );
    expect(noImprovementView.verdict.codes).toContain("evaluation_gate_failed");

    const regression = await makeSpecialistFixture(artifacts, {
      specialistId: "regression",
      reportTransform: (report) => ({
        ...report,
        regressions: [
          {
            task_id: "heldout-task-1",
            domain: "coding/mechanical-edit",
            compared_to: "base",
          },
        ],
      }),
    });
    const regressionView = await registry.registerSpecialist(
      context,
      regression.registration,
    );
    expect(regressionView.verdict.codes).toContain("regressions_exceeded");

    const missingCost = await makeSpecialistFixture(artifacts, {
      specialistId: "missing-cost",
      costUsdTotal: null,
      acceptance: { max_cost_usd_per_task: 1 },
    });
    const missingCostView = await registry.registerSpecialist(
      context,
      missingCost.registration,
    );
    expect(missingCostView.verdict.codes).toContain("cost_unmeasured");
  });

  test("keeps exact domain, role, and complexity coverage gates", async () => {
    const { registry, artifacts } = await setupRegistry();
    const fixture = await makeSpecialistFixture(artifacts);
    await registry.registerSpecialist(context, fixture.registration);
    await registry.promote(context, "specialist-1", "1", null);
    const exact = await registry.route(context, routingRequest());
    expect(exact.outcome).toBe("specialist");
    const nearDomain = await registry.route(
      context,
      routingRequest({ domain: "coding/mechanical" }),
    );
    expect(nearDomain.fallback?.reason_code).toBe("no_covering_specialist");
    expect(nearDomain.rejected[0]?.reasons).toContain("domain_not_covered");
    const extraSuffix = await registry.route(
      context,
      routingRequest({ domain: "coding/mechanical-edit-extra" }),
    );
    expect(extraSuffix.fallback?.reason_code).toBe("no_covering_specialist");
    const wrongRole = await registry.route(
      context,
      routingRequest({ role: "reviewer" }),
    );
    expect(wrongRole.rejected[0]?.reasons).toContain("role_not_covered");
    const wrongComplexity = await registry.route(
      context,
      routingRequest({ complexity: "heavy" }),
    );
    expect(wrongComplexity.rejected[0]?.reasons).toContain(
      "complexity_not_covered",
    );
    await expectCode(
      () =>
        registry.route(
          context,
          routingRequest({ domain: "Coding/Mechanical-Edit" }),
        ),
      "invalid_input",
      "routing_request_invalid",
    );
    const reportMissingDomain = await makeSpecialistFixture(artifacts, {
      specialistId: "report-missing-domain",
      domains: ["coding/mechanical-edit", "coding/research"],
    });
    await registry.registerSpecialist(
      context,
      reportMissingDomain.registration,
    );
    await registry.promote(context, "report-missing-domain", "1", null);
    const missingDomain = await registry.route(
      context,
      routingRequest({ domain: "coding/research" }),
    );
    expect(missingDomain.rejected.map((item) => item.ref)).toContain(
      "specialist:report-missing-domain@1",
    );
    expect(
      missingDomain.rejected.find(
        (item) => item.ref === "specialist:report-missing-domain@1",
      )?.reasons,
    ).toContain("domain_not_covered");
  });

  test("rechecks evidence on every route and falls back after artifact removal", async () => {
    const { registry, artifacts } = await setupRegistry();
    const fixture = await makeSpecialistFixture(artifacts);
    await registry.registerSpecialist(context, fixture.registration);
    await registry.promote(context, "specialist-1", "1", null);
    artifacts.delete(fixture.registration.evaluation);
    const decision = await registry.route(context, routingRequest());
    expect(decision.outcome).toBe("baseline");
    expect(decision.fallback?.reason_code).toBe(
      "intended_specialist_ineligible",
    );
    expect(decision.rejected[0]?.reasons).toContain("evidence_missing");
    expect(decision.fallback?.chain[0]?.ref).toBe("baseline:baseline@1");
  });

  test("rejects stale current-specialist evidence at promotion", async () => {
    const { registry, artifacts } = await setupRegistry();
    const first = await makeSpecialistFixture(artifacts, {
      specialistId: "freshness",
      revision: "1",
    });
    await registry.registerSpecialist(context, first.registration);
    await registry.promote(context, "freshness", "1", null);

    const stale = await makeSpecialistFixture(artifacts, {
      specialistId: "freshness",
      revision: "2",
      currentRevision: null,
    });
    const staleVerdict = await verifyEvidence(
      context,
      stale.registration,
      stale.candidateSha256,
      {
        artifacts,
        evidenceVerifier: evidenceVerifier(),
        allowSyntheticFixtures: true,
        currentProductionRevision: "1",
        checkCurrentFreshness: true,
      },
    );
    expect(staleVerdict.codes).toContain("evidence_stale_current_baseline");
    await registry.registerSpecialist(context, stale.registration);
    await expectCode(
      () => registry.promote(context, "freshness", "2", "1"),
      "invalid_state",
      "not_evaluated",
    );

    const valid = await makeSpecialistFixture(artifacts, {
      specialistId: "freshness",
      revision: "3",
      currentRevision: "1",
    });
    await registry.registerSpecialist(context, valid.registration);
    await registry.promote(context, "freshness", "3", "1");
    expect(
      (await registry.inspect(context, "freshness")).pointer
        .production_revision,
    ).toBe("3");
  });

  test("invalidates dependent revisions without silently changing the pointer", async () => {
    const { registry, artifacts } = await setupRegistry();
    const lineage = await makeLineageArtifact(artifacts);
    const fixture = await makeSpecialistFixture(artifacts, {
      datasetLineage: lineage,
    });
    await registry.registerSpecialist(context, fixture.registration);
    await registry.promote(context, "specialist-1", "1", null);
    const result = await registry.invalidateDependency(
      context,
      { artifact_sha256: lineage.sha256 },
      "lineage-revoked",
    );
    expect(result.invalidated).toEqual([
      { specialist_id: "specialist-1", revision: "1" },
    ]);
    expect(
      (await registry.inspect(context, "specialist-1")).pointer
        .production_revision,
    ).toBe("1");
    const route = await registry.route(context, routingRequest());
    expect(route.outcome).toBe("baseline");
    expect(route.rejected[0]?.reasons).toContain("invalidated");
    await expectCode(
      () => registry.promote(context, "specialist-1", "1", "1"),
      "invalid_state",
      "not_evaluated",
    );
  });

  test("invalidates tokenizer revisions and lineage dataset hashes", async () => {
    const { registry, artifacts } = await setupRegistry();
    const datasetHash = "f".repeat(64);
    const lineage = await makeLineageArtifact(artifacts, context.scope, {
      datasetSha256: datasetHash,
    });
    const fixture = await makeSpecialistFixture(artifacts, {
      datasetLineage: lineage,
    });
    await registry.registerSpecialist(context, fixture.registration);
    const tokenizerResult = await registry.invalidateDependency(
      context,
      { component: "tokenizer/base", revision: "1" },
      "tokenizer-replaced",
    );
    expect(tokenizerResult.invalidated).toContainEqual({
      specialist_id: fixture.registration.specialist_id,
      revision: fixture.registration.revision,
    });
    const datasetResult = await registry.invalidateDependency(
      context,
      { artifact_sha256: datasetHash },
      "dataset-revoked",
    );
    expect(datasetResult.invalidated).toContainEqual({
      specialist_id: fixture.registration.specialist_id,
      revision: fixture.registration.revision,
    });
  });

  test("checks adapter structure and host serving attestations", async () => {
    const { root, registry, artifacts } = await setupRegistry();
    const adapter = artifactRef("adapter-bytes", new Uint8Array([1, 2, 3]));
    const lineage = await makeLineageArtifact(artifacts, context.scope, {
      specialistId: "adapter-specialist",
    });
    const chatTemplate = artifactRef("template-adapter-specialist");
    const adapterSpec = {
      format: "peft-lora" as const,
      base_model: { component: "model/base", revision: "1" },
      tokenizer: { component: "tokenizer/base", revision: "1" },
      chat_template_sha256: chatTemplate.sha256,
    };
    const fixture = await makeSpecialistFixture(artifacts, {
      specialistId: "adapter-specialist",
      adapter,
      adapterFormat: "peft-lora",
      adapterSpec,
      datasetLineage: lineage,
    });
    await registry.registerSpecialist(context, fixture.registration);

    const attestor = (
      revision: string,
      overrides: {
        model_id?: string;
        tokenizer?: { component: string; revision: string };
        chat_template_sha256?: string;
        adapter_formats?: string[];
        loaded_adapter_sha256s?: string[];
      } = {},
    ) => ({
      async attest() {
        return {
          model_id: overrides.model_id ?? "specialist-model",
          provider_id: "local",
          provider_model: "specialist-upstream",
          base_model: { component: "model/base", revision },
          tokenizer: overrides.tokenizer ?? {
            component: "tokenizer/base",
            revision: "1",
          },
          chat_template_sha256:
            overrides.chat_template_sha256 ?? chatTemplate.sha256,
          adapter_formats: overrides.adapter_formats ?? ["peft-lora"],
          loaded_adapter_sha256s: overrides.loaded_adapter_sha256s ?? [
            adapter.sha256,
          ],
        };
      },
    });
    const compatibleRegistry = createRegistry(root, artifacts, {
      servingAttestor: attestor("1"),
    });
    const compatible = await compatibleRegistry.route(
      context,
      routingRequest({
        override: { ref: "specialist:adapter-specialist@1" },
      }),
    );
    expect(compatible.outcome).toBe("specialist");
    expect(compatible.selected?.serving_attestation).toBe("verified");

    const mismatchedRegistry = createRegistry(root, artifacts, {
      servingAttestor: attestor("2"),
    });
    const mismatched = await mismatchedRegistry.route(
      context,
      routingRequest({
        override: { ref: "specialist:adapter-specialist@1" },
      }),
    );
    expect(mismatched.outcome).toBe("override_rejected");
    expect(mismatched.rejected[0]?.reasons).toContain("serving_base_mismatch");

    const attestationCases = [
      {
        id: "tokenizer",
        attestor: attestor("1", {
          tokenizer: { component: "tokenizer/other", revision: "1" },
        }),
        reason: "serving_tokenizer_mismatch",
      },
      {
        id: "template",
        attestor: attestor("1", { chat_template_sha256: "0".repeat(64) }),
        reason: "serving_chat_template_mismatch",
      },
      {
        id: "adapter-format",
        attestor: attestor("1", { adapter_formats: [] }),
        reason: "serving_adapter_unsupported",
      },
      {
        id: "adapter-loaded",
        attestor: attestor("1", { loaded_adapter_sha256s: [] }),
        reason: "serving_adapter_not_loaded",
      },
      {
        id: "binding",
        attestor: attestor("1", { model_id: "different-model" }),
        reason: "model_binding_mismatch",
      },
    ] as const;
    for (const item of attestationCases) {
      const checked = createRegistry(root, artifacts, {
        servingAttestor: item.attestor,
      });
      const decision = await checked.route(
        context,
        routingRequest({
          override: { ref: "specialist:adapter-specialist@1" },
        }),
      );
      expect(decision.rejected[0]?.reasons).toContain(item.reason);
    }
    const throwingAttestor = createRegistry(root, artifacts, {
      servingAttestor: {
        async attest() {
          throw new Error("synthetic attestor failure");
        },
      },
    });
    expect(
      (
        await throwingAttestor.route(
          context,
          routingRequest({
            override: { ref: "specialist:adapter-specialist@1" },
          }),
        )
      ).rejected[0]?.reasons,
    ).toContain("serving_unattested");

    const unattestedRegistry = createRegistry(root, artifacts);
    const unattested = await unattestedRegistry.route(
      context,
      routingRequest({
        override: { ref: "specialist:adapter-specialist@1" },
      }),
    );
    expect(unattested.rejected[0]?.reasons).toContain("serving_unattested");

    const invalidSpecs = [
      {
        id: "bad-adapter-base",
        spec: {
          ...adapterSpec,
          base_model: { component: "model/base", revision: "2" },
        },
        format: "peft-lora" as const,
        detail: "adapter_base_mismatch",
      },
      {
        id: "bad-adapter-tokenizer",
        spec: {
          ...adapterSpec,
          tokenizer: { component: "tokenizer/other", revision: "1" },
        },
        format: "peft-lora" as const,
        detail: "adapter_tokenizer_mismatch",
      },
      {
        id: "bad-adapter-template",
        spec: {
          ...adapterSpec,
          chat_template_sha256: "e".repeat(64),
        },
        format: "peft-lora" as const,
        detail: "adapter_chat_template_mismatch",
      },
      {
        id: "bad-adapter-format",
        spec: adapterSpec,
        format: null,
        detail: "serving_format_mismatch",
      },
    ] as const;
    for (const item of invalidSpecs) {
      const itemLineage = await makeLineageArtifact(artifacts, context.scope, {
        specialistId: item.id,
      });
      const invalid = await makeSpecialistFixture(artifacts, {
        specialistId: item.id,
        adapter,
        adapterFormat: item.format,
        adapterSpec: item.spec,
        datasetLineage: itemLineage,
      });
      await expectCode(
        () => registry.registerSpecialist(context, invalid.registration),
        "invalid_input",
        item.detail,
      );
    }
  });

  test("checks pricing, availability, and model capabilities", async () => {
    const paidCatalog = fakeCatalog({
      allowPaid: false,
      models: [
        fakeModel({
          id: "specialist-model",
          providerId: "remote",
          model: "specialist-upstream",
          pricing: {
            free: false,
            inputPerMTokUsd: 1,
            outputPerMTokUsd: 2,
          },
          capabilities: {
            tools: false,
            vision: false,
            contextWindow: 512,
            reasoning: false,
          },
        }),
        fakeModel({
          id: "baseline-model",
          providerId: "local",
          model: "baseline-upstream",
        }),
      ],
      unavailableProviders: ["remote"],
    });
    const { registry, artifacts } = await setupRegistry({
      catalog: paidCatalog,
    });
    const fixture = await makeSpecialistFixture(artifacts, {
      providerId: "remote",
    });
    await registry.registerSpecialist(context, fixture.registration);
    await registry.promote(context, "specialist-1", "1", null);
    const decision = await registry.route(
      context,
      routingRequest({
        requires: {
          tools: true,
          vision: true,
          reasoning: true,
          min_context_tokens: 1000,
        },
      }),
    );
    const reasons = decision.rejected[0]?.reasons ?? [];
    for (const reason of [
      "paid_not_allowed",
      "paid_consent_missing",
      "provider_unavailable",
      "capability_tools",
      "capability_vision",
      "capability_reasoning",
      "capability_context",
    ] as const) {
      expect(reasons).toContain(reason);
    }
    const runtimeExceeded = await registry.route(
      context,
      routingRequest({
        budget: {
          max_tokens: 1000,
          max_usd: 1,
          max_duration_ms: 50,
          max_depth: 2,
          max_concurrency: 1,
        },
      }),
    );
    expect(runtimeExceeded.rejected[0]?.reasons).toContain(
      "budget_runtime_exceeded",
    );

    const expensive = await makeSpecialistFixture(artifacts, {
      specialistId: "expensive-specialist",
      providerId: "remote",
      costUsdTotal: 0.02,
    });
    await registry.registerSpecialist(context, expensive.registration);
    await registry.promote(context, "expensive-specialist", "1", null);
    const measuredCostExceeded = await registry.route(
      context,
      routingRequest({
        budget: {
          max_tokens: 1000,
          max_usd: 0.01,
          max_duration_ms: 1000,
          max_depth: 2,
          max_concurrency: 1,
        },
      }),
    );
    expect(
      measuredCostExceeded.rejected.find(
        (item) => item.ref === "specialist:expensive-specialist@1",
      )?.reasons,
    ).toContain("budget_cost_exceeded");
  });

  test("applies baseline paid consent, price upper bounds, and unknown-price gates", async () => {
    const pricedCatalog = fakeCatalog({ allowPaid: true });
    const { registry } = await setupRegistry({ catalog: pricedCatalog });
    await registry.registerBaseline(
      context,
      makeBaseline(context.scope, {
        baseline_id: "paid-baseline",
        model_id: "paid-model",
        provider_id: "remote",
        provider_model: "paid-upstream",
        priority: 0,
      }),
    );
    const noConsent = await registry.route(
      context,
      routingRequest({
        override: { ref: "baseline:paid-baseline@1" },
        paid_consent: false,
      }),
    );
    expect(noConsent.outcome).toBe("override_rejected");
    expect(noConsent.rejected[0]?.reasons).toContain("paid_consent_missing");

    const overBudget = await registry.route(
      context,
      routingRequest({
        override: { ref: "baseline:paid-baseline@1" },
        paid_consent: true,
        budget: {
          max_tokens: 1000,
          max_usd: 0.001,
          max_duration_ms: 1000,
          max_depth: 1,
          max_concurrency: 1,
        },
      }),
    );
    expect(overBudget.rejected[0]?.reasons).toContain("budget_cost_exceeded");

    const withinBudget = await registry.route(
      context,
      routingRequest({
        override: { ref: "baseline:paid-baseline@1" },
        paid_consent: true,
      }),
    );
    expect(withinBudget.outcome).toBe("baseline");
    expect(withinBudget.selected?.cost_basis).toBe(
      "configured_price_upper_bound",
    );

    const unknownCatalog = fakeCatalog({
      allowPaid: true,
      models: [
        fakeModel({
          id: "unknown-priced-model",
          providerId: "remote",
          model: "unknown-priced-upstream",
          pricing: { free: false },
        }),
      ],
    });
    const unknown = await setupRegistry({ catalog: unknownCatalog });
    await unknown.registry.registerBaseline(
      context,
      makeBaseline(context.scope, {
        baseline_id: "unknown-priced",
        model_id: "unknown-priced-model",
        provider_id: "remote",
        provider_model: "unknown-priced-upstream",
        priority: 0,
      }),
    );
    const unknownPrice = await unknown.registry.route(
      context,
      routingRequest({
        override: { ref: "baseline:unknown-priced@1" },
        paid_consent: true,
      }),
    );
    expect(unknownPrice.rejected[0]?.reasons).toContain("pricing_unknown");
  });

  test("never treats a specialist tag or an earlier successful task as evidence", async () => {
    const catalog = fakeCatalog({
      models: [
        fakeModel({
          id: "baseline-model",
          providerId: "local",
          model: "baseline-upstream",
        }),
        fakeModel({
          id: "tagged-model",
          providerId: "local",
          model: "tagged-specialist",
          tags: ["specialist"],
        }),
        fakeModel({
          id: "specialist-model",
          providerId: "local",
          model: "specialist-upstream",
        }),
      ],
    });
    const { registry, artifacts } = await setupRegistry({ catalog });
    const tagOnly = await makeSpecialistFixture(artifacts, {
      specialistId: "tagged-specialist",
      modelId: "tagged-model",
      providerModel: "tagged-specialist",
      reportTransform: () => ({ training_completed: true }),
    });
    const tagOnlyView = await registry.registerSpecialist(
      context,
      tagOnly.registration,
    );
    expect(tagOnlyView.status).toBe("rejected");
    expect((await registry.route(context, routingRequest())).outcome).toBe(
      "baseline",
    );

    const good = await makeSpecialistFixture(artifacts, {
      specialistId: "prior-success",
    });
    await registry.registerSpecialist(context, good.registration);
    await registry.promote(context, "prior-success", "1", null);
    expect(
      (await registry.route(context, routingRequest())).selected?.ref,
    ).toBe("specialist:prior-success@1");
    const rejected = await makeSpecialistFixture(artifacts, {
      specialistId: "prior-success",
      revision: "2",
      reportTransform: () => ({ training_completed: true }),
    });
    expect(
      (await registry.registerSpecialist(context, rejected.registration))
        .status,
    ).toBe("rejected");
    const afterRejectedRevision = await registry.route(
      context,
      routingRequest(),
    );
    expect(afterRejectedRevision.selected?.ref).toBe(
      "specialist:prior-success@1",
    );
  });

  test("selects with deterministic ranking and stable decision digests", async () => {
    const { registry, artifacts } = await setupRegistry({
      catalog: fakeCatalog({
        models: [
          fakeModel({
            id: "baseline-model",
            providerId: "local",
            model: "baseline-upstream",
          }),
          fakeModel({
            id: "specialist-model",
            providerId: "local",
            model: "specialist-upstream",
          }),
          fakeModel({
            id: "specialist-model-2",
            providerId: "local",
            model: "specialist-upstream",
          }),
        ],
      }),
    });
    const fixtures = await Promise.all([
      makeSpecialistFixture(artifacts, {
        specialistId: "rank-cost",
        modelId: "specialist-model",
        costUsdTotal: 0.02,
      }),
      makeSpecialistFixture(artifacts, {
        specialistId: "rank-name",
        modelId: "specialist-model-2",
        costUsdTotal: 0.01,
      }),
    ]);
    for (const fixture of fixtures) {
      await registry.registerSpecialist(context, fixture.registration);
      await registry.promote(
        context,
        fixture.registration.specialist_id,
        fixture.registration.revision,
        null,
      );
    }
    const first = await registry.route(context, routingRequest());
    const second = await registry.route(context, routingRequest());
    expect(first.selected?.ref).toBe("specialist:rank-name@1");
    expect(first.decision_sha256).toBe(second.decision_sha256);
    expect(first.explanation).toEqual(second.explanation);
    expect(first.ranking.map((item) => item.ref)).toEqual([
      "specialist:rank-name@1",
      "specialist:rank-cost@1",
    ]);
  });

  test("uses explicit overrides and never overrides failed gates", async () => {
    const { registry, artifacts } = await setupRegistry();
    const production = await makeSpecialistFixture(artifacts, {
      specialistId: "production",
    });
    await registry.registerSpecialist(context, production.registration);
    await registry.promote(context, "production", "1", null);
    const candidate = await makeSpecialistFixture(artifacts, {
      specialistId: "non-production",
      revision: "2",
    });
    await registry.registerSpecialist(context, candidate.registration);
    const validOverride = await registry.route(
      context,
      routingRequest({ override: { ref: "specialist:non-production@2" } }),
    );
    expect(validOverride.outcome).toBe("specialist");
    expect(validOverride.selected?.ref).toBe("specialist:non-production@2");
    const invalidOverride = await registry.route(
      context,
      routingRequest({
        override: { ref: "specialist:non-production@2" },
        domain: "coding/other",
      }),
    );
    expect(invalidOverride.outcome).toBe("override_rejected");
    expect(invalidOverride.selected).toBeNull();
    expect(invalidOverride.rejected[0]?.reasons).toContain(
      "domain_not_covered",
    );
  });

  test("supports the registry lifecycle, evaluation delegation, and contract adapter", async () => {
    const unavailable = await setupRegistry();
    const unavailableFixture = await makeSpecialistFixture(
      unavailable.artifacts,
      {
        specialistId: "no-evaluation-service",
      },
    );
    await unavailable.registry.registerSpecialist(
      context,
      unavailableFixture.registration,
    );
    await expectCode(
      () => unavailable.registry.evaluate(context, "no-evaluation-service@1"),
      "evaluation_unavailable",
    );

    const root = await newRoot();
    const artifacts = new MemoryArtifacts();
    const service: EvaluationService = {
      async submitComparison(_ctx, input_manifest) {
        return { job_id: "fake-job", input_manifest };
      },
      async inspect() {
        throw new Error("not used");
      },
      async cancel() {},
    };
    const registry = createRegistry(root, artifacts, {
      evaluation: {
        service,
        artifacts: {
          async put(_ctx, bytes, media_type) {
            return {
              artifact_id: "evaluation-request",
              sha256: sha256(bytes),
              media_type,
              byte_length: bytes.byteLength,
            };
          },
        },
        defaultBudget: {
          max_tokens: 1000,
          max_usd: 1,
          max_duration_ms: 1000,
          max_depth: 1,
          max_concurrency: 1,
        },
      },
      taskRouting: () => routingRequest({ task_id: "contract-task" }),
    });
    await registry.registerBaseline(context, makeBaseline());
    const task: Task = {
      schema_version: 1,
      task_id: "contract-task",
      session_id: "session-1",
      scope: context.scope,
      revision: 0,
      request: "synthetic contract task",
      acceptance_criteria: ["synthetic"],
      budget: {
        max_tokens: 1000,
        max_usd: 1,
        max_duration_ms: 1000,
        max_depth: 1,
        max_concurrency: 1,
      },
      status: "pending",
      specialist_revision: null,
      artifacts: [],
    };
    const v1 = await makeSpecialistFixture(artifacts, {
      specialistId: "lifecycle",
      revision: "1",
    });
    const { profile: _profile, ...manifestWithoutProfile } = v1.registration;
    await expectCode(
      () => registry.register(context, manifestWithoutProfile),
      "invalid_input",
      "profile_required",
    );
    await expectCode(
      () => createRegistry(root, artifacts).select(context, task),
      "invalid_input",
      "task_routing_unconfigured",
    );
    await registry.registerSpecialist(context, v1.registration);
    const job: JobRef = await registry.evaluate(context, "lifecycle@1");
    expect(job.job_id).toBe("fake-job");
    expect(await registry.evaluationJobs(context, "lifecycle", "1")).toEqual([
      job,
    ]);
    await registry.deploy(context, "lifecycle@1", "none");
    const v2 = await makeSpecialistFixture(artifacts, {
      specialistId: "lifecycle",
      revision: "2",
      currentRevision: "1",
    });
    await registry.registerSpecialist(context, v2.registration);
    await registry.promote(context, "lifecycle", "2", "1");
    await expectCode(
      () => registry.rollback(context, "lifecycle", "wrong"),
      "stale_revision",
    );
    expect(
      (await registry.inspect(context, "lifecycle")).pointer
        .production_revision,
    ).toBe("2");
    await registry.rollback(context, "lifecycle", "2");
    expect(
      (await registry.inspect(context, "lifecycle")).pointer
        .production_revision,
    ).toBe("1");
    await expectCode(
      () => registry.retire(context, "lifecycle", "wrong"),
      "stale_revision",
    );
    await registry.retire(context, "lifecycle", "1");
    expect((await registry.route(context, routingRequest())).outcome).toBe(
      "baseline",
    );
    await expectCode(() => registry.select(context, task), "baseline_selected");
    await registry.rollback(context, "lifecycle", "none");
    await expectCode(
      () => registry.archive(context, "lifecycle", "1"),
      "invalid_state",
      "production_revision",
    );

    expect((await registry.select(context, task)).manifest.specialist_id).toBe(
      "lifecycle",
    );
    const compatible = await registry.verifyCompatibility(
      context,
      "lifecycle@1",
      {
        component: "model/base",
        revision: "1",
      },
    );
    expect(compatible.compatible).toBe(true);
  });

  test("delegates no work and rejects retries after side effects", async () => {
    const { registry, artifacts } = await setupRegistry();
    const fixture = await makeSpecialistFixture(artifacts);
    await registry.registerSpecialist(context, fixture.registration);
    await registry.promote(context, "specialist-1", "1", null);
    const decision = await registry.route(context, routingRequest());
    for (const side_effects of [
      "output_emitted",
      "tools_executed",
      "unknown",
    ] as const) {
      await expectCode(
        () =>
          registry.fallbackAfterFailure(context, decision.decision_id, {
            ref: decision.selected?.ref ?? "",
            side_effects,
          }),
        "fallback_after_side_effects",
      );
    }
  });

  test("rejects rollback onto an invalidated history target without moving the pointer", async () => {
    const { registry, artifacts } = await setupRegistry();
    const first = await makeSpecialistFixture(artifacts, {
      specialistId: "rollback-target",
      revision: "1",
    });
    await registry.registerSpecialist(context, first.registration);
    await registry.promote(context, "rollback-target", "1", null);
    const second = await makeSpecialistFixture(artifacts, {
      specialistId: "rollback-target",
      revision: "2",
      currentRevision: "1",
    });
    await registry.registerSpecialist(context, second.registration);
    await registry.promote(context, "rollback-target", "2", "1");
    await registry.invalidateDependency(
      context,
      { artifact_sha256: first.registration.evaluation.sha256 },
      "old-evidence-revoked",
    );
    await expectCode(
      () => registry.rollback(context, "rollback-target", "2"),
      "invalid_state",
      "rollback_target_invalid",
    );
    expect(
      (await registry.inspect(context, "rollback-target")).pointer
        .production_revision,
    ).toBe("2");
  });

  test("rejects catalog binding changes during route and promotion", async () => {
    const { root, artifacts, registry } = await setupRegistry();
    const fixture = await makeSpecialistFixture(artifacts);
    await registry.registerSpecialist(context, fixture.registration);
    const mismatchedCatalog = fakeCatalog({
      models: [
        fakeModel({
          id: "baseline-model",
          providerId: "local",
          model: "baseline-upstream",
        }),
        fakeModel({
          id: "specialist-model",
          providerId: "local",
          model: "changed-upstream",
        }),
      ],
    });
    const mismatched = createRegistry(root, artifacts, {
      catalog: mismatchedCatalog,
    });
    await expectCode(
      () =>
        mismatched.promote(
          context,
          fixture.registration.specialist_id,
          "1",
          null,
        ),
      "invalid_state",
      "model_binding_mismatch",
    );
    await registry.promote(
      context,
      fixture.registration.specialist_id,
      "1",
      null,
    );
    const decision = await mismatched.route(context, routingRequest());
    expect(
      decision.rejected.find(
        (item) =>
          item.ref ===
          `specialist:${fixture.registration.specialist_id}@${fixture.registration.revision}`,
      )?.reasons,
    ).toContain("model_binding_mismatch");
  });

  test("marks unmeasured free-model cost as free", async () => {
    const { registry, artifacts } = await setupRegistry();
    const fixture = await makeSpecialistFixture(artifacts, {
      costUsdTotal: null,
    });
    await registry.registerSpecialist(context, fixture.registration);
    await registry.promote(
      context,
      fixture.registration.specialist_id,
      "1",
      null,
    );
    const bindings = await checkSpecialistBindings(
      context,
      fixture.registration,
      routingRequest(),
      { cost_usd_per_task: null, runtime_ms_p95: null },
      { catalog: fakeCatalog() },
    );
    expect(bindings[0]?.cost_basis).toBe("free");
  });

  test("retries only before side effects, excludes attempted refs, and caps attempts", async () => {
    const { registry, artifacts } = await setupRegistry();
    for (let index = 2; index <= 10; index += 1) {
      await registry.registerBaseline(
        context,
        makeBaseline(context.scope, {
          baseline_id: `baseline-${index}`,
          priority: index,
        }),
      );
    }
    const fixture = await makeSpecialistFixture(artifacts);
    await registry.registerSpecialist(context, fixture.registration);
    await registry.promote(context, "specialist-1", "1", null);
    let decision = await registry.route(context, routingRequest());
    const seen = new Set<string>();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const selected = decision.selected;
      expect(selected).not.toBeNull();
      if (!selected) break;
      expect(seen.has(selected.ref)).toBe(false);
      seen.add(selected.ref);
      decision = await registry.fallbackAfterFailure(
        context,
        decision.decision_id,
        { ref: selected.ref, side_effects: "none" },
      );
    }
    expect(decision.outcome).toBe("unavailable");
    expect(decision.selected).toBeNull();
    expect(decision.attempt).toBe(8);
  });

  test("routes synthetic teams with independent reviewers and baseline fallback", async () => {
    const { registry, artifacts } = await setupRegistry();
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("network disabled in specialist tests");
    }) as unknown as typeof fetch;
    await registry.registerBaseline(
      context,
      makeBaseline(context.scope, {
        baseline_id: "reviewer-baseline",
        model_id: "reviewer-model",
        provider_model: "reviewer-upstream",
        priority: 20,
      }),
    );
    const team = await makeSyntheticTeamFixture(artifacts);
    expect(team.label).toBe(SYNTHETIC_FIXTURE_NOTICE);
    for (const fixture of [team.worker, team.reviewer]) {
      await registry.registerSpecialist(context, fixture.registration);
      await registry.promote(
        context,
        fixture.registration.specialist_id,
        "1",
        null,
      );
    }
    const result = await registry.routeTeam(context, {
      schema_version: 1,
      task_id: "team-task",
      domain: "coding/mechanical-edit",
      complexity: "medium",
      requires: {
        tools: false,
        vision: false,
        reasoning: false,
        min_context_tokens: 1000,
      },
      budget: {
        max_tokens: 1000,
        max_usd: 1,
        max_duration_ms: 1000,
        max_depth: 1,
        max_concurrency: 1,
      },
      paid_consent: false,
      lead: {},
      worker: {},
      reviewer: {},
    });
    expect(result.lead?.outcome).toBe("baseline");
    expect(result.lead?.selected?.kind).toBe("baseline");
    expect(result.worker?.outcome).toBe("specialist");
    expect(result.worker?.selected?.kind).toBe("specialist");
    expect(result.worker?.selected?.cost_basis).toBe("measured");
    expect(result.worker?.selected?.evidence?.synthetic_fixture).toBe(true);
    expect(result.reviewer?.outcome).toBe("baseline");
    expect(result.reviewer?.selected?.model_id).not.toBe(
      result.worker?.selected?.model_id,
    );
    expect(result.reviewer?.selected?.model_id).not.toBe(
      result.lead?.selected?.model_id,
    );
    expect(result.reviewer?.rejected[0]?.reasons).toContain(
      "independence_same_model",
    );
    expect(fetchCalls).toBe(0);
  });

  test("blocks private paths and secret-like strings from publication", async () => {
    const root = await newRoot();
    const artifacts = new MemoryArtifacts();
    const registry = createRegistry(root, artifacts, {
      hostPrivateRoots: [path.join(root, "private")],
    });
    await registry.registerBaseline(context, makeBaseline());
    const pathFixture = await makeSpecialistFixture(artifacts);
    pathFixture.registration.profile.display_name = path.join(
      root,
      "private",
      "display",
    );
    const pathError = await expectCode(
      () => registry.registerSpecialist(context, pathFixture.registration),
      "unsafe_content",
      "publishability",
    );
    expect(pathError.message).not.toContain(root);
    const secretFixture = await makeSpecialistFixture(artifacts, {
      specialistId: "secret-name",
    });
    secretFixture.registration.profile.display_name = "sk-abcdefghijklmnop";
    await expectCode(
      () => registry.registerSpecialist(context, secretFixture.registration),
      "unsafe_content",
      "publishability",
    );
  });
});

describe("routing utilities and provider structural compatibility", () => {
  test("sorts nullable metrics deterministically and identifies fallback cycles/depth", () => {
    const ranked = rankCandidates([
      {
        ref: "a",
        specialist_id: "z",
        revision: "1",
        pass_rate: 0.9,
        cost_usd_per_task: null,
        runtime_ms_p95: null,
      },
      {
        ref: "b",
        specialist_id: "b",
        revision: "1",
        pass_rate: 0.9,
        cost_usd_per_task: 0.1,
        runtime_ms_p95: 300,
      },
      {
        ref: "c",
        specialist_id: "a",
        revision: "1",
        pass_rate: 0.9,
        cost_usd_per_task: 0.1,
        runtime_ms_p95: 200,
      },
    ]);
    expect(ranked.map((item) => item.ref)).toEqual(["c", "b", "a"]);
    expect(
      resolveFallbackChain("a", (ref) => (ref === "a" ? "b" : "a")).error,
    ).toBe("fallback_cycle");
    expect(
      resolveFallbackChain("1", (ref) => String(Number(ref) + 1), 2).error,
    ).toBe("fallback_depth_exceeded");
  });

  test("accepts the real ModelProviderRegistry as a structural ModelCatalog", async () => {
    const root = await newRoot();
    const providerRegistry = await loadModelRegistry({
      cwd: root,
      home: root,
      env: {},
    });
    const catalog: ModelCatalog = providerRegistry;
    expect(typeof catalog.getModel).toBe("function");
    expect(typeof catalog.unavailableReason).toBe("function");
    expect(typeof catalog.policy.allowPaid).toBe("boolean");
  });

  test("keeps canonical hashes independent of evaluation refs", async () => {
    const artifacts = new MemoryArtifacts();
    const fixture = await makeSpecialistFixture(artifacts);
    const changedEvaluation = {
      ...fixture.registration,
      evaluation: artifactRef("another-evaluation"),
    };
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(sha256("synthetic")).toHaveLength(64);
    expect(candidateDigest(changedEvaluation)).toBe(fixture.candidateSha256);
    expect(formatRef("specialist", "x", "1")).toBe("specialist:x@1");
  });
});
