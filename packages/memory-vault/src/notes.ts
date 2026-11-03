import { createHash } from "node:crypto";
import { emitYaml, parseYaml, type YamlValue } from "./yaml";

export const BODY_MARKER = "<!-- mars:body -->";
export const RELATED_MARKER = "<!-- mars:related -->";

export const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

export interface NoteSource {
  frontmatter: { [key: string]: YamlValue };
  body: string;
  related: readonly string[];
}

/**
 * Note layout (LF newlines):
 *
 *     ---
 *     <MARS frontmatter>
 *     ---
 *     <!-- mars:body -->
 *     <body, verbatim>
 *     <!-- mars:related -->
 *     ## Related
 *     - [[wikilink]]
 *
 * The body is copied verbatim between the two markers, so a skill's own
 * frontmatter round-trips exactly; `content_digest` is the SHA-256 of it.
 */
export function renderNote(note: NoteSource): string {
  const parts = [
    "---\n",
    emitYaml(note.frontmatter),
    "---\n",
    `${BODY_MARKER}\n`,
    note.body,
    "\n",
  ];
  if (note.related.length > 0)
    parts.push(
      `${RELATED_MARKER}\n## Related\n`,
      note.related.map((link) => `- ${link}\n`).join(""),
    );
  return parts.join("");
}

export interface ParsedNote {
  frontmatter: { [key: string]: YamlValue };
  body: string;
}

export class NoteParseError extends Error {
  constructor(
    readonly code: "no_frontmatter" | "invalid_frontmatter" | "no_body",
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "NoteParseError";
  }
}

/**
 * Inverse of `renderNote`. CRLF is normalised to LF first (editors may
 * rewrite line endings). If the related marker was removed, the body runs to
 * the end of the file minus one trailing newline; if the body marker was
 * removed, the body starts right after the frontmatter.
 */
export function parseNote(text: string): ParsedNote {
  const source = text.replaceAll("\r\n", "\n");
  if (!source.startsWith("---\n")) throw new NoteParseError("no_frontmatter");
  const end = source.indexOf("\n---\n", 4);
  if (end < 0) throw new NoteParseError("no_frontmatter");
  let frontmatter: { [key: string]: YamlValue };
  try {
    frontmatter = parseYaml(source.slice(4, end + 1));
  } catch (error) {
    throw new NoteParseError(
      "invalid_frontmatter",
      error instanceof Error ? error.message : undefined,
    );
  }
  let rest = source.slice(end + 5);
  if (rest.startsWith(`${BODY_MARKER}\n`))
    rest = rest.slice(BODY_MARKER.length + 1);
  else if (rest === BODY_MARKER) rest = "";
  const related = rest.indexOf(`\n${RELATED_MARKER}`);
  let body: string;
  if (related >= 0) body = rest.slice(0, related);
  else if (rest.startsWith(RELATED_MARKER)) body = "";
  else body = rest.endsWith("\n") ? rest.slice(0, -1) : rest;
  return { frontmatter, body };
}

/** `[[target]]` or `[[target|alias]]` with characters Obsidian cannot nest removed from the alias. */
export function wikilink(target: string, alias?: string): string {
  if (alias === undefined) return `[[${target}]]`;
  const clean = alias
    .replace(/[[\]|\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const short =
    [...clean].length > 80 ? `${[...clean].slice(0, 79).join("")}…` : clean;
  return short.length === 0 || short === target
    ? `[[${target}]]`
    : `[[${target}|${short}]]`;
}
