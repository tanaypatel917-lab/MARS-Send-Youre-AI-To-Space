import type {
  ArtifactRef,
  CheckpointRef,
  EventEnvelope,
  Scope,
  Task,
  TaskStatus,
  WorkspaceRef,
} from "@mars/contracts";
import { DEFAULT_MAX_REVIEW_LINES } from "@mars/output-format";
import type { MarsClient, VerifiedArtifact } from "./client";
import type { OpenOutcome } from "./diffOpener";
import type {
  ArtifactView,
  ConnectionStatus,
  ConnectionView,
  DiffFileView,
  EventView,
  Notice,
  SelectedView,
  ViewState,
  WebviewMessage,
} from "./messages";
import { WebviewMessageSchema } from "./messages";
import { patchStats } from "./patch";
import { checkRelativePath } from "./pathSafety";
import { EventPoller, type PollerOptions, type PollerStatus } from "./poller";
import {
  type Approvals,
  type DescribeResult,
  type DiffFile,
  sameScope,
} from "./protocol";
import type { ReviewOutcome, ReviewTarget } from "./reviewOpener";
import { RpcError } from "./rpc";
import { buildPendingTask } from "./taskFactory";

export type ConnectResult =
  | { ok: true; client: MarsClient; server: string }
  | { ok: false; status: "no-token" | "blocked" | "error"; message: string };

export interface WorkbenchUi {
  /** Native modal confirmation; resolves true only for the action button. */
  confirm(message: string, detail: string, action: string): Promise<boolean>;
  promptToken(): Promise<void>;
  openDiff(server: DescribeResult, file: DiffFile): Promise<OpenOutcome>;
  openArtifact(artifact: VerifiedArtifact, title: string): Promise<void>;
  copyText(text: string): Promise<void>;
  openReview(
    server: DescribeResult,
    target: ReviewTarget,
  ): Promise<ReviewOutcome>;
}

export interface ControllerOptions {
  connect(): Promise<ConnectResult>;
  ui: WorkbenchUi;
  post(state: ViewState): void;
  modelId(): string | null;
  newId(): string;
  poller?: Pick<PollerOptions, "minDelayMs" | "maxDelayMs" | "sleep">;
}

const TERMINAL: readonly TaskStatus[] = ["completed", "cancelled", "failed"];
export const MAX_EVENTS = 1000;
const MAX_ARTIFACT_TEXT = 256 * 1024;
const TEXT_TYPES =
  /^(text\/|application\/(json|x-ndjson|xml|yaml|x-yaml|javascript|x-diff|x-patch)\b)/i;

interface Selection {
  generation: number;
  task: Task;
  events: EventView[];
  eventsTruncated: boolean;
  polling: PollerStatus;
  usage: { input: number; output: number; cost: number; unknown: boolean };
  diff: DiffFile[] | null;
  checkpoints: CheckpointRef[];
  workspace: WorkspaceRef | null;
  artifact: ArtifactView | null;
  refreshing: boolean;
}

function disconnected(
  status: ConnectionStatus,
  message: string | null,
): ConnectionView {
  return {
    status,
    message,
    server: null,
    workspaceLabel: null,
    workspaceId: null,
    canExecute: false,
    canCheckpoint: false,
  };
}

function summarize(text: string, max = 160): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

/**
 * VS Code–independent workbench state machine. All task truth comes from the
 * server; the controller only caches the latest validated responses, and it
 * never executes tools, calls models or touches the filesystem itself.
 */
export class WorkbenchController {
  private client: MarsClient | undefined;
  private server: DescribeResult | undefined;
  private connection: ConnectionView = disconnected("connecting", null);
  private tasks: Task[] = [];
  private selection: Selection | undefined;
  private poller: EventPoller | undefined;
  private generation = 0;
  private busy: string | null = null;
  private notice: Notice | null = null;
  private readonly inflight = new Set<AbortController>();
  private disposedFlag = false;
  /** Server identity of the last successful describe; a change drops all task state. */
  private identity: { server: string; scope: Scope } | undefined;
  /** Checkpoints created in this session, kept per task across selections. */
  private readonly checkpointCache = new Map<
    string,
    { checkpoints: CheckpointRef[]; workspace: WorkspaceRef | null }
  >();

