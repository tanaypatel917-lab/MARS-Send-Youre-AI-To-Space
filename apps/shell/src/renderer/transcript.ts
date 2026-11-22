import type { Entry, ToolEntry, TranscriptProjection } from "@mars/ui-core";
import { disclosure, h, type ShellDocument, type ShellElement } from "./dom";
import { untrusted } from "./untrusted";

function provenanceLabel(source: string, eventId: string | null): string {
  return eventId ? `${source} · ${eventId}` : source;
}

function renderToolEntry(doc: ShellDocument, entry: ToolEntry): ShellElement {
  const header = entry.primary
    ? `${entry.name} (${entry.primary}) · ${entry.status}`
    : `${entry.name} · ${entry.status}`;
  return h(
    doc,
    "article",
    { class: `transcript-entry transcript-tool tool-${entry.status}` },
    h(
      doc,
      "div",
      { class: "entry-header" },
      h(doc, "strong", {}, header),
      h(doc, "span", { class: "entry-badge" }, entry.status),
    ),
    entry.output
      ? disclosure(
          doc,
          "entry-details",
          `tool:${entry.id}`,
          "Tool output",
          untrusted(
            doc,
            entry.output,
            provenanceLabel(entry.provenance.source, entry.provenance.event_id),
          ),
        )
      : null,
  );
}

