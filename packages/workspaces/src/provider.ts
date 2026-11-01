import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  type ArtifactRef,
  ArtifactRefSchema,
  BudgetSchema,
  type CheckpointRef,
  type RequestContext,
  SCHEMA_VERSION,
  ScopeSchema,
  type WorkspaceRef,
} from "@mars/contracts";
import { z } from "zod";
import { createWorkspaceDiff } from "./diff";
import {
  CommandNotApprovedError,
  IntegrityError,
  LimitExceededError,
  RevisionConflictError,
  SandboxUnavailableError,
  WorkspaceModifiedError,
  WorkspaceNotFoundError,
  WorkspacePolicyError,
} from "./errors";
import { resolveSafePath, validateRelativePath } from "./paths";
import {
  acquireProviderLock,
  type CheckpointRecord,
  fileExists,
  listMetas,
  loadMeta,
  metaPath,
  revision,
  saveMeta,
  type WorkspaceMeta,
  workspacePath,
} from "./store";
import {
  assertArtifactBytes,
  compareStrings,
  DEFAULT_WORKSPACE_LIMITS,
  ensureDirectory,
  materializeSnapshot,
  sha256,
  snapshotTree,
  type TreeFile,
  type TreeSnapshot,
  type WorkspaceLimits,
} from "./tree";
import type {
  LocalExecutionResult,
  LocalWorkspaceProvider,
  LocalWorkspaceProviderOptions,
  SandboxRunResult,
  WorkspaceDiff,
} from "./types";

const checkpointManifestSchema = z
  .object({
    schema_version: z.literal(1),
    kind: z.literal("mars.workspace.checkpoint"),
    checkpoint_id: z.string().regex(/^cp_[a-f0-9]{32}$/),
    workspace_id: z.string().regex(/^ws_[a-f0-9]{32}$/),
    provider: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,63}$/),
    owner_id: z.string().min(1),
    project_id: z.string().min(1),
    task_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
    revision: z.string().min(1),
    tree_digest: z.string().regex(/^[a-f0-9]{64}$/),
    created_at: z.string().datetime({ offset: true }),
    directories: z.array(z.string()),
    files: z.array(
      z
        .object({
          path: z.string(),
          mode: z.union([z.literal(420), z.literal(493)]),
          blob: ArtifactRefSchema,
        })
        .strict(),
    ),
  })
  .strict();

type CheckpointManifest = z.infer<typeof checkpointManifestSchema>;

interface Mutex {
  tail: Promise<void>;
}

interface ActiveRun {
  controller: AbortController;
  done: Promise<void>;
  resolveDone: () => void;
}

function createMutex(): Mutex {
  return { tail: Promise.resolve() };
}

