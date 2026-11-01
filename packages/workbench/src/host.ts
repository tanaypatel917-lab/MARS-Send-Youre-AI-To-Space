import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import {
  type ChildLaunch,
  type ChildOutcome,
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
  Scope,
  Task,
  WorkspaceRef,
} from "@mars/contracts";
import { ScopeSchema } from "@mars/contracts";
import {
  EXECUTION_PACKAGE_VERSION,
  initialRequestAllowance,
  MAX_RUNTIME_INSTRUCTION_LENGTH,
  MIN_INITIAL_OUTPUT_RESERVE,
  openRuntimeSession,
  optionalInstructionCapacity,
  type RuntimeObservation,
  type RuntimeOutcome,
  type RuntimeSession,
  type RuntimeSessionOptions,
  type RuntimeTools,
  selectExecutionModel,
} from "@mars/execution";
import type { ModelProviderRegistry } from "@mars/providers";
import type { DurableTaskStore } from "@mars/tasks";
import { z } from "zod";
import {
  collaborationTools,
  type FrozenCollaboration,
  FrozenCollaborationSchema,
  type WorkbenchCollaboration,
} from "./collaboration-context";
import {
  FrozenMemorySchema,
  freezeMemory,
  recallHistory,
  serializedBytes,
  validateFrozenMemory,
  type WorkbenchMemory,
  withFrozenMemory,
} from "./memory-context";
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
import { WorkbenchError, type WorkbenchOperations } from "./server";
import {
  type FrozenRouting,
  FrozenRoutingSchema,
  routeLaunch,
  type WorkbenchSpecialists,
} from "./specialist-routing";

const launchSchema = z
  .object({
    schema_version: z.literal(1),
    task_id: z.string().min(1),
    scope: ScopeSchema,
    model_id: z.string().min(1),
    approvals: ApprovalsSchema,
    workspace: WorkspaceRefSchema,
    cwd: z.string().min(1).refine(isAbsolute),
    memory: FrozenMemorySchema.optional(),
    repository_map: FrozenRepositoryMapSchema.optional(),
    routing: FrozenRoutingSchema.optional(),
    collaboration: FrozenCollaborationSchema.optional(),
  })
  .strict();
type Launch = z.infer<typeof launchSchema>;

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
}

