// Portions derived from openai/codex (https://github.com/openai/codex), file
// codex-rs/apply-patch/src/file_update.rs at revision f58acd6ede312266a7a0eaa63fd8dadacb4de239.
// Copyright 2025 OpenAI. Licensed under the Apache License, Version 2.0; see
// packages/codex-tools/third_party/codex/LICENSE.txt. Modified by MARS (TypeScript port).

import type { UpdateFileChunk } from "../types";
import {
  MAX_SEEK_LINE_COMPARISONS,
  type SeekBudget,
  SeekBudgetExceededError,
  seekSequence,
} from "./seek-sequence";
import { type Replacement, SourceFile } from "./source-file";

export class ReplacementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplacementError";
  }
}

/**
 * Computes the replacements that turn `originalLines` into the patched file.
 * Chunks are located in order: a `@@ ctx` line is sought from the current
 * position, then `old_lines` (retrying without a trailing empty line that
 * stands for the final newline). Parsed context lines are kept in place so
 * their exact text and terminators survive. A chunk without old lines is
 * appended at end of file (upstream behaviour, even after a `@@` anchor).
 * MARS bounds the whole search at `MAX_SEEK_LINE_COMPARISONS` per hunk.
 */
export function computeReplacements(
  originalLines: readonly string[],
  path: string,
  chunks: readonly UpdateFileChunk[],
): Replacement[] {
  const budget: SeekBudget = { remaining: MAX_SEEK_LINE_COMPARISONS };
  try {
    return locateReplacements(originalLines, path, chunks, budget);
  } catch (error) {
    if (error instanceof SeekBudgetExceededError) {
      throw new ReplacementError(
        `Failed to apply chunks to ${path}: ${error.message}`,
      );
    }
    throw error;
  }
}

function locateReplacements(
  originalLines: readonly string[],
  path: string,
  chunks: readonly UpdateFileChunk[],
  budget: SeekBudget,
): Replacement[] {
  const replacements: Replacement[] = [];
  let lineIndex = 0;
  for (const chunk of chunks) {
    if (chunk.change_context !== null) {
      const idx = seekSequence(
        originalLines,
        [chunk.change_context],
        lineIndex,
        false,
        budget,
      );
      if (idx === null) {
        throw new ReplacementError(
          `Failed to find context '${chunk.change_context}' in ${path}`,
        );
      }
      lineIndex = idx + 1;
    }
    if (chunk.old_lines.length === 0) {
      replacements.push([originalLines.length, 0, [...chunk.new_lines]]);
      continue;
    }
    let pattern: readonly string[] = chunk.old_lines;
    let newSlice: readonly string[] = chunk.new_lines;
    let found = seekSequence(
      originalLines,
      pattern,
      lineIndex,
      chunk.is_end_of_file,
      budget,
    );
    if (found === null && pattern[pattern.length - 1] === "") {
      pattern = pattern.slice(0, -1);
      if (newSlice[newSlice.length - 1] === "") {
        newSlice = newSlice.slice(0, -1);
      }
      found = seekSequence(
        originalLines,
        pattern,
        lineIndex,
        chunk.is_end_of_file,
        budget,
      );
    }
    if (found === null) {
      throw new ReplacementError(
        `Failed to find expected lines in ${path}:\n${chunk.old_lines.join("\n")}`,
      );
    }
    let oldStart = 0;
    let newStart = 0;
    for (const [oldContext, newContext] of chunk.context_line_indices) {
      if (oldContext >= pattern.length || newContext >= newSlice.length) {
        break;
      }
      if (oldStart !== oldContext || newStart !== newContext) {
        replacements.push([
          found + oldStart,
          oldContext - oldStart,
          newSlice.slice(newStart, newContext),
        ]);
      }
      oldStart = oldContext + 1;
      newStart = newContext + 1;
    }
    if (oldStart !== pattern.length || newStart !== newSlice.length) {
      replacements.push([
        found + oldStart,
        pattern.length - oldStart,
        newSlice.slice(newStart),
      ]);
    }
    lineIndex = found + pattern.length;
  }
  replacements.sort((a, b) => a[0] - b[0]);
  return replacements;
}

/** Applies `chunks` to `original` and returns the new file text. */
export function deriveNewContents(
  original: string,
  path: string,
  chunks: readonly UpdateFileChunk[],
): string {
  const source = SourceFile.parse(original);
  const replacements = computeReplacements(source.lineTexts(), path, chunks);
  source.applyReplacements(replacements);
  return source.contents();
}
