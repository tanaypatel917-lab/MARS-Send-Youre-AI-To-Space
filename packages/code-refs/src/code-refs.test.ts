import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createGitRunner,
  createRepoRegistry,
  type GitSpawn,
  isSameReference,
  type LocatorRejectReason,
  RepoRegistrationFailed,
  type RepoRegistry,
  ResolvedReferenceSchema,
  referenceDigest,
  resolveReference,
  SearchPathsResultSchema,
  searchPaths,
  validateLocator,
} from "./index";

const GIT = Bun.which("git");
const SHA = /^[a-f0-9]{40}$/;

if (!GIT)
  console.warn(
    "[code-refs] `git` is not on PATH: the resolver tests are SKIPPED, not passed.",
  );

test("git availability is reported, never silently assumed", () => {
  expect(typeof GIT === "string" || GIT === null).toBe(true);
});

interface SpawnCall {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
}

const POISONED_ENV: Record<string, string> = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: "/root",
  HTTP_PROXY: "http://proxy.example:3128",
  https_proxy: "http://proxy.example:3128",
  ALL_PROXY: "socks5://proxy.example:1080",
  NO_PROXY: "",
  GIT_ASKPASS: "/usr/bin/evil-askpass",
  GIT_SSH_COMMAND: "ssh -o ProxyCommand=evil",
  SSH_AUTH_SOCK: "/run/user/1000/ssh-agent",
  GIT_CONFIG_PARAMETERS: "'core.fsmonitor=evil'",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "core.fsmonitor",
  GIT_CONFIG_VALUE_0: "evil",
  GIT_DIR: "/somewhere/else/.git",
  GIT_WORK_TREE: "/somewhere/else",
  GIT_INDEX_FILE: "/somewhere/else/index",
  GIT_ALTERNATE_OBJECT_DIRECTORIES: "/somewhere/else/objects",
  GIT_NAMESPACE: "evil",
  GIT_TRACE: "1",
  GITHUB_TOKEN: "ghp_secret",
  AWS_SECRET_ACCESS_KEY: "secret",
};

function fixtureGit(cwd: string, home: string, ...args: string[]): string {
  const result = Bun.spawnSync(
    [
      GIT ?? "git",
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "init.defaultBranch=main",
      ...args,
    ],
    {
      cwd,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        LC_ALL: "C",
      },
      stdin: "ignore",
    },
  );
  if (result.exitCode !== 0)
    throw new Error(
      `fixture git ${args.join(" ")} failed: ${result.stderr.toString()}`,
    );
  return result.stdout.toString().trim();
}

