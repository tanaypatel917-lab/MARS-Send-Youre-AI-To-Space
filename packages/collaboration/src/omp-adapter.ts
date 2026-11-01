import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Task } from "@mars/contracts";
import {
  openRuntimeSession,
  type RuntimeSession,
  type RuntimeSessionOptions,
  type RuntimeTools,
  selectExecutionModel,
} from "@mars/execution";
import type { ModelProviderRegistry } from "@mars/providers";
import { SessionManager } from "@oh-my-pi/pi-coding-agent";
import { z } from "zod";
import { CollaborationError } from "./errors";
import type {
  ChildLaunch,
  ChildOutcome,
  ChildRun,
  ChildRuntimeAdapter,
} from "./runner";
import type { ChildUsage } from "./schemas";

const ledgerSchema = z
  .object({
    deadline: z.number().int().positive(),
    reserved_tokens: z.number().int().nonnegative(),
    reserved_usd: z.number().finite().nonnegative(),
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  })
  .strict();

const bindingSchema = z
  .object({
    session_id: z.string().min(1),
    budget: z
      .object({
        max_tokens: z.number().int().positive(),
        max_usd: z.number().finite().nonnegative(),
        max_duration_ms: z.number().int().positive(),
        max_depth: z.number().int().nonnegative(),
        max_concurrency: z.number().int().positive(),
      })
      .strict(),
    model_id: z.string().nullable(),
  })
  .strict();

export interface OhMyPiAdapterOptions {
  registry: ModelProviderRegistry;
  stateRoot: string;
  workspaceFor(launch: ChildLaunch): Promise<{
    cwd: string;
    tools: RuntimeTools;
    base_revision: string | null;
  }>;
  runtimeFactory?: (options: RuntimeSessionOptions) => Promise<RuntimeSession>;
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return (
    path !== "" &&
    !isAbsolute(path) &&
    path !== ".." &&
    !path.startsWith(`..${sep}`)
  );
}

function secureModelCheck(
  launch: ChildLaunch,
  registry: ModelProviderRegistry,
  inheritedModelId?: string,
): string {
  const modelId =
    launch.model_id ??
    inheritedModelId ??
    selectExecutionModel(
      registry,
      undefined,
      Object.values(launch.approvals).some(Boolean),
    ).id;
  const model = registry.getModel(modelId);
  if (!model)
    throw new CollaborationError(
      "forbidden",
      "Selected model is not available",
    );
  if (!model.pricing.free && !launch.paid_models)
    throw new CollaborationError(
      "forbidden",
      "Selected model requires paid-model authority",
    );
  if (launch.budget.max_usd === 0 && !model.pricing.free)
    throw new CollaborationError(
      "forbidden",
      "Selected model requires a paid budget",
    );
  return model.id;
}

async function childStateDirectory(
  stateRoot: string,
  workspace: string,
  launch: ChildLaunch,
): Promise<{ root: string; directory: string }> {
  if (!isAbsolute(stateRoot))
    throw new CollaborationError(
      "invalid_input",
      "Adapter state root must be absolute",
    );
  const absoluteRoot = resolve(stateRoot);
  await mkdir(absoluteRoot, { recursive: true, mode: 0o700 });
  await chmod(absoluteRoot, 0o700);
  const root = await realpath(absoluteRoot);
  const cwd = await realpath(workspace);
  if (root === cwd || inside(cwd, root))
    throw new CollaborationError(
      "forbidden",
      "Adapter state must be outside the workspace",
    );
  const mode = (await stat(root)).mode;
  if ((mode & 0o077) !== 0)
    throw new CollaborationError("forbidden", "Adapter state must be private");
  const key = createHash("sha256")
    .update(`${launch.room_id}${launch.agent_id}`)
    .digest("hex");
  const directory = join(root, key);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const resolved = await realpath(directory);
  if (!inside(root, resolved))
    throw new CollaborationError("forbidden", "Adapter state path is invalid");
  return { root, directory: resolved };
}

async function loadBinding(
  path: string,
): Promise<z.infer<typeof bindingSchema> | null> {
  try {
    return bindingSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return null;
    throw new CollaborationError(
      "forbidden",
      "Persisted runtime binding is invalid",
    );
  }
}

async function saveBinding(
  path: string,
  binding: z.infer<typeof bindingSchema>,
): Promise<void> {
  await writeFile(path, JSON.stringify(binding), { mode: 0o600 });
  await chmod(path, 0o600);
}

