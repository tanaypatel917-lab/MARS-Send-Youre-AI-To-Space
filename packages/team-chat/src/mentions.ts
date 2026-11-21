import type { ReferenceInput } from "./schemas";
import type { MentionIndex } from "./service";

/** One row of the `@` picker: a code reference, a teammate `@handle`, or `@MARS`. */
export type MentionCandidate =
  | {
      key: string;
      kind: "file" | "symbol" | "range";
      repo_id: string;
      repo_name: string;
      label: string;
      detail: string;
      reference: ReferenceInput;
    }
  | {
      key: string;
      kind: "user";
      user_id: string;
      handle: string;
      label: string;
      detail: string;
    }
  | {
      key: string;
      kind: "agent";
      agent_id: "mars";
      label: string;
      detail: string;
    };

export const MAX_MENTION_CANDIDATES = 8;

const QUERY = /^(?<path>[^:\s]*)(?::(?<start>\d+)(?:-(?<end>\d+))?)?$/;

/**
 * Candidates for a picker query. Syntax: `path`, `path:10`, `path:10-20`, a
 * symbol name, a teammate handle/display name, or `MARS` (when the read-only
 * assistant is enabled). Results are deterministic for a given index and query.
 */
export function mentionCandidates(
  index: MentionIndex,
  query: string,
  activeRepoId: string | null,
  limit = MAX_MENTION_CANDIDATES,
): MentionCandidate[] {
  const trimmed = query.trim();
  const lowered = trimmed.toLowerCase();
  const match = QUERY.exec(trimmed);
  const pathQuery = (match?.groups?.path ?? query).toLowerCase();
  const start = match?.groups?.start ? Number(match.groups.start) : null;
  const end = match?.groups?.end ? Number(match.groups.end) : start;

  const agents: MentionCandidate[] = [];
  if (
    index.agent_available &&
    start === null &&
    (lowered === "" || "mars".startsWith(lowered) || "mars".includes(lowered))
  ) {
    agents.push({
      key: "agent:mars",
      kind: "agent",
      agent_id: "mars",
      label: "@MARS",
      detail: "Ask read-only assistant (preview before sending)",
    });
  }

  const people: MentionCandidate[] = [];
  if (index.users && start === null) {
    for (const user of index.users) {
      const handle = user.handle.toLowerCase();
      const name = user.display_name.toLowerCase();
      const uid = user.user_id.toLowerCase();
      if (
        lowered === "" ||
        handle.includes(lowered) ||
        name.includes(lowered) ||
        uid.includes(lowered)
      ) {
        people.push({
          key: `user:${user.user_id}`,
          kind: "user",
          user_id: user.user_id,
          handle: user.handle,
          label: `@${user.handle}`,
          detail: user.display_name,
        });
      }
    }
  }

  const repos = [...index.repos].sort((a, b) => {
    if (a.repo_id === activeRepoId) return -1;
    if (b.repo_id === activeRepoId) return 1;
    return a.name < b.name ? -1 : 1;
  });
  const files: MentionCandidate[] = [];
  const symbols: MentionCandidate[] = [];
  for (const repo of repos) {
    for (const file of repo.files) {
      const path = file.path.toLowerCase();
      const base = path.slice(path.lastIndexOf("/") + 1);
      const fileMatches =
        pathQuery === "" ||
        path.includes(pathQuery) ||
        base.includes(pathQuery);
      if (fileMatches && start !== null && end !== null) {
        if (
          start >= 1 &&
          end >= start &&
          (file.line_count <= 0 || end <= file.line_count)
        )
          files.push({
            key: `${repo.repo_id}@${repo.commit_sha}:${file.path}:${start}-${end}`,
            kind: "range",
            repo_id: repo.repo_id,
            repo_name: repo.name,
            label: `${file.path}:${start}-${end}`,
            detail: `${repo.name} @ ${repo.commit_sha.slice(0, 7)}`,
            reference: {
              kind: "range",
              repo_id: repo.repo_id,
              commit_sha: repo.commit_sha,
              path: file.path,
              line_start: start,
              line_end: end,
              symbol: null,
            },
          });
        continue;
      }
      if (fileMatches)
        files.push({
          key: `${repo.repo_id}@${repo.commit_sha}:${file.path}`,
          kind: "file",
          repo_id: repo.repo_id,
          repo_name: repo.name,
          label: file.path,
          detail:
            file.line_count > 0
              ? `${repo.name} @ ${repo.commit_sha.slice(0, 7)} · ${file.line_count} lines`
              : `${repo.name} @ ${repo.commit_sha.slice(0, 7)}`,
          reference: {
            kind: "file",
            repo_id: repo.repo_id,
            commit_sha: repo.commit_sha,
            path: file.path,
            line_start: null,
            line_end: null,
            symbol: null,
          },
        });
      if (start !== null || pathQuery === "") continue;
      for (const symbol of file.symbols) {
        if (!symbol.name.toLowerCase().includes(pathQuery)) continue;
        symbols.push({
          key: `${repo.repo_id}@${repo.commit_sha}:${file.path}#${symbol.name}`,
          kind: "symbol",
          repo_id: repo.repo_id,
          repo_name: repo.name,
          label: symbol.name,
          detail: `${file.path}:${symbol.line} · ${repo.name} @ ${repo.commit_sha.slice(0, 7)}`,
          reference: {
            kind: "symbol",
            repo_id: repo.repo_id,
            commit_sha: repo.commit_sha,
            path: file.path,
            line_start: symbol.line,
            line_end: symbol.line,
            symbol: symbol.name,
          },
        });
      }
    }
  }
  const exact = (c: MentionCandidate) =>
    c.label.toLowerCase() === pathQuery ||
    c.label.toLowerCase() === `@${pathQuery}` ||
    c.label.toLowerCase().endsWith(`/${pathQuery}`);
  const rank = (list: MentionCandidate[]) =>
    list.sort((a, b) => {
      const ea = exact(a) ? 0 : 1;
      const eb = exact(b) ? 0 : 1;
      if (ea !== eb) return ea - eb;
      return 0;
    });
  return [
    ...rank(agents),
    ...rank(people),
    ...rank(symbols),
    ...rank(files),
  ].slice(0, Math.max(1, limit));
}

