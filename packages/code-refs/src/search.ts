import { hasInvisibleCodePoint, validateLocatorPath } from "./path-rules";
import type { RepoRegistry } from "./registry";
import {
  COMMIT_SHA_PATTERN,
  type PathMatch,
  REPO_ID_PATTERN,
  SEARCH_MAX_QUERY_LENGTH,
  type SearchLimits,
  type SearchLimitsInput,
  SearchLimitsSchema,
  type SearchPathsInput,
  SearchPathsInputSchema,
  type SearchPathsResult,
} from "./schemas";

function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? path : path.slice(slash + 1);
}

/** 0 exact file name, 1 file name prefix, 2 path prefix, 3 file name substring, 4 path substring, -1 no match. */
export function rankPath(path: string, query: string): number {
  const lowerPath = path.toLowerCase();
  const lowerName = basename(lowerPath);
  if (lowerName === query) return 0;
  if (lowerName.startsWith(query)) return 1;
  if (lowerPath.startsWith(query)) return 2;
  if (lowerName.includes(query)) return 3;
  if (lowerPath.includes(query)) return 4;
  return -1;
}

export function compareMatches(a: PathMatch, b: PathMatch): number {
  if (a.rank !== b.rank) return a.rank - b.rank;
  if (a.path.length !== b.path.length) return a.path.length - b.path.length;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

const RANKS = 5;

/** Inserts `match` and, past `limit`, drops the worst entry of the bucket. */
function keepBest(bucket: PathMatch[], match: PathMatch, limit: number): void {
  bucket.push(match);
  if (bucket.length <= limit) return;
  let worst = 0;
  for (let i = 1; i < bucket.length; i += 1)
    if (compareMatches(bucket[i] as PathMatch, bucket[worst] as PathMatch) > 0)
      worst = i;
  bucket.splice(worst, 1);
}

function normalizeQuery(query: string): string | null {
  const nfc = query.normalize("NFC").trim().toLowerCase();
  if (nfc.length === 0 || nfc.length > SEARCH_MAX_QUERY_LENGTH) return null;
  if (hasInvisibleCodePoint(nfc)) return null;
  for (const char of nfc)
    if (char.charCodeAt(0) < 0x20 || char === "\u007f") return null;
  return nfc;
}

/**
 * Case-insensitive substring/prefix search over the file names of one
 * commit. The listing is streamed and cut after `max_entries`; only paths
 * that pass the locator path rules are returned. Symbol search is out of
 * scope (the `@mars/context` extractors could back it later).
 */
export async function searchPaths(
  registry: RepoRegistry,
  input: SearchPathsInput,
  limitsInput: SearchLimitsInput = {},
): Promise<SearchPathsResult> {
  const limits: SearchLimits = SearchLimitsSchema.parse(limitsInput);
  const parsed = SearchPathsInputSchema.safeParse(input);
  if (!parsed.success) return { state: "invalid", reason: "invalid_input" };
  const { repo_id, commit_sha, limit } = parsed.data;
  if (!REPO_ID_PATTERN.test(repo_id))
    return { state: "invalid", reason: "invalid_repo_id" };
  if (!COMMIT_SHA_PATTERN.test(commit_sha))
    return { state: "invalid", reason: "invalid_commit_sha" };
  const query = normalizeQuery(parsed.data.query);
  if (query === null) return { state: "invalid", reason: "invalid_query" };
  const repo = registry.lookup(repo_id);
  if (!repo) return { state: "unknown_repo", repo_id, commit_sha };

  const git = registry.git;
  const git_version = await git.version();
  const base = { repo_id, commit_sha, git_version };

  const commit = await git.run({
    args: [
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      `${commit_sha}^{commit}`,
    ],
    cwd: repo.dir,
    timeoutMs: limits.timeout_ms,
    maxOutputBytes: 4096,
  });
  if (commit.spawn_error)
    return { state: "error", ...base, reason: "git_unavailable" };
  if (commit.timed_out) return { state: "error", ...base, reason: "timeout" };
  if (
    commit.exit_code !== 0 ||
    new TextDecoder().decode(commit.stdout).trim() !== commit_sha
  )
    return { state: "unavailable", ...base };

  const decoder = new TextDecoder("utf-8", { fatal: false });
  // One bounded bucket per rank: memory stays at most RANKS * limit matches
  // however broad the query or large the tree.
  const buckets: PathMatch[][] = Array.from({ length: RANKS }, () => []);
  let scanned = 0;
  let skipped = 0;
  let stopped = false;
  let pending = "";
  const consider = (path: string): void => {
    scanned += 1;
    if (!validateLocatorPath(path).ok) {
      skipped += 1;
      return;
    }
    const rank = rankPath(path.normalize("NFC"), query);
    if (rank < 0) return;
    // The committed spelling is returned verbatim: git never normalises names.
    keepBest(buckets[rank] as PathMatch[], { path, rank }, limit);
  };
  const listing = await git.run({
    args: ["ls-tree", "-r", "-z", "--name-only", commit_sha],
    cwd: repo.dir,
    timeoutMs: limits.timeout_ms,
    maxOutputBytes: limits.max_entries * 1025,
    onStdout: (chunk) => {
      pending += decoder.decode(chunk, { stream: true });
      let nul = pending.indexOf("\0");
      while (nul >= 0) {
        if (scanned >= limits.max_entries) {
          stopped = true;
          return false;
        }
        consider(pending.slice(0, nul));
        pending = pending.slice(nul + 1);
        nul = pending.indexOf("\0");
      }
      return true;
    },
  });
  if (listing.spawn_error)
    return { state: "error", ...base, reason: "git_unavailable" };
  if (listing.timed_out) return { state: "error", ...base, reason: "timeout" };
  if (!stopped && !listing.truncated && listing.exit_code !== 0)
    return { state: "error", ...base, reason: "git_error" };
  const matches = buckets
    .flatMap((bucket) => bucket.sort(compareMatches))
    .slice(0, limit);
  return {
    state: "ok",
    ...base,
    matches,
    scanned,
    skipped,
    truncated: stopped || listing.truncated,
  };
}
