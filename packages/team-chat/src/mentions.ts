import type { ReferenceInput } from "./schemas";
import type { MentionIndex } from "./service";

/** One row of the `@` picker. `reference` is what the composer attaches when chosen. */
export interface MentionCandidate {
  key: string;
  kind: "file" | "symbol" | "range";
  repo_id: string;
  repo_name: string;
  label: string;
  detail: string;
  reference: ReferenceInput;
}

export const MAX_MENTION_CANDIDATES = 8;

const QUERY = /^(?<path>[^:\s]*)(?::(?<start>\d+)(?:-(?<end>\d+))?)?$/;

/**
 * Candidates for a picker query. Syntax: `path`, `path:10`, `path:10-20`, or a
 * symbol name. The active repo is searched first, then the other repos the
 * viewer can read. Results are deterministic for a given index and query.
 */
export function mentionCandidates(
  index: MentionIndex,
  query: string,
  activeRepoId: string | null,
  limit = MAX_MENTION_CANDIDATES,
): MentionCandidate[] {
  const match = QUERY.exec(query.trim());
  const pathQuery = (match?.groups?.path ?? query).toLowerCase();
  const start = match?.groups?.start ? Number(match.groups.start) : null;
  const end = match?.groups?.end ? Number(match.groups.end) : start;
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
        if (start >= 1 && end >= start && end <= file.line_count)
          files.push({
            key: `${repo.repo_id}:${file.path}:${start}-${end}`,
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
          key: `${repo.repo_id}:${file.path}`,
          kind: "file",
          repo_id: repo.repo_id,
          repo_name: repo.name,
          label: file.path,
          detail: `${repo.name} @ ${repo.commit_sha.slice(0, 7)} · ${file.line_count} lines`,
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
          key: `${repo.repo_id}:${file.path}#${symbol.name}`,
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
    c.label.toLowerCase().endsWith(`/${pathQuery}`);
  const rank = (list: MentionCandidate[]) =>
    list.sort((a, b) => {
      const ea = exact(a) ? 0 : 1;
      const eb = exact(b) ? 0 : 1;
      if (ea !== eb) return ea - eb;
      return 0;
    });
  return [...rank(symbols), ...rank(files)].slice(0, Math.max(1, limit));
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
