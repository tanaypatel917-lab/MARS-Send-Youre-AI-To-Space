import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EvolutionError } from "./errors";
import { LIVE_ACCEPTANCE_EVIDENCE, liveEvidenceRecord } from "./live-evidence";
import { RunConfigSchema } from "./schemas";
import {
  type ArchiveMember,
  admitToArchive,
  childrenCounts,
  chooseEntry,
  parentProbabilities,
  selectParents,
} from "./selection";
import { pairedInterval, strictMean } from "./stats";
import { addFile, policyPatch, replaceLine, runConfig } from "./test-support";
import { enforcePathPolicy, parsePatch } from "./tree";
import { seededRandom } from "./util";

const member = (
  id: string,
  parent: string | null,
  score: number,
  extra: Partial<ArchiveMember> = {},
): ArchiveMember => ({
  candidate_id: id,
  parent_id: parent,
  score,
  eligible: true,
  seq: Number(id.replace(/\D/g, "") || 0),
  unresolved: ["t1"],
  unstable: [],
  ...extra,
});

const OPTIONS = { lambda: 10, midpoint: 0.5 };
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error instanceof EvolutionError ? error.code : String(error);
  }
  return "no error";
};

describe("DGM parent selection", () => {
  const archive = [
    member("c0", null, 0.4),
    member("c1", "c0", 0.8),
    member("c2", "c1", 0.8),
    member("c3", "c1", 0.8),
    member("c4", "c0", 0.2),
  ];

  test("score_child_prop matches DGM_outer.choose_selfimproves weights", () => {
    const sig = (a: number) => 1 / (1 + Math.exp(-10 * (a - 0.5)));
    const counts = childrenCounts(archive);
    expect(Object.fromEntries(counts)).toEqual({
      c0: 2,
      c1: 2,
      c2: 0,
      c3: 0,
      c4: 0,
    });
    const raw = archive.map(
      (m) => sig(m.score) / (1 + (counts.get(m.candidate_id) ?? 0)),
    );
    const total = raw.reduce((a, b) => a + b, 0);
    const probabilities = parentProbabilities(
      archive,
      "score_child_prop",
      OPTIONS,
    );
    for (const [i, m] of archive.entries())
      expect(probabilities.get(m.candidate_id)).toBeCloseTo(
        (raw[i] as number) / total,
        12,
      );
    const scoreProp = parentProbabilities(archive, "score_prop", OPTIONS);
    expect(scoreProp.get("c1")).toBeCloseTo(scoreProp.get("c2") as number, 12);
  });

  test("novelty term favours childless stepping stones over a crowded parent of equal score", () => {
    const probabilities = parentProbabilities(
      archive,
      "score_child_prop",
      OPTIONS,
    );
    expect(probabilities.get("c2") as number).toBeGreaterThan(
      probabilities.get("c1") as number,
    );
    expect(probabilities.get("c4") as number).toBeGreaterThan(0);
    const draws = selectParents(
      archive,
      4000,
      "score_child_prop",
      OPTIONS,
      seededRandom("x"),
    );
    expect(draws).toContain("c4");
  });

  test("selection is deterministic for a seed and excludes ineligible members", () => {
    const withBad = [...archive, member("c5", "c2", 1, { eligible: false })];
    const a = selectParents(
      withBad,
      50,
      "score_child_prop",
      OPTIONS,
      seededRandom("seed"),
    );
    const b = selectParents(
      withBad,
      50,
      "score_child_prop",
      OPTIONS,
      seededRandom("seed"),
    );
    expect(a).toEqual(b);
    for (const method of [
      "score_child_prop",
      "score_prop",
      "random",
      "best",
      "latest",
    ] as const)
      expect(
        selectParents(withBad, 30, method, OPTIONS, seededRandom(method)),
      ).not.toContain("c5");
    expect(
      selectParents(
        [member("c0", null, 1, { eligible: false })],
        3,
        "random",
        OPTIONS,
        Math.random,
      ),
    ).toEqual([]);
  });

  test("best picks the highest scores (upstream ascending-sort bug fixed) and latest is no_darwin", () => {
    const best = selectParents(archive, 2, "best", OPTIONS, seededRandom("b"));
    expect(best.every((id) => ["c1", "c2", "c3"].includes(id))).toBe(true);
    expect(best).not.toContain("c4");
    expect(
      selectParents(archive, 3, "latest", OPTIONS, seededRandom("l")),
    ).toEqual(["c4", "c4", "c4"]);
  });

  test("entry choice and keep_better archive update follow DGM", () => {
    expect(
      chooseEntry(member("c", null, 1, { unresolved: [] }), () => 0.9),
    ).toEqual({ kind: "explore" });
    expect(
      chooseEntry(member("c", null, 0, { unstable: ["t2"] }), () => 0.1),
    ).toEqual({ kind: "solve_stochasticity" });
    expect(chooseEntry(member("c", null, 0), () => 0.5)).toEqual({
      kind: "task",
      task_id: "t1",
    });
    expect(admitToArchive(0.35, 0.5, "keep_better", 0.1)).toBe(false);
    expect(admitToArchive(0.41, 0.5, "keep_better", 0.1)).toBe(true);
    expect(admitToArchive(0, 0.5, "keep_all", 0.1)).toBe(true);
  });
});

