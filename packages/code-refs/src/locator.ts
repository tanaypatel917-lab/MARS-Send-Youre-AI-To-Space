import { normalizeLocatorPath } from "./path-rules";
import {
  COMMIT_SHA_PATTERN,
  type Locator,
  type LocatorInput,
  LocatorInputSchema,
  type LocatorRejectReason,
  REPO_ID_PATTERN,
  type ResolveLimits,
} from "./schemas";

export type LocatorCheck =
  | { ok: true; locator: Locator }
  | { ok: false; reason: LocatorRejectReason };

function isPositiveInt(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * Validates an untrusted locator before anything touches git. Path rules are
 * those of `checkRelativePath` plus NFC normalisation and the invisible
 * code point denylist; ranges are inclusive, both bounds present or absent.
 */
export function validateLocator(
  input: unknown,
  limits: Pick<ResolveLimits, "max_range_lines">,
): LocatorCheck {
  const parsed = LocatorInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid_input" };
  const raw: LocatorInput = parsed.data;
  if (!REPO_ID_PATTERN.test(raw.repo_id))
    return { ok: false, reason: "invalid_repo_id" };
  if (!COMMIT_SHA_PATTERN.test(raw.commit_sha))
    return { ok: false, reason: "invalid_commit_sha" };
  const path = normalizeLocatorPath(raw.path);
  if (!path.ok) return { ok: false, reason: path.reason };

  const hasStart = raw.line_start !== undefined;
  const hasEnd = raw.line_end !== undefined;
  if (hasStart !== hasEnd) return { ok: false, reason: "invalid_range" };
  let line_start: number | null = null;
  let line_end: number | null = null;
  if (raw.line_start !== undefined && raw.line_end !== undefined) {
    if (!isPositiveInt(raw.line_start) || !isPositiveInt(raw.line_end))
      return { ok: false, reason: "invalid_range" };
    if (raw.line_start > raw.line_end)
      return { ok: false, reason: "invalid_range" };
    if (raw.line_end - raw.line_start + 1 > limits.max_range_lines)
      return { ok: false, reason: "range_too_large" };
    line_start = raw.line_start;
    line_end = raw.line_end;
  }
  return {
    ok: true,
    locator: {
      repo_id: raw.repo_id,
      commit_sha: raw.commit_sha,
      path: path.path,
      line_start,
      line_end,
    },
  };
}
