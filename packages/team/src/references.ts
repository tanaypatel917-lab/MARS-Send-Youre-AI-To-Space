import {
  type RepoRegistry,
  resolveReference,
  searchPaths,
  validateLocator,
} from "@mars/code-refs";
import type { GitRangeReference, ReferencePreview } from "@mars/contracts";
import {
  invalidInput,
  rateLimited,
  referenceNotFound,
  TeamError,
  unavailable,
} from "./errors";
import type {
  CreateReferenceParams,
  PathSearchResult,
  SearchPathsParams,
} from "./protocol";
import type { TeamActor, TeamStore } from "./store";

export interface ReferenceServiceOptions {
  store: TeamStore;
  /** The host's `@mars/code-refs` registry: `repo_id` → trusted directory. */
  repos: RepoRegistry;
  /** Milliseconds clock for the per-user resolve rate limit (tests inject). */
  now?: () => number;
}

/**
 * Authorization layer over `@mars/code-refs` (which performs none). Every call
 * re-reads team membership, conversation visibility and `repo_access` from
 * the store; nothing is cached, so a revocation is visible to the next call.
 */
export interface ReferenceService {
  create(
    actor: TeamActor,
    input: CreateReferenceParams,
  ): Promise<GitRangeReference>;
  resolve(actor: TeamActor, referenceId: string): Promise<ReferencePreview>;
  searchPaths(
    actor: TeamActor,
    input: SearchPathsParams,
  ): Promise<PathSearchResult>;
}

const RATE_WINDOW_MS = 60_000;

export function createReferenceService(
  options: ReferenceServiceOptions,
): ReferenceService {
  const { store, repos } = options;
  const now = options.now ?? (() => Date.now());
  const limits = store.limits;
  const resolveLimits = {
    max_blob_bytes: limits.max_preview_blob_bytes,
    max_range_lines: limits.max_preview_lines,
  };
  const resolves = new Map<string, number[]>();

  const takeResolveSlot = (actor: TeamActor) => {
    const key = `${actor.team_id}\n${actor.user_id}`;
    const current = now();
    const recent = (resolves.get(key) ?? []).filter(
      (at) => current - at < RATE_WINDOW_MS,
    );
    if (recent.length >= limits.max_resolves_per_minute) {
      resolves.set(key, recent);
      const oldest = recent[0] ?? current;
      throw rateLimited(
        "Reference resolve rate exceeded",
        Math.max(1, Math.ceil((oldest + RATE_WINDOW_MS - current) / 1000)),
      );
    }
    recent.push(current);
    resolves.set(key, recent);
  };

  const locatorOf = (reference: GitRangeReference) => ({
    repo_id: reference.repo_id,
    commit_sha: reference.commit_sha,
    path: reference.path,
    ...(reference.line_start !== null && reference.line_end !== null
      ? { line_start: reference.line_start, line_end: reference.line_end }
      : {}),
  });

  return {
    async create(actor, input) {
      const check = validateLocator(input, {
        max_range_lines: limits.max_preview_lines,
      });
      if (!check.ok) throw invalidInput("Invalid reference locator");
      const locator = check.locator;
      store.requireRepoAccess(actor, locator.repo_id);
      const resolved = await resolveReference(
        repos,
        {
          repo_id: locator.repo_id,
          commit_sha: locator.commit_sha,
          path: locator.path,
          ...(locator.line_start !== null && locator.line_end !== null
            ? { line_start: locator.line_start, line_end: locator.line_end }
            : {}),
        },
        resolveLimits,
      );
      switch (resolved.state) {
        case "ok":
          return store.putReference(actor, {
            locator,
            resolved_state: "ok",
            blob_sha256: resolved.text_sha256,
          });
        case "binary":
        case "oversized":
          return store.putReference(actor, {
            locator,
            resolved_state: resolved.state,
            blob_sha256: null,
          });
        case "unavailable":
          throw referenceNotFound();
        case "invalid":
        case "is_directory":
        case "unsupported_symlink":
        case "unsupported_submodule":
        case "range_out_of_bounds":
          throw invalidInput("Reference target is not a shareable file range");
        case "unknown_repo":
        case "error":
          throw unavailable("Repository is unavailable");
      }
    },
    async resolve(actor, referenceId) {
      const viewed = store.viewReference(actor, referenceId);
      if (!viewed.accessible) return { state: "restricted" };
      const { reference } = viewed;
      takeResolveSlot(actor);
      const resolved = await resolveReference(
        repos,
        locatorOf(reference),
        resolveLimits,
      );
      // Access may have been revoked while git ran: fail closed.
      if (!store.hasRepoAccess(actor, reference.repo_id))
        return { state: "restricted" };
      const located = {
        reference_id: reference.reference_id,
        repo_id: reference.repo_id,
        commit_sha: reference.commit_sha,
        path: reference.path,
        line_start: reference.line_start,
        line_end: reference.line_end,
      };
      switch (resolved.state) {
        case "ok":
          return {
            state: "ok",
            ...located,
            line_start: resolved.line_start,
            line_end: resolved.line_end,
            text: resolved.text,
            total_lines: resolved.total_lines,
            truncated: resolved.truncated,
          };
        case "unknown_repo":
        case "unavailable":
          return { state: "unavailable", ...located };
        case "invalid":
        case "error":
          return { state: "error", ...located };
        default:
          return { state: resolved.state, ...located };
      }
    },
    async searchPaths(actor, input) {
      const limit = input.limit ?? limits.max_search_hits;
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > limits.max_search_hits
      )
        throw invalidInput("Invalid search limit");
      store.requireRepoAccess(actor, input.repo_id);
      const result = await searchPaths(repos, {
        repo_id: input.repo_id,
        commit_sha: input.commit_sha,
        query: input.query,
        limit,
      });
      switch (result.state) {
        case "ok":
          return {
            state: "ok",
            matches: result.matches.map((match) => ({
              path: match.path,
              rank: match.rank,
            })),
            truncated: result.truncated,
          };
        case "unavailable":
          return { state: "unavailable" };
        case "invalid":
          throw invalidInput("Invalid search input");
        case "unknown_repo":
        case "error":
          throw unavailable("Repository is unavailable");
      }
    },
  };
}
