import { type RepoRegistry, resolveReference } from "@mars/code-refs";
import type { GitRangeReference } from "@mars/contracts";
import type { TeamReferenceAccess, TeamReferencePort } from "./agent";
import type { TeamActor, TeamStore } from "./store";

export interface AgentReferencePortOptions {
  /** Host-trusted `@mars/code-refs` registry (the one `serveTeam({repos})` uses). */
  repos: RepoRegistry;
  /** Lazy because the store is constructed with this port in its `agent` options. */
  store: () => TeamStore;
  /** Resolved excerpts kept in memory (keyed by `reference_id`; content at a pinned commit never changes). */
  max_cached_excerpts?: number;
}

/**
 * `TeamReferencePort` backed by the PR 4 tables and resolver: `describe` runs
 * synchronously inside the store's authorizing transaction, so the async
 * `git` read happens first in `prepare` (called by the server before
 * `agent.preview` / `agent.request`). Readers are computed per viewer through
 * the same `store.hasRepoAccess` gate `references.resolve` uses; a viewer
 * without access is simply not a reader, which the store renders as
 * `restricted` (no path, label or SHA for that viewer).
 */
export interface AgentReferencePort extends TeamReferencePort {
  prepare(teamId: string, referenceIds: readonly string[]): Promise<void>;
}

const DEFAULT_CACHE = 256;

export function createAgentReferencePort(
  options: AgentReferencePortOptions,
): AgentReferencePort {
  const { repos } = options;
  const maxCached = options.max_cached_excerpts ?? DEFAULT_CACHE;
  /** `reference_id` → excerpt (or null when the object was binary/oversized/unavailable). */
  const excerpts = new Map<string, string | null>();
  const remember = (referenceId: string, text: string | null) => {
    excerpts.delete(referenceId);
    excerpts.set(referenceId, text);
    while (excerpts.size > maxCached) {
      const oldest = excerpts.keys().next().value;
      if (oldest === undefined) break;
      excerpts.delete(oldest);
    }
  };
  const label = (reference: GitRangeReference) =>
    `${reference.repo_id} ${reference.path}@${reference.commit_sha.slice(0, 12)}${
      reference.line_start !== null && reference.line_end !== null
        ? `:${reference.line_start}-${reference.line_end}`
        : ""
    }`;

  return {
    async prepare(teamId, referenceIds) {
      const store = options.store();
      const limits = {
        max_blob_bytes: store.limits.max_preview_blob_bytes,
        max_range_lines: store.limits.max_preview_lines,
      };
      for (const reference of store.getReferences(teamId, referenceIds)) {
        if (excerpts.has(reference.reference_id)) continue;
        const resolved = await resolveReference(
          repos,
          {
            repo_id: reference.repo_id,
            commit_sha: reference.commit_sha,
            path: reference.path,
            ...(reference.line_start !== null && reference.line_end !== null
              ? {
                  line_start: reference.line_start,
                  line_end: reference.line_end,
                }
              : {}),
          },
          limits,
        );
        remember(
          reference.reference_id,
          resolved.state === "ok" &&
            (reference.blob_sha256 === null ||
              resolved.text_sha256 === reference.blob_sha256)
            ? resolved.text
            : null,
        );
      }
    },
    describe({ team_id, reference_ids, viewers }) {
      const store = options.store();
      const result: TeamReferenceAccess[] = [];
      for (const reference of store.getReferences(team_id, reference_ids)) {
        const text = excerpts.get(reference.reference_id);
        // Not prepared or not readable as text: unknown to the store, i.e. unreadable by everyone.
        if (text === undefined || text === null) continue;
        const readers = viewers.filter((user_id) => {
          const viewer: TeamActor = { team_id, user_id };
          return store.hasRepoAccess(viewer, reference.repo_id);
        });
        result.push({
          reference_id: reference.reference_id,
          label: label(reference),
          text,
          readers,
        });
      }
      return result;
    },
  };
}
