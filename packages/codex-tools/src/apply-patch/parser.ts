// Portions derived from openai/codex (https://github.com/openai/codex), files
// codex-rs/apply-patch/src/parser.rs and codex-rs/apply-patch/src/streaming_parser.rs
// at revision f58acd6ede312266a7a0eaa63fd8dadacb4de239.
// Copyright 2025 OpenAI. Licensed under the Apache License, Version 2.0; see
// packages/codex-tools/third_party/codex/LICENSE.txt. Modified by MARS (TypeScript port).

import type { ParsedPatch, PatchHunk, UpdateFileChunk } from "../types";

export const BEGIN_PATCH_MARKER = "*** Begin Patch";
export const END_PATCH_MARKER = "*** End Patch";
export const ADD_FILE_MARKER = "*** Add File: ";
export const DELETE_FILE_MARKER = "*** Delete File: ";
export const UPDATE_FILE_MARKER = "*** Update File: ";
export const MOVE_TO_MARKER = "*** Move to: ";
export const EOF_MARKER = "*** End of File";
export const CHANGE_CONTEXT_MARKER = "@@ ";
export const EMPTY_CHANGE_CONTEXT_MARKER = "@@";
const ENVIRONMENT_ID_MARKER = "*** Environment ID:";

/** MARS bound: a patch larger than this is rejected before parsing. */
export const MAX_PATCH_BYTES = 1024 * 1024;
/** MARS bound: a patch with more hunks than this is rejected while parsing. */
export const MAX_HUNKS = 4096;

export type ParseMode = "strict" | "lenient";

/**
 * `kind: "patch"` mirrors upstream `InvalidPatchError`, `kind: "hunk"` mirrors
 * `InvalidHunkError`; `message` carries the same rendering as upstream Display.
 */
export class PatchParseError extends Error {
  readonly kind: "patch" | "hunk";
  readonly detail: string;
  readonly line_number: number | null;

  constructor(
    kind: "patch" | "hunk",
    detail: string,
    lineNumber: number | null,
  ) {
    super(
      kind === "hunk"
        ? `Invalid patch hunk on line ${lineNumber ?? 0}: ${detail}`
        : `Invalid patch: ${detail}`,
    );
    this.name = "PatchParseError";
    this.kind = kind;
    this.detail = detail;
    this.line_number = lineNumber;
  }
}

function invalidPatch(detail: string): PatchParseError {
  return new PatchParseError("patch", detail, null);
}

function invalidHunk(detail: string, lineNumber: number): PatchParseError {
  return new PatchParseError("hunk", detail, lineNumber);
}

function notAHunkHeader(trimmed: string, lineNumber: number): PatchParseError {
  return invalidHunk(
    `'${trimmed}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`,
    lineNumber,
  );
}