  constructor(private readonly options: ControllerOptions) {}

  get disposed(): boolean {
    return this.disposedFlag;
  }

  get activePoller(): EventPoller | undefined {
    return this.poller;
  }

  dispose(): void {
    this.disposedFlag = true;
    this.stopPolling();
    for (const controller of this.inflight) controller.abort();
    this.inflight.clear();
  }

  /** Validates and dispatches one untrusted webview message. */
  async handleMessage(raw: unknown): Promise<boolean> {
    const parsed = WebviewMessageSchema.safeParse(raw);
    if (!parsed.success || this.disposedFlag) return false;
    await this.dispatch(parsed.data);
    return true;
  }

  private async dispatch(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case "ready":
        this.emit();
        if (!this.client) await this.connect();
        return;
      case "connect":
        return this.connect();
      case "setToken":
        await this.options.ui.promptToken();
        return this.connect();
      case "refresh":
        return this.refresh();
      case "selectTask":
        return this.select(message.taskId);
      case "createTask":
        return this.createTask(message);
      case "startTask":
        return this.start(message.taskId, message.approvals);
      case "resumeTask":
        return this.resume(message.taskId);
      case "steerTask":
        return this.steer(message.taskId, message.instruction);
      case "cancelTask":
        return this.cancel(message.taskId);
      case "loadDiff":
        return this.loadDiff(message.taskId);
      case "openDiff":
        return this.openDiff(message.taskId, message.index);
      case "inspectArtifact":
        return this.inspectArtifact(message.taskId, message.artifactId, false);
      case "openArtifact":
        return this.inspectArtifact(message.taskId, message.artifactId, true);
      case "createCheckpoint":
        return this.checkpoint(message.taskId);
      case "restoreCheckpoint":
        return this.restore(message.taskId, message.checkpointId);
      case "followUp":
        return this.followUp(message.taskId, message.prompt);
      case "openReview":
        return this.openReview(message);
      case "copyText":
        return this.copyText(message.text);
    }
  }

  get selectedTaskId(): string | undefined {
    return this.selection?.task.task_id;
  }

  // ---------------------------------------------------------------- state

  snapshot(): ViewState {
    const selected = this.selection;
    let selectedView: SelectedView | null = null;
    if (selected) {
      selectedView = {
        task: selected.task,
        events: selected.events,
        eventsTruncated: selected.eventsTruncated,
        polling: selected.polling,
        usage: {
          input_tokens: selected.usage.input,
          output_tokens: selected.usage.output,
          cost_usd: selected.usage.cost,
          cost_unknown: selected.usage.unknown,
          budget: selected.task.budget,
        },
        diff: selected.diff ? selected.diff.map(diffView) : null,
        checkpoints: selected.checkpoints,
        workspace: selected.workspace,
        artifact: selected.artifact,
      };
    }
    return {
      connection: this.connection,
      policy: {
        modelId: this.options.modelId(),
        paidPolicy:
          "Free-cloud models first. Paid models run only if the server's paid-model policy allows them; this client cannot enable paid fallback.",
      },
      tasks: this.tasks.map((task) => ({
        task_id: task.task_id,
        request: summarize(task.request),
        status: task.status,
        revision: task.revision,
      })),
      selected: selectedView,
      busy: this.busy,
      notice: this.notice,
    };
  }

  private emit(): void {
    if (!this.disposedFlag) this.options.post(this.snapshot());
  }

  private setNotice(kind: Notice["kind"], text: string): void {
    this.notice = { kind, text };
  }

  // ---------------------------------------------------------- requests

  private async request<T>(
    label: string | null,
    run: (client: MarsClient, signal: AbortSignal) => Promise<T>,
  ): Promise<T | undefined> {
    const client = this.client;
    if (!client) {
      this.setNotice("error", "Not connected to a MARS server.");
      this.emit();
      return undefined;
    }
    if (label) {
      if (this.busy) {
        this.setNotice("info", `Wait for "${this.busy}" to finish.`);
        this.emit();
        return undefined;
      }
      this.busy = label;
      this.notice = null;
      this.emit();
    }
    const controller = new AbortController();
    this.inflight.add(controller);
    try {
      const result = await run(client, controller.signal);
      if (this.connection.status === "disconnected" && this.client === client)
        this.connection = {
          ...this.connection,
          status: "connected",
          message: null,
        };
      return result;
    } catch (error) {
      await this.fail(error);
      return undefined;
    } finally {
      this.inflight.delete(controller);
      if (label) this.busy = null;
      this.emit();
    }
  }

  private async fail(error: unknown): Promise<void> {
    if (this.disposedFlag) return;
    const rpc =
      error instanceof RpcError
        ? error
        : new RpcError("protocol", "Unexpected client error.");
    switch (rpc.kind) {
      case "cancelled":
        return;
      case "disconnected":
      case "timeout":
        this.connection = {
          ...this.connection,
          status: "disconnected",
          message: rpc.message,
        };
        return;
      case "no-token":
        this.markDisconnected(
          "no-token",
          "Set a MARS server token to connect.",
        );
        return;
      case "unauthorized":
        this.markDisconnected(
          "unauthorized",
          "The server rejected the token. Set a new token.",
        );
        return;
      case "forbidden":
        this.setNotice("permission", `Permission denied: ${rpc.message}`);
        return;
      case "conflict":
        this.setNotice(
          "conflict",
          `The task changed on the server (${rpc.message}). Showing the latest server state; review it and retry.`,
        );
        await this.reloadSelected();
        return;
      default:
        this.setNotice("error", rpc.message);
    }
  }

  private markDisconnected(status: ConnectionStatus, message: string): void {
    this.stopPolling();
    this.client = undefined;
    this.server = undefined;
    this.connection = disconnected(status, message);
  }

  // ---------------------------------------------------------- connection

  async connect(): Promise<void> {
    this.stopPolling();
    this.client = undefined;
    this.server = undefined;
    this.connection = disconnected("connecting", null);
    this.emit();
    const result = await this.options.connect();
    if (this.disposedFlag) return;
    if (!result.ok) {
      this.connection = disconnected(result.status, result.message);
      this.emit();
      return;
    }
    const controller = new AbortController();
    this.inflight.add(controller);
    try {
      const server = await result.client.describe(controller.signal);
      const previous = this.identity;
      if (
        previous &&
        (previous.server !== result.server ||
          !sameScope(previous.scope, server.scope))
      )
        this.resetServerState();
      this.identity = { server: result.server, scope: server.scope };
      this.client = result.client;
      this.server = server;
      this.connection = {
        status: "connected",
        message: null,
        server: result.server,
        workspaceLabel: server.workspaceLabel,
        workspaceId: server.scope.workspace_id ?? null,
        canExecute: server.capabilities.execute,
        canCheckpoint: server.capabilities.checkpoint,
      };
      this.notice = null;
    } catch (error) {
      const rpc = error instanceof RpcError ? error : undefined;
      const status: ConnectionStatus =
        rpc?.kind === "unauthorized"
          ? "unauthorized"
          : rpc?.kind === "no-token"
            ? "no-token"
            : rpc?.kind === "disconnected" || rpc?.kind === "timeout"
              ? "disconnected"
              : "error";
      this.connection = disconnected(
        status,
        rpc?.message ?? "Connection failed.",
      );
      this.emit();
      return;
    } finally {
      this.inflight.delete(controller);
    }
    this.emit();
    await this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.client) return this.connect();
    const tasks = await this.request(null, (client, signal) =>
      client.list(signal),
    );
    if (!tasks) return;
    this.tasks = tasks;
    const selected = this.selection;
    if (selected) {
      const fresh = tasks.find(
        (task) => task.task_id === selected.task.task_id,
      );
      if (!fresh) {
        this.stopPolling();
        this.generation++;
        this.selection = undefined;
      } else {
        this.replaceTask(fresh);
        if (!this.poller && !TERMINAL.includes(fresh.status))
          this.startPolling(selected.generation, fresh.task_id);
      }
    }
    this.emit();
  }

  // ---------------------------------------------------------- selection

  private resetServerState(): void {
    this.stopPolling();
    this.generation++;
    this.selection = undefined;
    this.tasks = [];
    this.checkpointCache.clear();
  }

  private rememberCheckpoints(selected: Selection): void {
    this.checkpointCache.set(selected.task.task_id, {
      checkpoints: [...selected.checkpoints],
      workspace: selected.workspace,
    });
  }

  private stopPolling(): void {
    this.poller?.dispose();
    this.poller = undefined;
  }

  private current(taskId: string): Selection | undefined {
    const selected = this.selection;
    return selected && selected.task.task_id === taskId ? selected : undefined;
  }

  private replaceTask(task: Task): void {
    const index = this.tasks.findIndex((item) => item.task_id === task.task_id);
    if (index >= 0) this.tasks[index] = task;
    else this.tasks.unshift(task);
    const selected = this.current(task.task_id);
    if (selected) selected.task = task;
  }

  async select(taskId: string): Promise<void> {
    if (this.selection?.task.task_id === taskId) return;
    this.stopPolling();
    const generation = ++this.generation;
    const known = this.tasks.find((task) => task.task_id === taskId);
    this.selection = undefined;
    this.emit();
    const task = await this.request(null, (client, signal) =>
      client.inspect(taskId, signal),
    );
    if (!task || generation !== this.generation) return;
    if (known && task.revision < known.revision) {
      this.setNotice(
        "conflict",
        "Server returned an older task revision; refresh to resync.",
      );
    }
    this.replaceTask(task);
    const cached = this.checkpointCache.get(taskId);
    this.selection = {
      generation,
      task,
      events: [],
      eventsTruncated: false,
      polling: "idle",
      usage: { input: 0, output: 0, cost: 0, unknown: false },
      diff: null,
      checkpoints: [...(cached?.checkpoints ?? [])],
      workspace: cached?.workspace ?? null,
      artifact: null,
      refreshing: false,
    };
    this.startPolling(generation, taskId);
    this.emit();
  }

  private startPolling(generation: number, taskId: string): void {
    const client = this.client;
    if (!client) return;
    this.stopPolling();
    // A new poller replays from the first event, so drop what it will resend.
    const selected = this.current(taskId);
    if (selected) {
      selected.events = [];
      selected.eventsTruncated = false;
      selected.usage = { input: 0, output: 0, cost: 0, unknown: false };
    }
    const poller = new EventPoller({
      ...this.options.poller,
      fetchBatch: (after, signal) => client.events(taskId, after, signal),
      shouldContinue: () => {
        const selected = this.current(taskId);
        return !!selected && !TERMINAL.includes(selected.task.status);
      },
      onEvents: (events) => {
        if (generation === this.generation) this.applyEvents(taskId, events);
      },
      onStatus: (status, error) => {
        if (generation !== this.generation || this.poller !== poller) return;
        const selected = this.current(taskId);
        if (selected) selected.polling = status;
        if (error) void this.fail(error).then(() => this.emit());
        else this.emit();
      },
    });
    this.poller = poller;
    void poller.start();
  }

  private applyEvents(taskId: string, events: EventEnvelope[]): void {
    const selected = this.current(taskId);
    if (!selected) return;
    let taskChanged = false;
    for (const event of events) {
      if (event.usage) {
        selected.usage.input += event.usage.input_tokens;
        selected.usage.output += event.usage.output_tokens;
        if (event.usage.cost_usd === null) selected.usage.unknown = true;
        else selected.usage.cost += event.usage.cost_usd;
      }
      if (
        event.event_type === "task.updated" ||
        event.event_type === "task.created"
      )
        taskChanged = true;
      selected.events.push({
        event_id: event.event_id,
        event_type: event.event_type,
        occurred_at: event.occurred_at,
        producer: event.producer,
        run_id: event.run_id,
        payload: event.payload,
        usage: event.usage ?? null,
      });
    }
    if (selected.events.length > MAX_EVENTS) {
      selected.events.splice(0, selected.events.length - MAX_EVENTS);
      selected.eventsTruncated = true;
    }
    if (this.connection.status === "disconnected")
      this.connection = {
        ...this.connection,
        status: "connected",
        message: null,
      };
    this.emit();
    if (taskChanged) void this.reloadSelected();
  }

  private async reloadSelected(): Promise<void> {
    const selected = this.selection;
    if (!selected || selected.refreshing) return;
    const { generation } = selected;
    const taskId = selected.task.task_id;
    selected.refreshing = true;
    try {
      const task = await this.request(null, (client, signal) =>
        client.inspect(taskId, signal),
      );
      if (task && generation === this.generation) this.replaceTask(task);
    } finally {
      selected.refreshing = false;
    }
    this.emit();
  }

  // ---------------------------------------------------------- lifecycle

  async createTask(
    input: Extract<WebviewMessage, { type: "createTask" }>,
  ): Promise<void> {
    const server = this.server;
    if (!server) {
      this.setNotice(
        "error",
        "Connect to a MARS server before creating a task.",
      );
      this.emit();
      return;
    }
    const built = buildPendingTask(
      {
        request: input.request,
        acceptance_criteria: input.acceptanceCriteria,
        budget: input.budget,
      },
      server.scope,
      this.options.newId,
    );
    if (!built.ok) {
      this.setNotice("error", built.reason);
      this.emit();
      return;
    }
    const created = await this.request("Creating task", (client, signal) =>
      client.create(built.task, signal),
    );
    if (!created) return;
    this.replaceTask(created);
    this.setNotice(
      "info",
      "Task created. Review it, then start it explicitly.",
    );
    await this.select(created.task_id);
  }

  async start(taskId: string, approvals: Approvals): Promise<void> {
    const selected = this.current(taskId);
    if (!selected) return;
    const task = selected.task;
    if (task.status !== "pending") {
      this.setNotice(
        "error",
        `Only pending tasks can be started (task is ${task.status}).`,
      );
      this.emit();
      return;
    }
    if (approvals.execute && !this.connection.canExecute) {
      this.setNotice(
        "permission",
        "This server does not offer command execution.",
      );
      this.emit();
      return;
    }
    const modelId = this.options.modelId();
    const detail = [
      `Task: ${task.task_id} (revision ${task.revision})`,
      `Request: ${summarize(task.request, 300)}`,
      `Model: ${modelId ?? "server default free-cloud route"}`,
      `Approvals: read ${yesNo(approvals.read)}, write ${yesNo(approvals.write)}, execute ${yesNo(approvals.execute)}`,
      `Budget: ${task.budget.max_tokens} tokens, $${task.budget.max_usd}, ${task.budget.max_duration_ms} ms`,
      "Paid models are used only if the server's paid-model policy allows them.",
    ].join("\n");
    if (
      !(await this.options.ui.confirm(
        "Start this MARS task?",
        detail,
        "Start task",
      ))
    )
      return;
    const started = await this.request("Starting task", (client, signal) =>
      client.start(
        taskId,
        {
          expectedRevision: task.revision,
          approvals,
          ...(modelId ? { modelId } : {}),
        },
        signal,
      ),
    );
    if (started) this.afterMutation(started);
  }

  async resume(taskId: string): Promise<void> {
    const selected = this.current(taskId);
    if (!selected) return;
    const task = selected.task;
    if (task.status !== "paused") {
      this.setNotice(
        "error",
        `Only paused tasks can be resumed (task is ${task.status}).`,
      );
      this.emit();
      return;
    }
    const detail = `Task: ${task.task_id} (revision ${task.revision})\nResumes with the approvals the server recorded for this task.`;
    if (
      !(await this.options.ui.confirm(
        "Resume this MARS task?",
        detail,
        "Resume task",
      ))
    )
      return;
    const resumed = await this.request("Resuming task", (client, signal) =>
      client.resume(taskId, task.revision, signal),
    );
    if (resumed) this.afterMutation(resumed);
  }

  private afterMutation(task: Task): void {
    this.replaceTask(task);
    const selected = this.current(task.task_id);
    if (selected && !this.poller && !TERMINAL.includes(task.status))
      this.startPolling(selected.generation, task.task_id);
    this.poller?.poke();
    this.emit();
  }

  async steer(taskId: string, instruction: string): Promise<void> {
    const selected = this.current(taskId);
    const text = instruction.trim();
    if (!selected) return;
    if (!text) {
      this.setNotice("error", "Enter a steering instruction.");
      this.emit();
      return;
    }
    if (
      selected.task.status !== "running" &&
      selected.task.status !== "paused"
    ) {
      this.setNotice(
        "error",
        `Only running or paused tasks can be steered (task is ${selected.task.status}).`,
      );
      this.emit();
      return;
    }
    const sent = await this.request(
      "Sending instruction",
      async (client, signal) => {
        await client.steer(taskId, text, signal);
        return true;
      },
    );
    if (sent) {
      this.setNotice("info", "Instruction sent.");
      this.poller?.poke();
      this.emit();
    }
  }

  /**
   * A follow-up is a prompt the model proposed inside its own output. It is
   * shown in full and sent through the normal steer path only after the user
   * confirms, and only to a task that is still live.
   */
  async followUp(taskId: string, prompt: string): Promise<void> {
    const selected = this.current(taskId);
    const text = prompt.trim();
    if (!selected || !text) return;
    const status = selected.task.status;
    if (status !== "running" && status !== "paused") {
      this.setNotice(
        "info",
        `A follow-up can only steer a running or paused task (task is ${status}). Create a new task with this prompt instead.`,
      );
      this.emit();
      return;
    }
    const detail = [
      `Task: ${taskId} (revision ${selected.task.revision}, ${status})`,
      "The model proposed this follow-up in its output. Nothing was sent yet.",
      "",
      "Prompt:",
      text,
    ].join("\n");
    if (
      !(await this.options.ui.confirm(
        "Send this follow-up as a steering instruction?",
        detail,
        "Send follow-up",
      ))
    )
      return;
    await this.steer(taskId, text);
  }

  async cancel(taskId: string): Promise<void> {
    const selected = this.current(taskId);
    if (!selected) return;
    if (TERMINAL.includes(selected.task.status)) {
      this.setNotice("info", `Task is already ${selected.task.status}.`);
      this.emit();
      return;
    }
    const detail = `Task: ${taskId} (revision ${selected.task.revision}, ${selected.task.status})`;
    if (
      !(await this.options.ui.confirm(
        "Cancel this MARS task?",
        detail,
        "Cancel task",
      ))
    )
      return;
    const cancelled = await this.request(
      "Cancelling task",
      async (client, signal) => {
        await client.cancel(taskId, signal);
        return true;
      },
    );
    if (!cancelled) return;
    this.poller?.poke();
    await this.reloadSelected();
  }

  // ---------------------------------------------------------- diffs

  async loadDiff(taskId: string): Promise<void> {
    if (!this.current(taskId)) return;
    const generation = this.generation;
    const diff = await this.request("Loading changes", (client, signal) =>
      client.diff(taskId, signal),
    );
    const selected = this.current(taskId);
    if (diff && selected && generation === this.generation) {
      selected.diff = diff.files;
      this.emit();
    }
  }

  async openDiff(taskId: string, index: number): Promise<void> {
    const selected = this.current(taskId);
    const server = this.server;
    const file = selected?.diff?.[index];
    if (!selected || !server || !file) return;
    const outcome = await this.options.ui.openDiff(server, file);
    if (outcome.mode === "rejected")
      this.setNotice(
        "error",
        `Refused to open ${file.path}: ${outcome.reason}`,
      );
    else if (outcome.mode === "patch")
      this.setNotice("info", `Showing patch only: ${outcome.reason}`);
    else if (outcome.basis === "local-after")
      this.setNotice(
        "info",
        `${file.path} already contains the task change locally; showing it against the reconstructed original.`,
      );
    else this.notice = null;
    this.emit();
  }

  // ---------------------------------------------------------- output links

  /** Opens a `mars://review` target locally; the PR URL is displayed, never fetched. */
  async openReview(
    message: Extract<WebviewMessage, { type: "openReview" }>,
  ): Promise<void> {
    const selected = this.current(message.taskId);
    const server = this.server;
    if (!selected || !server) return;
    const label = `${message.path}:${message.line_start}-${message.line_end}`;
    const check = checkRelativePath(message.path);
    if (!check.ok) {
      this.setNotice("error", `Refused to open ${label}: ${check.reason}`);
      this.emit();
      return;
    }
    if (message.line_end < message.line_start) {
      this.setNotice("error", `Refused to open ${label}: empty line range.`);
      this.emit();
      return;
    }
    const span = message.line_end - message.line_start + 1;
    if (span > DEFAULT_MAX_REVIEW_LINES) {
      this.setNotice(
        "error",
        `Refused to open ${label}: range spans ${span} lines; the limit is ${DEFAULT_MAX_REVIEW_LINES}.`,
      );
      this.emit();
      return;
    }
    const outcome = await this.options.ui.openReview(server, {
      path: message.path,
      segments: check.segments,
      line_start: message.line_start,
      line_end: message.line_end,
      side: message.side,
      pr: message.pr,
    });
    if (outcome.ok)
      this.setNotice(
        "info",
        `Opened ${label} (${message.side} side of ${message.pr}; the PR itself was not fetched${outcome.note ? `; ${outcome.note}` : ""}).`,
      );
    else this.setNotice("error", `Refused to open ${label}: ${outcome.reason}`);
    this.emit();
  }

  async copyText(text: string): Promise<void> {
    await this.options.ui.copyText(text);
    this.setNotice("info", "Copied to the clipboard.");
    this.emit();
  }

  // ---------------------------------------------------------- artifacts

  private findArtifact(
    selected: Selection,
    artifactId: string,
  ): ArtifactRef | undefined {
    for (const event of selected.events)
      if (event.payload.artifact_id === artifactId) return event.payload;
    for (const ref of selected.task.artifacts)
      if (ref.artifact_id === artifactId) return ref;
    for (const checkpoint of selected.checkpoints)
      if (checkpoint.artifact.artifact_id === artifactId)
        return checkpoint.artifact;
    return undefined;
  }

  async inspectArtifact(
    taskId: string,
    artifactId: string,
    inEditor: boolean,
  ): Promise<void> {
    const selected = this.current(taskId);
    if (!selected) return;
    const ref = this.findArtifact(selected, artifactId);
    if (!ref) {
      this.setNotice("error", "Unknown artifact.");
      this.emit();
      return;
    }
    const generation = this.generation;
    const artifact = await this.request("Loading artifact", (client, signal) =>
      client.artifact(taskId, ref, signal),
    );
    if (!artifact || generation !== this.generation || !this.current(taskId))
      return;
    if (inEditor) {
      await this.options.ui.openArtifact(
        artifact,
        `MARS artifact ${ref.artifact_id}`,
      );
      return;
    }
    selected.artifact = artifactView(artifact, isFinalText(selected.task, ref));
    this.emit();
  }

  // ---------------------------------------------------------- checkpoints

  async checkpoint(taskId: string): Promise<void> {
    if (!this.current(taskId)) return;
    if (!this.connection.canCheckpoint) {
      this.setNotice(
        "permission",
        "This server does not offer workspace checkpoints.",
      );
      this.emit();
      return;
    }
    const checkpoint = await this.request(
      "Creating checkpoint",
      (client, signal) => client.checkpoint(taskId, signal),
    );
    const selected = this.current(taskId);
    if (!checkpoint || !selected) return;
    selected.checkpoints = [
      checkpoint,
      ...selected.checkpoints.filter(
        (item) => item.checkpoint_id !== checkpoint.checkpoint_id,
      ),
    ];
    selected.workspace = checkpoint.workspace;
    this.rememberCheckpoints(selected);
    this.setNotice("info", `Checkpoint ${checkpoint.checkpoint_id} created.`);
    this.emit();
  }

  async restore(taskId: string, checkpointId: string): Promise<void> {
    const selected = this.current(taskId);
    if (!selected) return;
    const checkpoint = selected.checkpoints.find(
      (item) => item.checkpoint_id === checkpointId,
    );
    const workspace = selected.workspace;
    if (!checkpoint || !workspace) {
      this.setNotice("error", "Unknown checkpoint.");
      this.emit();
      return;
    }
    if (checkpoint.workspace.workspace_id !== workspace.workspace_id) {
      this.setNotice("error", "Checkpoint belongs to a different workspace.");
      this.emit();
      return;
    }
    const detail = [
      "This overwrites workspace files with the checkpoint contents. Changes made after the checkpoint are lost unless the server preserves them.",
      `Workspace: ${workspace.workspace_id} (${workspace.provider})`,
      `Current workspace revision: ${workspace.revision}`,
      `Checkpoint: ${checkpoint.checkpoint_id}`,
      `Checkpoint workspace revision: ${checkpoint.workspace.revision}`,
      `Task: ${taskId}`,
    ].join("\n");
    if (
      !(await this.options.ui.confirm(
        "Restore workspace from checkpoint?",
        detail,
        "Restore workspace",
      ))
    )
      return;
    const restored = await this.request(
      "Restoring checkpoint",
      (client, signal) =>
        client.restore(taskId, checkpoint, workspace.revision, signal),
    );
    const current = this.current(taskId);
    if (!restored || !current) return;
    current.workspace = restored;
    current.diff = null;
    this.rememberCheckpoints(current);
    this.setNotice(
      "info",
      `Workspace ${restored.workspace_id} restored to checkpoint ${checkpointId}.`,
    );
    await this.reloadSelected();
  }
}

