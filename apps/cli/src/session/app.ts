import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  detectColourDepth,
  glyphPresetFromEnv,
  keysFor,
  LIMITS,
  type MarsThemeName,
  STRINGS,
} from "@mars/ui-core";
import {
  type Component,
  matchesKey,
  ProcessTerminal,
  TUI,
} from "@oh-my-pi/pi-tui";
import { renderTranscript } from "./cards";
import { httpTransport, SessionClient, type SessionTransport } from "./client";
import { readConnectionFile } from "./connection";
import { SessionController } from "./controller";
import { fixtureWorkbench } from "./fixture";
import {
  cardContext,
  initialState,
  renderScreen,
  type SessionState,
} from "./screen";

const USAGE = [
  "Usage: mars session [task] [--connection FILE] [--project ID] [--source DIR] [--theme mars-dark|mars-light] [--fixture demo|large] [--journal available|unavailable]",
  "Read-only terminal client for a running `mars serve` workbench: transcript, status line, /tasks, /resume (view only), /export, /graph, /proposals, /model, /context.",
  "It sends only read methods; start, steer, cancel and approvals are not in this client yet. --fixture runs over built-in fixture data (fixture evidence, no workbench).",
].join("\n");

const is = (data: string, id: string) =>
  keysFor(id).some((key) => matchesKey(data, key as never));

/** Root component: one full-screen frame from `renderScreen`; key handling never sends a mutating request. */
export class SessionView implements Component {
  private lastCtrlC = 0;
  constructor(
    private readonly state: SessionState,
    private readonly controller: SessionController,
    private readonly rows: () => number,
    private readonly redraw: (force?: boolean) => void,
    private readonly quit: () => void,
    private readonly now: () => number = Date.now,
  ) {}

  render(width: number): readonly string[] {
    return renderScreen(this.state, width, this.rows());
  }

  invalidate(): void {}

  private entryIds(): string[] {
    return (this.state.projection?.entries ?? [])
      .filter((entry) => entry.kind !== "earlier")
      .map((entry) => entry.id);
  }

  private focus(delta: number | "first" | "last"): void {
    const ids = this.entryIds();
    if (!ids.length) return;
    const current = this.state.focusedId
      ? ids.indexOf(this.state.focusedId)
      : ids.length;
    const next =
      delta === "first"
        ? 0
        : delta === "last"
          ? ids.length - 1
          : Math.max(0, Math.min(ids.length - 1, current + delta));
    this.state.focusedId = ids[next] ?? null;
    this.state.scroll = 0;
    const lines = renderTranscript(
      this.state.projection ?? {
        entries: [],
        trimmed: 0,
        totals: { input_tokens: 0, output_tokens: 0, cost_usd: null },
        children: 0,
        verify: { pass: 0, fail: 0 },
        journal: "unknown",
        last_event_id: null,
      },
      cardContext(this.state, 100),
    );
    const index = lines.findIndex(
      (line) => line.includes("\x1b[7m>") || line.startsWith(">"),
    );
    if (index >= 0)
      this.state.scroll = Math.max(
        0,
        lines.length - index - Math.floor(this.rows() / 2),
      );
  }