async function withMutex<T>(
  mutex: Mutex,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = mutex.tail;
  let release!: () => void;
  mutex.tail = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

export async function createLocalWorkspaceProvider(
  options: LocalWorkspaceProviderOptions,
): Promise<LocalWorkspaceProvider> {
  if (!isAbsolute(options.rootDir) || !isAbsolute(options.sourceRoot)) {
    throw new WorkspacePolicyError(
      "rootDir and sourceRoot must be absolute paths",
    );
  }
  const sourceRoot = await realDirectory(options.sourceRoot, "sourceRoot");
  const requestedRoot = resolve(options.rootDir);
  const rootCandidate = await resolveFromExistingParent(requestedRoot);
  if (
    isWithin(rootCandidate, sourceRoot) ||
    isWithin(sourceRoot, rootCandidate)
  ) {
    throw new WorkspacePolicyError(
      "rootDir and sourceRoot must not contain one another",
    );
  }
  await mkdir(requestedRoot, { recursive: true, mode: 0o700 });
  const rootDir = await realDirectory(options.rootDir, "rootDir");
  if (isWithin(rootDir, sourceRoot) || isWithin(sourceRoot, rootDir)) {
    throw new WorkspacePolicyError(
      "rootDir and sourceRoot must not contain one another",
    );
  }
  await chmod(rootDir, 0o700);
  if (!/^[A-Za-z0-9._/-]+$/.test(rootDir)) {
    throw new WorkspacePolicyError(
      "rootDir contains characters unsafe for Docker mount arguments",
    );
  }
  const providerId = options.providerId ?? "mars-local-workspace";
  if (!/^[a-z0-9][a-z0-9.-]{0,63}$/.test(providerId)) {
    throw new WorkspacePolicyError("Invalid providerId");
  }
  const limits = { ...DEFAULT_WORKSPACE_LIMITS, ...options.limits };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new WorkspacePolicyError(`Invalid workspace limit: ${key}`);
    }
  }
  const extraIgnores = options.extraIgnores ?? [];
  if (
    extraIgnores.some(
      (pattern) =>
        !/^[A-Za-z0-9._*-]+$/.test(pattern) || pattern.includes("**"),
    )
  ) {
    throw new WorkspacePolicyError(
      "extraIgnores must contain segment names or simple segment globs",
    );
  }
  const releaseLock = await acquireProviderLock(rootDir);
  let startupStateError: IntegrityError | undefined;
  try {
    for (const directory of ["meta", "workspaces", "staging", "trash"]) {
      await ensureDirectory(join(rootDir, directory));
    }
    if (options.sandbox) {
      await options.sandbox.cleanup({
        "mars.root": sha256(rootDir).slice(0, 16),
      });
    }
    await recoverProviderState(rootDir, limits, extraIgnores);
  } catch (error) {
    if (
      error instanceof IntegrityError &&
      error.message.includes("workspace state lost")
    ) {
      startupStateError = error;
    } else {
      await releaseLock();
      throw error;
    }
  }

  const locks = new Map<string, Mutex>();
  const prepareMutex = createMutex();
  const activeRuns = new Map<string, ActiveRun>();
  const now = options.now ?? (() => new Date());
  const ensureProviderState = (): void => {
    if (startupStateError) {
      throw new IntegrityError("workspace state lost", {
        cause: startupStateError,
      });
    }
  };
  const lockFor = (workspaceId: string): Mutex => {
    let lock = locks.get(workspaceId);
    if (!lock) {
      lock = createMutex();
      locks.set(workspaceId, lock);
    }
    return lock;
  };
  const verifyContext = (context: RequestContext): void => {
    try {
      if (
        context?.schema_version !== SCHEMA_VERSION ||
        typeof context.request_id !== "string" ||
        context.request_id.length === 0 ||
        !ScopeSchema.safeParse(context.scope).success
      ) {
        throw new Error("invalid");
      }
    } catch {
      throw new WorkspacePolicyError("Invalid request context");
    }
  };
  const assertTaskId = (taskId: string): void => {
    if (
      typeof taskId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(taskId)
    ) {
      throw new WorkspacePolicyError("Invalid task id");
    }
  };
  const assertWorkspace = async (
    context: RequestContext,
    workspace: WorkspaceRef | string,
    allowRestoreJournal = false,
  ): Promise<WorkspaceMeta> => {
    if (closed)
      throw new SandboxUnavailableError("Workspace provider is closed");
    ensureProviderState();
    verifyContext(context);
    const workspaceId =
      typeof workspace === "string" ? workspace : workspace?.workspace_id;
    if (
      typeof workspaceId !== "string" ||
      !/^ws_[a-f0-9]{32}$/.test(workspaceId) ||
      (typeof workspace !== "string" && workspace.provider !== providerId)
    ) {
      throw new WorkspaceNotFoundError();
    }
    let meta: WorkspaceMeta;
    try {
      meta = await loadMeta(rootDir, workspaceId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new WorkspaceNotFoundError();
      throw error;
    }
    if (
      meta.provider !== providerId ||
      meta.owner_id !== context.scope.owner_id ||
      meta.project_id !== context.scope.project_id ||
      (context.scope.workspace_id !== undefined &&
        context.scope.workspace_id !== workspaceId)
    ) {
      throw new WorkspaceNotFoundError();
    }
    if (allowRestoreJournal) ensureProviderState();
    else await assertWorkspaceAvailable(meta);
    return meta;
  };
  const currentRef = (meta: WorkspaceMeta): WorkspaceRef => ({
    workspace_id: meta.workspace_id,
    provider: meta.provider,
    revision: meta.revision,
  });
  const treeDir = (meta: WorkspaceMeta): string =>
    workspacePath(rootDir, meta.workspace_id);
  const assertWorkspaceAvailable = async (
    meta: WorkspaceMeta,
  ): Promise<string> => {
    ensureProviderState();
    if (meta.restore_journal) {
      throw new IntegrityError(
        "workspace state lost: restore recovery required",
      );
    }
    return resolveWorkspaceTree(rootDir, meta.workspace_id);
  };
  const reloadWorkspaceMeta = async (
    workspaceId: string,
  ): Promise<WorkspaceMeta> => {
    ensureProviderState();
    try {
      return await loadMeta(rootDir, workspaceId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new IntegrityError("workspace state lost", { cause: error });
      }
      throw error;
    }
  };
  const treeSnapshot = (
    meta: WorkspaceMeta,
    enforceLimits = true,
    includeData = true,
  ): Promise<TreeSnapshot> =>
    snapshotTree(treeDir(meta), {
      limits,
      extraIgnores,
      enforceLimits,
      includeData,
    });

  const validateArtifact = (artifact: ArtifactRef): ArtifactRef => {
    const parsed = ArtifactRefSchema.safeParse(artifact);
    if (!parsed.success)
      throw new IntegrityError("Invalid artifact reference", {
        cause: parsed.error,
      });
    return parsed.data;
  };

  const storeCheckpoint = async (
    context: RequestContext,
    meta: WorkspaceMeta,
    snapshot: TreeSnapshot,
    persist = true,
  ): Promise<CheckpointRef> => {
    const checkpointId = `cp_${randomUUID().replaceAll("-", "")}`;
    const checkpointTime = now().toISOString();
    const checkpointRevision = meta.revision;
    const files: CheckpointManifest["files"] = [];
    const blobIndex = { ...(meta.blob_index ?? {}) };
    for (const file of snapshot.files) {
      let blob = blobIndex[file.sha256];
      if (!blob) {
        blob = validateArtifact(
          await options.artifacts.put(
            context,
            file.data,
            "application/octet-stream",
          ),
        );
        assertArtifactBytes(file.data, blob);
        blobIndex[file.sha256] = blob;
      }
      files.push({ path: file.path, mode: file.mode, blob });
    }
    files.sort((a, b) => compareStrings(a.path, b.path));
    const manifest: CheckpointManifest = {
      schema_version: 1,
      kind: "mars.workspace.checkpoint",
      checkpoint_id: checkpointId,
      workspace_id: meta.workspace_id,
      provider: providerId,
      owner_id: meta.owner_id,
      project_id: meta.project_id,
      task_id: meta.task_id,
      revision: checkpointRevision,
      tree_digest: snapshot.digest,
      created_at: checkpointTime,
      directories: [...snapshot.directories].sort(compareStrings),
      files,
    };
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
    if (manifestBytes.byteLength > limits.maxManifestBytes) {
      throw new LimitExceededError(
        "Checkpoint manifest exceeds maxManifestBytes",
      );
    }
    const artifact = validateArtifact(
      await options.artifacts.put(
        context,
        manifestBytes,
        "application/vnd.mars.workspace-checkpoint+json",
      ),
    );
    assertArtifactBytes(manifestBytes, artifact);
    const record: CheckpointRecord = {
      checkpoint_id: checkpointId,
      artifact,
      revision: checkpointRevision,
      created_at: checkpointTime,
    };
    meta.blob_index = blobIndex;
    meta.checkpoints.push(record);
    if (meta.checkpoints.length === 1)
      meta.baseline_checkpoint_id = checkpointId;
    if (persist) await saveMeta(rootDir, meta);
    return {
      checkpoint_id: checkpointId,
      workspace: currentRef(meta),
      artifact,
    };
  };

  const loadRecordedManifest = async (
    context: RequestContext,
    meta: WorkspaceMeta,
    checkpoint: CheckpointRef,
  ): Promise<CheckpointManifest> => {
    if (
      !checkpoint ||
      !/^cp_[a-f0-9]{32}$/.test(checkpoint.checkpoint_id) ||
      checkpoint.workspace?.workspace_id !== meta.workspace_id ||
      checkpoint.workspace.provider !== providerId
    ) {
      throw new WorkspaceNotFoundError();
    }
    const record = meta.checkpoints.find(
      (item) => item.checkpoint_id === checkpoint.checkpoint_id,
    );
    if (!record) throw new WorkspaceNotFoundError();
    const artifact = validateArtifact(checkpoint.artifact);
    if (!sameArtifact(record.artifact, artifact)) {
      throw new IntegrityError(
        "Checkpoint artifact does not match the recorded checkpoint",
      );
    }
    if (checkpoint.workspace.revision !== record.revision) {
      throw new IntegrityError(
        "Checkpoint revision does not match the recorded checkpoint",
      );
    }
    let data: Uint8Array;
    try {
      data = await options.artifacts.get(context, artifact);
    } catch (error) {
      throw new IntegrityError("Checkpoint manifest is unavailable", {
        cause: error,
      });
    }
    if (data.byteLength > limits.maxManifestBytes) {
      throw new IntegrityError("Checkpoint manifest exceeds maxManifestBytes");
    }
    assertArtifactBytes(data, artifact);
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(data),
      );
    } catch (error) {
      throw new IntegrityError("Checkpoint manifest is not valid JSON", {
        cause: error,
      });
    }
    const parsed = checkpointManifestSchema.safeParse(parsedJson);
    if (!parsed.success)
      throw new IntegrityError("Checkpoint manifest schema is invalid", {
        cause: parsed.error,
      });
    const manifest = parsed.data;
    if (
      manifest.checkpoint_id !== record.checkpoint_id ||
      manifest.workspace_id !== meta.workspace_id ||
      manifest.provider !== providerId ||
      manifest.owner_id !== meta.owner_id ||
      manifest.project_id !== meta.project_id ||
      manifest.task_id !== meta.task_id ||
      manifest.revision !== record.revision
    ) {
      throw new IntegrityError(
        "Checkpoint manifest scope does not match workspace metadata",
      );
    }
    validateManifestPaths(manifest, limits, extraIgnores);
    return manifest;
  };

  const fetchManifestFiles = async (
    context: RequestContext,
    manifest: CheckpointManifest,
  ): Promise<TreeFile[]> => {
    const files: TreeFile[] = [];
    for (const entry of manifest.files) {
      let data: Uint8Array;
      try {
        data = await options.artifacts.get(context, entry.blob);
      } catch (error) {
        throw new IntegrityError(
          `Unable to fetch checkpoint blob ${entry.path}`,
          { cause: error },
        );
      }
      assertArtifactBytes(data, entry.blob);
      if (data.byteLength > limits.maxFileBytes) {
        throw new IntegrityError(
          `Checkpoint blob exceeds maxFileBytes: ${entry.path}`,
        );
      }
      files.push({
        path: entry.path,
        mode: entry.mode,
        data,
        size: data.byteLength,
        sha256: sha256(data),
      });
    }
    return files;
  };

  const getCheckpoint = async (
    context: RequestContext,
    meta: WorkspaceMeta,
    checkpoint: CheckpointRef,
  ): Promise<{ manifest: CheckpointManifest; files: TreeFile[] }> => {
    const manifest = await loadRecordedManifest(context, meta, checkpoint);
    const files = await fetchManifestFiles(context, manifest);
    const calculatedDigest = digestManifest(manifest, files);
    if (calculatedDigest !== manifest.tree_digest) {
      throw new IntegrityError(
        "Checkpoint tree digest does not match its manifest contents",
      );
    }
    return { manifest, files };
  };

  const invokeRestoreHook = async (
    phase: "staged" | "backed-up" | "swapped" | "committed",
  ): Promise<void> => {
    await options.testHooks?.restorePhase?.(phase);
  };

  const rollbackRestore = async (meta: WorkspaceMeta): Promise<void> => {
    const journal = meta.restore_journal;
    if (!journal) return;
    const workspace = treeDir(meta);
    const stage = join(rootDir, "staging", journal.staging);
    const backup = join(rootDir, "trash", journal.backup);
    if (await fileExists(backup)) {
      await rm(workspace, { recursive: true, force: true });
      await mkdir(dirname(workspace), { recursive: true, mode: 0o700 });
      await rename(backup, workspace);
    }
    await rm(stage, { recursive: true, force: true });
    await rm(backup, { recursive: true, force: true });
    meta.counter = journal.previous.counter;
    meta.revision = journal.previous.revision;
    meta.tree_digest = journal.previous.tree_digest;
    delete meta.restore_journal;
    await saveMeta(rootDir, meta);
  };

  const makeCheckpointForPublic = async (
    context: RequestContext,
    workspace: WorkspaceRef,
  ): Promise<CheckpointRef> => {
    const meta = await assertWorkspace(context, workspace);
    return withMutex(lockFor(meta.workspace_id), async () => {
      const fresh = await reloadWorkspaceMeta(meta.workspace_id);
      await assertWorkspaceAvailable(fresh);
      const snapshot = await treeSnapshot(fresh, true, true);
      if (fresh.tree_digest !== snapshot.digest) {
        fresh.tree_digest = snapshot.digest;
        fresh.revision = revision(fresh.counter, snapshot.digest);
        await saveMeta(rootDir, fresh);
      }
      return storeCheckpoint(context, fresh, snapshot);
    });
  };

  let closed = false;
  const provider: LocalWorkspaceProvider = {
    providerId,
    async prepare(context, taskId) {
      return withMutex(prepareMutex, async () => {
        verifyContext(context);
        assertTaskId(taskId);
        if (closed)
          throw new SandboxUnavailableError("Workspace provider is closed");
        ensureProviderState();
        const existing = (await listMetas(rootDir)).find(
          (meta) =>
            meta.owner_id === context.scope.owner_id &&
            meta.project_id === context.scope.project_id &&
            meta.task_id === taskId &&
            (context.scope.workspace_id === undefined ||
              meta.workspace_id === context.scope.workspace_id),
        );
        if (existing) {
          return withMutex(lockFor(existing.workspace_id), async () => {
            const current = await reloadWorkspaceMeta(existing.workspace_id);
            if (
              current.owner_id !== context.scope.owner_id ||
              current.project_id !== context.scope.project_id ||
              current.task_id !== taskId
            ) {
              throw new WorkspaceNotFoundError();
            }
            await assertWorkspaceAvailable(current);
            return currentRef(current);
          });
        }
        if (context.scope.workspace_id !== undefined)
          throw new WorkspaceNotFoundError();

        const skippedFiles: Array<{
          path: string;
          reason: "symlink" | "special" | "ignored-secret";
        }> = [];
        const snapshot = await snapshotTree(sourceRoot, {
          limits,
          extraIgnores,
          enforceLimits: true,
          skipped: skippedFiles,
        });
        const workspaceId = `ws_${randomUUID().replaceAll("-", "")}`;
        const stageName = `${workspaceId}-${randomUUID().replaceAll("-", "")}`;
        const stageDir = join(rootDir, "staging", stageName);
        const stagedTree = join(stageDir, "tree");
        const finalTree = workspacePath(rootDir, workspaceId);
        const createdAt = now().toISOString();
        const initialRevision = revision(0, snapshot.digest);
        try {
          await mkdir(stageDir, { recursive: false, mode: 0o700 });
          await materializeSnapshot(stagedTree, snapshot);
          await mkdir(dirname(finalTree), { recursive: true, mode: 0o700 });
          const meta: WorkspaceMeta = {
            schema_version: 1,
            workspace_id: workspaceId,
            provider: providerId,
            owner_id: context.scope.owner_id,
            project_id: context.scope.project_id,
            task_id: taskId,
            counter: 0,
            revision: initialRevision,
            tree_digest: snapshot.digest,
            created_at: createdAt,
            baseline_checkpoint_id: `cp_${randomUUID().replaceAll("-", "")}`,
            checkpoints: [],
            blob_index: {},
            skipped: skippedFiles,
          };
          await mkdir(dirname(metaPath(rootDir, workspaceId)), {
            recursive: true,
            mode: 0o700,
          });
          const checkpoint = await storeCheckpoint(
            context,
            meta,
            snapshot,
            false,
          );
          if (checkpoint.checkpoint_id !== meta.baseline_checkpoint_id) {
            throw new IntegrityError("Baseline checkpoint id mismatch");
          }
          await rename(stagedTree, finalTree);
          await saveMeta(rootDir, meta);
          return currentRef(meta);
        } catch (error) {
          await rm(join(rootDir, "meta", workspaceId), {
            recursive: true,
            force: true,
          });
          await rm(join(rootDir, "workspaces", workspaceId), {
            recursive: true,
            force: true,
          });
          throw error;
        } finally {
          await rm(stageDir, { recursive: true, force: true });
        }
      });
    },
    async read(context, workspace, relativePath) {
      const meta = await assertWorkspace(context, workspace);
      return withMutex(lockFor(meta.workspace_id), async () => {
        const current = await reloadWorkspaceMeta(meta.workspace_id);
        await assertWorkspaceAvailable(current);
        const path = validateRelativePath(relativePath, limits, extraIgnores);
        const absolute = await resolveSafePath(treeDir(current), path);
        let handle: FileHandle | undefined;
        try {
          handle = await open(
            absolute,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          );
          const info = await handle.stat();
          if (!info.isFile())
            throw new WorkspacePolicyError(
              "Workspace path is not a regular file",
            );
          if (info.size > limits.maxFileBytes)
            throw new LimitExceededError("File exceeds maxFileBytes");
          const data = await readBounded(handle, limits.maxFileBytes);
          const artifact = validateArtifact(
            await options.artifacts.put(
              context,
              data,
              "application/octet-stream",
            ),
          );
          assertArtifactBytes(data, artifact);
          return artifact;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT")
            throw new WorkspaceNotFoundError();
          if ((error as NodeJS.ErrnoException).code === "ELOOP") {
            throw new WorkspacePolicyError("Symlink paths are not allowed");
          }
          throw error;
        } finally {
          await handle?.close();
        }
      });
    },
    async write(context, workspace, relativePath, artifact, writeOptions) {
      const meta = await assertWorkspace(context, workspace);
      return withMutex(lockFor(meta.workspace_id), async () => {
        const current = await reloadWorkspaceMeta(meta.workspace_id);
        await assertWorkspaceAvailable(current);
        const path = validateRelativePath(relativePath, limits, extraIgnores);
        const ref = validateArtifact(artifact);
        const data = await options.artifacts.get(context, ref);
        assertArtifactBytes(data, ref);
        if (data.byteLength > limits.maxFileBytes)
          throw new LimitExceededError("File exceeds maxFileBytes");
        const tree = treeDir(current);
        const absolute = await resolveSafePath(tree, path);
        const existing = await lstat(absolute).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return undefined;
            throw error;
          },
        );
        if (existing && !existing.isFile()) {
          throw new WorkspacePolicyError(
            "Workspace write target is not a regular file",
          );
        }
        if (
          writeOptions?.executable !== undefined &&
          typeof writeOptions.executable !== "boolean"
        ) {
          throw new WorkspacePolicyError("executable must be a boolean");
        }
        const currentSnapshot = await treeSnapshot(current, true, false);
        const prior = currentSnapshot.files.find((file) => file.path === path);
        const fileCount = currentSnapshot.files.length + (prior ? 0 : 1);
        const totalBytes =
          currentSnapshot.totalBytes - (prior?.size ?? 0) + data.byteLength;
        if (fileCount > limits.maxFiles)
          throw new LimitExceededError("Workspace exceeds maxFiles");
        if (totalBytes > limits.maxTotalBytes)
          throw new LimitExceededError("Workspace exceeds maxTotalBytes");
        await ensureParentDirectories(tree, path);
        const mode =
          writeOptions?.executable === undefined
            ? existing
              ? (existing.mode & 0o111) !== 0
                ? 0o755
                : 0o644
              : 0o644
            : writeOptions.executable
              ? 0o755
              : 0o644;
        const temporary = join(
          dirname(absolute),
          `.mars-tmp-${randomUUID().replaceAll("-", "")}`,
        );
        const handle = await open(temporary, "wx", mode);
        try {
          await handle.writeFile(data);
          await handle.sync();
        } finally {
          await handle.close();
        }
        try {
          await rename(temporary, absolute);
          await chmod(absolute, mode);
          const after = await treeSnapshot(current, true, false);
          current.counter += 1;
          current.tree_digest = after.digest;
          current.revision = revision(current.counter, after.digest);
          await saveMeta(rootDir, current);
        } catch (error) {
          await rm(temporary, { force: true });
          throw error;
        }
      });
    },
    async execute(context, workspace, argv, budget, executeOptions) {
      const meta = await assertWorkspace(context, workspace);
      return withMutex(lockFor(meta.workspace_id), async () => {
        if (closed)
          throw new SandboxUnavailableError("Workspace provider is closed");
        const current = await reloadWorkspaceMeta(meta.workspace_id);
        await assertWorkspaceAvailable(current);
        if (
          !Array.isArray(argv) ||
          argv.length === 0 ||
          argv.length > 256 ||
          argv.some(
            (arg) =>
              typeof arg !== "string" ||
              arg.includes("\0") ||
              Buffer.byteLength(arg) > 4096,
          )
        ) {
          throw new WorkspacePolicyError("Invalid command arguments");
        }
        const parsedBudget = BudgetSchema.safeParse(budget);
        if (!parsedBudget.success)
          throw new WorkspacePolicyError("Invalid execution budget");
        if (!options.sandbox)
          throw new SandboxUnavailableError("No sandbox is configured");
        if (!options.approveCommand) throw new CommandNotApprovedError();
        const approved = await options.approveCommand({
          context,
          workspace: currentRef(current),
          task_id: current.task_id,
          argv: [...argv],
          budget: parsedBudget.data,
        });
        if (!approved) throw new CommandNotApprovedError();
        if (closed)
          throw new SandboxUnavailableError("Workspace provider is closed");
        try {
          await options.sandbox.verify();
        } catch (error) {
          if (error instanceof SandboxUnavailableError) throw error;
          throw new SandboxUnavailableError("Sandbox verification failed", {
            cause: error,
          });
        }
        if (closed)
          throw new SandboxUnavailableError("Workspace provider is closed");
        const timeoutMs = Math.min(
          parsedBudget.data.max_duration_ms,
          limits.maxExecutionMs,
        );
        const runId = randomUUID().replaceAll("-", "");
        const startedAt = now().toISOString();
        const controller = new AbortController();
        let resolveDone!: () => void;
        const done = new Promise<void>((resolvePromise) => {
          resolveDone = resolvePromise;
        });
        const active: ActiveRun = { controller, done, resolveDone };
        activeRuns.set(current.workspace_id, active);
        const externalSignal = executeOptions?.signal;
        const abortExternal = (): void =>
          controller.abort(externalSignal?.reason);
        externalSignal?.addEventListener("abort", abortExternal, {
          once: true,
        });
        if (externalSignal?.aborted) abortExternal();
        current.exec_in_progress = { run_id: runId, started_at: startedAt };
        let result: SandboxRunResult;
        try {
          try {
            await saveMeta(rootDir, current);
            result = await options.sandbox.run({
              workspaceDir: treeDir(current),
              argv: [...argv],
              timeoutMs,
              maxOutputBytes: limits.maxOutputBytes,
              signal: controller.signal,
              runId,
              labels: {
                "mars.workspace": current.workspace_id,
                "mars.root": sha256(rootDir).slice(0, 16),
              },
            });
          } finally {
            const after = await treeSnapshot(current, false, false);
            current.counter += 1;
            current.tree_digest = after.digest;
            current.revision = revision(current.counter, after.digest);
            delete current.exec_in_progress;
            await saveMeta(rootDir, current);
          }
          const stdout = result.stdout.subarray(0, limits.maxOutputBytes);
          const stderr = result.stderr.subarray(0, limits.maxOutputBytes);
          const stdoutTruncated =
            result.stdoutTruncated ||
            result.stdout.byteLength > stdout.byteLength;
          const stderrTruncated =
            result.stderrTruncated ||
            result.stderr.byteLength > stderr.byteLength;
          const stdoutRef = validateArtifact(
            await options.artifacts.put(
              context,
              stdout,
              "text/plain; charset=utf-8",
            ),
          );
          const stderrRef = validateArtifact(
            await options.artifacts.put(
              context,
              stderr,
              "text/plain; charset=utf-8",
            ),
          );
          assertArtifactBytes(stdout, stdoutRef);
          assertArtifactBytes(stderr, stderrRef);
          const finishedAt = now().toISOString();
          return {
            workspace: currentRef(current),
            exit_code: result.timedOut
              ? 124
              : result.cancelled
                ? 130
                : result.exitCode,
            stdout: stdoutRef,
            stderr: stderrRef,
            started_at: startedAt,
            finished_at: finishedAt,
            timed_out: result.timedOut,
            cancelled: result.cancelled,
            stdout_truncated: stdoutTruncated,
            stderr_truncated: stderrTruncated,
          };
        } finally {
          externalSignal?.removeEventListener("abort", abortExternal);
          activeRuns.delete(current.workspace_id);
          active.resolveDone();
        }
      });
    },
    async checkpoint(context, workspace) {
      return makeCheckpointForPublic(context, workspace);
    },
    async restore(context, checkpoint, expectedRevision) {
      if (!checkpoint?.workspace) throw new WorkspaceNotFoundError();
      const meta = await assertWorkspace(context, checkpoint.workspace);
      return withMutex(lockFor(meta.workspace_id), async () => {
        const current = await reloadWorkspaceMeta(meta.workspace_id);
        await assertWorkspaceAvailable(current);
        if (expectedRevision !== current.revision)
          throw new RevisionConflictError();
        const { manifest, files } = await getCheckpoint(
          context,
          current,
          checkpoint,
        );
        const currentSnapshot = await treeSnapshot(current, false, false);
        if (currentSnapshot.digest !== current.tree_digest)
          throw new WorkspaceModifiedError();
        const stageName = `${current.workspace_id}-${randomUUID().replaceAll("-", "")}`;
        const backupName = `${current.workspace_id}-${randomUUID().replaceAll("-", "")}`;
        const stagingDir = join(rootDir, "staging", stageName);
        const stagingTree = join(stagingDir, "tree");
        const backupDir = join(rootDir, "trash", backupName);
        const destination = treeDir(current);
        const restoredSnapshot: TreeSnapshot = {
          files,
          directories: [...manifest.directories],
          digest: manifest.tree_digest,
          totalBytes: files.reduce((sum, file) => sum + file.size, 0),
        };
        await mkdir(stagingDir, { recursive: false, mode: 0o700 });
        try {
          await materializeSnapshot(stagingTree, restoredSnapshot);
          await invokeRestoreHook("staged");
        } catch (error) {
          await rm(stagingDir, { recursive: true, force: true });
          throw error;
        }
        const targetCounter = current.counter + 1;
        const targetRevision = revision(targetCounter, manifest.tree_digest);
        current.restore_journal = {
          phase: "backed-up",
          staging: stageName,
          backup: backupName,
          previous: {
            counter: current.counter,
            revision: current.revision,
            tree_digest: current.tree_digest,
          },
          target: {
            counter: targetCounter,
            revision: targetRevision,
            tree_digest: manifest.tree_digest,
          },
        };
        await saveMeta(rootDir, current);
        try {
          await rename(destination, backupDir);
          await invokeRestoreHook("backed-up");
          await rename(stagingTree, destination);
          await invokeRestoreHook("swapped");
          current.counter = targetCounter;
          current.revision = targetRevision;
          current.tree_digest = manifest.tree_digest;
          delete current.restore_journal;
          await saveMeta(rootDir, current);
          await invokeRestoreHook("committed");
          await rm(backupDir, { recursive: true, force: true });
          await rm(stagingDir, { recursive: true, force: true });
          return currentRef(current);
        } catch (error) {
          if ((error as Error)?.name !== "SimulatedCrash") {
            const latest = await loadMeta(rootDir, current.workspace_id);
            await rollbackRestore(latest);
          }
          throw error;
        }
      });
    },
    async diff(context, workspace, diffOptions): Promise<WorkspaceDiff> {
      const meta = await assertWorkspace(context, workspace);
      return withMutex(lockFor(meta.workspace_id), async () => {
        const current = await reloadWorkspaceMeta(meta.workspace_id);
        await assertWorkspaceAvailable(current);
        const checkpoint =
          diffOptions?.base ?? (await baselineRef(context, current));
        const { files: baseFiles } = await getCheckpoint(
          context,
          current,
          checkpoint,
        );
        const currentSnapshot = await treeSnapshot(current, true, true);
        return createWorkspaceDiff(baseFiles, currentSnapshot.files);
      });
    },
    async collect(context, workspace) {
      const meta = await assertWorkspace(context, workspace);
      return withMutex(lockFor(meta.workspace_id), async () => {
        const current = await reloadWorkspaceMeta(meta.workspace_id);
        await assertWorkspaceAvailable(current);
        const base = await baselineRef(context, current);
        const { files: baseFiles } = await getCheckpoint(
          context,
          current,
          base,
        );
        const snapshot = await treeSnapshot(current, true, true);
        const diff = createWorkspaceDiff(baseFiles, snapshot.files);
        const patch = diff.files.map((file) => file.patch).join("");
        const result: ArtifactRef[] = [
          validateArtifact(
            await options.artifacts.put(
              context,
              new TextEncoder().encode(patch),
              "text/x-diff; charset=utf-8",
            ),
          ),
        ];
        assertArtifactBytes(new TextEncoder().encode(patch), result[0]!);
        const currentFiles = new Map(
          snapshot.files.map((file) => [file.path, file]),
        );
        for (const file of diff.files) {
          if (file.status === "deleted") continue;
          const currentFile = currentFiles.get(file.path);
          if (!currentFile) continue;
          const artifact = validateArtifact(
            await options.artifacts.put(
              context,
              currentFile.data,
              "application/octet-stream",
            ),
          );
          assertArtifactBytes(currentFile.data, artifact);
          result.push(artifact);
        }
        return result;
      });
    },
    async discover(context, taskId) {
      if (closed)
        throw new SandboxUnavailableError("Workspace provider is closed");
      verifyContext(context);
      assertTaskId(taskId);
      ensureProviderState();
      const meta = (await listMetas(rootDir)).find(
        (candidate) =>
          candidate.owner_id === context.scope.owner_id &&
          candidate.project_id === context.scope.project_id &&
          candidate.task_id === taskId &&
          (context.scope.workspace_id === undefined ||
            context.scope.workspace_id === candidate.workspace_id),
      );
      if (!meta) return null;
      return withMutex(lockFor(meta.workspace_id), async () => {
        const current = await reloadWorkspaceMeta(meta.workspace_id);
        if (
          current.owner_id !== context.scope.owner_id ||
          current.project_id !== context.scope.project_id ||
          current.task_id !== taskId
        ) {
          return null;
        }
        await assertWorkspaceAvailable(current);
        return currentRef(current);
      });
    },
    async inspect(context, workspaceId) {
      const meta = await assertWorkspace(context, workspaceId);
      return withMutex(lockFor(meta.workspace_id), async () => {
        const current = await reloadWorkspaceMeta(meta.workspace_id);
        await assertWorkspaceAvailable(current);
        return currentRef(current);
      });
    },
    async workspacePath(context, workspace) {
      const meta = await assertWorkspace(context, workspace, true);
      return withMutex(lockFor(meta.workspace_id), async () => {
        const current = await assertWorkspace(context, workspace, true);
        return assertWorkspaceAvailable(current);
      });
    },
    async checkpoints(context, workspace) {
      const meta = await assertWorkspace(context, workspace);
      return withMutex(lockFor(meta.workspace_id), async () => {
        const current = await reloadWorkspaceMeta(meta.workspace_id);
        await assertWorkspaceAvailable(current);
        return current.checkpoints.map((record) => ({
          checkpoint_id: record.checkpoint_id,
          workspace: {
            workspace_id: current.workspace_id,
            provider: providerId,
            revision: record.revision,
          },
          artifact: record.artifact,
        }));
      });
    },
    async skipped(context, workspace) {
      const meta = await assertWorkspace(context, workspace);
      return withMutex(lockFor(meta.workspace_id), async () => {
        const current = await reloadWorkspaceMeta(meta.workspace_id);
        await assertWorkspaceAvailable(current);
        return current.skipped.map((entry) => ({ ...entry }));
      });
    },
    async stop(context, workspace) {
      const meta = await assertWorkspace(context, workspace);
      const active = activeRuns.get(meta.workspace_id);
      if (!active) return;
      active.controller.abort(new Error("Workspace execution stopped"));
      await active.done;
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const active of activeRuns.values())
        active.controller.abort(new Error("Provider closed"));
      try {
        await Promise.all(
          [...activeRuns.values()].map((active) => active.done),
        );
      } finally {
        await releaseLock();
      }
    },
  };

  async function baselineRef(
    context: RequestContext,
    meta: WorkspaceMeta,
  ): Promise<CheckpointRef> {
    const record = meta.checkpoints.find(
      (item) => item.checkpoint_id === meta.baseline_checkpoint_id,
    );
    if (!record) throw new IntegrityError("Baseline checkpoint is missing");
    const ref: CheckpointRef = {
      checkpoint_id: record.checkpoint_id,
      workspace: currentRef({ ...meta, revision: record.revision }),
      artifact: record.artifact,
    };
    await loadRecordedManifest(context, meta, ref);
    return ref;
  }
  return provider;
}