function diffView(file: DiffFile, index: number): DiffFileView {
  const check = checkRelativePath(file.path);
  const stats = patchStats(file.patch);
  return {
    index,
    path: file.path,
    status: file.status,
    additions: stats.additions,
    deletions: stats.deletions,
    safe: check.ok,
    reason: check.ok ? null : check.reason,
  };
}

/**
 * The host stores the model's final text as a bare `text/plain` artifact on
 * the task itself; command stdout/stderr are `text/plain; charset=utf-8` and
 * only ever appear as event payloads, so they stay raw text.
 */
export function isFinalText(task: Task, ref: ArtifactRef): boolean {
  return (
    ref.media_type === "text/plain" &&
    task.artifacts.some((item) => item.artifact_id === ref.artifact_id)
  );
}

export function artifactView(
  artifact: VerifiedArtifact,
  finalText: boolean,
): ArtifactView {
  const base = {
    artifact_id: artifact.ref.artifact_id,
    media_type: artifact.media_type,
    byte_length: artifact.bytes.byteLength,
    final_text: finalText,
  };
  if (!TEXT_TYPES.test(artifact.media_type))
    return {
      ...base,
      text: null,
      truncated: false,
      note: "Binary artifact; content not displayed.",
    };
  const slice = artifact.bytes.subarray(0, MAX_ARTIFACT_TEXT);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(slice);
  } catch {
    if (artifact.bytes.byteLength <= MAX_ARTIFACT_TEXT)
      return {
        ...base,
        text: null,
        truncated: false,
        note: "Artifact is not valid UTF-8.",
      };
    text = new TextDecoder("utf-8").decode(slice);
  }
  const truncated = artifact.bytes.byteLength > MAX_ARTIFACT_TEXT;
  return {
    ...base,
    text,
    truncated,
    note: truncated ? "Showing the first 256 KiB." : null,
  };
}
