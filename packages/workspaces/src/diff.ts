import { compareStrings, type TreeFile } from "./tree";
import type { WorkspaceDiff, WorkspaceDiffFile } from "./types";

type Edit =
  | {
      kind: "equal";
      oldLine: string;
      newLine: string;
      oldIndex: number;
      newIndex: number;
    }
  | { kind: "delete"; oldLine: string; oldIndex: number; newIndex: number }
  | { kind: "insert"; newLine: string; oldIndex: number; newIndex: number };

interface TextLine {
  value: string;
  newline: boolean;
}

export function createWorkspaceDiff(
  baseFiles: readonly TreeFile[],
  currentFiles: readonly TreeFile[],
): WorkspaceDiff {
  const before = new Map(baseFiles.map((file) => [file.path, file]));
  const after = new Map(currentFiles.map((file) => [file.path, file]));
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort(
    compareStrings,
  );
  const files: WorkspaceDiffFile[] = [];
  for (const path of paths) {
    const oldFile = before.get(path);
    const newFile = after.get(path);
    const status = !oldFile ? "added" : !newFile ? "deleted" : "modified";
    if (
      oldFile &&
      newFile &&
      oldFile.sha256 === newFile.sha256 &&
      oldFile.mode === newFile.mode
    )
      continue;
    files.push({
      path,
      status,
      patch: makePatch(path, status, oldFile, newFile),
    });
  }
  return { files };
}

function makePatch(
  path: string,
  status: WorkspaceDiffFile["status"],
  oldFile: TreeFile | undefined,
  newFile: TreeFile | undefined,
): string {
  const out = [`diff --git a/${path} b/${path}\n`];
  if (status === "added") {
    if (!newFile) throw new Error("Added diff entry has no current file");
    out.push(`new file mode ${modeText(newFile.mode)}\n`);
  } else if (status === "deleted") {
    if (!oldFile) throw new Error("Deleted diff entry has no previous file");
    out.push(`deleted file mode ${modeText(oldFile.mode)}\n`);
  } else {
    if (!oldFile || !newFile)
      throw new Error("Modified diff entry is missing a file version");
    if (oldFile.mode !== newFile.mode) {
      out.push(
        `old mode ${modeText(oldFile.mode)}\nnew mode ${modeText(newFile.mode)}\n`,
      );
    }
  }
  const oldData = oldFile?.data ?? new Uint8Array();
  const newData = newFile?.data ?? new Uint8Array();
  if (isBinary(oldData) || isBinary(newData)) {
    const oldName = status === "added" ? "/dev/null" : `a/${path}`;
    const newName = status === "deleted" ? "/dev/null" : `b/${path}`;
    out.push(`Binary files ${oldName} and ${newName} differ\n`);
    return out.join("");
  }
  const oldText = decode(oldData);
  const newText = decode(newData);
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  out.push(`--- ${status === "added" ? "/dev/null" : `a/${path}`}\n`);
  out.push(`+++ ${status === "deleted" ? "/dev/null" : `b/${path}`}\n`);
  const edits =
    oldData.byteLength > 1024 * 1024 ||
    newData.byteLength > 1024 * 1024 ||
    oldLines.length * newLines.length > 1_000_000
      ? wholeFileEdits(oldLines, newLines)
      : lcsEdits(oldLines, newLines);
  out.push(renderHunks(edits));
  return out.join("");
}

function isBinary(data: Uint8Array): boolean {
  if (data.subarray(0, 8000).includes(0)) return true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(data);
    return false;
  } catch {
    return true;
  }
}

function decode(data: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(data);
}

function splitLines(text: string): TextLine[] {
  if (text.length === 0) return [];
  const chunks = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  return chunks.map((chunk) => ({
    value: chunk.endsWith("\n") ? chunk.slice(0, -1) : chunk,
    newline: chunk.endsWith("\n"),
  }));
}

