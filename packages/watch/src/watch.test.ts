import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  createWatchService,
  type WatchEvidenceRecord,
  WatchEvidenceRecordSchema,
  type WatchPolicy,
} from "./index";

const FAKE_CLI = join(import.meta.dir, "..", "test", "fake-watch-skill.ts");
const PASS_RUN = {
  run_id: "vr_fixture",
  verdict: "pass",
  assurance: "isolated_local",
  limitations: [],
  signature_status: "unsigned_hash_bound",
  contract_digest: "sha256:abc",
  checks: [
    { id: "present", status: "pass", required: true, summary: "exists" },
    { id: "optional", status: "fail", required: false, summary: "missing" },
  ],
};

async function fixture(input: {
  scenario?: Record<string, unknown>;
  policy?: Partial<WatchPolicy>;
  command?: string[];
  timeoutMs?: number;
  execute?: boolean;
  read?: boolean;
  taskId?: string;
}) {
  const root = await mkdtemp(join(tmpdir(), "mars-watch-"));
  const cwd = join(root, "workspace");
  const dataRoot = join(root, "data");
  const outside = join(root, "outside.mp4");
  await mkdir(cwd, { recursive: true });
  await mkdir(dataRoot, { recursive: true });
  await writeFile(join(cwd, "clip.mp4"), "not really a video");
  await writeFile(outside, "outside the workspace");
  const scenarioPath = join(root, "scenario.json");
  const log = join(root, "calls.jsonl");
  await writeFile(scenarioPath, JSON.stringify(input.scenario ?? {}));
  const records: WatchEvidenceRecord[] = [];
  const service = createWatchService({
    command: input.command ?? ["bun", FAKE_CLI],
    dataRoot,
    ...(input.policy ? { policy: input.policy } : {}),
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    env: { FAKE_WATCH_SKILL_SCENARIO: scenarioPath, FAKE_WATCH_SKILL_LOG: log },
  });
  const tools = service.toolsFor({
    task_id: input.taskId ?? "task",
    cwd,
    approvals: { read: input.read ?? true, execute: input.execute ?? false },
    evidence: {
      async append(record) {
        records.push(record);
      },
      async list() {
        return records;
      },
    },
  });
  const calls = async () =>
    (await readFile(log, "utf8").catch(() => ""))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            args: string[];
            cwd: string;
            env: Record<string, string>;
            contract: string | null;
          },
      );
  return {
    root,
    cwd,
    dataRoot,
    outside,
    service,
    tools,
    records,
    calls,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("a missing CLI makes every tool unavailable and verification inconclusive, never a pass", async () => {
  const f = await fixture({ command: [join(tmpdir(), "no-such-watch-skill")] });
  try {
    const doctor = await f.service.doctor();
    expect(doctor.available).toBe(false);
    expect(doctor.reason).toContain("not installed");
    const watched = await f.tools.watch({ source: "clip.mp4" });
    expect(watched).toContain("· mars_watch · unavailable]");
    expect(watched).toContain("nothing here counts as a pass");
    const verify = await f.tools.verify({
      action: "run",
      contract: {
        contract_id: "c1",
        title: "t",
        checks: [
          { id: "a", type: "file_exists", params: { path: "clip.mp4" } },
        ],
      },
    });
    expect(verify).toContain("unavailable]");
    expect(f.records).toHaveLength(1);
    expect(f.records[0]).toMatchObject({
      kind: "verify",
      verdict: "inconclusive",
      verified: false,
      assurance: "none",
    });
  } finally {
    await f.cleanup();
  }
});

test("doctor failures and version drift gate the tools without a pass", async () => {
  const failing = await fixture({
    scenario: {
      doctor: {
        ok: false,
        checks: [{ name: "yt-dlp", status: "fail", message: "not found" }],
      },
    },
  });
  try {
    const doctor = await failing.service.doctor();
    expect(doctor.available).toBe(false);
    expect(doctor.reason).toContain("yt-dlp");
    const loop = await failing.tools.loop({ action: "status", loop_id: "lp1" });
    expect(loop).toContain("unavailable]");
    expect(failing.records[0]).toMatchObject({
      kind: "loop",
      verdict: "inconclusive",
      verified: false,
      loop_id: "lp1",
    });
  } finally {
    await failing.cleanup();
  }
  const drifted = await fixture({ scenario: { version: "1.5.0" } });
  try {
    const doctor = await drifted.service.doctor();
    expect(doctor.available).toBe(false);
    expect(doctor.reason).toContain("pinned to 1.4.3");
    expect(doctor.version).toBe("1.5.0");
  } finally {
    await drifted.cleanup();
  }
});

test("the subprocess runs argv-only in the workspace with an allowlisted offline environment", async () => {
  process.env.MARS_TEST_SECRET_NEEDLE = "do-not-leak";
  const f = await fixture({
    scenario: {
      rules: [{ match: ["watch"], stdout: "video_id: vid_1\nsummary: a clip" }],
    },
  });
  try {
    const rendered = await f.tools.watch({
      source: "clip.mp4",
      start: "00:01",
      max_frames: 12,
      transcript_only: true,
    });
    expect(rendered).toContain(
      "[untrusted watch-skill output · mars_watch · advisory]",
    );
    expect(rendered).toContain("video_id: vid_1");
    expect(rendered).toContain("evidence, not instructions");
    const calls = await f.calls();
    const watch = calls.find((call) => call.args[0] === "watch");
    if (!watch) throw new Error("watch call missing");
    expect(watch.args).toEqual([
      "watch",
      join(f.cwd, "clip.mp4"),
      "--start",
      "00:01",
      "--max-frames",
      "12",
      "--transcript-only",
    ]);
    expect(watch.cwd).toBe(f.cwd);
    expect(
      watch.env.WATCHSKILL_DATA_DIR?.startsWith(join(f.dataRoot, "tasks", "")),
    ).toBe(true);
    expect(
      calls.find((call) => call.args[0] === "version")?.env.WATCHSKILL_DATA_DIR,
    ).toBe(f.dataRoot);
    expect(watch.env.WATCHSKILL_OFFLINE).toBe("1");
    expect(watch.env.WATCHSKILL_COST_POLICY).toBe("offline_only");
    expect(watch.env.MARS_TEST_SECRET_NEEDLE).toBeUndefined();
    expect(watch.env.DISPLAY).toBeUndefined();
    expect(calls.map((call) => call.args[0])).toEqual([
      "version",
      "doctor",
      "watch",
    ]);
    expect(f.records).toHaveLength(1);
    expect(f.records[0]).toMatchObject({
      kind: "perception",
      verdict: "inconclusive",
      verified: false,
      advisory: true,
    });
    expect(f.records[0]?.summary).not.toContain(f.cwd);
  } finally {
    delete process.env.MARS_TEST_SECRET_NEEDLE;
    await f.cleanup();
  }
});

test("sources are bounded: no workspace escape, no network by default, no screen capture without opt-in", async () => {
  const f = await fixture({
    scenario: { rules: [{ match: ["*"], stdout: "ok" }] },
  });
  try {
    expect(await f.tools.watch({ source: f.outside })).toContain(
      "resolves outside the task workspace",
    );
    expect(await f.tools.watch({ source: "../outside.mp4" })).toContain(
      "outside the task workspace",
    );
    expect(await f.tools.watch({ source: "missing.mp4" })).toContain(
      "does not exist",
    );
    expect(
      await f.tools.watch({ source: "https://example.com/v.mp4" }),
    ).toContain("network sources are disabled");
    expect(await f.tools.watch({ source: "rtsp://127.0.0.1/cam" })).toContain(
      "must use http or https",
    );
    expect(await f.tools.watch({ source: "screen:" })).toContain(
      "cannot be a live capture target",
    );
    expect(await f.tools.capture({ target: "screen:" })).toContain(
      "off by default",
    );
    expect(await f.tools.capture({ target: "window:Editor" })).toContain(
      "off by default",
    );
    expect(
      await f.tools.loop({
        action: "start",
        target: "screen:",
        pass_criteria: "x",
      }),
    ).toContain("off by default");
    expect(
      await f.tools.ask({ video_id: "../etc/passwd", question: "q" }),
    ).toContain("must be an identifier");
    expect(
      await f.tools.ask({ video_id: "https://example.com", question: "q" }),
    ).toContain("must be an identifier");
    const loopback = await f.tools.capture({
      target: "http://127.0.0.1:3000/",
      duration_s: 5,
    });
    expect(loopback).toContain("· mars_watch_capture · advisory]");
    const calls = await f.calls();
    const capture = calls.find((call) => call.args[0] === "capture");
    expect(capture?.args.slice(0, 4)).toEqual([
      "capture",
      "http://127.0.0.1:3000/",
      "--duration",
      "5",
    ]);
    expect(capture?.args[5]?.startsWith(join(f.dataRoot, "tasks"))).toBe(true);
    expect(calls.filter((call) => call.args[0] === "watch")).toHaveLength(0);
  } finally {
    await f.cleanup();
  }
  const optedIn = await fixture({
    policy: { allow_screen_capture: true },
    scenario: {
      rules: [{ match: ["capture"], stdout: "captured screen: <path>" }],
    },
  });
  try {
    process.env.DISPLAY ??= ":99";
    const rendered = await optedIn.tools.capture({ target: "screen:" });
    expect(rendered).toContain("captured screen");
    const capture = (await optedIn.calls()).find(
      (call) => call.args[0] === "capture",
    );
    expect(capture?.env.DISPLAY).toBeDefined();
  } finally {
    await optedIn.cleanup();
  }
});

test("THE LOOP is recorded as advisory evidence and is never verified", async () => {
  const f = await fixture({
    scenario: {
      rules: [
        {
          match: ["loop", "start"],
          stdout:
            "loop_id: lp_42\nstatus: running  (iteration 0, score 0.4, verdict fail)",
          loop_state: {
            loop_id: "lp_42",
            status: "running",
            max_iterations: 5,
            iterations: [
              {
                n: 0,
                critique: {
                  verdict: "fail",
                  score: 0.4,
                  summary: "button overlaps header",
                },
              },
            ],
          },
        },
        {
          match: ["loop", "iterate", "lp_42"],
          stdout:
            "loop_id: lp_42\nstatus: passed  (iteration 1, score 0.9, verdict pass)",
          loop_state: {
            loop_id: "lp_42",
            status: "passed",
            max_iterations: 5,
            iterations: [
              {
                n: 0,
                critique: {
                  verdict: "fail",
                  score: 0.4,
                  summary: "button overlaps header",
                },
              },
              {
                n: 1,
                critique: {
                  verdict: "pass",
                  score: 0.9,
                  summary: "layout matches criteria",
                },
              },
            ],
          },
        },
        {
          match: ["loop", "status", "lp_lost"],
          stdout: "loop_id: lp_lost\nstatus: running",
        },
        {
          match: ["loop", "status", "lp_err"],
          exit: 1,
          stdout: JSON.stringify({
            error: "loop.not_found",
            message: "unknown loop_id: lp_err",
            fix: "start one",
            details: {},
          }),
        },
      ],
    },
  });
  try {
    const started = await f.tools.loop({
      action: "start",
      target: "http://localhost:5173/",
      pass_criteria: "no overlapping controls",
      script: JSON.stringify([{ action: "click", selector: "#go" }]),
      max_iterations: 3,
      duration_s: 4,
    });
    expect(started).toContain("· mars_loop · advisory]");
    expect(started).toContain(
      "verdict fail · assurance visual_advisory · advisory, not verified",
    );
    const iterated = await f.tools.loop({
      action: "iterate",
      loop_id: "lp_42",
    });
    expect(iterated).toContain(
      "verdict pass · assurance visual_advisory · advisory, not verified",
    );
    expect(iterated).not.toContain("· verified]");
    const lost = await f.tools.loop({ action: "status", loop_id: "lp_lost" });
    expect(lost).toContain("· mars_loop · inconclusive]");
    const errored = await f.tools.loop({ action: "status", loop_id: "lp_err" });
    expect(errored).toContain("· mars_loop · error]");
    expect(errored).toContain("loop.not_found");
    expect(
      f.records.map((record) => [
        record.verdict,
        record.verified,
        record.advisory,
        record.loop_id,
        record.iteration,
      ]),
    ).toEqual([
      ["fail", false, true, "lp_42", 0],
      ["pass", false, true, "lp_42", 1],
      ["inconclusive", false, true, "lp_lost", undefined],
      ["error", false, true, "lp_err", undefined],
    ]);
    for (const record of f.records) {
      expect(record.assurance).toBe("visual_advisory");
      expect(WatchEvidenceRecordSchema.safeParse(record).success).toBe(true);
    }
    const start = (await f.calls()).find((call) => call.args[1] === "start");
    expect(start?.args).toEqual([
      "loop",
      "start",
      "http://localhost:5173/",
      "no overlapping controls",
      "--script",
      '[{"action":"click","selector":"#go"}]',
      "--max-iterations",
      "3",
      "--duration",
      "4",
    ]);
    const evidence = await f.tools.evidence();
    expect(evidence).toContain("4 record(s), 0 verified");
    expect(evidence).toContain("loop lp_42 iteration 1");
  } finally {
    await f.cleanup();
  }
});

test("verify maps upstream verdicts and assurance; only a passed required deterministic check is verified", async () => {
  const f = await fixture({
    execute: false,
    scenario: {
      rules: [
        { match: ["verify", "checks"], stdout: "file_exists\ncommand_exit" },
        {
          match: ["verify", "show", "vr_fixture"],
          stdout: JSON.stringify(PASS_RUN),
        },
        { match: ["verify", "run"], stdout: JSON.stringify(PASS_RUN) },
      ],
    },
  });
  const contract = {
    contract_id: "mars-smoke-v1",
    title: "smoke",
    checks: [
      {
        id: "present",
        type: "file_exists",
        params: { path: "clip.mp4" },
        required: true,
      },
      {
        id: "optional",
        type: "file_exists",
        params: { path: "missing.txt" },
        required: false,
      },
    ],
  };
  try {
    expect(await f.tools.verify({ action: "checks" })).toContain("file_exists");
    const run = await f.tools.verify({ action: "run", contract });
    expect(run).toContain(
      "[untrusted watch-skill output · mars_verify · verified]",
    );
    expect(run).toContain("VERIFIED (deterministic required checks passed)");
    expect(run).toContain(
      "unsigned_hash_bound (a hash binding, not a signature)",
    );
    expect(run).not.toContain(f.dataRoot);
    const record = f.records.at(-1);
    expect(record).toMatchObject({
      kind: "verify",
      verdict: "pass",
      assurance: "isolated_local",
      verified: true,
      advisory: false,
      run_id: "vr_fixture",
      contract_id: "mars-smoke-v1",
      contract_digest: "sha256:abc",
      signature_status: "unsigned_hash_bound",
      required_checks: { passed: 1, failed: 0, inconclusive: 0 },
    });
    const call = (await f.calls()).find((item) => item.args[1] === "run");
    expect(call?.args[0]).toBe("verify");
    expect(call?.args[2]?.startsWith(join(f.dataRoot, "tasks"))).toBe(true);
    expect(call?.args[2]?.includes(`${sep}contracts${sep}`)).toBe(true);
    expect(call?.args.slice(3)).toEqual(["--dir", f.cwd]);
    expect(call?.args).not.toContain("--in-process");
    expect(JSON.parse(call?.contract ?? "{}")).toMatchObject({
      contract_id: "mars-smoke-v1",
      required_assurance: "isolated_local",
    });
    expect(
      await f.tools.verify({ action: "show", run_id: "vr_fixture" }),
    ).toContain("· mars_verify · verified]");

    const refusals = await f.tools.verify({
      action: "run",
      contract: {
        ...contract,
        required_assurance: "remote_attested",
        allowed_origins: ["https://api.example.com"],
        checks: [
          ...contract.checks,
          {
            id: "cmd",
            type: "command_exit",
            params: { command: ["true"] },
            required: true,
          },
          {
            id: "http",
            type: "http_request",
            params: { url: "https://example.com/health" },
            required: true,
          },
        ],
      },
    });
    expect(refusals).toContain("· mars_verify · inconclusive]");
    expect(refusals).toContain("remote_attested is not implemented");
    expect(refusals).toContain("no execute approval");
    expect(refusals).toContain("network sources are disabled");
    expect(f.records.at(-1)).toMatchObject({
      verdict: "inconclusive",
      verified: false,
    });
    expect(
      (await f.calls()).filter((item) => item.args[1] === "run"),
    ).toHaveLength(1);
    expect(
      await f.tools.verify({ action: "run", contract: { title: "no id" } }),
    ).toContain("not a valid verification contract");
  } finally {
    await f.cleanup();
  }
});

test("verify never upgrades: failed, inconclusive, advisory-only and errored runs stay unverified", async () => {
  const cases: Array<[Record<string, unknown>, string, string]> = [
    [
      {
        ...PASS_RUN,
        verdict: "fail",
        checks: [{ id: "a", status: "fail", required: true }],
      },
      "fail",
      "inconclusive",
    ],
    [
      {
        ...PASS_RUN,
        verdict: "inconclusive",
        checks: [{ id: "a", status: "inconclusive", required: true }],
      },
      "inconclusive",
      "inconclusive",
    ],
    [
      { ...PASS_RUN, assurance: "visual_advisory" },
      "inconclusive",
      "inconclusive",
    ],
    [
      { ...PASS_RUN, checks: [{ id: "a", status: "pass", required: false }] },
      "inconclusive",
      "inconclusive",
    ],
    [{ ...PASS_RUN, verdict: "error", checks: [] }, "error", "error"],
  ];
  for (const [result, verdict, label] of cases) {
    const f = await fixture({
      scenario: {
        rules: [
          {
            match: ["verify", "run"],
            stdout: JSON.stringify(result),
            exit: verdict === "pass" ? 0 : 1,
          },
        ],
      },
    });
    try {
      const rendered = await f.tools.verify({
        action: "run",
        contract: {
          contract_id: "c",
          title: "t",
          checks: [
            { id: "a", type: "file_exists", params: { path: "clip.mp4" } },
          ],
        },
      });
      expect(rendered).toContain(`· mars_verify · ${label}]`);
      expect(rendered).not.toContain("· verified]");
      expect(f.records.at(-1)).toMatchObject({
        kind: "verify",
        verdict,
        verified: false,
      });
    } finally {
      await f.cleanup();
    }
  }
  const crashed = await fixture({
    scenario: {
      rules: [
        {
          match: ["verify", "run"],
          exit: 1,
          stdout: JSON.stringify({
            error: "verify.contract_unreadable",
            message: "bad",
            fix: "fix it",
            details: {},
          }),
        },
      ],
    },
  });
  try {
    const rendered = await crashed.tools.verify({
      action: "run",
      contract: {
        contract_id: "c",
        title: "t",
        checks: [
          { id: "a", type: "file_exists", params: { path: "clip.mp4" } },
        ],
      },
    });
    expect(rendered).toContain("· mars_verify · error]");
    expect(rendered).toContain("verify.contract_unreadable");
    expect(crashed.records.at(-1)).toMatchObject({
      verdict: "error",
      verified: false,
    });
  } finally {
    await crashed.cleanup();
  }
});

test("a hung CLI is killed at the host timeout and reported inconclusive", async () => {
  const f = await fixture({
    timeoutMs: 300,
    scenario: {
      rules: [
        {
          match: ["verify", "run"],
          sleep_ms: 5_000,
          stdout: JSON.stringify(PASS_RUN),
        },
      ],
    },
  });
  try {
    const rendered = await f.tools.verify({
      action: "run",
      contract: {
        contract_id: "c",
        title: "t",
        checks: [
          { id: "a", type: "file_exists", params: { path: "clip.mp4" } },
        ],
      },
    });
    expect(rendered).toContain("· mars_verify · inconclusive]");
    expect(rendered).toContain("host timeout");
    expect(f.records.at(-1)).toMatchObject({
      verdict: "inconclusive",
      verified: false,
    });
  } finally {
    await f.cleanup();
  }
});

test("evidence records reject a verified flag without a passed deterministic required check", () => {
  const base = {
    schema_version: 1,
    operation: "watch.evidence",
    kind: "loop",
    tool: "mars_loop",
    verdict: "pass",
    assurance: "visual_advisory",
    verified: true,
    advisory: true,
    required_checks: { passed: 0, failed: 0, inconclusive: 0 },
    limitations: [],
    summary: "s",
    cli_version: "1.4.3",
    recorded_at: "2026-01-01T00:00:00.000Z",
  };
  expect(WatchEvidenceRecordSchema.safeParse(base).success).toBe(false);
  expect(
    WatchEvidenceRecordSchema.safeParse({
      ...base,
      kind: "verify",
      assurance: "isolated_local",
      advisory: false,
      required_checks: { passed: 1, failed: 0, inconclusive: 0 },
    }).success,
  ).toBe(true);
});

test("each task gets its own watch data directory, so indexes, loops and bundles never cross tasks", async () => {
  const a = await fixture({
    taskId: "task-a",
    scenario: { rules: [{ match: ["search"], stdout: "hits" }] },
  });
  const b = await fixture({
    taskId: "task-b",
    scenario: { rules: [{ match: ["search"], stdout: "hits" }] },
  });
  try {
    await a.tools.search({ query: "login" });
    await b.tools.search({ query: "login" });
    const dirA = (await a.calls()).find((call) => call.args[0] === "search")
      ?.env.WATCHSKILL_DATA_DIR;
    const dirB = (await b.calls()).find((call) => call.args[0] === "search")
      ?.env.WATCHSKILL_DATA_DIR;
    expect(dirA).toBeDefined();
    expect(dirA).not.toBe(dirB);
    expect(dirA?.startsWith(join(a.dataRoot, "tasks", ""))).toBe(true);
    expect(dirA).not.toBe(a.dataRoot);
  } finally {
    await a.cleanup();
    await b.cleanup();
  }
  const fresh = await mkdtemp(join(tmpdir(), "mars-watch-fresh-"));
  try {
    const service = createWatchService({
      command: ["bun", FAKE_CLI],
      dataRoot: join(fresh, "does", "not", "exist", "yet"),
    });
    expect((await service.doctor()).available).toBe(true);
    expect(() =>
      service.toolsFor({
        task_id: "t",
        cwd: fresh,
        evidence: { append: async () => undefined, list: async () => [] },
      }),
    ).toThrow("outside the task workspace");
  } finally {
    await rm(fresh, { recursive: true, force: true });
  }
});

test("contract checks are gated by read/execute approval, relative paths and known check types", async () => {
  const readOnly = await fixture({
    read: true,
    execute: false,
    scenario: {
      rules: [{ match: ["verify", "run"], stdout: JSON.stringify(PASS_RUN) }],
    },
  });
  const contract = (checks: unknown[]) => ({
    contract_id: "c",
    title: "t",
    checks,
  });
  try {
    const escaped = await readOnly.tools.verify({
      action: "run",
      contract: contract([
        { id: "abs", type: "file_exists", params: { path: "/etc/passwd" } },
        {
          id: "up",
          type: "file_digest",
          params: { path: "../outside.mp4", digest: "x" },
        },
        {
          id: "dir",
          type: "directory_manifest",
          params: { path: "src", expected_files: ["/root/.ssh/id_rsa"] },
        },
        {
          id: "db",
          type: "sqlite_query",
          params: { database: "/var/db.sqlite", sql: "select 1" },
        },
        { id: "mystery", type: "shell", params: {} },
        { id: "live", type: "live_console", params: { session_id: "s" } },
        { id: "shell", type: "command_exit", params: { command: "rm -rf /" } },
      ]),
    });
    expect(escaped).toContain("· mars_verify · inconclusive]");
    expect(escaped).toContain("check abs path must be relative");
    expect(escaped).toContain("check up path must not leave");
    expect(escaped).toContain("expected_files entry must be relative");
    expect(escaped).toContain("check db database must be relative");
    expect(escaped).toContain("unknown type shell");
    expect(escaped).toContain("check live (live_console) runs something");
    expect(escaped).toContain("check shell (command_exit) runs something");
    expect(escaped).toContain("command must be a non-empty argv list");
    expect(
      (await readOnly.calls()).filter((call) => call.args[1] === "run"),
    ).toHaveLength(0);
    expect(readOnly.records.at(-1)).toMatchObject({
      kind: "verify",
      verdict: "inconclusive",
      verified: false,
    });
    const ok = await readOnly.tools.verify({
      action: "run",
      contract: contract([
        { id: "present", type: "file_exists", params: { path: "clip.mp4" } },
        { id: "gate", type: "human_approval", params: {} },
      ]),
    });
    expect(ok).toContain("· mars_verify · verified]");
  } finally {
    await readOnly.cleanup();
  }
  const noRead = await fixture({
    read: false,
    execute: false,
    scenario: {
      rules: [{ match: ["verify", "run"], stdout: JSON.stringify(PASS_RUN) }],
    },
  });
  try {
    const refused = await noRead.tools.verify({
      action: "run",
      contract: contract([
        { id: "present", type: "file_exists", params: { path: "clip.mp4" } },
      ]),
    });
    expect(refused).toContain("no read approval");
    expect(
      (await noRead.calls()).filter((call) => call.args[1] === "run"),
    ).toHaveLength(0);
  } finally {
    await noRead.cleanup();
  }
  const executor = await fixture({
    read: true,
    execute: true,
    scenario: {
      rules: [{ match: ["verify", "run"], stdout: JSON.stringify(PASS_RUN) }],
    },
  });
  try {
    const ran = await executor.tools.verify({
      action: "run",
      contract: contract([
        {
          id: "cmd",
          type: "command_exit",
          params: { command: ["bun", "test"], exit_code: 0 },
        },
        {
          id: "http",
          type: "http_request",
          params: { url: "http://localhost:3000/health", status: 200 },
        },
      ]),
    });
    expect(ran).toContain("· mars_verify · verified]");
    expect(
      (await executor.calls()).filter((call) => call.args[1] === "run"),
    ).toHaveLength(1);
  } finally {
    await executor.cleanup();
  }
});

test("loop scripts are limited to the upstream step allowlist and loopback navigation", async () => {
  const f = await fixture({
    scenario: {
      rules: [{ match: ["loop", "start"], stdout: "loop_id: lp_1" }],
    },
  });
  const start = (script: unknown) =>
    f.tools.loop({
      action: "start",
      target: "http://localhost:5173/",
      pass_criteria: "ok",
      script: JSON.stringify(script),
    });
  try {
    expect(
      await start([
        { action: "evaluate", expression: "fetch('https://evil')" },
      ]),
    ).toContain("script must be a JSON array of steps");
    expect(
      await start([{ action: "click", selector: "#a", onclick: "x" }]),
    ).toContain("script must be a JSON array of steps");
    expect(
      await start([{ action: "goto", url: "https://example.com/" }]),
    ).toContain("network sources are disabled");
    expect(await start([{ action: "wait", seconds: 999 }])).toContain(
      "script must be a JSON array of steps",
    );
    expect(
      (await f.calls()).filter((call) => call.args[0] === "loop"),
    ).toHaveLength(0);
    const ok = await start([
      { action: "goto", url: "http://127.0.0.1:5173/login" },
      { action: "fill", selector: "#user", value: "demo" },
      { action: "press", key: "Enter" },
      { action: "wait", seconds: 1 },
    ]);
    expect(ok).toContain("· mars_loop · inconclusive]");
    const call = (await f.calls()).find((item) => item.args[0] === "loop");
    expect(call?.args[5]).toBe(
      JSON.stringify([
        { action: "goto", url: "http://127.0.0.1:5173/login" },
        { action: "fill", selector: "#user", value: "demo" },
        { action: "press", key: "Enter" },
        { action: "wait", seconds: 1 },
      ]),
    );
  } finally {
    await f.cleanup();
  }
});

test("a verify run that prints a pass and then hangs is inconclusive, not verified", async () => {
  const f = await fixture({
    timeoutMs: 300,
    scenario: {
      rules: [
        {
          match: ["verify", "run"],
          stdout: JSON.stringify(PASS_RUN),
          hang_after_stdout_ms: 5_000,
        },
        {
          match: ["verify", "show", "vr_fixture"],
          stdout: JSON.stringify(PASS_RUN),
          hang_after_stdout_ms: 5_000,
        },
      ],
    },
  });
  try {
    const run = await f.tools.verify({
      action: "run",
      contract: {
        contract_id: "c",
        title: "t",
        checks: [
          { id: "a", type: "file_exists", params: { path: "clip.mp4" } },
        ],
      },
    });
    expect(run).toContain("· mars_verify · inconclusive]");
    expect(run).not.toContain("VERIFIED");
    expect(f.records.at(-1)).toMatchObject({
      kind: "verify",
      verdict: "inconclusive",
      verified: false,
      assurance: "none",
    });
    const shown = await f.tools.verify({
      action: "show",
      run_id: "vr_fixture",
    });
    expect(shown).toContain("· mars_verify · inconclusive]");
    expect(shown).not.toContain("VERIFIED");
  } finally {
    await f.cleanup();
  }
});

test("failed or timed-out perception attempts are still recorded as non-verified evidence", async () => {
  const f = await fixture({
    timeoutMs: 300,
    scenario: {
      rules: [
        {
          match: ["watch"],
          exit: 1,
          stdout: JSON.stringify({
            error: "watch.unreadable",
            message: "bad file",
            fix: "use mp4",
            details: {},
          }),
        },
        { match: ["capture"], sleep_ms: 5_000, stdout: "never" },
      ],
    },
  });
  try {
    expect(await f.tools.watch({ source: "clip.mp4" })).toContain(
      "· mars_watch · error]",
    );
    expect(
      await f.tools.capture({ target: "http://localhost:3000/" }),
    ).toContain("· mars_watch_capture · inconclusive]");
    expect(
      f.records.map((record) => [
        record.kind,
        record.tool,
        record.verdict,
        record.verified,
      ]),
    ).toEqual([
      ["perception", "mars_watch", "error", false],
      ["perception", "mars_watch_capture", "inconclusive", false],
    ]);
    expect(await f.tools.evidence()).toContain("2 record(s), 0 verified");
  } finally {
    await f.cleanup();
  }
});

test("cloud models never lift the CLI's offline mode unless network sources are also allowed", async () => {
  const cloudOnly = await fixture({
    policy: { allow_cloud_models: true },
    scenario: { rules: [{ match: ["search"], stdout: "x" }] },
  });
  try {
    await cloudOnly.tools.search({ query: "q" });
    const env = (await cloudOnly.calls()).find(
      (call) => call.args[0] === "search",
    )?.env;
    expect(env?.WATCHSKILL_OFFLINE).toBe("1");
    expect(env?.WATCHSKILL_COST_POLICY).toBe("offline_only");
  } finally {
    await cloudOnly.cleanup();
  }
  const both = await fixture({
    policy: { allow_cloud_models: true, allow_network_sources: true },
    scenario: { rules: [{ match: ["search"], stdout: "x" }] },
  });
  try {
    await both.tools.search({ query: "q" });
    const env = (await both.calls()).find(
      (call) => call.args[0] === "search",
    )?.env;
    expect(env?.WATCHSKILL_OFFLINE).toBeUndefined();
  } finally {
    await both.cleanup();
  }
});
