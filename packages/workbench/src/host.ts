import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { RepositoryMapProvider } from "@mars/context";
import type {
  ArtifactRef,
  ExecutionProvider,
  RequestContext,
  Scope,
  Task,
  WorkspaceRef,
} from "@mars/contracts";
import { ScopeSchema } from "@mars/contracts";
import {
  EXECUTION_PACKAGE_VERSION,
  MAX_RUNTIME_INSTRUCTION_LENGTH,
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
  FrozenMemorySchema,
  freezeMemory,
  recallHistory,
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
  })
  .strict();
type Launch = z.infer<typeof launchSchema>;

export interface WorkspaceHost extends ExecutionProvider {
  reopen(context: RequestContext, taskId: string): Promise<WorkspaceRef>;
  cwd(context: RequestContext, workspace: WorkspaceRef): Promise<string>;
  diff(context: RequestContext, workspace: WorkspaceRef): Promise<DiffResult>;
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
  hostPrivateRoots?: string[];
  runtimeFactory?: (options: RuntimeSessionOptions) => Promise<RuntimeSession>;
}

export interface WorkbenchHostApi extends WorkbenchOperations {
  close(): Promise<void>;
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
  const selectModel = (approvals: Approvals, modelId?: string) => {
    try {
      return selectExecutionModel(
        options.registry,
        modelId,
        Object.values(approvals).some(Boolean),
      );
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
  const run = (
    task: Task,
    workspace: WorkspaceRef,
    runtime: RuntimeSession,
    instruction: string,
    steeringEventIds: string[] = [],
    remainingSteering = false,
  ) => {
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
        await options.store.update(context, task.task_id, current.revision, {
          status:
            outcome.status === "completed" && remainingSteering
              ? "paused"
              : outcome.status,
          artifacts: [
            ...new Map(
              [...current.artifacts, ...collected, artifact].map((ref) => [
                ref.artifact_id,
                ref,
              ]),
            ).values(),
          ],
        });
      } catch {
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
          jobs.delete(task.task_id);
        }
      }
    })();
    jobs.set(task.task_id, job);
  };

  const toolsFor = (
    task: Task,
    workspace: WorkspaceRef,
    approvals: Approvals,
  ): RuntimeTools => {
    const authorize = async (permission: keyof Approvals) => {
      if (
        !approvals[permission] ||
        (permission === "execute" && !options.canExecute)
      )
        throw new WorkbenchError("forbidden");
      const context = internalContext(options.scope);
      if (
        (await options.store.inspect(context, task.task_id)).status !==
        "running"
      )
        throw new WorkbenchError("conflict");
      return context;
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
        const artifact = await options.store.artifacts.put(
          context,
          bytes,
          "application/octet-stream",
        );
        await authorize("write");
        await options.workspace.write(context, workspace, path, artifact);
      },
      async execute(argv) {
        const context = await authorize("execute");
        const result = await options.workspace.execute(
          context,
          workspace,
          argv,
          task.budget,
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

  await options.store.recoverInterrupted(internalContext(options.scope), {
    reason: "Workbench process interrupted.",
  });

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
      const model = selectModel(params.approvals, params.model_id);
      const capacity = optionalInstructionCapacity({
        model,
        budget: task.budget,
        approvals: params.approvals,
        recall: Boolean(options.memory),
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
      const running = await options.store.update(
        context,
        task.task_id,
        task.revision,
        { status: "running" },
      );
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
        const maxOutputTokens = repositoryMapTokenBudget(instruction);
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
          task: running,
          cwd,
          stateDir,
          registry: options.registry,
          modelId: model.id,
          approvals: params.approvals,
          tools: toolsFor(running, workspace, params.approvals),
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
        run(running, workspace, runtime, instruction);
        return running;
      } catch (error) {
        await runtime?.dispose().catch(() => undefined);
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
      selectModel(launch.approvals, launch.model_id);
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
          task: running,
          cwd,
          stateDir: taskState(task),
          sessionFile: binding.session_file,
          registry: options.registry,
          modelId: launch.model_id,
          approvals: launch.approvals,
          tools: toolsFor(running, workspace, launch.approvals),
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
      if (task.status === "running") await runtime?.steer(instruction);
    },
    async cancel(context, taskId) {
      checkContext(context);
      const task = await options.store.inspect(context, taskId);
      if (task.status === "running" && !active.has(taskId))
        throw new WorkbenchError("conflict");
      await options.store.cancel(context, taskId);
      await active.get(taskId)?.cancel();
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
