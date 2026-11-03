import { expect, test } from "bun:test";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimCredential } from "../agent/credential";
import {
  buildEvaluationReport,
  COMPARISON_MANIFEST_MEDIA_TYPE,
  canonicalJson,
  createEvaluationService,
  createFixtureScoringBackend,
  createHarborRunner,
  createHarborScoringBackend,
  exceptionKeepsRewardValid,
  PinMismatchError,
  packTrialDir,
  parseComparisonManifest,
  readHarborJob,
  renderTrialFeedback,
  requestSha256,
  sha256Hex,
  type TrialRecord,
  toTrialRecord,
} from "./index";
import {
  context,
  FAKE_HARBOR,
  FIXTURES,
  MemoryArtifacts,
  SAMPLE_IMAGE,
  sampleManifest,
} from "./test-support";

const HARBOR_FIXTURES = join(FIXTURES, "harbor");

async function fakeVenv(root: string, probe: Record<string, unknown>) {
  const python = join(root, "python");
  await writeFile(
    python,
    `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(probe)}'\n`,
  );
  await chmod(python, 0o755);
  return python;
}
const GOOD_PROBE = {
  python: [3, 12, 13],
  harbor: "0.25.0",
  mini_swe_agent: "2.4.6",
};

async function runnerFixture(
  probe: Record<string, unknown> = GOOD_PROBE,
  env: Record<string, string> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "mars-eval-"));
  const python = await fakeVenv(root, probe);
  const runner = createHarborRunner({
    pythonPath: python,
    harborPath: FAKE_HARBOR,
    agentPythonPath: join(FIXTURES, "..", "python"),
    jobsDir: join(root, "jobs"),
    dockerPath: null,
    env: { PATH: process.env.PATH, ...env },
  });
  return {
    root,
    runner,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------- manifest

test("manifest refuses unpinned docker images, budget inversions, holdout/task errors", async () => {
  const base = await sampleManifest();
  expect(base.schema).toBe("mars.evaluation-comparison/v1");
  expect(base.dataset.tasks_source.git_commit_id).toBe(
    "7e917f35c281188532772312d4ad91ca9274febc",
  );
  await expect(
    sampleManifest({
      environment: {
        type: "docker",
        images: [{ task_id: null, reference: "ghcr.io/x/y:2.0" }],
      },
    }),
  ).rejects.toThrow(/sha256 digest/);
  await expect(
    sampleManifest({
      environment: {
        type: "docker",
        images: [{ task_id: "regex-log", reference: SAMPLE_IMAGE }],
      },
    }),
  ).rejects.toThrow(/No digest-pinned image for task chess-best-move/);
  await expect(
    sampleManifest({ per_trial: { max_tokens: 1, max_usd: 50 } }),
  ).rejects.toThrow(/Per-trial USD/);
  await expect(
    sampleManifest({
      timeouts: { trial_timeout_ms: 7_200_000, timeout_multiplier: 1 },
    }),
  ).rejects.toThrow(/Trial timeout exceeds/);
  await expect(
    sampleManifest({ tasks: ["regex-log", "regex-log"] }),
  ).rejects.toThrow(/Duplicate task/);
  await expect(
    sampleManifest({
      arms: {
        baseline: { agent: "mini-swe-agent", version: "2.4.5" as "2.4.6" },
        candidate: base.arms.candidate,
      },
    }),
  ).rejects.toThrow();
  await expect(
    sampleManifest({
      model: { ...base.model, api_key_env: "sk-live-value-here" },
    }),
  ).rejects.toThrow();
  const roundTrip = parseComparisonManifest(JSON.parse(canonicalJson(base)));
  expect(roundTrip).toEqual(base);
});

// ----------------------------------------------------------------- parsing

test("parses real nop and oracle Harbor records without trusting exit codes", async () => {
  const nop = await readHarborJob(join(HARBOR_FIXTURES, "nop-regex-log"));
  expect(nop.job.n_total_trials).toBe(2);
  expect(nop.trials.map((trial) => trial.reward)).toEqual([0, 0]);
  expect(nop.trials.every((trial) => trial.reward_valid)).toBe(true);
  expect(nop.trials[0]?.task_source.git_commit_id).toBe(
    "7e917f35c281188532772312d4ad91ca9274febc",
  );
  expect(nop.trials[0]?.agent).toEqual({ name: "nop", version: "1.0.0" });
  expect(nop.trials[0]?.runtime_ms).toBeGreaterThanOrEqual(0);
  const oracle = await readHarborJob(join(HARBOR_FIXTURES, "oracle-regex-log"));
  expect(oracle.trials.map((trial) => trial.reward)).toEqual([1, 1]);
  expect(oracle.trials[0]?.dataset).toBe("terminal-bench-sample");
  expect(oracle.trials[0]?.total_ms).toBeGreaterThan(0);
});

test("exit-0-but-errored and null-reward trials are invalid; agent timeouts keep rewards valid", async () => {
  const candidate = await readHarborJob(
    join(HARBOR_FIXTURES, "synthetic-candidate"),
  );
  expect(candidate.job.stats.n_errored_trials).toBe(2);
  const byName = new Map(
    candidate.trials.map((trial) => [trial.trial_name, trial]),
  );
  const errored = byName.get("qemu-startup__c1");
  expect(errored?.reward).toBe(1);
  expect(errored?.reward_valid).toBe(false);
  expect(errored?.exception?.type).toBe("VerifierTimeoutError");
  const nullReward = byName.get("qemu-startup__c2");
  expect(nullReward?.reward).toBeNull();
  expect(nullReward?.reward_valid).toBe(false);
  expect(candidate.unreadable_trials).toEqual([
    { trial_dir: "qemu-startup__c3", error: "empty result.json" },
  ]);
  const timeout = await readHarborJob(
    join(HARBOR_FIXTURES, "synthetic-agent-timeout"),
  );
  expect(timeout.trials[0]?.reward_valid).toBe(true);
  expect(timeout.trials[0]?.reward).toBe(0);
  expect(exceptionKeepsRewardValid("AgentTimeoutError")).toBe(true);
  expect(exceptionKeepsRewardValid("VerifierTimeoutError")).toBe(false);
  expect(() => toTrialRecord({ task_name: "x" })).toThrow();
  const good = byName.get("regex-log__c1");
  expect(good).toMatchObject({
    reward: 1,
    reward_valid: true,
    n_input_tokens: 1200,
    n_output_tokens: 340,
    runtime_ms: 90_000,
  });
});

// ------------------------------------------------------------------ report

test("report computes per-arm aggregates, regressions, repeatability and holdout flags", async () => {
  const manifest = await sampleManifest();
  const baseline = await readHarborJob(
    join(HARBOR_FIXTURES, "synthetic-baseline"),
  );
  const candidate = await readHarborJob(
    join(HARBOR_FIXTURES, "synthetic-candidate"),
  );
  const report = buildEvaluationReport(
    manifest,
    {
      baseline: {
        agent: { name: "mini-swe-agent", version: "2.4.6" },
        trials: baseline.trials,
        harbor: baseline.job.stats,
      },
      candidate: {
        agent: { name: "mars-oh-my-pi", version: "0.1.0" },
        trials: candidate.trials,
        harbor: candidate.job.stats,
        unreadable_trials: candidate.unreadable_trials,
      },
    },
    () => Date.UTC(2026, 10, 2),
  );
  expect(report.schema).toBe("mars.evaluation-report/v1");
  expect(report.arms.baseline).toMatchObject({
    n_trials: 6,
    n_valid: 6,
    mean_reward_strict: 5 / 6,
  });
  expect(report.arms.candidate).toMatchObject({
    n_trials: 6,
    n_valid: 4,
    n_invalid: 2,
    mean_reward_strict: 4 / 6,
  });
  expect(report.arms.candidate.exceptions).toEqual({ VerifierTimeoutError: 1 });
  expect(report.regressions).toEqual(["qemu-startup"]);
  const fixGit = report.per_task.find(
    (entry) => entry.task_id === "chess-best-move",
  );
  expect(fixGit?.baseline).toMatchObject({
    rewards: [0, 1],
    mean_valid: 0.5,
    variance: 0.25,
    min: 0,
    max: 1,
    disagree: true,
  });
  expect(fixGit?.candidate).toMatchObject({
    rewards: [1, 1],
    variance: 0,
    disagree: false,
  });
  expect(fixGit?.delta_strict).toBe(0.5);
  expect(fixGit?.regression).toBe(false);
  const pathTracing = report.per_task.find(
    (entry) => entry.task_id === "qemu-startup",
  );
  expect(pathTracing?.final_holdout).toBe(true);
  expect(pathTracing?.candidate).toMatchObject({
    n_valid: 0,
    mean_strict: 0,
    disagree: false,
  });
  expect(report.unstable_tasks).toEqual(["chess-best-move"]);
  expect(report.repeatability).toHaveLength(6);
  expect(report.verdict).toMatchObject({
    complete: false,
    n_regressions: 1,
    n_unstable_tasks: 1,
  });
  expect(report.verdict.improvement_strict).toBeCloseTo(-1 / 6);
  expect(report.unreadable_trials).toEqual([
    {
      arm: "candidate",
      trial_dir: "qemu-startup__c3",
      error: "empty result.json",
    },
  ]);
  expect(report.harbor.candidate.n_errored_trials).toBe(2);
  // A trial from a different task commit is excluded, not silently mixed in.
  const first = baseline.trials[0] as TrialRecord;
  const foreign: TrialRecord = {
    ...first,
    trial_name: "foreign",
    task_source: { ...first.task_source, git_commit_id: "f".repeat(40) },
  };
  const mixed = buildEvaluationReport(manifest, {
    baseline: {
      agent: { name: "mini-swe-agent", version: "2.4.6" },
      trials: [...baseline.trials, foreign],
      harbor: baseline.job.stats,
    },
    candidate: {
      agent: { name: "mars-oh-my-pi", version: "0.1.0" },
      trials: candidate.trials,
      harbor: candidate.job.stats,
    },
  });
  expect(mixed.pin_mismatches).toEqual([
    {
      arm: "baseline",
      trial_name: "foreign",
      reason: expect.stringContaining("git_commit_id"),
    },
  ]);
  expect(mixed.arms.baseline.n_trials).toBe(6);
});

// -------------------------------------------------------------- trajectory

test("report completeness is judged per task, not by aggregate trial counts", async () => {
  const manifest = await sampleManifest();
  const baseline = await readHarborJob(
    join(HARBOR_FIXTURES, "synthetic-baseline"),
  );
  // Same number of valid trials (6), but qemu-startup has none and
  // chess-best-move has four: aggregate counts match, the comparison is not complete.
  const chess = baseline.trials.filter((t) => t.task_id === "chess-best-move");
  const skewed = [
    ...baseline.trials.filter((t) => t.task_id !== "qemu-startup"),
    ...chess.map((t) => ({ ...t, trial_name: `${t.trial_name}-dup` })),
  ];
  const arm = (trials: typeof skewed) => ({
    agent: { name: "mini-swe-agent", version: "2.4.6" },
    trials,
    harbor: baseline.job.stats,
  });
  const skewedReport = buildEvaluationReport(
    manifest,
    { baseline: arm(skewed), candidate: arm(skewed) },
    () => 0,
  );
  expect(skewedReport.arms.baseline.n_valid).toBe(6);
  expect(skewedReport.verdict.complete).toBe(false);
  const evenReport = buildEvaluationReport(
    manifest,
    { baseline: arm(baseline.trials), candidate: arm(baseline.trials) },
    () => 0,
  );
  expect(evenReport.verdict.complete).toBe(true);
});
test("trial bundles capture agent/verifier output but never verifier test sources", async () => {
  const candidate = await readHarborJob(
    join(HARBOR_FIXTURES, "synthetic-candidate"),
  );
  const record = candidate.trials.find(
    (trial) => trial.trial_name === "qemu-startup__c1",
  )!;
  const bundle = await packTrialDir(
    join(HARBOR_FIXTURES, "synthetic-candidate", record.trial_name),
    record,
  );
  const paths = bundle.files.map((file) => file.path);
  expect(paths).toContain("result.json");
  expect(paths).toContain("verifier/test-stdout.txt");
  expect(paths).toContain("agent/mars-usage.json");
  expect(paths).toContain("trial.log");
  expect(paths.some((path) => path.startsWith("tests/"))).toBe(false);
  expect(JSON.stringify(bundle)).not.toContain("hidden verifier test");
  const feedback = renderTrialFeedback(record, bundle);
  expect(feedback.startsWith("[untrusted evaluation evidence")).toBe(true);
  expect(feedback).toContain("Reward: 1 (invalid)");
  expect(feedback).toContain("VerifierTimeoutError");
  expect(feedback).toContain("Verifier output (tail):");
  expect(feedback.length).toBeLessThanOrEqual(6 * 1024);
});

// ------------------------------------------------------------------ runner

test("runner refuses mismatched python/harbor pins and registry drift", async () => {
  const manifest = await sampleManifest();
  for (const probe of [
    { ...GOOD_PROBE, harbor: "0.24.0" },
    { ...GOOD_PROBE, mini_swe_agent: null },
    { ...GOOD_PROBE, python: [3, 10, 12] },
  ]) {
    const f = await runnerFixture(probe);
    try {
      await expect(f.runner.verifyPins(manifest)).rejects.toBeInstanceOf(
        PinMismatchError,
      );
      await expect(
        f.runner.run({
          manifest,
          arm: "baseline",
          tasks: manifest.tasks,
          repeats: 1,
          jobName: "j",
          deadlineMs: Date.now() + 60_000,
          maxConcurrency: 1,
        }),
      ).rejects.toBeInstanceOf(PinMismatchError);
    } finally {
      await f.cleanup();
    }
  }
  const f = await runnerFixture();
  try {
    await f.runner.verifyPins(manifest);
    await f.runner.verifyRegistry(manifest);
    const drifted = await sampleManifest({
      dataset: {
        ...manifest.dataset,
        tasks_source: {
          ...manifest.dataset.tasks_source,
          git_commit_id: "0".repeat(40),
        },
      },
    });
    await expect(f.runner.verifyRegistry(drifted)).rejects.toThrow(
      /different repository\/commit/,
    );
    const wrongSha = await sampleManifest({
      dataset: {
        ...manifest.dataset,
        registry: { ...manifest.dataset.registry, sha256: "1".repeat(64) },
      },
    });
    await expect(f.runner.verifyRegistry(wrongSha)).rejects.toThrow(
      /Registry file sha256/,
    );
    await expect(
      f.runner.verifyRegistry(await sampleManifest({ tasks: ["not-a-task"] })),
    ).rejects.toThrow(/not in terminal-bench-sample/);
  } finally {
    await f.cleanup();
  }
});

test("runner argv matches conditions across arms and never carries key values", async () => {
  const manifest = await sampleManifest();
  const f = await runnerFixture();
  try {
    const baseline = f.runner.buildArgv({
      manifest,
      arm: "baseline",
      tasks: ["regex-log"],
      repeats: 2,
      jobName: "b",
      deadlineMs: 0,
      maxConcurrency: 8,
    });
    const candidate = f.runner.buildArgv({
      manifest,
      arm: "candidate",
      tasks: ["regex-log"],
      repeats: 2,
      jobName: "c",
      deadlineMs: 0,
      maxConcurrency: 8,
      candidatePath: "/tmp/cand.json",
    });
    for (const argv of [baseline, candidate]) {
      expect(argv).toContain("--env");
      expect(argv[argv.indexOf("-d") + 1]).toBe("terminal-bench-sample@2.0");
      expect(argv[argv.indexOf("-n") + 1]).toBe("2"); // clamped to manifest budget
      expect(argv[argv.indexOf("-m") + 1]).toBe("qwen3-coder:30b");
      expect(argv[argv.indexOf("--api-key-name") + 1]).toBe(
        "MARS_EVAL_API_KEY",
      );
      expect(argv.join(" ")).not.toMatch(/sk-|api[_-]?key=/i);
    }
    expect(baseline).toContain("mini-swe-agent");
    expect(baseline).toContain("version=2.4.6");
    expect(candidate).toContain("mars_harbor_agent.agent:MarsAgent");
    expect(candidate).toContain("candidate_path=/tmp/cand.json");
    expect(() =>
      f.runner.buildArgv({
        manifest,
        arm: "candidate",
        tasks: ["regex-log"],
        repeats: 1,
        jobName: "c",
        deadlineMs: 0,
        maxConcurrency: 1,
      }),
    ).toThrow(/candidatePath/);
    expect(() =>
      f.runner.buildArgv({
        manifest,
        arm: "baseline",
        tasks: ["unknown"],
        repeats: 1,
        jobName: "c",
        deadlineMs: 0,
        maxConcurrency: 1,
      }),
    ).toThrow(/not in the manifest/);
    const unpinned = {
      ...manifest,
      environment: {
        type: "docker" as const,
        images: [{ task_id: null, reference: "ghcr.io/x/y:2.0" }],
      },
    };
    expect(() =>
      f.runner.buildArgv({
        manifest: unpinned,
        arm: "baseline",
        tasks: ["regex-log"],
        repeats: 1,
        jobName: "c",
        deadlineMs: 0,
        maxConcurrency: 1,
      }),
    ).toThrow(/sha256 digest/);
  } finally {
    await f.cleanup();
  }
});

test("runner kills the whole Harbor process group on deadline", async () => {
  const manifest = await sampleManifest();
  const f = await runnerFixture(GOOD_PROBE, {
    FAKE_HARBOR_MODE: "hang",
    FAKE_HARBOR_PIDFILE: "",
  });
  const pidfile = join(f.root, "pids");
  const runner = createHarborRunner({
    pythonPath: await fakeVenv(f.root, GOOD_PROBE),
    harborPath: FAKE_HARBOR,
    agentPythonPath: join(FIXTURES, "..", "python"),
    jobsDir: join(f.root, "jobs"),
    dockerPath: null,
    env: {
      PATH: process.env.PATH,
      FAKE_HARBOR_MODE: "hang",
      FAKE_HARBOR_PIDFILE: pidfile,
    },
  });
  try {
    const started = Date.now();
    const outcome = await runner.run({
      manifest,
      arm: "baseline",
      tasks: ["regex-log"],
      repeats: 1,
      jobName: "hang",
      deadlineMs: started + 1500,
      maxConcurrency: 1,
    });
    expect(outcome.killed).toBe("deadline");
    expect(outcome.exit_code).toBeNull();
    expect(Date.now() - started).toBeLessThan(15_000);
    const [parent, child] = (await readFile(pidfile, "utf8"))
      .trim()
      .split(" ")
      .map(Number);
    await Bun.sleep(200);
    for (const pid of [parent, child]) {
      let alive = true;
      try {
        process.kill(pid!, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);
    }
  } finally {
    await f.cleanup();
  }
}, 20_000);

test("runner honours cancellation via AbortSignal", async () => {
  const manifest = await sampleManifest();
  const f = await runnerFixture(GOOD_PROBE, { FAKE_HARBOR_MODE: "hang" });
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const outcome = await f.runner.run({
      manifest,
      arm: "baseline",
      tasks: ["regex-log"],
      repeats: 1,
      jobName: "cancel",
      deadlineMs: Date.now() + 60_000,
      maxConcurrency: 1,
      signal: controller.signal,
    });
    expect(outcome.killed).toBe("cancelled");
  } finally {
    await f.cleanup();
  }
}, 20_000);

// ----------------------------------------------------------------- service

test("evaluation service runs both arms, stores report + trajectories durably and parses real-shaped results", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-eval-service-"));
  const bundleDir = join(root, "bundle");
  await mkdir(bundleDir);
  await writeFile(join(bundleDir, "mars-agent"), "#!/bin/sh\nexit 0\n");
  const bundleSha = sha256Hex(
    new Uint8Array(await readFile(join(bundleDir, "mars-agent"))),
  );
  const manifest = await sampleManifest(
    {},
    { path: bundleDir, sha256: bundleSha },
  );
  const python = await fakeVenv(root, GOOD_PROBE);
  const marker = join(root, "argv.log");
  // The fake harbor copies a different fixture per arm, selected by MARS_EVALUATION_ARM.
  const dispatcher = join(root, "harbor-dispatch.sh");
  await writeFile(
    dispatcher,
    `#!/bin/sh\nif [ "$MARS_EVALUATION_ARM" = "baseline" ]; then export FAKE_HARBOR_FIXTURE='${join(HARBOR_FIXTURES, "synthetic-baseline")}'; else export FAKE_HARBOR_FIXTURE='${join(HARBOR_FIXTURES, "synthetic-candidate")}'; fi\nexec python3 '${FAKE_HARBOR}' "$@"\n`,
  );
  await chmod(dispatcher, 0o755);
  const runner = createHarborRunner({
    pythonPath: python,
    harborPath: dispatcher,
    agentPythonPath: join(FIXTURES, "..", "python"),
    jobsDir: join(root, "jobs"),
    dockerPath: null,
    env: { PATH: process.env.PATH, FAKE_HARBOR_MARKER: marker },
  });
  const artifacts = new MemoryArtifacts();
  const service = createEvaluationService({
    stateDir: join(root, "state"),
    runner,
    artifacts,
  });
  try {
    const manifestRef = await artifacts.put(
      context,
      new TextEncoder().encode(canonicalJson(manifest)),
      COMPARISON_MANIFEST_MEDIA_TYPE,
    );
    await expect(
      service.submitComparison(context, manifestRef, {
        ...manifest.budget,
        max_usd: 1,
      }),
    ).rejects.toThrow(/exceeds the submitted budget/);
    const job = await service.submitComparison(
      context,
      manifestRef,
      manifest.budget,
    );
    expect((await service.inspect(context, job.job_id)).status).toMatch(
      /pending|running/,
    );
    await service.settled(job.job_id);
    const result = await service.inspect(context, job.job_id);
    expect(result.status).toBe("completed");
    expect(result.artifacts.length).toBe(1 + 12);
    const reportRef = result.artifacts[0]!;
    const report = JSON.parse(
      new TextDecoder().decode(await artifacts.get(context, reportRef)),
    );
    expect(report.schema).toBe("mars.evaluation-report/v1");
    expect(report.regressions).toEqual(["qemu-startup"]);
    expect(report.arms.candidate.n_invalid).toBe(2);
    const trajectory = JSON.parse(
      new TextDecoder().decode(
        await artifacts.get(context, result.artifacts[1]!),
      ),
    );
    expect(trajectory.schema).toBe("mars.harbor-trial-bundle/v1");
    const argvLog = await readFile(marker, "utf8");
    expect(argvLog.split("\n").filter(Boolean)).toHaveLength(2);
    expect(argvLog).toContain("mini-swe-agent");
    expect(argvLog).toContain("mars_harbor_agent.agent:MarsAgent");
    expect(argvLog).not.toContain("qemu-startup__");
    // durable: a fresh service instance over the same state dir sees the finished job
    const reopened = createEvaluationService({
      stateDir: join(root, "state"),
      runner,
      artifacts,
    });
    expect((await reopened.inspect(context, job.job_id)).status).toBe(
      "completed",
    );
    await expect(
      reopened.inspect(
        { ...context, scope: { owner_id: "other", project_id: "x" } },
        job.job_id,
      ),
    ).rejects.toThrow(/Unknown evaluation job/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("evaluation service cancel kills a running Harbor job and records cancelled", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-eval-cancel-"));
  const bundleDir = join(root, "bundle");
  await mkdir(bundleDir);
  await writeFile(join(bundleDir, "mars-agent"), "#!/bin/sh\nexit 0\n");
  const manifest = await sampleManifest(
    {},
    {
      path: bundleDir,
      sha256: sha256Hex(
        new Uint8Array(await readFile(join(bundleDir, "mars-agent"))),
      ),
    },
  );
  const runner = createHarborRunner({
    pythonPath: await fakeVenv(root, GOOD_PROBE),
    harborPath: FAKE_HARBOR,
    agentPythonPath: join(FIXTURES, "..", "python"),
    jobsDir: join(root, "jobs"),
    dockerPath: null,
    env: { PATH: process.env.PATH, FAKE_HARBOR_MODE: "hang" },
  });
  const artifacts = new MemoryArtifacts();
  const service = createEvaluationService({
    stateDir: join(root, "state"),
    runner,
    artifacts,
  });
  try {
    const ref = await artifacts.put(
      context,
      new TextEncoder().encode(canonicalJson(manifest)),
      COMPARISON_MANIFEST_MEDIA_TYPE,
    );
    const job = await service.submitComparison(context, ref, manifest.budget);
    await Bun.sleep(500);
    await service.cancel(context, job.job_id);
    await service.settled(job.job_id);
    expect((await service.inspect(context, job.job_id)).status).toBe(
      "cancelled",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);

// ----------------------------------------------------------------- scoring

test("harbor scoring backend scores the MARS arm only and refuses holdout instances", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-eval-score-"));
  const bundleDir = join(root, "bundle");
  await mkdir(bundleDir);
  await writeFile(join(bundleDir, "mars-agent"), "#!/bin/sh\nexit 0\n");
  const manifest = await sampleManifest(
    {},
    {
      path: bundleDir,
      sha256: sha256Hex(
        new Uint8Array(await readFile(join(bundleDir, "mars-agent"))),
      ),
    },
  );
  const marker = join(root, "argv.log");
  const runner = createHarborRunner({
    pythonPath: await fakeVenv(root, GOOD_PROBE),
    harborPath: FAKE_HARBOR,
    agentPythonPath: join(FIXTURES, "..", "python"),
    jobsDir: join(root, "jobs"),
    dockerPath: null,
    env: {
      PATH: process.env.PATH,
      FAKE_HARBOR_FIXTURE: join(HARBOR_FIXTURES, "synthetic-candidate"),
      FAKE_HARBOR_MARKER: marker,
    },
  });
  const artifacts = new MemoryArtifacts();
  expect(() =>
    createHarborScoringBackend({
      manifest,
      runner,
      artifacts,
      candidateDir: join(root, "cands"),
      splits: { train: ["regex-log"], validation: ["qemu-startup"] },
    }),
  ).toThrow(/final holdout/);
  const backend = createHarborScoringBackend({
    manifest,
    runner,
    artifacts,
    candidateDir: join(root, "cands"),
    splits: { train: ["regex-log"], validation: ["chess-best-move"] },
  });
  const request = {
    candidate: manifest.arms.candidate.candidate,
    split: "train" as const,
    instance_ids: ["regex-log"],
    repeats: 2,
    budget: manifest.budget,
  };
  try {
    await expect(
      backend.score(context, { ...request, instance_ids: ["qemu-startup"] }),
    ).rejects.toThrow(/final holdout/);
    await expect(
      backend.score(context, { ...request, instance_ids: ["chess-best-move"] }),
    ).rejects.toThrow(/not in the train split/);
    await expect(
      backend.score(context, request, { signal: AbortSignal.abort() }),
    ).rejects.toThrow();
    const result = await backend.score(context, request);
    expect(result.simulated).toBe(false);
    expect(result.request_sha256).toBe(requestSha256(request));
    expect(result.scores).toHaveLength(1);
    expect(result.scores[0]).toMatchObject({
      instance_id: "regex-log",
      score: 1,
      reward_valid: true,
      runtime_ms: 180_000,
      error: null,
    });
    expect(result.scores[0]?.trajectory?.media_type).toBe(
      "application/vnd.mars.harbor-trial+json",
    );
    // Identical requests keep the same request hash but get a fresh Harbor
    // job directory, so repeated scoring never collides.
    const again = await backend.score(context, request);
    expect(again.request_sha256).toBe(result.request_sha256);
    expect(again.scores[0]?.score).toBe(1);
    // A trial from another agent never contributes to the candidate score:
    // a perfect foreign reward is dropped, which leaves one of the two
    // expected repeats missing (strict score 0.5, reward not valid).
    const foreign = join(root, "foreign-fixture");
    await cp(join(HARBOR_FIXTURES, "synthetic-candidate"), foreign, {
      recursive: true,
    });
    const foreignTrial = join(foreign, "regex-log__c2", "result.json");
    const record = JSON.parse(await readFile(foreignTrial, "utf8"));
    record.agent_info.name = "nop";
    record.verifier_result.rewards = { reward: 1 };
    await writeFile(foreignTrial, JSON.stringify(record));
    const foreignRunner = createHarborRunner({
      pythonPath: await fakeVenv(root, GOOD_PROBE),
      harborPath: FAKE_HARBOR,
      agentPythonPath: join(FIXTURES, "..", "python"),
      jobsDir: join(root, "jobs-foreign"),
      dockerPath: null,
      env: {
        PATH: process.env.PATH,
        FAKE_HARBOR_FIXTURE: foreign,
        FAKE_HARBOR_MARKER: marker,
      },
    });
    const filtered = await createHarborScoringBackend({
      manifest,
      runner: foreignRunner,
      artifacts,
      candidateDir: join(root, "cands"),
      splits: { train: ["regex-log"], validation: ["chess-best-move"] },
    }).score(context, request);
    expect(filtered.scores[0]).toMatchObject({
      score: 0.5,
      reward_valid: false,
    });
    expect(filtered.scores[0]?.feedback).not.toContain("regex-log__c2");
    expect(result.scores[0]?.feedback).toContain(
      "[untrusted evaluation evidence",
    );
    expect(result.mean_score).toBe(1);
    const argv = await readFile(marker, "utf8");
    expect(argv).toContain("mars_harbor_agent.agent:MarsAgent");
    expect(argv).not.toContain("mini-swe-agent");
    expect(argv).not.toContain("qemu-startup");
    expect(argv).toContain("-i regex-log");
    const candidateFile = JSON.parse(
      await readFile(
        join(root, "cands", `${result.request_sha256}.json`),
        "utf8",
      ),
    );
    expect(candidateFile.components.system_prompt).toContain("candidate 1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("fixture scoring backend is deterministic, simulated and respects holdout", async () => {
  const manifest = await sampleManifest();
  const backend = createFixtureScoringBackend(
    {
      "regex-log": { reward: 1, runtime_ms: 10 },
      "chess-best-move": { reward: null, error: "verifier crashed" },
    },
    { holdout: ["qemu-startup"] },
  );
  const request = {
    candidate: manifest.arms.candidate.candidate,
    split: "validation" as const,
    instance_ids: ["regex-log", "chess-best-move"],
    repeats: 1,
    budget: manifest.budget,
  };
  const first = await backend.score(context, request);
  const second = await backend.score(context, request);
  expect(first).toEqual(second);
  expect(first.simulated).toBe(true);
  expect(first.mean_score).toBe(0.5);
  expect(first.scores[1]).toMatchObject({
    score: 0,
    reward_valid: false,
    error: "verifier crashed",
  });
  expect(first.scores[0]?.feedback).toContain("[simulated fixture evidence");
  await expect(
    backend.score(context, { ...request, instance_ids: ["qemu-startup"] }),
  ).rejects.toThrow(/final holdout/);
});

test("control agents and dry runs drop model flags and never masquerade as an arm", async () => {
  const manifest = await sampleManifest();
  const f = await runnerFixture();
  try {
    const argv = f.runner.buildArgv({
      manifest,
      arm: "baseline",
      tasks: ["regex-log"],
      repeats: 2,
      jobName: "ctl",
      deadlineMs: 0,
      maxConcurrency: 1,
      controlAgent: "oracle",
      dryRun: true,
    });
    expect(argv).toContain("--dry-run");
    expect(argv[argv.indexOf("-a") + 1]).toBe("oracle");
    for (const flag of [
      "-m",
      "--base-url",
      "--api-key-name",
      "--api-format",
      "--ak",
    ])
      expect(argv).not.toContain(flag);
    const outcome = await f.runner.run({
      manifest,
      arm: "baseline",
      tasks: ["regex-log"],
      repeats: 1,
      jobName: "ctl-dry",
      deadlineMs: Date.now() + 30_000,
      maxConcurrency: 1,
      controlAgent: "nop",
      dryRun: true,
    });
    expect(outcome.exit_code).toBe(0);
    expect(outcome.argv).toContain("--dry-run");
  } finally {
    await f.cleanup();
  }
});

test("harbor scoring backend forwards the abort signal to the Harbor runner", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-eval-signal-"));
  const bundleDir = join(root, "bundle");
  await mkdir(bundleDir);
  await writeFile(join(bundleDir, "mars-agent"), "#!/bin/sh\nexit 0\n");
  const manifest = await sampleManifest(
    {},
    {
      path: bundleDir,
      sha256: sha256Hex(
        new Uint8Array(await readFile(join(bundleDir, "mars-agent"))),
      ),
    },
  );
  const runner = createHarborRunner({
    pythonPath: await fakeVenv(root, GOOD_PROBE),
    harborPath: FAKE_HARBOR,
    agentPythonPath: join(FIXTURES, "..", "python"),
    jobsDir: join(root, "jobs"),
    dockerPath: null,
    env: {
      PATH: process.env.PATH,
      FAKE_HARBOR_FIXTURE: join(HARBOR_FIXTURES, "synthetic-candidate"),
    },
  });
  let seen: AbortSignal | undefined;
  const spy: typeof runner = {
    ...runner,
    run: (request) => {
      seen = request.signal;
      return runner.run(request);
    },
  };
  const backend = createHarborScoringBackend({
    manifest,
    runner: spy,
    artifacts: new MemoryArtifacts(),
    candidateDir: join(root, "cands"),
    splits: { train: ["regex-log"], validation: ["chess-best-move"] },
  });
  const controller = new AbortController();
  try {
    await backend.score(
      context,
      {
        candidate: manifest.arms.candidate.candidate,
        split: "train",
        instance_ids: ["regex-log"],
        repeats: 1,
        budget: manifest.budget,
      },
      { signal: controller.signal },
    );
    expect(seen).toBe(controller.signal);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the agent bundle removes the model credential from its own environment", () => {
  const env: Record<string, string | undefined> = {
    HARBOR_KEY: "secret-value",
    PATH: "/usr/bin",
  };
  expect(claimCredential(env, "HARBOR_KEY")).toBe("secret-value");
  expect("HARBOR_KEY" in env).toBe(false);
  expect(env.PATH).toBe("/usr/bin");
  expect(claimCredential(env, "HARBOR_KEY")).toBeUndefined();
});
