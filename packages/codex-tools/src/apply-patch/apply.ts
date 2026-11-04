// Portions derived from openai/codex (https://github.com/openai/codex), file
// codex-rs/apply-patch/src/lib.rs at revision f58acd6ede312266a7a0eaa63fd8dadacb4de239.
// Copyright 2025 OpenAI. Licensed under the Apache License, Version 2.0; see
// packages/codex-tools/third_party/codex/LICENSE.txt. Modified by MARS (TypeScript port:
// filesystem-agnostic, relative-path-only, bounded).

import type {
  AppliedPaths,
  ApplyPatchResult,
  PatchFileSystem,
  PatchHunk,
} from "../types";
import { deriveNewContents } from "./file-update";
import { type ParseMode, PatchParseError, parsePatch } from "./parser";

/** MARS bound on a hunk path, in UTF-8 bytes. */
export const MAX_PATCH_PATH_BYTES = 1024;

/**
 * MARS path policy for hunk paths: relative, forward slashes only, no `.`/`..`
 * or empty segments, no control characters, at most 1024 bytes. Upstream
 * accepts absolute paths; MARS does not, and the workspace provider validates
 * again before touching disk. Returns a reason or `null` when valid.
 */
export function validatePatchPath(path: string): string | null {
  if (path.length === 0) {
    return "path is empty";
  }
  if (Buffer.byteLength(path, "utf8") > MAX_PATCH_PATH_BYTES) {
    return `path exceeds ${MAX_PATCH_PATH_BYTES} bytes`;
  }
  if (path.startsWith("/")) {
    return "path must be relative";
  }
  if (path.includes("\\")) {
    return "path must use forward slashes";
  }
  if (/^[a-zA-Z]:/.test(path)) {
    return "path must be relative";
  }
  for (const ch of path) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      return "path contains a control character";
    }
  }
  for (const segment of path.split("/")) {
    if (segment.length === 0) {
      return "path contains an empty segment";
    }
    if (segment === "." || segment === "..") {
      return `path contains a '${segment}' segment`;
    }
  }
  return null;
}

class HunkError extends Error {}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hunkPath(hunk: PatchHunk): string {
  return hunk.kind === "update" && hunk.move_path !== null
    ? hunk.move_path
    : hunk.path;
}

function hunkPaths(hunk: PatchHunk): string[] {
  return hunk.kind === "update" && hunk.move_path !== null
    ? [hunk.path, hunk.move_path]
    : [hunk.path];
}

async function applyHunk(hunk: PatchHunk, fs: PatchFileSystem): Promise<void> {
  switch (hunk.kind) {
    case "add":
      try {
        await fs.write(hunk.path, hunk.contents);
      } catch (error) {
        throw new HunkError(
          `Failed to write file ${hunk.path}: ${describe(error)}`,
        );
      }
      return;
    case "delete": {
      const existing = await fs.exists(hunk.path);
      if (existing !== "file") {
        throw new HunkError(`Failed to delete file ${hunk.path}`);
      }
      try {
        await fs.remove(hunk.path);
      } catch (error) {
        throw new HunkError(
          `Failed to delete file ${hunk.path}: ${describe(error)}`,
        );
      }
      return;
    }
    case "update": {
      let original: string | null;
      try {
        original = await fs.read(hunk.path);
      } catch (error) {
        throw new HunkError(
          `Failed to read file to update ${hunk.path}: ${describe(error)}`,
        );
      }
      if (original === null) {
        throw new HunkError(`Failed to read file to update ${hunk.path}`);
      }
      let contents: string;
      try {
        contents = deriveNewContents(original, hunk.path, hunk.chunks);
      } catch (error) {
        throw new HunkError(describe(error));
      }
      const destination = hunk.move_path ?? hunk.path;
      try {
        await fs.write(destination, contents);
      } catch (error) {
        throw new HunkError(
          `Failed to write file ${destination}: ${describe(error)}`,
        );
      }
      if (hunk.move_path !== null && hunk.move_path !== hunk.path) {
        try {
          await fs.remove(hunk.path);
        } catch (error) {
          throw new HunkError(
            `Failed to remove original ${hunk.path}: ${describe(error)}`,
          );
        }
      }
      return;
    }
    default: {
      const exhaustive: never = hunk;
      throw new Error(`unreachable hunk ${String(exhaustive)}`);
    }
  }
}

