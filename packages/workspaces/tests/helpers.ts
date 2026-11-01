import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RequestContext, WorkspaceRef } from "@mars/contracts";
import {
  type CommandApprover,
  createInMemoryArtifactStore,
  createLocalWorkspaceProvider,
  type LocalWorkspaceProvider,
  type SandboxRunner,
  type SandboxRunRequest,
  type SandboxRunResult,
} from "../src";

export const context: RequestContext = {
  schema_version: 1,
  scope: { owner_id: "owner-test", project_id: "project-test" },
  request_id: "request-test",
};

export const budget = {
  max_tokens: 100,
  max_usd: 0,
  max_duration_ms: 5000,
  max_depth: 1,
  max_concurrency: 1,
};

export interface TestFixture {
  base: string;
  sourceRoot: string;
  rootDir: string;
  provider: LocalWorkspaceProvider;
  workspace: WorkspaceRef;
  initialSourceHash: string;
  initialGitStatus: string;
  artifacts: ReturnType<typeof createInMemoryArtifactStore>;
  close(): Promise<void>;
}

export type StubAction = (
  request: SandboxRunRequest,
) => Promise<Partial<SandboxRunResult> | undefined>;

export function createStubRunner(
  action: StubAction = async () => undefined,
): SandboxRunner {
  return {
    isolation: "stub",
    async verify() {},
    async cleanup() {},
    async run(request) {
      const result = (await action(request)) ?? {};
      return {
        exitCode: result.exitCode ?? 0,
        stdout: result.stdout ?? new TextEncoder().encode("stub output\n"),
        stderr: result.stderr ?? new Uint8Array(),
        stdoutTruncated: result.stdoutTruncated ?? false,
        stderrTruncated: result.stderrTruncated ?? false,
        timedOut: result.timedOut ?? false,
        cancelled: result.cancelled ?? false,
      };
    },
  };
}

