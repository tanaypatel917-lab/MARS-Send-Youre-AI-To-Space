import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type HookExecutor,
  type HookSpec,
  HooksError,
  HooksRegistry,
  isBlocked,
  loadHooks,
  MAX_HOOK_OUTPUT_BYTES,
  parseHooksFile,
  renderHookArgv,
  runHooks,
  truncateOutput,
} from "./index";

const FIXTURES = resolve(import.meta.dir, "../test/fixtures/hooks");
const file = (hooks: unknown) => ({ schema_version: 1, hooks });
const entry = (command: string[], extra: Record<string, unknown> = {}) => ({
  command,
  ...extra,
});

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mars-hooks-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("loadHooks", () => {
  it("returns null when .mars/hooks.json is missing", async () => {
    expect(await loadHooks(root)).toBeNull();
  });

  it("loads the canonical format with defaults applied", async () => {
    const registry = await loadHooks(join(FIXTURES, "valid"));
    expect(registry).not.toBeNull();
    expect(registry?.size).toBe(4);
    expect(registry?.list()).toEqual([
      {
        event: "session-start",
        command: ["bun", "run", "lint"],
        timeout_ms: 60_000,
      },
      {
        event: "pre-tool",
        matcher: "mars_write|mars_apply_patch",
        command: ["bun", "run", "check:fast", "{tool}", "{path}"],
        timeout_ms: 30_000,
      },
      {
        event: "pre-tool",
        matcher: "*",
        command: ["echo", "any-tool"],
        timeout_ms: 60_000,
      },
      {
        event: "post-tool",
        matcher: "mars_write",
        command: ["bun", "run", "biome", "format", "--write", "{path}"],
        timeout_ms: 60_000,
      },
    ]);
  });

  it("accepts Claude Code event names as aliases", async () => {
    const registry = await loadHooks(join(FIXTURES, "aliases"));
    expect(registry?.list().map((spec) => spec.event)).toEqual([
      "session-start",
      "pre-tool",
      "post-tool",
    ]);
    expect(registry?.select("pre-tool", "mars_write")[0]?.command).toEqual([
      "echo",
      "pre",
      "{tool}",
    ]);
  });

  it.each([
    ["invalid-unknown-key", "shell"],
    ["invalid-shell-string", "command"],
    ["invalid-event", "Stop"],
    ["invalid-timeout", "timeout_ms"],
    ["invalid-duplicate-alias", "configured twice"],
  ])("rejects fixture %s", async (fixture, needle) => {
    const attempt = loadHooks(join(FIXTURES, fixture));
    await expect(attempt).rejects.toBeInstanceOf(HooksError);
    await attempt.catch((error: HooksError) => {
      expect(error.code).toBe("invalid");
      expect(error.message).toContain(needle);
    });
  });

  it("rejects malformed JSON, symlinks, directories and oversize files", async () => {
    await mkdir(join(root, ".mars"));
    const path = join(root, ".mars", "hooks.json");
    await writeFile(path, '{ "schema_version": 1, "hooks": {');
    await expect(loadHooks(root)).rejects.toMatchObject({ code: "invalid" });
    await rm(path);
    await writeFile(join(root, "elsewhere.json"), JSON.stringify(file({})));
    await symlink(join(root, "elsewhere.json"), path);
    await expect(loadHooks(root)).rejects.toThrow(/symlink/);
    await rm(path);
    await mkdir(path);
    await expect(loadHooks(root)).rejects.toThrow(/regular file/);
    await rm(path, { recursive: true });
    await writeFile(
      path,
      JSON.stringify(
        file({ "session-start": [entry(["echo", "x".repeat(300 * 1024)])] }),
      ),
    );
    await expect(loadHooks(root)).rejects.toThrow(/exceeds/);
  });
});

