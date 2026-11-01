export interface PatchStats {
  additions: number;
  deletions: number;
}

interface Hunk {
  newStart: number;
  newCount: number;
  lines: string[];
}

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

function parseHunks(patch: string): Hunk[] | null {
  const hunks: Hunk[] = [];
  let current: Hunk | undefined;
  const lines = patch.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    const header = HUNK.exec(line);
    if (header) {
      current = {
        newStart: Number(header[1]),
        newCount: header[2] === undefined ? 1 : Number(header[2]),
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("\\")) continue;
    const kind = line[0];
    if (kind === " " || kind === "+" || kind === "-") current.lines.push(line);
    else if (line === "") current.lines.push(" ");
    else return null;
  }
  return hunks;
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

/**
 * Reconstructs the pre-change text by reverse-applying a unified diff to the
 * current text. Returns null if the current text no longer matches the patch
 * (for example the user edited the file afterwards).
 */
export function reconstructOriginal(
  current: string,
  patch: string,
): string | null {
  const hunks = parseHunks(patch);
  if (!hunks || hunks.length === 0) return null;
  const trailingNewline = current.endsWith("\n");
  const lines = current.split(/\r?\n/);
  if (trailingNewline) lines.pop();
  const output: string[] = [];
  let position = 0;
  for (const hunk of hunks) {
    const start = hunk.newCount === 0 ? hunk.newStart : hunk.newStart - 1;
    if (start < position || start > lines.length) return null;
    output.push(...lines.slice(position, start));
    position = start;
    for (const line of hunk.lines) {
      const text = line.slice(1);
      if (line[0] === "-") {
        output.push(text);
        continue;
      }
      if (lines[position] !== text) return null;
      if (line[0] === " ") output.push(text);
      position++;
    }
  }
  output.push(...lines.slice(position));
  const text = output.join("\n");
  return trailingNewline && output.length > 0 ? `${text}\n` : text;
}

/** Text of a deleted file, taken from the patch's removed lines. */
export function removedText(patch: string): string | null {
  const hunks = parseHunks(patch);
  if (!hunks) return null;
  const lines = hunks.flatMap((hunk) =>
    hunk.lines.filter((line) => line[0] === "-").map((line) => line.slice(1)),
  );
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}
