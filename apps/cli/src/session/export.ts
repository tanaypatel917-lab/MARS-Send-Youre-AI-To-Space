import {
  createPainter,
  glyphs,
  type TranscriptProjection,
} from "@mars/ui-core";
import { renderEntry } from "./cards";

/** `/export`: the projection as Markdown. Every entry is quoted as text; nothing is executed or linked. */
export function exportMarkdown(
  projection: TranscriptProjection,
  title: string,
): string {
  const ctx = {
    width: 100,
    painter: createPainter("mars-dark", "none"),
    glyphs: glyphs("unicode"),
    expanded: new Set(projection.entries.map((entry) => entry.id)),
    showThinking: true,
    focusedId: null,
    connectorIds: [],
    spinnerFrame: 0,
  };
  const parts = [
    `# MARS session · ${title}`,
    "",
    "Exported from the read-only `mars session` projection. Model output is untrusted text.",
    "",
  ];
  for (const entry of projection.entries) {
    const body = renderEntry(entry, ctx).join("\n").replaceAll("```", "ʼʼʼ");
    parts.push(
      `<!-- ${entry.kind} ${entry.id.replace(/--/g, "-")} -->`,
      "```text",
      body,
      "```",
      "",
    );
  }
  return parts.join("\n");
}
