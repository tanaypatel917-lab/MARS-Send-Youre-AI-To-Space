import { expect, test } from "bun:test";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, relative } from "node:path";
import {
  type ArtifactRef,
  buildDockerRunArgs,
  CommandNotApprovedError,
  createDockerSandbox,
  createInMemoryArtifactStore,
  createLocalWorkspaceProvider,
  IntegrityError,
  LimitExceededError,
  ProviderLockedError,
  type RequestContext,
  RevisionConflictError,
  resolveDockerConfig,
  type SandboxRunRequest,
  SandboxUnavailableError,
  WorkspaceModifiedError,
  WorkspaceNotFoundError,
  WorkspacePolicyError,
} from "../src";
import { isIgnored, isSecret } from "../src/paths";
import {
  artifactText,
  budget,
  context,
  createStubRunner,
  first,
  gitStatus,
  hashDirectory,
  makeFixture,
  type StubAction,
} from "./helpers";

const digest = "a".repeat(64);

test("path filters compare ignore and secret names case-insensitively", () => {
  expect(isIgnored(".Git")).toBe(true);
  expect(isIgnored("Node_Modules")).toBe(true);
  expect(isSecret(".ENV")).toBe(true);
  expect(isSecret("ID_RSA")).toBe(true);
  expect(isSecret(".SSH/ID_RSA")).toBe(true);
  expect(isSecret(".ENV.EXAMPLE")).toBe(false);
  expect(isSecret(".ENV.SAMPLE")).toBe(false);
  expect(isSecret(".ENV.TEMPLATE")).toBe(false);
});

test("workspacePath is host-only, scoped, and resolves only the real workspace tree [stub runner — not isolation evidence]", async () => {
  const fixture = await makeFixture();
  try {
    const path = await fixture.provider.workspacePath(
      context,
      fixture.workspace,
    );
    expect(path).toBe(
      await realpath(
        join(
          fixture.rootDir,
          "workspaces",
          fixture.workspace.workspace_id,
          "tree",
        ),
      ),
    );
    expect(relative(fixture.sourceRoot, path).startsWith("..")).toBe(true);
    await expect(
      fixture.provider.workspacePath(
        { ...context, scope: { ...context.scope, owner_id: "other-owner" } },
        fixture.workspace,
      ),
    ).rejects.toBeInstanceOf(WorkspaceNotFoundError);
    await expect(
      fixture.provider.workspacePath(context, {
        ...fixture.workspace,
        workspace_id: "ws_00000000000000000000000000000000",
      }),
    ).rejects.toBeInstanceOf(WorkspaceNotFoundError);
  } finally {
    await fixture.close();
  }
});

