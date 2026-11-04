import { processOutput, renderTerminal } from "@mars/output-format";
import type {
  Entry,
  Glyphs,
  Painter,
  TranscriptProjection,
} from "@mars/ui-core";
import { keyHint, LIMITS, STRINGS } from "@mars/ui-core";
import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@oh-my-pi/pi-tui";

export interface CardContext {
  width: number;
  painter: Painter;
  glyphs: Glyphs;
  expanded: ReadonlySet<string>;
  showThinking: boolean;
  focusedId: string | null;
  connectorIds: readonly string[];
  spinnerFrame: number;
}

const TOOL_LABELS: Readonly<Record<string, string>> = {
  mars_read: "Read",
  mars_list: "List",
  mars_glob: "List",
  mars_grep: "Search",
  mars_search: "Search",
  mars_exec: "Bash",
  mars_write: "Write",
  mars_apply_patch: "Update",
  mars_history: "History",
  mars_research_findings: "Research",
  mars_verify: "Verify",
};

/** Strips escape sequences and control characters other than newline/tab: untrusted text never drives the terminal. */
export function sanitize(text: string): string {
  let out = "";
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 27) {
      if (text[index + 1] === "[") {
        index += 2;
        while (index < text.length) {
          const final = text.charCodeAt(index);
          if (final >= 0x40 && final <= 0x7e) break;
          index++;
        }
      }
      continue;
    }
    if ((code < 32 && code !== 10 && code !== 9) || code === 127) continue;
    out += text[index];
  }
  return out;
}

