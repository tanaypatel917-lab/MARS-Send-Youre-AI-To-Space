import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type ArtifactRef,
  ArtifactRefSchema,
  BudgetSchema,
  type CheckpointRef,
  type RequestContext,
  type WorkspaceRef,
} from "@mars/contracts";
import {
  type ArtifactStore,
  assertArtifactBytes,
  type CheckRunResult,
  type CommandApprover,
  CommandNotApprovedError,
  createWorkspaceDiff,
  DEFAULT_WORKSPACE_LIMITS,
  IntegrityError,
  isValidArgv,
  LimitExceededError,
  type LocalExecutionResult,
  type LocalWorkspaceProvider,
  type PatchExportResult,
  RevisionConflictError,
  SandboxUnavailableError,
  snapshotTree,
  type TreeFile,
  validateRelativePath,
  type WorkspaceDiff,
  type WorkspaceLimits,
  WorkspaceModifiedError,
  WorkspaceNotFoundError,
  WorkspacePolicyError,
} from "@mars/workspaces";
import { z } from "zod";
import {
  type AgentServerClient,
  type AgentServerInfo,
  assertRemotePath,
} from "./client";
import { describeIsolation, type IsolationReport } from "./isolation";
import { roundTripPatch } from "./round-trip";
import {
  buildManifest,
  parseScan,
  ScanParseError,
  type ScanResult,
  scanCommand,
  sha256Hex,
  shellQuote,
} from "./shell";
import {
  type ManifestFile,
  openRemoteWorkspaceStore,
  type TreeManifest,
  type WorkspaceRow,
} from "./store";

export const REMOTE_PROVIDER_ID = "openhands-remote";
export const CHECKPOINT_MEDIA_TYPE =
  "application/vnd.mars.remote-workspace-checkpoint+json";

export interface RemoteWorkspaceProviderOptions {
  /** Local state: SQLite store and the derived read-only mirror. */
  rootDir: string;
  sourceRoot: string;
  artifacts: ArtifactStore;
  client: AgentServerClient;
  /** Absolute directory on the Agent Server host under which all workspaces live. */
  remoteRoot: string;
  providerId?: string;
  limits?: Partial<WorkspaceLimits>;
  extraIgnores?: readonly string[];
  approveCommand?: CommandApprover;
  now?: () => Date;
  /** Poll interval for bash output, in ms. */
  pollIntervalMs?: number;
  /** Bound for one tree scan's output. */
  maxScanBytes?: number;
}

export interface RemoteWorkspaceProvider
  extends Omit<LocalWorkspaceProvider, "search"> {
  readonly serverInfo: AgentServerInfo;
  isolation(): IsolationReport;
}

const CheckpointManifestSchema = z
  .object({
    kind: z.literal("mars.remote-workspace.checkpoint"),
    schema_version: z.literal(1),
    workspace_id: z.string(),
    checkpoint_id: z.string(),
    revision: z.string(),
    tree_digest: z.string().regex(/^[a-f0-9]{64}$/),
    files: z.array(
      z
        .object({
          path: z.string(),
          mode: z.union([z.literal(420), z.literal(493)]),
          artifact: ArtifactRefSchema,
        })
        .strict(),
    ),
    directories: z.array(z.string()),
  })
  .strict();

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CHUNK = 200;

interface RemoteRun {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  cancelled: boolean;
}

function revisionOf(counter: number, digest: string): string {
  return `${counter}.${digest.slice(0, 16)}`;
}

function newToken(): string {
  return randomUUID().replaceAll("-", "");
}

function createMutex() {
  const tails = new Map<string, Promise<unknown>>();
  return async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const previous = tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => next);
    tails.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
}

