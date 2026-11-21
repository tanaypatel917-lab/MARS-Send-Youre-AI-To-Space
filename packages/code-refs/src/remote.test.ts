import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepoRegistry } from "./registry";
import { createRemoteRepoMirror } from "./remote";
import { resolveReference } from "./resolve";
import { searchPaths } from "./search";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mars-code-refs-remote-"));
  dirs.push(dir);
  return dir;
}

function runGit(cwd: string, args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  if (proc.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${new TextDecoder().decode(proc.stderr)}`,
    );
  }
  return new TextDecoder().decode(proc.stdout).trim();
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("remote Git repository acquisition and pinned-commit resolution", () => {
  test("clones bare mirror, resolves pinned commits, and fetches newer commits on demand", async () => {
    const root = tempDir();
    const upstreamWork = join(root, "upstream-work");
    const upstreamBare = join(root, "upstream.git");
    const cacheDir = join(root, "cache");

    runGit(root, ["init", "--bare", upstreamBare]);
    runGit(root, ["clone", upstreamBare, upstreamWork]);
    writeFileSync(
      join(upstreamWork, "hello.ts"),
      'export function greet(name: string) {\n  return "hello " + name;\n}\n',
    );
    runGit(upstreamWork, ["add", "hello.ts"]);
    runGit(upstreamWork, ["commit", "-m", "initial"]);
    const c1 = runGit(upstreamWork, ["rev-parse", "HEAD"]);
    runGit(upstreamWork, ["push", "origin", "HEAD"]);

    const registry = createRepoRegistry();
    const remote = createRemoteRepoMirror({
      cacheDir,
      registry,
      allowLocalFileUrl: true,
    });

    await remote.registerRemote({
      repo_id: "repo_remote",
      label: "Remote Demo",
      url: `file://${upstreamBare}`,
    });

    // Resolve c1 from bare mirror
    const r1 = await resolveReference(registry, {
      repo_id: "repo_remote",
      commit_sha: c1,
      path: "hello.ts",
      line_start: 1,
      line_end: 3,
    });
    expect(r1.state).toBe("ok");
    if (r1.state === "ok") {
      expect(r1.text).toContain('"hello " + name');
    }

    // Push a second commit c2 to upstream AFTER the mirror was cloned
    writeFileSync(
      join(upstreamWork, "hello.ts"),
      'export function greet(name: string) {\n  return "hi " + name + "!";\n}\n',
    );
    writeFileSync(join(upstreamWork, "added.ts"), "export const v = 2;\n");
    runGit(upstreamWork, ["add", "hello.ts", "added.ts"]);
    runGit(upstreamWork, ["commit", "-m", "second"]);
    const c2 = runGit(upstreamWork, ["rev-parse", "HEAD"]);
    runGit(upstreamWork, ["push", "origin", "HEAD"]);

    // Resolving c2 triggers on-demand fetch via ensureCommit
    const r2 = await resolveReference(registry, {
      repo_id: "repo_remote",
      commit_sha: c2,
      path: "added.ts",
    });
    expect(r2.state).toBe("ok");
    if (r2.state === "ok") {
      expect(r2.text).toBe("export const v = 2;");
    }

    // Old pinned commit c1 still resolves identically
    const r1Again = await resolveReference(registry, {
      repo_id: "repo_remote",
      commit_sha: c1,
      path: "hello.ts",
      line_start: 2,
      line_end: 2,
    });
    expect(r1Again.state).toBe("ok");
    if (r1Again.state === "ok") {
      expect(r1Again.text).toBe('  return "hello " + name;');
    }

    // Path search works at c2
    const search = await searchPaths(registry, {
      repo_id: "repo_remote",
      commit_sha: c2,
      query: "added",
    });
    expect(search.state).toBe("ok");
    if (search.state === "ok") {
      expect(search.matches.map((m) => m.path)).toContain("added.ts");
    }
  });

  test("rejects unsafe protocols and option-like URLs", async () => {
    const root = tempDir();
    const registry = createRepoRegistry();
    const remote = createRemoteRepoMirror({
      cacheDir: join(root, "cache"),
      registry,
    });

    await expect(
      remote.registerRemote({
        repo_id: "r1",
        label: "R1",
        url: "file:///etc/passwd",
      }),
    ).rejects.toThrow(/invalid_registration/);

    await expect(
      remote.registerRemote({
        repo_id: "r2",
        label: "R2",
        url: "http://example.com/repo.git",
      }),
    ).rejects.toThrow(/invalid_registration/);

    await expect(
      remote.registerRemote({
        repo_id: "r3",
        label: "R3",
        url: "--upload-pack=evil",
      }),
    ).rejects.toThrow(/invalid_registration/);
  });

  test("isolates cached mirrors when a repo_id is re-registered with a different URL", async () => {
    const root = tempDir();
    const cacheDir = join(root, "cache");
    const repoA = join(root, "a.git");
    const workA = join(root, "work-a");
    const repoB = join(root, "b.git");
    const workB = join(root, "work-b");

    runGit(root, ["init", "--bare", repoA]);
    runGit(root, ["clone", repoA, workA]);
    writeFileSync(join(workA, "secret.ts"), "export const secret = 1;\n");
    runGit(workA, ["add", "."]);
    runGit(workA, ["commit", "-m", "a"]);
    const commitA = runGit(workA, ["rev-parse", "HEAD"]);
    runGit(workA, ["push", "origin", "HEAD"]);

    runGit(root, ["init", "--bare", repoB]);
    runGit(root, ["clone", repoB, workB]);
    writeFileSync(join(workB, "public.ts"), "export const pub = 2;\n");
    runGit(workB, ["add", "."]);
    runGit(workB, ["commit", "-m", "b"]);
    const commitB = runGit(workB, ["rev-parse", "HEAD"]);
    runGit(workB, ["push", "origin", "HEAD"]);

    // First run registers repo_shared -> repoA
    const reg1 = createRepoRegistry();
    const mirror1 = createRemoteRepoMirror({
      cacheDir,
      registry: reg1,
      allowLocalFileUrl: true,
    });
    await mirror1.registerRemote({
      repo_id: "repo_shared",
      label: "Shared",
      url: `file://${repoA}`,
    });

    // Restart registers repo_shared -> repoB; commitA from repoA must not resolve
    const reg2 = createRepoRegistry();
    const mirror2 = createRemoteRepoMirror({
      cacheDir,
      registry: reg2,
      allowLocalFileUrl: true,
    });
    await mirror2.registerRemote({
      repo_id: "repo_shared",
      label: "Shared",
      url: `file://${repoB}`,
    });

    const leaked = await resolveReference(reg2, {
      repo_id: "repo_shared",
      commit_sha: commitA,
      path: "secret.ts",
    });
    expect(leaked.state).not.toBe("ok");

    const ok = await resolveReference(reg2, {
      repo_id: "repo_shared",
      commit_sha: commitB,
      path: "public.ts",
    });
    expect(ok.state).toBe("ok");
  });
});