function renderEntry(doc: ShellDocument, entry: Entry): ShellElement {
  switch (entry.kind) {
    case "earlier":
      return h(
        doc,
        "p",
        { class: "transcript-earlier muted" },
        `${entry.count} earlier transcript entr${entry.count === 1 ? "y" : "ies"} omitted.`,
      );
    case "user":
      return h(
        doc,
        "article",
        { class: `transcript-entry transcript-user user-${entry.source}` },
        h(
          doc,
          "div",
          { class: "entry-header" },
          h(
            doc,
            "strong",
            {},
            entry.source === "steer" ? "Steer instruction" : "Task request",
          ),
        ),
        untrusted(
          doc,
          entry.text,
          provenanceLabel(entry.provenance.source, entry.provenance.event_id),
        ),
      );
    case "turn":
      return h(
        doc,
        "article",
        { class: "transcript-entry transcript-turn" },
        h(
          doc,
          "div",
          { class: "entry-header" },
          h(
            doc,
            "strong",
            {},
            entry.running ? "Turn in progress" : "Turn observed",
          ),
          h(doc, "span", { class: "muted" }, entry.observed),
        ),
        entry.summary
          ? untrusted(
              doc,
              entry.summary,
              provenanceLabel(
                entry.provenance.source,
                entry.provenance.event_id,
              ),
            )
          : null,
      );
    case "assistant":
      return h(
        doc,
        "article",
        { class: "transcript-entry transcript-assistant" },
        h(doc, "div", { class: "entry-header" }, h(doc, "strong", {}, "Agent")),
        untrusted(
          doc,
          entry.text,
          provenanceLabel(entry.provenance.source, entry.provenance.event_id),
        ),
      );
    case "thinking":
      return h(
        doc,
        "article",
        { class: "transcript-entry transcript-thinking" },
        disclosure(
          doc,
          "entry-details",
          `thinking:${entry.id}`,
          entry.tokens !== null
            ? `Reasoning (${entry.tokens} tokens)`
            : "Reasoning",
          untrusted(
            doc,
            entry.text,
            provenanceLabel(entry.provenance.source, entry.provenance.event_id),
          ),
        ),
      );
    case "tool":
      return renderToolEntry(doc, entry);
    case "explored": {
      const summaryText = entry.counts
        .map((item) => `${item.verb} ×${item.count}`)
        .join(" · ");
      return h(
        doc,
        "article",
        { class: "transcript-entry transcript-explored" },
        disclosure(
          doc,
          "entry-details",
          `explored:${entry.id}`,
          `Explored · ${summaryText}`,
          ...entry.tools.map((tool) => renderToolEntry(doc, tool)),
        ),
      );
    }
    case "hook":
      return h(
        doc,
        "article",
        { class: "transcript-entry transcript-hook" },
        h(
          doc,
          "div",
          { class: "entry-header" },
          h(
            doc,
            "strong",
            {},
            `Hook ${entry.phase} · ${entry.blocked ? "blocked" : `exit ${entry.exit_code ?? "?"}`}`,
          ),
        ),
        untrusted(
          doc,
          entry.command,
          provenanceLabel(entry.provenance.source, entry.provenance.event_id),
        ),
        entry.reason ? h(doc, "p", { class: "muted" }, entry.reason) : null,
        entry.output
          ? disclosure(
              doc,
              "entry-details",
              `hook:${entry.id}`,
              "Hook output",
              untrusted(
                doc,
                entry.output,
                provenanceLabel(
                  entry.provenance.source,
                  entry.provenance.event_id,
                ),
              ),
            )
          : null,
      );
    case "diff":
      return h(
        doc,
        "article",
        { class: "transcript-entry transcript-diff" },
        h(
          doc,
          "div",
          { class: "entry-header" },
          h(
            doc,
            "strong",
            {},
            `Workspace diff · ${entry.files.length} file${entry.files.length === 1 ? "" : "s"} (+${entry.added} −${entry.removed})`,
          ),
        ),
        ...entry.files.map((file) =>
          disclosure(
            doc,
            "entry-details",
            JSON.stringify(["diff", entry.id, file.path]),
            `${file.status} · ${file.path} (+${file.added} −${file.removed})`,
            untrusted(doc, file.patch, "workspace diff"),
          ),
        ),
      );
    case "child":
      return h(
        doc,
        "article",
        { class: "transcript-entry transcript-child" },
        h(
          doc,
          "div",
          { class: "entry-header" },
          h(doc, "strong", {}, `Subagent · ${entry.status}`),
          entry.model || entry.tier
            ? h(
                doc,
                "span",
                { class: "muted" },
                [entry.model, entry.tier].filter(Boolean).join(" · "),
              )
            : null,
        ),
        untrusted(
          doc,
          entry.label,
          provenanceLabel(entry.provenance.source, entry.provenance.event_id),
        ),
      );
    case "research":
      return h(
        doc,
        "article",
        { class: "transcript-entry transcript-research" },
        h(
          doc,
          "div",
          { class: "entry-header" },
          h(
            doc,
            "strong",
            {},
            `Research · ${entry.findings.length} finding${entry.findings.length === 1 ? "" : "s"}`,
          ),
        ),
        ...entry.findings.map((finding) =>
          h(
            doc,
            "div",
            { class: "research-finding" },
            h(
              doc,
              "p",
              { class: "muted" },
              `${finding.finding_id}${finding.stale ? " · stale" : ""}${finding.confidence !== null ? ` · confidence ${finding.confidence}` : ""}`,
            ),
            finding.claim
              ? untrusted(
                  doc,
                  finding.claim,
                  provenanceLabel(
                    entry.provenance.source,
                    entry.provenance.event_id,
                  ),
                )
              : null,
          ),
        ),
      );
    case "evidence":
      return h(
        doc,
        "article",
        { class: "transcript-entry transcript-evidence" },
        h(
          doc,
          "div",
          { class: "entry-header" },
          h(
            doc,
            "strong",
            {},
            `Verification · ${entry.check} (${entry.verdict})`,
          ),
          h(
            doc,
            "span",
            {
              class: `entry-badge ${entry.verified ? "badge-verified" : "badge-unverified"}`,
            },
            entry.verified ? "verified" : "unverified",
          ),
        ),
        entry.summary
          ? untrusted(
              doc,
              entry.summary,
              provenanceLabel(
                entry.provenance.source,
                entry.provenance.event_id,
              ),
            )
          : null,
      );
    case "proposal":
      return h(
        doc,
        "article",
        { class: "transcript-entry transcript-proposal" },
        h(
          doc,
          "div",
          { class: "entry-header" },
          h(
            doc,
            "strong",
            {},
            `Proposal · ${entry.proposal_kind} (${entry.scope})${entry.decision ? ` · ${entry.decision}` : ""}`,
          ),
        ),
        entry.after
          ? untrusted(
              doc,
              entry.after,
              provenanceLabel(
                entry.provenance.source,
                entry.provenance.event_id,
              ),
            )
          : null,
      );
    case "graph":
      return h(
        doc,
        "article",
        { class: "transcript-entry transcript-graph" },
        h(
          doc,
          "div",
          { class: "entry-header" },
          h(doc, "strong", {}, `${entry.operation} · ${entry.status}`),
        ),
        entry.summary
          ? untrusted(
              doc,
              entry.summary,
              provenanceLabel(
                entry.provenance.source,
                entry.provenance.event_id,
              ),
            )
          : null,
      );
    case "notice":
      return h(
        doc,
        "article",
        { class: `transcript-entry transcript-notice notice-${entry.tone}` },
        h(doc, "p", {}, entry.text),
        entry.detail ? h(doc, "small", { class: "muted" }, entry.detail) : null,
      );
    case "error":
      return h(
        doc,
        "article",
        { class: "transcript-entry transcript-error", role: "alert" },
        h(doc, "strong", { class: "error" }, `${entry.code}: ${entry.text}`),
        entry.detail ? h(doc, "p", { class: "muted" }, entry.detail) : null,
      );
    case "summary":
      return h(
        doc,
        "article",
        { class: "transcript-entry transcript-summary" },
        h(
          doc,
          "p",
          {},
          `Summary · ${entry.status}${entry.seconds !== null ? ` · ${entry.seconds}s` : ""} · ${entry.input_tokens} in / ${entry.output_tokens} out tokens`,
        ),
      );
  }
}