function appendBounded(
  target: { parts: Uint8Array[]; size: number; truncated: boolean },
  text: string,
  limit: number,
): void {
  if (!text) return;
  const bytes = new TextEncoder().encode(text);
  const room = limit - target.size;
  if (room <= 0) {
    target.truncated = true;
    return;
  }
  const part = bytes.byteLength > room ? bytes.subarray(0, room) : bytes;
  if (part.byteLength < bytes.byteLength) target.truncated = true;
  target.parts.push(part);
  target.size += part.byteLength;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(
    parts.reduce((sum, part) => sum + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function ancestors(path: string): string[] {
  const parts = path.split("/");
  return parts
    .slice(0, -1)
    .map((_, index) => parts.slice(0, index + 1).join("/"));
}

/**
 * Remote workspace provider over the pinned OpenHands Agent Server wire
 * protocol. MARS keeps identity, revisions, checkpoints and policy; the
 * server only stores bytes and runs commands. Every server answer that
 * matters is re-verified: trees by a full scan whose digest must equal the
 * one MARS expects, file bytes by SHA-256, paths by client-side confinement.
 */
export async function createRemoteWorkspaceProvider(
  options: RemoteWorkspaceProviderOptions,
): Promise<RemoteWorkspaceProvider> {
  const limits: WorkspaceLimits = {
    ...DEFAULT_WORKSPACE_LIMITS,
    ...options.limits,
  };
  const extraIgnores = options.extraIgnores ?? [];
  const providerId = options.providerId ?? REMOTE_PROVIDER_ID;
  const now = options.now ?? (() => new Date());
  const pollMs = options.pollIntervalMs ?? 50;
  const maxScanBytes = options.maxScanBytes ?? limits.maxManifestBytes;
  const client = options.client;
  const remoteRoot = assertRemotePath(options.remoteRoot.replace(/\/+$/, ""));
  const serverInfo = await client.verify();
  // Upload creates missing parents, so the root exists before it is used as a cwd.
  await client.upload(
    `${remoteRoot}/.mars-remote-root`,
    new TextEncoder().encode("MARS remote workspace root\n"),
  );
  const store = openRemoteWorkspaceStore(options.rootDir);
  const mirrorRoot = join(options.rootDir, "mirror");
  const withLock = createMutex();
  const active = new Map<string, AbortController>();
  const activeDone = new Map<string, Promise<void>>();
  const inFlight = new Set<Promise<unknown>>();
  let closed = false;
  let closing: Promise<void> | undefined;

  const validate = (path: string): string =>
    validateRelativePath(path, limits, extraIgnores);
  const treeRoot = (row: WorkspaceRow): string => `${row.remote_root}/tree`;
  const mirrorDir = (row: WorkspaceRow): string =>
    join(mirrorRoot, row.workspace_id, "tree");
  /** Client-side confinement: every remote file path goes through here. */
  const remotePath = (root: string, relative: string): string => {
    const safe = validate(relative);
    const absolute = assertRemotePath(`${root}/${safe}`);
    if (!absolute.startsWith(`${root}/`))
      throw new WorkspacePolicyError("Remote path escapes the workspace root");
    return absolute;
  };
  const refOf = (row: WorkspaceRow): WorkspaceRef => ({
    workspace_id: row.workspace_id,
    provider: providerId,
    revision: row.revision,
  });
  const assertOpen = (): void => {
    if (closed)
      throw new SandboxUnavailableError("Workspace provider is closed");
  };
  const verifyContext = (context: RequestContext): void => {
    if (
      !context ||
      context.schema_version !== 1 ||
      typeof context.scope?.owner_id !== "string" ||
      typeof context.scope?.project_id !== "string" ||
      !context.scope.owner_id ||
      !context.scope.project_id
    )
      throw new WorkspacePolicyError("Invalid request context");
  };
  const inScope = (context: RequestContext, row: WorkspaceRow): boolean =>
    row.owner_id === context.scope.owner_id &&
    row.project_id === context.scope.project_id &&
    (context.scope.workspace_id === undefined ||
      context.scope.workspace_id === row.workspace_id);
  const track = <T>(promise: Promise<T>): Promise<T> => {
    inFlight.add(promise);
    promise.finally(() => inFlight.delete(promise)).catch(() => undefined);
    return promise;
  };

  const withWorkspace = <T>(
    context: RequestContext,
    workspace: WorkspaceRef | string,
    fn: (row: WorkspaceRow) => Promise<T>,
  ): Promise<T> =>
    track(
      (async () => {
        assertOpen();
        verifyContext(context);
        const id =
          typeof workspace === "string" ? workspace : workspace?.workspace_id;
        if (
          typeof id !== "string" ||
          (typeof workspace !== "string" && workspace.provider !== providerId)
        )
          throw new WorkspaceNotFoundError();
        return withLock(id, async () => {
          assertOpen();
          const row = store.get(id);
          if (!row || !inScope(context, row))
            throw new WorkspaceNotFoundError();
          if (row.journal) await recoverJournal(context, row);
          if (!existsSync(mirrorDir(row))) await syncMirror(row, row.manifest);
          return fn(row);
        });
      })(),
    );

  // ---- remote command plumbing -------------------------------------------

  async function runRemote(
    command: string,
    cwd: string,
    timeoutMs: number,
    maxOutputBytes: number,
    signal?: AbortSignal,
    onStart?: (commandId: string) => void,
  ): Promise<RemoteRun> {
    const deadline = Date.now() + timeoutMs;
    const id = await client.startCommand(command, cwd, timeoutMs / 1000 + 1);
    try {
      onStart?.(id);
      return await pollRemote(id, deadline, maxOutputBytes, signal);
    } catch (error) {
      await client.stopCommand(id).catch(() => undefined);
      throw error;
    }
  }

  async function pollRemote(
    id: string,
    deadline: number,
    maxOutputBytes: number,
    signal?: AbortSignal,
  ): Promise<RemoteRun> {
    const stdout = { parts: [] as Uint8Array[], size: 0, truncated: false };
    const stderr = { parts: [] as Uint8Array[], size: 0, truncated: false };
    let lastOrder = -1;
    let exitCode: number | null = null;
    let stopReason: "timeout" | "cancel" | null = null;
    while (exitCode === null) {
      if (signal?.aborted || closed) stopReason = "cancel";
      else if (Date.now() >= deadline) stopReason = "timeout";
      if (stopReason) {
        await client.stopCommand(id).catch(() => undefined);
        break;
      }
      // The order filter stays fixed while paging so page offsets stay valid.
      const after = lastOrder;
      let pageId: string | undefined;
      do {
        const page = await client.searchOutput(id, after, pageId);
        for (const event of page.items.sort((a, b) => a.order - b.order)) {
          if (event.order <= lastOrder) continue;
          lastOrder = event.order;
          appendBounded(stdout, event.stdout ?? "", maxOutputBytes);
          appendBounded(stderr, event.stderr ?? "", maxOutputBytes);
          if (event.exit_code !== null && event.exit_code !== undefined)
            exitCode = event.exit_code;
        }
        pageId = page.next_page_id ?? undefined;
      } while (pageId && exitCode === null);
      if (exitCode === null)
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, pollMs);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
    }
    return {
      exitCode:
        stopReason === "timeout"
          ? 124
          : stopReason === "cancel"
            ? 130
            : (exitCode ?? 1),
      stdout: concat(stdout.parts),
      stderr: concat(stderr.parts),
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
      timedOut: stopReason === "timeout",
      cancelled: stopReason === "cancel",
    };
  }

  /** Internal maintenance command; any failure fails closed. */
  async function remoteShell(command: string, what: string): Promise<string> {
    const run = await runRemote(
      command,
      remoteRoot,
      limits.maxExecutionMs,
      maxScanBytes,
    );
    if (run.exitCode !== 0 || run.stdoutTruncated)
      throw new SandboxUnavailableError(
        `Agent Server ${what} failed (exit ${run.exitCode})`,
      );
    return new TextDecoder().decode(run.stdout);
  }

  async function scan(root: string): Promise<ScanResult> {
    const output = await remoteShell(
      scanCommand(root, extraIgnores),
      "tree scan",
    );
    try {
      return parseScan(output, extraIgnores, validate);
    } catch (error) {
      if (error instanceof ScanParseError)
        throw new IntegrityError("Agent Server tree scan is malformed", {
          cause: error,
        });
      throw error;
    }
  }

  /** The remote must hold exactly the tree MARS last recorded. */
  async function verifyRemote(row: WorkspaceRow): Promise<ScanResult> {
    const result = await scan(treeRoot(row));
    if (result.manifest.digest !== row.manifest.digest)
      throw new WorkspaceModifiedError();
    return result;
  }

  async function mkdirs(
    root: string,
    directories: readonly string[],
  ): Promise<void> {
    for (let i = 0; i < directories.length; i += CHUNK) {
      const batch = directories
        .slice(i, i + CHUNK)
        .map((dir) => remotePath(root, dir));
      await remoteShell(
        `mkdir -p -- ${batch.map(shellQuote).join(" ")}`,
        "mkdir",
      );
    }
  }

  async function setModes(
    root: string,
    files: readonly ManifestFile[] | readonly { path: string; mode: number }[],
  ): Promise<void> {
    for (const mode of [493, 420] as const) {
      const paths = files
        .filter((file) => file.mode === mode)
        .map((file) => remotePath(root, file.path));
      for (let i = 0; i < paths.length; i += CHUNK)
        await remoteShell(
          `chmod ${mode === 493 ? "0755" : "0644"} -- ${paths
            .slice(i, i + CHUNK)
            .map(shellQuote)
            .join(" ")}`,
          "chmod",
        );
    }
  }

  async function removePaths(
    root: string,
    paths: readonly string[],
    flags: string,
  ): Promise<void> {
    for (let i = 0; i < paths.length; i += CHUNK) {
      const batch = paths
        .slice(i, i + CHUNK)
        .map((path) => remotePath(root, path));
      await remoteShell(
        `rm ${flags} -- ${batch.map(shellQuote).join(" ")}`,
        "rm",
      );
    }
  }

  async function uploadVerified(
    root: string,
    path: string,
    data: Uint8Array,
  ): Promise<void> {
    await client.upload(remotePath(root, path), data);
  }

  async function downloadVerified(
    row: WorkspaceRow,
    file: ManifestFile,
  ): Promise<Uint8Array> {
    if (file.size > limits.maxFileBytes)
      throw new LimitExceededError(`File exceeds maxFileBytes: ${file.path}`);
    const data = await client.download(
      remotePath(treeRoot(row), file.path),
      limits.maxFileBytes,
    );
    if (data.byteLength !== file.size || sha256Hex(data) !== file.sha256)
      throw new IntegrityError(
        `Downloaded bytes do not match their hash: ${file.path}`,
      );
    return data;
  }

  // ---- mirror (derived, never authoritative) -----------------------------

  async function readMirror(
    row: WorkspaceRow,
    file: ManifestFile,
  ): Promise<Uint8Array> {
    const data = new Uint8Array(
      await readFile(join(mirrorDir(row), file.path)).catch(() => {
        throw new IntegrityError(`Local mirror is missing ${file.path}`);
      }),
    );
    if (data.byteLength !== file.size || sha256Hex(data) !== file.sha256)
      throw new IntegrityError(
        `Local mirror does not match its hash: ${file.path}`,
      );
    return data;
  }

  async function mirrorFiles(
    row: WorkspaceRow,
    manifest: TreeManifest = row.manifest,
  ): Promise<TreeFile[]> {
    const out: TreeFile[] = [];
    for (const file of manifest.files)
      out.push({ ...file, data: await readMirror(row, file) });
    return out;
  }

  /** Rebuild the mirror to `next`, reusing verified bytes and downloading the rest. */
  async function syncMirror(
    row: WorkspaceRow,
    next: TreeManifest,
    known: Map<string, Uint8Array> = new Map(),
  ): Promise<void> {
    const previous = new Map(
      row.manifest.files.map((file) => [file.path, file]),
    );
    const staging = join(mirrorRoot, row.workspace_id, `staging-${newToken()}`);
    await mkdir(staging, { recursive: true, mode: 0o700 });
    try {
      let total = 0;
      for (const dir of next.directories)
        await mkdir(join(staging, dir), { recursive: true, mode: 0o700 });
      for (const file of next.files) {
        total += file.size;
        if (total > limits.maxTotalBytes)
          throw new LimitExceededError("Workspace exceeds maxTotalBytes");
        let data = known.get(file.path);
        if (
          data &&
          (data.byteLength !== file.size || sha256Hex(data) !== file.sha256)
        )
          data = undefined;
        const prior = previous.get(file.path);
        if (!data && prior?.sha256 === file.sha256)
          data = await readMirror(row, prior).catch(() => undefined);
        data ??= await downloadVerified(row, file);
        const target = join(staging, file.path);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, data, { mode: file.mode });
        await chmod(target, file.mode);
      }
      const final = mirrorDir(row);
      const trash = join(mirrorRoot, row.workspace_id, `trash-${newToken()}`);
      await rename(final, trash).catch(() => undefined);
      await rename(staging, final);
      await rm(trash, { recursive: true, force: true });
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }

  // ---- checkpoints -------------------------------------------------------

  async function storeCheckpoint(
    context: RequestContext,
    row: WorkspaceRow,
    files: readonly TreeFile[],
    checkpointId: string,
  ): Promise<CheckpointRef> {
    const entries = [];
    for (const file of files) {
      const artifact = await options.artifacts.put(
        context,
        file.data,
        "application/octet-stream",
      );
      assertArtifactBytes(file.data, artifact);
      entries.push({ path: file.path, mode: file.mode, artifact });
    }
    const manifest = CheckpointManifestSchema.parse({
      kind: "mars.remote-workspace.checkpoint",
      schema_version: 1,
      workspace_id: row.workspace_id,
      checkpoint_id: checkpointId,
      revision: row.revision,
      tree_digest: row.manifest.digest,
      files: entries,
      directories: row.manifest.directories,
    });
    const bytes = new TextEncoder().encode(JSON.stringify(manifest));
    if (bytes.byteLength > limits.maxManifestBytes)
      throw new LimitExceededError(
        "Checkpoint manifest exceeds maxManifestBytes",
      );
    const artifact = await options.artifacts.put(
      context,
      bytes,
      CHECKPOINT_MEDIA_TYPE,
    );
    assertArtifactBytes(bytes, artifact);
    return {
      checkpoint_id: checkpointId,
      workspace: refOf(row),
      artifact: ArtifactRefSchema.parse(artifact),
    };
  }

  async function loadCheckpoint(
    context: RequestContext,
    row: WorkspaceRow,
    checkpoint: CheckpointRef | string,
  ): Promise<{ manifest: TreeManifest; files: TreeFile[]; revision: string }> {
    const id =
      typeof checkpoint === "string" ? checkpoint : checkpoint?.checkpoint_id;
    const record = typeof id === "string" ? store.checkpoint(id) : null;
    if (!record || record.workspace_id !== row.workspace_id)
      throw new WorkspaceNotFoundError();
    if (
      typeof checkpoint !== "string" &&
      (checkpoint.artifact?.sha256 !== record.artifact.sha256 ||
        checkpoint.workspace?.revision !== record.revision)
    )
      throw new IntegrityError(
        "Checkpoint reference does not match its record",
      );
    const bytes = await options.artifacts.get(context, record.artifact);
    assertArtifactBytes(bytes, record.artifact);
    let parsed: z.infer<typeof CheckpointManifestSchema>;
    try {
      parsed = CheckpointManifestSchema.parse(
        JSON.parse(new TextDecoder().decode(bytes)),
      );
    } catch (error) {
      throw new IntegrityError("Checkpoint manifest is invalid", {
        cause: error,
      });
    }
    if (
      parsed.workspace_id !== row.workspace_id ||
      parsed.checkpoint_id !== record.checkpoint_id ||
      parsed.revision !== record.revision
    )
      throw new IntegrityError("Checkpoint manifest belongs elsewhere");
    const files: TreeFile[] = [];
    const manifestFiles: ManifestFile[] = [];
    for (const entry of parsed.files) {
      validate(entry.path);
      const data = await options.artifacts.get(context, entry.artifact);
      assertArtifactBytes(data, entry.artifact);
      files.push({
        path: entry.path,
        mode: entry.mode,
        size: data.byteLength,
        sha256: entry.artifact.sha256,
        data,
      });
      manifestFiles.push({
        path: entry.path,
        mode: entry.mode,
        size: data.byteLength,
        sha256: entry.artifact.sha256,
      });
    }
    for (const dir of parsed.directories) validate(dir);
    const manifest = buildManifest(manifestFiles, parsed.directories);
    if (manifest.digest !== parsed.tree_digest)
      throw new IntegrityError("Checkpoint tree digest mismatch");
    return { manifest, files, revision: record.revision };
  }

  /** Make the remote tree equal `target`; verified by a full scan afterwards. */
  async function applyTree(
    row: WorkspaceRow,
    target: TreeManifest,
    files: readonly TreeFile[],
  ): Promise<void> {
    const root = treeRoot(row);
    const current = await scan(root);
    const wantFiles = new Map(target.files.map((file) => [file.path, file]));
    const wantDirs = new Set(target.directories);
    const blockers = [...current.blocked].filter(
      (path) => !ancestors(path).some((dir) => current.blocked.has(dir)),
    );
    await removePaths(root, blockers, "-rf");
    const staleFiles = current.manifest.files.filter(
      (file) => !wantFiles.has(file.path) || wantDirs.has(file.path),
    );
    await removePaths(
      root,
      staleFiles.map((file) => file.path),
      "-f",
    );
    const staleDirs = current.manifest.directories
      .filter((dir) => !wantDirs.has(dir))
      .filter((dir) => !ancestors(dir).some((parent) => !wantDirs.has(parent)));
    await removePaths(root, staleDirs, "-rf");
    await mkdirs(root, target.directories);
    const have = new Map(
      current.manifest.files.map((file) => [file.path, file]),
    );
    for (const file of files) {
      const existing = have.get(file.path);
      if (existing?.sha256 === file.sha256 && existing.size === file.size)
        continue;
      await uploadVerified(root, file.path, file.data);
    }
    await setModes(root, target.files);
    const after = await scan(root);
    if (after.manifest.digest !== target.digest)
      throw new IntegrityError(
        "Remote tree does not match the expected tree after update",
      );
  }

  async function recoverJournal(
    context: RequestContext,
    row: WorkspaceRow,
  ): Promise<void> {
    const journal = row.journal;
    if (!journal) return;
    if (journal.kind === "mutate") {
      await settleMutation(row);
      return;
    }
    if (journal.kind === "execute") {
      if (journal.command_id)
        await client.stopCommand(journal.command_id).catch(() => undefined);
      row.journal = null;
      await reconcile(row);
      return;
    }
    const { manifest, files } = await loadCheckpoint(
      context,
      row,
      journal.checkpoint_id,
    );
    if (manifest.digest !== journal.target_digest)
      throw new IntegrityError("Restore journal does not match its checkpoint");
    await applyTree(row, manifest, files);
    await syncMirror(
      row,
      manifest,
      new Map(files.map((file) => [file.path, file.data])),
    );
    row.manifest = manifest;
    row.counter = journal.target_counter;
    row.revision = revisionOf(row.counter, manifest.digest);
    row.journal = null;
    row.skipped = row.skipped.filter(
      (entry) => entry.reason !== "unsupported-name",
    );
    store.update(row);
  }

  /** Re-read the remote after a command and advance the revision. */
  async function reconcile(
    row: WorkspaceRow,
    scanned?: ScanResult,
  ): Promise<void> {
    const result = scanned ?? (await scan(treeRoot(row)));
    await syncMirror(row, result.manifest);
    row.manifest = result.manifest;
    row.skipped = result.skipped;
    row.counter += 1;
    row.revision = revisionOf(row.counter, result.manifest.digest);
    store.update(row);
  }

  /** Clear a mutate journal, adopting the remote tree only if it changed. */
  async function settleMutation(row: WorkspaceRow): Promise<void> {
    const result = await scan(treeRoot(row));
    row.journal = null;
    if (result.manifest.digest !== row.manifest.digest)
      await reconcile(row, result);
    else store.update(row);
  }

  /** A failed mutation may have changed remote bytes: adopt what is there. */
  async function mutateRemote(
    row: WorkspaceRow,
    next: TreeManifest,
    known: Map<string, Uint8Array>,
    apply: () => Promise<void>,
  ): Promise<void> {
    // Durable before any remote change, so a failed settle is retried later.
    row.journal = { kind: "mutate" };
    store.update(row);
    try {
      await apply();
    } catch (error) {
      await settleMutation(row).catch(() => undefined);
      throw error;
    }
    row.journal = null;
    await commitMutation(row, next, known);
  }

  async function commitMutation(
    row: WorkspaceRow,
    next: TreeManifest,
    known: Map<string, Uint8Array>,
  ): Promise<void> {
    const after = await scan(treeRoot(row));
    if (after.manifest.digest !== next.digest) {
      // Re-sync to whatever the server holds so the record stays truthful.
      await reconcile(row);
      throw new IntegrityError(
        "Remote tree does not match the expected tree after update",
      );
    }
    await syncMirror(row, next, known);
    row.manifest = next;
    row.counter += 1;
    row.revision = revisionOf(row.counter, next.digest);
    store.update(row);
  }

  const assertTaskId = (taskId: string): void => {
    if (typeof taskId !== "string" || !TASK_ID.test(taskId))
      throw new WorkspacePolicyError("Invalid task id");
  };

  const assertParentsSafe = (scanResult: ScanResult, path: string): void => {
    const files = new Set(scanResult.manifest.files.map((file) => file.path));
    for (const parent of ancestors(path))
      if (scanResult.blocked.has(parent) || files.has(parent))
        throw new WorkspacePolicyError(
          "A workspace path parent is not a directory",
        );
    if (scanResult.blocked.has(path))
      throw new WorkspacePolicyError(
        "Workspace write target is not a regular file",
      );
  };

  const prepareLock = createMutex();

  const provider: RemoteWorkspaceProvider = {
    providerId,
    serverInfo,
    isolation: () => describeIsolation(serverInfo, client, remoteRoot),

    prepare(context, taskId) {
      return track(
        prepareLock("prepare", async () => {
          assertOpen();
          verifyContext(context);
          assertTaskId(taskId);
          const existing = store.findByTask(
            context.scope.owner_id,
            context.scope.project_id,
            taskId,
          );
          if (existing) {
            if (!inScope(context, existing)) throw new WorkspaceNotFoundError();
            return withLock(existing.workspace_id, async () => {
              const row = store.get(existing.workspace_id);
              if (!row) throw new WorkspaceNotFoundError();
              if (row.journal) await recoverJournal(context, row);
              return refOf(row);
            });
          }
          if (context.scope.workspace_id !== undefined)
            throw new WorkspaceNotFoundError();
          const skipped: WorkspaceRow["skipped"] = [];
          const snapshot = await snapshotTree(options.sourceRoot, {
            limits,
            extraIgnores,
            enforceLimits: true,
            skipped,
          });
          const workspaceId = `ws_${newToken()}`;
          const row: WorkspaceRow = {
            workspace_id: workspaceId,
            owner_id: context.scope.owner_id,
            project_id: context.scope.project_id,
            task_id: taskId,
            remote_root: assertRemotePath(`${remoteRoot}/ws/${workspaceId}`),
            counter: 0,
            revision: revisionOf(0, snapshot.digest),
            manifest: buildManifest(
              snapshot.files.map(({ path, mode, size, sha256 }) => ({
                path,
                mode,
                size,
                sha256,
              })),
              snapshot.directories,
            ),
            skipped,
            baseline_checkpoint_id: `cp_${newToken()}`,
            created_at: now().toISOString(),
            journal: null,
          };
          if (row.manifest.digest !== snapshot.digest)
            throw new IntegrityError("Snapshot digest mismatch");
          try {
            const root = treeRoot(row);
            await remoteShell(
              `test ! -e ${shellQuote(row.remote_root)} && mkdir -p -- ${shellQuote(root)}`,
              "workspace creation",
            );
            await mkdirs(root, snapshot.directories);
            for (const file of snapshot.files)
              await uploadVerified(root, file.path, file.data);
            await setModes(root, snapshot.files);
            const after = await scan(root);
            if (after.manifest.digest !== snapshot.digest)
              throw new IntegrityError(
                "Remote workspace does not match the uploaded snapshot",
              );
            row.manifest = { ...row.manifest, files: row.manifest.files };
            await mkdir(join(mirrorRoot, workspaceId), {
              recursive: true,
              mode: 0o700,
            });
            await syncMirror(
              {
                ...row,
                manifest: {
                  files: [],
                  directories: [],
                  digest: row.manifest.digest,
                },
              },
              row.manifest,
              new Map(snapshot.files.map((file) => [file.path, file.data])),
            );
            const baseline = await storeCheckpoint(
              context,
              row,
              snapshot.files,
              row.baseline_checkpoint_id,
            );
            store.insert(row);
            store.addCheckpoint({
              checkpoint_id: baseline.checkpoint_id,
              workspace_id: workspaceId,
              revision: row.revision,
              artifact: baseline.artifact,
            });
            return refOf(row);
          } catch (error) {
            await remoteShell(
              `rm -rf -- ${shellQuote(row.remote_root)}`,
              "cleanup",
            ).catch(() => undefined);
            await rm(join(mirrorRoot, workspaceId), {
              recursive: true,
              force: true,
            });
            throw error;
          }
        }),
      );
    },

    read(context, workspace, relativePath) {
      return withWorkspace(context, workspace, async (row) => {
        const path = validate(relativePath);
        const file = row.manifest.files.find((entry) => entry.path === path);
        if (!file) {
          if (row.manifest.directories.includes(path))
            throw new WorkspacePolicyError(
              "Workspace path is not a regular file",
            );
          const chain = new Set([...ancestors(path), path]);
          if (
            row.skipped.some(
              (entry) =>
                chain.has(entry.path) && entry.reason !== "ignored-secret",
            )
          )
            throw new WorkspacePolicyError("Symlink paths are not allowed");
          if (
            ancestors(path).some((parent) =>
              row.manifest.files.some((entry) => entry.path === parent),
            )
          )
            throw new WorkspacePolicyError(
              "A workspace path parent is not a directory",
            );
          throw new WorkspaceNotFoundError();
        }
        if (file.size > limits.maxFileBytes)
          throw new LimitExceededError("File exceeds maxFileBytes");
        let data: Uint8Array;
        try {
          data = await downloadVerified(row, file);
        } catch (error) {
          if (error instanceof IntegrityError)
            throw new WorkspaceModifiedError();
          throw error;
        }
        const artifact = await options.artifacts.put(
          context,
          data,
          "application/octet-stream",
        );
        assertArtifactBytes(data, artifact);
        return artifact;
      });
    },

    write(context, workspace, relativePath, artifact, writeOptions) {
      return withWorkspace(context, workspace, async (row) => {
        const path = validate(relativePath);
        const ref = ArtifactRefSchema.safeParse(artifact);
        if (!ref.success)
          throw new WorkspacePolicyError("Invalid artifact reference");
        const data = await options.artifacts.get(context, ref.data);
        assertArtifactBytes(data, ref.data);
        if (data.byteLength > limits.maxFileBytes)
          throw new LimitExceededError("File exceeds maxFileBytes");
        if (
          writeOptions?.executable !== undefined &&
          typeof writeOptions.executable !== "boolean"
        )
          throw new WorkspacePolicyError("executable must be a boolean");
        const current = await verifyRemote(row);
        assertParentsSafe(current, path);
        if (row.manifest.directories.includes(path))
          throw new WorkspacePolicyError(
            "Workspace write target is not a regular file",
          );
        const prior = row.manifest.files.find((file) => file.path === path);
        const files = row.manifest.files.filter((file) => file.path !== path);
        if (files.length + 1 > limits.maxFiles)
          throw new LimitExceededError("Workspace exceeds maxFiles");
        const total =
          files.reduce((sum, file) => sum + file.size, 0) + data.byteLength;
        if (total > limits.maxTotalBytes)
          throw new LimitExceededError("Workspace exceeds maxTotalBytes");
        const mode: 420 | 493 =
          writeOptions?.executable === undefined
            ? (prior?.mode ?? 420)
            : writeOptions.executable
              ? 493
              : 420;
        const next = buildManifest(
          [
            ...files,
            { path, mode, size: data.byteLength, sha256: sha256Hex(data) },
          ],
          [...row.manifest.directories, ...ancestors(path)],
        );
        await mutateRemote(row, next, new Map([[path, data]]), async () => {
          await uploadVerified(treeRoot(row), path, data);
          await setModes(treeRoot(row), [{ path, mode }]);
        });
      });
    },

    remove(context, workspace, relativePath) {
      return withWorkspace(context, workspace, async (row) => {
        const path = validate(relativePath);
        const current = await verifyRemote(row);
        if (
          current.blocked.has(path) ||
          row.manifest.directories.includes(path)
        )
          throw new WorkspacePolicyError(
            "Workspace remove target is not a regular file",
          );
        if (!row.manifest.files.some((file) => file.path === path))
          throw new WorkspaceNotFoundError();
        const next = buildManifest(
          row.manifest.files.filter((file) => file.path !== path),
          row.manifest.directories,
        );
        await mutateRemote(row, next, new Map(), () =>
          removePaths(treeRoot(row), [path], "-f"),
        );
      });
    },

    execute(context, workspace, argv, budget, executeOptions) {
      return withWorkspace(
        context,
        workspace,
        async (row): Promise<LocalExecutionResult> => {
          if (!isValidArgv(argv))
            throw new WorkspacePolicyError("Invalid command arguments");
          const parsedBudget = BudgetSchema.safeParse(budget);
          if (!parsedBudget.success)
            throw new WorkspacePolicyError("Invalid execution budget");
          if (!options.approveCommand) throw new CommandNotApprovedError();
          const approved = await options.approveCommand({
            context,
            workspace: refOf(row),
            task_id: row.task_id,
            argv: [...argv],
            budget: parsedBudget.data,
          });
          if (!approved) throw new CommandNotApprovedError();
          assertOpen();
          const timeoutMs = Math.min(
            parsedBudget.data.max_duration_ms,
            limits.maxExecutionMs,
          );
          const controller = new AbortController();
          const external = executeOptions?.signal;
          const onAbort = (): void => controller.abort(external?.reason);
          external?.addEventListener("abort", onAbort, { once: true });
          if (external?.aborted) onAbort();
          let finish!: () => void;
          activeDone.set(
            row.workspace_id,
            new Promise<void>((resolve) => {
              finish = resolve;
            }),
          );
          active.set(row.workspace_id, controller);
          const startedAt = now().toISOString();
          try {
            let run: RemoteRun;
            row.journal = { kind: "execute", command_id: null };
            store.update(row);
            try {
              run = await runRemote(
                `cd -- ${shellQuote(treeRoot(row))} && ${argv.map(shellQuote).join(" ")}`,
                remoteRoot,
                timeoutMs,
                limits.maxOutputBytes,
                controller.signal,
                (commandId) => {
                  row.journal = { kind: "execute", command_id: commandId };
                  store.update(row);
                },
              );
            } finally {
              row.journal = null;
              await reconcile(row);
            }
            const stdoutRef = await options.artifacts.put(
              context,
              run.stdout,
              "text/plain; charset=utf-8",
            );
            const stderrRef = await options.artifacts.put(
              context,
              run.stderr,
              "text/plain; charset=utf-8",
            );
            assertArtifactBytes(run.stdout, stdoutRef);
            assertArtifactBytes(run.stderr, stderrRef);
            return {
              workspace: refOf(row),
              exit_code: run.exitCode,
              stdout: stdoutRef,
              stderr: stderrRef,
              started_at: startedAt,
              finished_at: now().toISOString(),
              timed_out: run.timedOut,
              cancelled: run.cancelled,
              stdout_truncated: run.stdoutTruncated,
              stderr_truncated: run.stderrTruncated,
            };
          } finally {
            external?.removeEventListener("abort", onAbort);
            active.delete(row.workspace_id);
            activeDone.delete(row.workspace_id);
            finish();
          }
        },
      );
    },

    runCheck(context, workspace, request) {
      return withWorkspace(
        context,
        workspace,
        async (row): Promise<CheckRunResult> => {
          if (workspace.revision !== row.revision)
            throw new RevisionConflictError();
          if (!isValidArgv(request.argv))
            throw new WorkspacePolicyError("Invalid command arguments");
          await verifyRemote(row);
          const files = await mirrorFiles(row);
          const excluded = (path: string): boolean =>
            (request.exclude ?? []).some((rule) =>
              rule.endsWith("/") ? path.startsWith(rule) : path === rule,
            );
          const overlay = request.overlay.map((file) => ({
            path: validate(file.path),
            data: file.data,
          }));
          const overlayPaths = new Set(overlay.map((file) => file.path));
          const copyFiles = [
            ...files.filter(
              (file) => !excluded(file.path) && !overlayPaths.has(file.path),
            ),
            ...overlay.map((file) => ({
              path: file.path,
              mode: 420 as const,
              size: file.data.byteLength,
              sha256: sha256Hex(file.data),
              data: file.data,
            })),
          ];
          const copyDirs = [
            ...row.manifest.directories.filter(
              (dir) => !excluded(dir) && !excluded(`${dir}/`),
            ),
            ...copyFiles.flatMap((file) => ancestors(file.path)),
          ];
          const expected = buildManifest(
            copyFiles.map(({ data: _data, ...file }) => file),
            copyDirs,
          );
          const checkRoot = assertRemotePath(
            `${remoteRoot}/checks/${newToken()}`,
          );
          try {
            await remoteShell(
              `test ! -e ${shellQuote(checkRoot)} && mkdir -p -- ${shellQuote(checkRoot)}`,
              "check copy",
            );
            await mkdirs(checkRoot, expected.directories);
            for (const file of copyFiles)
              await uploadVerified(checkRoot, file.path, file.data);
            await setModes(checkRoot, copyFiles);
            const copied = await scan(checkRoot);
            if (copied.manifest.digest !== expected.digest)
              throw new IntegrityError(
                "Remote check copy does not match the candidate",
              );
            const run = await runRemote(
              `cd -- ${shellQuote(checkRoot)} && ${request.argv.map(shellQuote).join(" ")}`,
              remoteRoot,
              Math.min(request.timeoutMs, limits.maxExecutionMs),
              limits.maxOutputBytes,
              request.signal,
            );
            // The check had no OS isolation from the candidate; prove it left it alone.
            const after = await scan(treeRoot(row));
            if (after.manifest.digest !== row.manifest.digest)
              throw new IntegrityError(
                "A host check modified the remote candidate",
              );
            return {
              workspace: refOf(row),
              exit_code: run.exitCode,
              stdout: run.stdout,
              stderr: run.stderr,
              output_truncated: run.stdoutTruncated || run.stderrTruncated,
              timed_out: run.timedOut,
              cancelled: run.cancelled,
            };
          } finally {
            await remoteShell(
              `rm -rf -- ${shellQuote(checkRoot)}`,
              "check cleanup",
            ).catch(() => undefined);
          }
        },
      );
    },

    exportPatch(context, workspace) {
      return withWorkspace(
        context,
        workspace,
        async (row): Promise<PatchExportResult> => {
          if (workspace.revision !== row.revision)
            throw new RevisionConflictError();
          await verifyRemote(row);
          const base = await loadCheckpoint(
            context,
            row,
            row.baseline_checkpoint_id,
          );
          const current = await mirrorFiles(row);
          const diff = createWorkspaceDiff(base.files, current);
          const patch = new TextEncoder().encode(
            diff.files.map((file) => file.patch).join(""),
          );
          const binary = diff.files
            .filter((file) => /^Binary files .* differ$/m.test(file.patch))
            .map((file) => file.path);
          return {
            workspace: refOf(row),
            patch,
            files: diff.files.length,
            round_trip: await roundTripPatch(
              base.files,
              current,
              patch,
              binary,
              limits,
              extraIgnores,
            ),
            unsupported: [
              ...row.skipped.map((entry) => ({
                path: entry.path,
                reason: entry.reason,
              })),
              ...binary.map((path) => ({ path, reason: "binary content" })),
            ],
          };
        },
      );
    },

    checkpoint(context, workspace) {
      return withWorkspace(context, workspace, async (row) => {
        await verifyRemote(row);
        const files = await mirrorFiles(row);
        const ref = await storeCheckpoint(
          context,
          row,
          files,
          `cp_${newToken()}`,
        );
        store.addCheckpoint({
          checkpoint_id: ref.checkpoint_id,
          workspace_id: row.workspace_id,
          revision: row.revision,
          artifact: ref.artifact,
        });
        return ref;
      });
    },

    restore(context, checkpoint, expectedRevision) {
      if (!checkpoint?.workspace)
        return Promise.reject(new WorkspaceNotFoundError());
      return withWorkspace(context, checkpoint.workspace, async (row) => {
        if (expectedRevision !== row.revision)
          throw new RevisionConflictError();
        const target = await loadCheckpoint(context, row, checkpoint);
        await verifyRemote(row);
        row.journal = {
          kind: "restore",
          checkpoint_id: checkpoint.checkpoint_id,
          target_counter: row.counter + 1,
          target_digest: target.manifest.digest,
        };
        store.update(row);
        await recoverJournal(context, row);
        return refOf(row);
      });
    },

    diff(context, workspace, diffOptions): Promise<WorkspaceDiff> {
      return withWorkspace(context, workspace, async (row) => {
        const base = await loadCheckpoint(
          context,
          row,
          diffOptions?.base ?? row.baseline_checkpoint_id,
        );
        await verifyRemote(row);
        return createWorkspaceDiff(base.files, await mirrorFiles(row));
      });
    },

    collect(context, workspace) {
      return withWorkspace(context, workspace, async (row) => {
        await verifyRemote(row);
        const base = await loadCheckpoint(
          context,
          row,
          row.baseline_checkpoint_id,
        );
        const current = await mirrorFiles(row);
        const diff = createWorkspaceDiff(base.files, current);
        const patch = new TextEncoder().encode(
          diff.files.map((file) => file.patch).join(""),
        );
        const patchRef = await options.artifacts.put(
          context,
          patch,
          "text/x-diff; charset=utf-8",
        );
        assertArtifactBytes(patch, patchRef);
        const result: ArtifactRef[] = [patchRef];
        const byPath = new Map(current.map((file) => [file.path, file]));
        for (const file of diff.files) {
          if (file.status === "deleted") continue;
          const data = byPath.get(file.path)?.data;
          if (!data) continue;
          const ref = await options.artifacts.put(
            context,
            data,
            "application/octet-stream",
          );
          assertArtifactBytes(data, ref);
          result.push(ref);
        }
        return result;
      });
    },

    async discover(context, taskId) {
      assertOpen();
      verifyContext(context);
      assertTaskId(taskId);
      const row = store.findByTask(
        context.scope.owner_id,
        context.scope.project_id,
        taskId,
      );
      if (!row || !inScope(context, row)) return null;
      return withWorkspace(context, row.workspace_id, async (current) =>
        refOf(current),
      );
    },

    inspect(context, workspaceId) {
      return withWorkspace(context, workspaceId, async (row) => refOf(row));
    },

    workspacePath(context, workspace) {
      return withWorkspace(context, workspace, async (row) => mirrorDir(row));
    },

    checkpoints(context, workspace) {
      return withWorkspace(context, workspace, async (row) =>
        store.checkpoints(row.workspace_id).map((record) => ({
          checkpoint_id: record.checkpoint_id,
          workspace: {
            workspace_id: row.workspace_id,
            provider: providerId,
            revision: record.revision,
          },
          artifact: record.artifact,
        })),
      );
    },

    skipped(context, workspace) {
      return withWorkspace(context, workspace, async (row) =>
        row.skipped.map((entry) => ({ ...entry })),
      );
    },

    async stop(context, workspace) {
      assertOpen();
      verifyContext(context);
      const row = workspace?.workspace_id
        ? store.get(workspace.workspace_id)
        : null;
      if (!row || !inScope(context, row) || workspace.provider !== providerId)
        throw new WorkspaceNotFoundError();
      const controller = active.get(row.workspace_id);
      if (!controller) return;
      controller.abort(new Error("Workspace execution stopped"));
      await activeDone.get(row.workspace_id);
    },

    async close() {
      if (closing) return closing;
      closed = true;
      for (const controller of active.values())
        controller.abort(new Error("Provider closed"));
      closing = (async () => {
        try {
          await Promise.allSettled([...inFlight]);
        } finally {
          store.close();
        }
      })();
      return closing;
    },
  };
  return provider;
}
