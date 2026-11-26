import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { applyPatch, type PatchFileSystem } from "@mars/codex-tools";
import type { ModelConfig, Task } from "@mars/contracts";
import { isInsideOrEqual } from "@mars/contracts/path-containment";
import {
  type BudgetLedger,
  createModelBridge,
  MARS_EDIT_FORMATS,
  type MarsEditFormat,
  maxOutputTokens,
  openRuntimeSession,
  type RuntimeSessionOptions,
  type RuntimeTools,
  selectExecutionModel,
} from "@mars/execution";
import type { ModelProviderRegistry } from "@mars/providers";
import { createAssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  Settings,
} from "@oh-my-pi/pi-coding-agent";
import { resolveEditMode } from "@oh-my-pi/pi-coding-agent/utils/edit-mode";
import { type EditBenchmarkTask, verifyWorkspace } from "./tasks";

export const OMP_STOCK_ARM = "omp-stock";
export type EditBenchmarkArm = `mars:${MarsEditFormat}` | typeof OMP_STOCK_ARM;

/**
 * Oh My Pi built-ins the stock arm keeps: file reading, editing, writing and
 * in-process search. Everything that spawns processes or reaches the network
 * (bash, eval, task, web_search, github, browser, lsp, mcp, …) is left out so
 * the stock arm runs under the same no-network, no-shell constraints as the
 * MARS arms, whose `mars_execute` is not granted either.
 */
export const OMP_STOCK_TOOLS = ["read", "edit", "write", "grep"] as const;

/**
 * How a MARS edit format is bound into a runtime session. New formats plug in
 * here: add the format to `MARS_EDIT_FORMATS` in `@mars/execution` and a
 * driver below; `mars:<format>` arms are derived from this table.
 */
export interface MarsEditFormatDriver {
  format: MarsEditFormat;
  /** The `mars_*` tools that perform edits in this format. */
  editTools: readonly string[];
  bind(files: PatchFileSystem): Partial<RuntimeSessionOptions>;
}

export const MARS_EDIT_FORMAT_DRIVERS: Record<
  MarsEditFormat,
  MarsEditFormatDriver
> = {
  // The real runtime tools: anchored mars_read + mars_edit.
  hashline: {
    format: "hashline",
    editTools: ["mars_edit"],
    bind: () => ({ editFormat: "hashline" }),
  },
  // The real runtime tools: mars_read + exact-text mars_replace.
  replace: {
    format: "replace",
    editTools: ["mars_replace"],
    bind: () => ({ editFormat: "replace" }),
  },
  apply_patch: {
    format: "apply_patch",
    editTools: ["mars_apply_patch"],
    bind: (files) => ({
      editFormat: "apply_patch",
      patch: {
        async apply(patch) {
          const result = await applyPatch(patch, files);
          if (!result.ok)
            throw new Error(
              `Patch failed${result.failed_hunk === null ? "" : ` at hunk ${result.failed_hunk + 1}`}: ${result.error}`,
            );
          return result.summary;
        },
      },
    }),
  },
};

/** `mars:<format>` for every runnable MARS format, then `omp-stock`. */
export function editBenchmarkArms(
  formats: readonly MarsEditFormat[] = MARS_EDIT_FORMATS,
): EditBenchmarkArm[] {
  return [...formats.map((format) => `mars:${format}` as const), OMP_STOCK_ARM];
}

export function parseEditBenchmarkArm(value: string): EditBenchmarkArm {
  if (value === OMP_STOCK_ARM) return value;
  const format = value.startsWith("mars:") ? value.slice(5) : "";
  if ((MARS_EDIT_FORMATS as readonly string[]).includes(format))
    return value as EditBenchmarkArm;
  throw new Error(
    `Unknown arm "${value}"; known arms: ${editBenchmarkArms().join(", ")}.`,
  );
}

export interface TrialBudget {
  max_tokens: number;
  max_usd: number;
  max_duration_ms: number;
}