function unexpectedUpdateLine(
  line: string,
  lineNumber: number,
): PatchParseError {
  return invalidHunk(
    `Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
    lineNumber,
  );
}

function stripPrefix(text: string, prefix: string): string | null {
  return text.startsWith(prefix) ? text.slice(prefix.length) : null;
}

function emptyChunk(changeContext: string | null = null): UpdateFileChunk {
  return {
    change_context: changeContext,
    old_lines: [],
    new_lines: [],
    context_line_indices: [],
    is_end_of_file: false,
  };
}

function pushContextLine(chunk: UpdateFileChunk, line: string): void {
  chunk.context_line_indices.push([
    chunk.old_lines.length,
    chunk.new_lines.length,
  ]);
  chunk.old_lines.push(line);
  chunk.new_lines.push(line);
}

function chunkIsEmpty(chunk: UpdateFileChunk | undefined): boolean {
  return (
    chunk !== undefined &&
    chunk.old_lines.length === 0 &&
    chunk.new_lines.length === 0
  );
}

type Mode =
  | { kind: "not-started" }
  | { kind: "started" }
  | { kind: "add" }
  | { kind: "delete" }
  | { kind: "update"; hunk_line_number: number }
  | { kind: "ended" };

/**
 * Incremental parser: feed text with `pushDelta` (whole lines are processed as
 * they complete) and call `finish` once the patch is complete.
 */
export class StreamingPatchParser {
  private mode: Mode = { kind: "not-started" };
  private readonly hunks: PatchHunk[] = [];
  private environmentId: string | null = null;
  private lineBuffer = "";
  private lineNumber = 0;

  environment_id(): string | null {
    return this.environmentId;
  }

  pushDelta(delta: string): PatchHunk[] {
    let rest = delta;
    for (;;) {
      const newline = rest.indexOf("\n");
      if (newline < 0) {
        this.lineBuffer += rest;
        break;
      }
      let line = this.lineBuffer + rest.slice(0, newline);
      this.lineBuffer = "";
      rest = rest.slice(newline + 1);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      this.lineNumber += 1;
      this.processLine(line);
    }
    return this.snapshot();
  }

  finish(): PatchHunk[] {
    if (this.lineBuffer.length > 0) {
      const line = this.lineBuffer;
      this.lineBuffer = "";
      this.lineNumber += 1;
      if (line.trim() === END_PATCH_MARKER) {
        this.ensureUpdateHunkIsNotEmpty(line.trim());
        this.mode = { kind: "ended" };
      } else {
        this.processLine(line);
      }
    }
    if (this.mode.kind !== "ended") {
      throw invalidPatch("The last line of the patch must be '*** End Patch'");
    }
    return this.snapshot();
  }

  private snapshot(): PatchHunk[] {
    return structuredClone(this.hunks);
  }

  private lastUpdate(): Extract<PatchHunk, { kind: "update" }> | null {
    const last = this.hunks[this.hunks.length - 1];
    return last?.kind === "update" ? last : null;
  }

  private pushHunk(hunk: PatchHunk): void {
    if (this.hunks.length >= MAX_HUNKS) {
      throw invalidPatch(`The patch has more than ${MAX_HUNKS} hunks`);
    }
    this.hunks.push(hunk);
  }

  private ensureUpdateHunkIsNotEmpty(line: string): void {
    const update = this.lastUpdate();
    if (!update) {
      return;
    }
    if (update.chunks.length === 0 && this.mode.kind === "update") {
      throw invalidHunk(
        `Update file hunk for path '${update.path}' is empty`,
        this.mode.hunk_line_number,
      );
    }
    if (chunkIsEmpty(update.chunks[update.chunks.length - 1])) {
      if (line === END_PATCH_MARKER) {
        throw invalidHunk(
          "Update hunk does not contain any lines",
          this.lineNumber,
        );
      }
      throw unexpectedUpdateLine(line, this.lineNumber);
    }
  }

  private handleHunkHeadersAndEndPatch(trimmed: string): boolean {
    if (this.mode.kind === "started") {
      const environmentId = stripPrefix(trimmed, ENVIRONMENT_ID_MARKER);
      if (environmentId !== null) {
        if (this.environmentId !== null) {
          throw invalidPatch(
            "apply_patch environment_id cannot be specified more than once",
          );
        }
        const id = environmentId.trim();
        if (id.length === 0) {
          throw invalidPatch("apply_patch environment_id cannot be empty");
        }
        this.environmentId = id;
        return true;
      }
    }
    if (trimmed === END_PATCH_MARKER) {
      this.ensureUpdateHunkIsNotEmpty(trimmed);
      this.mode = { kind: "ended" };
      return true;
    }
    const addPath = stripPrefix(trimmed, ADD_FILE_MARKER);
    if (addPath !== null) {
      this.ensureUpdateHunkIsNotEmpty(trimmed);
      this.pushHunk({ kind: "add", path: addPath, contents: "" });
      this.mode = { kind: "add" };
      return true;
    }
    const deletePath = stripPrefix(trimmed, DELETE_FILE_MARKER);
    if (deletePath !== null) {
      this.ensureUpdateHunkIsNotEmpty(trimmed);
      this.pushHunk({ kind: "delete", path: deletePath });
      this.mode = { kind: "delete" };
      return true;
    }
    const updatePath = stripPrefix(trimmed, UPDATE_FILE_MARKER);
    if (updatePath !== null) {
      this.ensureUpdateHunkIsNotEmpty(trimmed);
      this.pushHunk({
        kind: "update",
        path: updatePath,
        move_path: null,
        chunks: [],
      });
      this.mode = { kind: "update", hunk_line_number: this.lineNumber };
      return true;
    }
    return false;
  }

  private processLine(line: string): void {
    const trimmed = line.trim();
    const mode = this.mode;
    switch (mode.kind) {
      case "not-started":
        if (trimmed === BEGIN_PATCH_MARKER) {
          this.mode = { kind: "started" };
          return;
        }
        throw invalidPatch(
          "The first line of the patch must be '*** Begin Patch'",
        );
      case "started":
        if (this.handleHunkHeadersAndEndPatch(trimmed)) {
          return;
        }
        throw notAHunkHeader(trimmed, this.lineNumber);
      case "add": {
        if (this.handleHunkHeadersAndEndPatch(trimmed)) {
          return;
        }
        const last = this.hunks[this.hunks.length - 1];
        if (line.startsWith("+") && last?.kind === "add") {
          last.contents += `${line.slice(1)}\n`;
          return;
        }
        throw notAHunkHeader(trimmed, this.lineNumber);
      }
      case "delete":
        if (this.handleHunkHeadersAndEndPatch(trimmed)) {
          return;
        }
        throw notAHunkHeader(trimmed, this.lineNumber);
      case "update":
        this.processUpdateLine(line, mode.hunk_line_number);
        return;
      case "ended":
        if (trimmed.length === 0) {
          return;
        }
        throw invalidPatch(
          "The last line of the patch must be '*** End Patch'",
        );
      default: {
        const exhaustive: never = mode;
        throw new Error(`unreachable parser mode ${String(exhaustive)}`);
      }
    }
  }

  private processUpdateLine(line: string, hunkLineNumber: number): void {
    const updateLine = line.trimEnd();
    if (this.handleHunkHeadersAndEndPatch(updateLine)) {
      return;
    }
    const update = this.lastUpdate();
    if (update) {
      const chunks = update.chunks;
      const last = chunks[chunks.length - 1];
      if (last?.is_end_of_file) {
        if (updateLine.length === 0) {
          return;
        }
        if (
          updateLine !== EMPTY_CHANGE_CONTEXT_MARKER &&
          !updateLine.startsWith(CHANGE_CONTEXT_MARKER)
        ) {
          throw invalidHunk(
            `Expected update hunk to start with a @@ context marker, got: '${line}'`,
            this.lineNumber,
          );
        }
      }
      if (chunks.length === 0 && update.move_path === null) {
        const moveTo = stripPrefix(updateLine, MOVE_TO_MARKER);
        if (moveTo !== null) {
          update.move_path = moveTo;
          this.mode = { kind: "update", hunk_line_number: hunkLineNumber };
          return;
        }
      }
      const isContextMarker =
        updateLine === EMPTY_CHANGE_CONTEXT_MARKER ||
        updateLine.startsWith(CHANGE_CONTEXT_MARKER);
      if (isContextMarker && chunkIsEmpty(last)) {
        throw unexpectedUpdateLine(line, this.lineNumber);
      }
      if (updateLine === EMPTY_CHANGE_CONTEXT_MARKER) {
        chunks.push(emptyChunk());
        return;
      }
      const changeContext = stripPrefix(updateLine, CHANGE_CONTEXT_MARKER);
      if (changeContext !== null) {
        chunks.push(emptyChunk(changeContext));
        return;
      }
      if (updateLine === EOF_MARKER) {
        if (chunkIsEmpty(last)) {
          throw invalidHunk(
            "Update hunk does not contain any lines",
            this.lineNumber,
          );
        }
        if (last) {
          last.is_end_of_file = true;
        }
        return;
      }
      const target = (): UpdateFileChunk => {
        if (chunks.length === 0) {
          chunks.push(emptyChunk());
        }
        return chunks[chunks.length - 1] ?? emptyChunk();
      };
      if (line.length === 0) {
        pushContextLine(target(), "");
        return;
      }
      if (line.startsWith(" ")) {
        pushContextLine(target(), line.slice(1));
        return;
      }
      if (line.startsWith("+")) {
        target().new_lines.push(line.slice(1));
        return;
      }
      if (line.startsWith("-")) {
        target().old_lines.push(line.slice(1));
        return;
      }
      if (last && !chunkIsEmpty(last)) {
        throw invalidHunk(
          `Expected update hunk to start with a @@ context marker, got: '${line}'`,
          this.lineNumber,
        );
      }
    }
    throw unexpectedUpdateLine(line, this.lineNumber);
  }
}

function splitLines(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return [];
  }
  return trimmed
    .split("\n")
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

function checkStartAndEndLinesStrict(
  first: string | undefined,
  last: string | undefined,
): void {
  const firstTrimmed = first?.trim();
  const lastTrimmed = last?.trim();
  if (firstTrimmed === BEGIN_PATCH_MARKER && lastTrimmed === END_PATCH_MARKER) {
    return;
  }
  if (firstTrimmed !== undefined && firstTrimmed !== BEGIN_PATCH_MARKER) {
    throw invalidPatch("The first line of the patch must be '*** Begin Patch'");
  }
  throw invalidPatch("The last line of the patch must be '*** End Patch'");
}

function checkPatchBoundariesStrict(lines: string[]): string[] {
  checkStartAndEndLinesStrict(lines[0], lines[lines.length - 1]);
  return lines;
}

const HEREDOC_OPENERS = new Set(["<<EOF", "<<'EOF'", '<<"EOF"']);

function checkPatchBoundariesLenient(lines: string[]): string[] {
  try {
    return checkPatchBoundariesStrict(lines);
  } catch (error) {
    const first = lines[0];
    const last = lines[lines.length - 1];
    if (
      lines.length >= 4 &&
      first !== undefined &&
      last !== undefined &&
      HEREDOC_OPENERS.has(first) &&
      last.endsWith("EOF")
    ) {
      return checkPatchBoundariesStrict(lines.slice(1, -1));
    }
    throw error;
  }
}

/**
 * Parses a complete apply_patch body. Lenient mode (the default, as upstream
 * uses for every model) additionally unwraps a `<<EOF` … `EOF` heredoc.
 * Throws `PatchParseError`.
 */
export function parsePatch(
  patch: string,
  mode: ParseMode = "lenient",
): ParsedPatch {
  const bytes = Buffer.byteLength(patch, "utf8");
  if (bytes > MAX_PATCH_BYTES) {
    throw invalidPatch(
      `The patch is ${bytes} bytes; the limit is ${MAX_PATCH_BYTES} bytes`,
    );
  }
  const lines = splitLines(patch);
  const patchLines =
    mode === "strict"
      ? checkPatchBoundariesStrict(lines)
      : checkPatchBoundariesLenient(lines);
  const body = patchLines.join("\n");
  const parser = new StreamingPatchParser();
  parser.pushDelta(body);
  const hunks = parser.finish();
  return { hunks, patch: body, environment_id: parser.environment_id() };
}