const USER_MENTION_RE = /(?:^|[\s(])@([A-Za-z0-9][A-Za-z0-9._-]{0,63})\b/g;
const MARS_INVOCATION_RE = /^\s*@mars(?:\s+([\s\S]+))?$/i;

/** Extract distinct teammate `@handles` from a message body (excluding `@MARS`). */
export function extractUserMentions(text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.matchAll(USER_MENTION_RE)) {
    const handle = match[1];
    if (!handle || handle.toLowerCase() === "mars") continue;
    seen.add(handle);
  }
  return [...seen];
}

/**
 * Detect an explicit `@MARS <prompt>` composer invocation. Returns the trimmed
 * prompt when the draft invokes `@MARS`, or `null` for ordinary messages.
 */
export function parseMarsInvocation(text: string): { prompt: string } | null {
  const match = MARS_INVOCATION_RE.exec(text);
  if (!match) return null;
  const prompt = (match[1] ?? "").trim();
  if (prompt.length === 0) return null;
  return { prompt };
}

/** Chip text: repo · path · short SHA · range. */
export function chipLabel(reference: ReferenceInput, repoName: string): string {
  const range =
    reference.line_start === null
      ? ""
      : reference.line_end === reference.line_start
        ? `:${reference.line_start}`
        : `:${reference.line_start}-${reference.line_end}`;
  const symbol = reference.symbol ? ` (${reference.symbol})` : "";
  return `${repoName} · ${reference.path}${range} @ ${reference.commit_sha.slice(0, 7)}${symbol}`;
}