export interface TrialInput {
  arm: EditBenchmarkArm;
  task: EditBenchmarkTask;
  repeat: number;
  registry: ModelProviderRegistry;
  modelId: string;
  /** Integer sampling seed forwarded on every model request of the trial. */
  seed: number;
  budget: TrialBudget;
  /** Model transport; the only network path either arm has. */
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  env?: Record<string, string | undefined>;
  /** Scratch root; each trial gets a throwaway copy of the task tree under it. */
  workRoot: string;
  /** Directory receiving raw transcripts (`<arm>/<task>/<repeat>.jsonl`). */
  transcriptRoot: string;
}

export interface TrialResult {
  arm: EditBenchmarkArm;
  task_id: string;
  category: EditBenchmarkTask["category"];
  repeat: number;
  seed: number;
  solved: boolean;
  status: "completed" | "paused" | "cancelled" | "failed" | "error";
  failure: string | null;
  edit_calls: number;
  edit_failures: number;
  turns: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  wall_ms: number;
  /** Oh My Pi's resolved edit mode for the stock arm; the MARS format otherwise. */
  edit_mode: string;
  network_refusals: number;
  /** Stock-arm tool calls refused because a path left the throwaway workspace. */
  path_refusals: number;
  verification: Awaited<ReturnType<typeof verifyWorkspace>>;
  transcript: string | null;
}

function costOf(model: ModelConfig, input: number, output: number): number {
  if (model.pricing.free) return 0;
  return (
    (input * (model.pricing.inputPerMTokUsd ?? 0) +
      output * (model.pricing.outputPerMTokUsd ?? 0)) /
    1_000_000
  );
}

async function materialize(task: EditBenchmarkTask, root: string) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const [path, bytes] of task.before) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  return realpath(root);
}

