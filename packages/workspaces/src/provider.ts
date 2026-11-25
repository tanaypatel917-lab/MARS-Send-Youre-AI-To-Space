import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
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
import { sha256 } from "@mars/contracts/canonical";
import { isInsideOrEqual } from "@mars/contracts/path-containment";
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
import { isValidArgv } from "./sandbox";
import { searchWorkspaceTree } from "./search";
import {
  acquireProviderLock,
  CHECKPOINT_ID_PATTERN,
  type CheckpointRecord,
  listMetas,
  loadMeta,
  metaPath,
  newCheckpointId,
  newToken,
  newWorkspaceId,
  revision,
  saveMeta,
  WORKSPACE_ENTRY_PATTERN,
  WORKSPACE_ID_PATTERN,
  type WorkspaceMeta,
  workspacePath,
} from "./store";
import {
  assertArtifactBytes,
  compareStrings,
  DEFAULT_WORKSPACE_LIMITS,
  ensureDirectory,
  materializeSnapshot,
  snapshotTree,
  type TreeFile,
  type TreeSnapshot,
  type WorkspaceLimits,
} from "./tree";
import type {
  LocalWorkspaceProvider,
  LocalWorkspaceProviderOptions,
  SandboxRunResult,
  WorkspaceDiff,
} from "./types";