describe("statistics", () => {
  test("strict mean counts invalid and missing trials as zero", () => {
    expect(strictMean([1, null, 1], 4)).toBe(0.5);
  });
  test("paired bootstrap interval brackets the mean; single task is uninformative", () => {
    const interval = pairedInterval([0.5, 0.25, 0.75, 0.5], {
      confidence: 0.95,
      samples: 2000,
      seed: "s",
    });
    expect(interval.low).toBeLessThanOrEqual(interval.mean);
    expect(interval.high).toBeGreaterThanOrEqual(interval.mean);
    expect(interval.low).toBeGreaterThan(0);
    expect(interval.std_error).toBeGreaterThan(0);
    expect(
      pairedInterval([0.9], { confidence: 0.95, samples: 500, seed: "s" }),
    ).toMatchObject({ low: -1, high: 1 });
    expect(
      pairedInterval([0, 0, 0], { confidence: 0.95, samples: 500, seed: "s" }),
    ).toMatchObject({ low: 0, high: 0 });
  });
});

describe("run config", () => {
  test("final holdout may not overlap selection or regression tasks", () => {
    expect(RunConfigSchema.safeParse(runConfig()).success).toBe(true);
    // @mars/evaluation comparison manifests cap repeats at 32.
    const config = runConfig();
    expect(
      RunConfigSchema.safeParse({
        ...config,
        final_test: { ...config.final_test, repeats: 33 },
      }).success,
    ).toBe(false);
    const leak = runConfig({ final_test: { tasks: ["s1", "f2"], repeats: 2 } });
    expect(RunConfigSchema.safeParse(leak).success).toBe(false);
    const regressionLeak = runConfig({
      regression_families: [{ family: "x", tasks: ["f1"] }],
    });
    expect(RunConfigSchema.safeParse(regressionLeak).success).toBe(false);
    const overBudget = runConfig({
      evaluation_budget: {
        max_tokens: 10_000_000,
        max_usd: 1,
        max_duration_ms: 1,
        max_depth: 0,
        max_concurrency: 1,
      },
    });
    expect(RunConfigSchema.safeParse(overBudget).success).toBe(false);
  });
});