/** Workspace-confined file tools; no command execution is granted. */
function workspaceTools(root: string): {
  tools: RuntimeTools;
  files: PatchFileSystem;
} {
  const resolveInside = async (path: string) => {
    const target = resolve(root, path);
    if (!isInsideOrEqual(root, target))
      throw new Error(`Path escapes the task workspace: ${path}`);
    let probe = target;
    const missing: string[] = [];
    for (;;) {
      try {
        const real = await realpath(probe);
        const resolved = join(real, ...[...missing].reverse());
        if (!isInsideOrEqual(root, resolved))
          throw new Error(`Path escapes the task workspace: ${path}`);
        return resolved;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const parent = dirname(probe);
        if (parent === probe) throw error;
        missing.push(basename(probe));
        probe = parent;
      }
    }
  };
  const write = async (path: string, content: Uint8Array) => {
    const target = await resolveInside(path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  };
  const tools: RuntimeTools = {
    read: async (path) =>
      new Uint8Array(await readFile(await resolveInside(path))),
    write,
    async execute() {
      throw new Error("Command execution is not granted in this benchmark.");
    },
    async stop() {},
  };
  const files: PatchFileSystem = {
    async read(path) {
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(
          await readFile(await resolveInside(path)),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    write: (path, text) => write(path, new TextEncoder().encode(text)),
    async remove(path) {
      await rm(await resolveInside(path));
    },
    async exists(path) {
      try {
        const info = await stat(await resolveInside(path));
        return info.isDirectory() ? "directory" : "file";
      } catch {
        return null;
      }
    },
  };
  return { tools, files };
}

/**
 * Replaces the process-wide `fetch` for the duration of a trial so no tool of
 * either arm can reach the network; the model transport keeps its own,
 * explicitly injected fetch. Trials run one at a time.
 */
async function withoutNetwork<T>(
  run: (refusals: () => number) => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  let refused = 0;
  const guard = (async () => {
    refused += 1;
    throw new Error("Network access is disabled in the edit benchmark.");
  }) as unknown as typeof fetch;
  globalThis.fetch = guard;
  try {
    return await run(() => refused);
  } finally {
    globalThis.fetch = original;
  }
}

function benchmarkTask(input: TrialInput): Task {
  return {
    schema_version: 1,
    task_id: randomUUID(),
    session_id: randomUUID(),
    scope: {
      owner_id: "edit-benchmark",
      project_id: "edit-benchmark",
      workspace_id: input.task.task_id,
    },
    revision: 0,
    request: input.task.instruction,
    acceptance_criteria: ["The workspace matches the requested edit exactly."],
    budget: {
      max_tokens: input.budget.max_tokens,
      max_usd: input.budget.max_usd,
      max_duration_ms: input.budget.max_duration_ms,
      max_depth: 0,
      max_concurrency: 1,
    },
    status: "pending",
    specialist_revision: null,
    artifacts: [],
  };
}

async function keepTranscript(
  input: TrialInput,
  journal: string | undefined,
): Promise<string | null> {
  if (!journal) return null;
  const relativePath = join(
    input.arm.replace(":", "_"),
    input.task.task_id,
    `${input.repeat}.jsonl`,
  );
  const target = join(input.transcriptRoot, relativePath);
  await mkdir(dirname(target), { recursive: true });
  try {
    await copyFile(journal, target);
    return relativePath;
  } catch {
    return null;
  }
}

const RETRYABLE_HTTP_STATUS = new Set([429, 502, 503, 504]);
const MAX_TRANSIENT_RETRIES = 4;
const BASE_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

function retryDelayMs(response: Response, attempt: number): number {
  const remaining = response.headers.get("x-ratelimit-remaining")?.trim();
  const reset = response.headers.get("x-ratelimit-reset")?.trim();
  if (remaining === "0" && reset) {
    const parsed = Number(reset);
    if (Number.isFinite(parsed)) {
      const resetMs = parsed > 1e12 ? parsed : parsed * 1_000;
      const waitMs = resetMs - Date.now();
      if (waitMs >= 0) return Math.round(waitMs);
    }
  }
  const header = response.headers.get("retry-after")?.trim();
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.max(0, Math.round(seconds * 1_000));
    }
    const when = Date.parse(header);
    if (Number.isFinite(when)) {
      return Math.max(0, when - Date.now());
    }
  }
  return Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** attempt);
}

