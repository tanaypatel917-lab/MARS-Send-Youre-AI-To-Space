import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWatchService,
  LoopStateSchema,
  VerifyRunResultSchema,
  type WatchEvidenceRecord,
} from "./index";

/**
 * Compatibility with the real watch-skill 1.4.3 CLI. The fixture half runs
 * always, against artifacts the real package produced (see
 * test/fixtures/README.md). The live half runs only when MARS_WATCH_REAL_CLI
 * names an installed `watch-skill` binary; CI has none, so it is skipped there.
 */
const FIXTURES = join(import.meta.dir, "..", "test", "fixtures");
const FAKE_CLI = join(import.meta.dir, "..", "test", "fake-watch-skill.ts");
const REAL_CLI = process.env.MARS_WATCH_REAL_CLI;

const taskDir = (dataRoot: string, taskId: string) =>
  join(
    dataRoot,
    "tasks",
    createHash("sha256").update(taskId).digest("hex").slice(0, 32),
  );

async function harness(
  command: string[],
  extraEnv: Record<string, string> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "mars-watch-real-"));
  const cwd = join(root, "workspace");
  const dataRoot = join(root, "data");
  await mkdir(cwd, { recursive: true });
  await writeFile(join(cwd, "present.txt"), "present");
  const records: WatchEvidenceRecord[] = [];
  const service = createWatchService({
    command,
    dataRoot,
    env: extraEnv,
    fetch: async () => new Response(null, { status: 200 }),
  });
  const tools = service.toolsFor({
    task_id: "real",
    cwd,
    approvals: { read: true, execute: false },
    evidence: {
      async append(record) {
        records.push(record);
      },
      async list() {
        return records;
      },
    },
  });
  const seedLoopState = async () => {
    const dir = join(taskDir(dataRoot, "real"), "loops", "lp_real_fixture");
    await mkdir(dir, { recursive: true });
    await copyFile(
      join(FIXTURES, "real-loop-state.json"),
      join(dir, "state.json"),
    );
  };
  return {
    root,
    service,
    tools,
    records,
    seedLoopState,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("the wrapper parses upstream's real loop state.json and `loop status` output", async () => {
  const state = LoopStateSchema.parse(
    JSON.parse(await readFile(join(FIXTURES, "real-loop-state.json"), "utf8")),
  );
  expect(state.loop_id).toBe("lp_real_fixture");
  expect(state.status).toBe("passed");
  expect(
    state.iterations.map((item) => [item.n, item.critique.verdict]),
  ).toEqual([
    [0, "fail"],
    [1, "pass"],
  ]);
  const stdout = await readFile(
    join(FIXTURES, "real-loop-status.stdout"),
    "utf8",
  );
  expect(/^loop_id:\s*(\S+)/m.exec(stdout)?.[1]).toBe("lp_real_fixture");

  const scenario = join(
    tmpdir(),
    `mars-watch-real-scenario-${process.pid}.json`,
  );
  await writeFile(
    scenario,
    JSON.stringify({
      rules: [{ match: ["loop", "status", "lp_real_fixture"], stdout }],
    }),
  );
  const h = await harness(["bun", FAKE_CLI], {
    FAKE_WATCH_SKILL_SCENARIO: scenario,
  });
  try {
    await h.seedLoopState();
    const rendered = await h.tools.loop({
      action: "status",
      loop_id: "lp_real_fixture",
    });
    expect(rendered).toContain("· mars_loop · advisory]");
    expect(rendered).toContain(
      "verdict pass · assurance visual_advisory · advisory, not verified · loop status passed",
    );
    expect(rendered).toContain("FIXED: Submit button overlaps the header");
    expect(h.records.at(-1)).toMatchObject({
      kind: "loop",
      verdict: "pass",
      verified: false,
      advisory: true,
      loop_id: "lp_real_fixture",
      iteration: 1,
      summary: "Layout matches the pass criteria",
    });
  } finally {
    await h.cleanup();
    await rm(scenario, { force: true });
  }
});

test("the wrapper parses upstream's real `verify run` summary and `verify show` bundle", async () => {
  const run = VerifyRunResultSchema.parse(
    JSON.parse(
      await readFile(join(FIXTURES, "real-verify-run.stdout"), "utf8"),
    ),
  );
  const shown = VerifyRunResultSchema.parse(
    JSON.parse(
      await readFile(join(FIXTURES, "real-verify-show.stdout"), "utf8"),
    ),
  );
  for (const result of [run, shown]) {
    expect(result.verdict).toBe("pass");
    expect(result.assurance).toBe("isolated_local");
    expect(result.signature_status).toBe("unsigned_hash_bound");
    expect(
      result.checks.map((check) => [check.id, check.status, check.required]),
    ).toEqual([
      ["present", "pass", true],
      ["absent", "fail", false],
    ]);
  }
  expect(shown.run_id).toBe(run.run_id);
});

test.skipIf(!REAL_CLI)(
  "the real watch-skill 1.4.3 CLI passes the doctor gate, verifies a file_exists contract and reports loop status through the wrapper",
  async () => {
    const h = await harness([REAL_CLI as string]);
    try {
      const doctor = await h.service.doctor();
      expect(doctor.version).toBe("1.4.3");
      expect(doctor.available).toBe(true);
      expect(await h.tools.verify({ action: "checks" })).toContain(
        "file_exists",
      );
      const run = await h.tools.verify({
        action: "run",
        contract: {
          contract_id: "mars-real-smoke-v1",
          title: "real CLI smoke",
          checks: [
            {
              id: "present",
              type: "file_exists",
              required: true,
              params: { path: "present.txt" },
            },
            {
              id: "absent",
              type: "file_exists",
              required: false,
              params: { path: "missing.txt" },
            },
          ],
        },
      });
      expect(run).toContain(
        "[untrusted watch-skill output · mars_verify · verified]",
      );
      expect(run).toContain("assurance isolated_local");
      const record = h.records.at(-1);
      expect(record).toMatchObject({
        kind: "verify",
        verdict: "pass",
        assurance: "isolated_local",
        verified: true,
        contract_id: "mars-real-smoke-v1",
        required_checks: { passed: 1, failed: 0, inconclusive: 0 },
      });
      expect(record?.run_id).toMatch(/^vr_/);
      const shown = await h.tools.verify({
        action: "show",
        run_id: record?.run_id ?? "",
      });
      expect(shown).toContain("· mars_verify · verified]");
      await h.seedLoopState();
      const status = await h.tools.loop({
        action: "status",
        loop_id: "lp_real_fixture",
      });
      expect(status).toContain(
        "verdict pass · assurance visual_advisory · advisory, not verified · loop status passed",
      );
      expect(h.records.at(-1)).toMatchObject({
        kind: "loop",
        verdict: "pass",
        verified: false,
        iteration: 1,
      });
      const missing = await h.tools.loop({
        action: "status",
        loop_id: "lp_nope",
      });
      expect(missing).toContain("· mars_loop · error]");
      expect(missing).toContain("loop.not_found");
    } finally {
      await h.cleanup();
    }
  },
);
