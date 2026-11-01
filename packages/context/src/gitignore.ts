export interface GitignoreRule {
  regex: RegExp;
  negated: boolean;
  directoryOnly: boolean;
  exactDirectoryRegex?: RegExp;
}

export function parseGitignore(contents: string): GitignoreRule[] {
  return contents.split(/\r?\n/).flatMap((raw) => {
    let line = trimTrailingUnescapedSpaces(raw);
    if (!line) return [];
    if (line.startsWith("\\#") || line.startsWith("\\!")) {
      line = line.slice(1);
    } else if (line.startsWith("#")) {
      return [];
    }
    const negated = line.startsWith("!");
    if (negated) line = line.slice(1);
    line = unescapeTrailingSpace(line);
    const directoryOnly = line.endsWith("/") && !line.endsWith("\\/");
    if (directoryOnly) line = line.slice(0, -1);
    if (!line) return [];
    const anchored = line.startsWith("/") || line.includes("/");
    line = line.replace(/^\/+/, "");
    const source = globSource(line);
    let regex: RegExp;
    let exactDirectoryRegex: RegExp | undefined;
    try {
      regex = anchored
        ? new RegExp(`^${source}(?:/.*)?$`)
        : new RegExp(`(?:^|/)${source}(?:/.*)?$`);
      exactDirectoryRegex = directoryOnly
        ? anchored
          ? new RegExp(`^${source}$`)
          : new RegExp(`(?:^|/)${source}$`)
        : undefined;
    } catch {
      return [];
    }
    return [
      {
        regex,
        negated,
        directoryOnly,
        ...(exactDirectoryRegex ? { exactDirectoryRegex } : {}),
      },
    ];
  });
}

export function isGitignored(
  path: string,
  isDirectory: boolean,
  ruleScopes: readonly { prefix: string; rules: readonly GitignoreRule[] }[],
): boolean {
  let ignored = false;
  for (const scope of ruleScopes) {
    const relative =
      scope.prefix === ""
        ? path
        : path.startsWith(`${scope.prefix}/`)
          ? path.slice(scope.prefix.length + 1)
          : "";
    if (!relative) continue;
    for (const rule of scope.rules) {
      if (!rule.regex.test(relative)) continue;
      if (
        rule.directoryOnly &&
        !isDirectory &&
        rule.exactDirectoryRegex?.test(relative)
      ) {
        continue;
      }
      ignored = !rule.negated;
    }
  }
  return ignored;
}

function globSource(pattern: string): string {
  let result = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] ?? "";
    if (character === "*" && pattern[index + 1] === "*") {
      index += 1;
      if (pattern[index + 1] === "/") {
        index += 1;
        result += "(?:.*/)?";
      } else {
        result += ".*";
      }
    } else if (character === "*") {
      result += "[^/]*";
    } else if (character === "?") {
      result += "[^/]";
    } else if (character === "[") {
      const close = pattern.indexOf("]", index + 1);
      if (close < 0) result += "\\[";
      else {
        let body = pattern.slice(index + 1, close);
        if (body.startsWith("!")) body = `^${body.slice(1)}`;
        result += `[${body.replaceAll("\\", "\\\\")}]`;
        index = close;
      }
    } else {
      result += character.replace(/[.+^${}()|\\]/g, "\\$&");
    }
  }
  return result;
}

function trimTrailingUnescapedSpaces(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === " ") {
    let escapes = 0;
    for (let index = end - 2; index >= 0 && value[index] === "\\"; index -= 1) {
      escapes += 1;
    }
    if (escapes % 2 === 1) break;
    end -= 1;
  }
  return value.slice(0, end);
}

function unescapeTrailingSpace(value: string): string {
  if (!value.endsWith(" ")) return value;
  let slashes = 0;
  for (
    let index = value.length - 2;
    index >= 0 && value[index] === "\\";
    index -= 1
  ) {
    slashes += 1;
  }
  return slashes % 2 === 1
    ? `${value.slice(0, value.length - 1 - slashes)}${"\\".repeat(slashes - 1)} `
    : value;
}
