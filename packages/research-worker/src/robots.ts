export interface RobotsGroup {
  agents: string[];
  rules: Array<{ allow: boolean; pattern: string }>;
  crawlDelaySeconds?: number;
}

export interface RobotsFile {
  groups: RobotsGroup[];
}

export function parseRobots(text: string): RobotsFile {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | undefined;
  let collectingAgents = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (field === "user-agent") {
      if (!current || !collectingAgents) {
        current = { agents: [], rules: [] };
        groups.push(current);
        collectingAgents = true;
      }
      current.agents.push(value.toLowerCase());
      continue;
    }
    if (!current) continue;
    collectingAgents = false;
    if (field === "allow" || field === "disallow") {
      if (field === "disallow" && value === "") continue;
      current.rules.push({ allow: field === "allow", pattern: value });
    } else if (field === "crawl-delay") {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) {
        current.crawlDelaySeconds = seconds;
      }
    }
  }
  return { groups };
}

function patternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const source = body
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}${anchored ? "$" : ""}`).test(path);
}

export interface RobotsDecision {
  allowed: boolean;
  crawlDelayMs: number;
}

export function robotsDecision(
  file: RobotsFile,
  userAgent: string,
  path: string,
): RobotsDecision {
  const token = userAgent.split("/")[0]?.trim().toLowerCase() ?? "";
  const specific = file.groups.filter((group) =>
    group.agents.some((agent) => agent !== "*" && token.startsWith(agent)),
  );
  const chosen = specific.length
    ? specific
    : file.groups.filter((group) => group.agents.includes("*"));
  if (!chosen.length) return { allowed: true, crawlDelayMs: 0 };
  let best: { allow: boolean; length: number } | undefined;
  let crawlDelayMs = 0;
  for (const group of chosen) {
    crawlDelayMs = Math.max(
      crawlDelayMs,
      Math.round((group.crawlDelaySeconds ?? 0) * 1000),
    );
    for (const rule of group.rules) {
      if (!patternMatches(rule.pattern, path)) continue;
      const length = rule.pattern.length;
      if (
        !best ||
        length > best.length ||
        (length === best.length && rule.allow && !best.allow)
      ) {
        best = { allow: rule.allow, length };
      }
    }
  }
  return { allowed: best?.allow ?? true, crawlDelayMs };
}

export const ROBOTS_ALLOW_ALL: RobotsFile = { groups: [] };
export const ROBOTS_DENY_ALL: RobotsFile = {
  groups: [{ agents: ["*"], rules: [{ allow: false, pattern: "/" }] }],
};
