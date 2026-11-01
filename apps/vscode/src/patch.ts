export interface PatchStats {
  additions: number;
  deletions: number;
}

interface HunkLine {
  kind: " " | "+" | "-";
  text: string;
}

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: HunkLine[];
}

/** A strictly validated single-file unified diff. */
export interface ParsedPatch {
  hunks: Hunk[];
  oldNoNewline: boolean;
  newNoNewline: boolean;
}

export type PatchParse =
  | { ok: true; patch: ParsedPatch }
  | { ok: false; reason: string };

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/;
const MAX_PATCH_CHARS = 8 * 1024 * 1024;

function hasNul(text: string): boolean {
  return text.includes("\u0000");
}

function malformed(reason: string): PatchParse {
  return { ok: false, reason: `Malformed patch: ${reason}.` };
}

/**
 * Parses one file's unified diff. Header line counts must match the hunk
 * bodies exactly; binary diffs, multi-file diffs and unknown hunk lines are
 * rejected. Line text keeps any `\r`, so CRLF files round-trip.
 */
export function parsePatch(patch: string): PatchParse {
  if (patch.length > MAX_PATCH_CHARS) return malformed("too large");
  if (hasNul(patch))
    return { ok: false, reason: "Binary patch cannot be shown as text." };
  const lines = patch.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const hunks: Hunk[] = [];
  let current: Hunk | undefined;
  let oldLeft = 0;
  let newLeft = 0;
  let previous: HunkLine["kind"] | undefined;
  let oldNoNewline = false;
  let newNoNewline = false;
  for (const raw of lines) {
    const line =
      raw.endsWith("\r") && raw.startsWith("@@") ? raw.slice(0, -1) : raw;
    if (
      line.startsWith("Binary files ") ||
      line === "GIT binary patch" ||
      line.startsWith("GIT binary patch")
    )
      return { ok: false, reason: "Binary patch cannot be shown as text." };
    if (!current || (oldLeft === 0 && newLeft === 0)) {
      const header = HUNK.exec(line);
      if (header) {
        current = {
          oldStart: Number(header[1]),
          oldCount: header[2] === undefined ? 1 : Number(header[2]),
          newStart: Number(header[3]),
          newCount: header[4] === undefined ? 1 : Number(header[4]),
          lines: [],
        };
        if (current.oldCount === 0 && current.newCount === 0)
          return malformed("empty hunk");
        if (oldNoNewline || newNoNewline)
          return malformed("hunk after end-of-file marker");
        hunks.push(current);
        oldLeft = current.oldCount;
        newLeft = current.newCount;
        previous = undefined;
        continue;
      }
      if (line.startsWith("\\") && current && previous) {
        if (previous !== "+") oldNoNewline = true;
        if (previous !== "-") newNoNewline = true;
        previous = undefined;
        continue;
      }
      if (current) return malformed("content after the final hunk");
      if (line.startsWith("@@")) return malformed("invalid hunk header");
      continue;
    }
    if (line.startsWith("\\")) {
      if (!previous) return malformed("misplaced end-of-file marker");
      if (previous !== "+") oldNoNewline = true;
      if (previous !== "-") newNoNewline = true;
      previous = undefined;
      continue;
    }
    const kind = line === "" ? " " : line[0];
    if (kind !== " " && kind !== "+" && kind !== "-")
      return malformed("unknown hunk line");
    if (kind !== "+") {
      if (oldLeft === 0 || oldNoNewline)
        return malformed("hunk is longer than its header");
      oldLeft--;
    }
    if (kind !== "-") {
      if (newLeft === 0 || newNoNewline)
        return malformed("hunk is longer than its header");
      newLeft--;
    }
    current.lines.push({ kind, text: line.slice(1) });
    previous = kind;
  }
  if (hunks.length === 0) return malformed("no hunks");
  if (oldLeft !== 0 || newLeft !== 0)
    return malformed("hunk is shorter than its header");
  return { ok: true, patch: { hunks, oldNoNewline, newNoNewline } };
}

function splitText(text: string): { lines: string[]; newline: boolean } {
  if (text === "") return { lines: [], newline: false };
  const newline = text.endsWith("\n");
  return { lines: (newline ? text.slice(0, -1) : text).split("\n"), newline };
}

/**
 * Applies a parsed patch to `source` with no fuzz: every context and removed
 * line must match at the exact header position and the target-side headers
 * must agree with the resulting offsets. Returns null on any mismatch.
 * `reverse` applies the patch backwards (AFTER -> BEFORE).
 */
export function applyParsed(
  source: string,
  parsed: ParsedPatch,
  reverse = false,
): string | null {
  const drop = reverse ? "+" : "-";
  const fromNoNewline = reverse ? parsed.newNoNewline : parsed.oldNoNewline;
  const toNoNewline = reverse ? parsed.oldNoNewline : parsed.newNoNewline;
  const { lines, newline } = splitText(source);
  const output: string[] = [];
  let position = 0;
  let reachedEnd = false;
  for (const hunk of parsed.hunks) {
    const fromStart = reverse ? hunk.newStart : hunk.oldStart;
    const fromCount = reverse ? hunk.newCount : hunk.oldCount;
    const toStart = reverse ? hunk.oldStart : hunk.newStart;
    const toCount = reverse ? hunk.oldCount : hunk.newCount;
    const start = fromCount === 0 ? fromStart : fromStart - 1;
    if (start < position || start + fromCount > lines.length) return null;
    output.push(...lines.slice(position, start));
    const expectedTo = toCount === 0 ? output.length : output.length + 1;
    if (toStart !== expectedTo) return null;
    position = start;
    for (const line of hunk.lines) {
      if (line.kind === drop || line.kind === " ") {
        if (lines[position] !== line.text) return null;
        position++;
      }
      if (line.kind !== drop) output.push(line.text);
    }
    reachedEnd = position === lines.length;
  }
  output.push(...lines.slice(position));
  let endsWithNewline = newline;
  if (reachedEnd) {
    if (lines.length > 0 && newline === fromNoNewline) return null;
    endsWithNewline = !toNoNewline;
  } else if (fromNoNewline) return null;
  if (output.length === 0) return "";
  const text = output.join("\n");
  return endsWithNewline ? `${text}\n` : text;
}

function apply(source: string, patch: string, reverse: boolean): string | null {
  const parsed = parsePatch(patch);
  return parsed.ok ? applyParsed(source, parsed.patch, reverse) : null;
}

/** BEFORE -> AFTER: the task's version derived from the local baseline. */
export function applyPatch(before: string, patch: string): string | null {
  return apply(before, patch, false);
}

/** AFTER -> BEFORE: the original derived from a file that already has the change. */
export function reconstructOriginal(
  current: string,
  patch: string,
): string | null {
  return apply(current, patch, true);
}

/** Full content of an added file; only a pure-addition patch onto an empty file qualifies. */
export function addedContent(patch: string): string | null {
  return apply("", patch, false);
}

/** Full content of a deleted file; only a pure-removal patch to an empty file qualifies. */
export function removedText(patch: string): string | null {
  return apply("", patch, true);
}

export function patchStats(patch: string): PatchStats {
  let additions = 0;
  let deletions = 0;
  let inHunk = false;
  for (const line of patch.split(/\r?\n/)) {
    if (HUNK.test(line)) inHunk = true;
    else if (!inHunk) continue;
    else if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions };
}
