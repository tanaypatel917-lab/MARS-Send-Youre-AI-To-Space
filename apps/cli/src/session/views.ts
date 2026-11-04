import type { Task } from "@mars/contracts";
import {
  type DescribeExtras,
  type Entry,
  type Glyphs,
  type InspectExtras,
  KEYMAP,
  keyHint,
  keymapContext,
  type Painter,
  SLASH_COMMANDS,
  STRINGS,
  type TranscriptProjection,
} from "@mars/ui-core";
import { padding, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { money, sanitize } from "./cards";

export interface ViewContext {
  painter: Painter;
  glyphs: Glyphs;
  width: number;
  now: Date;
}

export interface OverlayView {
  title: string;
  lines: string[];
}

type Bag = Record<string, unknown>;
const bag = (value: unknown): Bag =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Bag)
    : {};
const list = (value: unknown): Bag[] =>
  Array.isArray(value) ? value.map(bag) : [];
const text = (value: unknown, fallback = "—"): string =>
  typeof value === "string" && value
    ? sanitize(value)
    : typeof value === "number"
      ? String(value)
      : fallback;

function columns(cells: string[], widths: number[]): string {
  return cells
    .map((cell, index) => {
      const width = widths[index] ?? 10;
      const cut = truncateToWidth(cell, width);
      return `${cut}${padding(width - visibleWidth(cut))}`;
    })
    .join(" ")
    .trimEnd();
}

export function helpView(ctx: ViewContext): OverlayView {
  const { painter: p } = ctx;
  const lines = [p.bold("Commands"), ""];
  for (const command of SLASH_COMMANDS)
    lines.push(
      `${columns([`/${command.name}${command.args ? ` ${command.args}` : ""}`, command.help], [24, Math.max(20, ctx.width - 30)])}${command.stage === 1 ? "" : p.fg("dim", ` (UI PR ${command.stage})`)}`,
    );
  lines.push("", p.bold("Keys"), "");
  let context = "";
  for (const [id, entry] of Object.entries(KEYMAP)) {
    if (keymapContext(id) !== context) {
      context = keymapContext(id);
      lines.push(p.fg("muted", context));
    }
    lines.push(
      `  ${columns([keyHint(id), entry.description], [18, Math.max(20, ctx.width - 24)])}`,
    );
  }
  lines.push("", p.fg("dim", STRINGS.readOnly));
  return { title: "Help", lines };
}

export function tasksView(
  ctx: ViewContext,
  tasks: readonly Task[],
  current: string | null,
): OverlayView {
  const { painter: p, glyphs: g } = ctx;
  if (!tasks.length) return { title: "Tasks", lines: [STRINGS.noTasks] };
  return {
    title: "Tasks",
    lines: tasks.map((task) => {
      const token =
        task.status === "completed"
          ? "success"
          : task.status === "failed"
            ? "error"
            : task.status === "running"
              ? "accent"
              : "muted";
      return `${task.task_id === current ? g.user : " "} ${columns([task.task_id, p.fg(token, task.status), sanitize(task.request)], [20, 10, Math.max(10, ctx.width - 36)])}`;
    }),
  };
}

export function resumeView(
  ctx: ViewContext,
  task: Task,
  extras: Partial<InspectExtras>,
): OverlayView {
  const { painter: p } = ctx;
  const approvals = extras.approvals;
  const rows: [string, string][] = [
    ["task", task.task_id],
    ["status", task.status],
    ["revision", String(task.revision)],
    [
      "model",
      extras.model_tier
        ? `${sanitize(extras.model_tier.model_id)} · ${extras.model_tier.tier}`
        : "—",
    ],
    ["mode", extras.mode ? sanitize(extras.mode) : "—"],
    [
      "approvals",
      approvals
        ? `${approvals.read ? "read" : "·"} ${approvals.write ? "write" : "·"} ${approvals.execute ? "execute" : "·"}`
        : "—",
    ],
    ["max tokens", String(task.budget.max_tokens)],
    ["max cost", money(task.budget.max_usd)],
    ["max duration", `${Math.round(task.budget.max_duration_ms / 1000)}s`],
    ["max depth", String(task.budget.max_depth)],
    ["max concurrency", String(task.budget.max_concurrency)],
  ];
  return {
    title: "Resume · view only",
    lines: [
      p.fg("muted", STRINGS.frozenSettings),
      "",
      ...rows.map(
        ([key, value]) =>
          `${columns([p.fg("dim", key), `${value} ${p.fg("dim", "(frozen)")}`], [18, Math.max(10, ctx.width - 24)])}`,
      ),
      "",
      p.bold("Acceptance criteria"),
      ...task.acceptance_criteria.map(
        (criterion) => `  ${ctx.glyphs.dot} ${sanitize(criterion)}`,
      ),
      "",
      p.fg("dim", "This client does not resume execution."),
    ],
  };
}