test("lost workspace trees and corrupt metadata fail closed after provider reopen [stub runner — not isolation evidence]", async () => {
  const fixture = await makeFixture();
  const workspacePath = join(
    fixture.rootDir,
    "workspaces",
    fixture.workspace.workspace_id,
    "tree",
  );
  await fixture.provider.close();
  await rm(workspacePath, { recursive: true, force: true });
  const reopened = await createLocalWorkspaceProvider({
    rootDir: fixture.rootDir,
    sourceRoot: fixture.sourceRoot,
    artifacts: fixture.artifacts,
    sandbox: createStubRunner(),
    approveCommand: () => true,
  });
  try {
    await expect(
      reopened.discover(context, "task-test"),
    ).rejects.toBeInstanceOf(IntegrityError);
    await expect(
      reopened.inspect(context, fixture.workspace.workspace_id),
    ).rejects.toBeInstanceOf(IntegrityError);
    await expect(reopened.prepare(context, "task-test")).rejects.toBeInstanceOf(
      IntegrityError,
    );
    await expect(
      reopened.workspacePath(context, fixture.workspace),
    ).rejects.toBeInstanceOf(IntegrityError);
    await expect(lstat(workspacePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await reopened.close();
    await fixture.close();
  }

  const corrupt = await makeFixture();
  const metadataPath = join(
    corrupt.rootDir,
    "meta",
    corrupt.workspace.workspace_id,
    "workspace.json",
  );
  await corrupt.provider.close();
  await writeFile(metadataPath, "{ invalid json");
  const reopenedCorrupt = await createLocalWorkspaceProvider({
    rootDir: corrupt.rootDir,
    sourceRoot: corrupt.sourceRoot,
    artifacts: corrupt.artifacts,
    sandbox: createStubRunner(),
    approveCommand: () => true,
  });
  try {
    await expect(
      reopenedCorrupt.discover(context, "task-test"),
    ).rejects.toBeInstanceOf(IntegrityError);
    await expect(
      reopenedCorrupt.prepare(context, "task-test"),
    ).rejects.toBeInstanceOf(IntegrityError);
  } finally {
    await reopenedCorrupt.close();
    await corrupt.close();
  }
});

test("lost workspace recovery is isolated and healthy workspaces recover journals and interrupted execution [stub runner — not isolation evidence]", async () => {
  const fixture = await makeFixture();
  const workspaceB = await fixture.provider.prepare(context, "task-second");
  const treeA = join(
    fixture.rootDir,
    "workspaces",
    fixture.workspace.workspace_id,
    "tree",
  );
  const treeB = await fixture.provider.workspacePath(context, workspaceB);
  const metadataPathB = join(
    fixture.rootDir,
    "meta",
    workspaceB.workspace_id,
    "workspace.json",
  );
  let metadataB = JSON.parse(await readFile(metadataPathB, "utf8")) as {
    counter: number;
    revision: string;
    tree_digest: string;
    exec_in_progress?: unknown;
    restore_journal?: unknown;
  };
  const stageName = `${workspaceB.workspace_id}-${"a".repeat(32)}`;
  const backupName = `${workspaceB.workspace_id}-${"b".repeat(32)}`;
  const backupPath = join(fixture.rootDir, "trash", backupName);
  const stagingPath = join(fixture.rootDir, "staging", stageName);
  await mkdir(stagingPath);
  await writeFile(join(treeB, "interrupted.txt"), "recovered output\n");
  await fixture.provider.checkpoint(context, workspaceB);
  metadataB = JSON.parse(
    await readFile(metadataPathB, "utf8"),
  ) as typeof metadataB;
  await rename(treeB, backupPath);
  metadataB.exec_in_progress = {
    run_id: "interrupted-run",
    started_at: new Date().toISOString(),
  };
  metadataB.restore_journal = {
    phase: "backed-up",
    staging: stageName,
    backup: backupName,
    previous: {
      counter: metadataB.counter,
      revision: metadataB.revision,
      tree_digest: metadataB.tree_digest,
    },
    target: {
      counter: metadataB.counter + 1,
      revision: `${metadataB.counter + 1}.${"c".repeat(16)}`,
      tree_digest: "c".repeat(64),
    },
  };
  await writeFile(metadataPathB, `${JSON.stringify(metadataB)}\n`);
  await rm(treeA, { recursive: true, force: true });
  await fixture.provider.close();

  const reopened = await createLocalWorkspaceProvider({
    rootDir: fixture.rootDir,
    sourceRoot: fixture.sourceRoot,
    artifacts: fixture.artifacts,
  });
  try {
    await expect(
      reopened.inspect(context, fixture.workspace.workspace_id),
    ).rejects.toBeInstanceOf(IntegrityError);
    await expect(
      reopened.workspacePath(context, fixture.workspace),
    ).rejects.toBeInstanceOf(IntegrityError);
    await expect(
      reopened.read(context, fixture.workspace, "tracked.txt"),
    ).rejects.toBeInstanceOf(IntegrityError);
    await expect(
      reopened.discover(context, "task-test"),
    ).rejects.toBeInstanceOf(IntegrityError);
    await expect(reopened.prepare(context, "task-test")).rejects.toBeInstanceOf(
      IntegrityError,
    );
    await expect(lstat(treeA)).rejects.toMatchObject({ code: "ENOENT" });

    const healthy = await reopened.inspect(context, workspaceB.workspace_id);
    expect(await reopened.discover(context, "task-second")).toEqual(healthy);
    const healthyTree = await reopened.workspacePath(context, healthy);
    expect(healthyTree).toBe(await realpath(healthyTree));
    const recoveredText = await reopened.read(
      context,
      healthy,
      "interrupted.txt",
    );
    expect(await artifactText(fixture.artifacts, recoveredText)).toBe(
      "recovered output\n",
    );
    const recoveredMeta = JSON.parse(await readFile(metadataPathB, "utf8")) as {
      counter: number;
      exec_in_progress?: unknown;
      restore_journal?: unknown;
    };
    expect(recoveredMeta.counter).toBeGreaterThan(metadataB.counter);
    expect(recoveredMeta.exec_in_progress).toBeUndefined();
    expect(recoveredMeta.restore_journal).toBeUndefined();
    expect(await readdir(join(fixture.rootDir, "staging"))).toEqual([]);
    expect(await readdir(join(fixture.rootDir, "trash"))).toEqual([]);

    const firstValue = await putText(fixture, "checkpoint value\n");
    await reopened.write(context, healthy, "after.txt", firstValue);
    const afterWrite = await reopened.inspect(context, healthy.workspace_id);
    const checkpoint = await reopened.checkpoint(context, afterWrite);
    const changedValue = await putText(fixture, "changed value\n");
    await reopened.write(context, afterWrite, "after.txt", changedValue);
    const beforeRestore = await reopened.inspect(context, healthy.workspace_id);
    const restored = await reopened.restore(
      context,
      checkpoint,
      beforeRestore.revision,
    );
    const restoredValue = await reopened.read(context, restored, "after.txt");
    expect(await artifactText(fixture.artifacts, restoredValue)).toBe(
      "checkpoint value\n",
    );
  } finally {
    await reopened.close();
    await fixture.close();
  }
});

test("unreadable metadata isolates id-based operations but blocks prepare and discover [stub runner — not isolation evidence]", async () => {
  const fixture = await makeFixture();
  const workspaceB = await fixture.provider.prepare(context, "task-second");
  const metadataPathA = join(
    fixture.rootDir,
    "meta",
    fixture.workspace.workspace_id,
    "workspace.json",
  );
  await fixture.provider.close();
  await writeFile(metadataPathA, "{ invalid json");
  const reopened = await createLocalWorkspaceProvider({
    rootDir: fixture.rootDir,
    sourceRoot: fixture.sourceRoot,
    artifacts: fixture.artifacts,
  });
  try {
    await expect(
      reopened.inspect(context, fixture.workspace.workspace_id),
    ).rejects.toBeInstanceOf(IntegrityError);
    await expect(
      reopened.workspacePath(context, fixture.workspace),
    ).rejects.toBeInstanceOf(IntegrityError);
    const healthy = await reopened.inspect(context, workspaceB.workspace_id);
    const artifact = await reopened.read(context, healthy, "tracked.txt");
    expect(await artifactText(fixture.artifacts, artifact)).toBe(
      "dirty tracked\n",
    );
    expect(await reopened.workspacePath(context, healthy)).toBe(
      await realpath(
        join(fixture.rootDir, "workspaces", workspaceB.workspace_id, "tree"),
      ),
    );
    await expect(
      reopened.discover(context, "task-second"),
    ).rejects.toBeInstanceOf(IntegrityError);
    await expect(
      reopened.prepare(context, "task-second"),
    ).rejects.toBeInstanceOf(IntegrityError);
    await expect(reopened.prepare(context, "new-task")).rejects.toBeInstanceOf(
      IntegrityError,
    );
  } finally {
    await reopened.close();
    await fixture.close();
  }
});

test("uncommitted prepare metadata without a tree is removed during recovery [stub runner — not isolation evidence]", async () => {
  const fixture = await makeFixture();
  const leftoverId = `ws_${"d".repeat(32)}`;
  const leftoverMetadata = join(fixture.rootDir, "meta", leftoverId);
  await mkdir(leftoverMetadata);
  await fixture.provider.close();
  const reopened = await createLocalWorkspaceProvider({
    rootDir: fixture.rootDir,
    sourceRoot: fixture.sourceRoot,
    artifacts: fixture.artifacts,
  });
  try {
    await expect(lstat(leftoverMetadata)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await reopened.discover(context, "task-test")).toEqual(
      fixture.workspace,
    );
    expect(await reopened.discover(context, "task-new")).toBeNull();
    await expect(reopened.prepare(context, "task-new")).resolves.toMatchObject({
      provider: fixture.workspace.provider,
    });
  } finally {
    await reopened.close();
    await fixture.close();
  }
});

async function putText(
  fixture: Awaited<ReturnType<typeof makeFixture>>,
  text: string,
): Promise<ArtifactRef> {
  return fixture.artifacts.put(
    context,
    new TextEncoder().encode(text),
    "text/plain",
  );
}

async function crashDuringRestore() {
  const fixture = await makeFixture({
    testHooks: {
      restorePhase(phase) {
        if (phase === "swapped") {
          const error = new Error("simulated crash");
          error.name = "SimulatedCrash";
          throw error;
        }
      },
    },
  });
  const workspace = fixture.workspace;
  const baseline = first(
    await fixture.provider.checkpoints(context, workspace),
  );
  const changedValue = await putText(fixture, "pre-restore contents\n");
  await fixture.provider.write(context, workspace, "tracked.txt", changedValue);
  const current = await fixture.provider.inspect(
    context,
    workspace.workspace_id,
  );
  const tree = await fixture.provider.workspacePath(context, current);
  const treeDigest = await hashDirectory(tree);
  await expect(
    fixture.provider.restore(context, baseline, current.revision),
  ).rejects.toMatchObject({ name: "SimulatedCrash" });
  const metadata = JSON.parse(
    await readFile(
      join(fixture.rootDir, "meta", workspace.workspace_id, "workspace.json"),
      "utf8",
    ),
  ) as { restore_journal: { backup: string; staging: string } };
  return {
    fixture,
    workspace,
    tree,
    treeDigest,
    previousRevision: current.revision,
    backupPath: join(fixture.rootDir, "trash", metadata.restore_journal.backup),
    stagingPath: join(
      fixture.rootDir,
      "staging",
      metadata.restore_journal.staging,
    ),
  };
}

test("prepare preserves the source tree and copies only the filtered dirty snapshot [stub runner — not isolation evidence]", async () => {
  let action: StubAction = async () => undefined;
  const runner = createStubRunner((request) => action(request));
  const fixture = await makeFixture({ runner });
  try {
    const again = await fixture.provider.prepare(context, "task-test");
    expect(again.workspace_id).toBe(fixture.workspace.workspace_id);
    expect(await fixture.provider.discover(context, "task-test")).toEqual(
      again,
    );
    expect(
      await artifactText(
        fixture.artifacts,
        await fixture.provider.read(context, again, "tracked.txt"),
      ),
    ).toBe("dirty tracked\n");
    expect(
      await artifactText(
        fixture.artifacts,
        await fixture.provider.read(context, again, "untracked.txt"),
      ),
    ).toBe("untracked source\n");
    expect(
      await artifactText(
        fixture.artifacts,
        await fixture.provider.read(context, again, "run.sh"),
      ),
    ).toContain("echo ok");
    const skipped = await fixture.provider.skipped(context, again);
    expect(skipped).toEqual(
      expect.arrayContaining([
        { path: ".env", reason: "ignored-secret" },
        { path: ".ENV", reason: "ignored-secret" },
        { path: "ID_RSA", reason: "ignored-secret" },
        { path: ".ssh", reason: "ignored-secret" },
        { path: ".SSH", reason: "ignored-secret" },
        { path: ".config/gcloud", reason: "ignored-secret" },
        { path: "passwd-link", reason: "symlink" },
        { path: "sibling-link", reason: "symlink" },
      ]),
    );
    const tree = join(
      fixture.rootDir,
      "workspaces",
      again.workspace_id,
      "tree",
    );
    await expect(readFile(join(tree, ".env"))).rejects.toThrow();
    expect(await readFile(join(tree, ".ENV.EXAMPLE"), "utf8")).toBe(
      "DUMMY=example\n",
    );
    await expect(readFile(join(tree, "ID_RSA"))).rejects.toThrow();
    await expect(readFile(join(tree, ".ssh", "id_ed25519"))).rejects.toThrow();
    await expect(readFile(join(tree, ".SSH", "ID_RSA"))).rejects.toThrow();
    await expect(
      readFile(join(tree, ".config", "gcloud", "credentials.json")),
    ).rejects.toThrow();
    await expect(
      readFile(join(tree, "node_modules", "dep", "index.js")),
    ).rejects.toThrow();
    await expect(
      readFile(join(tree, "Node_Modules", "dep", "index.js")),
    ).rejects.toThrow();
    await expect(readFile(join(tree, ".git", "config"))).rejects.toThrow();
    expect((await lstat(join(tree, "run.sh"))).mode & 0o111).not.toBe(0);

    const baseline = first(await fixture.provider.checkpoints(context, again));
    const result = await fixture.provider.execute(
      context,
      again,
      ["fixture-command"],
      budget,
    );
    expect(result.workspace.revision).not.toBe(again.revision);
    action = async (request) => {
      await writeFile(
        join(request.workspaceDir, "tracked.txt"),
        "changed text",
      );
      await rm(join(request.workspaceDir, "untracked.txt"));
      await chmod(join(request.workspaceDir, "run.sh"), 0o644);
      await mkdir(join(request.workspaceDir, "new", "empty"), {
        recursive: true,
      });
      await writeFile(
        join(request.workspaceDir, "new", "binary.bin"),
        new Uint8Array([0, 255, 1]),
      );
      return { stdout: new TextEncoder().encode("mutated\n") };
    };
    const mutated = await fixture.provider.execute(
      context,
      again,
      ["fixture-command"],
      budget,
    );
    expect(mutated.workspace.revision).not.toBe(result.workspace.revision);
    const difference = await fixture.provider.diff(context, mutated.workspace);
    expect(difference.files.map(({ path, status }) => [path, status])).toEqual([
      ["new/binary.bin", "added"],
      ["run.sh", "modified"],
      ["tracked.txt", "modified"],
      ["untracked.txt", "deleted"],
    ]);
    expect(
      difference.files.find(({ path }) => path === "tracked.txt")?.patch,
    ).toContain("@@");
    expect(
      difference.files.find(({ path }) => path === "tracked.txt")?.patch,
    ).toContain("\\ No newline at end of file");
    expect(
      difference.files.find(({ path }) => path === "new/binary.bin")?.patch,
    ).toContain("Binary files");
    expect(
      difference.files.find(({ path }) => path === "run.sh")?.patch,
    ).toContain("old mode 100755");
    expect(
      difference.files.find(({ path }) => path === "untracked.txt")?.patch,
    ).toContain("/dev/null");
    const collected = await fixture.provider.collect(
      context,
      mutated.workspace,
    );
    expect(collected).toHaveLength(4);
    expect(await artifactText(fixture.artifacts, first(collected))).toContain(
      "diff --git",
    );
    expect(
      new Uint8Array(
        await fixture.artifacts.get(context, first(collected.slice(1))),
      ),
    ).toEqual(new Uint8Array([0, 255, 1]));

    const restored = await fixture.provider.restore(
      context,
      baseline,
      mutated.workspace.revision,
    );
    expect(
      await artifactText(
        fixture.artifacts,
        await fixture.provider.read(context, restored, "tracked.txt"),
      ),
    ).toBe("dirty tracked\n");
    expect(
      await artifactText(
        fixture.artifacts,
        await fixture.provider.read(context, restored, "untracked.txt"),
      ),
    ).toBe("untracked source\n");
    expect((await lstat(join(tree, "run.sh"))).mode & 0o111).not.toBe(0);
    await expect(readFile(join(tree, "new", "binary.bin"))).rejects.toThrow();
    expect(await readdir(join(tree, "new")).catch(() => [])).toEqual([]);
    expect(
      (await fixture.provider.diff(context, restored, { base: baseline }))
        .files,
    ).toEqual([]);
    expect(await gitStatus(fixture.sourceRoot)).toBe(fixture.initialGitStatus);
    expect(await hashDirectory(fixture.sourceRoot)).toBe(
      fixture.initialSourceHash,
    );
  } finally {
    await fixture.close();
  }
});

test("text diff patches apply to a baseline and reproduce file contents and modes [stub runner — not isolation evidence]", async () => {
  const fixture = await makeFixture();
  try {
    const tree = await fixture.provider.workspacePath(
      context,
      fixture.workspace,
    );
    await writeFile(
      join(tree, "middle.txt"),
      "line one\nline two\nline three\nline four\nline five\n",
    );
    await writeFile(join(tree, "deleted.txt"), "delete me\n");
    await writeFile(join(tree, "mode.sh"), "echo mode\n", { mode: 0o644 });
    await writeFile(join(tree, "no-newline.txt"), "old without newline");
    await writeFile(join(tree, "gain-newline.txt"), "gain newline");
    await writeFile(join(tree, "lose-newline.txt"), "lose newline\n");

    const baselineCheckpoint = await fixture.provider.checkpoint(
      context,
      fixture.workspace,
    );
    const baselineWorkspace = await fixture.provider.inspect(
      context,
      fixture.workspace.workspace_id,
    );
    const baselineCopyParent = await mkdtemp(
      join(fixture.base, "apply-baseline-"),
    );
    const baselineCopy = join(baselineCopyParent, "tree");
    await cp(tree, baselineCopy, { recursive: true });

    await writeFile(
      join(tree, "middle.txt"),
      "line one\nline two\nchanged middle\nline four\nline five\n",
    );
    await mkdir(join(tree, "new-dir"), { recursive: true });
    await writeFile(join(tree, "new-dir", "added.txt"), "new file\n");
    await rm(join(tree, "deleted.txt"));
    await chmod(join(tree, "mode.sh"), 0o755);
    await writeFile(join(tree, "no-newline.txt"), "new without newline");
    await writeFile(join(tree, "gain-newline.txt"), "gain newline\n");
    await writeFile(join(tree, "lose-newline.txt"), "lose newline");

    const difference = await fixture.provider.diff(context, baselineWorkspace, {
      base: baselineCheckpoint,
    });
    const patch = difference.files.map((file) => file.patch).join("");
    expect(patch).not.toContain("Binary files");
    const patchPath = join(fixture.base, "workspace.patch");
    await writeFile(patchPath, patch);
    const apply = Bun.spawn(
      ["git", "apply", "-p1", "--whitespace=nowarn", patchPath],
      {
        cwd: baselineCopy,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      apply.exited,
      new Response(apply.stdout).text(),
      new Response(apply.stderr).text(),
    ]);
    if (exitCode !== 0)
      throw new Error(`git apply failed: ${stdout}\n${stderr}`);

    const collectFiles = async (
      root: string,
      directory = root,
      files = new Map<string, { data: Buffer; executable: boolean }>(),
    ): Promise<Map<string, { data: Buffer; executable: boolean }>> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          await collectFiles(root, path, files);
        } else if (entry.isFile()) {
          const info = await lstat(path);
          files.set(relative(root, path), {
            data: await readFile(path),
            executable: (info.mode & 0o111) !== 0,
          });
        }
      }
      return files;
    };
    const appliedFiles = await collectFiles(baselineCopy);
    const workspaceFiles = await collectFiles(tree);
    expect([...appliedFiles.keys()].sort()).toEqual(
      [...workspaceFiles.keys()].sort(),
    );
    for (const [path, expected] of workspaceFiles) {
      const applied = appliedFiles.get(path);
      if (!applied) throw new Error(`Applied file is missing: ${path}`);
      expect(applied.data.equals(expected.data)).toBe(true);
      expect(applied.executable).toBe(expected.executable);
    }
  } finally {
    await fixture.close();
  }
});

