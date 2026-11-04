import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import {
  type ChildLaunch,
  type ChildRunner,
  type ChildRuntimeAdapter,
  CollaborationError,
  createChildRunner,
  createOhMyPiChildAdapter,
} from "@mars/collaboration";
import type { RepositoryMapProvider } from "@mars/context";
import type {
  ArtifactRef,
  Budget,
  ExecutionProvider,
  RequestContext,
  RequiredCheck,
  Scope,
  Task,
  VerificationCheckResult,
  VerificationEvidenceRecord,
  VerificationView,
  WorkspaceRef,
} from "@mars/contracts";
import {
  REQUIRED_CHECK_DEFAULT_TIMEOUT_MS,
  RequiredCheckSchema,
  ScopeSchema,
  VERIFICATION_EVIDENCE_OPERATION,
  VerificationEvidenceRecordSchema,
  verificationStateFor,
} from "@mars/contracts";
import {
  EXECUTION_PACKAGE_VERSION,
  initialRequestAllowance,
  MAX_RUNTIME_INSTRUCTION_LENGTH,
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
  selectExecutionModel,
} from "@mars/execution";
import type { ModelProviderRegistry } from "@mars/providers";
import type { Turn } from "@mars/review";
import type { DurableTaskStore } from "@mars/tasks";
import { z } from "zod";
import { chooseChildModel, isReviewerRole } from "./child-model";
import {
  collaborationTools,
  type FrozenCollaboration,
  FrozenCollaborationSchema,
  type WorkbenchCollaboration,
} from "./collaboration-context";
import {
  type FrozenInstructions,
  FrozenInstructionsSchema,
  freezeInstructions,
  hookBlockMessage,
  hookResultRecord,
  renderPatchResult,
  repositorySkillsSource,
  type WorkbenchConventions,
  withFrozenInstructions,
} from "./conventions-context";
import {
  FrozenGraphSummarySchema,
  freezeGraphSummary,
  graphEvidence,
  validateFrozenGraphSummary,
  type WorkbenchKnowledgeGraph,
  withFrozenGraphSummary,
} from "./graph-context";
import {
  FrozenMemorySchema,
  freezeMemory,
  recallHistory,
  serializedBytes,
  validateFrozenMemory,
  type WorkbenchMemory,
  withFrozenMemory,
} from "./memory-context";
import { proposalTools, type WorkbenchOptimization } from "./proposal-context";
import {
  type Approvals,
  ApprovalsSchema,
  CheckpointRefSchema,
  type DiffResult,
  WorkspaceRefSchema,
} from "./protocol";
import {
  FrozenRepositoryMapSchema,
  freezeRepositoryMap,
  repositoryMapTokenBudget,
  validateFrozenRepositoryMap,
  withFrozenRepositoryMap,
} from "./repository-context";
import {
  researchTools,
  staleTaskResearch,
  type WorkbenchResearch,
} from "./research-context";
import { WorkbenchError, type WorkbenchOperations } from "./server";
import {
  type FrozenSkills,
  FrozenSkillsSchema,
  freezeCurrentSkills,
  validateFrozenSkills,
  type WorkbenchSkills,
  withFrozenSkills,
} from "./skills-context";
import {
  type FrozenRouting,
  FrozenRoutingSchema,
  routeLaunch,
  type WorkbenchSpecialists,
} from "./specialist-routing";
import { type WorkbenchWatch, watchEvidence } from "./watch-context";

const launchSchema = z
  .object({
    schema_version: z.literal(1),
    task_id: z.string().min(1),
    scope: ScopeSchema,
    model_id: z.string().min(1),
    deadline: z.number().int().positive().optional(),
    approvals: ApprovalsSchema,
    workspace: WorkspaceRefSchema,
    cwd: z.string().min(1).refine(isAbsolute),
    memory: FrozenMemorySchema.optional(),
    skills: FrozenSkillsSchema.optional(),
    repository_map: FrozenRepositoryMapSchema.optional(),
    knowledge_graph: FrozenGraphSummarySchema.optional(),
    instructions: FrozenInstructionsSchema.optional(),
    routing: FrozenRoutingSchema.optional(),
    collaboration: FrozenCollaborationSchema.optional(),
    /** Host-run checks fixed at launch; the model never sees or edits them. */
    required_checks: z.array(RequiredCheckSchema).max(32).optional(),
  })
  .strict();
type Launch = z.infer<typeof launchSchema>;

const MAX_VERIFICATION_RECORDS = 50;
/** Fragments of the text-form tool-call syntax some models emit instead of a structured call. */
const TEXTUAL_TOOL_CALL = /<function=[A-Za-z0-9_]+>|<\/?tool_call>/;

function textualToolCallDiagnostic(content: string): string | null {
  const match = TEXTUAL_TOOL_CALL.exec(content);
  if (!match) return null;
  return `Assistant text contains a tool call written as text (${match[0]}); it was never executed. Tools run only through validated structured calls.`;
}

function expectedDigest(check: RequiredCheck): string {
  return (
    check.sha256 ??
    createHash("sha256")
      .update(check.content ?? "", "utf8")
      .digest("hex")
  );
}

/**
 * Launch metadata keeps only the digest form of each required check, so a
 * start that was accepted can never write a launch the host refuses to read
 * (expected bytes travel in the request, not in `launch.json`).
 */