const ISOLATION_LABEL: Readonly<Record<string, string>> = {
  process_env: "process-level confinement, not a kernel sandbox",
};

export function graphView(
  ctx: ViewContext,
  extras: Partial<DescribeExtras>,
  projection: TranscriptProjection | null,
): OverlayView {
  const { painter: p } = ctx;
  const graph = extras.graph;
  if (!graph)
    return {
      title: "Knowledge graph",
      lines: [
        p.fg(
          "dim",
          "this workbench does not report a knowledge graph (describe.graph absent)",
        ),
      ],
    };
  const token =
    graph.state === "ready"
      ? "success"
      : graph.state === "failed"
        ? "error"
        : graph.state === "stale"
          ? "warning"
          : "muted";
  const counts = bag(bag(graph).counts);
  const lines = [
    `${columns([p.fg("dim", "state"), p.fg(token, graph.state)], [14, 40])}`,
    `${columns([p.fg("dim", "revision"), text(graph.revision)], [14, 40])}`,
    `${columns([p.fg("dim", "built at"), text(graph.built_at)], [14, 40])}`,
    `${columns([p.fg("dim", "workspace"), text(graph.workspace_revision)], [14, 40])}`,
    `${columns([p.fg("dim", "counts"), counts.nodes !== undefined ? `${text(counts.nodes)} nodes · ${text(counts.edges)} edges` : "—"], [14, 40])}`,
    `${columns([p.fg("dim", "isolation"), graph.isolation ? (ISOLATION_LABEL[graph.isolation] ?? sanitize(graph.isolation)) : "—"], [14, Math.max(20, ctx.width - 20)])}`,
  ];
  if (graph.state === "stale")
    lines.push(
      "",
      p.fg(
        "warning",
        `the workspace is at ${text(graph.workspace_revision)}; the graph was built at ${text(graph.revision)}`,
      ),
      p.fg(
        "dim",
        "action (a steer draft, not in this read-only client): ask the coordinator to rebuild",
      ),
    );
  if (graph.state === "not_built")
    lines.push("", p.fg("dim", "no graph has been built for this workspace"));
  if (graph.state === "unavailable")
    lines.push(
      "",
      p.fg("dim", "the knowledge-graph CLI is not installed on the host"),
    );
  if (graph.state === "failed")
    lines.push(
      "",
      p.fg("error", "the last graph build failed · see the graph.build record"),
    );
  const builds = (projection?.entries ?? []).filter(
    (entry): entry is Extract<Entry, { kind: "graph" }> =>
      entry.kind === "graph" && entry.operation === "graph.build",
  );
  const last = builds.at(-1);
  lines.push("", p.bold("Last graph.build"));
  lines.push(
    last
      ? `  ${last.status} · ${text(last.revision)} · ${sanitize(last.summary)} · model requests 0`
      : p.fg("dim", "  none in this task"),
  );
  return { title: "Knowledge graph · read only", lines };
}

export function proposalsView(
  ctx: ViewContext,
  extras: Partial<DescribeExtras>,
  projection: TranscriptProjection | null,
): OverlayView {
  const { painter: p, glyphs: g } = ctx;
  const lines: string[] = [];
  const vault = bag(extras.vault);
  for (const proposal of list(vault.proposals)) {
    const fence = bag(proposal.revision_fence);
    const scan = bag(proposal.threat_scan);
    const fenceOk =
      fence.expected !== undefined && fence.expected === fence.current;
    lines.push(
      `${p.bold("vault import")} ${g.dot} ${text(proposal.source)} ${g.dot} ${text(proposal.proposal_id)}`,
      `  revision fence ${text(fence.expected)} → ${text(fence.current)} ${fenceOk ? p.fg("success", "holds") : p.fg("warning", "moved")}`,
      `  threat scan ${scan.status === "clean" ? p.fg("success", "clean") : p.fg("warning", text(scan.status))}`,
      ...(Array.isArray(scan.findings) ? scan.findings : []).map(
        (finding) =>
          `    ${p.fg("untrustedLabel", `[${STRINGS.untrusted}]`)} ${text(finding)}`,
      ),
      `  ${p.fg("toolDiffAdded", `+ ${text(proposal.after, "")}`)}`,
      `  ${p.fg("dim", "operator command (not run): mars vault import --accept")}`,
      "",
    );
  }
  for (const entry of projection?.entries ?? []) {
    if (entry.kind !== "proposal") continue;
    lines.push(
      `${p.bold(`${entry.proposal_kind} proposal`)} ${g.dot} ${entry.scope} ${g.dot} rev ${text(entry.revision)} ${g.dot} ${entry.decision ?? "pending"}`,
      `  ${p.fg("toolDiffRemoved", `- ${sanitize(entry.before)}`)}`,
      `  ${p.fg("toolDiffAdded", `+ ${sanitize(entry.after)}`)}`,
      `  ${p.fg("dim", `operator command (not run): ${entry.proposal_kind === "skill" ? "mars skills …" : "decided by the operator outside this client"}`)}`,
      "",
    );
  }
  if (!lines.length) lines.push(p.fg("dim", "no pending proposals"));
  const pending =
    typeof vault.pending_proposals === "number"
      ? `${vault.pending_proposals} pending vault proposal(s)`
      : null;
  return {
    title: "Proposals · read only",
    lines: pending ? [p.fg("muted", pending), "", ...lines] : lines,
  };
}