function sleepAbortable(
  ms: number,
  signal?: AbortSignal | null,
): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Runs one task once in one arm inside a fresh throwaway copy of its tree. */
export async function runEditTrial(input: TrialInput): Promise<TrialResult> {
  const scratch = join(input.workRoot, randomUUID());
  const workspace = await materialize(input.task, join(scratch, "workspace"));
  const stateDir = join(scratch, "state");
  const model = selectExecutionModel(input.registry, input.modelId, true);
  let turns = 0;
  const started = Date.now();
  const countedFetch = async (url: string, init?: RequestInit) => {
    turns += 1;
    let attempt = 0;
    while (true) {
      const response = await input.fetch(url, init);
      if (
        !RETRYABLE_HTTP_STATUS.has(response.status) ||
        attempt >= MAX_TRANSIENT_RETRIES ||
        init?.signal?.aborted
      ) {
        return response;
      }
      const remaining =
        input.budget.max_duration_ms - (Date.now() - started) - 1_000;
      const delay = retryDelayMs(response, attempt);
      if (remaining <= 0 || delay > remaining) return response;
      await response.body?.cancel().catch(() => undefined);
      await sleepAbortable(delay, init?.signal);
      if (init?.signal?.aborted) return response;
      attempt += 1;
    }
  };
  try {
    const run =
      input.arm === OMP_STOCK_ARM
        ? await withoutNetwork((refusals) =>
            runOmpStock(input, workspace, stateDir, model, countedFetch).then(
              (result) => ({ ...result, network_refusals: refusals() }),
            ),
          )
        : await withoutNetwork((refusals) =>
            runMars(input, workspace, stateDir, countedFetch).then(
              (result) => ({ ...result, network_refusals: refusals() }),
            ),
          );
    const verification = await verifyWorkspace(workspace, input.task);
    return {
      arm: input.arm,
      task_id: input.task.task_id,
      category: input.task.category,
      repeat: input.repeat,
      seed: input.seed,
      solved: verification.solved,
      status: run.status,
      failure: run.failure,
      edit_calls: run.edit_calls,
      edit_failures: run.edit_failures,
      turns,
      input_tokens: run.ledger.input_tokens,
      output_tokens: run.ledger.output_tokens,
      cost_usd: costOf(
        model,
        run.ledger.input_tokens,
        run.ledger.output_tokens,
      ),
      wall_ms: Date.now() - started,
      edit_mode: run.edit_mode,
      network_refusals: run.network_refusals,
      path_refusals: run.path_refusals ?? 0,
      verification,
      transcript: await keepTranscript(input, run.journal),
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

interface ArmRun {
  status: TrialResult["status"];
  failure: string | null;
  edit_calls: number;
  edit_failures: number;
  ledger: Pick<BudgetLedger, "input_tokens" | "output_tokens">;
  edit_mode: string;
  path_refusals?: number;
  journal: string | undefined;
}

async function runMars(
  input: TrialInput,
  workspace: string,
  stateDir: string,
  fetch: TrialInput["fetch"],
): Promise<ArmRun> {
  const format = input.arm.slice("mars:".length) as MarsEditFormat;
  const driver = MARS_EDIT_FORMAT_DRIVERS[format];
  const { tools, files } = workspaceTools(workspace);
  const editTools = new Set(driver.editTools);
  let editCalls = 0;
  let editFailures = 0;
  const session = await openRuntimeSession({
    task: benchmarkTask(input),
    cwd: workspace,
    stateDir,
    registry: input.registry,
    modelId: input.modelId,
    approvals: { read: true, write: true, execute: false },
    tools,
    ...driver.bind(files),
    seed: input.seed,
    fetch,
    ...(input.env ? { env: input.env } : {}),
    onEvent: async (event) => {
      if (
        event.type === "tool_execution_end" &&
        event.tool_name &&
        editTools.has(event.tool_name)
      )
        editCalls += 1;
    },
  });
  const journal = session.journalPath;
  try {
    const outcome = await session.run(input.task.instruction);
    for (const entry of session.journalSnapshot().entries) {
      const message = (entry as { message?: Record<string, unknown> }).message;
      if (
        message?.role === "toolResult" &&
        editTools.has(String(message.toolName)) &&
        message.isError === true
      )
        editFailures += 1;
    }
    return {
      status: outcome.status,
      failure: outcome.failure_code ?? null,
      edit_calls: editCalls,
      edit_failures: editFailures,
      ledger: outcome.usage,
      edit_mode: format,
      journal,
    };
  } finally {
    await session.dispose();
  }
}

/** Every path a stock tool call names: `path` arguments and patch/hashline headers. */
export function stockToolPaths(
  tool: string,
  args: Record<string, unknown> | undefined,
): string[] {
  const paths: string[] = [];
  if (typeof args?.path === "string")
    paths.push(tool === "read" ? args.path.replace(/:[^/]*$/, "") : args.path);
  if (tool === "edit" && typeof args?.input === "string")
    for (const line of args.input.split("\n")) {
      const header =
        /^\[([^\]#]+)#[0-9A-Fa-f]{4}\]\s*$/.exec(line)?.[1] ??
        /^\*\*\* (?:Update File|Add File|Delete File|Move to): (.+)$/.exec(
          line,
        )?.[1] ??
        /^MV (.+)$/.exec(line.trim())?.[1];
      if (header) paths.push(header.trim());
    }
  return paths;
}

/** Paths that are URLs/URIs or resolve (through symlinks) outside `root`. */
async function pathsOutside(
  root: string,
  paths: readonly string[],
): Promise<string[]> {
  const outside: string[] = [];
  for (const path of paths) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path) || path.startsWith("~")) {
      outside.push(path);
      continue;
    }
    let probe = resolve(root, path);
    if (!isInsideOrEqual(root, probe)) {
      outside.push(path);
      continue;
    }
    for (;;) {
      try {
        if (!isInsideOrEqual(root, await realpath(probe))) outside.push(path);
        break;
      } catch {
        const parent = dirname(probe);
        if (parent === probe) break;
        probe = parent;
      }
    }
  }
  return outside;
}

/**
 * The MARS bridge reports each tool call whole (start, end). Oh My Pi's
 * built-in `edit` consumes streamed argument text, as every streaming
 * provider sends it, so the stock arm re-emits each call's arguments as one
 * `toolcall_delta` before its end event. Nothing else changes.
 */
function withToolCallDeltas(
  bridge: ReturnType<typeof createModelBridge>,
): ReturnType<typeof createModelBridge> {
  return (model, context, options) => {
    const source = bridge(model, context, options);
    const stream = createAssistantMessageEventStream();
    void (async () => {
      try {
        for await (const event of source) {
          if (event.type === "toolcall_end")
            stream.push({
              type: "toolcall_delta",
              contentIndex: event.contentIndex,
              delta: JSON.stringify(event.toolCall.arguments),
              partial: event.partial,
            });
          stream.push(event);
        }
        stream.end(await source.result());
      } catch (error) {
        stream.fail(error);
      }
    })();
    return stream;
  };
}

async function runOmpStock(
  input: TrialInput,
  workspace: string,
  stateDir: string,
  model: ModelConfig,
  fetch: TrialInput["fetch"],
): Promise<ArmRun> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const ledger: BudgetLedger = {
    deadline: Date.now() + input.budget.max_duration_ms,
    reserved_tokens: 0,
    reserved_usd: 0,
    input_tokens: 0,
    output_tokens: 0,
  };
  const controller = new AbortController();
  let failure: string | null = null;
  let pathRefusals = 0;
  const bridge = createModelBridge({
    registry: input.registry,
    selected: model,
    budget: { ...input.budget, max_depth: 0, max_concurrency: 1 },
    ledger,
    persistLedger: async () => undefined,
    signal: controller.signal,
    onFailure: (code) => {
      failure = code;
    },
    fetch,
    seed: input.seed,
    workspaceRoots: [await realpath(workspace), workspace],
    ...(input.env ? { env: input.env } : {}),
  });
  const providerId = `omp-stock-${randomUUID()}`;
  // Oh My Pi picks per-model edit modes (e.g. replace for Kimi/DeepSeek) from
  // the model name it sees, so the stock session is registered under the
  // upstream model name, not the MARS registry alias. The bridge still routes
  // by the alias.
  const stockModelId = model.model;
  const authStorage = await AuthStorage.create(":memory:");
  const models = new ModelRegistry(authStorage);
  models.registerProvider(providerId, {
    api: providerId,
    apiKey: "mars-host-managed",
    baseUrl: "https://mars.invalid",
    streamSimple: withToolCallDeltas(bridge),
    models: [
      {
        id: stockModelId,
        name: stockModelId,
        reasoning: false,
        input: ["text"],
        supportsTools: model.capabilities.tools,
        cost: {
          input: model.pricing.free ? 0 : (model.pricing.inputPerMTokUsd ?? 0),
          output: model.pricing.free
            ? 0
            : (model.pricing.outputPerMTokUsd ?? 0),
          cacheRead: 0,
          cacheWrite: 0,
        },
        contextWindow: model.capabilities.contextWindow,
        maxTokens: Math.min(maxOutputTokens(model), input.budget.max_tokens),
      },
    ],
  });
  const registered = models.find(providerId, stockModelId);
  if (!registered) throw new Error("Failed to register the benchmark model.");
  const manager = SessionManager.create(workspace, stateDir);
  const settings = Settings.isolated({
    "compaction.enabled": false,
    "retry.enabled": false,
    "retry.modelFallback": false,
  });
  const created = await createAgentSession({
    cwd: workspace,
    agentDir: join(stateDir, "agent"),
    authStorage,
    modelRegistry: models,
    model: registered,
    getApiKey: async () => "mars-host-managed",
    settings,
    sessionManager: manager,
    hasUI: false,
    interactivePrompts: false,
    bindProcessState: false,
    disableExtensionDiscovery: true,
    skills: [],
    rules: [],
    contextFiles: [],
    noContextFiles: true,
    promptTemplates: [],
    slashCommands: [],
    preloadedCustomToolPaths: [],
    toolNames: [...OMP_STOCK_TOOLS],
    restrictToolNames: true,
    enableMCP: false,
    enableLsp: false,
    enableIrc: false,
    skipPythonPreflight: true,
    cacheWarming: false,
    autoTitle: false,
    deadline: ledger.deadline,
    agentId: providerId,
    allowSessionModelFallback: false,
    rebindModelAfterDiscovery: false,
  });
  const session = created.session;
  const deadline = setTimeout(
    () => {
      controller.abort();
      void session.abort().catch(() => undefined);
    },
    Math.max(1, ledger.deadline - Date.now()),
  );
  deadline.unref();
  const original = session.agent.beforeToolCall;
  session.agent.beforeToolCall = async (ctx, signal) => {
    const outside = await pathsOutside(
      workspace,
      stockToolPaths(ctx.tool.name, ctx.args as Record<string, unknown>),
    );
    if (outside.length > 0) {
      pathRefusals += 1;
      return {
        block: true,
        reason: `Path is outside the benchmark workspace: ${outside[0]}`,
      };
    }
    return original ? original(ctx, signal) : undefined;
  };
  let editCalls = 0;
  let editFailures = 0;
  let replyId: string | undefined;
  let capped = false;
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_end" && event.message.role === "assistant") {
      replyId = event.message.responseId;
      capped = false;
    }
    if (
      event.type === "turn_end" &&
      event.message.role === "assistant" &&
      event.message.stopReason === "length"
    )
      capped = true;
    if (event.type === "tool_execution_end" && event.toolName === "edit") {
      editCalls += 1;
      if (event.isError) editFailures += 1;
    }
  });
  const editMode = resolveEditMode({
    settings,
    getActiveModelString: () => stockModelId,
  });
  try {
    const active = session.getActiveToolNames().sort();
    if (JSON.stringify(active) !== JSON.stringify([...OMP_STOCK_TOOLS].sort()))
      throw new Error(
        `Stock arm enabled unexpected tools: ${active.join(", ")}`,
      );
    await session.prompt(input.task.instruction);
    await session.flushToDisk();
    const settled = session.getLastAssistantMessage();
    const stopReason = capped
      ? "length"
      : replyId !== undefined && settled?.responseId === replyId
        ? settled.stopReason
        : undefined;
    const status: TrialResult["status"] =
      controller.signal.aborted ||
      !stopReason ||
      stopReason === "error" ||
      stopReason === "aborted"
        ? "failed"
        : stopReason === "length"
          ? "paused"
          : "completed";
    return {
      status,
      failure:
        status === "failed"
          ? (failure ??
            (Date.now() >= ledger.deadline
              ? "deadline_exceeded"
              : "provider_error"))
          : null,
      edit_calls: editCalls,
      edit_failures: editFailures,
      ledger,
      edit_mode: editMode,
      path_refusals: pathRefusals,
      journal: manager.getSessionFile(),
    };
  } finally {
    clearTimeout(deadline);
    unsubscribe();
    controller.abort();
    await session.dispose().catch(() => undefined);
    models.unregisterProvider(providerId);
    await Promise.resolve()
      .then(() => authStorage.close())
      .catch(() => undefined);
  }
}