const checkpointManifestSchema = z
  .object({
    schema_version: z.literal(1),
    kind: z.literal("mars.workspace.checkpoint"),
    checkpoint_id: z.string().regex(CHECKPOINT_ID_PATTERN),
    workspace_id: z.string().regex(WORKSPACE_ID_PATTERN),
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

interface RecoveryState {
  lostWorkspaces: Set<string>;
  unreadableWorkspaces: Set<string>;
}

function createMutex(): Mutex {
  return { tail: Promise.resolve() };
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve() {
      if (!resolvePromise) throw new Error("Deferred promise is not ready");
      resolvePromise();
    },
  };
}

async function withMutex<T>(
  mutex: Mutex,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = mutex.tail;
  const release = createDeferred();
  mutex.tail = release.promise;
  await previous;
  try {
    return await operation();
  } finally {
    release.resolve();
  }
}

interface ResolvedProviderOptions {
  sourceRoot: string;
  rootDir: string;
  providerId: string;
  limits: WorkspaceLimits;
  extraIgnores: readonly string[];
}

async function resolveProviderOptions(
  options: LocalWorkspaceProviderOptions,
): Promise<ResolvedProviderOptions> {
  if (!isAbsolute(options.rootDir) || !isAbsolute(options.sourceRoot)) {
    throw new WorkspacePolicyError(
      "rootDir and sourceRoot must be absolute paths",
    );
  }
  const sourceRoot = await realDirectory(options.sourceRoot, "sourceRoot");
  const requestedRoot = resolve(options.rootDir);
  const rootCandidate = await resolveFromExistingParent(requestedRoot);
  if (
    isInsideOrEqual(rootCandidate, sourceRoot) ||
    isInsideOrEqual(sourceRoot, rootCandidate)
  ) {
    throw new WorkspacePolicyError(
      "rootDir and sourceRoot must not contain one another",
    );
  }
  await mkdir(requestedRoot, { recursive: true, mode: 0o700 });
  const rootDir = await realDirectory(options.rootDir, "rootDir");
  if (
    isInsideOrEqual(rootDir, sourceRoot) ||
    isInsideOrEqual(sourceRoot, rootDir)
  ) {
    throw new WorkspacePolicyError(
      "rootDir and sourceRoot must not contain one another",
    );
  }
  await chmod(rootDir, 0o700);
  if (options.sandbox && !/^[A-Za-z0-9._/-]+$/.test(rootDir)) {
    throw new WorkspacePolicyError(
      "rootDir contains characters unsafe for Docker mount arguments",
    );
  }
  const providerId = options.providerId ?? "mars-local-workspace";
  if (!/^[a-z0-9][a-z0-9.-]{0,63}$/.test(providerId)) {
    throw new WorkspacePolicyError("Invalid providerId");
  }
  const limits: WorkspaceLimits = {
    ...DEFAULT_WORKSPACE_LIMITS,
    ...options.limits,
  };
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
  return { sourceRoot, rootDir, providerId, limits, extraIgnores };
}

export async function createLocalWorkspaceProvider(
  options: LocalWorkspaceProviderOptions,
): Promise<LocalWorkspaceProvider> {
  const { sourceRoot, rootDir, providerId, limits, extraIgnores } =
    await resolveProviderOptions(options);
  // Identifies sandbox containers owned by this provider root; startup
  // cleanup matches on it to remove containers leaked by a previous process.
  const rootLabels = { "mars.root": sha256(rootDir).slice(0, 16) };
  const releaseLock = await acquireProviderLock(rootDir);
  let recoveryState: RecoveryState;
  try {
    for (const directory of ["meta", "workspaces", "staging", "trash"]) {
      await ensureDirectory(join(rootDir, directory));
    }
    if (options.sandbox) {
      await options.sandbox.cleanup(rootLabels);
    }
    recoveryState = await recoverProviderState(
      rootDir,
      limits,
      extraIgnores,
      options.testHooks,
    );
  } catch (error) {
    await releaseLock();
    throw error;
  }

  const { lostWorkspaces, unreadableWorkspaces } = recoveryState;
  const locks = new Map<string, Mutex>();
  const prepareMutex = createMutex();
  const activeRuns = new Map<string, ActiveRun>();
  const now = options.now ?? (() => new Date());
  const inFlight = new Set<Promise<unknown>>();
  let closed = false;
  let closing: Promise<void> | undefined;
  const assertOpen = (): void => {
    if (closed)
      throw new SandboxUnavailableError("Workspace provider is closed");
  };
  const track = <T>(fn: () => Promise<T>): Promise<T> => {
    if (closed)
      return Promise.reject(
        new SandboxUnavailableError("Workspace provider is closed"),
      );
    const operation = Promise.resolve().then(fn);
    inFlight.add(operation);
    void operation.finally(() => inFlight.delete(operation)).catch(() => {});
    return operation;
  };
  const assertWorkspaceNotLost = (workspaceId: string): void => {
    if (lostWorkspaces.has(workspaceId))
      throw new IntegrityError("workspace state lost");
  };
  const markUndoFailed = (
    workspaceId: string,
    error: unknown,
    undoError: unknown,
  ): unknown => {
    lostWorkspaces.add(workspaceId);
    return withUndoFailure(error, undoError);
  };
  const assertNoUnreadableMetadata = (): void => {
    if (unreadableWorkspaces.size > 0)
      throw new IntegrityError("workspace state lost");
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
    verifyContext(context);
    const workspaceId =
      typeof workspace === "string" ? workspace : workspace?.workspace_id;
    if (
      typeof workspaceId !== "string" ||
      !WORKSPACE_ID_PATTERN.test(workspaceId) ||
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
    assertWorkspaceNotLost(workspaceId);
    if (!allowRestoreJournal) await assertWorkspaceAvailable(meta);
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
    assertWorkspaceNotLost(meta.workspace_id);
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
    assertOpen();
    assertWorkspaceNotLost(workspaceId);
    try {
      return await loadMeta(rootDir, workspaceId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new IntegrityError("workspace state lost", { cause: error });
      }
      throw error;
    }
  };
  // Shared prologue for workspace-scoped methods: scope/ownership check, then
  // under the workspace lock a closed check, metadata reload and availability
  // check. `reload: "scoped"` re-runs the scope check instead of the plain
  // metadata reload.
  const withWorkspace = async <T>(
    context: RequestContext,
    workspace: WorkspaceRef | string,
    fn: (current: WorkspaceMeta, tree: string) => T | Promise<T>,
    {
      allowRestoreJournal = false,
      reload = "meta",
    }: { allowRestoreJournal?: boolean; reload?: "meta" | "scoped" } = {},
  ): Promise<T> => {
    const meta = await assertWorkspace(context, workspace, allowRestoreJournal);
    return withMutex(lockFor(meta.workspace_id), async () => {
      assertOpen();
      const current =
        reload === "scoped"
          ? await assertWorkspace(context, workspace, allowRestoreJournal)
          : await reloadWorkspaceMeta(meta.workspace_id);
      const tree = await assertWorkspaceAvailable(current);
      return fn(current, tree);
    });
  };
  const treeSnapshot = (
    meta: WorkspaceMeta,
    enforceLimits = true,
    includeData = true,
  ): Promise<TreeSnapshot> => {
    const skipped: NonNullable<TreeSnapshot["skipped"]> = [];
    return snapshotTree(treeDir(meta), {
      limits,
      extraIgnores,
      enforceLimits,
      includeData,
      tolerateUnsupportedNames: true,
      skipped,
    });
  };

  // Crash-consistent commit of one tree mutation: the write_in_progress marker
  // is persisted before `apply` and cleared with the counter/revision bump.
  // On failure the tree change is undone and the metadata rolled back; if
  // either rollback fails the workspace is marked lost. `apply` may hard-link
  // the original file into `priorPath`, which is removed unless a failed
  // undo left it as the file's only copy.
  const commitTreeMutation = async (
    current: WorkspaceMeta,
    mutation: {
      apply: (priorPath: string) => Promise<void>;
      undo: (priorPath: string) => Promise<void>;
      phaseHook?: () => void | Promise<void>;
    },
  ): Promise<void> => {
    const priorPath = join(
      rootDir,
      "staging",
      `${current.workspace_id}-prior-${newToken()}`,
    );
    const previous = {
      counter: current.counter,
      revision: current.revision,
      tree_digest: current.tree_digest,
      skipped: current.skipped,
    };
    let markerSaved = false;
    let applied = false;
    let committed = false;
    try {
      current.write_in_progress = { started_at: now().toISOString() };
      await saveMeta(rootDir, current);
      markerSaved = true;
      await mutation.apply(priorPath);
      applied = true;
      await mutation.phaseHook?.();
      const after = await treeSnapshot(current, true, false);
      updateUnsupportedSkipped(current, after);
      current.counter += 1;
      current.tree_digest = after.digest;
      current.revision = revision(current.counter, after.digest);
      delete current.write_in_progress;
      await saveMeta(rootDir, current);
      committed = true;
    } catch (error) {
      if (applied) {
        try {
          await mutation.undo(priorPath);
          applied = false;
        } catch (undoError) {
          throw markUndoFailed(current.workspace_id, error, undoError);
        }
      }
      if (markerSaved) {
        current.counter = previous.counter;
        current.revision = previous.revision;
        current.tree_digest = previous.tree_digest;
        current.skipped = previous.skipped;
        delete current.write_in_progress;
        try {
          await saveMeta(rootDir, current);
        } catch (undoError) {
          current.write_in_progress = {
            started_at: now().toISOString(),
          };
          throw markUndoFailed(current.workspace_id, error, undoError);
        }
      }
      throw error;
    } finally {
      if (committed || !applied)
        await rm(priorPath, { force: true }).catch(() => undefined);
    }
  };

  const validateArtifact = (artifact: ArtifactRef): ArtifactRef => {
    const parsed = ArtifactRefSchema.safeParse(artifact);
    if (!parsed.success)
      throw new IntegrityError("Invalid artifact reference", {
        cause: parsed.error,
      });
    return parsed.data;
  };

  const updateUnsupportedSkipped = (
    meta: WorkspaceMeta,
    snapshot: TreeSnapshot,
  ): void => {
    meta.skipped = [
      ...meta.skipped.filter((entry) => entry.reason !== "unsupported-name"),
      ...(snapshot.skipped ?? []).filter(
        (entry) => entry.reason === "unsupported-name",
      ),
    ];
  };

  const storeCheckpoint = async (
    context: RequestContext,
    meta: WorkspaceMeta,
    snapshot: TreeSnapshot,
    persist = true,
  ): Promise<CheckpointRef> => {
    const checkpointId = newCheckpointId();
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
      !CHECKPOINT_ID_PATTERN.test(checkpoint.checkpoint_id) ||
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

  const makeCheckpointForPublic = async (
    context: RequestContext,
    workspace: WorkspaceRef,
  ): Promise<CheckpointRef> => {
    return withWorkspace(context, workspace, async (fresh) => {
      const snapshot = await treeSnapshot(fresh, true, true);
      if (fresh.tree_digest !== snapshot.digest) {
        fresh.tree_digest = snapshot.digest;
        fresh.revision = revision(fresh.counter, snapshot.digest);
        await saveMeta(rootDir, fresh);
      }
      return storeCheckpoint(context, fresh, snapshot);
    });
  };

  const provider: LocalWorkspaceProvider = {
    providerId,
    async prepare(context, taskId) {
      return withMutex(prepareMutex, async () => {
        assertOpen();
        verifyContext(context);
        assertTaskId(taskId);
        assertNoUnreadableMetadata();
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
            assertOpen();
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
          reason: "symlink" | "special" | "ignored-secret" | "unsupported-name";
        }> = [];
        const snapshot = await snapshotTree(sourceRoot, {
          limits,
          extraIgnores,
          enforceLimits: true,
          skipped: skippedFiles,
        });
        const workspaceId = newWorkspaceId();
        const stageName = `${workspaceId}-${newToken()}`;
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
            baseline_checkpoint_id: newCheckpointId(),
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
    async search(context, workspace, request) {
      return withWorkspace(context, workspace, (_current, tree) =>
        searchWorkspaceTree(tree, request, limits, extraIgnores),
      );
    },
    async read(context, workspace, relativePath) {
      return withWorkspace(context, workspace, async (current) => {
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
      return withWorkspace(context, workspace, async (current) => {
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
          rootDir,
          "staging",
          `${current.workspace_id}-write-${newToken()}`,
        );
        let handle: FileHandle | undefined;
        try {
          handle = await open(temporary, "wx", mode);
          await handle.writeFile(data);
          await options.testHooks?.writePhase?.("before-sync");
          await handle.sync();
          await handle.chmod(mode);
          await handle.close();
          handle = undefined;
        } catch (error) {
          await handle?.close().catch(() => undefined);
          await rm(temporary, { force: true }).catch(() => undefined);
          throw error;
        }
        try {
          await commitTreeMutation(current, {
            apply: async (priorPath) => {
              if (existing) await link(absolute, priorPath);
              await rename(temporary, absolute);
            },
            undo: async (priorPath) => {
              if (existing) await rename(priorPath, absolute);
              else await rm(absolute, { force: true });
            },
            phaseHook: () => options.testHooks?.writePhase?.("after-rename"),
          });
        } finally {
          await rm(temporary, { force: true }).catch(() => undefined);
        }
      });
    },
    async remove(context, workspace, relativePath) {
      return withWorkspace(context, workspace, async (current) => {
        const path = validateRelativePath(relativePath, limits, extraIgnores);
        const tree = treeDir(current);
        const absolute = await resolveSafePath(tree, path);
        const existing = await lstat(absolute).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return undefined;
            throw error;
          },
        );
        if (!existing) throw new WorkspaceNotFoundError();
        if (!existing.isFile())
          throw new WorkspacePolicyError(
            "Workspace remove target is not a regular file",
          );
        await commitTreeMutation(current, {
          apply: async (priorPath) => {
            await link(absolute, priorPath);
            await rm(absolute);
          },
          undo: (priorPath) => rename(priorPath, absolute),
          phaseHook: () => options.testHooks?.removePhase?.("after-remove"),
        });
      });
    },
    async runCheck(context, workspace, request) {
      return withWorkspace(context, workspace, async (current) => {
        if (workspace.revision !== current.revision)
          throw new RevisionConflictError();
        if (!isValidArgv(request.argv))
          throw new WorkspacePolicyError("Invalid command arguments");
        if (!options.sandbox)
          throw new SandboxUnavailableError("No sandbox is configured");
        const snapshot = await treeSnapshot(current, true, true);
        if (snapshot.digest !== current.tree_digest)
          throw new WorkspaceModifiedError();
        try {
          await options.sandbox.verify();
        } catch (error) {
          if (error instanceof SandboxUnavailableError) throw error;
          throw new SandboxUnavailableError("Sandbox verification failed", {
            cause: error,
          });
        }
        // The copy holds only snapshot files (ignored secrets never leave the
        // candidate) and lives outside every workspace tree.
        const copy = await mkdtemp(join(tmpdir(), "mars-check-"));
        try {
          const place = async (
            path: string,
            data: Uint8Array,
            mode: number,
          ) => {
            const target = await resolveSafePath(
              copy,
              validateRelativePath(path, limits, extraIgnores),
            );
            await mkdir(dirname(target), { recursive: true });
            await rm(target, { force: true });
            await writeFile(target, data, { mode });
          };
          const excluded = (path: string) =>
            (request.exclude ?? []).some((rule) =>
              rule.endsWith("/") ? path.startsWith(rule) : path === rule,
            );
          for (const file of snapshot.files)
            if (file.data && !excluded(file.path))
              await place(file.path, file.data, file.mode);
          for (const file of request.overlay)
            await place(file.path, file.data, 0o644);
          const timeoutMs = Math.min(request.timeoutMs, limits.maxExecutionMs);
          const controller = new AbortController();
          const abort = (): void => controller.abort(request.signal?.reason);
          request.signal?.addEventListener("abort", abort, { once: true });
          if (request.signal?.aborted) abort();
          try {
            const result = await options.sandbox.run({
              workspaceDir: copy,
              argv: [...request.argv],
              timeoutMs,
              maxOutputBytes: limits.maxOutputBytes,
              signal: controller.signal,
              runId: newToken(),
              labels: {
                "mars.workspace": current.workspace_id,
                "mars.check": "1",
                ...rootLabels,
              },
            });
            return {
              workspace: currentRef(current),
              exit_code: result.timedOut
                ? 124
                : result.cancelled
                  ? 130
                  : result.exitCode,
              stdout: result.stdout.subarray(0, limits.maxOutputBytes),
              stderr: result.stderr.subarray(0, limits.maxOutputBytes),
              timed_out: result.timedOut,
              cancelled: result.cancelled,
            };
          } finally {
            request.signal?.removeEventListener("abort", abort);
          }
        } finally {
          await rm(copy, { recursive: true, force: true });
        }
      });
    },
    async exportPatch(context, workspace, exportOptions) {
      return withWorkspace(context, workspace, async (current) => {
        if (workspace.revision !== current.revision)
          throw new RevisionConflictError();
        const base = await baselineRef(context, current);
        const { manifest, files: baseFiles } = await getCheckpoint(
          context,
          current,
          base,
        );
        const snapshot = await treeSnapshot(current, true, true);
        if (snapshot.digest !== current.tree_digest)
          throw new WorkspaceModifiedError();
        const diff = createWorkspaceDiff(baseFiles, snapshot.files);
        const patch = new TextEncoder().encode(
          diff.files.map((file) => file.patch).join(""),
        );
        const binary = diff.files
          .filter((file) => /^Binary files .* differ$/m.test(file.patch))
          .map((file) => file.path);
        const unsupported = [
          ...current.skipped.map((entry) => ({
            path: entry.path,
            reason: entry.reason,
          })),
          ...binary.map((path) => ({ path, reason: "binary content" })),
        ];
        const scratch = await mkdtemp(join(tmpdir(), "mars-export-"));
        const roundTrip = async (): Promise<{
          status: "passed" | "failed" | "unavailable";
          reason: string | null;
        }> => {
          if (binary.length)
            return {
              status: "unavailable",
              reason: `Binary files have no text patch: ${binary.slice(0, 20).join(", ")}`,
            };
          const tree = join(scratch, "tree");
          await mkdir(tree, { recursive: true });
          for (const file of baseFiles) {
            if (!file.data) continue;
            const target = join(tree, file.path);
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, file.data, { mode: file.mode });
            await chmod(target, file.mode);
          }
          if (patch.byteLength > 0) {
            const patchFile = join(scratch, "candidate.patch");
            await writeFile(patchFile, patch);
            for (const args of [["--check"], []]) {
              let proc: ReturnType<typeof Bun.spawnSync>;
              try {
                proc = Bun.spawnSync(
                  ["git", "apply", "--unsafe-paths", ...args, patchFile],
                  {
                    cwd: tree,
                    stdout: "pipe",
                    stderr: "pipe",
                    env: { PATH: process.env.PATH ?? "" },
                  },
                );
              } catch {
                return {
                  status: "unavailable",
                  reason: "git is not available",
                };
              }
              if (proc.exitCode !== 0)
                return {
                  status: "failed",
                  reason: `git apply ${args.join(" ") || "(apply)"} exited ${proc.exitCode}: ${new TextDecoder().decode(proc.stderr ?? new Uint8Array()).slice(0, 512)}`,
                };
            }
          }
          const rebuilt = await snapshotTree(tree, {
            limits,
            extraIgnores,
            includeData: false,
            tolerateUnsupportedNames: true,
          });
          const expected = new Map(
            snapshot.files.map((file) => [file.path, file]),
          );
          const mismatches: string[] = [];
          for (const file of rebuilt.files) {
            const want = expected.get(file.path);
            expected.delete(file.path);
            if (!want || want.sha256 !== file.sha256 || want.mode !== file.mode)
              mismatches.push(file.path);
          }
          mismatches.push(...expected.keys());
          return mismatches.length
            ? {
                status: "failed",
                reason: `Reconstructed tree differs at: ${mismatches.slice(0, 20).join(", ")}`,
              }
            : { status: "passed", reason: null };
        };
        try {
          const proof = await roundTrip();
          const source = exportOptions?.compareSourceBaseline
            ? await snapshotTree(sourceRoot, {
                limits,
                extraIgnores,
                includeData: false,
              }).catch(() => null)
            : undefined;
          return {
            workspace: currentRef(current),
            patch,
            files: diff.files.length,
            round_trip: proof,
            unsupported,
            ...(source === undefined
              ? {}
              : {
                  source_baseline: !source
                    ? "unavailable"
                    : source.digest === manifest.tree_digest
                      ? "matches"
                      : "mismatch",
                }),
          };
        } finally {
          await rm(scratch, { recursive: true, force: true });
        }
      });
    },
    async execute(context, workspace, argv, budget, executeOptions) {
      return withWorkspace(context, workspace, async (current) => {
        if (!isValidArgv(argv))
          throw new WorkspacePolicyError("Invalid command arguments");
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
        const runId = newToken();
        const startedAt = now().toISOString();
        const controller = new AbortController();
        const completion = createDeferred();
        const active: ActiveRun = {
          controller,
          done: completion.promise,
          resolveDone: completion.resolve,
        };
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
        const reconcileExecution = async (): Promise<void> => {
          let after: TreeSnapshot;
          try {
            after = await treeSnapshot(current, false, false);
          } catch (error) {
            lostWorkspaces.add(current.workspace_id);
            throw new IntegrityError("workspace state lost", {
              cause: error,
            });
          }
          updateUnsupportedSkipped(current, after);
          current.counter += 1;
          current.tree_digest = after.digest;
          current.revision = revision(current.counter, after.digest);
          delete current.exec_in_progress;
          await saveMeta(rootDir, current);
        };
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
                ...rootLabels,
              },
            });
          } catch (error) {
            await reconcileExecution();
            throw error;
          }
          await reconcileExecution();
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
      return withWorkspace(context, checkpoint.workspace, async (current) => {
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
        const stageName = `${current.workspace_id}-${newToken()}`;
        const backupName = `${current.workspace_id}-${newToken()}`;
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
          current.skipped = current.skipped.filter(
            (entry) => entry.reason !== "unsupported-name",
          );
          delete current.restore_journal;
          await saveMeta(rootDir, current);
        } catch (error) {
          if ((error as Error)?.name !== "SimulatedCrash") {
            try {
              const latest = await loadMeta(rootDir, current.workspace_id);
              await rollbackRestoreJournal(
                rootDir,
                latest,
                limits,
                extraIgnores,
                options.testHooks,
              );
            } catch (rollbackError) {
              throw markUndoFailed(current.workspace_id, error, rollbackError);
            }
          }
          throw error;
        }
        await invokeRestoreHook("committed");
        // The restore is committed; leftovers are swept by startup recovery.
        await rm(backupDir, { recursive: true, force: true }).catch(
          () => undefined,
        );
        await rm(stagingDir, { recursive: true, force: true }).catch(
          () => undefined,
        );
        return currentRef(current);
      });
    },
    async diff(context, workspace, diffOptions): Promise<WorkspaceDiff> {
      return withWorkspace(context, workspace, async (current) => {
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
      return withWorkspace(context, workspace, async (current) => {
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
        const patchArtifact = result[0];
        if (!patchArtifact)
          throw new IntegrityError("Workspace patch artifact is missing");
        assertArtifactBytes(new TextEncoder().encode(patch), patchArtifact);
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
      assertNoUnreadableMetadata();
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
        assertOpen();
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
      return withWorkspace(context, workspaceId, async (current) => {
        return currentRef(current);
      });
    },
    async workspacePath(context, workspace) {
      return withWorkspace(context, workspace, (_current, tree) => tree, {
        allowRestoreJournal: true,
        reload: "scoped",
      });
    },
    async checkpoints(context, workspace) {
      return withWorkspace(context, workspace, async (current) => {
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
      return withWorkspace(context, workspace, async (current) => {
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
      if (closing) return closing;
      if (closed) return;
      closed = true;
      for (const active of activeRuns.values())
        active.controller.abort(new Error("Provider closed"));
      closing = (async () => {
        try {
          await Promise.allSettled([...inFlight]);
          await Promise.all(
            [...activeRuns.values()].map((active) => active.done),
          );
        } finally {
          await releaseLock();
        }
      })();
      return closing;
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
  return {
    ...provider,
    prepare: (...args) => track(() => provider.prepare(...args)),
    read: (...args) => track(() => provider.read(...args)),
    write: (...args) => track(() => provider.write(...args)),
    remove: (...args) => track(() => provider.remove(...args)),
    execute: (...args) => track(() => provider.execute(...args)),
    checkpoint: (...args) => track(() => provider.checkpoint(...args)),
    restore: (...args) => track(() => provider.restore(...args)),
    diff: (...args) => track(() => provider.diff(...args)),
    collect: (...args) => track(() => provider.collect(...args)),
    discover: (...args) => track(() => provider.discover(...args)),
    inspect: (...args) => track(() => provider.inspect(...args)),
    workspacePath: (...args) => track(() => provider.workspacePath(...args)),
    checkpoints: (...args) => track(() => provider.checkpoints(...args)),
    skipped: (...args) => track(() => provider.skipped(...args)),
    stop: (...args) => track(() => provider.stop(...args)),
  };
}

async function realDirectory(path: string, label: string): Promise<string> {
  let real: string;
  try {
    real = await realpath(path);
  } catch {
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
  hooks: LocalWorkspaceProviderOptions["testHooks"],
): Promise<RecoveryState> {
  const lostWorkspaces = new Set<string>();
  const unreadableWorkspaces = new Set<string>();
  const metadataDirectories = new Set<string>();
  const readableMetas = new Map<string, WorkspaceMeta>();

  try {
    for (const entry of await readdir(join(rootDir, "meta"), {
      withFileTypes: true,
    })) {
      if (!WORKSPACE_ID_PATTERN.test(entry.name)) continue;
      const metadataDirectory = join(rootDir, "meta", entry.name);
      metadataDirectories.add(entry.name);
      try {
        const directoryStat = await lstat(metadataDirectory);
        if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
          throw new IntegrityError("workspace state lost");
        }

        const metadataFile = metaPath(rootDir, entry.name);
        let metadataStat: Awaited<ReturnType<typeof lstat>> | undefined;
        try {
          metadataStat = await lstat(metadataFile);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (!metadataStat) {
          const treeStatus = await workspaceTreeStatus(rootDir, entry.name);
          if (treeStatus === "missing") {
            await rm(metadataDirectory, { recursive: true, force: true });
            metadataDirectories.delete(entry.name);
            continue;
          }
          throw new IntegrityError("workspace state lost");
        }
        if (!metadataStat.isFile() || metadataStat.isSymbolicLink()) {
          throw new IntegrityError("workspace state lost");
        }
        const meta = await loadMeta(rootDir, entry.name);
        if (meta.workspace_id !== entry.name) {
          throw new IntegrityError("workspace state lost");
        }
        readableMetas.set(meta.workspace_id, meta);
      } catch {
        lostWorkspaces.add(entry.name);
        unreadableWorkspaces.add(entry.name);
      }
    }

    for (const meta of readableMetas.values()) {
      try {
        if (meta.restore_journal) {
          await rollbackRestoreJournal(
            rootDir,
            meta,
            limits,
            extraIgnores,
            hooks,
          );
        }
        await resolveWorkspaceTree(rootDir, meta.workspace_id);
        if (meta.exec_in_progress || meta.write_in_progress) {
          const skipped: NonNullable<TreeSnapshot["skipped"]> = [];
          const snapshot = await snapshotTree(
            workspacePath(rootDir, meta.workspace_id),
            {
              limits,
              extraIgnores,
              enforceLimits: false,
              includeData: false,
              tolerateUnsupportedNames: true,
              skipped,
            },
          );
          meta.skipped = [
            ...meta.skipped.filter(
              (entry) => entry.reason !== "unsupported-name",
            ),
            ...skipped.filter((entry) => entry.reason === "unsupported-name"),
          ];
          meta.counter += 1;
          meta.tree_digest = snapshot.digest;
          meta.revision = revision(meta.counter, snapshot.digest);
          delete meta.exec_in_progress;
          delete meta.write_in_progress;
          await saveMeta(rootDir, meta);
        }
      } catch {
        lostWorkspaces.add(meta.workspace_id);
      }
    }

    for (const entry of await readdir(join(rootDir, "workspaces"), {
      withFileTypes: true,
    })) {
      if (!WORKSPACE_ID_PATTERN.test(entry.name)) continue;
      if (metadataDirectories.has(entry.name)) continue;
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        lostWorkspaces.add(entry.name);
        unreadableWorkspaces.add(entry.name);
        continue;
      }
      await rm(join(rootDir, "workspaces", entry.name), {
        recursive: true,
        force: true,
      });
    }
  } finally {
    await cleanupRecoveryDirectories(rootDir, readableMetas, lostWorkspaces);
  }

  return { lostWorkspaces, unreadableWorkspaces };
}

/**
 * Keeps the original failure as the thrown error and records the failed undo
 * as its `cause`, alongside any cause the original already carried.
 */
function withUndoFailure(error: unknown, undoError: unknown): unknown {
  if (!(error instanceof Error))
    return new AggregateError(
      [error, undoError],
      "Operation failed and its undo also failed",
    );
  error.cause =
    error.cause === undefined
      ? undoError
      : new AggregateError(
          [error.cause, undoError],
          "Original cause and undo failure",
        );
  return error;
}

async function rollbackRestoreJournal(
  rootDir: string,
  meta: WorkspaceMeta,
  limits: WorkspaceLimits,
  extraIgnores: readonly string[],
  hooks: LocalWorkspaceProviderOptions["testHooks"],
): Promise<void> {
  const journal = meta.restore_journal;
  if (!journal) return;
  const workspace = workspacePath(rootDir, meta.workspace_id);
  const backup = join(rootDir, "trash", journal.backup);
  const staging = join(rootDir, "staging", journal.staging);
  let aside: string | undefined;
  let backupMoved = false;
  let committed = false;
  let digestMismatch = false;

  try {
    if (await pathExists(backup)) {
      if (await pathExists(workspace)) {
        aside = join(
          rootDir,
          "trash",
          `${meta.workspace_id}-aside-${newToken()}`,
        );
        await rename(workspace, aside);
      }
      await mkdir(dirname(workspace), { recursive: true, mode: 0o700 });
      await hooks?.recoveryPhase?.("before-rollback-rename");
      await rename(backup, workspace);
      backupMoved = true;
    } else if (!(await isRealDirectory(workspace))) {
      throw new IntegrityError("workspace state lost");
    }

    await resolveWorkspaceTree(rootDir, meta.workspace_id);
    const snapshot = await snapshotTree(workspace, {
      limits,
      extraIgnores,
      enforceLimits: false,
      includeData: false,
      tolerateUnsupportedNames: true,
    });
    if (snapshot.digest !== journal.previous.tree_digest) {
      digestMismatch = true;
      throw new IntegrityError("workspace state lost");
    }

    const recoveredMeta: WorkspaceMeta = {
      ...meta,
      counter: journal.previous.counter,
      revision: journal.previous.revision,
      tree_digest: journal.previous.tree_digest,
    };
    delete recoveredMeta.restore_journal;
    await saveMeta(rootDir, recoveredMeta);
    Object.assign(meta, recoveredMeta);
    delete meta.restore_journal;
    committed = true;
  } catch (error) {
    const undoFailures: unknown[] = [];
    if (!committed && backupMoved) {
      try {
        if (!(await pathExists(backup)) && (await pathExists(workspace)))
          await rename(workspace, backup);
      } catch (undoError) {
        undoFailures.push(undoError);
      }
    }
    if (!committed && aside && !digestMismatch) {
      try {
        if ((await pathExists(aside)) && !(await pathExists(workspace))) {
          await mkdir(dirname(workspace), { recursive: true, mode: 0o700 });
          await rename(aside, workspace);
        }
      } catch (undoError) {
        undoFailures.push(undoError);
      }
    }
    if (undoFailures.length > 0)
      throw withUndoFailure(
        error,
        undoFailures.length === 1
          ? undoFailures[0]
          : new AggregateError(undoFailures, "Restore rollback undo failed"),
      );
    throw error;
  }

  await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  const trash = join(rootDir, "trash");
  const asidePrefix = `${meta.workspace_id}-aside-`;
  for (const entry of await readdir(trash).catch(() => [])) {
    if (entry.startsWith(asidePrefix))
      await rm(join(trash, entry), { recursive: true, force: true }).catch(
        () => undefined,
      );
  }
}

async function workspaceTreeStatus(
  rootDir: string,
  workspaceId: string,
): Promise<"missing" | "valid" | "invalid"> {
  const workspaceDirectory = join(rootDir, "workspaces", workspaceId);
  let directoryStat: Awaited<ReturnType<typeof lstat>>;
  try {
    directoryStat = await lstat(workspaceDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
    return "invalid";

  try {
    const treeStat = await lstat(workspacePath(rootDir, workspaceId));
    return treeStat.isDirectory() && !treeStat.isSymbolicLink()
      ? "valid"
      : "invalid";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

async function cleanupRecoveryDirectories(
  rootDir: string,
  readableMetas: ReadonlyMap<string, WorkspaceMeta>,
  lostWorkspaces: ReadonlySet<string>,
): Promise<void> {
  for (const directory of ["staging", "trash"]) {
    const directoryPath = join(rootDir, directory);
    const entries = await readdir(directoryPath).catch(() => []);
    for (const entry of entries) {
      const match = WORKSPACE_ENTRY_PATTERN.exec(entry);
      const workspaceId = match?.[1];
      if (!workspaceId) continue;
      const meta = readableMetas.get(workspaceId);
      let shouldDelete =
        meta !== undefined &&
        !lostWorkspaces.has(workspaceId) &&
        meta.restore_journal === undefined;
      if (!shouldDelete) {
        const [metaExists, workspaceExists] = await Promise.all([
          pathExists(join(rootDir, "meta", workspaceId)).catch(() => true),
          pathExists(join(rootDir, "workspaces", workspaceId)).catch(
            () => true,
          ),
        ]);
        shouldDelete = !metaExists && !workspaceExists;
      }
      if (shouldDelete)
        await rm(join(rootDir, directory, entry), {
          recursive: true,
          force: true,
        }).catch(() => undefined);
    }
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function isRealDirectory(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
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
  for (let index = 1; index < manifest.directories.length; index += 1) {
    const previous = manifest.directories[index - 1];
    const current = manifest.directories[index];
    if (previous !== undefined && current !== undefined && previous > current) {
      throw new IntegrityError("Checkpoint directories are not sorted");
    }
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
  for (let index = 1; index < manifest.files.length; index += 1) {
    const previous = manifest.files[index - 1];
    const current = manifest.files[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      previous.path > current.path
    ) {
      throw new IntegrityError("Checkpoint files are not sorted");
    }
  }
}

function digestManifest(
  manifest: CheckpointManifest,
  files: readonly TreeFile[],
): string {
  const contentByPath = new Map(files.map((file) => [file.path, file]));
  const entries = [
    ...manifest.files.map((file) => {
      const content = contentByPath.get(file.path);
      if (!content)
        throw new IntegrityError("Checkpoint file content is missing");
      return {
        path: file.path,
        line: `F\0${file.path}\0${file.mode}\0${content.sha256}\n`,
      };
    }),
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
