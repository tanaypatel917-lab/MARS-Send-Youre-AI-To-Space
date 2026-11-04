/**
 * Emitter and parser for the YAML subset the vault writes as frontmatter:
 * nested block mappings, block sequences of scalars, and scalars (strings,
 * finite numbers, booleans, null). Anchors, aliases, tags, flow collections
 * (except the empty `[]`), block scalars and duplicate keys are rejected so a
 * hand-edited note can never smuggle in YAML features Obsidian would accept
 * but this package does not understand.
 */
export type YamlScalar = string | number | boolean | null;
export type YamlValue = YamlScalar | YamlValue[] | { [key: string]: YamlValue };

const KEY = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const PLAIN = /^[A-Za-z0-9_][A-Za-z0-9_./@:+-]*$/;
const RESERVED = new Set([
  "true",
  "false",
  "null",
  "yes",
  "no",
  "on",
  "off",
  "~",
]);

function scalar(value: YamlScalar): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("yaml: non-finite number");
    return String(value);
  }
  if (
    PLAIN.test(value) &&
    !RESERVED.has(value.toLowerCase()) &&
    !/^-?(0|[1-9]\d*)(\.\d+)?$/.test(value) &&
    !value.includes(": ")
  )
    return value;
  return JSON.stringify(value);
}

function emitLines(value: YamlValue, indent: number, out: string[]): void {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item !== null && typeof item === "object")
        throw new Error("yaml: nested collections inside sequences");
      out.push(`${pad}- ${scalar(item)}`);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (!KEY.test(key)) throw new Error(`yaml: invalid key ${key}`);
      if (item !== null && typeof item === "object") {
        const empty = Array.isArray(item)
          ? item.length === 0
          : Object.keys(item).length === 0;
        if (empty)
          out.push(`${pad}${key}: ${Array.isArray(item) ? "[]" : "{}"}`);
        else {
          out.push(`${pad}${key}:`);
          emitLines(item, indent + 2, out);
        }
      } else out.push(`${pad}${key}: ${scalar(item)}`);
    }
    return;
  }
  throw new Error("yaml: top-level scalar");
}

/** Emits a block mapping with keys in insertion order and LF newlines. */
export function emitYaml(value: { [key: string]: YamlValue }): string {
  const out: string[] = [];
  emitLines(value, 0, out);
  return `${out.join("\n")}\n`;
}

export class YamlParseError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`yaml: ${message} (line ${line})`);
    this.name = "YamlParseError";
  }
}

function parseScalar(raw: string, line: number): YamlScalar {
  const text = raw.trim();
  if (text === "" || text === "null" || text === "~") return null;
  if (text === "true") return true;
  if (text === "false") return false;
  if (text.startsWith('"')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new YamlParseError("invalid quoted string", line);
    }
    if (typeof parsed !== "string")
      throw new YamlParseError("invalid quoted string", line);
    return parsed;
  }
  if (text.startsWith("'")) {
    if (!text.endsWith("'") || text.length < 2)
      throw new YamlParseError("invalid quoted string", line);
    return text.slice(1, -1).replaceAll("''", "'");
  }
  if (/^[&*!|>{}[\]%@`]/.test(text) || text.includes(" #"))
    throw new YamlParseError("unsupported scalar syntax", line);
  if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(text)) {
    const n = Number(text);
    if (Number.isSafeInteger(n) || (Number.isFinite(n) && text.includes(".")))
      return n;
  }
  return text;
}

interface Line {
  indent: number;
  text: string;
  number: number;
}

function lines(source: string): Line[] {
  const result: Line[] = [];
  source.split("\n").forEach((raw, index) => {
    const text = raw.replace(/\s+$/, "");
    if (!text.trim() || text.trimStart().startsWith("#")) return;
    if (text.includes("\t"))
      throw new YamlParseError("tab character", index + 1);
    const indent = text.length - text.trimStart().length;
    result.push({ indent, text: text.trimStart(), number: index + 1 });
  });
  return result;
}

function parseBlock(
  items: Line[],
  position: { index: number },
  indent: number,
): YamlValue {
  const first = items[position.index];
  if (!first) return {};
  if (first.text.startsWith("- ") || first.text === "-") {
    const list: YamlValue[] = [];
    while (position.index < items.length) {
      const item = items[position.index];
      if (!item || item.indent !== indent) {
        if (item && item.indent > indent)
          throw new YamlParseError("unexpected indentation", item.number);
        break;
      }
      if (!(item.text.startsWith("- ") || item.text === "-"))
        throw new YamlParseError("mixed sequence and mapping", item.number);
      list.push(parseScalar(item.text.slice(1), item.number));
      position.index += 1;
    }
    return list;
  }
  const map: { [key: string]: YamlValue } = {};
  while (position.index < items.length) {
    const item = items[position.index];
    if (!item || item.indent !== indent) {
      if (item && item.indent > indent)
        throw new YamlParseError("unexpected indentation", item.number);
      break;
    }
    const separator = item.text.indexOf(":");
    if (separator <= 0)
      throw new YamlParseError("expected `key: value`", item.number);
    const key = item.text.slice(0, separator).trim();
    const rest = item.text.slice(separator + 1);
    if (!KEY.test(key) || key === "__proto__" || key === "constructor")
      throw new YamlParseError("invalid key", item.number);
    if (Object.hasOwn(map, key))
      throw new YamlParseError(`duplicate key ${key}`, item.number);
    if (rest !== "" && !rest.startsWith(" "))
      throw new YamlParseError("expected space after colon", item.number);
    position.index += 1;
    const trimmed = rest.trim();
    if (trimmed === "") {
      const next = items[position.index];
      if (next && next.indent > indent)
        map[key] = parseBlock(items, position, next.indent);
      else map[key] = null;
    } else if (trimmed === "[]") map[key] = [];
    else if (trimmed === "{}") map[key] = {};
    else map[key] = parseScalar(trimmed, item.number);
  }
  return map;
}

/** Parses a block mapping emitted by `emitYaml` (or edited by hand within the subset). */
export function parseYaml(source: string): { [key: string]: YamlValue } {
  const items = lines(source);
  const position = { index: 0 };
  const value = parseBlock(items, position, items[0]?.indent ?? 0);
  if (position.index !== items.length)
    throw new YamlParseError(
      "unexpected content",
      items[position.index]?.number ?? 0,
    );
  if (Array.isArray(value) || value === null || typeof value !== "object")
    throw new YamlParseError("frontmatter must be a mapping", 1);
  return value;
}
