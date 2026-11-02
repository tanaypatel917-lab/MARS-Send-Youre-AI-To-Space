const SECRET_PATTERNS = [
  /\b(?:bearer|basic)\s+[a-z0-9._~+/=-]{8,}/gi,
  /\b(?:api[_-]?key|access[_-]?token|secret|password|passwd|token)\s*[:=]\s*["']?[^\s"']{6,}/gi,
  /\b(?:sk|pk|rk)-[a-z0-9_-]{16,}\b/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
];

const NAMED_ENTITIES: Record<string, string[]> = {
  "/": ["sol"],
  "-": ["hyphen", "dash"],
  ":": ["colon"],
  ".": ["period"],
  _: ["lowbar"],
  "&": ["amp"],
  "<": ["lt"],
  ">": ["gt"],
  '"': ["quot"],
  "'": ["apos"],
  " ": ["nbsp"],
};

const MAX_PATTERN_NEEDLE_CHARS = 256;

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
}

/**
 * Matches one character of a needle in its literal form or as a numeric HTML
 * entity, a named entity, or percent-encoded UTF-8, so a needle hidden behind
 * encoding is redacted in place without rewriting the surrounding text.
 */
function characterVariants(char: string): string {
  const code = char.codePointAt(0) ?? 0;
  const variants = [
    escapeRegex(char),
    `&#0*${code};?`,
    `&#x0*${code.toString(16)};?`,
    [...Buffer.from(char, "utf8")]
      .map((byte) => `%${byte.toString(16).padStart(2, "0")}`)
      .join(""),
    ...(NAMED_ENTITIES[char] ?? []).map((name) => `&${name};?`),
  ];
  return `(?:${variants.join("|")})`;
}

export function needlePattern(needle: string): RegExp {
  const chars = [...needle];
  if (chars.length > MAX_PATTERN_NEEDLE_CHARS) {
    return new RegExp(escapeRegex(needle), "g");
  }
  return new RegExp(chars.map(characterVariants).join(""), "gi");
}

const ENCODED_UNIT = /&#x([0-9a-f]+);?|&#(\d+);?|&([a-z]+);?|%([0-9a-f]{2})/gi;
const NAMED_LOOKUP = new Map(
  Object.entries(NAMED_ENTITIES).flatMap(([char, names]) =>
    names.map((name) => [name, char] as const),
  ),
);
interface EncodedUnit {
  start: number;
  end: number;
  char?: string;
  byte?: number;
}

/**
 * Decoded text plus a sparse map back to source offsets. Segments are stored
 * as parallel arrays: decoded start, source start, source end and stride (the
 * source chars per decoded UTF-16 unit; 0 = the whole segment maps to one
 * span). Literal runs and uniform escape runs collapse into one segment each,
 * so memory grows with the number of distinct encodings, not page size.
 */
interface DecodedView {
  text: string;
  decodedStarts: number[];
  sourceStarts: number[];
  sourceEnds: number[];
  strides: number[];
}

function utf8SequenceLength(lead: number): number {
  if (lead < 0x80) return 1;
  if ((lead & 0xe0) === 0xc0) return 2;
  if ((lead & 0xf0) === 0xe0) return 3;
  if ((lead & 0xf8) === 0xf0) return 4;
  return 1;
}

function parseUnit(match: RegExpExecArray): EncodedUnit {
  const [unit, hex, decimal, name, percent] = match;
  const start = match.index;
  const end = start + unit.length;
  if (percent !== undefined) {
    return { start, end, byte: Number.parseInt(percent, 16) };
  }
  if (hex !== undefined || decimal !== undefined) {
    const code = Number.parseInt(
      hex ?? decimal ?? "0",
      hex !== undefined ? 16 : 10,
    );
    return {
      start,
      end,
      char: code > 0 && code < 0x110000 ? String.fromCodePoint(code) : unit,
    };
  }
  return {
    start,
    end,
    char: NAMED_LOOKUP.get((name ?? "").toLowerCase()) ?? unit,
  };
}