describe("parseHooksFile", () => {
  it("rejects wrong schema versions, unknown root keys and non-array events", () => {
    expect(() => parseHooksFile({ schema_version: 2, hooks: {} })).toThrow(
      HooksError,
    );
    expect(() => parseHooksFile({ ...file({}), extra: 1 })).toThrow(/extra/);
    expect(() => parseHooksFile(file({ "pre-tool": entry(["echo"]) }))).toThrow(
      HooksError,
    );
    expect(() => parseHooksFile(null)).toThrow(HooksError);
  });

  it("enforces argv, matcher and timeout bounds", () => {
    const ok = parseHooksFile(
      file({ "pre-tool": [entry(["echo"], { timeout_ms: 1_000 })] }),
    );
    expect(ok.size).toBe(1);
    expect(() => parseHooksFile(file({ "pre-tool": [entry([])] }))).toThrow(
      /command/,
    );
    expect(() =>
      parseHooksFile(file({ "pre-tool": [entry(Array(65).fill("a"))] })),
    ).toThrow(/command/);
    expect(
      parseHooksFile(file({ "pre-tool": [entry(Array(64).fill("a"))] })).size,
    ).toBe(1);
    expect(() =>
      parseHooksFile(file({ "pre-tool": [entry(["a".repeat(1025)])] })),
    ).toThrow(/1024 bytes/);
    expect(() =>
      parseHooksFile(file({ "pre-tool": [entry(["echo", "a\nb"])] })),
    ).toThrow(/control characters/);
    expect(() =>
      parseHooksFile(file({ "pre-tool": [entry(["echo", ""])] })),
    ).toThrow(/command/);
    expect(() =>
      parseHooksFile(
        file({ "pre-tool": [entry(["echo"], { timeout_ms: 300_001 })] }),
      ),
    ).toThrow(/timeout_ms/);
    expect(() =>
      parseHooksFile(
        file({ "pre-tool": [entry(["echo"], { timeout_ms: 1000.5 })] }),
      ),
    ).toThrow(/timeout_ms/);
    expect(() =>
      parseHooksFile(
        file({ "pre-tool": [entry(["echo"], { matcher: "mars write" })] }),
      ),
    ).toThrow(/matcher/);
    expect(() =>
      parseHooksFile(
        file({ "pre-tool": [entry(["echo"], { matcher: "a||b" })] }),
      ),
    ).toThrow(/matcher/);
    expect(() =>
      parseHooksFile(
        file({ "session-start": [entry(["echo"], { matcher: "*" })] }),
      ),
    ).toThrow(/no matcher/);
    expect(() =>
      parseHooksFile(file({ "post-tool": Array(33).fill(entry(["echo"])) })),
    ).toThrow(/post-tool/);
    expect(
      parseHooksFile(file({ "post-tool": Array(32).fill(entry(["echo"])) }))
        .size,
    ).toBe(32);
  });
});

describe("HooksRegistry.select", () => {
  const registry = parseHooksFile(
    file({
      "session-start": [entry(["a"])],
      "pre-tool": [
        entry(["b"], { matcher: "mars_write|mars_apply_patch" }),
        entry(["c"], { matcher: "*" }),
        entry(["d"]),
      ],
      "post-tool": [entry(["e"], { matcher: "mars_write" })],
    }),
  );
  it("matches exact tool names, wildcards and absent matchers", () => {
    const argv = (specs: HookSpec[]) => specs.map((s) => s.command[0]);
    expect(argv(registry.select("session-start"))).toEqual(["a"]);
    expect(argv(registry.select("session-start", "anything"))).toEqual(["a"]);
    expect(argv(registry.select("pre-tool", "mars_write"))).toEqual([
      "b",
      "c",
      "d",
    ]);
    expect(argv(registry.select("pre-tool", "mars_apply_patch"))).toEqual([
      "b",
      "c",
      "d",
    ]);
    expect(argv(registry.select("pre-tool", "mars_read"))).toEqual(["c", "d"]);
    expect(argv(registry.select("pre-tool", "mars_write_extra"))).toEqual([
      "c",
      "d",
    ]);
    expect(argv(registry.select("pre-tool"))).toEqual(["c", "d"]);
    expect(argv(registry.select("post-tool", "mars_read"))).toEqual([]);
    expect(argv(registry.select("post-tool", "mars_write"))).toEqual(["e"]);
  });
  it("returns copies so callers cannot mutate the registry", () => {
    const first = registry.select("post-tool", "mars_write")[0];
    first?.command.push("mutated");
    expect(registry.select("post-tool", "mars_write")[0]?.command).toEqual([
      "e",
    ]);
  });
});