function compact(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function money(value: number | null | undefined): string {
  return value === null || value === undefined ? "$ —" : `$${value.toFixed(2)}`;
}

class Lines {
  readonly out: string[] = [];
  constructor(private readonly ctx: CardContext) {}
  /** Head row: `● Title rest`, wrapped to width with a 2-column hanging indent. */
  head(bullet: string, text: string): void {
    const wrapped = wrapTextWithAnsi(`${bullet} ${text}`, this.ctx.width);
    wrapped.forEach((line, index) => {
      this.out.push(index === 0 ? line : `  ${line}`);
    });
  }
  /** Body rows under `⎿`, indented 2 then 3 more on continuation. */
  body(text: string, first = true): void {
    const { width, glyphs, painter } = this.ctx;
    const lead = first ? `  ${painter.fg("dim", glyphs.connector)} ` : "     ";
    const room = Math.max(10, width - visibleWidth(lead));
    for (const raw of text.split("\n")) {
      const wrapped = wrapTextWithAnsi(raw, room);
      for (const line of wrapped.length ? wrapped : [""]) {
        this.out.push(
          truncateToWidth(
            `${this.out.length && !first ? "     " : lead}${line}`,
            width,
          ),
        );
        first = false;
      }
    }
  }
  plain(line: string): void {
    this.out.push(truncateToWidth(line, this.ctx.width));
  }
}

function preview(
  text: string,
  expanded: boolean,
  ctx: CardContext,
  lines: Lines,
): void {
  const rows = sanitize(text).split("\n");
  const limit = expanded ? rows.length : LIMITS.toolPreviewLines;
  if (!text) return;
  lines.body(rows.slice(0, limit).join("\n"));
  if (rows.length > limit)
    lines.plain(
      `     ${ctx.painter.fg("dim", STRINGS.expandHint(rows.length - limit, keyHint("mars.transcript.expand")))}`,
    );
}

function provenance(ctx: CardContext, source: string, lines: Lines): void {
  lines.plain(
    `     ${ctx.painter.fg("untrustedLabel", `[${STRINGS.untrusted}]`)} ${ctx.painter.fg("dim", sanitize(source))}`,
  );
}

/** One transcript entry → terminal rows. Collapsed unless its id is in `ctx.expanded`. */
export function renderEntry(entry: Entry, ctx: CardContext): string[] {
  const { painter: p, glyphs: g } = ctx;
  const lines = new Lines(ctx);
  const expanded = ctx.expanded.has(entry.id);
  const bullet = (token: string) => p.fg(token, g.running);
  switch (entry.kind) {
    case "earlier":
      lines.plain(
        p.fg(
          "dim",
          `${g.rail} ${STRINGS.loadEarlier(entry.count, keyHint("mars.transcript.loadEarlier"))}`,
        ),
      );
      break;
    case "user":
      lines.head(
        p.fg("accent", g.user),
        `${entry.source === "steer" ? `${p.fg("muted", "[steer]")} ` : ""}${p.bold(sanitize(entry.text))}`,
      );
      break;
    case "turn":
      lines.head(
        entry.running
          ? p.fg(
              "accent",
              g.spinner[ctx.spinnerFrame % g.spinner.length] ?? g.running,
            )
          : bullet("dim"),
        p.fg(
          "dim",
          `${STRINGS.turnMarker} · ${entry.observed}${entry.summary ? ` · ${sanitize(entry.summary)}` : ""}`,
        ),
      );
      if (expanded)
        lines.body(
          p.fg(
            "dim",
            `entries ${entry.entry_ids.join(", ") || "—"} · ${STRINGS.journalUnavailable}`,
          ),
        );
      break;
    case "assistant": {
      const processed = processOutput(sanitize(entry.text), {
        connector_ids: [...ctx.connectorIds],
        allowed_addresses: [],
      });
      const rendered = renderTerminal(processed.document, {
        width: Math.max(20, ctx.width - 2),
        errors: processed.errors,
      }).replace(/\n+$/, "");
      rendered.split("\n").forEach((line, index) => {
        lines.plain(`${index === 0 ? `${bullet("text")} ` : "  "}${line}`);
      });
      if (processed.errors.length)
        lines.plain(
          `  ${p.fg("warning", `${g.warning} ${processed.errors.length} format errors`)}`,
        );
      provenance(ctx, entry.provenance.source, lines);
      break;
    }
    case "thinking":
      if (ctx.showThinking || expanded) {
        lines.head(
          p.fg("thinkingText", g.thinking),
          p.fg("thinkingText", "Thinking"),
        );
        lines.body(p.fg("thinkingText", sanitize(entry.text)));
      } else
        lines.head(
          p.fg("dim", g.thinking),
          p.fg(
            "dim",
            `Thinking${entry.tokens !== null ? ` (${compact(entry.tokens)} tokens)` : ""} · ${keyHint("mars.transcript.thinking")} to show`,
          ),
        );
      break;
    case "tool": {
      const token =
        entry.status === "ok"
          ? "success"
          : entry.status === "running"
            ? "accent"
            : entry.status === "blocked"
              ? "warning"
              : "error";
      const label = TOOL_LABELS[entry.name] ?? entry.name;
      lines.head(
        p.fg(token, entry.status === "blocked" ? g.blocked : g.running),
        `${p.bold(label)}${entry.primary ? `(${sanitize(entry.primary)})` : ""}${entry.status === "ok" ? "" : p.fg(token, ` ${entry.status}`)}`,
      );
      preview(entry.output, expanded, ctx, lines);
      break;
    }
    case "explored":
      lines.head(
        bullet("success"),
        `${p.bold("Explored")} ${g.collapsed} ${entry.counts.map((c) => `${c.verb} ${c.count}`).join(` ${g.dot} `)}`,
      );
      if (expanded)
        entry.tools.forEach((tool, index) => {
          lines.plain(
            `  ${p.fg("dim", index === entry.tools.length - 1 ? g.last : g.branch)} ${TOOL_LABELS[tool.name] ?? tool.name}${tool.primary ? `(${sanitize(tool.primary)})` : ""}`,
          );
        });
      break;
    case "hook":
      lines.head(
        p.fg(
          entry.blocked ? "warning" : "success",
          entry.blocked ? g.blocked : g.running,
        ),
        `${p.bold("Hook")} ${entry.phase} ${p.fg("muted", sanitize(entry.command))}`,
      );
      lines.body(
        `${entry.blocked ? p.fg("warning", "blocked") : "ok"}${entry.exit_code !== null ? ` · exit ${entry.exit_code}` : ""}${entry.reason ? ` · ${sanitize(entry.reason)}` : ""}`,
      );
      if (expanded && entry.output) preview(entry.output, true, ctx, lines);
      provenance(ctx, entry.provenance.source, lines);
      break;
    case "diff":
      lines.head(
        bullet("success"),
        `${p.bold("Edited")} ${entry.files.length} file${entry.files.length === 1 ? "" : "s"} ${p.fg("toolDiffAdded", `+${entry.added}`)} ${p.fg("toolDiffRemoved", `-${entry.removed}`)}`,
      );
      for (const file of entry.files) {
        lines.body(
          `${sanitize(file.path)} ${p.fg("muted", file.status)} ${p.fg("toolDiffAdded", `+${file.added}`)} ${p.fg("toolDiffRemoved", `-${file.removed}`)}`,
        );
        if (!expanded) continue;
        const rows = sanitize(file.patch).split("\n");
        for (const row of rows.slice(0, LIMITS.diffLinesPerFile))
          lines.plain(
            `     ${row.startsWith("+") ? p.fg("toolDiffAdded", row) : row.startsWith("-") ? p.fg("toolDiffRemoved", row) : p.fg("toolDiffContext", row)}`,
          );
        if (rows.length > LIMITS.diffLinesPerFile)
          lines.plain(
            `     ${p.fg("dim", `… +${rows.length - LIMITS.diffLinesPerFile} lines (view only)`)}`,
          );
      }
      break;
    case "child": {
      const tier = entry.tier
        ? p.fg(
            entry.tier === "paid"
              ? "paidTier"
              : entry.tier === "local"
                ? "localTier"
                : "freeTier",
            entry.tier,
          )
        : null;
      lines.head(
        p.fg(
          entry.status === "running"
            ? "accent"
            : entry.status === "failed"
              ? "error"
              : "success",
          g.running,
        ),
        [
          p.bold(sanitize(entry.label)),
          entry.status,
          entry.tool_calls !== null ? `${entry.tool_calls} tool calls` : null,
          entry.model ? sanitize(entry.model) : null,
          tier,
        ]
          .filter(Boolean)
          .join(` ${g.dot} `),
      );
      break;
    }
    case "research":
      lines.head(
        bullet("accent"),
        `${p.bold("Research")} ${g.dot} ${entry.findings.length} finding${entry.findings.length === 1 ? "" : "s"}`,
      );
      for (const finding of entry.findings) {
        const text = `[${finding.confidence?.toFixed(2) ?? "—"}] ${sanitize(finding.claim ?? finding.finding_id)}${finding.source ? ` — ${sanitize(finding.source)}` : ""}${finding.used === null ? "" : finding.used ? " (used)" : " (not used)"}`;
        lines.body(
          finding.stale
            ? `${p.fg("staleFinding", p.strike(text))} ${p.fg("staleFinding", "(stale)")}`
            : text,
        );
        if (expanded && finding.excerpt)
          lines.plain(
            `       ${p.fg("muted", `“${sanitize(finding.excerpt)}”`)}`,
          );
      }
      provenance(ctx, entry.provenance.source, lines);
      break;
    case "evidence": {
      const pass = entry.verdict === "pass";
      const token = pass
        ? "verifyPass"
        : entry.verdict === "fail"
          ? "verifyFail"
          : "warning";
      lines.head(
        p.fg(
          token,
          pass ? g.ok : entry.verdict === "fail" ? g.fail : g.warning,
        ),
        `${p.bold(entry.evidence_kind === "verify" ? "Verify" : "Watch")} ${sanitize(entry.check)} ${p.fg(token, entry.verdict)}${entry.advisory ? p.fg("muted", " advisory") : ""}`,
      );
      if (entry.summary) lines.body(sanitize(entry.summary));
      if (entry.files.length)
        lines.plain(
          `     ${p.fg("dim", entry.files.map(sanitize).join(", "))}`,
        );
      if (expanded)
        lines.body(
          p.fg("muted", sanitize(JSON.stringify(entry.record, null, 2))),
        );
      provenance(ctx, entry.provenance.source, lines);
      break;
    }
    case "proposal": {
      const top = `${g.hr}${g.hr} ${entry.proposal_kind} proposal ${g.dot} ${entry.scope}${entry.revision ? ` ${g.dot} rev ${sanitize(entry.revision)}` : ""} `;
      lines.plain(
        p.fg(
          "border",
          `${top}${g.hr.repeat(Math.max(0, ctx.width - visibleWidth(top)))}`,
        ),
      );
      if (entry.before)
        lines.plain(
          `  ${p.fg("toolDiffRemoved", `- ${sanitize(entry.before)}`)}`,
        );
      if (entry.after)
        lines.plain(`  ${p.fg("toolDiffAdded", `+ ${sanitize(entry.after)}`)}`);
      lines.plain(
        `  ${p.fg("dim", `decision ${entry.decision ?? "pending"} · decided outside this read-only client`)}`,
      );
      provenance(ctx, entry.provenance.source, lines);
      break;
    }
    case "graph":
      lines.head(
        bullet(
          entry.status === "ready"
            ? "success"
            : entry.status === "failed"
              ? "error"
              : "warning",
        ),
        `${p.bold(entry.operation === "graph.build" ? "Graph build" : "Graph query")} ${g.dot} ${entry.status}${entry.revision ? ` ${g.dot} ${sanitize(entry.revision)}` : ""}${entry.isolation ? ` ${g.dot} ${entry.isolation}` : ""}`,
      );
      if (entry.summary) lines.body(sanitize(entry.summary));
      break;
    case "notice":
      lines.head(
        p.fg(
          entry.tone === "info" ? "dim" : entry.tone,
          entry.tone === "info" ? g.info : g.warning,
        ),
        entry.tone === "info"
          ? p.fg("muted", sanitize(entry.text))
          : sanitize(entry.text),
      );
      if (entry.detail && (expanded || entry.tone !== "info"))
        lines.body(p.fg("dim", sanitize(entry.detail)));
      break;
    case "error":
      lines.head(p.fg("error", g.fail), p.fg("error", sanitize(entry.text)));
      if (entry.detail) lines.body(sanitize(entry.detail));
      break;
    case "summary":
      lines.plain(
        p.fg(
          "dim",
          `${g.sum} ${entry.status}${entry.seconds !== null ? ` ${g.dot} ${entry.seconds}s` : ""} ${g.dot} ${compact(entry.input_tokens)} in / ${compact(entry.output_tokens)} out ${g.dot} ${money(entry.cost_usd)} ${g.dot} ${entry.tools} tools`,
        ),
      );
      break;
  }
  if (ctx.focusedId === entry.id && lines.out.length)
    lines.out[0] = `${ctx.painter.inverse(">")}${lines.out[0]?.slice(0) ?? ""}`;
  return lines.out;
}

const contextIds = new WeakMap<object, number>();
let nextContextId = 0;
const contextId = (value: object) => {
  let id = contextIds.get(value);
  if (id === undefined) {
    id = nextContextId++;
    contextIds.set(value, id);
  }
  return id;
};
const entryCache = new WeakMap<Entry, { key: string; lines: string[] }>();

/** Renders one entry, reusing the previous rows while nothing that affects them changed. */
export function renderEntryCached(entry: Entry, ctx: CardContext): string[] {
  const animated =
    (entry as { running?: boolean }).running === true ||
    (entry as { status?: string }).status === "running";
  const key = [
    ctx.width,
    contextId(ctx.painter),
    contextId(ctx.glyphs),
    ctx.expanded.has(entry.id) ? 1 : 0,
    ctx.focusedId === entry.id ? 1 : 0,
    ctx.showThinking ? 1 : 0,
    animated ? ctx.spinnerFrame : 0,
    ctx.connectorIds.join(","),
  ].join("|");
  const cached = entryCache.get(entry);
  if (cached?.key === key) return cached.lines;
  const lines = renderEntry(entry, ctx).map((line) =>
    truncateToWidth(line, ctx.width),
  );
  entryCache.set(entry, { key, lines });
  return lines;
}

export function renderTranscript(
  projection: TranscriptProjection,
  ctx: CardContext,
): string[] {
  const out: string[] = [];
  for (const entry of projection.entries) {
    if (out.length) out.push("");
    out.push(...renderEntryCached(entry, ctx));
  }
  return out;
}

/** The last `rows` transcript rows, rendering only the entries that reach the viewport. */
export function renderTranscriptTail(
  projection: TranscriptProjection,
  ctx: CardContext,
  rows: number,
): string[] {
  const blocks: string[][] = [];
  let count = 0;
  for (
    let index = projection.entries.length - 1;
    index >= 0 && count < rows;
    index--
  ) {
    const entry = projection.entries[index];
    if (!entry) continue;
    const lines = renderEntryCached(entry, ctx);
    blocks.push(index > 0 ? ["", ...lines] : lines);
    count += lines.length + (index > 0 ? 1 : 0);
  }
  const out = blocks.reverse().flat();
  if (out[0] === "" && blocks.length === projection.entries.length) out.shift();
  return out.slice(Math.max(0, out.length - rows));
}