  async handle(data: string): Promise<void> {
    const state = this.state;
    if (is(data, "mars.global.quit")) {
      if (this.now() - this.lastCtrlC < LIMITS.quitConfirmMs)
        return this.quit();
      this.lastCtrlC = this.now();
      state.notice = STRINGS.quitHint;
      return;
    }
    if (is(data, "mars.global.quitEmpty") && !state.composer)
      return this.quit();
    if (is(data, "mars.global.redraw")) return this.redraw(true);
    if (state.overlay) {
      if (is(data, "mars.overlay.close")) state.overlay = null;
      else if (is(data, "mars.overlay.up"))
        state.overlayScroll = Math.max(0, state.overlayScroll - 1);
      else if (is(data, "mars.overlay.down")) state.overlayScroll++;
      else if (is(data, "mars.overlay.pageUp"))
        state.overlayScroll = Math.max(
          0,
          state.overlayScroll - (this.rows() - 6),
        );
      else if (is(data, "mars.overlay.pageDown"))
        state.overlayScroll += this.rows() - 6;
      return;
    }
    if (is(data, "mars.composer.submit")) {
      const line = state.composer;
      state.composer = "";
      if (
        line.startsWith("/") &&
        (await this.controller.command(line)) === "quit"
      )
        this.quit();
      return;
    }
    if (is(data, "mars.composer.clear")) {
      state.composer = "";
      return;
    }
    if (is(data, "mars.composer.complete") && state.composer.startsWith("/")) {
      const { SLASH_COMMANDS } = await import("@mars/ui-core");
      const match = SLASH_COMMANDS.find((command) =>
        `/${command.name}`.startsWith(state.composer),
      );
      if (match) state.composer = `/${match.name}`;
      return;
    }
    if (data === "\x7f" || data === "\b") {
      state.composer = state.composer.slice(0, -1);
      return;
    }
    if (is(data, "mars.transcript.expandAll")) {
      const ids = this.entryIds();
      if (ids.every((id) => state.expanded.has(id))) state.expanded.clear();
      else for (const id of ids) state.expanded.add(id);
      return;
    }
    if (is(data, "mars.transcript.expand")) {
      const id = state.focusedId ?? this.entryIds().at(-1);
      if (id)
        state.expanded.has(id)
          ? state.expanded.delete(id)
          : state.expanded.add(id);
      return;
    }
    if (is(data, "mars.transcript.thinking")) {
      state.showThinking = !state.showThinking;
      return;
    }
    if (is(data, "mars.transcript.focusPrevious")) return this.focus(-1);
    if (is(data, "mars.transcript.focusNext")) return this.focus(1);
    if (is(data, "mars.transcript.top")) return this.focus("first");
    if (is(data, "mars.transcript.bottom")) {
      state.focusedId = null;
      state.scroll = 0;
      return;
    }
    if (is(data, "mars.transcript.loadEarlier")) {
      const before = state.scroll;
      state.scroll += Math.max(1, this.rows() - 6);
      const total = renderTranscript(
        state.projection ?? this.controller.emptyProjection(),
        cardContext(state, 100),
      ).length;
      if (state.scroll > total && before >= total - this.rows())
        this.controller.loadEarlier();
      return;
    }
    if (data === "\x1b[6~") {
      state.scroll = Math.max(0, state.scroll - Math.max(1, this.rows() - 6));
      return;
    }
    if (!state.composer && is(data, "mars.global.help")) {
      await this.controller.command("/help");
      return;
    }
    if (data.length === 1 && data >= " " && (state.composer || data === "/"))
      state.composer += data;
  }

  handleInput(data: string): void {
    void this.handle(data)
      .catch((error) => {
        this.state.notice =
          error instanceof Error ? error.message : String(error);
      })
      .finally(() => this.redraw());
  }
}

async function defaultConnectionPath(
  project: string | undefined,
  source: string | undefined,
): Promise<string> {
  const resolved = await realpath(resolve(source ?? process.cwd()));
  const id =
    project ??
    `project-${createHash("sha256").update(resolved).digest("hex").slice(0, 24)}`;
  return join(homedir(), ".mars", "workbench", id, "connection.json");
}

export async function runSession(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: {
      connection: { type: "string" },
      project: { type: "string" },
      source: { type: "string" },
      theme: { type: "string" },
      fixture: { type: "string" },
      journal: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (positionals.length > 1)
    throw new Error(`Pass at most one task id.\n${USAGE}`);
  if (!process.stdout.isTTY)
    throw new Error(
      "mars session needs an interactive terminal; use mars render for piped output.",
    );
  const theme = (values.theme ?? "mars-dark") as MarsThemeName;
  if (theme !== "mars-dark" && theme !== "mars-light")
    throw new Error("--theme must be mars-dark or mars-light.");
  let transport: SessionTransport;
  if (values.fixture !== undefined) {
    if (values.fixture !== "demo" && values.fixture !== "large")
      throw new Error("--fixture must be demo or large.");
    transport = fixtureWorkbench({
      large: values.fixture === "large",
      journal: values.journal === "unavailable" ? "unavailable" : "available",
    }).transport;
  } else {
    const path =
      values.connection ??
      (await defaultConnectionPath(values.project, values.source));
    transport = httpTransport(await readConnectionFile(path));
  }
  const state = initialState({
    theme,
    depth: detectColourDepth(process.env),
    glyphs: glyphPresetFromEnv(process.env),
  });
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);
  let done: () => void = () => {};
  const finished = new Promise<void>((resolveDone) => {
    done = resolveDone;
  });
  const controller = new SessionController(
    new SessionClient(transport),
    state,
    () => tui.requestRender(),
    {
      ...(positionals[0] ? { taskId: positionals[0] } : {}),
      width: () => terminal.columns,
    },
  );
  const spinner = setInterval(() => {
    if (state.task?.status !== "running") return;
    state.spinnerFrame++;
    tui.requestRender();
  }, LIMITS.spinnerIntervalMs);
  const view = new SessionView(
    state,
    controller,
    () => terminal.rows,
    (force) => tui.requestRender(force),
    () => {
      clearInterval(spinner);
      controller.stop();
      tui.stop();
      done();
    },
  );
  tui.addChild(view);
  tui.setFocus(view);
  tui.start();
  controller.start();
  await finished;
}
