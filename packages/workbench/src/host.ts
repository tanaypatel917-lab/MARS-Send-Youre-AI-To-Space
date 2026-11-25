import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type ChildLaunch,
  type ChildRunner,
  type ChildRuntimeAdapter,
  CollaborationError,
  createChildRunner,
  createOhMyPiChildAdapter,
  isTerminalChildState,
} from "@mars/collaboration";
import type { RepositoryMapProvider } from "@mars/context";
import type {
  ArtifactRef,
  Budget,
  ExecutionProvider,
  PatchExport,
  RequestContext,
  RequiredCheck,
  ReviewVerificationView,
  Scope,
  Task,
  VerificationCheckLogs,
  WorkspaceRef,
} from "@mars/contracts";
import {
  ArtifactRefSchema,
  EVENT_OPERATIONS,
  isTerminalTaskStatus,
  JournalEntryIdsSchema,
  PatchExportSchema,
  verificationStateFor,
  WorkbenchProviderSchema,
  WorkbenchVaultSchema,
} from "@mars/contracts";
import {
  type EditFormatEvidence,
  EXECUTION_PACKAGE_VERSION,
  initialRequestAllowance,
  MAX_RUNTIME_INSTRUCTION_LENGTH,
  type MarsEditFormat,
  MIN_INITIAL_OUTPUT_RESERVE,
  openRuntimeSession,
  optionalInstructionCapacity,
  type RuntimeObservation,
  type RuntimeOutcome,
  type RuntimePatch,
  type RuntimeSession,
  type RuntimeSessionOptions,
  type RuntimeTools,
  type RuntimeWatch,
  type SharedBudget,
  selectEditFormat,
  selectExecutionModel,
} from "@mars/execution";
import type { StatusReport } from "@mars/memory-vault";
import type { ModelProviderRegistry } from "@mars/providers";
import {
  isLoopbackUrl,
  OMNIROUTE_PROVIDER_ID,
} from "@mars/providers-omniroute";
import { redact } from "@mars/research-worker";
import type { Turn } from "@mars/review";
import type {
  AppendEventInput,
  DurableTaskStore,
  SlotLease,
  TaskPatch,
} from "@mars/tasks";
import {
  WATCH_EVIDENCE_PRODUCER,
  type WatchEvidenceRecord,
  WatchEvidenceRecordSchema,
} from "@mars/watch";
import type { LocalWorkspaceProvider } from "@mars/workspaces";
import { z } from "zod";
import {
  browserTools,
  staleTaskBrowser,
  type WorkbenchBrowser,
} from "./browser-context";
import { chooseChildModel, isReviewerRole } from "./child-model";
import {
  collaborationTools,
  type FrozenCollaboration,
  type WorkbenchCollaboration,
} from "./collaboration-context";
import {
  type FrozenInstructions,
  freezeInstructions,
  hookBlockMessage,
  hookResultRecord,
  renderPatchResult,
  repositorySkillsSource,
  type WorkbenchConventions,
  withFrozenInstructions,
} from "./conventions-context";
import { diffDigest } from "./diff-digest";
import {
  type FrozenGraphSummarySchema,
  freezeGraphSummary,
  graphEvidence,
  type WorkbenchKnowledgeGraph,
  withFrozenGraphSummary,
} from "./graph-context";
import { type HostCheckDefinition, summarizeHostChecks } from "./host-checks";
import { childWorkspaceTaskId, createChildRecords } from "./host-children";
import {
  type Launch,
  type LaunchLocation,
  readLaunch,
  readLaunchIfPresent,
  rewriteLaunch,
  taskStateDir,
  writeLaunch,
} from "./host-launch";
import {
  errorCodeOf,
  internalContext,
  WORKBENCH_PRODUCER,
  workbenchEvent,
} from "./host-shared";
import {
  freezeRequiredChecks,
  patchSha256,
  RequiredCheckRejected,
  type VerificationHost,
  verificationRecords,
  verifyCandidate,
} from "./host-verification";
import { projectJournal, readJournalFile } from "./journal";
import {
  type FrozenMemorySchema,
  freezeMemory,
  recallHistory,
  serializedBytes,
  type WorkbenchMemory,
  type WorkbenchMemoryProposals,
  withFrozenMemory,
} from "./memory-context";
import { proposalTools, type WorkbenchOptimization } from "./proposal-context";
import {
  type Approvals,
  CheckpointRefSchema,
  type DiffResult,
  type EvidenceRecord,
  type StartParams,
  WorkspaceRefSchema,
} from "./protocol";
import {
  type FrozenRepositoryMapSchema,
  freezeRepositoryMap,
  repositoryMapTokenBudget,
  withFrozenRepositoryMap,
} from "./repository-context";
import {
  researchTools,
  staleTaskResearch,
  type WorkbenchResearch,
} from "./research-context";
import {
  MAX_RESPONSE_BYTES,
  WorkbenchError,
  type WorkbenchOperations,
} from "./server";
import {
  type FrozenSkills,
  freezeCurrentSkills,
  type WorkbenchSkillOutcomes,
  type WorkbenchSkills,
  withFrozenSkills,
} from "./skills-context";
import {
  skillOperatorApi,
  type WorkbenchSkillOperator,
} from "./skills-operator";
import {
  type FrozenRouting,
  pinInvalidation,
  type ResumeRefusal,
  type ResumeRoutingOutcome,
  type RoutedTaskStep,
  routeLaunch,
  routeTaskStep,
  routingStepEvidence,
  type WorkbenchSpecialists,
} from "./specialist-routing";
import {
  type EvidenceBinding,
  type WorkbenchWatch,
  watchEvidence,
} from "./watch-context";

/** Whether `tasks.artifact` can return these bytes within one server response. */
const artifactResponseFits = (bytes: number, mediaType: string) =>
  4 * Math.ceil(bytes / 3) +
    Buffer.byteLength(
      JSON.stringify({ result: { data_base64: "", media_type: mediaType } }),
    ) <=
  MAX_RESPONSE_BYTES;

export { WORKBENCH_PACKAGE_VERSION } from "./host-shared";

export interface WorkspaceHost extends ExecutionProvider {
  search?: LocalWorkspaceProvider["search"];
  reopen(context: RequestContext, taskId: string): Promise<WorkspaceRef>;
  cwd(context: RequestContext, workspace: WorkspaceRef): Promise<string>;
  diff(context: RequestContext, workspace: WorkspaceRef): Promise<DiffResult>;
  write(
    context: RequestContext,
    workspace: WorkspaceRef,
    relativePath: string,
    artifact: ArtifactRef,
    options?: { executable?: boolean },
  ): Promise<void>;
  /** Removes one regular file from the private workspace (apply_patch deletes and moves). */
  remove(
    context: RequestContext,
    workspace: WorkspaceRef,
    relativePath: string,
  ): Promise<void>;
  /** Runs a host check on a disposable copy of the candidate; absent means no sandbox. */
  runCheck?: LocalWorkspaceProvider["runCheck"];
  /** Exact candidate patch bytes plus a reconstruction proof; absent means no export. */
  exportPatch?: LocalWorkspaceProvider["exportPatch"];
}

/**
 * Background review hooks. The host only reports foreground turns; the
 * service owns the runner and its lifecycle, so `close()` never stops it.
 */
export interface WorkbenchReview {
  beginLiveTurn(sessionId: string): void;
  endLiveTurn(sessionId: string): void;
  recordTurn(turn: Turn): void;
}

/** Bound on each transcript message handed to background review. */
const REVIEW_TRANSCRIPT_LENGTH = 8_000;
/** Ledger hold for the delegation pool a room reserves at launch. */
const DELEGATION_HOLD = "delegation";

/**
 * Verified edit-format benchmark evidence (see `@mars/evaluation`
 * `editFormatEvidenceFromReport`) for this repository. Launches and resumes
 * use the best verified format for their model, else `default`.
 */
export interface WorkbenchEditFormats {
  repository: string;
  evidence: readonly EditFormatEvidence[];
  default?: MarsEditFormat;
  /** Lets simulated (fake-model) reports decide; tests only. */
  allowSimulated?: boolean;
}

export interface WorkbenchHostOptions {
  verifiedExportsOnly?: boolean;
  verificationReadiness?: {
    status: "ready" | "unavailable";
    reason: string;
    setup?: string;
  };
  image?: string;
  /** Host-owned read seam; no vault path or store is accepted from an RPC client. */
  vault?: { status(context: RequestContext): Promise<StatusReport> };
  /** Cached discovery/doctor facts only; describe never probes a provider. */
  providerStatus?: Readonly<
    Record<
      string,
      {
        health: "unknown" | "available" | "unavailable";
        catalog_stale: boolean;
      }
    >
  >;
  scope: Scope;
  workspaceLabel: string;
  stateRoot: string;
  store: DurableTaskStore;
  workspace: WorkspaceHost;
  registry: ModelProviderRegistry;
  canExecute: boolean;
  /** Host-defined protected checks a client may select at Start by id. */
  checks?: readonly HostCheckDefinition[];
  memory?: WorkbenchMemory;
  /** Operator surface for reviewed memory proposals (list/accept/reject/revert). */
  memoryProposals?: WorkbenchMemoryProposals;
  skills?: WorkbenchSkills;
  /** Verified-outcome credit for the skill versions each task loaded; ranks future launches. */
  skillOutcomes?: WorkbenchSkillOutcomes;
  /** Operator surface for skills and their proposals (list/accept/reject/undo review). */
  skillOperator?: WorkbenchSkillOperator;
  review?: WorkbenchReview;
  repositoryMap?: Pick<RepositoryMapProvider, "map">;
  specialists?: WorkbenchSpecialists;
  /** Evidence-based per-model edit format; absent means the runtime's static default. */
  editFormats?: WorkbenchEditFormats;
  collaboration?: WorkbenchCollaboration;
  research?: WorkbenchResearch;
  /** Background browser tasks; sessions get no browser tools without it. */
  browser?: WorkbenchBrowser;
  /** Read-only prompt-optimisation proposals exposed to sessions as untrusted text. */
  optimization?: WorkbenchOptimization;
  /** Host-owned watch-skill perception and verification; absent means no watch tools. */
  watch?: WorkbenchWatch;
  /** Host-owned derived code knowledge graph; tools and launch summaries are bound per task. */
  knowledgeGraph?: WorkbenchKnowledgeGraph;
  /** Repository conventions (instruction files, skill folders, hooks, slash commands, apply_patch). */
  conventions?: WorkbenchConventions;
  hostPrivateRoots?: string[];
  runtimeFactory?: (options: RuntimeSessionOptions) => Promise<RuntimeSession>;
  mcp?: RuntimeSessionOptions["mcp"];
}

export type WorkbenchHostApi = WorkbenchOperations &
  Required<
    Pick<
      WorkbenchOperations,
      | "memoryProposals"
      | "acceptMemoryProposal"
      | "rejectMemoryProposal"
      | "revertMemoryProposal"
      | "skills"
      | "skillProposals"
      | "acceptSkillProposal"
      | "rejectSkillProposal"
      | "undoSkillReview"
    >
  > & {
    close(): Promise<void>;
  };

function normalizeClaimedPath(path: string): string | null {
  if (path.startsWith("/") || path.startsWith("\\")) return null;
  const segments = path
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0 || segments.includes("..")) return null;
  return segments.join("/");
}

/** A write is inside the child's claim when it equals or sits under a claimed path. */

/** The executable bit a workspace diff patch records for the file's new state. */
function seededExecutable(patch: string): boolean | undefined {
  const match = /^new (?:file )?mode (\d{6})$/m.exec(patch);
  if (!match) return undefined;
  return match[1] === "100755";
}

function withinClaimedPaths(path: string, claimed: readonly string[]): boolean {
  const target = normalizeClaimedPath(path);
  // Only the canonical spelling is accepted, so the claim check and the
  // provider's own path validation always judge the same string.
  if (target === null || target !== path) return false;
  return claimed.some((claim) => {
    const prefix = normalizeClaimedPath(claim);
    return (
      prefix !== null && (target === prefix || target.startsWith(prefix + "/"))
    );
  });
}

const MAX_EVIDENCE_RECORDS = 1000;

function parseEvidenceRecord(bytes: Uint8Array): WatchEvidenceRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  const result = WatchEvidenceRecordSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