describe("renderHookArgv", () => {
  const spec: HookSpec = {
    event: "pre-tool",
    command: ["run", "{tool}", "--path", "{path}", "x{path}y", "{tool}"],
    timeout_ms: 1_000,
  };
  it("substitutes whole tokens only and drops placeholders without a value", () => {
    expect(
      renderHookArgv(spec, { tool: "mars_write", path: "src/a.ts" }),
    ).toEqual([
      "run",
      "mars_write",
      "--path",
      "src/a.ts",
      "x{path}y",
      "mars_write",
    ]);
    expect(renderHookArgv(spec, { tool: "mars_write" })).toEqual([
      "run",
      "mars_write",
      "--path",
      "x{path}y",
      "mars_write",
    ]);
    expect(renderHookArgv(spec, {})).toEqual(["run", "--path", "x{path}y"]);
  });
});

describe("runHooks", () => {
  const registry = parseHooksFile(
    file({
      "session-start": [entry(["lint"])],
      "pre-tool": [
        entry(["first", "{tool}", "{path}"], { matcher: "mars_write" }),
        entry(["second"], { matcher: "*" }),
        entry(["third"]),
      ],
      "post-tool": [entry(["format", "{path}"], { matcher: "mars_write" })],
    }),
  );
  const recording = (
    respond: (argv: string[]) => Awaited<ReturnType<HookExecutor>>,
  ) => {
    const calls: Array<{ argv: string[]; timeoutMs: number }> = [];
    const executor: HookExecutor = async (argv, timeoutMs) => {
      calls.push({ argv, timeoutMs });
      return respond(argv);
    };
    return { calls, executor };
  };

  it("runs hooks in order through the injected executor and never blocks on exit 0", async () => {
    const { calls, executor } = recording(() => ({
      exit_code: 0,
      stdout: "ok",
      stderr: "",
    }));
    const results = await runHooks(
      registry,
      "pre-tool",
      { tool: "mars_write", path: "src/a.ts" },
      executor,
    );
    expect(calls).toEqual([
      { argv: ["first", "mars_write", "src/a.ts"], timeoutMs: 60_000 },
      { argv: ["second"], timeoutMs: 60_000 },
      { argv: ["third"], timeoutMs: 60_000 },
    ]);
    expect(
      results.map((r) => [r.outcome, r.exit_code, r.blocked, r.tool]),
    ).toEqual([
      ["ran", 0, false, "mars_write"],
      ["ran", 0, false, "mars_write"],
      ["ran", 0, false, "mars_write"],
    ]);
    expect(results[0]?.event).toBe("pre-tool");
    expect(results[0]?.stdout).toBe("ok");
    expect(isBlocked(results)).toBe(false);
  });

  it("blocks on pre-tool exit code 2 and stops the remaining pre-tool hooks", async () => {
    const { calls, executor } = recording((argv) =>
      argv[0] === "first"
        ? { exit_code: 2, stdout: "", stderr: "policy says no" }
        : { exit_code: 0, stdout: "", stderr: "" },
    );
    const results = await runHooks(
      registry,
      "pre-tool",
      { tool: "mars_write" },
      executor,
    );
    expect(calls.length).toBe(1);
    expect(results).toEqual([
      {
        event: "pre-tool",
        tool: "mars_write",
        argv: ["first", "mars_write"],
        outcome: "ran",
        exit_code: 2,
        stdout: "",
        stderr: "policy says no",
        blocked: true,
      },
    ]);
    expect(isBlocked(results)).toBe(true);
  });

  it("records other non-zero exits without blocking, and exit 2 outside pre-tool does not block", async () => {
    const one = await runHooks(
      registry,
      "pre-tool",
      { tool: "mars_read" },
      recording(() => ({ exit_code: 1, stdout: "", stderr: "warn" })).executor,
    );
    expect(one.map((r) => [r.argv[0], r.exit_code, r.blocked])).toEqual([
      ["second", 1, false],
      ["third", 1, false],
    ]);
    const post = await runHooks(
      registry,
      "post-tool",
      { tool: "mars_write", path: "src/a.ts" },
      recording(() => ({ exit_code: 2, stdout: "", stderr: "" })).executor,
    );
    expect(post).toEqual([
      {
        event: "post-tool",
        tool: "mars_write",
        argv: ["format", "src/a.ts"],
        outcome: "ran",
        exit_code: 2,
        stdout: "",
        stderr: "",
        blocked: false,
      },
    ]);
    const start = await runHooks(
      registry,
      "session-start",
      {},
      recording(() => ({ exit_code: 2, stdout: "", stderr: "" })).executor,
    );
    expect(start.map((r) => [r.argv, r.blocked, r.tool])).toEqual([
      [["lint"], false, undefined],
    ]);
  });

  it("records executor refusals as skipped and thrown errors as error", async () => {
    const skipped = await runHooks(registry, "session-start", {}, async () => ({
      skipped: "execute approval not granted",
    }));
    expect(skipped).toEqual([
      {
        event: "session-start",
        argv: ["lint"],
        outcome: "skipped",
        stdout: "",
        stderr: "",
        blocked: false,
        reason: "execute approval not granted",
      },
    ]);
    const failed = await runHooks(registry, "session-start", {}, async () => {
      throw new Error("sandbox unavailable");
    });
    expect(failed.map((r) => [r.outcome, r.reason, r.blocked])).toEqual([
      ["error", "sandbox unavailable", false],
    ]);
  });

  it("times out hooks that outlive timeout_ms", async () => {
    const slow = new HooksRegistry([
      { event: "session-start", command: ["hang"], timeout_ms: 20 },
      { event: "session-start", command: ["after"], timeout_ms: 20 },
    ]);
    const results = await runHooks(slow, "session-start", {}, (argv) =>
      argv[0] === "hang"
        ? new Promise(() => {})
        : Promise.resolve({ exit_code: 0, stdout: "", stderr: "" }),
    );
    expect(results.map((r) => [r.argv[0], r.outcome, r.reason])).toEqual([
      ["hang", "timeout", "exceeded 20 ms"],
      ["after", "ran", undefined],
    ]);
  });

  it("truncates stdout/stderr to 4 KiB and skips hooks whose argv empties out", async () => {
    const results = await runHooks(
      registry,
      "post-tool",
      { tool: "mars_write" },
      async () => ({
        exit_code: 0,
        stdout: "é".repeat(5000),
        stderr: "x".repeat(5000),
      }),
    );
    expect(results[0]?.argv).toEqual(["format"]);
    expect(Buffer.byteLength(results[0]?.stdout ?? "")).toBeLessThanOrEqual(
      MAX_HOOK_OUTPUT_BYTES,
    );
    expect(results[0]?.stdout).toBe("é".repeat(2048));
    expect(results[0]?.stderr).toBe("x".repeat(4096));
    const empty = new HooksRegistry([
      { event: "post-tool", command: ["{path}"], timeout_ms: 1_000 },
    ]);
    const skipped = await runHooks(
      empty,
      "post-tool",
      { tool: "t" },
      async () => {
        throw new Error("must not be called");
      },
    );
    expect(skipped.map((r) => [r.outcome, r.argv])).toEqual([["skipped", []]]);
    expect(truncateOutput("abc", 2)).toBe("ab");
    expect(truncateOutput("abc")).toBe("abc");
  });

  it.each([
    "../../etc/passwd",
    "/etc/passwd",
    "C:/secrets.txt",
    "a\\b.txt",
    "src/./a.txt",
    "src//a.txt",
    "a\u0000.txt",
    "",
  ])(
    "refuses to hand a hook a path that is not workspace-relative: %j",
    async (path) => {
      let called = false;
      await expect(
        runHooks(
          registry,
          "pre-tool",
          { tool: "mars_write", path },
          async () => {
            called = true;
            return { exit_code: 0, stdout: "", stderr: "" };
          },
        ),
      ).rejects.toMatchObject({ code: "invalid" });
      expect(called).toBe(false);
    },
  );

  it("passes ordinary relative paths (including spaces) through unchanged", async () => {
    const { calls, executor } = recording(() => ({
      exit_code: 0,
      stdout: "",
      stderr: "",
    }));
    await runHooks(
      registry,
      "post-tool",
      { tool: "mars_write", path: "docs/my notes/..notes.md" },
      executor,
    );
    expect(calls.map((call) => call.argv)).toEqual([
      ["format", "docs/my notes/..notes.md"],
    ]);
  });

  it("rejects malformed tool names before anything runs", async () => {
    await expect(
      runHooks(registry, "pre-tool", { tool: "bad tool" }, async () => {
        throw new Error("must not be called");
      }),
    ).rejects.toMatchObject({ code: "invalid" });
  });
});