export interface WorkbenchHostOptions {
  scope: Scope;
  workspaceLabel: string;
  stateRoot: string;
  store: DurableTaskStore;
  workspace: WorkspaceHost;
  registry: ModelProviderRegistry;
  canExecute: boolean;
  memory?: WorkbenchMemory;
  repositoryMap?: Pick<RepositoryMapProvider, "map">;
  specialists?: WorkbenchSpecialists;
  collaboration?: WorkbenchCollaboration;
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
    collaboration || Object.values(approvals).some(Boolean);
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
      if (value.memory) {
        validateFrozenMemory(value.memory);
        if (
          value.memory.scope.owner_id !== task.scope.owner_id ||
          value.memory.scope.project_id !== task.scope.project_id ||
          value.memory.scope.workspace_id !== task.scope.workspace_id
        )
          throw new WorkbenchError("internal_error");
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
  /** Session usage already mirrored into task events for one child. */
  const childResults = async (
    context: RequestContext,
    taskId: string,
    childTaskId: string,
  ) => {
    let input = 0;
    let output = 0;
    let usd = 0;
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
          child_task_id: z.string(),
        })
        .safeParse(JSON.parse(new TextDecoder().decode(bytes)));
      if (!payload.success || payload.data.child_task_id !== childTaskId)
        continue;
      input += event.usage?.input_tokens ?? 0;
      output += event.usage?.output_tokens ?? 0;
      usd += event.usage?.cost_usd ?? 0;
    }
    return { input, output, usd };
  };
  const childRouting = new Map<string, FrozenRouting>();
  /**
   * Mirrors one child attempt into the parent task's durable timeline. The
   * collaboration store stays authoritative for budgets; this records what
   * each child ran, under which routing decision, and what it consumed.
   */
  const publishChildResult = async (
    launch: ChildLaunch,
    outcome: ChildOutcome,
  ) => {
    const context = internalContext(options.scope);
    const previous = await childResults(
      context,
      launch.task_id,
      launch.child_task_id,
    );
    const usage = outcome.usage;
    await options.store.appendEvent(context, launch.task_id, {
      event_type: "tool.completed",
      producer: "@mars/workbench",
      run_id: randomUUID(),
      versions: [{ component: "@mars/workbench", revision: "0.0.1" }],
      payload: {
        operation: "child.result",
        child_task_id: launch.child_task_id,
        child_agent_id: launch.agent_id,
        role_label: launch.role_label,
        task_revision: launch.task_revision,
        attempt: launch.attempt,
        status: outcome.status,
        model_id: launch.model_id,
        routing: childRouting.get(launch.child_task_id) ?? null,
      },
      ...(usage
        ? {
            usage: {
              input_tokens: Math.max(0, usage.input_tokens - previous.input),
              output_tokens: Math.max(0, usage.output_tokens - previous.output),
              cost_usd: Math.max(0, usage.usd - previous.usd),
            },
          }
        : {}),
    });
  };
  const observeChildren = (
    adapter: ChildRuntimeAdapter,
  ): ChildRuntimeAdapter => ({
    async start(launch, hooks) {
      const run = await adapter.start(launch, hooks);
      void run.outcome.then(
        (outcome) => publishChildResult(launch, outcome).catch(() => undefined),
        () => undefined,
      );
      return run;
    },
    ...(adapter.reconcile
      ? { reconcile: adapter.reconcile.bind(adapter) }
      : {}),
  });
  const closeFrozenRoom = (
    frozen: FrozenCollaboration,
    mode: "drain" | "cancel",
  ) =>
    options.collaboration
      ? options.collaboration.host
          .closeRoom(internalContext(options.scope), frozen.room_id, mode)
          .then(() => undefined)
          .catch(() => undefined)
      : Promise.resolve();
  const closeRecordedRoom = async (task: Task, mode: "drain" | "cancel") => {
    const launch = await readLaunch(task).catch(() => null);
    if (launch?.collaboration)
      await closeFrozenRoom(launch.collaboration, mode);
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
  const run = (
    task: Task,
    workspace: WorkspaceRef,
    runtime: RuntimeSession,
    instruction: string,
    steeringEventIds: string[] = [],
    remainingSteering = false,
    collaboration?: FrozenCollaboration,
  ) => {
    const closeRoom = (mode: "drain" | "cancel") =>
      collaboration ? closeFrozenRoom(collaboration, mode) : Promise.resolve();
    active.set(task.task_id, runtime);
    const job = (async () => {
      try {
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
      } finally {
        await runtime.dispose().catch(() => undefined);
        if (active.get(task.task_id) === runtime) {
          active.delete(task.task_id);
          liveRooms.delete(task.task_id);
          jobs.delete(task.task_id);
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
  const toolsFor = (
    workspace: WorkspaceRef,
    approvals: Approvals,
    budget: Budget,
    assertActive: () => Promise<void>,
    writePaths: readonly string[] = [],
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
    return {
      async read(path) {
        const context = await authorize("read");
        return options.store.artifacts.get(
          context,
          await options.workspace.read(context, workspace, path),
        );
      },
      async write(path, bytes) {
        const context = await authorize("write");
        if (writePaths.length > 0 && !withinClaimedPaths(path, writePaths))
          throw new WorkbenchError("forbidden");
        const artifact = await options.store.artifacts.put(
          context,
          bytes,
          "application/octet-stream",
        );
        await authorize("write");
        await options.workspace.write(context, workspace, path, artifact);
      },
      async execute(argv) {
        // Execution cannot be confined to claimed paths, so a path-scoped
        // child does not execute at all.
        if (writePaths.length > 0) throw new WorkbenchError("forbidden");
        const context = await authorize("execute");
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
      stop: () =>
        options.workspace.stop(internalContext(options.scope), workspace),
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
      modelPolicy: async (request) => {
        const fallback = selectExecutionModel(
          options.registry,
          undefined,
          true,
        );
        if (!options.specialists)
          return { model_id: fallback.id, reason: "workbench free default" };
        let routing: FrozenRouting;
        try {
          routing = await routeLaunch(
            internalContext(options.scope),
            { task_id: request.child_task_id, budget: request.budget },
            true,
            { ...options.specialists, paid_consent: false },
            initialRequestAllowance({
              approvals: request.approvals,
              recall: false,
              collaboration: true,
              instruction: request.instruction,
            }) + MIN_INITIAL_OUTPUT_RESERVE,
          );
        } catch {
          return {
            model_id: fallback.id,
            reason: "workbench free default (routing unavailable)",
          };
        }
        childRouting.set(request.child_task_id, routing);
        const specialist = routing.model_id
          ? options.registry.getModel(routing.model_id)
          : undefined;
        if (
          specialist &&
          specialist.pricing.free === true &&
          specialist.capabilities.tools
        )
          return {
            model_id: specialist.id,
            reason: `specialist ${routing.decision_id}`,
          };
        return {
          model_id: fallback.id,
          reason: `workbench free default (${routing.outcome})`,
        };
      },
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
      const baseInstruction = `${task.request}\n\nAcceptance criteria:\n${task.acceptance_criteria.map((criterion) => `- ${criterion}`).join("\n")}`;
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
        if (closing) throw new WorkbenchError("unavailable");
        await writeLaunch(task, {
          schema_version: 1,
          task_id: task.task_id,
          scope: task.scope,
          cwd,
          model_id: runtime.modelId,
          approvals: params.approvals,
          workspace: WorkspaceRefSchema.parse(workspace),
          ...(memory ? { memory } : {}),
          ...(repositoryMap ? { repository_map: repositoryMap } : {}),
          ...(routing ? { routing } : {}),
          ...(collaboration ? { collaboration } : {}),
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
        run(running, workspace, runtime, instruction, [], false, collaboration);
        return running;
      } catch (error) {
        await runtime?.dispose().catch(() => undefined);
        if (collaboration) await closeFrozenRoom(collaboration, "cancel");
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
    restore: serialize((_, taskId) => taskId, api.restore),
    async close() {
      closing = true;
      if (runnerTimer) clearInterval(runnerTimer);
      await runner?.shutdown().catch(() => undefined);
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