async function usageFromJournal(
  sessionRef: string,
  stateRoot: string,
): Promise<ChildUsage | null> {
  let manager: SessionManager | undefined;
  try {
    const file = await realpath(sessionRef);
    const root = await realpath(stateRoot);
    if (!inside(root, file)) return null;
    manager = await SessionManager.open(file, dirname(file));
    const entries = manager.getEntries();
    const budgetEntry = entries
      .filter(
        (entry) =>
          entry.type === "custom" && entry.customType === "mars.budget",
      )
      .at(-1);
    if (budgetEntry?.type !== "custom") return null;
    const ledger = ledgerSchema.safeParse(budgetEntry.data);
    if (!ledger.success) return null;
    const steps = entries.filter((entry) => {
      if (entry.type !== "message") return false;
      const record = entry as { message?: { role?: string } };
      return record.message?.role === "assistant";
    }).length;
    return {
      input_tokens: ledger.data.input_tokens,
      output_tokens: ledger.data.output_tokens,
      usd: ledger.data.reserved_usd,
      steps,
    };
  } catch {
    return null;
  } finally {
    await manager?.close().catch(() => undefined);
  }
}

const zeroUsage: ChildUsage = {
  input_tokens: 0,
  output_tokens: 0,
  usd: 0,
  steps: 0,
};

function cancelledOutcome(usage: ChildUsage | null): ChildOutcome {
  return {
    status: "cancelled",
    summary: "Cancelled before the runtime started.",
    artifacts: [],
    usage,
  };
}

function cancelledRun(
  sessionRef: string | null,
  baseRevision: string | null,
  usage: ChildUsage | null,
): ChildRun {
  return {
    session_ref: sessionRef,
    base_revision: baseRevision,
    outcome: Promise.resolve(cancelledOutcome(usage)),
    async cancel() {},
  };
}

async function cancelledBeforeRuntime(
  launch: ChildLaunch,
  stateRoot: string,
  baseRevision: string | null,
): Promise<ChildRun> {
  const sessionRef = launch.session_ref || null;
  const usage = sessionRef
    ? await usageFromJournal(sessionRef, stateRoot)
    : zeroUsage;
  return cancelledRun(sessionRef, baseRevision, usage);
}

