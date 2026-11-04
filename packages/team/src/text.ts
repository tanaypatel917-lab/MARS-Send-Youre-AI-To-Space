/**
 * Text rules shared by reactions and search. The invisible-code-point
 * denylist is the one from `packages/memory/src/threats.ts` (also copied by
 * `packages/code-refs`): every default-ignorable or format code point that
 * renders as nothing is rejected, so a reaction key or a search query can never
 * smuggle text past a reader.
 */
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

/** A reaction key: 1..max UTF-16 units, no whitespace, no invisible code point. */
export function isValidEmoji(
  value: unknown,
  maxChars: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= maxChars &&
    !/\s/u.test(value) &&
    !hasInvisibleCodePoint(value)
  );
}

/**
 * ASCII-only case folding, the same folding SQLite's `LIKE` applies without
 * ICU, so the excerpt position agrees with the SQL match. Length-preserving.
 */
export function foldAscii(text: string): string {
  return text.replace(/[A-Z]/g, (char) => char.toLowerCase());
}

/** Escapes `%`, `_` and the escape character for a `LIKE ? ESCAPE '\'` pattern. */
export function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

export interface Excerpt {
  text: string;
  cut_before: boolean;
  cut_after: boolean;
}

const isHighSurrogate = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;
const isLowSurrogate = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;

/**
 * `text.slice(start, end)` moved inwards so it never starts on a low or ends
 * on a high surrogate. Lengths are UTF-16 units, the unit the Zod `max`
 * bounds of the response schemas use.
 */
function sliceWhole(text: string, start: number, end: number): string {
  let from = start;
  let to = Math.min(end, text.length);
  if (from < to && isLowSurrogate(text.charCodeAt(from))) from += 1;
  if (to > from && isHighSurrogate(text.charCodeAt(to - 1))) to -= 1;
  return text.slice(from, to);
}

/** First `maxChars` UTF-16 units. */
export function headExcerpt(text: string, maxChars: number): Excerpt {
  if (text.length <= maxChars)
    return { text, cut_before: false, cut_after: false };
  return {
    text: sliceWhole(text, 0, maxChars),
    cut_before: false,
    cut_after: true,
  };
}

/**
 * Bounded window around the first case-folded hit, in the shape of
 * `excerptAround` in `packages/workbench/src/memory-context.ts`: the hit sits
 * a quarter of the way in. `maxChars` is in UTF-16 units and the window never
 * splits a surrogate pair.
 */
export function excerptAround(
  text: string,
  query: string,
  maxChars: number,
): Excerpt {
  if (text.length <= maxChars)
    return { text, cut_before: false, cut_after: false };
  const hit = foldAscii(text).indexOf(foldAscii(query));
  const first = hit < 0 ? 0 : hit;
  const start = Math.max(
    0,
    Math.min(first - Math.floor(maxChars / 4), text.length - maxChars),
  );
  const window = sliceWhole(text, start, start + maxChars);
  return {
    text: window,
    cut_before: start > 0,
    cut_after: start + maxChars < text.length,
  };
}
