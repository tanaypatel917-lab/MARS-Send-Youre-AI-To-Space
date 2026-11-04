import { writeFile } from "node:fs/promises";
import type { Task } from "@mars/contracts";
import {
  createPainter,
  glyphs,
  type JournalEntry,
  type JournalState,
  LIMITS,
  type ProjectionEvent,
  pendingJournalIds,
  projectTranscript,
  SLASH_COMMANDS,
  STRINGS,
} from "@mars/ui-core";
import { type SessionClient, SessionRpcError } from "./client";
import { exportMarkdown } from "./export";
import type { SessionState } from "./screen";
import {
  contextView,
  graphView,
  helpView,
  modelView,
  proposalsView,
  resumeView,
  tasksView,
  type ViewContext,
} from "./views";

export interface ControllerOptions {
  taskId?: string;
  now?: () => Date;
  writeFile?: (path: string, text: string) => Promise<void>;
  width?: () => number;
}

/** Read-only: polls the workbench and folds replies into `SessionState`. Sends nothing that mutates. */
export class SessionController {
  private events: ProjectionEvent[] = [];
  private journal: JournalState = { status: "unknown" };
  private journalEntries = new Map<string, JournalEntry>();
  private finalText: string | null = null;
  private backoff = 500;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private limit: number = LIMITS.renderedEntries;

  constructor(
    private readonly client: SessionClient,
    readonly state: SessionState,
    private readonly changed: () => void,
    private readonly options: ControllerOptions = {},
  ) {}

  async connect(): Promise<void> {
    const described = await this.client.describe();
    this.state.workspaceLabel = described.result.workspaceLabel;
    this.state.describeExtras = described.extras;
    this.state.connectorIds = [];
    this.state.tasks = await this.client.list();
    const chosen =
      this.options.taskId ?? this.state.tasks.at(0)?.task_id ?? null;
    if (chosen) await this.select(chosen);
    this.state.connection = "connected";
    this.state.errorCode = null;
    this.changed();
  }

  async select(taskId: string): Promise<void> {
    this.events = [];
    this.journal = { status: "unknown" };
    this.journalEntries = new Map();
    this.finalText = null;
    this.state.expanded.clear();
    this.state.scroll = 0;
    this.state.focusedId = null;
    this.limit = LIMITS.renderedEntries;
    const inspected = await this.client.inspect(taskId);
    this.state.task = inspected.task;
    this.state.inspect = inspected.extras;
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const task = this.state.task;
    if (!task) return;
    const inspected = await this.client.inspect(task.task_id);
    this.state.task = inspected.task;
    this.state.inspect = inspected.extras;
    for (;;) {
      const page = await this.client.events(
        task.task_id,
        this.events.at(-1)?.event.event_id,
      );
      if (!page.length) break;
      this.events.push(...page.map((event) => ({ event })));
    }
    const tailStart = Math.max(0, this.events.length - LIMITS.payloadTail);
    for (let index = tailStart; index < this.events.length; index++) {
      const row = this.events[index];
      if (!row || row.payload !== undefined) continue;
      row.payload =
        (await this.client
          .json(task.task_id, row.event.payload)
          .catch(() => undefined)) ?? null;
    }
    if (this.journal.status !== "unavailable") {
      const pending = pendingJournalIds(
        this.events.slice(tailStart),
        new Set(this.journalEntries.keys()),
      );
      for (
        let index = 0;
        index < pending.length;
        index += LIMITS.journalBatch
      ) {
        const reply = await this.client.journal(
          task.task_id,
          pending.slice(index, index + LIMITS.journalBatch),
        );
        if (!reply.available) {
          this.journal = { status: "unavailable" };
          break;
        }
        for (const entry of reply.entries)
          if (entry.kind !== "not_found" || task.status !== "running")
            this.journalEntries.set(entry.entry_id, entry);
        this.journal = { status: "available", entries: this.journalEntries };
      }
    }
    this.state.verification = await this.client
      .verification(task.task_id)
      .catch(() => null);
    if (this.finalText === null && task.status === "completed") {
      const text = inspected.task.artifacts.findLast((ref) =>
        ref.media_type.startsWith("text/plain"),
      );
      if (text && text.byte_length <= LIMITS.artifactPreviewBytes)
        this.finalText = new TextDecoder().decode(
          await this.client.artifact(task.task_id, text),
        );
    }
    this.state.projection = projectTranscript({
      task: {
        task_id: inspected.task.task_id,
        request: inspected.task.request,
        status: inspected.task.status,
      },
      events: this.events,
      journal: this.journal,
      finalText: this.finalText,
      verification: this.state.verification,
      limit: this.limit,
    });
  }

