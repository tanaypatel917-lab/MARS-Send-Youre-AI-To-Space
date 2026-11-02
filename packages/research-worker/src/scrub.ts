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
/** Encoded units closer than this are decoded as one region. */
const REGION_GAP = 64;
/** Literal context kept around a region so secret shapes spanning it match. */
const REGION_PAD = 512;

interface EncodedUnit {
  start: number;
  end: number;
  char?: string;
  byte?: number;
}

interface DecodedView {
  text: string;
  starts: number[];
  ends: number[];
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

/** Bounded windows of text that contain encoded units, with literal padding. */
function encodedRegions(text: string): Array<[number, number]> {
  const regions: Array<[number, number]> = [];
  for (const match of text.matchAll(ENCODED_UNIT)) {
    const start = Math.max(0, match.index - REGION_PAD);
    const end = Math.min(
      text.length,
      match.index + match[0].length + REGION_PAD,
    );
    const last = regions[regions.length - 1];
    if (last && start <= last[1] + REGION_GAP) {
      last[1] = Math.max(last[1], end);
    } else {
      regions.push([start, end]);
    }
  }
  return regions;
}

/**
 * Decodes entities and percent escapes inside one region while mapping each
 * decoded char back to exactly the source span that produced it.
 */
function decodedView(text: string, from: number, to: number): DecodedView {
  let decoded = "";
  const starts: number[] = [];
  const ends: number[] = [];
  const push = (chunk: string, start: number, end: number) => {
    decoded += chunk;
    for (let i = 0; i < chunk.length; i += 1) {
      starts.push(start);
      ends.push(end);
    }
  };
  const pushLiteral = (chunk: string, start: number) => {
    let offset = start;
    for (const char of chunk) {
      push(char, offset, offset + char.length);
      offset += char.length;
    }
  };
  const units: EncodedUnit[] = [];
  const pattern = new RegExp(ENCODED_UNIT.source, "giy");
  pattern.lastIndex = from;
  for (let scan = from; scan < to; ) {
    pattern.lastIndex = scan;
    const match = pattern.exec(text);
    if (match && match.index === scan) {
      const unit = parseUnit(match);
      if (unit.end > to) break;
      units.push(unit);
      scan = unit.end;
    } else {
      scan += 1;
    }
  }
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let cursor = from;
  for (let i = 0; i < units.length; i += 1) {
    const unit = units[i];
    if (!unit) break;
    if (unit.start > cursor)
      pushLiteral(text.slice(cursor, unit.start), cursor);
    if (unit.char !== undefined) {
      push(unit.char, unit.start, unit.end);
      cursor = unit.end;
      continue;
    }
    const length = utf8SequenceLength(unit.byte ?? 0);
    const bytes = [unit.byte ?? 0];
    let last = unit;
    for (let j = 1; j < length; j += 1) {
      const next = units[i + j];
      if (!next || next.byte === undefined || next.start !== last.end) break;
      bytes.push(next.byte);
      last = next;
    }
    i += bytes.length - 1;
    push(decoder.decode(new Uint8Array(bytes)), unit.start, last.end);
    cursor = last.end;
  }
  if (cursor < to) pushLiteral(text.slice(cursor, to), cursor);
  return { text: decoded, starts, ends };
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
  const ranges: Array<[number, number]> = [];
  for (const [from, to] of encodedRegions(text)) {
    const view = decodedView(text, from, to);
    for (const pattern of SECRET_PATTERNS) {
      for (const match of view.text.matchAll(pattern)) {
        const index = match.index ?? 0;
        const start = view.starts[index];
        const end = view.ends[index + match[0].length - 1];
        if (start !== undefined && end !== undefined) ranges.push([start, end]);
      }
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
