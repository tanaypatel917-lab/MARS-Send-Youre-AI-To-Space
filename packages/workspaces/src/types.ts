import type {
  ArtifactRef,
  Budget,
  CheckpointRef,
  ExecutionProvider,
  ExecutionResult,
  RequestContext,
  WorkspaceRef,
} from "@mars/contracts";
import type { WorkspaceLimits } from "./tree";

export interface ArtifactStore {
  put(
    context: RequestContext,
    data: Uint8Array,
    mediaType: string,
  ): Promise<ArtifactRef>;
  get(context: RequestContext, ref: ArtifactRef): Promise<Uint8Array>;
}

export interface CommandApprovalRequest {
  context: RequestContext;
  workspace: WorkspaceRef;
  task_id: string;
  argv: readonly string[];
  budget: Budget;
}

export type CommandApprover = (
  request: CommandApprovalRequest,
) => boolean | Promise<boolean>;

export interface SandboxRunRequest {
  workspaceDir: string;
  argv: readonly string[];
  timeoutMs: number;
  maxOutputBytes: number;
  signal: AbortSignal;
  runId: string;
  labels: Readonly<Record<string, string>>;
}

export interface SandboxRunResult {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  cancelled: boolean;
}

export interface SandboxRunner {
  readonly isolation: string;
  verify(): Promise<void>;
  run(request: SandboxRunRequest): Promise<SandboxRunResult>;
  cleanup(labels: Readonly<Record<string, string>>): Promise<void>;
}

export interface DockerSandboxOptions {
  image: string;
  dockerPath?: string;
  user?: { uid: number; gid: number };
  memoryBytes?: number;
  pids?: number;
  cpus?: number;
  tmpfsBytes?: number;
  maxFileBytes?: number;
}

export interface LocalWorkspaceProviderOptions {
  rootDir: string;
  sourceRoot: string;
  artifacts: ArtifactStore;
  providerId?: string;
  limits?: Partial<WorkspaceLimits>;
  extraIgnores?: readonly string[];
  approveCommand?: CommandApprover;
  sandbox?: SandboxRunner;
  now?: () => Date;
  testHooks?: {
    /** Test-only hook for failing restore rollback before the backup rename. */
    recoveryPhase?(phase: "before-rollback-rename"): void | Promise<void>;
    /** Test-only hook for write transaction failure injection. */
    writePhase?(phase: "before-sync" | "after-rename"): void | Promise<void>;
    /** Test-only hook for remove transaction failure injection. */
    removePhase?(phase: "after-remove"): void | Promise<void>;
    restorePhase?(
      phase: "staged" | "backed-up" | "swapped" | "committed",
    ): void | Promise<void>;
  };
}

export interface WorkspaceDiffFile {
  path: string;
  status: "added" | "modified" | "deleted";
  patch: string;
}

export interface WorkspaceDiff {
  files: WorkspaceDiffFile[];
}

export interface LocalExecutionResult extends ExecutionResult {
  workspace: WorkspaceRef;
  timed_out: boolean;
  cancelled: boolean;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
}

export interface LocalWorkspaceProvider extends ExecutionProvider {
  readonly providerId: string;
  execute(
    context: RequestContext,
    workspace: WorkspaceRef,
    argv: readonly string[],
    budget: Budget,
    options?: { signal?: AbortSignal },
  ): Promise<LocalExecutionResult>;
  write(
    context: RequestContext,
    workspace: WorkspaceRef,
    relativePath: string,
    artifact: ArtifactRef,
    options?: { executable?: boolean },
  ): Promise<void>;
  /** Removes one regular file; the revision advances and the file shows as deleted in diffs. */
  remove(
    context: RequestContext,
    workspace: WorkspaceRef,
    relativePath: string,
  ): Promise<void>;
  diff(
    context: RequestContext,
    workspace: WorkspaceRef,
    options?: { base?: CheckpointRef },
  ): Promise<WorkspaceDiff>;
  discover(
    context: RequestContext,
    taskId: string,
  ): Promise<WorkspaceRef | null>;
  inspect(context: RequestContext, workspaceId: string): Promise<WorkspaceRef>;
  workspacePath(
    context: RequestContext,
    workspace: WorkspaceRef,
  ): Promise<string>;
  checkpoints(
    context: RequestContext,
    workspace: WorkspaceRef,
  ): Promise<CheckpointRef[]>;
  skipped(
    context: RequestContext,
    workspace: WorkspaceRef,
  ): Promise<
    Array<{
      path: string;
      reason: "symlink" | "special" | "ignored-secret" | "unsupported-name";
    }>
  >;
  close(): Promise<void>;
}

export type {
  ArtifactRef,
  Budget,
  CheckpointRef,
  RequestContext,
  WorkspaceLimits,
  WorkspaceRef,
};