async function realDirectory(path: string, label: string): Promise<string> {
  let real: string;
  try {
    real = await realpath(path);
  } catch (error) {
    throw new WorkspacePolicyError(
      `${label} must resolve to an existing directory`,
    );
  }
  const info = await lstat(real);
  if (!info.isDirectory())
    throw new WorkspacePolicyError(`${label} must be a directory`);
  return real;
}

async function resolveWorkspaceTree(
  rootDir: string,
  workspaceId: string,
): Promise<string> {
  const workspaceRoot = join(rootDir, "workspaces");
  const workspaceDirectory = join(workspaceRoot, workspaceId);
  const tree = workspacePath(rootDir, workspaceId);
  try {
    for (const path of [workspaceRoot, workspaceDirectory, tree]) {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new IntegrityError("workspace state lost");
      }
    }
    const resolved = await realpath(tree);
    if (resolved !== tree) throw new IntegrityError("workspace state lost");
    return resolved;
  } catch (error) {
    if (error instanceof IntegrityError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") {
      throw new IntegrityError("workspace state lost", { cause: error });
    }
    throw error;
  }
}

async function resolveFromExistingParent(path: string): Promise<string> {
  let candidate = path;
  const missing: string[] = [];
  while (true) {
    try {
      const realParent = await realpath(candidate);
      return join(realParent, ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      missing.push(basename(candidate));
      candidate = parent;
    }
  }
}

function isWithin(parent: string, child: string): boolean {
  const relation = relative(parent, child);
  return (
    relation === "" ||
    (relation !== ".." &&
      !relation.startsWith(`..${sep}`) &&
      !isAbsolute(relation))
  );
}

function sameArtifact(left: ArtifactRef, right: ArtifactRef): boolean {
  return (
    left.artifact_id === right.artifact_id &&
    left.sha256 === right.sha256 &&
    left.media_type === right.media_type &&
    left.byte_length === right.byte_length
  );
}

async function readBounded(
  handle: FileHandle,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const length =
      total === maxBytes ? 1 : Math.min(64 * 1024, maxBytes - total);
    const chunk = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(chunk, 0, length, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > maxBytes)
      throw new LimitExceededError("File exceeds maxFileBytes");
    chunks.push(chunk.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, total);
}

async function recoverProviderState(
  rootDir: string,
  limits: WorkspaceLimits,
  extraIgnores: readonly string[],
): Promise<void> {
  const metas = await listMetas(rootDir);
  for (const meta of metas) {
    if (meta.restore_journal) {
      const workspace = workspacePath(rootDir, meta.workspace_id);
      const journal = meta.restore_journal;
      const backup = join(rootDir, "trash", journal.backup);
      const staging = join(rootDir, "staging", journal.staging);
      if (await fileExists(backup)) {
        await rm(workspace, { recursive: true, force: true });
        await mkdir(dirname(workspace), { recursive: true, mode: 0o700 });
        await rename(backup, workspace);
      }
      await rm(staging, { recursive: true, force: true });
      await rm(backup, { recursive: true, force: true });
      meta.counter = journal.previous.counter;
      meta.revision = journal.previous.revision;
      meta.tree_digest = journal.previous.tree_digest;
      delete meta.restore_journal;
      await saveMeta(rootDir, meta);
    }
    await resolveWorkspaceTree(rootDir, meta.workspace_id);
    if (meta.exec_in_progress) {
      const snapshot = await snapshotTree(
        workspacePath(rootDir, meta.workspace_id),
        {
          limits,
          extraIgnores,
          enforceLimits: false,
          includeData: false,
        },
      );
      meta.counter += 1;
      meta.tree_digest = snapshot.digest;
      meta.revision = revision(meta.counter, snapshot.digest);
      delete meta.exec_in_progress;
      await saveMeta(rootDir, meta);
    }
  }
  const recordedWorkspaces = new Set(metas.map((meta) => meta.workspace_id));
  for (const entry of await readdir(join(rootDir, "workspaces"), {
    withFileTypes: true,
  })) {
    if (
      entry.isDirectory() &&
      /^ws_[a-f0-9]{32}$/.test(entry.name) &&
      !recordedWorkspaces.has(entry.name)
    ) {
      await rm(join(rootDir, "workspaces", entry.name), {
        recursive: true,
        force: true,
      });
    }
  }
  for (const entry of await readdir(join(rootDir, "staging"))) {
    await rm(join(rootDir, "staging", entry), { recursive: true, force: true });
  }
  for (const entry of await readdir(join(rootDir, "trash"))) {
    await rm(join(rootDir, "trash", entry), { recursive: true, force: true });
  }
}

function validateManifestPaths(
  manifest: CheckpointManifest,
  limits: WorkspaceLimits,
  extraIgnores: readonly string[],
): void {
  const files = new Map<string, CheckpointManifest["files"][number]>();
  const dirs = new Set<string>();
  let total = 0;
  for (const directory of manifest.directories) {
    try {
      validateRelativePath(directory, limits, extraIgnores);
    } catch (error) {
      throw new IntegrityError(
        "Checkpoint contains an invalid directory path",
        { cause: error },
      );
    }
    if (dirs.has(directory))
      throw new IntegrityError("Checkpoint contains duplicate directories");
    dirs.add(directory);
  }
  if (
    manifest.directories.some(
      (path, index) => index > 0 && manifest.directories[index - 1]! > path,
    )
  ) {
    throw new IntegrityError("Checkpoint directories are not sorted");
  }
  for (const file of manifest.files) {
    try {
      validateRelativePath(file.path, limits, extraIgnores);
    } catch (error) {
      throw new IntegrityError("Checkpoint contains an invalid file path", {
        cause: error,
      });
    }
    if (files.has(file.path) || dirs.has(file.path)) {
      throw new IntegrityError(
        "Checkpoint contains duplicate or conflicting paths",
      );
    }
    files.set(file.path, file);
    if (file.blob.byte_length > limits.maxFileBytes) {
      throw new IntegrityError("Checkpoint file exceeds maxFileBytes");
    }
    total += file.blob.byte_length;
    if (files.size > limits.maxFiles || total > limits.maxTotalBytes) {
      throw new IntegrityError("Checkpoint exceeds workspace limits");
    }
  }
  for (const filePath of files.keys()) {
    const segments = filePath.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      const parent = segments.slice(0, index).join("/");
      if (!dirs.has(parent))
        throw new IntegrityError("Checkpoint omits a file parent directory");
      if (files.has(parent))
        throw new IntegrityError(
          "A checkpoint file is a parent of another file",
        );
    }
    if (dirs.has(filePath))
      throw new IntegrityError("Checkpoint path is both file and directory");
  }
  for (const directory of dirs) {
    const segments = directory.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      const parent = segments.slice(0, index).join("/");
      if (!dirs.has(parent))
        throw new IntegrityError("Checkpoint omits a directory parent");
      if (files.has(parent))
        throw new IntegrityError(
          "A checkpoint file is a parent of a directory",
        );
    }
  }
  if (
    manifest.files.some(
      (file, index) => index > 0 && manifest.files[index - 1]!.path > file.path,
    )
  ) {
    throw new IntegrityError("Checkpoint files are not sorted");
  }
}

function digestManifest(
  manifest: CheckpointManifest,
  files: readonly TreeFile[],
): string {
  const contentByPath = new Map(files.map((file) => [file.path, file]));
  const entries = [
    ...manifest.files.map((file) => ({
      path: file.path,
      line: `F\0${file.path}\0${file.mode}\0${contentByPath.get(file.path)!.sha256}\n`,
    })),
    ...manifest.directories.map((path) => ({ path, line: `D\0${path}\n` })),
  ];
  entries.sort((a, b) => compareStrings(a.path, b.path));
  return sha256(entries.map(({ line }) => line).join(""));
}

async function ensureParentDirectories(
  root: string,
  relativePath: string,
): Promise<void> {
  const segments = relativePath.split("/");
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new WorkspacePolicyError(
          "Workspace parent path is not a real directory",
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current, { mode: 0o700 });
    }
  }
}
