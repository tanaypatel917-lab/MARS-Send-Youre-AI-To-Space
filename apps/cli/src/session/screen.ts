import type { Task, VerificationView } from "@mars/contracts";
import {
  type ColourDepth,
  createPainter,
  type DescribeExtras,
  errorLine,
  type GlyphPreset,
  glyphs,
  type InspectExtras,
  LIMITS,
  type MarsThemeName,
  STRINGS,
  type TranscriptProjection,
} from "@mars/ui-core";
import { padding, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import {
  type CardContext,
  money,
  renderTranscriptTail,
  sanitize,
} from "./cards";
import type { OverlayView } from "./views";

export type ConnectionState = "connecting" | "connected" | "disconnected";

/** Everything one frame needs. The workbench owns the data; this is a rendered projection only. */
export interface SessionState {
  workspaceLabel: string | null;
  describeExtras: Partial<DescribeExtras>;
  tasks: Task[];
  task: Task | null;
  inspect: Partial<InspectExtras>;
  projection: TranscriptProjection | null;
  verification: VerificationView | null;
  connection: ConnectionState;
  errorCode: string | null;
  expanded: Set<string>;
  showThinking: boolean;
  focusedId: string | null;
  /** Rows scrolled up from the bottom of the transcript. */
  scroll: number;
  overlay: OverlayView | null;
  overlayScroll: number;
  composer: string;
  notice: string | null;
  spinnerFrame: number;
  theme: MarsThemeName;
  depth: ColourDepth;
  glyphs: GlyphPreset;
  connectorIds: string[];
}

export function initialState(
  options: Partial<SessionState> = {},
): SessionState {
  return {
    workspaceLabel: null,
    describeExtras: {},
    tasks: [],
    task: null,
    inspect: {},
    projection: null,
    verification: null,
    connection: "connecting",
    errorCode: null,
    expanded: new Set(),
    showThinking: false,
    focusedId: null,
    scroll: 0,
    overlay: null,
    overlayScroll: 0,
    composer: "",
    notice: null,
    spinnerFrame: 0,
    theme: "mars-dark",
    depth: "truecolor",
    glyphs: "unicode",
    connectorIds: [],
    ...options,
  };
}

function fit(line: string, width: number): string {
  const cut = truncateToWidth(line, width);
  return `${cut}${padding(width - visibleWidth(cut))}`;
}

/** §2.3 segments, most important first; narrow terminals drop them from the right. */
export function statusSegments(state: SessionState): string[] {
  const p = createPainter(state.theme, state.depth);
  const g = glyphs(state.glyphs);
  const segments: string[] = [];
  segments.push(
    p.fg(
      "statusLineModel",
      state.inspect.mode
        ? `mode ${sanitize(state.inspect.mode)}`
        : STRINGS.readOnly,
    ),
  );
  const tier = state.inspect.model_tier;
  if (tier)
    segments.push(
      `${p.fg("statusLineModel", sanitize(tier.model_id))} ${g.dot} ${p.fg(tier.tier === "paid" ? "paidTier" : tier.tier === "local" ? "localTier" : "freeTier", tier.tier)}`,
    );
  const usage = state.inspect.usage_totals;
  if (usage?.context_tokens !== undefined && usage.context_window) {
    const ratio = Math.min(1, usage.context_tokens / usage.context_window);
    const filled = Math.round(ratio * 4);
    segments.push(
      p.fg(
        "statusLineContext",
        `context ${g.filled.repeat(filled)}${g.empty.repeat(4 - filled)} ${Math.round(ratio * 100)}%`,
      ),
    );
  }
  if (state.task) {
    const spent = state.projection?.totals.cost_usd ?? usage?.cost_usd ?? null;
    segments.push(
      p.fg(
        "statusLineCost",
        `cost ${money(spent)} / ${money(state.task.budget.max_usd)}`,
      ),
    );
  }
  const approvals = state.inspect.approvals;
  if (approvals)
    segments.push(
      `approvals ${approvals.read ? "r" : g.dot} ${approvals.write ? "w" : g.dot} ${approvals.execute ? "x" : g.dot}`,
    );
  const children = state.projection?.children ?? 0;
  if (children)
    segments.push(p.fg("statusLineSubagents", `children ${children}`));
  const verify = state.projection?.verify;
  if (verify && (verify.pass || verify.fail || state.verification))
    segments.push(
      `verify ${p.fg("verifyPass", `${g.ok}${verify.pass}`)} ${p.fg("verifyFail", `${g.fail}${verify.fail}`)}${state.verification ? ` ${g.dot} ${STRINGS.verification[state.verification.state]}` : ""}`,
    );
  if (state.workspaceLabel)
    segments.push(p.fg("statusLinePath", sanitize(state.workspaceLabel)));
  return segments;
}

export function renderStatusLine(state: SessionState, width: number): string {
  const segments = statusSegments(state);
  while (segments.length > 1 && visibleWidth(segments.join("  ")) > width)
    segments.pop();
  return fit(segments.join("  "), width);
}

function header(state: SessionState, width: number): string[] {
  const p = createPainter(state.theme, state.depth);
  const g = glyphs(state.glyphs);
  const task = state.task
    ? `${state.task.task_id} ${g.dot} ${state.task.status}`
    : "no task";
  return [
    fit(
      `${p.bold(p.fg("accent", "MARS"))} ${g.dot} ${sanitize(state.workspaceLabel ?? "workbench")} ${g.dot} ${task} ${g.dot} ${p.fg("dim", STRINGS.readOnly)}`,
      width,
    ),
    p.fg("borderMuted", g.hr.repeat(width)),
  ];
}

function composerBand(state: SessionState, width: number): string[] {
  const p = createPainter(state.theme, state.depth);
  const g = glyphs(state.glyphs);
  let line: string;
  if (state.connection === "disconnected" && state.errorCode)
    line = p.fg("error", `${g.fail} ${errorLine(state.errorCode)}`);
  else if (state.notice) line = p.fg("warning", state.notice);
  else if (state.composer)
    line = `${p.fg("accent", g.user)} ${sanitize(state.composer)}`;
  else
    line = `${p.fg("accent", g.user)} ${p.fg("dim", STRINGS.readOnlyComposer)}`;
  return [p.fg("borderMuted", g.hr.repeat(width)), fit(line, width)];
}

export function cardContext(state: SessionState, width: number): CardContext {
  return {
    width,
    painter: createPainter(state.theme, state.depth),
    glyphs: glyphs(state.glyphs),
    expanded: state.expanded,
    showThinking: state.showThinking,
    focusedId: state.focusedId,
    connectorIds: state.connectorIds,
    spinnerFrame: state.spinnerFrame,
  };
}

function overlayBox(
  state: SessionState,
  view: OverlayView,
  width: number,
  height: number,
): string[] {
  const p = createPainter(state.theme, state.depth);
  const { box } = glyphs(state.glyphs);
  const inner = Math.max(10, width - 4);
  const bodyRows = Math.max(1, height - 3);
  const start = Math.min(
    state.overlayScroll,
    Math.max(0, view.lines.length - bodyRows),
  );
  const body = view.lines.slice(start, start + bodyRows);
  const title = ` ${view.title} `;
  const top = `${box.tl}${box.h}${title}${box.h.repeat(Math.max(0, inner + 1 - visibleWidth(title)))}${box.tr}`;
  const more =
    view.lines.length > start + bodyRows
      ? ` +${view.lines.length - start - bodyRows} more `
      : "";
  const hint = ` Esc close${more ? ` ${glyphs(state.glyphs).dot}${more}` : " "}`;
  const bottom = `${box.bl}${box.h.repeat(Math.max(0, inner + 2 - visibleWidth(hint) - 1))}${hint}${box.h}${box.br}`;
  return [
    p.fg("borderAccent", fit(top, width)),
    ...body.map(
      (line) =>
        `${p.fg("borderAccent", box.v)} ${fit(line, inner)} ${p.fg("borderAccent", box.v)}`,
    ),
    p.fg("borderAccent", fit(bottom, width)),
  ];
}

/** One full frame: exactly `height` rows, each exactly `width` columns wide. */
export function renderScreen(
  state: SessionState,
  width: number,
  height: number,
): string[] {
  if (width < LIMITS.minColumns || height < LIMITS.minRows) {
    const rows = Array.from({ length: Math.max(1, height) }, () =>
      padding(Math.max(1, width)),
    );
    rows[Math.floor(rows.length / 2)] = fit(STRINGS.resize, Math.max(1, width));
    return rows;
  }
  const top = height >= LIMITS.headerMinRows ? header(state, width) : [];
  const bottom = [
    ...composerBand(state, width),
    renderStatusLine(state, width),
  ];
  const available = height - top.length - bottom.length;
  let middle: string[];
  if (state.overlay) {
    const box = overlayBox(state, state.overlay, width, available);
    middle = [
      ...box,
      ...Array.from({ length: Math.max(0, available - box.length) }, () =>
        padding(width),
      ),
    ];
  } else {
    const transcript = state.projection
      ? renderTranscriptTail(
          state.projection,
          cardContext(state, width),
          available + state.scroll,
        )
      : [
          state.connection === "connecting"
            ? "connecting to the workbench…"
            : STRINGS.noTasks,
        ];
    const end = Math.max(0, transcript.length - state.scroll);
    const slice = transcript.slice(Math.max(0, end - available), end);
    middle = [
      ...Array.from({ length: available - slice.length }, () => ""),
      ...slice,
    ].map((line) => fit(line, width));
  }
  return [...top, ...middle.slice(0, available), ...bottom];
}