  emptyProjection() {
    return projectTranscript({ events: [] });
  }

  /** Pages older entries back into the bounded projection ("load earlier"). */
  loadEarlier(): void {
    if (!this.state.projection?.trimmed || !this.state.task) return;
    this.limit += LIMITS.renderedEntries;
    this.state.projection = projectTranscript({
      task: {
        task_id: this.state.task.task_id,
        request: this.state.task.request,
        status: this.state.task.status,
      },
      events: this.events,
      journal: this.journal,
      finalText: this.finalText,
      limit: this.limit,
    });
  }

  /** Polls at 250 ms while running, 2 s idle, and backs off to 30 s while disconnected. */
  start(): void {
    const tick = async () => {
      if (this.stopped) return;
      try {
        if (this.state.connection !== "connected") await this.connect();
        else await this.refresh();
        this.backoff = 500;
        this.state.connection = "connected";
        this.state.errorCode = null;
      } catch (error) {
        this.state.connection = "disconnected";
        this.state.errorCode =
          error instanceof SessionRpcError ? error.code : "unreachable";
        this.backoff = Math.min(LIMITS.pollBackoffMaxMs, this.backoff * 2);
      }
      this.changed();
      if (this.stopped) return;
      const delay =
        this.state.connection !== "connected"
          ? this.backoff
          : this.state.task?.status === "running"
            ? LIMITS.pollRunningMs
            : LIMITS.pollIdleMs;
      this.timer = setTimeout(tick, delay);
    };
    void tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private view(): ViewContext {
    return {
      painter: createPainter(this.state.theme, this.state.depth),
      glyphs: glyphs(this.state.glyphs),
      width: this.options.width?.() ?? 100,
      now: this.options.now?.() ?? new Date(),
    };
  }

  private open(view: SessionState["overlay"]): undefined {
    this.state.overlay = view;
    this.state.overlayScroll = 0;
    return undefined;
  }

  /** Runs one slash command; every one is a view over data already fetched read-only. */
  async command(line: string): Promise<"quit" | undefined> {
    const [raw = "", ...args] = line.trim().replace(/^\//, "").split(/\s+/);
    const name = raw === "mode" ? "permissions" : raw;
    const known = SLASH_COMMANDS.find((command) => command.name === name);
    this.state.notice = null;
    if (!known) {
      this.state.notice = STRINGS.unknownCommand(name);
      return;
    }
    const view = this.view();
    switch (name) {
      case "help":
        return this.open(helpView(view));
      case "tasks":
        this.state.tasks = await this.client.list();
        return this.open(
          tasksView(view, this.state.tasks, this.state.task?.task_id ?? null),
        );
      case "resume": {
        if (args[0] && args[0] !== this.state.task?.task_id)
          await this.select(args[0]);
        if (!this.state.task) {
          this.state.notice = STRINGS.noTasks;
          return;
        }
        return this.open(
          resumeView(view, this.state.task as Task, this.state.inspect),
        );
      }
      case "graph":
        return this.open(
          graphView(view, this.state.describeExtras, this.state.projection),
        );
      case "proposals":
        return this.open(
          proposalsView(view, this.state.describeExtras, this.state.projection),
        );
      case "model":
        return this.open(
          modelView(view, this.state.describeExtras, this.state.inspect),
        );
      case "context":
        return this.open(contextView(view, this.state.inspect));
      case "compact":
        this.state.notice = STRINGS.compactionDisabled;
        return;
      case "export": {
        if (!this.state.projection || !this.state.task) {
          this.state.notice = STRINGS.noTasks;
          return;
        }
        const path = args[0] ?? `mars-session-${this.state.task.task_id}.md`;
        await (
          this.options.writeFile ??
          ((file, text) => writeFile(file, text, { flag: "wx" }))
        )(path, exportMarkdown(this.state.projection, this.state.task.task_id));
        this.state.notice = `exported ${path} · nothing was executed`;
        return;
      }
      case "quit":
        return "quit";
      default:
        this.state.notice = STRINGS.notYet(name);
    }
  }
}
