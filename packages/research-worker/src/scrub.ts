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

export function redact(text: string, needles: readonly string[]): string {
  let output = text;
  for (const needle of [...new Set(needles)]
    .filter((value) => value.length > 0)
    .sort((a, b) => b.length - a.length)) {
    output = output.replace(needlePattern(needle), "[redacted]");
  }
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, "[redacted]");
  }
  return output;
}