export function createOhMyPiChildAdapter(
  options: OhMyPiAdapterOptions,
): ChildRuntimeAdapter {
  const runtimeFactory = options.runtimeFactory ?? openRuntimeSession;
  return {
    async start(launch, hooks) {
      if (hooks.signal.aborted)
        return cancelledBeforeRuntime(launch, options.stateRoot, null);
      const workspace = await options.workspaceFor(launch);
      if (hooks.signal.aborted)
        return cancelledBeforeRuntime(
          launch,
          options.stateRoot,
          workspace.base_revision,
        );
      const state = await childStateDirectory(
        options.stateRoot,
        workspace.cwd,
        launch,
      );
      if (hooks.signal.aborted)
        return cancelledBeforeRuntime(
          launch,
          options.stateRoot,
          workspace.base_revision,
        );
      const bindingPath = join(state.directory, "binding.json");
      const existing = await loadBinding(bindingPath);
      if (hooks.signal.aborted)
        return cancelledBeforeRuntime(
          launch,
          options.stateRoot,
          workspace.base_revision,
        );
      let sessionFile: string | undefined;
      if (launch.session_ref) {
        try {
          sessionFile = await realpath(launch.session_ref);
        } catch {
          if (hooks.signal.aborted)
            return cancelledBeforeRuntime(
              launch,
              options.stateRoot,
              workspace.base_revision,
            );
          throw new CollaborationError(
            "forbidden",
            "Session journal is unavailable",
          );
        }
      }
      if (hooks.signal.aborted)
        return cancelledBeforeRuntime(
          launch,
          options.stateRoot,
          workspace.base_revision,
        );
      if (sessionFile && !inside(state.directory, sessionFile))
        throw new CollaborationError(
          "forbidden",
          "Session journal is outside child state",
        );
      const selectedModelId = secureModelCheck(
        launch,
        options.registry,
        existing?.model_id ?? undefined,
      );
      const desired = {
        session_id: existing?.session_id ?? randomUUID(),
        budget: existing?.budget ?? launch.budget,
        model_id: existing?.model_id ?? selectedModelId,
      };
      if (
        existing &&
        ((launch.model_id !== null && existing.model_id !== launch.model_id) ||
          (!sessionFile &&
            JSON.stringify(existing.budget) !== JSON.stringify(launch.budget)))
      )
        throw new CollaborationError(
          "forbidden",
          "Persisted runtime binding does not match",
        );
      if (!existing) {
        await saveBinding(bindingPath, desired);
        if (hooks.signal.aborted)
          return cancelledBeforeRuntime(
            launch,
            options.stateRoot,
            workspace.base_revision,
          );
      }
      if (hooks.signal.aborted)
        return cancelledBeforeRuntime(
          launch,
          options.stateRoot,
          workspace.base_revision,
        );
      const task: Task = {
        schema_version: 1,
        task_id: launch.child_task_id,
        session_id: desired.session_id,
        scope: launch.scope,
        revision: launch.task_revision,
        request: launch.instruction,
        acceptance_criteria: ["Return a concise result for the parent agent"],
        budget: desired.budget,
        status: "pending",
        specialist_revision: null,
        artifacts: [],
      };
      const approvals = {
        ...launch.approvals,
        ...(launch.workspace_mode === "read_only"
          ? { write: false, execute: false }
          : {}),
      };
      let steps = 0;
      let session: RuntimeSession;
      try {
        session = await runtimeFactory({
          task,
          cwd: workspace.cwd,
          stateDir: state.directory,
          ...(sessionFile ? { sessionFile } : {}),
          registry: options.registry,
          modelId: desired.model_id,
          approvals,
          tools: workspace.tools,
          onEvent: async (observation) => {
            if (observation.type === "turn_end") steps += 1;
            await hooks.onProgress({
              steps,
              usage: null,
              ...(observation.journal_path
                ? { session_ref: observation.journal_path }
                : {}),
              base_revision: workspace.base_revision,
            });
            if (steps > launch.max_steps)
              void session.cancel().catch(() => undefined);
          },
        });
      } catch (error) {
        if (error instanceof CollaborationError) throw error;
        // Opening a runtime session makes no model request, so no usage accrued.
        throw new CollaborationError(
          "invalid_input",
          "Runtime session could not be opened",
        );
      }
      const sessionRef = session.journalPath || launch.session_ref || null;
      const abort = () => {
        if (runStarted) void session.cancel().catch(() => undefined);
      };
      let runStarted = false;
      hooks.signal.addEventListener("abort", abort, { once: true });
      if (hooks.signal.aborted) {
        hooks.signal.removeEventListener("abort", abort);
        await session.dispose().catch(() => undefined);
        const usage = launch.session_ref
          ? sessionRef
            ? await usageFromJournal(sessionRef, state.root)
            : null
          : zeroUsage;
        return cancelledRun(sessionRef, workspace.base_revision, usage);
      }
      if (!sessionRef) {
        hooks.signal.removeEventListener("abort", abort);
        await session.dispose();
        throw new CollaborationError(
          "forbidden",
          "Runtime journal is unavailable",
        );
      }
      const outcome: Promise<ChildOutcome> = (async () => {
        try {
          if (hooks.signal.aborted) {
            const usage = launch.session_ref
              ? await usageFromJournal(sessionRef, state.root)
              : zeroUsage;
            return cancelledOutcome(usage);
          }
          runStarted = true;
          const result = await session.run(launch.instruction);
          const usage: ChildUsage = {
            input_tokens: result.usage.input_tokens,
            output_tokens: result.usage.output_tokens,
            usd: result.usage.reserved_usd,
            steps,
          };
          return {
            status: result.status,
            summary: result.content,
            artifacts: [],
            usage,
          };
        } catch {
          return {
            status: "failed" as const,
            summary: "Runtime failed before a result could be produced.",
            artifacts: [],
            usage: await usageFromJournal(sessionRef, state.root),
          };
        } finally {
          hooks.signal.removeEventListener("abort", abort);
          await session.dispose().catch(() => undefined);
        }
      })();
      return {
        session_ref: sessionRef,
        base_revision: workspace.base_revision,
        outcome,
        async cancel() {
          if (runStarted) await session.cancel();
        },
      };
    },
    async reconcile(sessionRef) {
      return usageFromJournal(sessionRef, options.stateRoot);
    },
  };
}