export async function makeFixture(
  options: {
    git?: boolean;
    runner?: SandboxRunner | false;
    approveCommand?: boolean | CommandApprover;
    limits?: Record<string, number>;
    testHooks?: Parameters<typeof createLocalWorkspaceProvider>[0]["testHooks"];
    artifactStore?: ReturnType<typeof createInMemoryArtifactStore>;
  } = {},
): Promise<TestFixture> {
  const base = await mkdtemp(join(tmpdir(), "mars-workspaces-"));
  const sourceRoot = join(base, "source");
  const rootDir = join(base, "provider");
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(join(sourceRoot, "tracked.txt"), "baseline tracked\n");
  await writeFile(join(sourceRoot, "untracked.txt"), "untracked source\n");
  await writeFile(join(sourceRoot, "run.sh"), "#!/bin/sh\necho ok\n", {
    mode: 0o755,
  });
  await chmod(join(sourceRoot, "run.sh"), 0o755);
  await writeFile(
    join(sourceRoot, "binary.dat"),
    new Uint8Array([0, 1, 255, 3]),
  );
  await writeFile(join(sourceRoot, ".env"), "DUMMY=not-a-secret\n");
  await writeFile(join(sourceRoot, ".ENV"), "DUMMY=not-a-secret\n");
  await writeFile(join(sourceRoot, ".ENV.EXAMPLE"), "DUMMY=example\n");
  await writeFile(join(sourceRoot, "ID_RSA"), "dummy private key\n");
  await mkdir(join(sourceRoot, ".ssh"), { recursive: true });
  await writeFile(
    join(sourceRoot, ".ssh", "id_ed25519"),
    "dummy private key\n",
  );
  await mkdir(join(sourceRoot, ".SSH"), { recursive: true });
  await writeFile(join(sourceRoot, ".SSH", "ID_RSA"), "dummy private key\n");
  await mkdir(join(sourceRoot, ".config", "gcloud"), { recursive: true });
  await writeFile(
    join(sourceRoot, ".config", "gcloud", "credentials.json"),
    "dummy credentials\n",
  );
  await mkdir(join(sourceRoot, "node_modules", "dep"), { recursive: true });
  await writeFile(
    join(sourceRoot, "node_modules", "dep", "index.js"),
    "ignored\n",
  );
  await mkdir(join(sourceRoot, "nested", ".git"), { recursive: true });
  await writeFile(join(sourceRoot, "nested", ".git", "config"), "ignored\n");
  await mkdir(join(sourceRoot, "Node_Modules", "dep"), { recursive: true });
  await writeFile(
    join(sourceRoot, "Node_Modules", "dep", "index.js"),
    "ignored\n",
  );
  const sibling = join(base, "sibling");
  await mkdir(sibling);
  await writeFile(join(sibling, "neighbor.txt"), "outside\n");
  await symlink("/etc/passwd", join(sourceRoot, "passwd-link"));
  await symlink(sibling, join(sourceRoot, "sibling-link"));

  if (options.git !== false) {
    await rm(join(sourceRoot, "untracked.txt"));
    const gitInit = await Bun.spawn(["git", "init", "--quiet", sourceRoot], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    if ((await gitInit.exited) !== 0)
      throw new Error("git init failed for fixture");
    await writeFile(join(sourceRoot, "tracked.txt"), "committed tracked\n");
    const commit = await Bun.spawn(
      [
        "git",
        "-C",
        sourceRoot,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "add",
        "-A",
      ],
      { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
    );
    if ((await commit.exited) !== 0) {
      const stderr = await new Response(commit.stderr).text();
      throw new Error(`git add failed for fixture: ${stderr}`);
    }
    const gitCommit = await Bun.spawn(
      [
        "git",
        "-C",
        sourceRoot,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "fixture",
      ],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    );
    if ((await gitCommit.exited) !== 0)
      throw new Error("git commit failed for fixture");
    await writeFile(join(sourceRoot, "tracked.txt"), "dirty tracked\n");
    await writeFile(join(sourceRoot, "untracked.txt"), "untracked source\n");
  }
  const initialGitStatus =
    options.git === false ? "" : await gitStatus(sourceRoot);
  const initialSourceHash = await hashDirectory(sourceRoot);
  const artifacts = options.artifactStore ?? createInMemoryArtifactStore();
  let provider: LocalWorkspaceProvider | undefined;
  let workspace: WorkspaceRef;
  const sandbox =
    options.runner === false
      ? undefined
      : (options.runner ?? createStubRunner());
  const approveCommand =
    options.approveCommand === false
      ? undefined
      : typeof options.approveCommand === "function"
        ? options.approveCommand
        : () => true;
  try {
    provider = await createLocalWorkspaceProvider({
      rootDir,
      sourceRoot,
      artifacts,
      ...(sandbox ? { sandbox } : {}),
      ...(approveCommand ? { approveCommand } : {}),
      ...(options.limits ? { limits: options.limits } : {}),
      ...(options.testHooks ? { testHooks: options.testHooks } : {}),
    });
    workspace = await provider.prepare(context, "task-test");
  } catch (error) {
    await provider?.close();
    await rm(base, { recursive: true, force: true });
    throw error;
  }
  let closed = false;
  return {
    base,
    sourceRoot,
    rootDir,
    provider,
    workspace,
    initialSourceHash,
    initialGitStatus,
    artifacts,
    async close() {
      if (!closed) {
        closed = true;
        await provider.close();
      }
      await rm(base, { recursive: true, force: true });
    },
  };
}

export async function gitStatus(sourceRoot: string): Promise<string> {
  const child = Bun.spawn(
    ["git", "-C", sourceRoot, "status", "--porcelain=v1"],
    {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    },
  );
  const output = await new Response(child.stdout).text();
  if ((await child.exited) !== 0)
    throw new Error("git status failed for fixture");
  return output;
}

export async function hashDirectory(root: string): Promise<string> {
  const hash = createHash("sha256");
  const walk = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      const info = await lstat(path);
      hash.update(`${name}\0${info.mode & 0o777}\0`);
      if (info.isSymbolicLink()) {
        hash.update(`L\0${await readlink(path)}\n`);
      } else if (info.isDirectory()) {
        hash.update("D\n");
        await walk(path, name);
      } else if (info.isFile()) {
        hash.update("F\0");
        hash.update(await readFile(path));
        hash.update("\n");
      } else {
        hash.update("S\n");
      }
    }
  };
  await walk(root, "");
  return hash.digest("hex");
}

export function first<T>(values: readonly T[]): T {
  const value = values[0];
  if (value === undefined) throw new Error("Expected at least one value");
  return value;
}

export async function artifactText(
  artifacts: ReturnType<typeof createInMemoryArtifactStore>,
  artifact: Parameters<typeof artifacts.get>[1],
): Promise<string> {
  return new TextDecoder().decode(await artifacts.get(context, artifact));
}

export async function outputText(
  fixture: TestFixture,
  artifact: Parameters<typeof fixture.artifacts.get>[1],
): Promise<string> {
  return artifactText(fixture.artifacts, artifact);
}

export type { SandboxRunRequest };