function formatUsd(value: number): string {
  return `$${value.toFixed(Math.abs(value) < 1 ? 4 : 2)}`;
}

export function renderUsageTotals(
  doc: ShellDocument,
  totals: TranscriptProjection["totals"],
): ShellElement | null {
  if (
    totals.input_tokens === 0 &&
    totals.output_tokens === 0 &&
    totals.cost_usd === null
  )
    return null;
  const parts = [
    `Transcript usage · ${totals.input_tokens} in / ${totals.output_tokens} out tokens`,
  ];
  if (totals.cost_usd !== null) parts.push(formatUsd(totals.cost_usd));
  return h(
    doc,
    "p",
    { class: "muted transcript-totals", "data-transcript-totals": "true" },
    parts.join(" · "),
  );
}

export function renderTranscript(
  doc: ShellDocument,
  projection: TranscriptProjection | undefined,
  eventCount: number,
  eventsCapped = false,
): ShellElement[] {
  const visible = projection?.entries.length ?? 0;
  const countLabel = `${visible} transcript ${visible === 1 ? "entry" : "entries"} · ${eventCount}${eventsCapped ? "+" : ""} task event${eventCount === 1 && !eventsCapped ? "" : "s"} recorded`;
  if (!projection || projection.entries.length === 0) {
    return [
      h(
        doc,
        "p",
        { class: "muted transcript-meta" },
        eventCount > 0 ? countLabel : "No transcript entries yet.",
      ),
    ];
  }
  const totals = renderUsageTotals(doc, projection.totals);
  const nodes: ShellElement[] = [
    h(doc, "p", { class: "muted transcript-meta" }, countLabel),
    ...(totals ? [totals] : []),
    ...projection.entries.map((entry) => renderEntry(doc, entry)),
  ];
  if (projection.trimmed > 0) {
    nodes.unshift(
      h(
        doc,
        "p",
        { class: "muted" },
        `${projection.trimmed} older entries trimmed.`,
      ),
    );
  }
  return nodes;
}
