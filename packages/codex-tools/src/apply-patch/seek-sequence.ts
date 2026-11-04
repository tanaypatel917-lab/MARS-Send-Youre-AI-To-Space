// Portions derived from openai/codex (https://github.com/openai/codex), file
// codex-rs/apply-patch/src/seek_sequence.rs at revision f58acd6ede312266a7a0eaa63fd8dadacb4de239.
// Copyright 2025 OpenAI. Licensed under the Apache License, Version 2.0; see
// packages/codex-tools/third_party/codex/LICENSE.txt. Modified by MARS (TypeScript port).

const PUNCTUATION_MAP: ReadonlyMap<string, string> = new Map<string, string>([
  ["\u2010", "-"],
  ["\u2011", "-"],
  ["\u2012", "-"],
  ["\u2013", "-"],
  ["\u2014", "-"],
  ["\u2015", "-"],
  ["\u2212", "-"],
  ["\u2018", "'"],
  ["\u2019", "'"],
  ["\u201a", "'"],
  ["\u201b", "'"],
  ["\u201c", '"'],
  ["\u201d", '"'],
  ["\u201e", '"'],
  ["\u201f", '"'],
  ["\u00a0", " "],
  ["\u2002", " "],
  ["\u2003", " "],
  ["\u2004", " "],
  ["\u2005", " "],
  ["\u2006", " "],
  ["\u2007", " "],
  ["\u2008", " "],
  ["\u2009", " "],
  ["\u200a", " "],
  ["\u202f", " "],
  ["\u205f", " "],
  ["\u3000", " "],
]);

/** Maps typographic dashes, quotes and odd spaces to ASCII so ASCII-authored patches still match. */
export function normalisePunctuation(text: string): string {
  let out = "";
  for (const ch of text.trim()) {
    out += PUNCTUATION_MAP.get(ch) ?? ch;
  }
  return out;
}

/**
 * MARS bound: line comparisons one update hunk may spend locating its chunks.
 * The search is quadratic in the worst case and runs on the host's event
 * loop, so a model-controlled file and patch could otherwise stall the host.
 */
export const MAX_SEEK_LINE_COMPARISONS = 20_000_000;

/** Shared across the seeks of one update hunk; `remaining` counts down. */
export interface SeekBudget {
  remaining: number;
}

export class SeekBudgetExceededError extends Error {
  constructor() {
    super(
      `context search exceeded ${MAX_SEEK_LINE_COMPARISONS} line comparisons`,
    );
    this.name = "SeekBudgetExceededError";
  }
}

function matchesWith(
  lines: readonly string[],
  pattern: readonly string[],
  searchStart: number,
  equal: (line: string, pat: string) => boolean,
  budget: SeekBudget | undefined,
): number | null {
  const last = lines.length - pattern.length;
  for (let i = searchStart; i <= last; i += 1) {
    let ok = true;
    for (let p = 0; p < pattern.length; p += 1) {
      if (budget !== undefined && --budget.remaining < 0) {
        throw new SeekBudgetExceededError();
      }
      if (!equal(lines[i + p] ?? "", pattern[p] ?? "")) {
        ok = false;
        break;
      }
    }
    if (ok) {
      return i;
    }
  }
  return null;
}

/**
 * Finds `pattern` within `lines` at or after `start` with decreasing strictness:
 * exact, trailing-whitespace-insensitive, whitespace-insensitive, then with
 * Unicode punctuation normalised. With `eof` the end-of-file position is tried
 * first. An empty pattern matches at `start`; a pattern longer than `lines`
 * never matches. With a `budget`, every line comparison counts against it and
 * `SeekBudgetExceededError` is thrown once it is spent.
 */
export function seekSequence(
  lines: readonly string[],
  pattern: readonly string[],
  start: number,
  eof: boolean,
  budget?: SeekBudget,
): number | null {
  if (pattern.length === 0) {
    return start;
  }
  if (pattern.length > lines.length) {
    return null;
  }
  const searchStart = eof
    ? Math.max(lines.length - pattern.length, start)
    : start;
  return (
    matchesWith(
      lines,
      pattern,
      searchStart,
      (line, pat) => line === pat,
      budget,
    ) ??
    matchesWith(
      lines,
      pattern,
      searchStart,
      (line, pat) => line.trimEnd() === pat.trimEnd(),
      budget,
    ) ??
    matchesWith(
      lines,
      pattern,
      searchStart,
      (line, pat) => line.trim() === pat.trim(),
      budget,
    ) ??
    matchesWith(
      lines,
      pattern,
      searchStart,
      (line, pat) => normalisePunctuation(line) === normalisePunctuation(pat),
      budget,
    )
  );
}