/** Upstream `print_summary`, rendered to a string (one line per path). */
export function renderApplyPatchSummary(applied: AppliedPaths): string {
  const lines = ["Success. Updated the following files:"];
  for (const path of applied.added) {
    lines.push(`A ${path}`);
  }
  for (const path of applied.modified) {
    lines.push(`M ${path}`);
  }
  for (const path of applied.deleted) {
    lines.push(`D ${path}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Applies already-parsed hunks in order through `fs`. Every hunk path is
 * validated first, so an invalid path fails before anything is written. Like
 * upstream, applying stops at the first failing hunk and earlier hunks stay
 * applied; the result reports what was touched and which hunk failed.
 */
export async function applyHunks(
  hunks: readonly PatchHunk[],
  fs: PatchFileSystem,
): Promise<ApplyPatchResult> {
  const applied: AppliedPaths = { added: [], modified: [], deleted: [] };
  if (hunks.length === 0) {
    return {
      ok: false,
      applied,
      failed_hunk: null,
      error: "No files were modified.",
    };
  }
  for (const [index, hunk] of hunks.entries()) {
    for (const path of hunkPaths(hunk)) {
      const reason = validatePatchPath(path);
      if (reason !== null) {
        return {
          ok: false,
          applied,
          failed_hunk: index,
          error: `Invalid path '${path}': ${reason}`,
        };
      }
    }
  }
  for (const [index, hunk] of hunks.entries()) {
    try {
      await applyHunk(hunk, fs);
    } catch (error) {
      return {
        ok: false,
        applied,
        failed_hunk: index,
        error: describe(error),
      };
    }
    const path = hunkPath(hunk);
    if (hunk.kind === "add") {
      applied.added.push(path);
    } else if (hunk.kind === "delete") {
      applied.deleted.push(path);
    } else {
      applied.modified.push(path);
    }
  }
  return { ok: true, applied, summary: renderApplyPatchSummary(applied) };
}

/** Parses `patch` and applies it through `fs`; never throws for patch content errors. */
export async function applyPatch(
  patch: string,
  fs: PatchFileSystem,
  options: { mode?: ParseMode } = {},
): Promise<ApplyPatchResult> {
  let hunks: PatchHunk[];
  try {
    hunks = parsePatch(patch, options.mode ?? "lenient").hunks;
  } catch (error) {
    if (error instanceof PatchParseError) {
      return {
        ok: false,
        applied: { added: [], modified: [], deleted: [] },
        failed_hunk: null,
        error: error.message,
      };
    }
    throw error;
  }
  return applyHunks(hunks, fs);
}

/** MARS-written description of the patch format, for tool descriptions. */
export function renderApplyPatchInstructions(): string {
  return [
    "Edit workspace files with a single apply_patch document. The document starts with",
    "`*** Begin Patch` and ends with `*** End Patch`; between them list one or more hunks:",
    "",
    "- `*** Add File: <path>` followed by the new file's lines, each prefixed with `+`.",
    "- `*** Delete File: <path>` removes an existing file (directories cannot be deleted).",
    "- `*** Update File: <path>` edits an existing file. Optionally follow it with",
    "  `*** Move to: <new path>` to rename. Then give one or more chunks: `@@` (or",
    "  `@@ <a unique line to search for>`) followed by lines prefixed with a space",
    "  (unchanged context), `-` (removed) or `+` (added). Include a few context lines",
    "  so the chunk is unambiguous; `*** End of File` after the last chunk anchors it",
    "  to the end of the file.",
    "",
    "Paths are relative to the workspace root, use forward slashes and may not contain",
    "`..`. Hunks apply in order and the first failing hunk stops the patch; earlier",
    "hunks remain applied. Line endings of edited files are preserved.",
  ].join("\n");
}
