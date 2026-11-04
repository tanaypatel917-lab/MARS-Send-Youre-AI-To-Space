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
  const rows: [string, string][] = [
    ["task", task.task_id],
    ["status", task.status],
    ["revision", String(task.revision)],
    ["model tier", extras.model_tier ?? "—"],
    [
      "pinned",
      extras.pinned ? `${extras.pinned.length} file(s) · untrusted` : "—",
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

const ISOLATION_LABEL = {
  process_env: "process-level confinement, not a kernel sandbox",
  os_wrapper: "OS-level wrapper (host-reported)",
} as const;

const GRAPH_TOKEN = {
  ready: "success",
  failed: "error",
  stale: "warning",
  building: "muted",
  not_built: "muted",
  unavailable: "muted",
} as const;

export function graphView(
  ctx: ViewContext,
  extras: Partial<DescribeExtras>,
  projection: TranscriptProjection | null,
): OverlayView {
  const { painter: p } = ctx;
  const graph = extras.graph;
  const lines: string[] = [];
  if (graph === undefined)
    lines.push(
      p.fg(
        "dim",
        "this workbench does not report a knowledge graph (describe.graph absent)",
      ),
    );
  else if (graph === null)
    lines.push(
      p.fg("dim", "no unambiguous workspace binding · describe.graph is null"),
      p.fg(
        "dim",
        "per-task graph state comes from the graph.build / graph.query cards below",
      ),
    );
  else {
    lines.push(
      `${columns([p.fg("dim", "state"), p.fg(GRAPH_TOKEN[graph.state], graph.state)], [14, 40])}`,
      `${columns([p.fg("dim", "revision"), text(graph.revision)], [14, 40])}`,
      `${columns([p.fg("dim", "built at"), text(graph.built_at)], [14, 40])}`,
      `${columns([p.fg("dim", "isolation"), graph.isolation ? ISOLATION_LABEL[graph.isolation] : "—"], [14, Math.max(20, ctx.width - 20)])}`,
    );
    if (graph.state === "stale")
      lines.push(
        "",
        p.fg(
          "warning",
          `the graph built at ${text(graph.revision)} is stale for this workspace`,
        ),
        p.fg(
          "dim",
          "action (a steer draft, not in this read-only client): ask the coordinator to rebuild",
        ),
      );
    if (graph.state === "not_built")
      lines.push("", p.fg("dim", "no graph has been built for this workspace"));
    if (graph.state === "building")
      lines.push("", p.fg("dim", "a graph build is in progress"));
    if (graph.state === "unavailable")
      lines.push(
        "",
        p.fg("dim", "the knowledge-graph CLI is not installed on the host"),
      );
    if (graph.state === "failed")
      lines.push(
        "",
        p.fg(
          "error",
          "the last graph build failed · see the graph.build record",
        ),
      );
  }
  const cards = (projection?.entries ?? []).filter(
    (entry): entry is Extract<Entry, { kind: "graph" }> =>
      entry.kind === "graph",
  );
  const last = cards
    .filter((entry) => entry.operation === "graph.build")
    .at(-1);
  lines.push("", p.bold("Last graph.build in this task"));
  lines.push(
    last
      ? `  ${last.status} · ${text(last.revision)} · ${sanitize(last.summary)} · model requests 0`
      : p.fg("dim", "  none in this task"),
  );
  const queries = cards.filter((entry) => entry.operation === "graph.query");
  if (queries.length)
    lines.push(
      "",
      p.bold("graph.query in this task"),
      ...queries.map(
        (entry) =>
          `  ${entry.status} · ${text(entry.revision)} · ${sanitize(entry.summary)}`,
      ),
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
  const vault = extras.vault;
  if (vault) {
    lines.push(
      p.fg(
        "muted",
        `${vault.pending_proposals} pending vault proposal(s) ${g.dot} last export ${text(vault.last_export_at, "never")}`,
      ),
    );
    if (vault.pending_proposals)
      lines.push(
        `  ${p.fg("dim", "operator command (not run): mars vault import --accept")}`,
        `  ${p.fg("dim", "it checks each proposal's revision fence and threat scan before writing")}`,
      );
    lines.push("");
  } else if (vault === null)
    lines.push(
      p.fg(
        "dim",
        "no vault is bound to this workspace (describe.vault is null)",
      ),
      "",
    );
  let shown = 0;
  for (const entry of projection?.entries ?? []) {
    if (entry.kind !== "proposal") continue;
    shown += 1;
    lines.push(
      `${p.bold(`${entry.proposal_kind} proposal`)} ${g.dot} ${entry.scope} ${g.dot} revision ${text(entry.revision)} ${g.dot} ${entry.decision ?? "pending"}`,
      `  ${p.fg("toolDiffRemoved", `- ${sanitize(entry.before)}`)}`,
      `  ${p.fg("toolDiffAdded", `+ ${sanitize(entry.after)}`)}`,
      `  ${p.fg("dim", `operator command (not run): ${entry.proposal_kind === "skill" ? "mars skills …" : "decided by the operator outside this client"}`)}`,
      "",
    );
  }
  if (!shown && !vault?.pending_proposals)
    lines.push(p.fg("dim", "no pending proposals"));
  return { title: "Proposals · read only", lines };
}

const HEALTH_TOKEN = {
  available: "success",
  unavailable: "dim",
  unknown: "muted",
} as const;

export function modelView(
  ctx: ViewContext,
  extras: Partial<DescribeExtras>,
  inspect: Partial<InspectExtras>,
): OverlayView {
  const { painter: p, glyphs: g } = ctx;
  const lines: string[] = [];
  const tier = inspect.model_tier;
  if (tier)
    lines.push(
      `this task ${g.dot} ${p.fg(tier === "paid" ? "paidTier" : tier === "local" ? "localTier" : "freeTier", p.bold(tier))} ${p.fg("dim", "(pinned at launch)")}`,
      "",
    );
  const providers = extras.providers;
  if (!providers)
    lines.push(
      p.fg(
        "dim",
        "this workbench does not list providers (describe.providers absent)",
      ),
    );
  else if (!providers.length)
    lines.push(p.fg("dim", "no providers are configured"));
  else {
    lines.push(
      p.fg(
        "muted",
        columns(["provider", "kind", "health", "catalog"], [28, 12, 14, 20]),
      ),
    );
    for (const provider of providers) {
      const row = columns(
        [
          sanitize(provider.id),
          provider.kind,
          p.fg(HEALTH_TOKEN[provider.health], provider.health),
          provider.catalog_stale
            ? p.fg("warning", `${g.warning} catalog stale`)
            : "catalog current",
        ],
        [28, 12, 14, 20],
      );
      lines.push(provider.health === "unavailable" ? p.fg("dim", row) : row);
    }
    lines.push(
      "",
      p.fg("dim", `policy owner: ${providers[0]?.policy_owner ?? "mars"}`),
    );
  }
  lines.push(
    "",
    p.fg(
      "dim",
      "per-model capabilities and prices are not in workbench RPC · `mars models list` prints them (not run)",
    ),
    p.fg("dim", "view only · launch settings are frozen once a task starts"),
  );
  return { title: "Models · read only", lines };
}

export function contextView(
  ctx: ViewContext,
  inspect: Partial<InspectExtras>,
): OverlayView {
  const { painter: p } = ctx;
  const rows = inspect.context_rows;
  const usage = inspect.usage_totals;
  const lines: string[] = [];
  if (usage)
    lines.push(
      p.fg(
        "statusLineContext",
        `cumulative usage ${usage.input_tokens.toLocaleString("en-US")} in · ${usage.output_tokens.toLocaleString("en-US")} out · ${usage.cost_usd === null ? "$ —" : money(usage.cost_usd)}`,
      ),
      p.fg(
        "dim",
        "the host records cumulative usage only; per-row tokens may be unknown",
      ),
      "",
    );
  if (!rows?.length)
    lines.push(
      p.fg(
        "dim",
        "this workbench does not report context rows (tasks.inspect.context_rows absent)",
      ),
    );
  else {
    const widths = [36, 9, 8, Math.max(10, ctx.width - 60)];
    lines.push(
      p.fg("muted", columns(["source", "tokens", "$", "remedy"], widths)),
    );
    for (const row of rows)
      lines.push(
        columns(
          [
            sanitize(row.source),
            row.tokens === null ? "—" : row.tokens.toLocaleString("en-US"),
            row.cost_usd === null ? "$ —" : money(row.cost_usd),
            sanitize(row.remedy),
          ],
          widths,
        ),
      );
  }
  const pinned = inspect.pinned ?? [];
  if (pinned.length)
    lines.push(
      "",
      p.bold("Pinned"),
      ...pinned.map(
        (file) =>
          `  ${sanitize(file.path)} ${p.fg("dim", `${file.bytes.toLocaleString("en-US")} B`)} ${p.fg("untrustedLabel", `[${STRINGS.untrusted}]`)}`,
      ),
    );
  lines.push("", p.fg("muted", "compaction is off · /new with a summary"));
  return { title: "Context · read only", lines };
}