const DAY_MS = 86_400_000;

export function modelView(
  ctx: ViewContext,
  extras: Partial<DescribeExtras>,
  inspect: Partial<InspectExtras>,
): OverlayView {
  const { painter: p, glyphs: g } = ctx;
  const providers = extras.providers ?? [];
  if (!providers.length)
    return {
      title: "Models",
      lines: [
        p.fg(
          "dim",
          "this workbench does not list providers (describe.providers absent)",
        ),
      ],
    };
  const lines: string[] = [];
  for (const provider of providers) {
    const curated = text(bag(provider).catalog_curated_at, "");
    if (
      provider.catalog_stale ||
      (curated && ctx.now.getTime() - Date.parse(curated) > 120 * DAY_MS)
    )
      lines.push(
        p.fg(
          "warning",
          `${g.warning} ${provider.id} catalog curated ${curated || "unknown"} · stale`,
        ),
      );
  }
  const current = inspect.model_tier?.model_id ?? null;
  for (const tier of ["free", "local", "paid"] as const) {
    const rows = providers.flatMap((provider) =>
      list(bag(provider).models).filter((model) => model.tier === tier),
    );
    if (!rows.length) continue;
    lines.push(
      "",
      p.fg(
        tier === "paid"
          ? "paidTier"
          : tier === "local"
            ? "localTier"
            : "freeTier",
        p.bold(tier),
      ),
    );
    for (const model of rows) {
      const unavailable =
        typeof model.availability === "string" &&
        model.availability.startsWith("unavailable");
      const capabilities = text(model.capabilities, "unknown");
      const price =
        tier === "paid"
          ? `$${text(model.input_usd_per_million, "?")} / $${text(model.output_usd_per_million, "?")} per M`
          : "$ —";
      const row = columns(
        [
          `${text(model.model_id) === current ? g.user : " "} ${text(model.model_id)}`,
          capabilities === "unknown"
            ? p.fg("dim", "capabilities: unknown")
            : capabilities,
          price,
          unavailable ? p.fg("dim", text(model.availability)) : "",
        ],
        [34, 22, 20, 22],
      );
      lines.push(unavailable ? p.fg("dim", row) : row);
    }
  }
  lines.push(
    "",
    p.fg("dim", "view only · launch settings are frozen once a task starts"),
  );
  return { title: "Models · read only", lines };
}

export function contextView(
  ctx: ViewContext,
  inspect: Partial<InspectExtras>,
): OverlayView {
  const { painter: p, glyphs: g } = ctx;
  const rows = inspect.context_rows;
  if (!rows?.length)
    return {
      title: "Context",
      lines: [
        p.fg(
          "dim",
          "this workbench does not report context rows (tasks.inspect.context_rows absent)",
        ),
      ],
    };
  const used = rows.reduce((sum, row) => sum + row.tokens, 0);
  const window = inspect.usage_totals?.context_window ?? null;
  const lines: string[] = [];
  if (window) {
    const cells = 30;
    const filled = Math.min(cells, Math.round((used / window) * cells));
    lines.push(
      `${p.fg("statusLineContext", g.filled.repeat(filled))}${p.fg("dim", g.empty.repeat(cells - filled))} ${Math.round((used / window) * 100)}% of ${window.toLocaleString("en-US")}`,
      "",
    );
  }
  const widths = [26, 9, 7, 24, Math.max(10, ctx.width - 74)];
  lines.push(
    p.fg("muted", columns(["item", "tokens", "$", "source", "remedy"], widths)),
  );
  for (const row of rows)
    lines.push(
      columns(
        [
          `${sanitize(row.item)}${row.trust === "untrusted" ? ` ${p.fg("untrustedLabel", "[untrusted]")}` : ""}`,
          row.tokens.toLocaleString("en-US"),
          row.cost_usd ? money(row.cost_usd) : "$ —",
          sanitize(row.source),
          row.remedy ? sanitize(row.remedy) : "—",
        ],
        widths,
      ),
    );
  lines.push(
    p.fg(
      "muted",
      columns(["total", used.toLocaleString("en-US"), "", "", ""], widths),
    ),
  );
  if (window)
    lines.push(
      p.fg(
        "muted",
        columns(
          [
            "free",
            Math.max(0, window - used).toLocaleString("en-US"),
            "",
            "",
            "compaction is off · /new with a summary",
          ],
          widths,
        ),
      ),
    );
  return { title: "Context · read only", lines };
}