describe.skipIf(!GIT)("@mars/code-refs", () => {
  let root: string;
  let repoDir: string;
  let otherDir: string;
  let bareDir: string;
  let homeDir: string;
  let c1: string;
  let c2: string;
  let foreign: string;
  const calls: SpawnCall[] = [];
  const spawn: GitSpawn = (argv, options) => {
    calls.push({ argv: [...argv], cwd: options.cwd, env: { ...options.env } });
    return Bun.spawn(argv, {
      cwd: options.cwd,
      env: options.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  };
  let registry: RepoRegistry;
  const results: unknown[] = [];

  const resolve = async (
    input: unknown,
    limits: Parameters<typeof resolveReference>[2] = {},
  ) => {
    const result = await resolveReference(registry, input, {
      max_blob_bytes: 4096,
      ...limits,
    });
    ResolvedReferenceSchema.parse(result);
    results.push(result);
    return result;
  };
  const locate = (
    path: string,
    sha: string,
    range?: [number, number],
  ): Record<string, unknown> => ({
    repo_id: "main-repo",
    commit_sha: sha,
    path,
    ...(range ? { line_start: range[0], line_end: range[1] } : {}),
  });

  beforeAll(async () => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), "code-refs-test-")));
    homeDir = join(root, "home");
    mkdirSync(homeDir, { mode: 0o700 });
    const fixtureHome = join(root, "fixture-home");
    mkdirSync(fixtureHome, { mode: 0o700 });
    repoDir = join(root, "repo");
    mkdirSync(repoDir);
    fixtureGit(repoDir, fixtureHome, "init", "-q");
    mkdirSync(join(repoDir, "src"));
    mkdirSync(join(repoDir, "docs", "nested"), { recursive: true });
    mkdirSync(join(repoDir, "bin"));
    mkdirSync(join(repoDir, "tree"));
    writeFileSync(
      join(repoDir, "src", "app.ts"),
      `${Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n")}\n`,
    );
    writeFileSync(
      join(repoDir, "bin", "blob.bin"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]),
    );
    writeFileSync(
      join(repoDir, "latin1.txt"),
      Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]),
    );
    writeFileSync(join(repoDir, "docs", "nested", "readme.md"), "# nested\n");
    writeFileSync(join(repoDir, "big.txt"), "x".repeat(5000));
    writeFileSync(join(repoDir, "renamed-old.txt"), "renamed\n");
    writeFileSync(join(repoDir, "crlf.txt"), "a\r\nb\r\nc\r\n");
    writeFileSync(join(repoDir, "empty.txt"), "");
    writeFileSync(join(repoDir, "no-newline.txt"), "only");
    for (let i = 0; i < 30; i += 1)
      writeFileSync(
        join(repoDir, "tree", `f${String(i).padStart(2, "0")}.txt`),
        `${i}\n`,
      );
    symlinkSync("src/app.ts", join(repoDir, "link.ts"));
    fixtureGit(repoDir, fixtureHome, "add", "-A");
    fixtureGit(
      repoDir,
      fixtureHome,
      "update-index",
      "--add",
      "--cacheinfo",
      "160000,1111111111111111111111111111111111111111,vendor/sub",
    );
    fixtureGit(repoDir, fixtureHome, "commit", "-q", "-m", "c1");
    c1 = fixtureGit(repoDir, fixtureHome, "rev-parse", "HEAD");

    fixtureGit(
      repoDir,
      fixtureHome,
      "mv",
      "renamed-old.txt",
      "renamed-new.txt",
    );
    writeFileSync(
      join(repoDir, "src", "app.ts"),
      `${Array.from({ length: 10 }, (_, i) =>
        i === 2 ? "line 3 CHANGED" : `line ${i + 1}`,
      ).join("\n")}\n`,
    );
    writeFileSync(join(repoDir, "only-later.txt"), "later\n");
    fixtureGit(repoDir, fixtureHome, "add", "-A");
    fixtureGit(repoDir, fixtureHome, "commit", "-q", "-m", "c2");
    c2 = fixtureGit(repoDir, fixtureHome, "rev-parse", "HEAD");

    otherDir = join(root, "other");
    mkdirSync(join(otherDir, "src"), { recursive: true });
    fixtureGit(otherDir, fixtureHome, "init", "-q");
    writeFileSync(join(otherDir, "src", "app.ts"), "foreign\n");
    fixtureGit(otherDir, fixtureHome, "add", "-A");
    fixtureGit(otherDir, fixtureHome, "commit", "-q", "-m", "foreign");
    foreign = fixtureGit(otherDir, fixtureHome, "rev-parse", "HEAD");

    bareDir = join(root, "bare.git");
    fixtureGit(root, fixtureHome, "clone", "-q", "--bare", repoDir, bareDir);

    registry = createRepoRegistry({
      git: createGitRunner({ spawn, homeDir, processEnv: POISONED_ENV }),
    });
    await registry.register({
      repo_id: "main-repo",
      dir: repoDir,
      label: "Main",
    });
    await registry.register({
      repo_id: "bare-repo",
      dir: bareDir,
      label: "Bare",
    });
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("fixture commits are real", () => {
    expect(c1).toMatch(SHA);
    expect(c2).toMatch(SHA);
    expect(c1).not.toBe(c2);
  });

  describe("registry", () => {
    test("lists ids and labels only", () => {
      expect(registry.list()).toEqual([
        { repo_id: "main-repo", label: "Main" },
        { repo_id: "bare-repo", label: "Bare" },
      ]);
      expect(JSON.stringify(registry.list())).not.toContain(root);
    });

    const rejects = async (
      input: { repo_id: string; dir: string; label: string },
      code: RepoRegistrationFailed["code"],
    ) => {
      const fresh = createRepoRegistry({
        git: createGitRunner({ spawn, homeDir, processEnv: POISONED_ENV }),
      });
      await fresh.register({
        repo_id: "main-repo",
        dir: repoDir,
        label: "Main",
      });
      let error: unknown;
      try {
        await fresh.register(input);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(RepoRegistrationFailed);
      const failed = error as RepoRegistrationFailed;
      expect(failed.code).toBe(code);
      expect(failed.message).not.toContain(root);
    };

    test("rejects nested, overlapping, symlinked, non-git and relative dirs", async () => {
      await rejects(
        { repo_id: "nested", dir: join(repoDir, "src"), label: "x" },
        "dir_overlaps_registered",
      );
      await rejects(
        { repo_id: "parent", dir: root, label: "x" },
        "dir_overlaps_registered",
      );
      await rejects(
        { repo_id: "main-repo", dir: otherDir, label: "x" },
        "repo_id_taken",
      );
      const link = join(root, "repo-link");
      symlinkSync(otherDir, link);
      await rejects(
        { repo_id: "link", dir: link, label: "x" },
        "dir_is_symlink",
      );
      await rejects(
        { repo_id: "via-link", dir: join(link, "src"), label: "x" },
        "dir_not_canonical",
      );
      const plain = join(root, "plain");
      mkdirSync(plain);
      await rejects(
        { repo_id: "plain", dir: plain, label: "x" },
        "dir_not_git",
      );
      await rejects(
        { repo_id: "sub", dir: join(otherDir, "src"), label: "x" },
        "dir_not_git",
      );
      await rejects(
        { repo_id: "rel", dir: "repo", label: "x" },
        "dir_not_absolute",
      );
      await rejects(
        { repo_id: "bad id!", dir: otherDir, label: "x" },
        "invalid_registration",
      );
      await rejects(
        { repo_id: "missing", dir: join(root, "nope"), label: "x" },
        "dir_not_directory",
      );
    });

    test("accepts a bare repository and resolves from it", async () => {
      const result = await resolve({
        repo_id: "bare-repo",
        commit_sha: c1,
        path: "src/app.ts",
        line_start: 3,
        line_end: 3,
      });
      expect(result.state).toBe("ok");
      if (result.state === "ok") expect(result.text).toBe("line 3");
    });
  });

  describe("resolution pins to the commit", () => {
    test("range at c1 survives the branch moving on", async () => {
      const result = await resolve(locate("src/app.ts", c1, [3, 4]));
      expect(result).toMatchObject({
        state: "ok",
        repo_id: "main-repo",
        commit_sha: c1,
        path: "src/app.ts",
        line_start: 3,
        line_end: 4,
        total_lines: 10,
        text: "line 3\nline 4",
        truncated: false,
      });
      if (result.state === "ok") {
        expect(result.blob_sha).toMatch(SHA);
        expect(result.text_sha256).toBe(
          new Bun.CryptoHasher("sha256").update("line 3\nline 4").digest("hex"),
        );
        expect(result.git_version).toMatch(/^\d+\.\d+/);
      }
      const later = await resolve(locate("src/app.ts", c2, [3, 3]));
      expect(later).toMatchObject({ state: "ok", text: "line 3 CHANGED" });
    });

    test("rename: old path stays at c1, is unavailable at c2", async () => {
      expect(await resolve(locate("renamed-old.txt", c1))).toMatchObject({
        state: "ok",
        text: "renamed",
        total_lines: 1,
      });
      expect(await resolve(locate("renamed-old.txt", c2))).toMatchObject({
        state: "unavailable",
        path: "renamed-old.txt",
      });
      expect(await resolve(locate("renamed-new.txt", c2))).toMatchObject({
        state: "ok",
      });
      expect(await resolve(locate("renamed-new.txt", c1))).toMatchObject({
        state: "unavailable",
      });
    });

    test("missing revision is unavailable even when HEAD has the path", async () => {
      expect(await resolve(locate("src/app.ts", foreign))).toEqual({
        state: "unavailable",
        repo_id: "main-repo",
        commit_sha: foreign,
        path: "src/app.ts",
        git_version: expect.any(String),
      });
      expect(await resolve(locate("only-later.txt", c1))).toMatchObject({
        state: "unavailable",
      });
      const blobAsCommit = await resolve(locate("src/app.ts", c1, [1, 1]));
      if (blobAsCommit.state === "ok")
        expect(
          await resolve(locate("src/app.ts", blobAsCommit.blob_sha)),
        ).toMatchObject({ state: "unavailable" });
    });

    test("whole file without a range, truncated at max_range_lines", async () => {
      const whole = await resolve(locate("src/app.ts", c1));
      expect(whole).toMatchObject({
        state: "ok",
        line_start: 1,
        line_end: 10,
        total_lines: 10,
        truncated: false,
      });
      const cut = await resolve(locate("src/app.ts", c1), {
        max_range_lines: 4,
      });
      expect(cut).toMatchObject({
        state: "ok",
        line_start: 1,
        line_end: 4,
        total_lines: 10,
        text: "line 1\nline 2\nline 3\nline 4",
        truncated: true,
      });
    });

    test("CRLF, missing final newline and empty files", async () => {
      expect(await resolve(locate("crlf.txt", c1, [2, 3]))).toMatchObject({
        state: "ok",
        text: "b\nc",
        total_lines: 3,
      });
      expect(await resolve(locate("no-newline.txt", c1))).toMatchObject({
        state: "ok",
        text: "only",
        total_lines: 1,
      });
      expect(await resolve(locate("empty.txt", c1))).toMatchObject({
        state: "ok",
        text: "",
        total_lines: 0,
        line_start: 1,
        line_end: 1,
      });
    });
  });

  describe("entry kinds and content states", () => {
    test("symlink, submodule and directory entries", async () => {
      expect(await resolve(locate("link.ts", c1))).toMatchObject({
        state: "unsupported_symlink",
      });
      expect(await resolve(locate("vendor/sub", c1))).toMatchObject({
        state: "unsupported_submodule",
      });
      expect(await resolve(locate("docs/nested", c1))).toMatchObject({
        state: "is_directory",
      });
      expect(await resolve(locate("docs/nested/readme.md", c1))).toMatchObject({
        state: "ok",
        text: "# nested",
      });
    });

    test("binary (NUL), binary (invalid UTF-8) and oversized blobs", async () => {
      expect(await resolve(locate("bin/blob.bin", c1))).toMatchObject({
        state: "binary",
        blob_sha: expect.stringMatching(SHA),
      });
      expect(await resolve(locate("latin1.txt", c1))).toMatchObject({
        state: "binary",
      });
      expect(await resolve(locate("big.txt", c1))).toMatchObject({
        state: "oversized",
        size_bytes: 5000,
        max_blob_bytes: 4096,
      });
      expect(
        await resolve(locate("big.txt", c1), { max_blob_bytes: 8192 }),
      ).toMatchObject({ state: "ok", total_lines: 1 });
    });

    test("range beyond EOF reports the line count", async () => {
      expect(await resolve(locate("src/app.ts", c1, [9, 12]))).toMatchObject({
        state: "range_out_of_bounds",
        total_lines: 10,
      });
      expect(await resolve(locate("src/app.ts", c1, [11, 11]))).toMatchObject({
        state: "range_out_of_bounds",
        total_lines: 10,
      });
      expect(await resolve(locate("src/app.ts", c1, [10, 10]))).toMatchObject({
        state: "ok",
        text: "line 10",
      });
    });
  });

  describe("locator validation happens before git runs", () => {
    const BAD_PATHS: [string, LocatorRejectReason][] = [
      ["../etc/passwd", "path_bad_segment"],
      ["src/../../x", "path_bad_segment"],
      ["/etc/passwd", "path_not_relative"],
      ["~/x", "path_not_relative"],
      [".git/config", "path_git_segment"],
      ["src/.GIT/HEAD", "path_git_segment"],
      ["src\\app.ts", "path_backslash"],
      ["file:///x", "path_scheme_or_drive"],
      ["C:/x", "path_scheme_or_drive"],
      ["src/app\u0000.ts", "path_control_characters"],
      ["src/app\u200b.ts", "path_invisible_code_point"],
      ["src/app\u202e.ts", "path_invisible_code_point"],
      ["src/app*.ts", "path_reserved_characters"],
      ["", "path_empty_or_too_long"],
      [`${"a".repeat(1025)}`, "path_empty_or_too_long"],
      ["src//app.ts", "path_bad_segment"],
      ["./src/app.ts", "path_bad_segment"],
    ];

    test("unsafe paths are rejected without spawning git", async () => {
      const before = calls.length;
      for (const [path, reason] of BAD_PATHS) {
        expect(await resolve(locate(path, c1))).toEqual({
          state: "invalid",
          reason,
        });
      }
      expect(calls.length).toBe(before);
    });

    test("abbreviated or symbolic revisions never reach git", async () => {
      const before = calls.length;
      for (const sha of [
        c1.slice(0, 7),
        "HEAD",
        "main",
        c1.toUpperCase(),
        `${c1}^`,
        `${c1} --output=/tmp/x`,
        "--version",
      ])
        expect(await resolve(locate("src/app.ts", sha))).toEqual({
          state: "invalid",
          reason: "invalid_commit_sha",
        });
      expect(calls.length).toBe(before);
    });

    test("bad repo ids, ranges and unknown fields", async () => {
      const before = calls.length;
      expect(
        await resolve({ ...locate("src/app.ts", c1), repo_id: "../main-repo" }),
      ).toEqual({ state: "invalid", reason: "invalid_repo_id" });
      expect(await resolve(locate("src/app.ts", c1, [5, 4]))).toEqual({
        state: "invalid",
        reason: "invalid_range",
      });
      expect(await resolve(locate("src/app.ts", c1, [0, 4]))).toEqual({
        state: "invalid",
        reason: "invalid_range",
      });
      expect(await resolve(locate("src/app.ts", c1, [1.5, 4]))).toEqual({
        state: "invalid",
        reason: "invalid_range",
      });
      expect(
        await resolve({ ...locate("src/app.ts", c1), line_start: 1 }),
      ).toEqual({ state: "invalid", reason: "invalid_range" });
      expect(await resolve(locate("src/app.ts", c1, [1, 401]))).toEqual({
        state: "invalid",
        reason: "range_too_large",
      });
      expect(
        await resolve({ ...locate("src/app.ts", c1), dir: repoDir }),
      ).toEqual({ state: "invalid", reason: "invalid_input" });
      expect(await resolve("src/app.ts")).toEqual({
        state: "invalid",
        reason: "invalid_input",
      });
      expect(calls.length).toBe(before);
      expect(
        await resolve({ ...locate("src/app.ts", c1), repo_id: "unknown" }),
      ).toEqual({
        state: "unknown_repo",
        repo_id: "unknown",
        commit_sha: c1,
        path: "src/app.ts",
      });
      expect(calls.length).toBe(before);
    });

    test("NFC normalisation keeps the locator path canonical", () => {
      const decomposed = "docs/cafe\u0301.md";
      const checked = validateLocator(
        { repo_id: "r", commit_sha: c1, path: decomposed },
        { max_range_lines: 400 },
      );
      expect(checked.ok).toBe(true);
      if (checked.ok) expect(checked.locator.path).toBe("docs/caf\u00e9.md");
    });
  });

  describe("git is sandboxed", () => {
    test("argv is git + fixed flags, user values only after `--` or as full SHAs", () => {
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.argv[0]).toBe("git");
        expect(call.argv.slice(1, 3)).toEqual([
          "--no-replace-objects",
          "--literal-pathspecs",
        ]);
        const dash = call.argv.indexOf("--");
        const positional = call.argv.slice(3).filter((arg, i, all) => {
          if (dash >= 0 && i + 3 > dash) return false;
          return !arg.startsWith("-") && i > 0 && all[0] !== arg;
        });
        for (const arg of positional)
          expect(arg).toMatch(/^([a-f0-9]{40}(\^\{commit\})?|blob|-s)$/);
      }
      const lsTree = calls.find(
        (call) => call.argv.includes("ls-tree") && call.argv.includes("--"),
      );
      expect(lsTree).toBeDefined();
      if (lsTree) {
        const dash = lsTree.argv.indexOf("--");
        expect(lsTree.argv.slice(dash + 1)).toHaveLength(1);
      }
    });

    test("environment is the allowlist only: no proxy, credential or GIT_* overrides", () => {
      for (const call of calls) {
        expect(Object.keys(call.env).sort()).toEqual(
          [
            "GIT_CONFIG_GLOBAL",
            "GIT_CONFIG_NOSYSTEM",
            "GIT_OPTIONAL_LOCKS",
            "GIT_PAGER",
            "GIT_TERMINAL_PROMPT",
            "HOME",
            "LC_ALL",
            "NO_COLOR",
            "PATH",
            "XDG_CONFIG_HOME",
          ].sort(),
        );
        expect(call.env.HOME).toBe(homeDir);
        expect(call.env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
        expect(call.env.GIT_CONFIG_NOSYSTEM).toBe("1");
        expect(call.env.GIT_TERMINAL_PROMPT).toBe("0");
        expect(call.env.LC_ALL).toBe("C");
        for (const key of Object.keys(call.env)) {
          expect(key.toLowerCase()).not.toContain("proxy");
          expect(key).not.toMatch(
            /^GIT_(ASKPASS|SSH|CONFIG_(PARAMETERS|COUNT|KEY|VALUE)|DIR|WORK_TREE|INDEX|ALTERNATE|NAMESPACE|TRACE)/,
          );
        }
        expect(call.env.SSH_AUTH_SOCK).toBeUndefined();
        expect(call.env.GITHUB_TOKEN).toBeUndefined();
        expect(
          call.cwd === repoDir ||
            call.cwd === bareDir ||
            call.cwd === homeDir ||
            call.cwd.startsWith(root),
        ).toBe(true);
      }
    });

    test("timeouts produce `error`, not a hang", async () => {
      const slow: GitSpawn = (_argv, options) =>
        Bun.spawn([process.execPath, "-e", "await Bun.sleep(30000)"], {
          cwd: options.cwd,
          env: { PATH: options.env.PATH ?? "" },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });
      const slowRegistry = createRepoRegistry({
        git: createGitRunner({ spawn, homeDir, processEnv: POISONED_ENV }),
      });
      await slowRegistry.register({
        repo_id: "main-repo",
        dir: repoDir,
        label: "Main",
      });
      const hanging = createRepoRegistry({
        git: createGitRunner({ spawn: slow, homeDir, versionTimeoutMs: 300 }),
      });
      // Registration itself must fail fast when git hangs.
      const started = Date.now();
      let registrationError: unknown;
      try {
        await createRepoRegistry({
          git: createGitRunner({ spawn: slow, homeDir }),
          probeTimeoutMs: 300,
        }).register({ repo_id: "x", dir: repoDir, label: "x" });
      } catch (error) {
        registrationError = error;
      }
      expect(registrationError).toBeInstanceOf(RepoRegistrationFailed);
      expect(Date.now() - started).toBeLessThan(5000);

      // Resolution against a registry whose git hangs.
      const hangingWithRepo = {
        ...hanging,
        lookup: slowRegistry.lookup.bind(slowRegistry),
        has: slowRegistry.has.bind(slowRegistry),
        list: slowRegistry.list.bind(slowRegistry),
      };
      const begin = Date.now();
      const result = await resolveReference(
        hangingWithRepo,
        locate("src/app.ts", c1),
        { timeout_ms: 300 },
      );
      expect(result).toEqual({
        state: "error",
        repo_id: "main-repo",
        commit_sha: c1,
        path: "src/app.ts",
        git_version: null,
        reason: "timeout",
      });
      expect(Date.now() - begin).toBeLessThan(5000);
      results.push(result);
      const search = await searchPaths(
        hangingWithRepo,
        { repo_id: "main-repo", commit_sha: c1, query: "app" },
        { timeout_ms: 300 },
      );
      expect(search).toMatchObject({ state: "error", reason: "timeout" });
    });

    test("a missing git binary is `error: git_unavailable`", async () => {
      const broken = createRepoRegistry({
        git: createGitRunner({
          command: [join(root, "no-such-git")],
          homeDir,
        }),
      });
      let error: unknown;
      try {
        await broken.register({ repo_id: "x", dir: repoDir, label: "x" });
      } catch (caught) {
        error = caught;
      }
      expect((error as RepoRegistrationFailed).code).toBe("git_unavailable");
    });
  });

  describe("searchPaths", () => {
    const search = async (
      input: Parameters<typeof searchPaths>[1],
      limits: Parameters<typeof searchPaths>[2] = {},
    ) => {
      const result = await searchPaths(registry, input, limits);
      SearchPathsResultSchema.parse(result);
      results.push(result);
      return result;
    };

    test("ranks file-name matches first, case-insensitively", async () => {
      const result = await search({
        repo_id: "main-repo",
        commit_sha: c1,
        query: "APP",
      });
      expect(result).toMatchObject({ state: "ok", truncated: false });
      if (result.state === "ok") {
        expect(result.matches[0]).toEqual({ path: "src/app.ts", rank: 1 });
        expect(result.scanned).toBeGreaterThan(30);
        expect(result.git_version).toMatch(/^\d+\.\d+/);
      }
      const exact = await search({
        repo_id: "main-repo",
        commit_sha: c1,
        query: "readme.md",
      });
      if (exact.state === "ok")
        expect(exact.matches[0]).toEqual({
          path: "docs/nested/readme.md",
          rank: 0,
        });
      const prefix = await search({
        repo_id: "main-repo",
        commit_sha: c1,
        query: "tree/f0",
        limit: 3,
      });
      if (prefix.state === "ok") {
        expect(prefix.matches.map((m) => m.path)).toEqual([
          "tree/f00.txt",
          "tree/f01.txt",
          "tree/f02.txt",
        ]);
        expect(prefix.matches.every((m) => m.rank === 2)).toBe(true);
      }
    });

    test("sees the tree at the requested commit", async () => {
      const atC1 = await search({
        repo_id: "main-repo",
        commit_sha: c1,
        query: "renamed",
      });
      const atC2 = await search({
        repo_id: "main-repo",
        commit_sha: c2,
        query: "renamed",
      });
      if (atC1.state === "ok")
        expect(atC1.matches.map((m) => m.path)).toEqual(["renamed-old.txt"]);
      if (atC2.state === "ok")
        expect(atC2.matches.map((m) => m.path)).toEqual(["renamed-new.txt"]);
    });

    test("stops after max_entries and reports truncation", async () => {
      const result = await search(
        { repo_id: "main-repo", commit_sha: c1, query: "txt" },
        { max_entries: 5 },
      );
      expect(result).toMatchObject({
        state: "ok",
        truncated: true,
        scanned: 5,
      });
    });

    test("invalid, unknown and unavailable inputs", async () => {
      const before = calls.length;
      expect(
        await search({
          repo_id: "main-repo",
          commit_sha: c1,
          query: "a\u200bb",
        }),
      ).toEqual({
        state: "invalid",
        reason: "invalid_query",
      });
      expect(
        await search({ repo_id: "main-repo", commit_sha: c1, query: "   " }),
      ).toEqual({
        state: "invalid",
        reason: "invalid_query",
      });
      expect(
        await search({
          repo_id: "main-repo",
          commit_sha: "HEAD",
          query: "app",
        }),
      ).toEqual({
        state: "invalid",
        reason: "invalid_commit_sha",
      });
      expect(
        await search({
          repo_id: "main-repo",
          commit_sha: c1,
          query: "app",
          limit: 101,
        }),
      ).toEqual({
        state: "invalid",
        reason: "invalid_input",
      });
      expect(
        await search({ repo_id: "nope", commit_sha: c1, query: "app" }),
      ).toEqual({
        state: "unknown_repo",
        repo_id: "nope",
        commit_sha: c1,
      });
      expect(calls.length).toBe(before);
      expect(
        await search({
          repo_id: "main-repo",
          commit_sha: foreign,
          query: "app",
        }),
      ).toMatchObject({
        state: "unavailable",
      });
    });
  });

  describe("digests", () => {
    test("referenceDigest is stable and range-sensitive", () => {
      const a = {
        repo_id: "r",
        commit_sha: c1,
        path: "src/app.ts",
        line_start: 3,
        line_end: 4,
      };
      const expected = new Bun.CryptoHasher("sha256")
        .update(`r\n${c1}\nsrc/app.ts\n3\n4`)
        .digest("hex");
      expect(referenceDigest(a)).toBe(expected);
      expect(referenceDigest({ ...a })).toBe(expected);
      expect(referenceDigest({ ...a, line_end: 5 })).not.toBe(expected);
      expect(referenceDigest({ ...a, line_start: null, line_end: null })).toBe(
        new Bun.CryptoHasher("sha256")
          .update(`r\n${c1}\nsrc/app.ts\n\n`)
          .digest("hex"),
      );
      expect(isSameReference(a, { ...a })).toBe(true);
      expect(isSameReference(a, { ...a, commit_sha: c2 })).toBe(false);
    });
  });

  test("no result or error string carries the repository directory", () => {
    expect(results.length).toBeGreaterThan(20);
    const serialized = JSON.stringify(results);
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain(tmpdir());
  });
});
