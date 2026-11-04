/**
 * Locator path and text rules. Copied (not imported) from
 * `apps/vscode/src/pathSafety.ts` (`checkRelativePath`) and
 * `packages/memory/src/threats.ts` (`INVISIBLE_CODE_POINT_RANGES`) so this
 * package depends only on `@mars/contracts` and `zod`; `sync.test.ts` fails
 * when either source drifts.
 */

export const MAX_PATH_LENGTH = 1024;

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const WINDOWS_RESERVED = /[<>:"|?*]/;

export type PathRejectReason =
  | "path_empty_or_too_long"
  | "path_control_characters"
  | "path_backslash"
  | "path_scheme_or_drive"
  | "path_not_relative"
  | "path_bad_segment"
  | "path_reserved_characters"
  | "path_git_segment"
  | "path_invisible_code_point";

export type PathCheck =
  | { ok: true; path: string; segments: string[] }
  | { ok: false; reason: PathRejectReason };

/** Same denylist as `packages/memory/src/threats.ts`. */
export const INVISIBLE_CODE_POINT_RANGES: readonly (readonly [
  number,
  number,
  string,
])[] = [
  [0x00ad, 0x00ad, "soft hyphen"],
  [0x034f, 0x034f, "combining grapheme joiner"],
  [0x061c, 0x061c, "Arabic letter mark"],
  [0x115f, 0x1160, "Hangul choseong/jungseong fillers"],
  [0x17b4, 0x17b5, "Khmer inherent vowels"],
  [0x180b, 0x180f, "Mongolian free variation selectors and vowel separator"],
  [0x200b, 0x200f, "zero-width space/joiners, LRM, RLM"],
  [0x2028, 0x2029, "line and paragraph separators"],
  [0x202a, 0x202e, "bidirectional embedding and override controls"],
  [0x2060, 0x2064, "word joiner and invisible operators"],
  [0x2066, 0x206f, "bidirectional isolates and deprecated format controls"],
  [0x3164, 0x3164, "Hangul filler"],
  [0xfe00, 0xfe0f, "variation selectors"],
  [0xfeff, 0xfeff, "zero-width no-break space / BOM"],
  [0xffa0, 0xffa0, "halfwidth Hangul filler"],
  [0xfff9, 0xfffb, "interlinear annotation controls"],
  [0x1bca0, 0x1bca3, "shorthand format controls"],
  [0x1d173, 0x1d17a, "musical symbol format controls"],
  [0xe0000, 0xe007f, "tag characters"],
  [0xe0100, 0xe01ef, "variation selectors supplement"],
];

export function isInvisibleCodePoint(codePoint: number): boolean {
  if (codePoint === 0x7f || (codePoint >= 0x80 && codePoint <= 0x9f))
    return true;
  if (codePoint < 0x20) return codePoint !== 0x09 && codePoint !== 0x0a;
  for (const [start, end] of INVISIBLE_CODE_POINT_RANGES)
    if (codePoint >= start && codePoint <= end) return true;
  return false;
}

export function hasInvisibleCodePoint(text: string): boolean {
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (isInvisibleCodePoint(codePoint)) return true;
  }
  return false;
}

/**
 * Validates a repository-relative POSIX path with exactly the rules of
 * `checkRelativePath` in `apps/vscode/src/pathSafety.ts`. The caller is
 * is expected to have checked the NFC form too (`validateLocatorPath`).
 */
export function checkLocatorPath(path: string): PathCheck {
  if (path.length === 0 || path.length > MAX_PATH_LENGTH)
    return { ok: false, reason: "path_empty_or_too_long" };
  if (
    Array.from(path).some(
      (char) => char.charCodeAt(0) < 0x20 || char === "\u007f",
    )
  )
    return { ok: false, reason: "path_control_characters" };
  if (path.includes("\\")) return { ok: false, reason: "path_backslash" };
  if (SCHEME.test(path)) return { ok: false, reason: "path_scheme_or_drive" };
  if (path.startsWith("/") || path.startsWith("~"))
    return { ok: false, reason: "path_not_relative" };
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..")
      return { ok: false, reason: "path_bad_segment" };
    if (WINDOWS_RESERVED.test(segment))
      return { ok: false, reason: "path_reserved_characters" };
    if (segment.toLowerCase() === ".git")
      return { ok: false, reason: "path_git_segment" };
  }
  if (hasInvisibleCodePoint(path))
    return { ok: false, reason: "path_invisible_code_point" };
  return { ok: true, path, segments };
}

/**
 * Git stores paths as bytes and never normalises Unicode, so the committed
 * spelling is kept verbatim for lookup; the NFC form is checked as well so
 * that normalisation cannot hide a rejected segment.
 */
export function validateLocatorPath(path: string): PathCheck {
  const raw = checkLocatorPath(path);
  if (!raw.ok) return raw;
  const nfc = checkLocatorPath(path.normalize("NFC"));
  if (!nfc.ok) return nfc;
  return raw;
}