function lcsEdits(oldLines: TextLine[], newLines: TextLine[]): Edit[] {
  const rows = oldLines.length + 1;
  const cols = newLines.length + 1;
  const table = Array.from({ length: rows }, () => new Uint32Array(cols));
  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      const oldLine = oldLines[i];
      const newLine = newLines[j];
      const currentRow = table[i];
      const nextRow = table[i + 1];
      if (!oldLine || !newLine || !currentRow || !nextRow)
        throw new Error("Diff line index is out of bounds");
      const diagonal = nextRow[j + 1];
      const nextOld = nextRow[j];
      const nextNew = currentRow[j + 1];
      if (
        diagonal === undefined ||
        nextOld === undefined ||
        nextNew === undefined
      ) {
        throw new Error("Diff score index is out of bounds");
      }
      currentRow[j] = sameLine(oldLine, newLine)
        ? diagonal + 1
        : Math.max(nextOld, nextNew);
    }
  }
  const edits: Edit[] = [];
  let i = 0;
  let j = 0;
  while (i < oldLines.length || j < newLines.length) {
    const oldLine = oldLines[i];
    const newLine = newLines[j];
    if (i < oldLines.length && j < newLines.length) {
      if (!oldLine || !newLine)
        throw new Error("Diff line index is out of bounds");
      if (sameLine(oldLine, newLine)) {
        edits.push({
          kind: "equal",
          oldLine: renderLine(oldLine),
          newLine: renderLine(newLine),
          oldIndex: i,
          newIndex: j,
        });
        i += 1;
        j += 1;
        continue;
      }
    }
    const currentRow = table[i];
    const nextRow = table[i + 1];
    const nextOldScore = nextRow?.[j];
    const nextNewScore = currentRow?.[j + 1];
    const deleteBeforeInsert =
      nextOldScore !== undefined &&
      nextNewScore !== undefined &&
      nextOldScore >= nextNewScore;
    if (i < oldLines.length && (j >= newLines.length || deleteBeforeInsert)) {
      if (!oldLine) throw new Error("Diff old line is missing");
      edits.push({
        kind: "delete",
        oldLine: renderLine(oldLine),
        oldIndex: i,
        newIndex: j,
      });
      i += 1;
    } else {
      if (!newLine) throw new Error("Diff new line is missing");
      edits.push({
        kind: "insert",
        newLine: renderLine(newLine),
        oldIndex: i,
        newIndex: j,
      });
      j += 1;
    }
  }
  return edits;
}

function wholeFileEdits(oldLines: TextLine[], newLines: TextLine[]): Edit[] {
  const edits: Edit[] = [];
  oldLines.forEach((line, index) => {
    edits.push({
      kind: "delete",
      oldLine: renderLine(line),
      oldIndex: index,
      newIndex: 0,
    });
  });
  newLines.forEach((line, index) => {
    edits.push({
      kind: "insert",
      newLine: renderLine(line),
      oldIndex: oldLines.length,
      newIndex: index,
    });
  });
  return edits;
}

function renderHunks(edits: Edit[]): string {
  const changed: number[] = [];
  edits.forEach((edit, index) => {
    if (edit.kind !== "equal") changed.push(index);
  });
  if (changed.length === 0) return "";
  const groups: Array<[number, number]> = [];
  for (const index of changed) {
    const start = Math.max(0, index - 3);
    const end = Math.min(edits.length, index + 4);
    const previous = groups.at(-1);
    if (previous && start <= previous[1])
      previous[1] = Math.max(previous[1], end);
    else groups.push([start, end]);
  }
  const output: string[] = [];
  for (const [start, end] of groups) {
    const section = edits.slice(start, end);
    const oldCount = section.filter((edit) => edit.kind !== "insert").length;
    const newCount = section.filter((edit) => edit.kind !== "delete").length;
    const oldStart =
      section.find((edit) => edit.kind !== "insert")?.oldIndex ?? 0;
    const newStart =
      section.find((edit) => edit.kind !== "delete")?.newIndex ?? 0;
    output.push(
      `@@ -${rangeStart(oldStart, oldCount)},${oldCount} +${rangeStart(newStart, newCount)},${newCount} @@\n`,
    );
    for (const edit of section) {
      const line = edit.kind === "insert" ? edit.newLine : edit.oldLine;
      const patchLine = `${edit.kind === "equal" ? " " : edit.kind === "delete" ? "-" : "+"}${line}`;
      output.push(patchLine.endsWith("\n") ? patchLine : `${patchLine}\n`);
      const lacksNewline =
        (edit.kind !== "insert" && !edit.oldLine.endsWith("\n")) ||
        (edit.kind !== "delete" && !edit.newLine.endsWith("\n"));
      if (lacksNewline) output.push("\\ No newline at end of file\n");
    }
  }
  return output.join("");
}

function rangeStart(zeroBasedStart: number, count: number): number {
  return count === 0 ? zeroBasedStart : zeroBasedStart + 1;
}

function sameLine(a: TextLine, b: TextLine): boolean {
  return a.value === b.value && a.newline === b.newline;
}

function renderLine(line: TextLine): string {
  return `${line.value}${line.newline ? "\n" : ""}`;
}

function modeText(mode: number): string {
  return mode === 493 ? "100755" : "100644";
}