function freezeRequiredChecks(
  checks: readonly RequiredCheck[],
): RequiredCheck[] {
  return checks.map((check) =>
    RequiredCheckSchema.parse({
      kind: check.kind,
      path: check.path,
      sha256: expectedDigest(check),
      ...(check.timeout_ms !== undefined
        ? { timeout_ms: check.timeout_ms }
        : {}),
    }),
  );
}

class CheckTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Required check timed out after ${timeoutMs} ms`);
    this.name = "CheckTimeoutError";
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new CheckTimeoutError(timeoutMs)),
        timeoutMs,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

export interface WorkspaceHost extends ExecutionProvider {
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

export interface WorkbenchHostOptions {
  scope: Scope;
  workspaceLabel: string;
  stateRoot: string;
  store: DurableTaskStore;
  workspace: WorkspaceHost;
  registry: ModelProviderRegistry;
  canExecute: boolean;
  memory?: WorkbenchMemory;
  skills?: WorkbenchSkills;
  review?: WorkbenchReview;
  repositoryMap?: Pick<RepositoryMapProvider, "map">;
  specialists?: WorkbenchSpecialists;
  collaboration?: WorkbenchCollaboration;
  research?: WorkbenchResearch;
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
}

export interface WorkbenchHostApi extends WorkbenchOperations {
  close(): Promise<void>;
}

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
/**
 * The workspace id a child's tree is prepared under. The runner derives child
 * task ids by suffixing the parent's, which can exceed the provider's 128
 * character limit for a valid parent; such ids map to a stable digest alias.
 */
function childWorkspaceTaskId(childTaskId: string): string {
  if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(childTaskId))
    return childTaskId;
  return "child." + createHash("sha256").update(childTaskId).digest("hex");
}

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

function internalContext(scope: Scope): RequestContext {
  return { schema_version: 1, scope, request_id: randomUUID() };
}

function scopeKey(scope: Scope, taskId: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        scope.owner_id,
        scope.project_id,
        scope.workspace_id ?? null,
        taskId,
      ]),
    )
    .digest("hex");
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return (
    rel === "" ||
    (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
  );
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
  const proposalsFor = () =>
    options.optimization
      ? {
          proposals: proposalTools(options.optimization, () =>
            internalContext(options.scope),
          ),
        }
      : {};
  const staleResearch = async (taskId: string) => {
    if (!options.research) return;
    await staleTaskResearch(
      options.research,
      internalContext(options.scope),
      taskId,
    ).catch(() => undefined);
  };
  const reconcileResearch = async (taskId: string) => {
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
  const taskState = (task: Task) =>
    join(root, scopeKey(options.scope, task.task_id));
  const readLaunch = async (task: Task): Promise<Launch> => {
    const dir = taskState(task);
    if (!inside(root, dir) || (await realpath(dir)) !== dir)
      throw new WorkbenchError("not_found");
    const file = await open(
      join(dir, "launch.json"),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const info = await file.stat();
      if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 128 * 1024)
        throw new WorkbenchError("internal_error");
      const value = launchSchema.parse(JSON.parse(await file.readFile("utf8")));
      if (value.repository_map) {
        const map = value.repository_map;
        validateFrozenRepositoryMap(map);
        if (
          !value.approvals.read ||
          map.scope.owner_id !== task.scope.owner_id ||
          map.scope.project_id !== task.scope.project_id ||
          map.scope.workspace_id !== task.scope.workspace_id ||
          map.workspace.workspace_id !== value.workspace.workspace_id ||
          map.workspace.provider !== value.workspace.provider ||
          map.workspace.revision !== value.workspace.revision
        )
          throw new WorkbenchError("internal_error");
      }
      if (value.knowledge_graph) {
        const graph = value.knowledge_graph;
        validateFrozenGraphSummary(graph);
        if (
          !value.approvals.read ||
          graph.scope.owner_id !== task.scope.owner_id ||
          graph.scope.project_id !== task.scope.project_id ||
          graph.scope.workspace_id !== task.scope.workspace_id ||
          graph.workspace.workspace_id !== value.workspace.workspace_id ||
          graph.workspace.provider !== value.workspace.provider ||
          graph.workspace.revision !== value.workspace.revision
        )
          throw new WorkbenchError("internal_error");
      }
      if (value.memory) {
        validateFrozenMemory(value.memory);
        if (
          value.memory.scope.owner_id !== task.scope.owner_id ||
          value.memory.scope.project_id !== task.scope.project_id ||
          value.memory.scope.workspace_id !== task.scope.workspace_id
        )
          throw new WorkbenchError("internal_error");
      }
      if (value.skills) {
        validateFrozenSkills(value.skills);
        if (!value.approvals.read) throw new WorkbenchError("internal_error");
      }
      if (
        value.task_id !== task.task_id ||
        value.scope.owner_id !== task.scope.owner_id ||
        value.scope.project_id !== task.scope.project_id ||
        value.scope.workspace_id !== task.scope.workspace_id
      )
        throw new WorkbenchError("internal_error");
      return value;
    } finally {
      await file.close();
    }
  };
  const writeLaunch = async (task: Task, launch: Launch): Promise<void> => {
    const dir = taskState(task);
    if ((await realpath(dir)) !== dir || ((await stat(dir)).mode & 0o077) !== 0)
      throw new WorkbenchError("internal_error");
    const file = await open(
      join(dir, "launch.json"),
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.writeFile(JSON.stringify(launchSchema.parse(launch)));
      await file.sync();
    } finally {
      await file.close();
    }
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
    const launch = await readLaunch(task).catch(() => null);
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
  const ownedArtifact = async (
    context: RequestContext,
    taskId: string,
    ref: ArtifactRef,
  ): Promise<boolean> => {
    const task = await options.store.inspect(context, taskId);
    if (task.artifacts.some((item) => item.artifact_id === ref.artifact_id))
      return true;
    for await (const event of options.store.events(context, taskId)) {
      if (event.payload.artifact_id === ref.artifact_id) return true;
      if (
        event.event_type === "tool.completed" &&
        event.producer === "@mars/workbench"
      ) {
        const bytes = await options.store.artifacts.get(context, event.payload);
        const payload = z
          .object({
            operation: z.literal("workspace.checkpoint"),
            checkpoint: CheckpointRefSchema,
          })
          .strict()
          .safeParse(JSON.parse(new TextDecoder().decode(bytes)));
        if (
          payload.success &&
          payload.data.checkpoint.artifact.artifact_id === ref.artifact_id
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
        event.producer !== "@mars/workbench"
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
          operation: z.literal("runtime.result"),
          steering_event_ids: z.array(z.string()),
        })
        .safeParse(payload);
      if (event.producer === "@mars/workbench" && result.success) {
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
    await options.store.appendEvent(context, task.task_id, {
      event_type: "tool.completed",
      producer: "@mars/workbench",
      run_id: randomUUID(),
      versions: [{ component: "@mars/workbench", revision: "0.0.1" }],
      source_event_ids: steeringEventIds,
      payload: {
        operation: "runtime.result",
        status: outcome.status,
        steering_event_ids: steeringEventIds,
      },
      usage: {
        input_tokens: Math.max(0, outcome.usage.input_tokens - previous.input),
        output_tokens: Math.max(
          0,
          outcome.usage.output_tokens - previous.output,
        ),
        cost_usd:
          options.registry.getModel(runtime.modelId)?.pricing.free === true
            ? 0
            : null,
      },
    });
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
        event.producer !== "@mars/workbench"
      )
        continue;
      const bytes = await options.store.artifacts.get(context, event.payload);
      const payload = z
        .object({
          operation: z.literal("child.result"),
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
  const childRouting = new Map<string, FrozenRouting>();
  // Models already used inside a task (coordinator and children) so a
  // reviewer child can be routed to a different one; per child, whether its
  // review was independent, mirrored into the child.result event.
  // The history is durable (private per-task record) and selection is
  // serialized per task, so it survives pauses and host restarts and two
  // children routed concurrently can never both claim the same model.
  const TaskModelsSchema = z
    .object({
      models: z.array(z.string().min(1)),
      verdicts: z.record(z.string(), z.boolean()),
    })
    .strict();
  type TaskModels = z.infer<typeof TaskModelsSchema>;
  const taskModels = new Map<string, TaskModels>();
  const taskModelLocks = new Map<string, Promise<unknown>>();
  const taskModelsPath = (taskId: string) =>
    join(
      options.stateRoot,
      "children",
      "models",
      childWorkspaceTaskId(taskId) + ".json",
    );
  const loadTaskModels = async (taskId: string): Promise<TaskModels> => {
    const known = taskModels.get(taskId);
    if (known) return known;
    const parsed = await readFile(taskModelsPath(taskId), "utf8")
      .then((text) => TaskModelsSchema.safeParse(JSON.parse(text)))
      .catch(() => null);
    const record = parsed?.success ? parsed.data : { models: [], verdicts: {} };
    taskModels.set(taskId, record);
    return record;
  };
  const saveTaskModels = async (taskId: string, record: TaskModels) => {
    taskModels.set(taskId, record);
    const path = taskModelsPath(taskId);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = path + "." + randomUUID() + ".tmp";
    await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
    await rename(temporary, path);
  };
  const forgetTaskModels = async (taskId: string) => {
    taskModels.delete(taskId);
    await rm(taskModelsPath(taskId), { force: true }).catch(() => undefined);
  };
  const withTaskModelLock = async <T>(
    taskId: string,
    work: () => Promise<T>,
  ): Promise<T> => {
    const previous = taskModelLocks.get(taskId) ?? Promise.resolve();
    const run = previous.then(work, work);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    taskModelLocks.set(taskId, settled);
    try {
      return await run;
    } finally {
      if (taskModelLocks.get(taskId) === settled) taskModelLocks.delete(taskId);
    }
  };
  /** Routing decisions survive a host restart in a private per-child record. */
  const childRoutingPath = (childTaskId: string) =>
    join(
      options.stateRoot,
      "children",
      "routing",
      childWorkspaceTaskId(childTaskId) + ".json",
    );
  const rememberChildRouting = async (
    childTaskId: string,
    routing: FrozenRouting,
  ) => {
    childRouting.set(childTaskId, routing);
    const path = childRoutingPath(childTaskId);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = path + "." + randomUUID() + ".tmp";
    await writeFile(temporary, JSON.stringify(routing), { mode: 0o600 });
    await rename(temporary, path);
  };
  const recallChildRouting = async (
    childTaskId: string,
  ): Promise<FrozenRouting | null> => {
    const known = childRouting.get(childTaskId);
    if (known) return known;
    const parsed = await readFile(childRoutingPath(childTaskId), "utf8")
      .then((text) => FrozenRoutingSchema.safeParse(JSON.parse(text)))
      .catch(() => null);
    if (!parsed?.success) return null;
    childRouting.set(childTaskId, parsed.data);
    return parsed.data;
  };
  const forgetChildRouting = async (childTaskId: string) => {
    childRouting.delete(childTaskId);
    await rm(childRoutingPath(childTaskId), { force: true }).catch(
      () => undefined,
    );
  };
  const childLaunches = new Map<string, ChildLaunch>();
  const childSweeps = new Map<string, Promise<void>>();
  /** Room capabilities kept for sweeping after the coordinator has exited. */
  const sweepRooms = new Map<string, FrozenCollaboration>();
  const TERMINAL_CHILD_STATES = new Set([
    "completed",
    "failed",
    "cancelled",
    "expired",
  ]);
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
          const final = TERMINAL_CHILD_STATES.has(child.state);
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
          await options.store.appendEvent(context, taskId, {
            event_type: "tool.completed",
            producer: "@mars/workbench",
            run_id: randomUUID(),
            versions: [{ component: "@mars/workbench", revision: "0.0.1" }],
            payload: {
              operation: "child.result",
              child_task_id: childTaskId,
              child_agent_id: child.agent_id,
              role_label: child.role_label,
              task_revision: child.task_revision,
              attempt: launch?.attempt ?? null,
              status: child.state,
              model_id: launch?.model_id ?? null,
              routing: await recallChildRouting(childTaskId),
              reviewer_independent:
                (await loadTaskModels(taskId)).verdicts[childTaskId] ?? null,
            },
            usage: delta,
          });
          if (final) {
            childLaunches.delete(childTaskId);
            await forgetChildRouting(childTaskId);
          }
        }
        cursor = page.next_cursor;
      } while (cursor);
      if (settled && !liveRooms.has(taskId)) {
        sweepRooms.delete(taskId);
        // A paused task keeps its model history for later reviewers; only a
        // terminal task with every child settled releases it.
        const status = await options.store
          .inspect(context, taskId)
          .then((task) => task.status)
          .catch(() => null);
        if (
          status === "completed" ||
          status === "failed" ||
          status === "cancelled"
        )
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
      : Promise.resolve();
  const closeRecordedRoom = async (task: Task, mode: "drain" | "cancel") => {
    const launch = await readLaunch(task).catch(() => null);
    if (launch?.collaboration)
      await closeFrozenRoom(task.task_id, launch.collaboration, mode);
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
    const launch = await readLaunch(task).catch(() => null);
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
      await rewriteLaunch(task, { ...launch, collaboration: frozen });
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
  const rewriteLaunch = async (task: Task, launch: Launch): Promise<void> => {
    const dir = taskState(task);
    if ((await realpath(dir)) !== dir || ((await stat(dir)).mode & 0o077) !== 0)
      throw new WorkbenchError("internal_error");
    const temporary = join(dir, "launch.json." + randomUUID());
    const file = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.writeFile(JSON.stringify(launchSchema.parse(launch)));
    } finally {
      await file.close();
    }
    await rename(temporary, join(dir, "launch.json"));
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
  const recordReviewTurn = (
    runtime: RuntimeSession,
    instruction: string,
    content: string,
    iterationsBefore: number,
  ) => {
    if (!options.review) return;
    try {
      options.review.recordTurn({
        sessionId: runtime.sessionId,
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
        success: true,
      });
    } catch {
      // Review is advisory; it never affects the task.
    }
  };
  /**
   * The host-owned verdict: re-reads the candidate (the workspace revision
   * after the agent stopped), runs every required check against it with a
   * bounded timeout, confirms the revision did not move meanwhile, and
   * persists the result as task evidence. Never throws; an unavailable
   * verifier is `inconclusive`, never `passed`.
   */
  const verifyCandidate = async (
    task: Task,
    runtime: RuntimeSession,
    requiredChecks: readonly RequiredCheck[],
    content: string,
  ): Promise<VerificationEvidenceRecord | null> => {
    if (requiredChecks.length === 0) return null;
    const context = internalContext(options.scope);
    const startedAt = Date.now();
    const diagnostics: string[] = [];
    const textual = textualToolCallDiagnostic(content);
    if (textual) diagnostics.push(textual);
    const persist = async (record: VerificationEvidenceRecord) => {
      await options.store
        .appendEvent(context, task.task_id, {
          event_type: "tool.completed",
          producer: "@mars/workbench",
          run_id: runtime.sessionId,
          versions: [{ component: "@mars/workbench", revision: "0.0.1" }],
          payload: record,
        })
        .catch(() => undefined);
      return record;
    };
    let candidate: WorkspaceRef;
    try {
      candidate = WorkspaceRefSchema.parse(
        await withTimeout(
          options.workspace.reopen(context, task.task_id),
          REQUIRED_CHECK_DEFAULT_TIMEOUT_MS,
        ),
      );
    } catch {
      // No candidate can be named, so no check can run; the failure is still
      // evidence (inconclusive), never silence that reads as "unverified".
      return persist(
        VerificationEvidenceRecordSchema.parse({
          schema_version: 1,
          operation: VERIFICATION_EVIDENCE_OPERATION,
          run_id: runtime.sessionId,
          task_id: task.task_id,
          task_revision: task.revision,
          candidate: null,
          verdict: "inconclusive",
          verified: false,
          checks: [],
          reasons: [
            "Candidate revision could not be acquired; required checks did not run",
          ],
          diagnostics,
          duration_ms: Math.max(0, Date.now() - startedAt),
          recorded_at: new Date().toISOString(),
        } satisfies VerificationEvidenceRecord),
      );
    }
    const checks: VerificationCheckResult[] = [];
    const reasons: string[] = [];
    for (const check of requiredChecks) {
      const expected = expectedDigest(check);
      const timeoutMs = check.timeout_ms ?? REQUIRED_CHECK_DEFAULT_TIMEOUT_MS;
      const began = Date.now();
      let status: VerificationCheckResult["status"];
      let reason: string | null = null;
      let observed: string | null = null;
      try {
        const artifact = await withTimeout(
          options.workspace.read(context, candidate, check.path),
          timeoutMs,
        );
        observed = artifact.sha256;
        if (artifact.sha256 === expected) status = "passed";
        else {
          status = "failed";
          reason = `Required file content mismatch: ${check.path}`;
        }
      } catch (error) {
        if (error instanceof CheckTimeoutError) {
          status = "inconclusive";
          reason = `${error.message}: ${check.path}`;
        } else if (
          error instanceof Error &&
          "code" in error &&
          error.code === "not_found"
        ) {
          status = "failed";
          reason = `Required file missing: ${check.path}`;
        } else {
          status = "inconclusive";
          reason = `Verifier unavailable for ${check.path}`;
        }
      }
      if (reason) reasons.push(reason);
      checks.push({
        kind: check.kind,
        path: check.path,
        expected_sha256: expected,
        observed_sha256: observed,
        status,
        reason,
        duration_ms: Math.max(0, Date.now() - began),
      });
    }
    let verdict: VerificationEvidenceRecord["verdict"] = checks.some(
      (check) => check.status === "failed",
    )
      ? "failed"
      : checks.some((check) => check.status === "inconclusive")
        ? "inconclusive"
        : "passed";
    try {
      const after = await withTimeout(
        options.workspace.reopen(context, task.task_id),
        REQUIRED_CHECK_DEFAULT_TIMEOUT_MS,
      );
      if (after.revision !== candidate.revision) {
        verdict = "inconclusive";
        reasons.push("Workspace revision changed while checks were running");
      }
    } catch {
      verdict = "inconclusive";
      reasons.push("Candidate revision could not be confirmed after checks");
    }
    return persist(
      VerificationEvidenceRecordSchema.parse({
        schema_version: 1,
        operation: VERIFICATION_EVIDENCE_OPERATION,
        run_id: runtime.sessionId,
        task_id: task.task_id,
        task_revision: task.revision,
        candidate,
        verdict,
        verified:
          verdict === "passed" &&
          checks.every((check) => check.status === "passed"),
        checks,
        reasons,
        diagnostics,
        duration_ms: Math.max(0, Date.now() - startedAt),
        recorded_at: new Date().toISOString(),
      } satisfies VerificationEvidenceRecord),
    );
  };
  const verificationRecords = async (
    context: RequestContext,
    taskId: string,
  ): Promise<VerificationEvidenceRecord[]> => {
    const records: VerificationEvidenceRecord[] = [];
    for await (const event of options.store.events(context, taskId)) {
      if (
        event.event_type !== "tool.completed" ||
        event.producer !== "@mars/workbench"
      )
        continue;
      const bytes = await options.store.artifacts.get(context, event.payload);
      let payload: unknown;
      try {
        payload = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        continue;
      }
      if (
        !payload ||
        typeof payload !== "object" ||
        (payload as { operation?: unknown }).operation !==
          VERIFICATION_EVIDENCE_OPERATION
      )
        continue;
      const parsed = VerificationEvidenceRecordSchema.safeParse(payload);
      if (parsed.success && parsed.data.task_id === taskId)
        records.push(parsed.data);
    }
    return records.slice(-MAX_VERIFICATION_RECORDS);
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
              .appendEvent(context, task.task_id, {
                event_type: "tool.completed",
                producer: "@mars/workbench",
                run_id: runtime.sessionId,
                versions: [{ component: "@mars/workbench", revision: "0.0.1" }],
                payload: { operation: "memory.index", status: "unavailable" },
              })
              .catch(() => undefined);
          }
        }
        await publishResult(
          task,
          runtime,
          outcome,
          outcome.status === "cancelled" ? [] : steeringEventIds,
        );
        const context = internalContext(options.scope);
        let current = await options.store.inspect(context, task.task_id);
        if (current.status !== "running") return;
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
        if (status === "completed")
          await verifyCandidate(
            current,
            runtime,
            requiredChecks,
            outcome.content,
          );
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
        if (status === "completed" && reviewable)
          recordReviewTurn(
            runtime,
            instruction,
            outcome.content,
            iterationsBefore,
          );
        await reconcileResearch(task.task_id);
      } catch {
        await closeRoom("cancel");
        const context = internalContext(options.scope);
        const current = await options.store
          .inspect(context, task.task_id)
          .catch(() => null);
        if (current?.status === "running")
          await options.store
            .update(context, task.task_id, current.revision, {
              status: "failed",
            })
            .catch(() => undefined);
        await reconcileResearch(task.task_id);
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
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: unknown }).code === "too-large"
      )
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
        .appendEvent(context, taskId, {
          event_type: "tool.completed",
          producer: "@mars/workbench",
          run_id: randomUUID(),
          versions: [{ component: "@mars/workbench", revision: "0.0.1" }],
          payload: {
            operation: "hook.completed",
            event,
            ...(hookContext.tool ? { tool: hookContext.tool } : {}),
            results: results.map(hookResultRecord),
          },
        })
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
      read: (path) =>
        hooked(
          "mars_read",
          path,
          () => authorize("read"),
          async (context) =>
            options.store.artifacts.get(
              context,
              await options.workspace.read(context, workspace, path),
            ),
        ),
      write: (path, bytes) =>
        hooked(
          "mars_write",
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
    const notFound = (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: unknown }).code === "not_found";
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
          const code =
            typeof error === "object" && error !== null && "code" in error
              ? (error as { code: unknown }).code
              : undefined;
          // A file too large to read still exists and can be deleted or moved.
          if (code === "limit_exceeded") return "file" as const;
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
                    watchFor(launch.task_id, cwd, {
                      read: launch.approvals.read,
                      execute:
                        launch.approvals.execute &&
                        launch.workspace_mode !== "read_only",
                    }),
                }
              : {}),
          }),
    );
    runner = createChildRunner({
      collaboration: {
        host: collaboration.host,
        agents: collaboration.agents,
        close: async () => undefined,
      },
      adapter,
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
              );
              await rememberChildRouting(request.child_task_id, routing).catch(
                () => undefined,
              );
            } catch {
              routing = null;
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
          }).catch(() => undefined);
          return { model_id: choice.model_id, reason: choice.reason };
        }),
    });
    await runner.recover();
    const tick = () => void runner?.tick().catch(() => undefined);
    runnerTimer = setInterval(tick, delegation.tickMs ?? 1000);
    runnerTimer.unref();
  }

  const api: WorkbenchOperations = {
    scope: options.scope,
    async describe() {
      if (closing) throw new WorkbenchError("unavailable");
      return {
        scope: options.scope,
        workspaceLabel: options.workspaceLabel,
        capabilities: { execute: options.canExecute, checkpoint: true },
      };
    },
    async create(context, task) {
      checkContext(context);
      return options.store.create(context, task);
    },
    async list(context) {
      checkContext(context);
      return options.store.list(context);
    },
    async inspect(context, taskId) {
      checkContext(context);
      return options.store.inspect(context, taskId);
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
      // A request that names a repository slash command (`/name args`) is
      // expanded from the command file; the durable task keeps the original.
      const expanded = expandRequest(task.request);
      const request = expanded ? expanded.prompt : task.request;
      const baseInstruction = `${request}\n\nAcceptance criteria:\n${task.acceptance_criteria.map((criterion) => `- ${criterion}`).join("\n")}`;
      if (baseInstruction.length > MAX_RUNTIME_INSTRUCTION_LENGTH)
        throw new WorkbenchError("too_large");
      // The coordinator runs under the room budget minus the delegation pool
      // and carries the delegation tools, so optional evidence is sized the
      // way the runtime will actually be constrained.
      const coordinatorBudget: Budget = delegation
        ? {
            ...task.budget,
            max_tokens: Math.max(
              0,
              task.budget.max_tokens - delegation.pool.max_tokens,
            ),
          }
        : task.budget;
      let routing: FrozenRouting | undefined;
      if (options.specialists && params.model_id === undefined) {
        try {
          routing = await routeLaunch(
            context,
            task,
            toolsRequired(params.approvals, Boolean(options.collaboration)),
            options.specialists,
            initialRequestAllowance({
              approvals: params.approvals,
              recall: Boolean(options.memory),
              collaboration: Boolean(options.collaboration),
              delegation: Boolean(delegation),
              research: Boolean(options.research),
              proposals: Boolean(options.optimization),
              watch: Boolean(options.watch),
              knowledgeGraph: Boolean(options.knowledgeGraph),
              patch: Boolean(options.conventions?.applyPatch),
              instruction: baseInstruction,
            }) + MIN_INITIAL_OUTPUT_RESERVE,
          );
        } catch {
          throw new WorkbenchError("unavailable");
        }
      }
      const model = selectModel(
        params.model_id ?? routing?.model_id ?? undefined,
        toolsRequired(params.approvals, Boolean(options.collaboration)),
      );
      const capacity = optionalInstructionCapacity({
        model,
        budget: coordinatorBudget,
        approvals: params.approvals,
        recall: Boolean(options.memory),
        collaboration: Boolean(options.collaboration),
        delegation: Boolean(delegation),
        research: Boolean(options.research),
        proposals: Boolean(options.optimization),
        watch: Boolean(options.watch),
        knowledgeGraph: Boolean(options.knowledgeGraph),
        patch: Boolean(options.conventions?.applyPatch),
        instruction: baseInstruction,
      });
      let memory: z.infer<typeof FrozenMemorySchema> | undefined;
      if (options.memory && params.approvals.read) {
        try {
          memory = freezeMemory(
            context,
            await options.memory.snapshot(context),
            baseInstruction,
            capacity,
          );
        } catch {
          throw new WorkbenchError("unavailable");
        }
      }
      let instruction = withFrozenMemory(baseInstruction, memory);
      let skills: FrozenSkills | undefined;
      const skillsSource = repositorySkillsSource(
        options.skills,
        options.conventions?.repositorySkills,
      );
      if (skillsSource && params.approvals.read) {
        try {
          skills = await freezeCurrentSkills(
            skillsSource,
            instruction,
            capacity -
              (serializedBytes(instruction) - serializedBytes(baseInstruction)),
          );
        } catch {
          throw new WorkbenchError("unavailable");
        }
        instruction = withFrozenSkills(instruction, skills);
      }
      // Repository instructions come from the trusted checkout, not from the
      // workspace, so they do not depend on read approval; they are frozen
      // whole or omitted.
      let instructions: FrozenInstructions | undefined;
      const foundInstructions = options.conventions?.instructions;
      if (foundInstructions) {
        instructions = freezeInstructions(
          foundInstructions,
          instruction,
          capacity -
            (serializedBytes(instruction) - serializedBytes(baseInstruction)),
        );
        instruction = withFrozenInstructions(instruction, instructions);
      }
      const remainingCapacity =
        capacity -
        (serializedBytes(instruction) - serializedBytes(baseInstruction));
      const running = await options.store.update(
        context,
        task.task_id,
        task.revision,
        {
          status: "running",
          ...(routing?.specialist_revision
            ? { specialist_revision: routing.specialist_revision }
            : {}),
        },
      );
      // Research deadlines follow the runtime ledger, whose clock starts when
      // the session opens, not when the task was marked running.
      let launchDeadline = Date.now() + running.budget.max_duration_ms;
      let collaboration: FrozenCollaboration | undefined;
      if (options.collaboration) {
        try {
          const opened = await options.collaboration.host.openRoom(context, {
            task: running,
            idempotency_key: running.task_id,
            authority: {
              approvals: params.approvals,
              allow_delegation: Boolean(delegation),
              paid_consent: false,
            },
            ...(delegation
              ? {
                  delegation_pool: delegation.pool,
                  ...(delegation.limits ? { limits: delegation.limits } : {}),
                }
              : {}),
            model_id: model.id,
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
          collaboration = {
            room_id: opened.room.room_id,
            capability: opened.coordinator,
            budget: opened.room.coordinator_runtime_budget,
            delegation: Boolean(delegation),
          };
        } catch {
          await options.store
            .update(context, task.task_id, running.revision, {
              status: "failed",
            })
            .catch(() => undefined);
          await reconcileResearch(task.task_id);
          throw new WorkbenchError("unavailable");
        }
      }
      let runtime: RuntimeSession | undefined;
      const initialObservations: RuntimeObservation[] = [];
      let bound = false;
      const persistObservation = observe(task.task_id);
      try {
        const workspace = await options.workspace.prepare(
          context,
          task.task_id,
        );
        let repositoryMap:
          | z.infer<typeof FrozenRepositoryMapSchema>
          | undefined;
        const maxOutputTokens = repositoryMapTokenBudget(
          instruction,
          remainingCapacity,
        );
        if (options.repositoryMap && params.approvals.read && maxOutputTokens) {
          try {
            repositoryMap = freezeRepositoryMap(
              context,
              workspace,
              await options.repositoryMap.map(context, {
                workspace: WorkspaceRefSchema.parse(workspace),
                query: task.request.slice(0, 4096),
                max_output_tokens: maxOutputTokens,
              }),
              instruction,
              remainingCapacity,
            );
            assertPublicBytes(
              new TextEncoder().encode(repositoryMap.text),
              await privatePatterns(context, task.task_id),
            );
            instruction = withFrozenRepositoryMap(instruction, repositoryMap);
          } catch {
            repositoryMap = undefined;
            await options.store
              .appendEvent(internalContext(options.scope), task.task_id, {
                event_type: "tool.completed",
                producer: "@mars/workbench",
                run_id: randomUUID(),
                versions: [{ component: "@mars/workbench", revision: "0.0.1" }],
                payload: { operation: "context.map", status: "unavailable" },
              })
              .catch(() => undefined);
          }
        }
        const stateDir = taskState(task);
        await mkdir(stateDir, { mode: 0o700 });
        const cwd = await options.workspace.cwd(context, workspace);
        let graphSummary: z.infer<typeof FrozenGraphSummarySchema> | undefined;
        if (options.knowledgeGraph && params.approvals.read) {
          try {
            const found = await options.knowledgeGraph.lookup(
              graphBinding(
                context,
                task.task_id,
                cwd,
                workspace,
                params.approvals,
              ),
            );
            if (found.status === "ready") {
              graphSummary = freezeGraphSummary(
                context,
                WorkspaceRefSchema.parse(workspace),
                found.artifact,
                instruction,
                capacity -
                  (serializedBytes(instruction) -
                    serializedBytes(baseInstruction)),
              );
              if (graphSummary) {
                assertPublicBytes(
                  new TextEncoder().encode(graphSummary.text),
                  await privatePatterns(context, task.task_id),
                );
                instruction = withFrozenGraphSummary(instruction, graphSummary);
              }
            }
          } catch {
            graphSummary = undefined;
          }
        }
        runtime = await runtimeFactory({
          task: runtimeTask(running, collaboration),
          cwd,
          stateDir,
          registry: options.registry,
          modelId: model.id,
          approvals: params.approvals,
          tools: toolsFor(
            workspace,
            params.approvals,
            running.budget,
            activeTask(running.task_id),
            [],
            task.task_id,
          ),
          ...patchFor(
            workspace,
            params.approvals,
            running.budget,
            activeTask(running.task_id),
            task.task_id,
          ),
          ...(collaboration
            ? roomToolsFor(
                task.task_id,
                collaboration,
                workspace,
                params.approvals,
              )
            : {}),
          ...(params.approvals.read ? historyFor(context) : {}),
          ...researchFor(task.task_id, () => launchDeadline),
          ...proposalsFor(),
          ...watchOption(task.task_id, cwd, params.approvals),
          ...graphOption(
            context,
            task.task_id,
            cwd,
            workspace,
            params.approvals,
          ),
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
        launchDeadline = Date.now() + running.budget.max_duration_ms;
        if (closing) throw new WorkbenchError("unavailable");
        await writeLaunch(task, {
          schema_version: 1,
          task_id: task.task_id,
          scope: task.scope,
          cwd,
          model_id: runtime.modelId,
          deadline: launchDeadline,
          approvals: params.approvals,
          workspace: WorkspaceRefSchema.parse(workspace),
          ...(memory ? { memory } : {}),
          ...(skills ? { skills } : {}),
          ...(repositoryMap ? { repository_map: repositoryMap } : {}),
          ...(graphSummary ? { knowledge_graph: graphSummary } : {}),
          ...(instructions ? { instructions } : {}),
          ...(routing ? { routing } : {}),
          ...(collaboration ? { collaboration } : {}),
          ...(params.required_checks?.length
            ? { required_checks: freezeRequiredChecks(params.required_checks) }
            : {}),
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
        for (const observation of initialObservations)
          await persistObservation(observation);
        bound = true;
        if (options.conventions) {
          const omittedInstructions =
            Boolean(foundInstructions) && !instructions;
          if (expanded || omittedInstructions)
            await options.store
              .appendEvent(internalContext(options.scope), task.task_id, {
                event_type: "tool.completed",
                producer: "@mars/workbench",
                run_id: randomUUID(),
                versions: [{ component: "@mars/workbench", revision: "0.0.1" }],
                payload: {
                  operation: "conventions.applied",
                  ...(expanded ? { command: expanded.name } : {}),
                  instructions: instructions
                    ? "frozen"
                    : foundInstructions
                      ? "omitted"
                      : "none",
                },
              })
              .catch(() => undefined);
          await dispatchHooks(
            task.task_id,
            workspace,
            params.approvals,
            running.budget,
            "session-start",
            {},
          );
        }
        run(
          running,
          workspace,
          runtime,
          instruction,
          [],
          false,
          collaboration,
          params.approvals.read,
          params.required_checks ?? [],
        );
        return running;
      } catch (error) {
        await runtime?.dispose().catch(() => undefined);
        if (collaboration)
          await closeFrozenRoom(task.task_id, collaboration, "cancel");
        const current = await options.store
          .inspect(context, task.task_id)
          .catch(() => null);
        if (current?.status === "running")
          await options.store
            .update(
              internalContext(options.scope),
              task.task_id,
              current.revision,
              { status: "failed" },
            )
            .catch(() => undefined);
        await reconcileResearch(task.task_id);
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
      const launch = await readLaunch(task);
      if (launch.approvals.execute && !options.canExecute)
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
      const running = await options.store.resume(context, taskId, revision);
      let runtime: RuntimeSession | undefined;
      try {
        runtime = await runtimeFactory({
          task: runtimeTask(running, launch.collaboration),
          cwd,
          stateDir: taskState(task),
          sessionFile: binding.session_file,
          registry: options.registry,
          modelId: launch.model_id,
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
        await runtime?.dispose().catch(() => undefined);
        const current = await options.store.inspect(context, taskId);
        if (current.status === "running")
          await options.store.update(
            internalContext(options.scope),
            taskId,
            current.revision,
            { status: "paused" },
          );
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
      await closeRecordedRoom(task, "cancel");
      await reconcileResearch(taskId);
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
      return diff;
    },
    async checkpoint(context, taskId) {
      checkContext(context);
      await options.store.inspect(context, taskId);
      const workspace = await options.workspace.reopen(context, taskId);
      const checkpoint = CheckpointRefSchema.parse(
        await options.workspace.checkpoint(context, workspace),
      );
      await options.store.artifacts.get(context, checkpoint.artifact);
      await options.store.appendEvent(internalContext(options.scope), taskId, {
        event_type: "tool.completed",
        run_id: randomUUID(),
        producer: "@mars/workbench",
        versions: [{ component: "@mars/workbench", revision: "0.0.1" }],
        payload: { operation: "workspace.checkpoint", checkpoint },
      });
      return checkpoint;
    },
    async verification(context, taskId): Promise<VerificationView> {
      checkContext(context);
      await options.store.inspect(context, taskId);
      const records = await verificationRecords(context, taskId);
      let candidate: WorkspaceRef | null = null;
      try {
        candidate = WorkspaceRefSchema.parse(
          await options.workspace.reopen(context, taskId),
        );
      } catch {
        candidate = null;
      }
      const presentation = verificationStateFor(
        candidate?.revision ?? null,
        records,
      );
      const view: VerificationView = {
        candidate,
        state: presentation.state,
        record: presentation.record,
        reasons: presentation.reasons,
        records,
      };
      // Same guard as artifacts and diffs: nothing host-private leaves the
      // service, even when a client named such a path in a required check.
      assertPublicBytes(
        new TextEncoder().encode(JSON.stringify(view)),
        await privatePatterns(context, taskId),
      );
      return view;
    },
    async restore(context, taskId, checkpointId, revision) {
      checkContext(context);
      const task = await options.store.inspect(context, taskId);
      if (task.status === "running" || active.has(taskId))
        throw new WorkbenchError("conflict");
      const workspace = await options.workspace.reopen(context, taskId);
      for await (const event of options.store.events(context, taskId)) {
        if (
          event.event_type !== "tool.completed" ||
          event.producer !== "@mars/workbench"
        )
          continue;
        const bytes = await options.store.artifacts.get(context, event.payload);
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
    artifact: track(api.artifact),
    diff: track(api.diff),
    checkpoint: track(api.checkpoint),
    verification: track(api.verification),
    restore: serialize((_, taskId) => taskId, api.restore),
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