/** Decodes the whole text while mapping every decoded char to its source span. */
function decodedView(text: string): DecodedView {
  const view: DecodedView = {
    text: "",
    decodedStarts: [],
    sourceStarts: [],
    sourceEnds: [],
    strides: [],
  };
  const parts: string[] = [];
  let decodedLength = 0;
  const append = (
    chunk: string,
    sourceStart: number,
    sourceEnd: number,
    stride: number,
  ) => {
    if (!chunk.length) return;
    const last = view.strides.length - 1;
    const mergeable =
      last >= 0 &&
      view.strides[last] === stride &&
      stride > 0 &&
      view.sourceEnds[last] === sourceStart;
    if (mergeable) {
      view.sourceEnds[last] = sourceEnd;
    } else {
      view.decodedStarts.push(decodedLength);
      view.sourceStarts.push(sourceStart);
      view.sourceEnds.push(sourceEnd);
      view.strides.push(stride);
    }
    parts.push(chunk);
    decodedLength += chunk.length;
  };
  const units: EncodedUnit[] = [];
  for (const match of text.matchAll(ENCODED_UNIT)) {
    units.push(parseUnit(match as RegExpExecArray));
  }
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let cursor = 0;
  for (let i = 0; i < units.length; i += 1) {
    const unit = units[i];
    if (!unit) break;
    if (unit.start > cursor)
      append(text.slice(cursor, unit.start), cursor, unit.start, 1);
    if (unit.char !== undefined) {
      const width = unit.end - unit.start;
      append(
        unit.char,
        unit.start,
        unit.end,
        unit.char.length === 1 ? width : 0,
      );
      cursor = unit.end;
      continue;
    }
    const bytes = [unit.byte ?? 0];
    let last = unit;
    for (let j = 1; j < utf8SequenceLength(bytes[0] ?? 0); j += 1) {
      const next = units[i + j];
      if (!next || next.byte === undefined || next.start !== last.end) break;
      bytes.push(next.byte);
      last = next;
    }
    i += bytes.length - 1;
    const char = decoder.decode(new Uint8Array(bytes));
    const width = last.end - unit.start;
    append(char, unit.start, last.end, char.length === 1 ? width : 0);
    cursor = last.end;
  }
  if (cursor < text.length) append(text.slice(cursor), cursor, text.length, 1);
  view.text = parts.join("");
  return view;
}

function segmentAt(view: DecodedView, index: number): number {
  let lo = 0;
  let hi = view.decodedStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((view.decodedStarts[mid] ?? 0) <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Source span [start, end) of the decoded chars [from, to). */
function sourceSpan(
  view: DecodedView,
  from: number,
  to: number,
): [number, number] {
  const first = segmentAt(view, from);
  const lastIndex = segmentAt(view, to - 1);
  const firstStride = view.strides[first] ?? 0;
  const lastStride = view.strides[lastIndex] ?? 0;
  const start =
    firstStride > 0
      ? (view.sourceStarts[first] ?? 0) +
        (from - (view.decodedStarts[first] ?? 0)) * firstStride
      : (view.sourceStarts[first] ?? 0);
  const end =
    lastStride > 0
      ? (view.sourceStarts[lastIndex] ?? 0) +
        (to - (view.decodedStarts[lastIndex] ?? 0)) * lastStride
      : (view.sourceEnds[lastIndex] ?? 0);
  return [start, end];
}

function spliceRanges(text: string, ranges: Array<[number, number]>): string {
  if (!ranges.length) return text;
  ranges.sort((a, b) => a[0] - b[0]);
  let output = "";
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (end <= cursor) continue;
    output += `${text.slice(cursor, Math.max(cursor, start))}[redacted]`;
    cursor = end;
  }
  return output + text.slice(cursor);
}

function redactSecretShapes(text: string): string {
  if (!ENCODED_UNIT.test(text)) {
    ENCODED_UNIT.lastIndex = 0;
    let output = text;
    for (const pattern of SECRET_PATTERNS) {
      output = output.replace(pattern, "[redacted]");
    }
    return output;
  }
  ENCODED_UNIT.lastIndex = 0;
  const view = decodedView(text);
  const ranges: Array<[number, number]> = [];
  for (const pattern of SECRET_PATTERNS) {
    for (const match of view.text.matchAll(pattern)) {
      const index = match.index ?? 0;
      ranges.push(sourceSpan(view, index, index + match[0].length));
    }
  }
  let output = spliceRanges(text, ranges);
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, "[redacted]");
  }
  return output;
}

export function redact(text: string, needles: readonly string[]): string {
  let output = text;
  for (const needle of [...new Set(needles)]
    .filter((value) => value.length > 0)
    .sort((a, b) => b.length - a.length)) {
    output = output.replace(needlePattern(needle), "[redacted]");
  }
  return redactSecretShapes(output);
}