export async function createWorkbenchHost(
  options: WorkbenchHostOptions,
): Promise<WorkbenchHostApi> {
  const root = await realpath(options.stateRoot);
  const rootInfo = await stat(root);
  if (!rootInfo.isDirectory() || (rootInfo.mode & 0o077) !== 0)
    throw new Error("Host state root must be private.");
  if (
    !options.workspaceLabel ||
    options.workspaceLabel.length > 128 ||
    options.workspaceLabel.includes("/") ||
    options.workspaceLabel.includes("\\") ||
    [...options.workspaceLabel].some((char) => char.charCodeAt(0) < 32)
  )
    throw new Error("Workspace label must not be a host path.");
  const active = new Map<string, RuntimeSession>();
  // Export and restore of one candidate never overlap: an export reports the bytes it read.
  const candidateBusy = new Set<string>();
  const exclusiveCandidate = async <T>(
    taskId: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    if (candidateBusy.has(taskId)) throw new WorkbenchError("conflict");
    candidateBusy.add(taskId);
    try {
      return await operation();
    } finally {
      candidateBusy.delete(taskId);
    }
  };
  const jobs = new Map<string, Promise<void>>();
  const operations = new Set<Promise<unknown>>();
  let closing = false;
  const checkContext = (context: RequestContext) => {
    if (closing) throw new WorkbenchError("unavailable");
    if (
      context.schema_version !== 1 ||
      context.scope.owner_id !== options.scope.owner_id ||
      context.scope.project_id !== options.scope.project_id ||
      context.scope.workspace_id !== options.scope.workspace_id
    )
      throw new WorkbenchError("forbidden");
  };
  const runtimeFactory = options.runtimeFactory ?? openRuntimeSession;
  const historyFor = (context: RequestContext) => {
    const memory = options.memory;
    return memory
      ? { recall: (query: string) => recallHistory(memory, context, query) }
      : {};
  };
  // Room tools are always declared for a collaboration session, so the model
  // must support tools even when no file approval is granted.
  const toolsRequired = (approvals: Approvals, collaboration: boolean) =>
    collaboration ||
    Boolean(options.research) ||
    Boolean(options.browser) ||
    Boolean(options.watch) ||
    Boolean(options.knowledgeGraph) ||
    Object.values(approvals).some(Boolean);
  // Watch tools are host-bound too: the subprocess, policy and evidence
  // records belong to the host, and loop/verify verdicts land in the task's
  // events so a reviewer can require them. Children bind to the parent task.
  const watchFor = (
    taskId: string,
    cwd: string,
    approvals: Pick<Approvals, "read" | "execute">,
    workspaceTaskId: string = taskId,
  ): RuntimeWatch | undefined => {
    const watch = options.watch;
    if (!watch) return undefined;
    return watch.toolsFor({
      task_id: taskId,
      cwd,
      approvals: { read: approvals.read, execute: approvals.execute },
      evidence: watchEvidence(
        options.store,
        () => internalContext(options.scope),
        taskId,
        // Stamp the workspace the verifier inspected: a delegated child's
        // private copy, not the parent task that stores the event.
        async (): Promise<EvidenceBinding> => {
          const context = internalContext(options.scope);
          const workspace = await options.workspace.reopen(
            context,
            workspaceTaskId,
          );
          const diff = await options.workspace.diff(context, workspace);
          return {
            workspace_id: workspace.workspace_id,
            workspace_revision: workspace.revision,
            diff_sha256: diffDigest(diff),
          };
        },
      ),
    });
  };
  const watchOption = (
    taskId: string,
    cwd: string,
    approvals: Pick<Approvals, "read" | "execute">,
  ) => {
    const watch = watchFor(taskId, cwd, approvals);
    return watch ? { watch } : {};
  };
  // Optional launch context is best-effort: a failed block is omitted and
  // recorded as reviewable evidence, and a failing sink never fails launch.
  const recordContextUnavailable = (
    taskId: string,
    operation: "context.map" | "context.graph",
  ) =>
    options.store
      .appendEvent(
        internalContext(options.scope),
        taskId,
        workbenchEvent({ operation, status: "unavailable" }),
      )
      .catch(() => undefined);
  // Graph tools are host-bound and revision-fenced: the artifact is a derived,
  // rebuildable cache next to the repository map, never a memory owner, and
  // build attempts land in the task's events.
  const graphBinding = (
    context: RequestContext,
    taskId: string,
    cwd: string,
    workspace: WorkspaceRef,
    approvals: Pick<Approvals, "read">,
  ) => ({
    task_id: taskId,
    owner_id: options.scope.owner_id,
    project_id: options.scope.project_id,
    workspace_id: workspace.workspace_id,
    cwd,
    revision: workspace.revision,
    // The workspace revision advances on every write; builds and queries
    // re-resolve it so an edited tree never answers from the launch graph.
    async currentRevision() {
      const current = await options.workspace.reopen(context, taskId);
      if (current.workspace_id !== workspace.workspace_id)
        throw new WorkbenchError("conflict");
      return current.revision;
    },
    approvals: { read: approvals.read },
    evidence: graphEvidence(
      options.store,
      () => internalContext(options.scope),
      taskId,
    ),
  });
  const graphOption = (
    context: RequestContext,
    taskId: string,
    cwd: string,
    workspace: WorkspaceRef,
    approvals: Pick<Approvals, "read">,
  ) => {
    const graph = options.knowledgeGraph;
    if (!graph) return {};
    return {
      knowledgeGraph: graph.toolsFor(
        graphBinding(context, taskId, cwd, workspace, approvals),
      ),
    };
  };
  // Research tools are host-bound: requests carry the task's current durable
  // revision and budget, and findings return as rendered untrusted text.
  const researchFor = (taskId: string, deadline: () => number) => {
    const research = options.research;
    if (!research) return {};
    const context = () => internalContext(options.scope);
    return {
      research: researchTools(
        research,
        context,
        () => options.store.inspect(context(), taskId),
        deadline,
      ),
    };
  };
  const browserFor = (taskId: string, deadline: () => number) => {
    const browser = options.browser;
    if (!browser) return {};
    const context = () => internalContext(options.scope);
    const task = () => options.store.inspect(context(), taskId);
    return { browser: browserTools(browser, context, task, deadline) };
  };
  const proposalsFor = () =>
    options.optimization
      ? {
          proposals: proposalTools(options.optimization, () =>
            internalContext(options.scope),
          ),
        }
      : {};
  // Stale-marking failures are recorded as reviewable evidence; a failing
  // sink never fails the steer.
  const staleResearch = async (taskId: string) => {
    if (options.browser)
      await staleTaskBrowser(
        options.browser,
        internalContext(options.scope),
        () => options.store.inspect(internalContext(options.scope), taskId),
      );
    if (!options.research) return;
    const context = internalContext(options.scope);
    const failures = await staleTaskResearch(options.research, context, taskId);
    if (failures.length === 0) return;
    await options.store
      .appendEvent(
        context,
        taskId,
        workbenchEvent({ operation: "research.stale_failed", failures }),
      )
      .catch(() => undefined);
  };
  const reconcileResearch = async (taskId: string) => {
    await options.browser
      ?.reconcileTask(internalContext(options.scope), taskId)
      .catch(() => undefined);
    if (!options.research) return;
    await options.research
      .reconcileTask(internalContext(options.scope), taskId)
      .catch(() => undefined);
  };
  const selectModel = (modelId: string | undefined, needsTools: boolean) => {
    try {
      return selectExecutionModel(options.registry, modelId, needsTools);
    } catch {
      throw new WorkbenchError("model_unavailable");
    }
  };
  const launchLocation: LaunchLocation = { root, scope: options.scope };
  const taskState = (task: Task) => taskStateDir(launchLocation, task.task_id);
  const classifyModel = (modelId: string) => {
    const model = options.registry.getModel(modelId);
    if (!model) return null;
    const provider = options.registry.getProvider(model.providerId);
    const tier =
      provider &&
      provider.id !== OMNIROUTE_PROVIDER_ID &&
      isLoopbackUrl(provider.baseUrl)
        ? ("local" as const)
        : model.pricing.free
          ? ("free" as const)
          : ("paid" as const);
    return { tier, free: model.pricing.free };
  };
  const privatePatterns = async (
    context: RequestContext,
    taskId: string,
  ): Promise<string[]> => {
    const patterns = new Set([root, ...(options.hostPrivateRoots ?? [])]);
    const task = await options.store.inspect(context, taskId);
    const binding = await options.store.upstreamSession(context, taskId);
    if (binding) {
      patterns.add(binding.session_file);
      const directory = dirname(binding.session_file);
      if (directory.length > 1) patterns.add(directory);
    }
    const launch = await readLaunchIfPresent(launchLocation, task);
    if (binding && !launch) throw new WorkbenchError("unavailable");
    if (launch) {
      patterns.add(launch.cwd);
      if (dirname(launch.cwd).length > 1) patterns.add(dirname(launch.cwd));
    } else {
      const workspace = await options.workspace
        .reopen(context, taskId)
        .catch(() => null);
      if (workspace)
        patterns.add(await options.workspace.cwd(context, workspace));
    }
    return [...patterns];
  };
  const assertPublicBytes = (bytes: Uint8Array, patterns: string[]): void => {
    const buffer = Buffer.from(bytes);
    if (
      patterns.some((pattern) =>
        [pattern, JSON.stringify(pattern).slice(1, -1)].some((value) =>
          buffer.includes(Buffer.from(value)),
        ),
      )
    )
      throw new WorkbenchError("forbidden");
  };
  const verificationView = async (
    context: RequestContext,
    taskId: string,
    bound?: { workspace: WorkspaceRef; diff: { files: { patch: string }[] } },
    includeCheckLogs = false,
  ): Promise<ReviewVerificationView> => {
    await options.store.inspect(context, taskId);
    const checkLogs = includeCheckLogs
      ? new Map<string, VerificationCheckLogs>()
      : undefined;
    const records = await verificationRecords(
      verificationHost,
      context,
      taskId,
      checkLogs,
    );
    let candidate: WorkspaceRef | null = null;
    let patch: string | null = null;
    try {
      candidate = WorkspaceRefSchema.parse(
        bound?.workspace ?? (await options.workspace.reopen(context, taskId)),
      );
      patch = patchSha256(
        bound?.diff ?? (await options.workspace.diff(context, candidate)),
      );
    } catch {
      patch = null;
    }
    const presentation = verificationStateFor(
      candidate?.revision ?? null,
      records,
      patch,
    );
    const runIds = new Set([
      presentation.record?.run_id,
      ...records.toReversed().map((record) => record.run_id),
    ]);
    const view: ReviewVerificationView = {
      candidate,
      state: presentation.state,
      record: presentation.record,
      reasons: presentation.reasons,
      records,
      patch_sha256: patch,
      ...(checkLogs
        ? {
            check_logs: [...runIds]
              .flatMap((id) => {
                const logs = id && checkLogs.get(id);
                return logs ? [logs] : [];
              })
              .slice(0, 8),
          }
        : {}),
    };
    // Same guard as artifacts and diffs: nothing host-private leaves the
    // service, even when a client named such a path in a required check.
    assertPublicBytes(
      new TextEncoder().encode(JSON.stringify(view)),
      await privatePatterns(context, taskId),
    );
    return view;
  };
  const ownedArtifact = async (
    context: RequestContext,
    taskId: string,
    ref: ArtifactRef,
  ): Promise<boolean> => {
    const task = await options.store.inspect(context, taskId);
    if (task.artifacts.some((item) => item.artifact_id === ref.artifact_id))
      return true;
    if (await options.browser?.ownsEvidence?.(context, taskId, ref))
      return true;
    for await (const event of options.store.events(context, taskId)) {
      if (event.payload.artifact_id === ref.artifact_id) return true;
      if (
        event.event_type === "tool.completed" &&
        event.producer === WORKBENCH_PRODUCER
      ) {
        const bytes = await options.store.artifacts.get(context, event.payload);
        const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
        const checkpoint = z
          .object({
            operation: z.literal("workspace.checkpoint"),
            checkpoint: CheckpointRefSchema,
          })
          .strict()
          .safeParse(parsed);
        if (
          checkpoint.success &&
          checkpoint.data.checkpoint.artifact.artifact_id === ref.artifact_id
        )
          return true;
        const exported = z
          .object({
            operation: z.literal("patch.exported"),
            artifact: ArtifactRefSchema,
            round_trip: z.enum(["passed", "failed", "unavailable"]).optional(),
          })
          .strict()
          .safeParse(parsed);
        if (
          exported.success &&
          exported.data.artifact.artifact_id === ref.artifact_id
        )
          return true;
      }
      if (event.event_type === "execution.observed") {
        const bytes = await options.store.artifacts.get(context, event.payload);
        const payload: unknown = JSON.parse(new TextDecoder().decode(bytes));
        if (
          payload &&
          typeof payload === "object" &&
          "artifacts" in payload &&
          Array.isArray(payload.artifacts) &&
          payload.artifacts.some(
            (candidate: unknown) =>
              typeof candidate === "object" &&
              candidate !== null &&
              "artifact_id" in candidate &&
              candidate.artifact_id === ref.artifact_id,
          )
        )
          return true;
      }
    }
    return false;
  };
  const observe =
    (taskId: string) =>
    async (event: {
      type: string;
      session_id: string;
      entry_id: string | null;
      tool_name?: string;
    }) => {
      if (!event.entry_id) return;
      await options.store.appendEvent(internalContext(options.scope), taskId, {
        event_type: "execution.observed",
        run_id: event.session_id,
        producer: "@mars/execution",
        versions: [
          { component: "oh-my-pi", revision: EXECUTION_PACKAGE_VERSION },
        ],
        payload: {
          upstream: {
            runtime: "oh-my-pi",
            package_version: EXECUTION_PACKAGE_VERSION,
            session_id: event.session_id,
            entry_ids: [event.entry_id],
          },
          kind: event.type,
          ...(event.tool_name ? { summary: event.tool_name } : {}),
        },
      });
    };
  const runtimeResults = async (context: RequestContext, taskId: string) => {
    const queued = new Map<string, string>();
    const applied = new Set<string>();
    let input = 0;
    let output = 0;
    for await (const event of options.store.events(context, taskId)) {
      if (
        event.event_type !== "task.updated" &&
        event.producer !== WORKBENCH_PRODUCER
      )
        continue;
      const bytes = await options.store.artifacts.get(context, event.payload);
      const payload = JSON.parse(new TextDecoder().decode(bytes));
      const steering = z
        .object({
          change: z.literal("steered"),
          task_status: z.literal("paused"),
          instruction: z.string(),
        })
        .safeParse(payload);
      if (steering.success)
        queued.set(event.event_id, steering.data.instruction);
      const result = z
        .object({
          operation: z.literal(EVENT_OPERATIONS.runtimeResult),
          steering_event_ids: z.array(z.string()),
        })
        .safeParse(payload);
      if (event.producer === WORKBENCH_PRODUCER && result.success) {
        for (const id of result.data.steering_event_ids) applied.add(id);
        input += event.usage?.input_tokens ?? 0;
        output += event.usage?.output_tokens ?? 0;
      }
    }
    return {
      queued: [...queued].filter(([id]) => !applied.has(id)),
      input,
      output,
    };
  };
  const publishResult = async (
    task: Task,
    runtime: RuntimeSession,
    outcome: RuntimeOutcome,
    steeringEventIds: string[],
  ) => {
    const context = internalContext(options.scope);
    const previous = await runtimeResults(context, task.task_id);
    await options.store.appendEvent(
      context,
      task.task_id,
      workbenchEvent(
        {
          operation: EVENT_OPERATIONS.runtimeResult,
          status: outcome.status,
          ...(outcome.failure_code === undefined
            ? {}
            : { failure_code: outcome.failure_code }),
          steering_event_ids: steeringEventIds,
        },
        randomUUID(),
        {
          source_event_ids: steeringEventIds,
          usage: {
            input_tokens: Math.max(
              0,
              outcome.usage.input_tokens - previous.input,
            ),
            output_tokens: Math.max(
              0,
              outcome.usage.output_tokens - previous.output,
            ),
            cost_usd:
              options.registry.getModel(runtime.modelId)?.pricing.free === true
                ? 0
                : null,
          },
        },
      ),
    );
  };
  /** Usage already mirrored into task events, and the last recorded state, per child. */
  const childResults = async (context: RequestContext, taskId: string) => {
    const recorded = new Map<
      string,
      { input: number; output: number; usd: number; state: string }
    >();
    for await (const event of options.store.events(context, taskId)) {
      if (
        event.event_type !== "tool.completed" ||
        event.producer !== WORKBENCH_PRODUCER
      )
        continue;
      const bytes = await options.store.artifacts.get(context, event.payload);
      const payload = z
        .object({
          operation: z.literal(EVENT_OPERATIONS.childResult),
          child_agent_id: z.string(),
          status: z.string(),
        })
        .safeParse(JSON.parse(new TextDecoder().decode(bytes)));
      if (!payload.success) continue;
      const previous = recorded.get(payload.data.child_agent_id) ?? {
        input: 0,
        output: 0,
        usd: 0,
        state: "",
      };
      recorded.set(payload.data.child_agent_id, {
        input: previous.input + (event.usage?.input_tokens ?? 0),
        output: previous.output + (event.usage?.output_tokens ?? 0),
        usd: previous.usd + (event.usage?.cost_usd ?? 0),
        state: payload.data.status,
      });
    }
    return recorded;
  };
  const {
    loadTaskModels,
    saveTaskModels,
    forgetTaskModels,
    withTaskModelLock,
    rememberChildRouting,
    recallChildRouting,
    forgetChildRouting,
  } = createChildRecords(options.stateRoot);
  const childLaunches = new Map<string, ChildLaunch>();
  const childSweeps = new Map<string, Promise<void>>();
  /** Room capabilities kept for sweeping after the coordinator has exited. */
  const sweepRooms = new Map<string, FrozenCollaboration>();
  /** Rooms closed in drain mode whose children are still finishing. */
  const drainingRooms = new Map<string, FrozenCollaboration>();
  /**
   * Once a task's room is closed its children can no longer spend, so the
   * delegation pool reserved at launch is settled to what the room charged
   * them (plus any reservation it still reports outstanding) and the unspent
   * rest returns to the task's foreground run and research. Settling is
   * idempotent and only ever raises an already settled hold, so retries,
   * restarts and concurrent hosts never undercount.
   */
  const settleDelegation = async (
    taskId: string,
    frozen: FrozenCollaboration,
  ): Promise<void> => {
    const collaboration = options.collaboration;
    const { settleBudget } = options.store;
    if (!collaboration || !settleBudget) return;
    const context = internalContext(options.scope);
    const room = await collaboration.host.inspectRoom(context, frozen.room_id);
    if (room.task_id !== taskId) return;
    if (room.status !== "closed") {
      if (room.status === "draining") drainingRooms.set(taskId, frozen);
      return;
    }
    const stats = await collaboration.host.stats(context, frozen.room_id);
    await settleBudget.call(options.store, context, taskId, DELEGATION_HOLD, {
      tokens: stats.tokens.input + stats.tokens.output + stats.reserved.tokens,
      usd: stats.usd + stats.reserved.usd,
    });
    if (drainingRooms.get(taskId) === frozen) drainingRooms.delete(taskId);
  };
  const settleDrainingRooms = async () => {
    for (const [taskId, frozen] of [...drainingRooms])
      await settleDelegation(taskId, frozen).catch(() => undefined);
  };
  /**
   * Mirrors the room's children into the parent task's durable timeline from
   * the collaboration store's charged usage (the authority for budgets, which
   * also covers usage reconciled during recovery). Sweeps are serialized per
   * task so overlapping attempts can never record the same usage twice: each
   * sweep records only the delta over what earlier events already carry, and
   * a terminal state once.
   */
  const sweepChildren = (
    taskId: string,
    room?: FrozenCollaboration,
  ): Promise<void> => {
    const collaboration = options.collaboration;
    const frozen = room ?? liveRooms.get(taskId) ?? sweepRooms.get(taskId);
    if (!collaboration || !frozen) return Promise.resolve();
    sweepRooms.set(taskId, frozen);
    const run = async () => {
      const context = internalContext(options.scope);
      const recorded = await childResults(context, taskId);
      let settled = true;
      let cursor: string | null = null;
      do {
        const page = await collaboration.agents.children(
          context,
          frozen.capability,
          cursor ? { cursor } : undefined,
        );
        for (const child of page.children) {
          const previous = recorded.get(child.agent_id) ?? {
            input: 0,
            output: 0,
            usd: 0,
            state: "",
          };
          const delta = {
            input_tokens: Math.max(
              0,
              child.usage.input_tokens - previous.input,
            ),
            output_tokens: Math.max(
              0,
              child.usage.output_tokens - previous.output,
            ),
            cost_usd: Math.max(0, child.usage.usd - previous.usd),
          };
          const final = isTerminalChildState(child.state);
          if (!final) settled = false;
          const terminal = final && previous.state !== child.state;
          if (
            !terminal &&
            delta.input_tokens === 0 &&
            delta.output_tokens === 0 &&
            delta.cost_usd === 0
          )
            continue;
          const childTaskId = `${taskId}.child.${child.agent_id}`;
          const launch = childLaunches.get(childTaskId);
          await options.store.appendEvent(
            context,
            taskId,
            workbenchEvent(
              {
                operation: EVENT_OPERATIONS.childResult,
                child_task_id: childTaskId,
                child_agent_id: child.agent_id,
                role_label: child.role_label,
                task_revision: child.task_revision,
                attempt: launch?.attempt ?? null,
                status: child.state,
                model_id: launch?.model_id ?? null,
                routing: await recallChildRouting(childTaskId),
                // An unreadable history leaves independence unknown; the
                // child's usage and result are still recorded.
                reviewer_independent: await loadTaskModels(taskId).then(
                  (history) => history.verdicts[childTaskId] ?? null,
                  () => null,
                ),
              },
              randomUUID(),
              { usage: delta },
            ),
          );
          if (final) {
            childLaunches.delete(childTaskId);
            await forgetChildRouting(childTaskId);
          }
        }
        cursor = page.next_cursor;
      } while (cursor);
      await settleDelegation(taskId, frozen).catch(() => undefined);
      if (settled && !liveRooms.has(taskId)) {
        sweepRooms.delete(taskId);
        // A paused task keeps its model history for later reviewers; only a
        // terminal task with every child settled releases it.
        const status = await options.store
          .inspect(context, taskId)
          .then((task) => task.status)
          .catch(() => null);
        if (status !== null && isTerminalTaskStatus(status))
          await forgetTaskModels(taskId);
      }
    };
    const queued = (childSweeps.get(taskId) ?? Promise.resolve()).then(
      run,
      run,
    );
    const pending = queued
      .catch(() => undefined)
      .then(() => {
        if (childSweeps.get(taskId) === pending) childSweeps.delete(taskId);
      });
    childSweeps.set(taskId, pending);
    return queued;
  };
  const observeChildren = (
    adapter: ChildRuntimeAdapter,
  ): ChildRuntimeAdapter => ({
    async start(launch, hooks) {
      childLaunches.set(launch.child_task_id, launch);
      const run = await adapter.start(launch, hooks);
      const sweep = () => {
        // Let the runner finalize the child in the collaboration store first.
        setTimeout(
          () => void sweepChildren(launch.task_id).catch(() => undefined),
          0,
        ).unref();
      };
      void run.outcome.then(sweep, sweep);
      return run;
    },
    ...(adapter.reconcile
      ? { reconcile: adapter.reconcile.bind(adapter) }
      : {}),
  });
  const closeFrozenRoom = (
    taskId: string,
    frozen: FrozenCollaboration,
    mode: "drain" | "cancel",
  ) =>
    options.collaboration
      ? options.collaboration.host
          .closeRoom(internalContext(options.scope), frozen.room_id, mode)
          .then(() => sweepChildren(taskId, frozen))
          .catch(() => undefined)
          // An already closed room still settles its delegation hold.
          .then(() => settleDelegation(taskId, frozen))
          .catch(() => undefined)
      : Promise.resolve();
  const closeRecordedRoom = async (task: Task, mode: "drain" | "cancel") => {
    const launch = await readLaunchIfPresent(launchLocation, task);
    if (launch?.collaboration)
      await closeFrozenRoom(task.task_id, launch.collaboration, mode);
  };
  /**
   * The one teardown for a run that cannot continue: dispose the runtime,
   * cancel its room, and only while the task is still running record
   * `evidence` and move it to `status` (`paused` keeps a failed resume
   * resumable); research is always reconciled. Every step is best-effort so
   * the caller's original error is what surfaces.
   */
  const settleFailedRun = async (
    taskId: string,
    settle: {
      runtime?: RuntimeSession | undefined;
      collaboration?: FrozenCollaboration | undefined;
      status?: "failed" | "paused";
      evidence?: AppendEventInput;
    } = {},
  ) => {
    await settle.runtime?.dispose().catch(() => undefined);
    if (settle.collaboration)
      await closeFrozenRoom(taskId, settle.collaboration, "cancel");
    const context = internalContext(options.scope);
    const current = await options.store
      .inspect(context, taskId)
      .catch(() => null);
    if (current?.status === "running") {
      if (settle.evidence)
        await options.store
          .appendEvent(context, taskId, settle.evidence)
          .catch(() => undefined);
      await options.store
        .update(context, taskId, current.revision, {
          status: settle.status ?? "failed",
        })
        .catch(() => undefined);
    }
    await reconcileResearch(taskId);
  };
  // Steering advances the task revision; the room marks pending child
  // proposals stale so the coordinator reviews them against current intent.
  /**
   * Steering changes the task the room was opened for. The room keeps its own
   * monotonic task revision (the durable task revision does not change on
   * steer): proposals from the previous revision become stale, children are
   * cancelled, and the coordinator receives a fresh capability which replaces
   * the frozen one in launch metadata and in the live room tools.
   */
  const reviseRecordedRoom = async (task: Task) => {
    const launch = await readLaunchIfPresent(launchLocation, task);
    if (!launch?.collaboration || !options.collaboration) return;
    const context = internalContext(options.scope);
    const roomId = launch.collaboration.room_id;
    try {
      const room = await options.collaboration.host.inspectRoom(
        context,
        roomId,
      );
      const revised = await options.collaboration.host.reviseTask(
        context,
        roomId,
        { ...task, revision: room.task_revision + 1 },
      );
      const frozen: FrozenCollaboration = {
        ...launch.collaboration,
        capability: revised.coordinator,
        budget: revised.room.coordinator_runtime_budget,
      };
      await rewriteLaunch(launchLocation, task, {
        ...launch,
        collaboration: frozen,
      });
      const live = liveRooms.get(task.task_id);
      if (live) Object.assign(live, frozen);
    } catch (error) {
      if (
        error instanceof CollaborationError &&
        (error.code === "closed" || error.code === "not_found")
      )
        return;
      throw error;
    }
  };
  /**
   * Only successful foreground turns reach background review; `run` is never
   * used for delegated children, which execute under the child runner.
   */
  /** Model iterations = assistant messages in the Oh My Pi journal. */
  const modelIterations = (runtime: RuntimeSession): number => {
    try {
      return runtime.journalSnapshot().entries.filter((entry) => {
        const record = entry as {
          type?: unknown;
          message?: { role?: unknown };
        } | null;
        return (
          record?.type === "message" && record.message?.role === "assistant"
        );
      }).length;
    } catch {
      return 0;
    }
  };
  // Every host verdict on a task that froze skills is credited, including tasks
  // that loaded none: those are the baseline each skill is compared against.
  const creditSkills = async (task: Task, verified: boolean) => {
    if (!options.skillOutcomes) return;
    try {
      const launch = await readLaunchIfPresent(launchLocation, task);
      // Launches frozen before selection existed name skills without their
      // content hashes; crediting them as "no skills" would skew the baseline.
      const selection = launch?.skills?.selection;
      if (!selection) return;
      let cost = 0;
      let unpriced = false;
      try {
        for await (const event of options.store.events(
          internalContext(options.scope),
          task.task_id,
        )) {
          if (!event.usage) continue;
          if (event.usage.cost_usd === null) unpriced = true;
          else cost += event.usage.cost_usd;
        }
      } catch {
        unpriced = true;
      }
      await options.skillOutcomes.record({
        scope_key: JSON.stringify([
          options.scope.owner_id,
          options.scope.project_id,
          options.scope.workspace_id,
        ]),
        task_id: task.task_id,
        skills: selection.map(({ name, sha256 }) => ({
          name,
          sha256,
        })),
        verified,
        cost_usd: unpriced ? null : cost,
        recorded_at: Date.now(),
      });
    } catch {
      // Outcome credit is advisory; it never affects the task.
    }
  };
  const recordReviewTurn = (
    taskId: string,
    runtime: RuntimeSession,
    instruction: string,
    content: string,
    iterationsBefore: number,
    success: boolean,
  ) => {
    if (!options.review) return;
    try {
      options.review.recordTurn({
        sessionId: runtime.sessionId,
        taskId,
        origin: "foreground",
        iterations: Math.max(1, modelIterations(runtime) - iterationsBefore),
        transcript: [
          {
            role: "user",
            content: instruction.slice(0, REVIEW_TRANSCRIPT_LENGTH),
          },
          {
            role: "assistant",
            content: content.slice(0, REVIEW_TRANSCRIPT_LENGTH),
          },
        ],
        success,
      });
    } catch {
      // Review is advisory; it never affects the task.
    }
  };
  const verificationHost: VerificationHost = {
    scope: options.scope,
    store: options.store,
    workspace: options.workspace,
    scrubOutput: async (context, taskId, output) => {
      const patterns = await privatePatterns(context, taskId);
      return redact(output, [
        ...patterns,
        ...patterns.map((pattern) => JSON.stringify(pattern).slice(1, -1)),
      ]);
    },
    ...(options.checks ? { checks: options.checks } : {}),
  };
  const run = (
    task: Task,
    workspace: WorkspaceRef,
    runtime: RuntimeSession,
    instruction: string,
    steeringEventIds: string[] = [],
    remainingSteering = false,
    collaboration?: FrozenCollaboration,
    reviewable = false,
    requiredChecks: readonly RequiredCheck[] = [],
  ) => {
    const closeRoom = (mode: "drain" | "cancel") =>
      collaboration
        ? closeFrozenRoom(task.task_id, collaboration, mode)
        : Promise.resolve();
    active.set(task.task_id, runtime);
    const job = (async () => {
      // The step a failed run stopped in, recorded as the failure's evidence.
      let stage: "run" | "publish" | "collect" | "verify" | "update" = "run";
      try {
        try {
          options.review?.beginLiveTurn(runtime.sessionId);
        } catch {
          // Review is advisory; it never affects the task.
        }
        const iterationsBefore = reviewable ? modelIterations(runtime) : 0;
        const outcome = await runtime.run(instruction);
        if (options.memory) {
          const context = internalContext(options.scope);
          try {
            const journal = runtime.journalSnapshot();
            if (journal.session_id !== runtime.sessionId)
              throw new Error("Invalid runtime journal binding.");
            await options.memory.indexJournal(context, journal);
          } catch {
            await options.store
              .appendEvent(
                context,
                task.task_id,
                workbenchEvent(
                  { operation: "memory.index", status: "unavailable" },
                  runtime.sessionId,
                ),
              )
              .catch(() => undefined);
          }
        }
        stage = "publish";
        await publishResult(
          task,
          runtime,
          outcome,
          outcome.status === "cancelled" ? [] : steeringEventIds,
        );
        const context = internalContext(options.scope);
        let current = await options.store.inspect(context, task.task_id);
        if (current.status !== "running") return;
        stage = "collect";
        const collected = await options.workspace.collect(context, workspace);
        const artifact = await options.store.artifacts.put(
          context,
          new TextEncoder().encode(outcome.content),
          "text/plain",
        );
        current = await options.store.inspect(context, task.task_id);
        if (current.status !== "running") return;
        const status =
          outcome.status === "completed" && remainingSteering
            ? "paused"
            : outcome.status;
        // The verdict is recorded before the task turns `completed`, so a
        // client that sees the terminal status also sees the evidence.
        stage = "verify";
        const verdict =
          status === "completed"
            ? await verifyCandidate(
                verificationHost,
                current,
                runtime,
                requiredChecks,
                outcome.content,
              )
            : null;
        stage = "update";
        await options.store.update(context, task.task_id, current.revision, {
          status,
          artifacts: [
            ...new Map(
              [...current.artifacts, ...collected, artifact].map((ref) => [
                ref.artifact_id,
                ref,
              ]),
            ).values(),
          ],
        });
        if (status !== "paused")
          await closeRoom(status === "cancelled" ? "cancel" : "drain");
        // Read-denied tasks never feed review: the reviewer would otherwise
        // see saved memory and skills the task itself was not allowed to read.
        // Only a persisted verdict for this exact candidate feeds review: a
        // passing one as a success, any other as a failure. Unverified runs
        // (no required checks) never reach the positive path.
        if (status === "completed" && verdict)
          await creditSkills(current, verdict.verified);
        if (status === "completed" && reviewable && verdict)
          recordReviewTurn(
            task.task_id,
            runtime,
            instruction,
            outcome.content,
            iterationsBefore,
            verdict.verified,
          );
        await reconcileResearch(task.task_id);
      } catch (error) {
        await settleFailedRun(task.task_id, {
          collaboration,
          evidence: workbenchEvent(
            {
              operation: "runtime.run",
              status: "failed",
              stage,
              reason: error instanceof WorkbenchError ? error.code : "internal",
            },
            runtime.sessionId,
          ),
        });
      } finally {
        try {
          options.review?.endLiveTurn(runtime.sessionId);
        } catch {
          // Review is advisory; it never affects the task.
        }
        await runtime.dispose().catch(() => undefined);
        if (active.get(task.task_id) === runtime) {
          active.delete(task.task_id);
          liveRooms.delete(task.task_id);
          jobs.delete(task.task_id);
          // Re-sweep after the live entry is gone so a room whose children
          // have all settled releases its retained capability.
          if (sweepRooms.has(task.task_id))
            void sweepChildren(task.task_id).catch(() => undefined);
        }
      }
    })();
    jobs.set(task.task_id, job);
  };

  const runtimeTask = (task: Task, frozen?: FrozenCollaboration): Task =>
    frozen ? { ...task, budget: frozen.budget } : task;
  /** Live frozen room records, mutated in place when a revision swaps capabilities. */
  const liveRooms = new Map<string, FrozenCollaboration>();
  const roomToolsFor = (
    taskId: string,
    frozen: FrozenCollaboration,
    workspace: WorkspaceRef,
    approvals: Approvals,
  ) => {
    const collaboration = options.collaboration;
    if (!collaboration) return {};
    liveRooms.set(taskId, frozen);
    // A restarted host mirrors whatever recovery charged while it was away.
    void sweepChildren(taskId).catch(() => undefined);
    return {
      collaboration: collaborationTools(
        collaboration.agents,
        () => internalContext(options.scope),
        frozen,
        {
          afterDelegate: async () => {
            await runner?.tick();
          },
          currentBaseRevision: async () => {
            const live = await options.workspace.reopen(
              internalContext(options.scope),
              taskId,
            );
            return live.revision ?? null;
          },
          parentApprovals: () => approvals,
          roomTaskRevision: async () =>
            (
              await collaboration.host.inspectRoom(
                internalContext(options.scope),
                frozen.room_id,
              )
            ).task_revision,
        },
      ),
    };
  };
  const activeTask = (taskId: string) => async () => {
    const context = internalContext(options.scope);
    if ((await options.store.inspect(context, taskId)).status !== "running")
      throw new WorkbenchError("conflict");
  };
  /**
   * Repository hooks run through the same approval-gated sandboxed execute
   * path as the model's own commands; without execute approval they are
   * recorded as skipped. Every result lands in the task's events, and a
   * pre-tool hook exiting 2 blocks the tool call (Claude Code semantics).
   */
  const HOOK_BUDGET_MAX_MS = 300_000;
  // A slash command whose expansion exceeds the registry's prompt bound is a
  // workbench size error, not an internal failure.
  const expandRequest = (request: string) => {
    try {
      return options.conventions?.commands?.expand(request) ?? null;
    } catch (error) {
      if (errorCodeOf(error) === "too-large")
        throw new WorkbenchError("too_large");
      throw error;
    }
  };
  const dispatchHooks = async (
    taskId: string | undefined,
    workspace: WorkspaceRef,
    approvals: Approvals,
    budget: Budget,
    event: "session-start" | "pre-tool" | "post-tool",
    hookContext: { tool?: string; path?: string },
  ): Promise<void> => {
    const hooks = options.conventions?.hooks;
    if (!hooks) return;
    const context = internalContext(options.scope);
    const decode = async (ref: ArtifactRef) =>
      new TextDecoder().decode(await options.store.artifacts.get(context, ref));
    const results = await hooks.run(
      event,
      hookContext,
      async (argv, timeoutMs) => {
        if (!approvals.execute || !options.canExecute)
          return { skipped: "execute approval not granted" };
        const result = await options.workspace.execute(
          context,
          workspace,
          argv,
          {
            ...budget,
            max_duration_ms: Math.max(
              1,
              Math.min(timeoutMs, HOOK_BUDGET_MAX_MS, budget.max_duration_ms),
            ),
          },
        );
        return {
          exit_code: result.exit_code,
          stdout: await decode(result.stdout),
          stderr: await decode(result.stderr),
        };
      },
    );
    if (taskId && results.length > 0)
      await options.store
        .appendEvent(
          context,
          taskId,
          workbenchEvent({
            operation: EVENT_OPERATIONS.hookCompleted,
            event,
            ...(hookContext.tool ? { tool: hookContext.tool } : {}),
            results: results.map(hookResultRecord),
          }),
        )
        .catch(() => undefined);
    if (event === "pre-tool" && results.some((result) => result.blocked))
      throw new Error(hookBlockMessage(results));
  };
  const toolsFor = (
    workspace: WorkspaceRef,
    approvals: Approvals,
    budget: Budget,
    assertActive: () => Promise<void>,
    writePaths: readonly string[] = [],
    hookTaskId?: string,
    includeSearch = true,
  ): RuntimeTools => {
    const authorize = async (permission: keyof Approvals) => {
      if (
        !approvals[permission] ||
        (permission === "execute" && !options.canExecute)
      )
        throw new WorkbenchError("forbidden");
      await assertActive();
      return internalContext(options.scope);
    };
    // The tool's own approval and claimed-path checks run before any hook so
    // a denied call never launches a hook command.
    const hooked = async <T>(
      tool: string,
      path: string | undefined,
      authorized: () => Promise<RequestContext>,
      work: (context: RequestContext) => Promise<T>,
    ): Promise<T> => {
      const context = await authorized();
      const hookContext = path === undefined ? { tool } : { tool, path };
      await dispatchHooks(
        hookTaskId,
        workspace,
        approvals,
        budget,
        "pre-tool",
        hookContext,
      );
      const result = await work(context);
      await dispatchHooks(
        hookTaskId,
        workspace,
        approvals,
        budget,
        "post-tool",
        hookContext,
      );
      return result;
    };
    return {
      ...(includeSearch && options.workspace.search
        ? {
            grep: (request: Parameters<NonNullable<RuntimeTools["grep"]>>[0]) =>
              hooked(
                "mars_grep",
                request.path,
                () => authorize("read"),
                (context) => {
                  if (!options.workspace.search)
                    throw new WorkbenchError("unavailable");
                  return options.workspace.search(context, workspace, request);
                },
              ),
          }
        : {}),
      read: (path, toolName) =>
        hooked(
          toolName ?? "mars_read",
          path,
          () => authorize("read"),
          async (context) =>
            options.store.artifacts.get(
              context,
              await options.workspace.read(context, workspace, path),
            ),
        ),
      write: (path, bytes, toolName) =>
        hooked(
          toolName ?? "mars_write",
          path,
          async () => {
            const context = await authorize("write");
            if (writePaths.length > 0 && !withinClaimedPaths(path, writePaths))
              throw new WorkbenchError("forbidden");
            return context;
          },
          async (context) => {
            const artifact = await options.store.artifacts.put(
              context,
              bytes,
              "application/octet-stream",
            );
            await authorize("write");
            await options.workspace.write(context, workspace, path, artifact);
          },
        ),
      execute: (argv) =>
        hooked(
          "mars_execute",
          undefined,
          () => {
            // Execution cannot be confined to claimed paths, so a path-scoped
            // child does not execute at all.
            if (writePaths.length > 0) throw new WorkbenchError("forbidden");
            return authorize("execute");
          },
          async (context) => {
            const result = await options.workspace.execute(
              context,
              workspace,
              argv,
              budget,
            );
            return {
              exit_code: result.exit_code,
              stdout: new TextDecoder().decode(
                await options.store.artifacts.get(context, result.stdout),
              ),
              stderr: new TextDecoder().decode(
                await options.store.artifacts.get(context, result.stderr),
              ),
            };
          },
        ),
      stop: () =>
        options.workspace.stop(internalContext(options.scope), workspace),
    };
  };
  /**
   * Picks the session's edit format from verified benchmark evidence for the
   * selected model on this repository (else the static default) and records
   * the decision with the report digest as task evidence, like routing.
   */
  const editFormatFor = async (
    context: RequestContext,
    taskId: string,
    modelId: string,
  ): Promise<{ editFormat: MarsEditFormat } | Record<string, never>> => {
    const config = options.editFormats;
    if (!config) return {};
    const model = options.registry.getModel(modelId);
    const decision = selectEditFormat({
      modelId,
      repository: config.repository,
      ...(model ? { model } : {}),
      evidence: config.evidence,
      ...(config.default ? { staticDefault: config.default } : {}),
      ...(config.allowSimulated ? { allowSimulated: true } : {}),
    });
    await options.store
      .appendEvent(
        context,
        taskId,
        workbenchEvent({ operation: "edit_format", ...decision }),
      )
      .catch(() => undefined);
    return { editFormat: decision.format };
  };
  /**
   * Host-bound apply_patch: the applier only sees a filesystem seam whose
   * every operation re-authorizes against the task's approvals and claimed
   * paths and goes through the workspace provider. A patch reads before it
   * writes (Update hunks need the file text, Delete hunks its existence), so
   * the tool is declared only for sessions approved for both read and write
   * when the host has an applier.
   */
  const patchFor = (
    workspace: WorkspaceRef,
    approvals: Approvals,
    budget: Budget,
    assertActive: () => Promise<void>,
    taskId: string,
    writePaths: readonly string[] = [],
  ): { patch: RuntimePatch } | Record<string, never> => {
    const applyPatch = options.conventions?.applyPatch;
    if (!applyPatch || !approvals.write || !approvals.read) return {};
    const authorize = async () => {
      if (!approvals.write || !approvals.read)
        throw new WorkbenchError("forbidden");
      await assertActive();
      return internalContext(options.scope);
    };
    const claimed = (path: string) => {
      if (writePaths.length > 0 && !withinClaimedPaths(path, writePaths))
        throw new WorkbenchError("forbidden");
    };
    const notFound = (error: unknown) => errorCodeOf(error) === "not_found";
    const readText = async (path: string): Promise<string | null> => {
      const context = await authorize();
      let ref: ArtifactRef;
      try {
        ref = await options.workspace.read(context, workspace, path);
      } catch (error) {
        if (notFound(error)) return null;
        throw error;
      }
      const bytes = await options.store.artifacts.get(context, ref);
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    };
    const files = {
      read: readText,
      async write(path: string, text: string) {
        const context = await authorize();
        claimed(path);
        const artifact = await options.store.artifacts.put(
          context,
          new TextEncoder().encode(text),
          "application/octet-stream",
        );
        await authorize();
        await options.workspace.write(context, workspace, path, artifact);
      },
      async remove(path: string) {
        const context = await authorize();
        claimed(path);
        await options.workspace.remove(context, workspace, path);
      },
      // Existence never decodes content, so binary files can be deleted or
      // moved; only Update hunks require UTF-8 text. A provider policy refusal
      // (ignored or private path, directory) propagates as the hunk's failure
      // instead of being reported as a directory.
      async exists(path: string) {
        try {
          const context = await authorize();
          await options.workspace.read(context, workspace, path);
          return "file" as const;
        } catch (error) {
          if (notFound(error)) return null;
          // A file too large to read still exists and can be deleted or moved.
          if (errorCodeOf(error) === "limit_exceeded") return "file" as const;
          throw error;
        }
      },
    };
    return {
      patch: {
        async apply(patch) {
          await authorize();
          const hookContext = { tool: "mars_apply_patch" };
          await dispatchHooks(
            taskId,
            workspace,
            approvals,
            budget,
            "pre-tool",
            hookContext,
          );
          const result = await applyPatch(patch, files);
          await dispatchHooks(
            taskId,
            workspace,
            approvals,
            budget,
            "post-tool",
            hookContext,
          );
          return renderPatchResult(result);
        },
      },
    };
  };

  // Interrupted tasks come back paused and resumable, so their rooms stay open.
  await options.store.recoverInterrupted(internalContext(options.scope), {
    reason: "Workbench process interrupted.",
  });

  // Children run under the host's own runner, in private workspaces prepared
  // for their child task id, with tools bound to the child's clamped approvals
  // and fenced on the room staying open.
  const delegation = options.collaboration?.delegation;
  let runner: ChildRunner | undefined;
  let runnerTimer: ReturnType<typeof setInterval> | undefined;
  const childWorkspaceFor = async (launch: ChildLaunch) => {
    const room = options.collaboration;
    if (
      !room ||
      launch.scope.owner_id !== options.scope.owner_id ||
      launch.scope.project_id !== options.scope.project_id ||
      (launch.scope.workspace_id ?? null) !==
        (options.scope.workspace_id ?? null)
    )
      throw new WorkbenchError("forbidden");
    const context = internalContext(options.scope);
    const workspace = await options.workspace.prepare(
      context,
      childWorkspaceTaskId(launch.child_task_id),
    );
    // The child starts from the coordinator's current tree, not the source
    // checkout: its proposal base is the coordinator revision it was seeded
    // from, which the review compares with the coordinator's live revision.
    // Seeding happens once per child; a retried attempt reopens the child's
    // own tree and keeps the recorded base.
    const seedsDir = join(options.stateRoot, "children", "seeds");
    const seedPath = join(
      seedsDir,
      encodeURIComponent(launch.child_task_id) + ".json",
    );
    let baseRevision: string | null;
    const recorded = await readFile(seedPath, "utf8").then(
      (text) => JSON.parse(text) as { base_revision: string | null },
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      },
    );
    if (recorded) {
      baseRevision = recorded.base_revision;
    } else {
      const parent = await options.workspace.reopen(context, launch.task_id);
      const changes = await options.workspace.diff(context, parent);
      for (const file of changes.files) {
        if (file.status === "deleted") throw new WorkbenchError("unavailable");
        const executable = seededExecutable(file.patch);
        await options.workspace.write(
          context,
          workspace,
          file.path,
          await options.workspace.read(context, parent, file.path),
          executable === undefined ? undefined : { executable },
        );
      }
      baseRevision =
        parent.revision === undefined || parent.revision === null
          ? null
          : String(parent.revision);
      await mkdir(seedsDir, { recursive: true, mode: 0o700 });
      const temporary = seedPath + "." + randomUUID() + ".tmp";
      await writeFile(
        temporary,
        JSON.stringify({ base_revision: baseRevision }),
        { mode: 0o600 },
      );
      await rename(temporary, seedPath);
    }
    const approvals: Approvals =
      launch.workspace_mode === "read_only"
        ? { read: launch.approvals.read, write: false, execute: false }
        : launch.approvals;
    return {
      cwd: await options.workspace.cwd(context, workspace),
      tools: toolsFor(
        workspace,
        approvals,
        launch.budget,
        async () => {
          const view = await room.host.inspectRoom(context, launch.room_id);
          if (view.status !== "open") throw new WorkbenchError("conflict");
        },
        launch.write_paths,
        launch.task_id,
        false,
      ),
      base_revision: baseRevision,
    };
  };
  if (options.collaboration && delegation) {
    const collaboration = options.collaboration;
    const adapter = observeChildren(
      delegation.adapter
        ? delegation.adapter({ workspaceFor: childWorkspaceFor })
        : createOhMyPiChildAdapter({
            registry: options.registry,
            stateRoot: join(options.stateRoot, "children"),
            workspaceFor: childWorkspaceFor,
            ...(options.runtimeFactory
              ? { runtimeFactory: options.runtimeFactory }
              : {}),
            ...(options.watch
              ? {
                  watchFor: (launch: ChildLaunch, cwd: string) =>
                    watchFor(
                      launch.task_id,
                      cwd,
                      {
                        read: launch.approvals.read,
                        execute:
                          launch.approvals.execute &&
                          launch.workspace_mode !== "read_only",
                      },
                      childWorkspaceTaskId(launch.child_task_id),
                    ),
                }
              : {}),
          }),
    );
    const { acquireSlot, releaseSlot } = options.store;
    runner = createChildRunner({
      collaboration: {
        host: collaboration.host,
        agents: collaboration.agents,
        close: async () => undefined,
      },
      adapter,
      ...(acquireSlot && releaseSlot
        ? {
            slots: {
              acquire: (taskId: string, key: string, lease: SlotLease) =>
                acquireSlot.call(
                  options.store,
                  internalContext(options.scope),
                  taskId,
                  key,
                  lease,
                ),
              release: (taskId: string, key: string) =>
                releaseSlot.call(
                  options.store,
                  internalContext(options.scope),
                  taskId,
                  key,
                ),
            },
          }
        : {}),
      // Children never inherit the coordinator's model: a paid coordinator
      // would otherwise hand children a model they are not allowed to use.
      // With a specialist registry the child is routed like a launch, and a
      // verified specialist is pinned only when it is free and tool-capable.
      modelPolicy: (request) =>
        withTaskModelLock(request.task_id, async () => {
          const reviewer = isReviewerRole(request.role_label);
          const history = await loadTaskModels(request.task_id);
          const excluded = new Set(history.models);
          if (request.parent_model_id) excluded.add(request.parent_model_id);
          let routing: FrozenRouting | null = null;
          if (options.specialists) {
            try {
              routing = await routeLaunch(
                internalContext(options.scope),
                { task_id: request.child_task_id, budget: request.budget },
                true,
                { ...options.specialists, paid_consent: false },
                initialRequestAllowance({
                  approvals: request.approvals,
                  recall: false,
                  // Children get workspace tools (and watch tools when the
                  // host has them) from the child adapter; never room tools.
                  collaboration: false,
                  watch: Boolean(options.watch),
                  instruction: request.instruction,
                }) + MIN_INITIAL_OUTPUT_RESERVE,
                reviewer ? "reviewer" : "worker",
                (step) =>
                  options.store
                    .appendEvent(
                      internalContext(options.scope),
                      request.task_id,
                      workbenchEvent(
                        routingStepEvidence(step, {
                          phase: "child",
                          child_task_id: request.child_task_id,
                        }),
                      ),
                    )
                    .then(() => undefined),
              );
              await rememberChildRouting(request.child_task_id, routing).catch(
                () => undefined,
              );
            } catch {
              routing = null;
              await options.store
                .appendEvent(
                  internalContext(options.scope),
                  request.task_id,
                  workbenchEvent({
                    operation: "routing",
                    status: "unavailable",
                    child_task_id: request.child_task_id,
                  }),
                )
                .catch(() => undefined);
            }
          }
          const choice = chooseChildModel(
            options.registry,
            routing,
            excluded,
            reviewer,
          );
          await saveTaskModels(request.task_id, {
            models: history.models.includes(choice.model_id)
              ? history.models
              : [...history.models, choice.model_id],
            verdicts:
              choice.independent === null
                ? history.verdicts
                : {
                    ...history.verdicts,
                    [request.child_task_id]: choice.independent,
                  },
          });
          return { model_id: choice.model_id, reason: choice.reason };
        }),
    });
    await runner.recover();
    const tick = () =>
      void runner
        ?.tick()
        .catch(() => undefined)
        .then(settleDrainingRooms);
    runnerTimer = setInterval(tick, delegation.tickMs ?? 1000);
    runnerTimer.unref();
  }
  // Rooms that closed while no host was watching (including those recovery
  // just closed) settle their delegation holds now; draining ones settle from
  // the runner tick once their last child finishes.
  if (options.collaboration && options.store.unsettledBudgetHolds) {
    const context = internalContext(options.scope);
    const unsettled = await options.store
      .unsettledBudgetHolds(context, DELEGATION_HOLD)
      .catch(() => []);
    for (const taskId of unsettled) {
      try {
        const task = await options.store.inspect(context, taskId);
        const launch = await readLaunchIfPresent(launchLocation, task);
        if (launch?.collaboration)
          await settleDelegation(taskId, launch.collaboration);
      } catch {
        // Unreadable launch metadata keeps the whole pool held.
      }
    }
  }

  // Launch stages for `api.start`, in call order. Each optional-context stage
  // takes the instruction built so far with the capacity it may still use and
  // returns its frozen value alongside the extended instruction and what is
  // left of that capacity.
  type LaunchPrompt = { instruction: string; remainingCapacity: number };
  type LaunchStage<T> = { frozen: T | undefined; prompt: LaunchPrompt };
  const extendPrompt = (
    prompt: LaunchPrompt,
    instruction: string,
  ): LaunchPrompt => ({
    instruction,
    remainingCapacity:
      prompt.remainingCapacity -
      (serializedBytes(instruction) - serializedBytes(prompt.instruction)),
  });
  const launchSurface = (approvals: Approvals, instruction: string) => ({
    approvals,
    recall: Boolean(options.memory),
    collaboration: Boolean(options.collaboration),
    delegation: Boolean(delegation),
    research: Boolean(options.research),
    browser: Boolean(options.browser),
    proposals: Boolean(options.optimization),
    watch: Boolean(options.watch),
    knowledgeGraph: Boolean(options.knowledgeGraph),
    patch: Boolean(options.conventions?.applyPatch),
    grep: Boolean(options.workspace.search),
    instruction,
  });
  // The coordinator runs under the room budget minus the delegation pool
  // and carries the delegation tools, so optional evidence is sized the
  // way the runtime will actually be constrained.
  const coordinatorBudgetFor = (budget: Budget): Budget =>
    delegation
      ? {
          ...budget,
          max_tokens: Math.max(
            0,
            budget.max_tokens - delegation.pool.max_tokens,
          ),
        }
      : budget;
  const resolveLaunchRouting = async (
    context: RequestContext,
    task: Task,
    params: StartParams,
    baseInstruction: string,
  ): Promise<FrozenRouting | undefined> => {
    if (!options.specialists || params.model_id !== undefined) return undefined;
    try {
      return await routeLaunch(
        context,
        task,
        toolsRequired(params.approvals, Boolean(options.collaboration)),
        options.specialists,
        initialRequestAllowance(
          launchSurface(params.approvals, baseInstruction),
        ) + MIN_INITIAL_OUTPUT_RESERVE,
        "worker",
        (step) =>
          options.store
            .appendEvent(
              context,
              task.task_id,
              workbenchEvent(routingStepEvidence(step, { phase: "launch" })),
            )
            .then(() => undefined),
      );
    } catch {
      throw new WorkbenchError("unavailable");
    }
  };
  /**
   * With step routing, a resumed specialist launch re-checks its pin against
   * durable usage and the fixed deadline. A pin that is still verified keeps
   * the launch unchanged. A pin that was rolled back or lost serving
   * attestation resumes on its routed fallback (`fallback_specialist_revision`
   * chain, then the base model): the launch is rewritten with the new routing
   * and model before the task is marked running, and the saved journal is
   * rebound to that model by the runtime. Every outcome is recorded as a
   * `resume` routing event. A fallback never resumes on an unattested adapter
   * and never turns a free session into a paid one.
   */
  const rerouteResume = async (
    context: RequestContext,
    task: Task,
    launch: Launch,
    instruction: string,
  ): Promise<Launch> => {
    const specialists = options.specialists;
    const steps = specialists?.steps;
    if (!specialists || !steps || launch.routing?.outcome !== "specialist")
      return launch;
    const pinned = launch.routing;
    const needsTools = toolsRequired(
      launch.approvals,
      Boolean(launch.collaboration),
    );
    let routed: RoutedTaskStep;
    let outcome: ResumeRoutingOutcome;
    let rebound: Launch | undefined;
    try {
      const usage = { tokens: 0, usd: 0 };
      let unpriced = false;
      for await (const event of options.store.events(context, task.task_id)) {
        if (!event.usage) continue;
        usage.tokens += event.usage.input_tokens + event.usage.output_tokens;
        if (event.usage.cost_usd === null) unpriced = true;
        else usage.usd += event.usage.cost_usd;
      }
      const { reserveBudget, recordBudget } = options.store;
      const committed = await options.store.budgetCommitted?.(
        context,
        task.task_id,
      );
      if (committed) {
        usage.tokens = Math.max(usage.tokens, committed.tokens);
        usage.usd = Math.max(usage.usd, committed.usd);
      }
      // Unpriced usage is covered only by a ledger that foreground runs
      // charge (see `foregroundBudget`); otherwise it spends the budget.
      if (unpriced && !(committed && reserveBudget && recordBudget))
        usage.usd = task.budget.max_usd;
      routed = await routeTaskStep(
        context,
        task,
        needsTools,
        { ...specialists, steps },
        initialRequestAllowance(launchSurface(launch.approvals, instruction)) +
          MIN_INITIAL_OUTPUT_RESERVE,
        "worker",
        {
          usage,
          ...((launch.model_classification ?? classifyModel(launch.model_id))
            ?.free === true || specialists.paid_consent !== true
            ? {
                free_target: (
                  target: NonNullable<RoutedTaskStep["step"]["selected"]>,
                ) => {
                  if (target.kind === "baseline") return true;
                  try {
                    return selectModel(target.model_id, needsTools).pricing
                      .free;
                  } catch {
                    return true;
                  }
                },
              }
            : {}),
          ...(launch.deadline ? { deadline_at: launch.deadline } : {}),
        },
      );
      // A resume that routed the fallback but stayed paused already moved the
      // step router's pin; its recorded evidence keeps the invalidation.
      const invalidation =
        pinInvalidation(routed.step, pinned.ref) ??
        (pinned.ref !== null &&
        routed.step.lost_refs.includes(pinned.ref) &&
        routed.routing?.ref !== pinned.ref
          ? await priorResumeInvalidation(context, task.task_id, pinned.ref)
          : null);
      ({ outcome, rebound } = resumeTarget(
        launch,
        pinned,
        routed,
        needsTools,
        invalidation,
      ));
      await options.store.appendEvent(
        context,
        task.task_id,
        workbenchEvent(
          routingStepEvidence(routed.step, {
            phase: "resume",
            resume: outcome,
          }),
        ),
      );
    } catch {
      throw new WorkbenchError("unavailable");
    }
    if (outcome.action === "refused")
      throw new WorkbenchError(
        outcome.reason === "fallback_model_unavailable"
          ? "model_unavailable"
          : "unavailable",
      );
    if (!rebound) return launch;
    try {
      await rewriteLaunch(launchLocation, task, rebound);
    } catch {
      throw new WorkbenchError("unavailable");
    }
    return rebound;
  };
  const priorResumeInvalidation = async (
    context: RequestContext,
    taskId: string,
    ref: string,
  ): Promise<string | null> => {
    for await (const event of options.store.events(context, taskId)) {
      if (
        event.event_type !== "tool.completed" ||
        event.producer !== WORKBENCH_PRODUCER
      )
        continue;
      const bytes = await options.store.artifacts.get(context, event.payload);
      const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        continue;
      const record = parsed as Record<string, unknown>;
      if (record.operation !== "routing" || record.phase !== "resume") continue;
      const reason = pinInvalidation(record, ref);
      if (reason) return reason;
    }
    return null;
  };
  /** Decides whether a re-routed resume keeps its pin, falls back or stays paused. */
  const resumeTarget = (
    launch: Launch,
    pinned: FrozenRouting,
    routed: RoutedTaskStep,
    needsTools: boolean,
    invalidation: string | null,
  ): { outcome: ResumeRoutingOutcome; rebound?: Launch } => {
    const routing = routed.routing;
    const selected = routed.step.selected;
    const base = {
      from_ref: pinned.ref,
      to_ref: routing?.ref ?? null,
      from_model_id: launch.model_id,
    };
    const refuse = (reason: ResumeRefusal) => ({
      outcome: {
        ...base,
        action: "refused" as const,
        reason,
        to_model_id: null,
      },
    });
    if (routed.step.mode === "budget_exhausted")
      return refuse("budget_exhausted");
    if (!routing || !selected || routing.outcome === "unavailable")
      return refuse(
        routed.step.paid_skipped?.length
          ? "fallback_paid_refused"
          : "routing_unavailable",
      );
    // Defense in depth: the step router already refuses these.
    if (
      selected.adapter_sha256 !== null &&
      selected.serving_attestation !== "verified"
    )
      return refuse("unattested_adapter_refused");
    if (routing.ref === pinned.ref) {
      if (routing.model_id !== pinned.model_id)
        return rebind(routing, "rebound", "pinned_binding_changed");
      return {
        outcome: {
          ...base,
          action: "pinned",
          reason: null,
          to_model_id: launch.model_id,
        },
      };
    }
    // Only a pin that is no longer a verified target moves; one dropped for
    // budget or capability keeps the session paused, as before.
    if (!invalidation) return refuse("pinned_not_invalidated");
    return rebind(
      routing,
      "fallback",
      routed.step.paid_skipped?.length ? "fallback_paid_skipped" : invalidation,
    );

    function rebind(
      routing: FrozenRouting,
      action: "fallback" | "rebound",
      reason: string,
    ): { outcome: ResumeRoutingOutcome; rebound?: Launch } {
      // A baseline fallback has no pinned model and uses the free-only default.
      let model: ReturnType<typeof selectModel>;
      try {
        model = selectModel(routing.model_id ?? undefined, needsTools);
      } catch {
        return refuse("fallback_model_unavailable");
      }
      const launchedFree =
        (launch.model_classification ?? classifyModel(launch.model_id))
          ?.free === true;
      if (
        !model.pricing.free &&
        (launchedFree || options.specialists?.paid_consent !== true)
      )
        return refuse("fallback_paid_refused");
      const rebind = {
        from_model_id: launch.model_id,
        to_model_id: model.id,
        from_ref: pinned.ref,
        to_ref: routing.ref,
        decision_id: routing.decision_id,
        step_reasons: routed.step.step_reasons,
      };
      const history = launch.model_rebinds ?? [];
      if (history.length >= 32) return refuse("rebind_limit_reached");
      return {
        outcome: {
          ...base,
          action,
          reason,
          ...(action === "fallback" && routed.step.paid_skipped?.length
            ? {
                skipped_refs: routed.step.paid_skipped,
                ...(invalidation ? { invalidation } : {}),
              }
            : {}),
          to_model_id: model.id,
        },
        rebound: {
          ...launch,
          model_id: model.id,
          model_classification: classifyModel(model.id) ?? undefined,
          routing,
          model_rebinds: [...history, rebind],
        },
      };
    }
  };
  const freezeLaunchMemory = async (
    context: RequestContext,
    approvals: Approvals,
    prompt: LaunchPrompt,
  ): Promise<LaunchStage<z.infer<typeof FrozenMemorySchema>>> => {
    let memory: z.infer<typeof FrozenMemorySchema> | undefined;
    if (options.memory && approvals.read) {
      try {
        memory = freezeMemory(
          context,
          await options.memory.snapshot(context),
          prompt.instruction,
          prompt.remainingCapacity,
        );
      } catch {
        throw new WorkbenchError("unavailable");
      }
    }
    return {
      frozen: memory,
      prompt: extendPrompt(
        prompt,
        withFrozenMemory(prompt.instruction, memory),
      ),
    };
  };
  const freezeLaunchSkills = async (
    approvals: Approvals,
    prompt: LaunchPrompt,
    query: string,
  ): Promise<LaunchStage<FrozenSkills>> => {
    const source = repositorySkillsSource(
      options.skills,
      options.conventions?.repositorySkills,
    );
    if (!source || !approvals.read) return { frozen: undefined, prompt };
    let skills: FrozenSkills | undefined;
    try {
      // Outcome evidence only reorders skills; without it ranking is relevance-only.
      const stats = await Promise.resolve()
        .then(() => options.skillOutcomes?.stats())
        .catch(() => undefined);
      skills = await freezeCurrentSkills(
        source,
        prompt.instruction,
        prompt.remainingCapacity,
        { query, ...(stats ? { stats } : {}) },
      );
    } catch {
      throw new WorkbenchError("unavailable");
    }
    return {
      frozen: skills,
      prompt: extendPrompt(
        prompt,
        withFrozenSkills(prompt.instruction, skills),
      ),
    };
  };
  // Repository instructions come from the trusted checkout, not from the
  // workspace, so they do not depend on read approval; they are frozen whole
  // or omitted.
  const freezeLaunchInstructions = (
    found: NonNullable<WorkbenchConventions["instructions"]> | undefined,
    prompt: LaunchPrompt,
  ): LaunchStage<FrozenInstructions> => {
    if (!found) return { frozen: undefined, prompt };
    const instructions = freezeInstructions(
      found,
      prompt.instruction,
      prompt.remainingCapacity,
    );
    return {
      frozen: instructions,
      prompt: extendPrompt(
        prompt,
        withFrozenInstructions(prompt.instruction, instructions),
      ),
    };
  };
  // Every spender of a task holds its share of the task budget in the store's
  // ledger: the foreground run, research and the delegation pool.
  const fixedDeadline = async (
    context: RequestContext,
    task: Task,
  ): Promise<number> =>
    (await options.store.fixDeadline?.(context, task.task_id, Date.now())) ??
    Date.now() + task.budget.max_duration_ms;
  const foregroundBudget = (
    context: RequestContext,
    taskId: string,
  ): { sharedBudget?: SharedBudget } => {
    const store = options.store;
    const { reserveBudget, recordBudget } = store;
    if (!reserveBudget || !recordBudget) return {};
    return {
      sharedBudget: {
        reserve: (amount) =>
          reserveBudget.call(store, context, taskId, "foreground", amount),
        record: (amount) =>
          recordBudget.call(store, context, taskId, "foreground", amount),
      },
    };
  };
  // A room that cannot be opened at the sized coordinator budget fails the
  // already-running task.
  const openLaunchRoom = async (
    context: RequestContext,
    running: Task,
    approvals: Approvals,
    modelId: string,
    coordinatorBudget: Budget,
    deadline: number,
  ): Promise<FrozenCollaboration | undefined> => {
    if (!options.collaboration) return undefined;
    try {
      const opened = await options.collaboration.host.openRoom(context, {
        task: running,
        idempotency_key: running.task_id,
        authority: {
          approvals,
          allow_delegation: Boolean(delegation),
          paid_consent: false,
        },
        ...(delegation
          ? {
              delegation_pool: delegation.pool,
              ...(delegation.limits ? { limits: delegation.limits } : {}),
            }
          : {}),
        model_id: modelId,
        deadline,
      });
      if (
        opened.room.coordinator_runtime_budget.max_tokens <
        coordinatorBudget.max_tokens
      ) {
        // Evidence was sized for a larger runtime than the room grants.
        await options.collaboration.host
          .closeRoom(context, opened.room.room_id, "cancel")
          .catch(() => undefined);
        throw new Error("Room budget below the sized coordinator budget");
      }
      const pool = {
        tokens: Math.max(
          0,
          running.budget.max_tokens -
            opened.room.coordinator_runtime_budget.max_tokens,
        ),
        usd: Math.max(
          0,
          running.budget.max_usd -
            opened.room.coordinator_runtime_budget.max_usd,
        ),
      };
      if ((pool.tokens > 0 || pool.usd > 0) && options.store.reserveBudget)
        await options.store
          .reserveBudget(context, running.task_id, DELEGATION_HOLD, pool)
          .catch(async (error) => {
            await options.collaboration?.host
              .closeRoom(context, opened.room.room_id, "cancel")
              .catch(() => undefined);
            throw error;
          });
      return {
        room_id: opened.room.room_id,
        capability: opened.coordinator,
        budget: opened.room.coordinator_runtime_budget,
        delegation: Boolean(delegation),
      };
    } catch {
      await settleFailedRun(running.task_id);
      throw new WorkbenchError("unavailable");
    }
  };
  const freezeLaunchRepositoryMap = async (
    context: RequestContext,
    task: Task,
    approvals: Approvals,
    workspace: WorkspaceRef,
    prompt: LaunchPrompt,
  ): Promise<LaunchStage<z.infer<typeof FrozenRepositoryMapSchema>>> => {
    const maxOutputTokens = repositoryMapTokenBudget(
      prompt.instruction,
      prompt.remainingCapacity,
    );
    if (!options.repositoryMap || !approvals.read || !maxOutputTokens)
      return { frozen: undefined, prompt };
    try {
      const repositoryMap = freezeRepositoryMap(
        context,
        workspace,
        await options.repositoryMap.map(context, {
          workspace: WorkspaceRefSchema.parse(workspace),
          query: task.request.slice(0, 4096),
          max_output_tokens: maxOutputTokens,
        }),
        prompt.instruction,
        prompt.remainingCapacity,
      );
      assertPublicBytes(
        new TextEncoder().encode(repositoryMap.text),
        await privatePatterns(context, task.task_id),
      );
      return {
        frozen: repositoryMap,
        prompt: extendPrompt(
          prompt,
          withFrozenRepositoryMap(prompt.instruction, repositoryMap),
        ),
      };
    } catch {
      await recordContextUnavailable(task.task_id, "context.map");
      return { frozen: undefined, prompt };
    }
  };
  const freezeLaunchGraphSummary = async (
    context: RequestContext,
    taskId: string,
    approvals: Approvals,
    workspace: WorkspaceRef,
    cwd: string,
    prompt: LaunchPrompt,
  ): Promise<LaunchStage<z.infer<typeof FrozenGraphSummarySchema>>> => {
    if (!options.knowledgeGraph || !approvals.read)
      return { frozen: undefined, prompt };
    try {
      const found = await options.knowledgeGraph.lookup(
        graphBinding(context, taskId, cwd, workspace, approvals),
      );
      if (found.status !== "ready") return { frozen: undefined, prompt };
      const graphSummary = freezeGraphSummary(
        context,
        WorkspaceRefSchema.parse(workspace),
        found.artifact,
        prompt.instruction,
        prompt.remainingCapacity,
      );
      if (!graphSummary) return { frozen: undefined, prompt };
      assertPublicBytes(
        new TextEncoder().encode(graphSummary.text),
        await privatePatterns(context, taskId),
      );
      return {
        frozen: graphSummary,
        prompt: extendPrompt(
          prompt,
          withFrozenGraphSummary(prompt.instruction, graphSummary),
        ),
      };
    } catch {
      await recordContextUnavailable(taskId, "context.graph");
      return { frozen: undefined, prompt };
    }
  };
  // Observations emitted before the upstream session is bound are buffered
  // and persisted by `release`.
  const openLaunchRuntime = async (launch: {
    context: RequestContext;
    running: Task;
    approvals: Approvals;
    workspace: WorkspaceRef;
    cwd: string;
    stateDir: string;
    modelId: string;
    collaboration: FrozenCollaboration | undefined;
    provisionalDeadline: number;
  }) => {
    const { context, running, approvals, workspace, cwd, collaboration } =
      launch;
    const taskId = running.task_id;
    const persistObservation = observe(taskId);
    const initialObservations: RuntimeObservation[] = [];
    let bound = false;
    let deadline = launch.provisionalDeadline;
    const editFormat = await editFormatFor(context, taskId, launch.modelId);
    const runtime = await runtimeFactory({
      ...(options.mcp ? { mcp: options.mcp } : {}),
      ...foregroundBudget(context, taskId),
      ...editFormat,
      deadline: launch.provisionalDeadline,
      task: runtimeTask(running, collaboration),
      cwd,
      stateDir: launch.stateDir,
      registry: options.registry,
      modelId: launch.modelId,
      approvals,
      tools: toolsFor(
        workspace,
        approvals,
        running.budget,
        activeTask(taskId),
        [],
        taskId,
      ),
      ...patchFor(
        workspace,
        approvals,
        running.budget,
        activeTask(taskId),
        taskId,
      ),
      ...(collaboration
        ? roomToolsFor(taskId, collaboration, workspace, approvals)
        : {}),
      ...(approvals.read ? historyFor(context) : {}),
      ...researchFor(taskId, () => deadline),
      ...browserFor(taskId, () => deadline),
      ...proposalsFor(),
      ...watchOption(taskId, cwd, approvals),
      ...graphOption(context, taskId, cwd, workspace, approvals),
      onEvent: async (event) => {
        if (!bound) {
          if (initialObservations.length >= 1000)
            throw new WorkbenchError("unavailable");
          initialObservations.push(event);
          return;
        }
        await persistObservation(event);
      },
    });
    deadline = Math.min(
      Date.now() + running.budget.max_duration_ms,
      launch.provisionalDeadline,
    );
    return {
      runtime,
      deadline,
      release: async () => {
        for (const observation of initialObservations)
          await persistObservation(observation);
        bound = true;
      },
    };
  };
  const recordEditFormat = async (taskId: string, runtime: RuntimeSession) => {
    await options.store
      .appendEvent(
        internalContext(options.scope),
        taskId,
        workbenchEvent({
          operation: "edit_format.selected",
          model_id: runtime.modelId,
          ...runtime.editFormat,
        }),
      )
      .catch(() => undefined);
  };
  const announceConventions = async (
    running: Task,
    workspace: WorkspaceRef,
    approvals: Approvals,
    expanded: ReturnType<typeof expandRequest>,
    found: boolean,
    instructions: FrozenInstructions | undefined,
  ) => {
    if (!options.conventions) return;
    if (expanded || (found && !instructions))
      await options.store
        .appendEvent(
          internalContext(options.scope),
          running.task_id,
          workbenchEvent({
            operation: "conventions.applied",
            ...(expanded ? { command: expanded.name } : {}),
            instructions: instructions ? "frozen" : found ? "omitted" : "none",
          }),
        )
        .catch(() => undefined);
    await dispatchHooks(
      running.task_id,
      workspace,
      approvals,
      running.budget,
      "session-start",
      {},
    );
  };

  const proposals = (context: RequestContext) => {
    checkContext(context);
    if (!options.memoryProposals) throw new WorkbenchError("unavailable");
    return options.memoryProposals;
  };
  /** Decisions are attributed to the named actor, else the scope owner making the request. */
  const resolver = (context: RequestContext, actor?: string) => ({
    resolved_by: actor ?? context.scope.owner_id,
  });

  const skillOperations = skillOperatorApi(
    () => {
      if (!options.skillOperator) throw new WorkbenchError("unavailable");
      return options.skillOperator;
    },
    (context, actor) => ({
      actor: actor ?? context.scope.owner_id,
      source: "operator",
    }),
  );
  const checked =
    <A extends unknown[], R>(
      run: (context: RequestContext, ...args: A) => Promise<R>,
    ) =>
    async (context: RequestContext, ...args: A) => {
      checkContext(context);
      return run(context, ...args);
    };

  const api: WorkbenchOperations &
    Required<
      Pick<
        WorkbenchOperations,
        | "journal"
        | "memoryProposals"
        | "acceptMemoryProposal"
        | "rejectMemoryProposal"
        | "revertMemoryProposal"
        | "skills"
        | "skillProposals"
        | "acceptSkillProposal"
        | "rejectSkillProposal"
        | "undoSkillReview"
      >
    > = {
    scope: options.scope,
    skills: checked(skillOperations.skills),
    skillProposals: checked(skillOperations.skillProposals),
    acceptSkillProposal: checked(skillOperations.acceptSkillProposal),
    rejectSkillProposal: checked(skillOperations.rejectSkillProposal),
    undoSkillReview: checked(skillOperations.undoSkillReview),
    async memoryProposals(context, params) {
      return proposals(context).listProposals(
        context,
        params.status,
        params.task_id === undefined ? undefined : { task_id: params.task_id },
      );
    },
    async acceptMemoryProposal(context, params) {
      return proposals(context).acceptProposal(
        context,
        params.proposal_id,
        resolver(context, params.resolved_by),
      );
    },
    async rejectMemoryProposal(context, params) {
      return proposals(context).rejectProposal(
        context,
        params.proposal_id,
        params.reason,
        resolver(context, params.resolved_by),
      );
    },
    async revertMemoryProposal(context, params) {
      return proposals(context).revertProposal(
        context,
        params.proposal_id,
        params.expected_revision,
        {
          ...resolver(context, params.resolved_by),
          ...(params.reason === undefined ? {} : { reason: params.reason }),
        },
      );
    },
    async describe() {
      if (closing) throw new WorkbenchError("unavailable");
      let vault = null;
      if (options.vault) {
        const status = await options.vault.status(
          internalContext(options.scope),
        );
        if (
          status.scope.owner_id !== options.scope.owner_id ||
          status.scope.project_id !== options.scope.project_id ||
          status.scope.workspace_id !== options.scope.workspace_id
        )
          throw new WorkbenchError("forbidden");
        vault = WorkbenchVaultSchema.parse({
          pending_proposals:
            status.memory.pending_vault_proposals +
            status.skills.pending_vault_proposals,
          last_export_at: status.exported_at,
        });
      }
      const digest = options.image?.match(/@?(sha256:[a-f0-9]{64})$/)?.[1];
      return {
        scope: options.scope,
        workspaceLabel: options.workspaceLabel,
        capabilities: { execute: options.canExecute, checkpoint: true },
        ...(options.checks?.length
          ? { checks: summarizeHostChecks(options.checks) }
          : {}),
        connectors: [],
        image: digest ? { digest } : null,
        ...(options.verificationReadiness
          ? { verification_readiness: options.verificationReadiness }
          : {}),
        conventions: options.conventions?.summary ?? {
          instructions: options.conventions?.instructions?.files.length ?? 0,
          hooks: 0,
          commands: 0,
        },
        policy: {
          allow_paid: options.registry.policy.allowPaid,
          allow_screen_capture: false,
        },
        graph: null,
        vault,
        providers: options.registry.providers.map((provider) => {
          const cached = options.providerStatus?.[provider.id];
          return WorkbenchProviderSchema.parse({
            id: provider.id,
            kind:
              provider.id === OMNIROUTE_PROVIDER_ID
                ? "omniroute"
                : isLoopbackUrl(provider.baseUrl)
                  ? "local"
                  : "direct",
            health: options.registry.unavailableReason(provider.id)
              ? "unavailable"
              : (cached?.health ?? "unknown"),
            catalog_stale:
              cached?.catalog_stale ?? provider.id === OMNIROUTE_PROVIDER_ID,
            policy_owner: "mars",
          });
        }),
      };
    },
    async create(context, task, createOptions) {
      checkContext(context);
      return createOptions?.launch_key === undefined
        ? options.store.create(context, task)
        : options.store.create(context, task, {
            launch_key: createOptions.launch_key,
          });
    },
    async list(context) {
      checkContext(context);
      return options.store.list(context);
    },
    async inspect(context, taskId) {
      checkContext(context);
      const task = await options.store.inspect(context, taskId);
      const launch = await readLaunchIfPresent(launchLocation, task);
      const classification = launch
        ? (launch.model_classification ?? classifyModel(launch.model_id))
        : null;
      const usage = {
        input_tokens: 0,
        output_tokens: 0,
        cost_usd: 0 as number | null,
      };
      for await (const event of options.store.events(context, taskId)) {
        if (!event.usage) continue;
        usage.input_tokens += event.usage.input_tokens;
        usage.output_tokens += event.usage.output_tokens;
        usage.cost_usd =
          usage.cost_usd === null || event.usage.cost_usd === null
            ? null
            : usage.cost_usd + event.usage.cost_usd;
      }
      return {
        ...task,
        model_tier: classification?.tier ?? null,
        usage_totals: usage,
        pinned: (launch?.instructions?.file_metadata ?? []).map((file) => ({
          ...file,
          trust: "untrusted" as const,
        })),
        context_rows: [
          {
            source: "durable task usage (all recorded turns and children)",
            tokens: usage.input_tokens + usage.output_tokens,
            cost_usd: usage.cost_usd,
            remedy:
              "Start a fresh task to reset cumulative usage; this is not the current context window.",
          },
          ...(launch
            ? [
                {
                  source: "frozen launch context",
                  tokens: null,
                  cost_usd: null,
                  remedy:
                    "Start a new task to reload instructions, memory, skills, repository map and graph summary; per-source token counts are not recorded.",
                },
              ]
            : []),
        ],
      };
    },
    async journal(context, taskId, entryIds) {
      checkContext(context);
      const task = await options.store.inspect(context, taskId);
      JournalEntryIdsSchema.parse(entryIds);
      const binding = await options.store.upstreamSession(context, taskId);
      if (!binding || !entryIds.length)
        return projectJournal([], entryIds, false);
      const launch = await readLaunchIfPresent(launchLocation, task);
      const free = launch
        ? (launch.model_classification ?? classifyModel(launch.model_id))
            ?.free === true
        : false;
      try {
        const entries = await readJournalFile(
          taskState(task),
          binding.session_file,
          binding.session_id,
          entryIds,
        );
        const rows = projectJournal(entries, entryIds, free);
        const patterns = await privatePatterns(context, taskId);
        for (const row of rows)
          assertPublicBytes(new TextEncoder().encode(row.text), patterns);
        return rows;
      } catch (error) {
        if (
          error !== null &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return projectJournal([], entryIds, free);
        throw error;
      }
    },
    async start(context, params) {
      checkContext(context);
      if (active.has(params.task_id)) throw new WorkbenchError("conflict");
      const task = await options.store.inspect(context, params.task_id);
      if (
        task.status !== "pending" ||
        task.revision !== params.expected_revision
      )
        throw new WorkbenchError("conflict");
      if (params.approvals.execute && !options.canExecute)
        throw new WorkbenchError("forbidden");
      let requiredChecks: RequiredCheck[];
      try {
        requiredChecks = await freezeRequiredChecks(
          params.required_checks ?? [],
          options.checks ?? [],
          params.approvals.execute &&
            options.canExecute &&
            Boolean(options.workspace.runCheck),
        );
      } catch (error) {
        if (error instanceof RequiredCheckRejected)
          throw new WorkbenchError(error.code);
        throw error;
      }
      // A request that names a repository slash command (`/name args`) is
      // expanded from the command file; the durable task keeps the original.
      const expanded = expandRequest(task.request);
      const request = expanded ? expanded.prompt : task.request;
      const baseInstruction = `${request}\n\nAcceptance criteria:\n${task.acceptance_criteria.map((criterion) => `- ${criterion}`).join("\n")}`;
      if (baseInstruction.length > MAX_RUNTIME_INSTRUCTION_LENGTH)
        throw new WorkbenchError("too_large");
      const coordinatorBudget = coordinatorBudgetFor(task.budget);
      const routing = await resolveLaunchRouting(
        context,
        task,
        params,
        baseInstruction,
      );
      const model = selectModel(
        params.model_id ?? routing?.model_id ?? undefined,
        toolsRequired(params.approvals, Boolean(options.collaboration)),
      );
      const capacity = optionalInstructionCapacity({
        model,
        budget: coordinatorBudget,
        ...launchSurface(params.approvals, baseInstruction),
      });
      const memory = await freezeLaunchMemory(context, params.approvals, {
        instruction: baseInstruction,
        remainingCapacity: capacity,
      });
      const skills = await freezeLaunchSkills(
        params.approvals,
        memory.prompt,
        baseInstruction,
      );
      const foundInstructions = options.conventions?.instructions;
      const instructions = freezeLaunchInstructions(
        foundInstructions,
        skills.prompt,
      );
      const startPatch: TaskPatch = {
        status: "running",
        ...(routing?.specialist_revision
          ? { specialist_revision: routing.specialist_revision }
          : {}),
      };
      // One absolute deadline for the room, the foreground run and research,
      // fixed in the same transaction that marks the task running.
      const started = options.store.startRun
        ? await options.store.startRun(
            context,
            task.task_id,
            task.revision,
            startPatch,
            Date.now(),
          )
        : undefined;
      const running =
        started?.task ??
        (await options.store.update(
          context,
          task.task_id,
          task.revision,
          startPatch,
        ));
      let provisionalDeadline: number;
      try {
        provisionalDeadline =
          started?.deadline ?? (await fixedDeadline(context, running));
      } catch (error) {
        await settleFailedRun(task.task_id);
        throw error;
      }
      const collaboration = await openLaunchRoom(
        context,
        running,
        params.approvals,
        model.id,
        coordinatorBudget,
        provisionalDeadline,
      );
      let runtime: RuntimeSession | undefined;
      try {
        const workspace = await options.workspace.prepare(
          context,
          task.task_id,
        );
        const repositoryMap = await freezeLaunchRepositoryMap(
          context,
          task,
          params.approvals,
          workspace,
          instructions.prompt,
        );
        const stateDir = taskState(task);
        await mkdir(stateDir, { mode: 0o700 });
        const cwd = await options.workspace.cwd(context, workspace);
        const graphSummary = await freezeLaunchGraphSummary(
          context,
          task.task_id,
          params.approvals,
          workspace,
          cwd,
          repositoryMap.prompt,
        );
        const opened = await openLaunchRuntime({
          context,
          running,
          approvals: params.approvals,
          workspace,
          cwd,
          stateDir,
          modelId: model.id,
          collaboration,
          provisionalDeadline,
        });
        runtime = opened.runtime;
        if (closing) throw new WorkbenchError("unavailable");
        await writeLaunch(launchLocation, task, {
          schema_version: 1,
          task_id: task.task_id,
          scope: task.scope,
          cwd,
          model_id: runtime.modelId,
          edit_format: runtime.editFormat,
          model_classification: classifyModel(model.id) ?? undefined,
          deadline: opened.deadline,
          approvals: params.approvals,
          workspace: WorkspaceRefSchema.parse(workspace),
          ...(memory.frozen ? { memory: memory.frozen } : {}),
          ...(skills.frozen ? { skills: skills.frozen } : {}),
          ...(repositoryMap.frozen
            ? { repository_map: repositoryMap.frozen }
            : {}),
          ...(graphSummary.frozen
            ? { knowledge_graph: graphSummary.frozen }
            : {}),
          ...(instructions.frozen ? { instructions: instructions.frozen } : {}),
          ...(routing ? { routing } : {}),
          ...(collaboration ? { collaboration } : {}),
          ...(requiredChecks.length ? { required_checks: requiredChecks } : {}),
        });
        await options.store.bindUpstreamSession(
          internalContext(options.scope),
          task.task_id,
          {
            runtime: "oh-my-pi",
            package_version: EXECUTION_PACKAGE_VERSION,
            session_id: runtime.sessionId,
            session_file: runtime.journalPath,
          },
        );
        if (closing) throw new WorkbenchError("unavailable");
        await opened.release();
        await recordEditFormat(task.task_id, runtime);
        await announceConventions(
          running,
          workspace,
          params.approvals,
          expanded,
          Boolean(foundInstructions),
          instructions.frozen,
        );
        run(
          running,
          workspace,
          runtime,
          graphSummary.prompt.instruction,
          [],
          false,
          collaboration,
          params.approvals.read,
          requiredChecks,
        );
        return running;
      } catch (error) {
        await settleFailedRun(task.task_id, { runtime, collaboration });
        throw error;
      }
    },
    async resume(context, taskId, revision) {
      checkContext(context);
      if (active.has(taskId)) throw new WorkbenchError("conflict");
      const task = await options.store.inspect(context, taskId);
      if (task.revision !== revision || task.status !== "paused")
        throw new WorkbenchError("conflict");
      const binding = await options.store.upstreamSession(context, taskId);
      if (!binding) throw new WorkbenchError("conflict");
      const savedLaunch = await readLaunch(launchLocation, task);
      if (savedLaunch.approvals.execute && !options.canExecute)
        throw new WorkbenchError("forbidden");
      const { queued } = await runtimeResults(context, taskId);
      let instruction = "Continue the task from the saved session.";
      const steeringEventIds: string[] = [];
      for (const [eventId, text] of queued) {
        const addition = `${steeringEventIds.length ? "\n\n" : "\n\nQueued steering instructions:\n"}${text}`;
        if (
          instruction.length + addition.length >
          MAX_RUNTIME_INSTRUCTION_LENGTH
        )
          break;
        instruction += addition;
        steeringEventIds.push(eventId);
      }
      if (queued.length && !steeringEventIds.length)
        throw new WorkbenchError("too_large");
      const launch = await rerouteResume(
        context,
        task,
        savedLaunch,
        instruction,
      );
      // A rebound launch carries the routed fallback's specialist revision
      // (null for the base model); the task records it as it resumes.
      const specialistRevision = launch.model_rebinds
        ? (launch.routing?.specialist_revision ?? null)
        : task.specialist_revision;
      selectModel(
        launch.model_id,
        toolsRequired(launch.approvals, Boolean(launch.collaboration)),
      );
      const workspace = await options.workspace.reopen(context, taskId);
      if (
        workspace.workspace_id !== launch.workspace.workspace_id ||
        workspace.provider !== launch.workspace.provider
      )
        throw new WorkbenchError("conflict");
      const cwd = await options.workspace.cwd(context, workspace);
      if (cwd !== launch.cwd) throw new WorkbenchError("conflict");
      const running = await options.store.resume(
        context,
        taskId,
        revision,
        ...(specialistRevision !== task.specialist_revision ||
        binding.package_version !== EXECUTION_PACKAGE_VERSION
          ? [
              {
                ...(specialistRevision !== task.specialist_revision
                  ? { specialist_revision: specialistRevision }
                  : {}),
                ...(binding.package_version !== EXECUTION_PACKAGE_VERSION
                  ? {
                      upstream_package_version: {
                        from: binding.package_version,
                        to: EXECUTION_PACKAGE_VERSION,
                      },
                    }
                  : {}),
              },
            ]
          : []),
      );
      let runtime: RuntimeSession | undefined;
      try {
        const editFormat = await editFormatFor(
          context,
          running.task_id,
          launch.model_id,
        );
        runtime = await runtimeFactory({
          ...(options.mcp ? { mcp: options.mcp } : {}),
          ...foregroundBudget(context, running.task_id),
          ...editFormat,
          deadline: await fixedDeadline(context, running),
          task: runtimeTask(running, launch.collaboration),
          cwd,
          stateDir: taskState(task),
          sessionFile: binding.session_file,
          registry: options.registry,
          modelId: launch.model_id,
          ...(launch.model_rebinds
            ? {
                rebindFromModelIds: launch.model_rebinds.map(
                  (item) => item.from_model_id,
                ),
              }
            : {}),
          approvals: launch.approvals,
          tools: toolsFor(
            workspace,
            launch.approvals,
            running.budget,
            activeTask(running.task_id),
            [],
            task.task_id,
          ),
          ...patchFor(
            workspace,
            launch.approvals,
            running.budget,
            activeTask(running.task_id),
            task.task_id,
          ),
          ...(launch.collaboration
            ? roomToolsFor(
                task.task_id,
                launch.collaboration,
                workspace,
                launch.approvals,
              )
            : {}),
          ...(launch.approvals.read ? historyFor(context) : {}),
          ...researchFor(
            task.task_id,
            () => launch.deadline ?? Date.now() + task.budget.max_duration_ms,
          ),
          ...browserFor(
            task.task_id,
            () => launch.deadline ?? Date.now() + task.budget.max_duration_ms,
          ),
          ...proposalsFor(),
          ...watchOption(task.task_id, cwd, launch.approvals),
          ...graphOption(
            context,
            task.task_id,
            cwd,
            workspace,
            launch.approvals,
          ),
          onEvent: observe(taskId),
        });
        if (closing) throw new WorkbenchError("unavailable");
        if (
          runtime.sessionId !== binding.session_id ||
          runtime.journalPath !== binding.session_file ||
          runtime.modelId !== launch.model_id
        )
          throw new WorkbenchError("conflict");
        await rewriteLaunch(launchLocation, task, {
          ...launch,
          edit_format: runtime.editFormat,
        });
        await recordEditFormat(taskId, runtime);
        run(
          running,
          workspace,
          runtime,
          instruction,
          steeringEventIds,
          steeringEventIds.length < queued.length,
          launch.collaboration,
          launch.approvals.read,
          launch.required_checks ?? [],
        );
        return running;
      } catch (error) {
        await settleFailedRun(taskId, { runtime, status: "paused" });
        throw error;
      }
    },
    async steer(context, taskId, instruction) {
      checkContext(context);
      const task = await options.store.inspect(context, taskId);
      const runtime = active.get(taskId);
      if (task.status !== "paused" && (task.status !== "running" || !runtime))
        throw new WorkbenchError("conflict");
      await options.store.steer(context, taskId, instruction);
      await reviseRecordedRoom(await options.store.inspect(context, taskId));
      await staleResearch(taskId);
      await reconcileResearch(taskId);
      if (task.status === "running") await runtime?.steer(instruction);
    },
    async cancel(context, taskId) {
      checkContext(context);
      const task = await options.store.inspect(context, taskId);
      if (task.status === "running" && !active.has(taskId))
        throw new WorkbenchError("conflict");
      await options.store.cancel(context, taskId);
      await active.get(taskId)?.cancel();
      try {
        await closeRecordedRoom(task, "cancel");
      } finally {
        await reconcileResearch(taskId);
      }
    },
    async events(context, taskId, cursor) {
      checkContext(context);
      const events = [];
      const patterns = await privatePatterns(context, taskId);
      for await (const event of options.store.events(context, taskId, cursor)) {
        assertPublicBytes(
          await options.store.artifacts.get(context, event.payload),
          patterns,
        );
        events.push(event);
        if (events.length >= 100) break;
      }
      return events;
    },
    async artifact(context, taskId, ref) {
      checkContext(context);
      if (!(await ownedArtifact(context, taskId, ref)))
        throw new WorkbenchError("not_found");
      const bytes = await options.store.artifacts.get(context, ref);
      assertPublicBytes(bytes, await privatePatterns(context, taskId));
      return {
        data_base64: Buffer.from(bytes).toString("base64"),
        media_type: ref.media_type,
      };
    },
    async diff(context, taskId) {
      checkContext(context);
      await options.store.inspect(context, taskId);
      const workspace = await options.workspace.reopen(context, taskId);
      const diff = await options.workspace.diff(context, workspace);
      assertPublicBytes(
        new TextEncoder().encode(JSON.stringify(diff)),
        await privatePatterns(context, taskId),
      );
      return { ...diff, digest: diffDigest(diff) };
    },
    async evidence(context, taskId, includeHostVerification = false) {
      checkContext(context);
      const task = await options.store.inspect(context, taskId);
      const workspace = await options.workspace.reopen(context, taskId);
      const diff = await options.workspace.diff(context, workspace);
      const patterns = await privatePatterns(context, taskId);
      assertPublicBytes(
        new TextEncoder().encode(JSON.stringify(diff)),
        patterns,
      );
      const digest = diffDigest(diff);
      const records: EvidenceRecord[] = [];
      for await (const event of options.store.events(context, taskId)) {
        if (
          event.event_type !== "tool.completed" ||
          event.producer !== WATCH_EVIDENCE_PRODUCER
        )
          continue;
        const bytes = await options.store.artifacts.get(context, event.payload);
        assertPublicBytes(bytes, patterns);
        const record = parseEvidenceRecord(bytes);
        if (!record || record.kind !== "verify") continue;
        records.push({
          event_id: event.event_id,
          verdict: record.verdict,
          assurance: record.assurance,
          verified: record.verified,
          ...(record.contract_id === undefined
            ? {}
            : { contract_id: record.contract_id }),
          ...(record.contract_digest === undefined
            ? {}
            : { contract_digest: record.contract_digest }),
          recorded_at: record.recorded_at,
          workspace_id: record.workspace_id ?? null,
          workspace_revision: record.workspace_revision ?? null,
          diff_sha256: record.diff_sha256 ?? null,
          stale:
            record.workspace_id !== workspace.workspace_id ||
            record.workspace_revision !== workspace.revision ||
            record.diff_sha256 !== digest,
          ...(record.binding_error === undefined
            ? {}
            : { binding_error: record.binding_error }),
        });
        if (records.length > MAX_EVIDENCE_RECORDS) records.shift();
      }
      return {
        task_revision: task.revision,
        workspace,
        diff_sha256: digest,
        verify_records: records,
        ...(includeHostVerification
          ? {
              host_verification: await verificationView(context, taskId, {
                workspace,
                diff,
              }),
            }
          : {}),
      };
    },
    async checkpoint(context, taskId) {
      checkContext(context);
      await options.store.inspect(context, taskId);
      const workspace = await options.workspace.reopen(context, taskId);
      const checkpoint = CheckpointRefSchema.parse(
        await options.workspace.checkpoint(context, workspace),
      );
      await options.store.artifacts.get(context, checkpoint.artifact);
      await options.store.appendEvent(
        internalContext(options.scope),
        taskId,
        workbenchEvent({ operation: "workspace.checkpoint", checkpoint }),
      );
      return checkpoint;
    },
    async verification(
      context,
      taskId,
      includeCheckLogs,
    ): Promise<ReviewVerificationView> {
      checkContext(context);
      return verificationView(context, taskId, undefined, includeCheckLogs);
    },
    async export(context, params): Promise<PatchExport> {
      checkContext(context);
      return exclusiveCandidate(params.task_id, async () => {
        const task = await options.store.inspect(context, params.task_id);
        if (task.status === "running" || active.has(params.task_id))
          throw new WorkbenchError("conflict");
        if (!options.workspace.exportPatch)
          throw new WorkbenchError("unavailable");
        const candidate = WorkspaceRefSchema.parse(
          await options.workspace.reopen(context, params.task_id),
        );
        if (candidate.revision !== params.expected_revision)
          throw new WorkbenchError("conflict");
        const exported = await options.workspace.exportPatch(
          context,
          candidate,
          params.review_handoff
            ? {
                compareSourceBaseline: true,
                ...(params.review_destination === undefined
                  ? {}
                  : { destination: params.review_destination }),
              }
            : undefined,
        );
        const after = await options.workspace.reopen(context, params.task_id);
        if (after.revision !== candidate.revision)
          throw new WorkbenchError("conflict");
        if (!artifactResponseFits(exported.patch.byteLength, "text/x-diff"))
          throw new WorkbenchError("too_large");
        const sha256 = createHash("sha256")
          .update(exported.patch)
          .digest("hex");
        if (sha256 !== params.expected_patch_sha256)
          throw new WorkbenchError("conflict");
        const patterns = await privatePatterns(context, params.task_id);
        assertPublicBytes(exported.patch, patterns);
        const records = await verificationRecords(
          verificationHost,
          context,
          params.task_id,
        );
        const presentation = verificationStateFor(
          candidate.revision,
          records,
          sha256,
        );
        const verdict = presentation.record;
        if (params.review_handoff) {
          if (
            presentation.state !== "verified" ||
            verdict?.patch_sha256 !== sha256 ||
            !exported.files
          )
            throw new WorkbenchError("conflict");
          if (exported.round_trip.status !== "passed")
            throw new WorkbenchError("patch_round_trip_failed");
          assertPublicBytes(Buffer.from(JSON.stringify(verdict)), patterns);
        }
        if (
          options.verifiedExportsOnly &&
          (presentation.state !== "verified" ||
            exported.round_trip.status !== "passed")
        )
          throw new WorkbenchError("conflict");
        const artifact = await options.store.artifacts.put(
          context,
          exported.patch,
          "text/x-diff",
        );
        // An event, not a task update: owning the export must not move the task revision.
        await options.store.appendEvent(
          context,
          params.task_id,
          workbenchEvent({
            operation: "patch.exported",
            artifact,
            round_trip: exported.round_trip.status,
          }),
        );
        return PatchExportSchema.parse({
          candidate: {
            workspace_id: candidate.workspace_id,
            provider: candidate.provider,
            revision: candidate.revision,
          },
          patch_sha256: sha256,
          artifact,
          files: exported.files,
          verification: presentation.state,
          verified:
            presentation.state === "verified" &&
            exported.round_trip.status === "passed",
          verdict_run_id: presentation.record?.run_id ?? null,
          ...(params.review_handoff && verdict
            ? {
                handoff: {
                  source_baseline: exported.source_baseline ?? "unavailable",
                  ...(params.review_destination === undefined
                    ? {}
                    : { destination: exported.destination ?? "unavailable" }),
                  verdict,
                },
              }
            : {}),
          round_trip: exported.round_trip,
          unsupported: exported.unsupported.map((entry) => ({
            path: entry.path,
            reason: entry.reason.slice(0, 64),
          })),
        });
      });
    },
    async restore(context, taskId, checkpointId, revision) {
      checkContext(context);
      return exclusiveCandidate(taskId, async () => {
        const task = await options.store.inspect(context, taskId);
        if (task.status === "running" || active.has(taskId))
          throw new WorkbenchError("conflict");
        const workspace = await options.workspace.reopen(context, taskId);
        for await (const event of options.store.events(context, taskId)) {
          if (
            event.event_type !== "tool.completed" ||
            event.producer !== WORKBENCH_PRODUCER
          )
            continue;
          const bytes = await options.store.artifacts.get(
            context,
            event.payload,
          );
          const payload = z
            .object({
              operation: z.literal("workspace.checkpoint"),
              checkpoint: CheckpointRefSchema,
            })
            .strict()
            .safeParse(JSON.parse(new TextDecoder().decode(bytes)));
          if (
            payload.success &&
            payload.data.checkpoint.checkpoint_id === checkpointId
          ) {
            const checkpoint = payload.data.checkpoint;
            if (
              checkpoint.workspace.workspace_id !== workspace.workspace_id ||
              checkpoint.workspace.provider !== workspace.provider
            )
              throw new WorkbenchError("conflict");
            await options.store.artifacts.get(context, checkpoint.artifact);
            return options.workspace.restore(context, checkpoint, revision);
          }
        }
        throw new WorkbenchError("not_found");
      });
    },
  };
  const track =
    <A extends unknown[], R>(operation: (...args: A) => Promise<R>) =>
    (...args: A): Promise<R> => {
      const promise = operation(...args);
      operations.add(promise);
      void promise.then(
        () => operations.delete(promise),
        () => operations.delete(promise),
      );
      return promise;
    };
  const lifecycle = new Map<string, Promise<unknown>>();
  const serialize = <A extends unknown[], R>(
    key: (...args: A) => string,
    operation: (...args: A) => Promise<R>,
  ) =>
    track((...args: A): Promise<R> => {
      const taskId = key(...args);
      const previous = lifecycle.get(taskId) ?? Promise.resolve();
      const promise = previous
        .catch(() => undefined)
        .then(() => operation(...args));
      lifecycle.set(taskId, promise);
      const remove = () => {
        if (lifecycle.get(taskId) === promise) lifecycle.delete(taskId);
      };
      void promise.then(remove, remove);
      return promise;
    });
  return {
    scope: api.scope,
    describe: track(api.describe),
    create: track(api.create),
    list: track(api.list),
    inspect: track(api.inspect),
    start: serialize((_, params) => params.task_id, api.start),
    resume: serialize((_, taskId) => taskId, api.resume),
    steer: serialize((_, taskId) => taskId, api.steer),
    cancel: serialize((_, taskId) => taskId, api.cancel),
    events: track(api.events),
    journal: track(api.journal),
    artifact: track(api.artifact),
    diff: track(api.diff),
    evidence: track(api.evidence),
    checkpoint: track(api.checkpoint),
    verification: track(api.verification),
    export: track(api.export),
    restore: serialize((_, taskId) => taskId, api.restore),
    memoryProposals: track(api.memoryProposals),
    acceptMemoryProposal: track(api.acceptMemoryProposal),
    rejectMemoryProposal: track(api.rejectMemoryProposal),
    revertMemoryProposal: track(api.revertMemoryProposal),
    skills: track(api.skills),
    skillProposals: track(api.skillProposals),
    acceptSkillProposal: track(api.acceptSkillProposal),
    rejectSkillProposal: track(api.rejectSkillProposal),
    undoSkillReview: track(api.undoSkillReview),
    async close() {
      closing = true;
      if (runnerTimer) clearInterval(runnerTimer);
      await runner?.shutdown().catch(() => undefined);
      await Promise.allSettled([...childSweeps.values()]);
      await Promise.allSettled([...operations]);
      let cleanupFailed = false;
      await Promise.all(
        [...active].map(async ([taskId, runtime]) => {
          try {
            const context = internalContext(options.scope);
            const task = await options.store.inspect(context, taskId);
            if (task.status === "running")
              await options.store.update(context, taskId, task.revision, {
                status: "paused",
              });
          } catch {
            cleanupFailed = true;
          }
          try {
            await runtime.cancel();
          } catch {
            cleanupFailed = true;
          }
        }),
      );
      await Promise.allSettled([...jobs.values()]);
      if (cleanupFailed) throw new WorkbenchError("unavailable");
    },
  };
}