describe("patch policy", () => {
  const policy = {
    mutable_paths: ["harness/**"],
    protected_paths: ["evaluator/**", "build.sh"],
  };

  test("accepts a plain modification and an added file", () => {
    expect(parsePatch(policyPatch('{"default":1}'))).toEqual([
      { path: "harness/fixture-policy.json", kind: "modify", mode: null },
    ]);
    expect(parsePatch(addFile("harness/new.txt", "x"))[0]).toMatchObject({
      kind: "add",
      mode: "100644",
    });
  });

  test("refuses protected paths, paths outside the allowlist, traversal and .git", () => {
    expect(code(() => enforcePathPolicy(["evaluator/score.ts"], policy))).toBe(
      "protected_path",
    );
    expect(code(() => enforcePathPolicy(["build.sh"], policy))).toBe(
      "protected_path",
    );
    expect(
      code(() => enforcePathPolicy(["permissions/policy.json"], policy)),
    ).toBe("protected_path");
    expect(code(() => parsePatch(addFile("harness/../evaluator/x", "y")))).toBe(
      "unsafe_patch",
    );
    expect(
      code(() => parsePatch(addFile("harness/.git/hooks/post", "y"))),
    ).toBe("unsafe_patch");
    expect(code(() => parsePatch(addFile("/etc/passwd", "y")))).toBe(
      "unsafe_patch",
    );
  });

  test("refuses symlinks, gitlinks, renames, binary and non-git patches", () => {
    expect(
      code(() => parsePatch(addFile("harness/link", "../evaluator", "120000"))),
    ).toBe("unsafe_patch");
    expect(
      code(() => parsePatch(addFile("harness/sub", "deadbeef", "160000"))),
    ).toBe("unsafe_patch");
    expect(
      code(() =>
        parsePatch(
          "diff --git a/harness/a b/harness/a\nsimilarity index 100%\nrename from harness/a\nrename to evaluator/a\n",
        ),
      ),
    ).toBe("unsafe_patch");
    expect(
      code(() =>
        parsePatch(
          "diff --git a/harness/a b/harness/a\nBinary files a/harness/a and b/harness/a differ\n",
        ),
      ),
    ).toBe("unsafe_patch");
    expect(
      code(() =>
        parsePatch("--- a/harness/a\n+++ b/harness/a\n@@ -1 +1 @@\n-x\n+y\n"),
      ),
    ).toBe("unsafe_patch");
    expect(
      code(() => parsePatch('diff --git "a/harness/\\tx" "b/harness/\\tx"\n')),
    ).toBe("unsafe_patch");
  });

  test("a file header smuggled after an understated hunk is parsed as its own file and refused", () => {
    const smuggled = `${replaceLine("harness/a.txt", "x", "y")}diff --git a/evaluator/score.ts b/evaluator/score.ts\n--- a/evaluator/score.ts\n+++ b/evaluator/score.ts\n@@ -1 +1 @@\n-a\n+b\n`;
    const files = parsePatch(smuggled).map((file) => file.path);
    expect(files).toEqual(["harness/a.txt", "evaluator/score.ts"]);
    expect(code(() => enforcePathPolicy(files, policy))).toBe("protected_path");
    const hidden =
      "diff --git a/harness/a.txt b/harness/a.txt\n--- a/harness/a.txt\n+++ b/harness/a.txt\n@@ -1 +1,2 @@\n-x\n+y\n+diff --git a/evaluator/score.ts b/evaluator/score.ts\n";
    expect(parsePatch(hidden).map((file) => file.path)).toEqual([
      "harness/a.txt",
    ]);
    expect(
      code(() =>
        parsePatch(`${replaceLine("harness/a.txt", "x", "y")}garbage\n`),
      ),
    ).toBe("unsafe_patch");
    expect(
      code(() => parsePatch("diff --git a/harness/a.txt b/harness/b.txt\n")),
    ).toBe("unsafe_patch");
  });
});

describe("live acceptance evidence label", () => {
  test("labels the opt-in live test as model-driven proposer with Docker --network=none builds", () => {
    expect(LIVE_ACCEPTANCE_EVIDENCE.scope).toBe("model-proposer-docker-build");
    expect(LIVE_ACCEPTANCE_EVIDENCE.proposer).toBe("model-driven");
    expect(LIVE_ACCEPTANCE_EVIDENCE.build_isolation).toBe(
      "docker-network-none",
    );
    const gaps = LIVE_ACCEPTANCE_EVIDENCE.does_not_establish.join("\n");
    expect(gaps).toContain("Harbor applies only system_prompt");
    expect(gaps).toContain("matched-budget comparison");
    const source = readFileSync(
      join(import.meta.dir, "live.acceptance.test.ts"),
      "utf8",
    );
    expect(source).toContain("createModelProposer(");
    expect(source).toContain("createEvolutionDockerSandbox(");
    expect(source).toContain("LIVE_ACCEPTANCE_EVIDENCE");
    expect(source).toContain(
      "live (model-driven proposer, Docker --network=none builds, Harbor evaluation)",
    );
    expect(source).not.toContain("rollback survives reopen");
    expect(source.lastIndexOf("live-evidence.json")).toBeGreaterThan(
      source.indexOf("} finally {"),
    );
  });

  test("a failed live run's evidence says it failed and establishes nothing", () => {
    const evidence = liveEvidenceRecord({
      status: "failed",
      verdict: "accepted",
      rolled_back: true,
      verified_after_reopen: false,
      error:
        "harbor exited 1 with MARS_EVAL_API_KEY=sk-live-secret-value-123456",
    });
    expect(evidence.status).toBe("failed");
    expect(evidence.establishes).toEqual([]);
    expect(evidence.does_not_establish[0]).toContain("live run failed");
    expect(evidence.error).not.toContain("sk-live-secret-value-123456");
  });

  test("rollback is claimed only when the run actually rolled back", () => {
    const refused = liveEvidenceRecord({
      status: "passed",
      verdict: "no_improvement",
      rolled_back: false,
      verified_after_reopen: true,
    });
    expect(refused.establishes.join("\n")).not.toContain("rollback");
    expect(refused.does_not_establish.join("\n")).toContain("rollback");
    expect(refused.establishes).toContain(
      "final-holdout promotion verdict: no_improvement",
    );
    const accepted = liveEvidenceRecord({
      status: "passed",
      verdict: "accepted",
      rolled_back: true,
      verified_after_reopen: true,
    });
    expect(accepted.establishes).toContain("rollback to the previous champion");
    expect(accepted.does_not_establish.join("\n")).not.toContain("rollback (");
  });
});
