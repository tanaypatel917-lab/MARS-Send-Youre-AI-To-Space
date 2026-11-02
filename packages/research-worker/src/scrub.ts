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

interface DecodedView {
  text: string;
  starts: number[];
  ends: number[];
}

/** Decodes entities and percent escapes while mapping each char to its span. */
function decodedView(text: string): DecodedView {
  let decoded = "";
  const starts: number[] = [];
  const ends: number[] = [];
  const push = (chunk: string, start: number, end: number) => {
    for (const char of chunk) {
      decoded += char;
      for (let i = 0; i < char.length; i += 1) {
        starts.push(start);
        ends.push(end);
      }
    }
  };
  const pushLiteral = (chunk: string, start: number) => {
    let offset = start;
    for (const char of chunk) {
      push(char, offset, offset + char.length);
      offset += char.length;
    }
  };
  let cursor = 0;
  let pendingBytes: number[] = [];
  let pendingStart = 0;
  const flushBytes = (end: number) => {
    if (!pendingBytes.length) return;
    push(
      new TextDecoder("utf-8", { fatal: false }).decode(
        new Uint8Array(pendingBytes),
      ),
      pendingStart,
      end,
    );
    pendingBytes = [];
  };
  for (const match of text.matchAll(ENCODED_UNIT)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      flushBytes(cursor);
      pushLiteral(text.slice(cursor, index), cursor);
    }
    const [unit, hex, decimal, name, percent] = match;
    const end = index + unit.length;
    if (percent !== undefined) {
      if (!pendingBytes.length) pendingStart = index;
      pendingBytes.push(Number.parseInt(percent, 16));
      cursor = end;
      continue;
    }
    flushBytes(index);
    let char: string | undefined;
    if (hex !== undefined || decimal !== undefined) {
      const code = Number.parseInt(
        hex ?? decimal ?? "0",
        hex !== undefined ? 16 : 10,
      );
      if (code > 0 && code < 0x110000) char = String.fromCodePoint(code);
    } else if (name !== undefined) {
      char = NAMED_LOOKUP.get(name.toLowerCase());
    }
    push(char ?? unit, index, end);
    cursor = end;
  }
  flushBytes(cursor);
  if (cursor < text.length) pushLiteral(text.slice(cursor), cursor);
  return { text: decoded, starts, ends };
}

function redactSecretShapes(text: string): string {
  const view = decodedView(text);
  const ranges: Array<[number, number]> = [];
  for (const pattern of SECRET_PATTERNS) {
    for (const match of view.text.matchAll(pattern)) {
      const index = match.index ?? 0;
      const last = index + match[0].length - 1;
      const start = view.starts[index];
      const end = view.ends[last];
      if (start !== undefined && end !== undefined) ranges.push([start, end]);
    }
  }
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

export function redact(text: string, needles: readonly string[]): string {
  let output = text;
  for (const needle of [...new Set(needles)]
    .filter((value) => value.length > 0)
    .sort((a, b) => b.length - a.length)) {
    output = output.replace(needlePattern(needle), "[redacted]");
  }
  return redactSecretShapes(output);
}
