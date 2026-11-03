/**
 * Minimal, dependency-free parser for the YAML subset allowed in SKILL.md
 * frontmatter: a flat mapping of scalar `key: value` pairs. Anchors, aliases,
 * nested structures, flow collections and duplicate keys are rejected so the
 * parser cannot be used for billion-laughs or type-confusion tricks.
 */
export interface Frontmatter {
  name?: string;
  description?: string;
  [key: string]: string | undefined;
}

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const KEY = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

function unquote(value: string): string | undefined {
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === "string" ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    return value.slice(1, -1).replaceAll("''", "'");
  if (/^[&*!|>{}[\]%@`]/.test(value)) return undefined;
  const comment = value.indexOf(" #");
  return (comment >= 0 ? value.slice(0, comment) : value).trim();
}

export function parseFrontmatter(content: string): Frontmatter | undefined {
  const match = FENCE.exec(content);
  if (!match || match[1] === undefined) return undefined;
  const data: Frontmatter = {};
  for (const raw of match[1].split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (line !== line.trimStart()) return undefined;
    const separator = line.indexOf(":");
    if (separator <= 0) return undefined;
    const key = line.slice(0, separator).trim();
    const rest = line.slice(separator + 1);
    if (!KEY.test(key) || key === "__proto__") return undefined;
    if (rest && !rest.startsWith(" ")) return undefined;
    if (Object.hasOwn(data, key)) return undefined;
    const value = unquote(rest.trim());
    if (value === undefined) return undefined;
    data[key] = value;
  }
  return data;
}