test("prepare rejects overlapping roots and enforces source limits before creating a workspace [stub runner — not isolation evidence]", async () => {
  const base = await mkdtemp(join(Bun.env.TMPDIR ?? "/tmp", "mars-ws-policy-"));
  const sourceRoot = join(base, "source");
  const rootDir = join(base, "provider");
  await mkdir(sourceRoot);
  await writeFile(join(sourceRoot, "one"), "one");
  await writeFile(join(sourceRoot, "two"), "two");
  try {
    await expect(
      createLocalWorkspaceProvider({
        sourceRoot,
        rootDir: join(sourceRoot, "provider"),
        artifacts: createInMemoryArtifactStore(),
      }),
    ).rejects.toBeInstanceOf(WorkspacePolicyError);
    await expect(readdir(join(sourceRoot, "provider"))).rejects.toThrow();
    await expect(
      createLocalWorkspaceProvider({
        sourceRoot,
        rootDir: base,
        artifacts: createInMemoryArtifactStore(),
      }),
    ).rejects.toBeInstanceOf(WorkspacePolicyError);
    await expect(
      createLocalWorkspaceProvider({
        sourceRoot,
        rootDir: join(base, "unsafe,name"),
        artifacts: createInMemoryArtifactStore(),
      }),
    ).rejects.toBeInstanceOf(WorkspacePolicyError);

    const provider = await createLocalWorkspaceProvider({
      sourceRoot,
      rootDir,
      artifacts: createInMemoryArtifactStore(),
      limits: { maxFiles: 1 },
    });
    await expect(
      provider.prepare(context, "limit-task"),
    ).rejects.toBeInstanceOf(LimitExceededError);
    expect(await readdir(join(rootDir, "workspaces"))).toEqual([]);
    await provider.close();
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("scope, workspace ids, checkpoint ownership, and relative paths fail closed [stub runner — not isolation evidence]", async () => {
  const fixture = await makeFixture();
  try {
    const workspace = fixture.workspace;
    const wrongScope = {
      ...context,
      scope: { owner_id: "someone-else", project_id: "project-test" },
    };
    await expect(
      fixture.provider.read(wrongScope, workspace, "tracked.txt"),
    ).rejects.toBeInstanceOf(WorkspaceNotFoundError);
    await expect(
      fixture.provider.read(
        context,
        { ...workspace, workspace_id: "../x" },
        "tracked.txt",
      ),
    ).rejects.toBeInstanceOf(WorkspaceNotFoundError);
    await expect(
      fixture.provider.read(
        context,
        { ...workspace, provider: "other" },
        "tracked.txt",
      ),
    ).rejects.toBeInstanceOf(WorkspaceNotFoundError);
    await expect(
      fixture.provider.read(
        context,
        {
          ...workspace,
          workspace_id: "ws_00000000000000000000000000000000",
        },
        "tracked.txt",
      ),
    ).rejects.toBeInstanceOf(WorkspaceNotFoundError);
    const scoped = {
      ...context,
      scope: {
        ...context.scope,
        workspace_id: "ws_00000000000000000000000000000000",
      },
    };
    expect(await fixture.provider.discover(scoped, "task-test")).toBeNull();
    await expect(
      fixture.provider.prepare(scoped, "task-test"),
    ).rejects.toBeInstanceOf(WorkspaceNotFoundError);
    const checkpoint = first(
      await fixture.provider.checkpoints(context, workspace),
    );
    const second = await fixture.provider.prepare(context, "second-task");
    const substituted = { ...checkpoint, workspace: second };
    await expect(
      fixture.provider.restore(context, substituted, second.revision),
    ).rejects.toBeInstanceOf(WorkspaceNotFoundError);

    const artifact = await putText(fixture, "content");
    for (const invalid of [
      "../x",
      "/etc/passwd",
      "a/../../x",
      "a\\b",
      "line\nbreak",
      "",
      "a//b",
      "bad\0path",
      ".git/config",
      ".env",
      "sub/.ssh/id_rsa",
      "node_modules/x",
      "a".repeat(1025),
      Array.from({ length: 65 }, () => "x").join("/"),
    ]) {
      await expect(
        fixture.provider.read(context, workspace, invalid),
      ).rejects.toBeInstanceOf(WorkspacePolicyError);
      await expect(
        fixture.provider.write(context, workspace, invalid, artifact),
      ).rejects.toBeInstanceOf(WorkspacePolicyError);
    }
  } finally {
    await fixture.close();
  }
});

test("host-side resolution rejects workspace symlinks and restored trees remove them [stub runner — not isolation evidence]", async () => {
  let mutate = false;
  const runner = createStubRunner(async (request) => {
    if (mutate) {
      await mkdir(join(request.workspaceDir, "d"), { recursive: true });
      await symlink("/etc", join(request.workspaceDir, "d-link"));
      await symlink("/etc/passwd", join(request.workspaceDir, "leak"));
    }
    return {};
  });
  const fixture = await makeFixture({ runner });
  try {
    const baseline = first(
      await fixture.provider.checkpoints(context, fixture.workspace),
    );
    mutate = true;
    const executed = await fixture.provider.execute(
      context,
      fixture.workspace,
      ["create-links"],
      budget,
    );
    await expect(
      fixture.provider.read(context, executed.workspace, "leak"),
    ).rejects.toBeInstanceOf(WorkspacePolicyError);
    await expect(
      fixture.provider.read(context, executed.workspace, "d-link/passwd"),
    ).rejects.toBeInstanceOf(WorkspacePolicyError);
    const restored = await fixture.provider.restore(
      context,
      baseline,
      executed.workspace.revision,
    );
    const tree = join(
      fixture.rootDir,
      "workspaces",
      restored.workspace_id,
      "tree",
    );
    await expect(lstat(join(tree, "leak"))).rejects.toThrow();
    await expect(lstat(join(tree, "d-link"))).rejects.toThrow();
  } finally {
    await fixture.close();
  }
});

test("restore checks revision conflicts and detects out-of-band workspace edits [stub runner — not isolation evidence]", async () => {
  const fixture = await makeFixture();
  try {
    const baseline = first(
      await fixture.provider.checkpoints(context, fixture.workspace),
    );
    await expect(
      fixture.provider.restore(context, baseline, "stale.revision"),
    ).rejects.toBeInstanceOf(RevisionConflictError);
    const tree = join(
      fixture.rootDir,
      "workspaces",
      fixture.workspace.workspace_id,
      "tree",
    );
    await writeFile(join(tree, "tracked.txt"), "external edit\n");
    await expect(
      fixture.provider.restore(context, baseline, fixture.workspace.revision),
    ).rejects.toBeInstanceOf(WorkspaceModifiedError);
  } finally {
    await fixture.close();
  }
});

test("failed artifact retrieval leaves the tree and revision untouched [stub runner — not isolation evidence]", async () => {
  const backing = createInMemoryArtifactStore();
  let failOnGet = -1;
  let getCount = 0;
  const artifacts = {
    put: backing.put.bind(backing),
    async get(ctx: RequestContext, ref: ArtifactRef) {
      getCount += 1;
      if (getCount === failOnGet)
        throw new Error("simulated blob retrieval failure");
      return backing.get(ctx, ref);
    },
  };
  const fixture = await makeFixture({ artifactStore: artifacts });
  try {
    const baseline = first(
      await fixture.provider.checkpoints(context, fixture.workspace),
    );
    const updated = await fixture.provider.execute(
      context,
      fixture.workspace,
      ["no-op"],
      budget,
    );
    const tree = join(
      fixture.rootDir,
      "workspaces",
      updated.workspace.workspace_id,
      "tree",
    );
    const before = await hashDirectory(tree);
    getCount = 0;
    failOnGet = 3;
    await expect(
      fixture.provider.restore(context, baseline, updated.workspace.revision),
    ).rejects.toBeInstanceOf(IntegrityError);
    expect(await hashDirectory(tree)).toBe(before);
    expect(
      (await fixture.provider.inspect(context, updated.workspace.workspace_id))
        .revision,
    ).toBe(updated.workspace.revision);
    expect(await readdir(join(fixture.rootDir, "staging"))).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test("write verifies artifacts, preserves executable mode, and updates diff and revision [stub runner — not isolation evidence]", async () => {
  const fixture = await makeFixture();
  try {
    const before = fixture.workspace;
    const baseline = first(await fixture.provider.checkpoints(context, before));
    const artifact = await putText(fixture, "written file\n");
    await fixture.provider.write(
      context,
      before,
      "nested/result.txt",
      artifact,
      { executable: true },
    );
    const inspected = await fixture.provider.inspect(
      context,
      before.workspace_id,
    );
    expect(inspected.revision).not.toBe(before.revision);
    const tree = join(
      fixture.rootDir,
      "workspaces",
      before.workspace_id,
      "tree",
    );
    expect(await readFile(join(tree, "nested", "result.txt"), "utf8")).toBe(
      "written file\n",
    );
    expect(
      (await lstat(join(tree, "nested", "result.txt"))).mode & 0o111,
    ).not.toBe(0);
    expect(
      (await fixture.provider.diff(context, inspected, { base: baseline }))
        .files,
    ).toContainEqual(
      expect.objectContaining({ path: "nested/result.txt", status: "added" }),
    );

    await expect(
      fixture.provider.write(context, inspected, "nested/corrupt.txt", {
        ...artifact,
        sha256: "0".repeat(64),
      }),
    ).rejects.toBeInstanceOf(IntegrityError);
    await expect(lstat(join(tree, "nested", "corrupt.txt"))).rejects.toThrow();
  } finally {
    await fixture.close();
  }
});

test("restore rejects forged checkpoint paths, modes, and duplicate entries before mutation [stub runner — not isolation evidence]", async () => {
  const fixture = await makeFixture();
  try {
    const checkpoint = first(
      await fixture.provider.checkpoints(context, fixture.workspace),
    );
    const tree = join(
      fixture.rootDir,
      "workspaces",
      fixture.workspace.workspace_id,
      "tree",
    );
    const before = await hashDirectory(tree);
    const metadataPath = join(
      fixture.rootDir,
      "meta",
      fixture.workspace.workspace_id,
      "workspace.json",
    );
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as {
      checkpoints: Array<{ checkpoint_id: string; artifact: ArtifactRef }>;
    };
    const record = metadata.checkpoints.find(
      (item) => item.checkpoint_id === checkpoint.checkpoint_id,
    );
    if (!record) throw new Error("Checkpoint metadata record is missing");
    const original = JSON.parse(
      new TextDecoder().decode(
        await fixture.artifacts.get(context, checkpoint.artifact),
      ),
    ) as {
      files: Array<{ path: string; mode: number; blob: ArtifactRef }>;
      directories: string[];
    };
    const corruptions = [
      (manifest: typeof original) => {
        first(manifest.files).path = "../escape";
      },
      (manifest: typeof original) => {
        first(manifest.files).mode = 0o4755;
      },
      (manifest: typeof original) => {
        manifest.files.push({ ...first(manifest.files) });
      },
    ];
    for (const corrupt of corruptions) {
      const manifest = JSON.parse(JSON.stringify(original)) as typeof original;
      corrupt(manifest);
      const artifact = await fixture.artifacts.put(
        context,
        new TextEncoder().encode(JSON.stringify(manifest)),
        "application/vnd.mars.workspace-checkpoint+json",
      );
      record.artifact = artifact;
      await writeFile(metadataPath, `${JSON.stringify(metadata)}\n`);
      await expect(
        fixture.provider.restore(
          context,
          { ...checkpoint, artifact },
          fixture.workspace.revision,
        ),
      ).rejects.toBeInstanceOf(IntegrityError);
      expect(await hashDirectory(tree)).toBe(before);
    }
    expect(await readdir(join(fixture.rootDir, "staging"))).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test("restore hook failures roll back while simulated process death recovers on reopen [stub runner — not isolation evidence]", async () => {
  let phase: "swapped" | undefined = "swapped";
  const runner = createStubRunner(async (request) => {
    await writeFile(
      join(request.workspaceDir, "tracked.txt"),
      "pre-restore modified\n",
    );
    return undefined;
  });
  const base = await mkdtemp(
    join(Bun.env.TMPDIR ?? "/tmp", "mars-ws-recovery-"),
  );
  const sourceRoot = join(base, "source");
  const rootDir = join(base, "provider");
  await mkdir(sourceRoot);
  await writeFile(join(sourceRoot, "tracked.txt"), "source\n");
  const artifacts = createInMemoryArtifactStore();
  let provider = await createLocalWorkspaceProvider({
    rootDir,
    sourceRoot,
    artifacts,
    sandbox: runner,
    approveCommand: () => true,
    testHooks: {
      restorePhase(current) {
        if (current === phase) {
          const error = new Error("simulated crash");
          error.name = "SimulatedCrash";
          throw error;
        }
      },
    },
  });
  try {
    const workspace = await provider.prepare(context, "restore-task");
    const baseline = first(await provider.checkpoints(context, workspace));
    const changed = await provider.execute(
      context,
      workspace,
      ["mutate"],
      budget,
    );
    const tree = join(rootDir, "workspaces", workspace.workspace_id, "tree");
    const before = await hashDirectory(tree);
    phase = "swapped";
    await expect(
      provider.restore(context, baseline, changed.workspace.revision),
    ).rejects.toMatchObject({
      name: "SimulatedCrash",
    });
    await provider.close();
    provider = await createLocalWorkspaceProvider({
      rootDir,
      sourceRoot,
      artifacts,
    });
    expect(await hashDirectory(tree)).toBe(before);
    expect(
      (await provider.inspect(context, workspace.workspace_id)).revision,
    ).toBe(changed.workspace.revision);
    expect(await readdir(join(rootDir, "trash"))).toEqual([]);
    expect(await readdir(join(rootDir, "staging"))).toEqual([]);
  } finally {
    await provider.close();
    await rm(base, { recursive: true, force: true });
  }
});

test("ordinary restore hook errors recover in-process [stub runner — not isolation evidence]", async () => {
  const base = await mkdtemp(
    join(Bun.env.TMPDIR ?? "/tmp", "mars-ws-rollback-"),
  );
  const sourceRoot = join(base, "source");
  const rootDir = join(base, "provider");
  await mkdir(sourceRoot);
  await writeFile(join(sourceRoot, "file.txt"), "source\n");
  const artifacts = createInMemoryArtifactStore();
  const provider = await createLocalWorkspaceProvider({
    rootDir,
    sourceRoot,
    artifacts,
    sandbox: createStubRunner(async (request) => {
      await writeFile(join(request.workspaceDir, "file.txt"), "changed\n");
      return undefined;
    }),
    approveCommand: () => true,
    testHooks: {
      restorePhase(phase) {
        if (phase === "swapped") throw new Error("hook failure");
      },
    },
  });
  try {
    const workspace = await provider.prepare(context, "rollback-task");
    const baseline = first(await provider.checkpoints(context, workspace));
    const changed = await provider.execute(
      context,
      workspace,
      ["mutate"],
      budget,
    );
    const tree = join(rootDir, "workspaces", workspace.workspace_id, "tree");
    const before = await hashDirectory(tree);
    await expect(
      provider.restore(context, baseline, changed.workspace.revision),
    ).rejects.toThrow("hook failure");
    expect(await hashDirectory(tree)).toBe(before);
    expect(
      (await provider.inspect(context, workspace.workspace_id)).revision,
    ).toBe(changed.workspace.revision);
  } finally {
    await provider.close();
    await rm(base, { recursive: true, force: true });
  }
});

test("failed startup rollback retains A's backup while healthy B recovers and cleans [stub runner — not isolation evidence]", async () => {
  const crashed = await crashDuringRestore();
  const { fixture, workspace, tree, treeDigest, previousRevision, backupPath } =
    crashed;
  const workspaceB = await fixture.provider.prepare(context, "task-second");
  const staleB = join(
    fixture.rootDir,
    "trash",
    `${workspaceB.workspace_id}-stale`,
  );
  await mkdir(staleB);
  await fixture.provider.close();
  const reopened = await createLocalWorkspaceProvider({
    rootDir: fixture.rootDir,
    sourceRoot: fixture.sourceRoot,
    artifacts: fixture.artifacts,
    testHooks: {
      recoveryPhase() {
        throw new Error("injected recovery failure");
      },
    },
  });
  try {
    expect(await hashDirectory(backupPath)).toBe(treeDigest);
    await expect(
      reopened.inspect(context, workspace.workspace_id),
    ).rejects.toBeInstanceOf(IntegrityError);
    await expect(
      reopened.read(context, workspace, "tracked.txt"),
    ).rejects.toBeInstanceOf(IntegrityError);
    const journalMeta = JSON.parse(
      await readFile(
        join(fixture.rootDir, "meta", workspace.workspace_id, "workspace.json"),
        "utf8",
      ),
    ) as { restore_journal?: unknown };
    expect(journalMeta.restore_journal).toBeDefined();
    await expect(lstat(staleB)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (await reopened.inspect(context, workspaceB.workspace_id)).workspace_id,
    ).toBe(workspaceB.workspace_id);
    await reopened.read(context, workspaceB, "tracked.txt");
  } finally {
    await reopened.close();
  }
  const recovered = await createLocalWorkspaceProvider({
    rootDir: fixture.rootDir,
    sourceRoot: fixture.sourceRoot,
    artifacts: fixture.artifacts,
  });
  try {
    expect(await hashDirectory(tree)).toBe(treeDigest);
    expect(
      (await recovered.inspect(context, workspace.workspace_id)).revision,
    ).toBe(previousRevision);
    const metadata = JSON.parse(
      await readFile(
        join(fixture.rootDir, "meta", workspace.workspace_id, "workspace.json"),
        "utf8",
      ),
    ) as { restore_journal?: unknown };
    expect(metadata.restore_journal).toBeUndefined();
    expect(
      (await readdir(join(fixture.rootDir, "trash"))).filter((name) =>
        name.startsWith(workspace.workspace_id),
      ),
    ).toEqual([]);
    expect(
      (await readdir(join(fixture.rootDir, "staging"))).filter((name) =>
        name.startsWith(workspace.workspace_id),
      ),
    ).toEqual([]);
  } finally {
    await recovered.close();
    await fixture.close();
  }
});

test("in-process rollback failure retains journal and backup for later recovery [stub runner — not isolation evidence]", async () => {
  const fixture = await makeFixture({
    testHooks: {
      restorePhase(phase) {
        if (phase === "swapped") throw new Error("restore hook failure");
      },
      recoveryPhase() {
        throw new Error("rollback hook failure");
      },
    },
  });
  try {
    const baseline = first(
      await fixture.provider.checkpoints(context, fixture.workspace),
    );
    const artifact = await putText(fixture, "pre-restore contents\n");
    await fixture.provider.write(
      context,
      fixture.workspace,
      "tracked.txt",
      artifact,
    );
    const changed = await fixture.provider.inspect(
      context,
      fixture.workspace.workspace_id,
    );
    const tree = await fixture.provider.workspacePath(
      context,
      fixture.workspace,
    );
    const digestBefore = await hashDirectory(tree);
    await expect(
      fixture.provider.restore(context, baseline, changed.revision),
    ).rejects.toThrow("rollback hook failure");
    await expect(
      fixture.provider.inspect(context, fixture.workspace.workspace_id),
    ).rejects.toBeInstanceOf(IntegrityError);
    const metadata = JSON.parse(
      await readFile(
        join(
          fixture.rootDir,
          "meta",
          fixture.workspace.workspace_id,
          "workspace.json",
        ),
        "utf8",
      ),
    ) as { restore_journal: { backup: string } };
    const backup = join(
      fixture.rootDir,
      "trash",
      metadata.restore_journal.backup,
    );
    expect(await hashDirectory(backup)).toBe(digestBefore);
    await fixture.provider.close();
    const recovered = await createLocalWorkspaceProvider({
      rootDir: fixture.rootDir,
      sourceRoot: fixture.sourceRoot,
      artifacts: fixture.artifacts,
    });
    try {
      expect(await hashDirectory(tree)).toBe(digestBefore);
      expect(
        (await recovered.inspect(context, fixture.workspace.workspace_id))
          .revision,
      ).toBe(changed.revision);
    } finally {
      await recovered.close();
    }
  } finally {
    await fixture.close();
  }
});

test("unreadable metadata retains recovery entries while true orphans are removed [stub runner — not isolation evidence]", async () => {
  const fixture = await makeFixture();
  const workspaceB = await fixture.provider.prepare(context, "task-second");
  const id = fixture.workspace.workspace_id;
  const trashA = join(fixture.rootDir, "trash", `${id}-x`);
  const stagingA = join(fixture.rootDir, "staging", `${id}-y`);
  const unknownId = `ws_${"e".repeat(32)}`;
  const orphan = join(fixture.rootDir, "trash", `${unknownId}-z`);
  try {
    await Promise.all([mkdir(trashA), mkdir(stagingA), mkdir(orphan)]);
    await writeFile(
      join(fixture.rootDir, "meta", id, "workspace.json"),
      "{bad",
    );
    await fixture.provider.close();
    const reopened = await createLocalWorkspaceProvider({
      rootDir: fixture.rootDir,
      sourceRoot: fixture.sourceRoot,
      artifacts: fixture.artifacts,
    });
    try {
      expect(await readdir(join(fixture.rootDir, "trash"))).toContain(
        `${id}-x`,
      );
      expect(await readdir(join(fixture.rootDir, "staging"))).toContain(
        `${id}-y`,
      );
      await expect(lstat(orphan)).rejects.toMatchObject({ code: "ENOENT" });
      await reopened.read(context, workspaceB, "tracked.txt");
    } finally {
      await reopened.close();
    }
  } finally {
    await fixture.close();
  }
});

test("missing rollback backup and tree retain journal and staging [stub runner — not isolation evidence]", async () => {
  const fixture = await makeFixture();
  try {
    const id = fixture.workspace.workspace_id;
    const metadataPath = join(fixture.rootDir, "meta", id, "workspace.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as {
      counter: number;
      revision: string;
      tree_digest: string;
      restore_journal?: unknown;
    };
    const staging = `${id}-${"a".repeat(32)}`;
    metadata.restore_journal = {
      phase: "backed-up",
      staging,
      backup: `${id}-${"b".repeat(32)}`,
      previous: {
        counter: metadata.counter,
        revision: metadata.revision,
        tree_digest: metadata.tree_digest,
      },
      target: {
        counter: metadata.counter + 1,
        revision: `${metadata.counter + 1}.${"c".repeat(16)}`,
        tree_digest: "c".repeat(64),
      },
    };
    await mkdir(join(fixture.rootDir, "staging", staging));
    await rm(join(fixture.rootDir, "workspaces", id, "tree"), {
      recursive: true,
    });
    await writeFile(metadataPath, JSON.stringify(metadata));
    await fixture.provider.close();
    const reopened = await createLocalWorkspaceProvider({
      rootDir: fixture.rootDir,
      sourceRoot: fixture.sourceRoot,
      artifacts: fixture.artifacts,
    });
    try {
      await expect(reopened.inspect(context, id)).rejects.toBeInstanceOf(
        IntegrityError,
      );
      expect(
        (JSON.parse(await readFile(metadataPath, "utf8")) as typeof metadata)
          .restore_journal,
      ).toBeDefined();
      await expect(
        lstat(join(fixture.rootDir, "staging", staging)),
      ).resolves.toBeDefined();
    } finally {
      await reopened.close();
    }
  } finally {
    await fixture.close();
  }
});

test("tampered rollback backup and aside remain for forensics [stub runner — not isolation evidence]", async () => {
  const crashed = await crashDuringRestore();
  const { fixture, workspace, backupPath } = crashed;
  try {
    await writeFile(join(backupPath, "tracked.txt"), "tampered backup\n");
    await fixture.provider.close();
    await fixture.provider.close();
    const reopened = await createLocalWorkspaceProvider({
      rootDir: fixture.rootDir,
      sourceRoot: fixture.sourceRoot,
      artifacts: fixture.artifacts,
    });
    try {
      await expect(
        reopened.inspect(context, workspace.workspace_id),
      ).rejects.toBeInstanceOf(IntegrityError);
      expect(await lstat(backupPath)).toBeDefined();
      const trash = await readdir(join(fixture.rootDir, "trash"));
      expect(
        trash.some((name) =>
          name.startsWith(`${workspace.workspace_id}-aside-`),
        ),
      ).toBe(true);
      const metadata = JSON.parse(
        await readFile(
          join(
            fixture.rootDir,
            "meta",
            workspace.workspace_id,
            "workspace.json",
          ),
          "utf8",
        ),
      ) as { restore_journal?: unknown };
      expect(metadata.restore_journal).toBeDefined();
    } finally {
      await reopened.close();
    }
  } finally {
    await fixture.close();
  }
});

test("restore journal paths are validated before recovery touches workspace data [stub runner — not isolation evidence]", async () => {
  const fixture = await makeFixture();
  try {
    const metadataPath = join(
      fixture.rootDir,
      "meta",
      fixture.workspace.workspace_id,
      "workspace.json",
    );
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as {
      counter: number;
      revision: string;
      tree_digest: string;
      restore_journal?: unknown;
    };
    metadata.restore_journal = {
      phase: "backed-up",
      staging: "..",
      backup: "..",
      previous: {
        counter: metadata.counter,
        revision: metadata.revision,
        tree_digest: metadata.tree_digest,
      },
      target: {
        counter: metadata.counter + 1,
        revision: `${metadata.counter + 1}.${"b".repeat(16)}`,
        tree_digest: "b".repeat(64),
      },
    };
    await writeFile(metadataPath, `${JSON.stringify(metadata)}\n`);
    const tree = join(
      fixture.rootDir,
      "workspaces",
      fixture.workspace.workspace_id,
      "tree",
    );
    const before = await hashDirectory(tree);
    await fixture.provider.close();
    const reopened = await createLocalWorkspaceProvider({
      rootDir: fixture.rootDir,
      sourceRoot: fixture.sourceRoot,
      artifacts: fixture.artifacts,
    });
    try {
      await expect(
        reopened.discover(context, "task-test"),
      ).rejects.toMatchObject({
        name: "IntegrityError",
        message: "workspace state lost",
      });
      expect(await hashDirectory(tree)).toBe(before);
    } finally {
      await reopened.close();
    }
  } finally {
    await fixture.close();
  }
});

test("metadata and workspaces survive restart while a second provider is rejected [stub runner — not isolation evidence]", async () => {
  const fixture = await makeFixture();
  try {
    const checkpoints = await fixture.provider.checkpoints(
      context,
      fixture.workspace,
    );
    const workspaceId = fixture.workspace.workspace_id;
    await expect(
      createLocalWorkspaceProvider({
        rootDir: fixture.rootDir,
        sourceRoot: fixture.sourceRoot,
        artifacts: fixture.artifacts,
      }),
    ).rejects.toBeInstanceOf(ProviderLockedError);
    await fixture.provider.close();
    const reopened = await createLocalWorkspaceProvider({
      rootDir: fixture.rootDir,
      sourceRoot: fixture.sourceRoot,
      artifacts: fixture.artifacts,
    });
    try {
      expect(await reopened.discover(context, "task-test")).toEqual(
        fixture.workspace,
      );
      expect(await reopened.inspect(context, workspaceId)).toEqual(
        fixture.workspace,
      );
      expect(await reopened.checkpoints(context, fixture.workspace)).toEqual(
        checkpoints,
      );
      expect(
        (
          await reopened.restore(
            context,
            first(checkpoints),
            fixture.workspace.revision,
          )
        ).workspace_id,
      ).toBe(workspaceId);
    } finally {
      await reopened.close();
    }
  } finally {
    await fixture.close();
  }
});

test("execute fails closed without isolation or approval and validates argv [stub runner — not isolation evidence]", async () => {
  let approverCalled = false;
  const noSandbox = await makeFixture({
    runner: false,
    approveCommand: () => {
      approverCalled = true;
      return true;
    },
  });
  try {
    await expect(
      noSandbox.provider.execute(
        context,
        noSandbox.workspace,
        ["do-not-run"],
        budget,
      ),
    ).rejects.toBeInstanceOf(SandboxUnavailableError);
    expect(approverCalled).toBe(false);
    await expect(
      noSandbox.provider.execute(
        context,
        noSandbox.workspace,
        ["bad\0arg"],
        budget,
      ),
    ).rejects.toBeInstanceOf(WorkspacePolicyError);
  } finally {
    await noSandbox.close();
  }

  let verifyCalls = 0;
  const rejectedRunner = createStubRunner();
  const runner: typeof rejectedRunner = {
    ...rejectedRunner,
    async verify() {
      verifyCalls += 1;
    },
  };
  const noApproval = await makeFixture({ runner, approveCommand: false });
  try {
    await expect(
      noApproval.provider.execute(
        context,
        noApproval.workspace,
        ["must-not-run"],
        budget,
      ),
    ).rejects.toBeInstanceOf(CommandNotApprovedError);
    expect(verifyCalls).toBe(0);
  } finally {
    await noApproval.close();
  }

  let runnerStarted = false;
  const unavailableRunner = createStubRunner(async () => {
    runnerStarted = true;
    return undefined;
  });
  unavailableRunner.verify = async () => {
    throw new SandboxUnavailableError("simulated unavailable sandbox");
  };
  const unavailable = await makeFixture({ runner: unavailableRunner });
  try {
    await expect(
      unavailable.provider.execute(
        context,
        unavailable.workspace,
        ["echo", "no-host-fallback"],
        budget,
      ),
    ).rejects.toBeInstanceOf(SandboxUnavailableError);
    expect(runnerStarted).toBe(false);
  } finally {
    await unavailable.close();
  }
});

test("stub execute clamps deadlines, supports stop and external cancellation, and stores bounded output [stub runner — not isolation evidence]", async () => {
  let timeoutMs = 0;
  let outputLimit = 0;
  let signalSeen: AbortSignal | undefined;
  let begin: (() => void) | undefined;
  const began = new Promise<void>((resolvePromise) => {
    begin = resolvePromise;
  });
  let waitForAbort = false;
  const runner = createStubRunner(async (request: SandboxRunRequest) => {
    timeoutMs = request.timeoutMs;
    outputLimit = request.maxOutputBytes;
    signalSeen = request.signal;
    if (waitForAbort) {
      if (!begin) throw new Error("Start signal was not initialized");
      begin();
      if (request.signal.aborted) return { exitCode: 130, cancelled: true };
      await new Promise<void>((resolvePromise) => {
        request.signal.addEventListener("abort", () => resolvePromise(), {
          once: true,
        });
      });
      return { exitCode: 137, cancelled: true };
    }
    return {
      stdout: new TextEncoder().encode("0123456789"),
      stderr: new TextEncoder().encode("err-too-long"),
    };
  });
  const fixture = await makeFixture({
    runner,
    limits: { maxExecutionMs: 1000, maxOutputBytes: 5 },
  });
  try {
    const first = await fixture.provider.execute(
      context,
      fixture.workspace,
      ["bounded"],
      budget,
    );
    expect(timeoutMs).toBe(1000);
    expect(outputLimit).toBe(5);
    expect(first.stdout_truncated).toBe(true);
    expect(first.stderr_truncated).toBe(true);
    expect(await artifactText(fixture.artifacts, first.stdout)).toBe("01234");
    expect(await artifactText(fixture.artifacts, first.stderr)).toBe("err-t");
    waitForAbort = true;
    const run = fixture.provider.execute(
      context,
      first.workspace,
      ["wait"],
      budget,
    );
    await began;
    await fixture.provider.stop(context, first.workspace);
    const cancelled = await run;
    expect(signalSeen?.aborted).toBe(true);
    expect(cancelled.cancelled).toBe(true);
    expect(cancelled.exit_code).toBe(130);

    waitForAbort = true;
    const abortController = new AbortController();
    const external = fixture.provider.execute(
      context,
      cancelled.workspace,
      ["wait"],
      budget,
      { signal: abortController.signal },
    );
    abortController.abort();
    const cancelledExternally = await external;
    expect(cancelledExternally.cancelled).toBe(true);
  } finally {
    await fixture.close();
  }
});

test("Docker args are constrained and include the fixed hardening flags [stub runner — not isolation evidence]", () => {
  const image = `mirror.gcr.io/library/busybox@sha256:${digest}`;
  const resolved = resolveDockerConfig({
    image,
    user: { uid: 1000, gid: 1000 },
    memoryBytes: 536870912,
    pids: 128,
    cpus: 1,
    tmpfsBytes: 67108864,
    maxFileBytes: 10485760,
  });
  const request: SandboxRunRequest = {
    workspaceDir: "/tmp/workspaces/ws_abc/tree",
    argv: ["sh", "-c", "echo safe"],
    timeoutMs: 1000,
    maxOutputBytes: 1000,
    signal: new AbortController().signal,
    runId: "run-123",
    labels: { "mars.workspace": "ws_abc", "mars.root": "root123" },
  };
  const args = buildDockerRunArgs(resolved, request, "mars-ws-run-123");
  expect(args).toEqual([
    "run",
    "--rm",
    "--pull=never",
    "--name",
    "mars-ws-run-123",
    "--label",
    "mars.root=root123",
    "--label",
    "mars.workspace=ws_abc",
    "--network",
    "none",
    "--read-only",
    "--user",
    "1000:1000",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "128",
    "--memory",
    "536870912",
    "--memory-swap",
    "536870912",
    "--cpus",
    "1",
    "--ipc",
    "none",
    "--init",
    "--ulimit",
    "nofile=1024:1024",
    "--ulimit",
    "fsize=10485760",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,nodev,size=67108864",
    "--mount",
    "type=bind,src=/tmp/workspaces/ws_abc/tree,dst=/workspace",
    "--workdir",
    "/workspace",
    "--env",
    "HOME=/tmp",
    image,
    "sh",
    "-c",
    "echo safe",
  ]);
  expect(() => createDockerSandbox({ image: "busybox:latest" })).toThrow();
  expect(() =>
    buildDockerRunArgs(
      resolved,
      { ...request, workspaceDir: "/tmp/a,b" },
      "name",
    ),
  ).toThrow();
});
