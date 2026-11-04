import type { GitResult } from "./git";
import { validateLocator } from "./locator";
import type { RepoRegistry } from "./registry";
import {
  type Locator,
  type ResolvedReference,
  type ResolveErrorReason,
  type ResolveLimits,
  type ResolveLimitsInput,
  ResolveLimitsSchema,
} from "./schemas";

const MODE_SYMLINK = "120000";
const MODE_SUBMODULE = "160000";
const BINARY_PROBE_BYTES = 8 * 1024;

type Located = Pick<Locator, "repo_id" | "commit_sha" | "path"> & {
  git_version: string | null;
};

function failure(result: GitResult): ResolveErrorReason | null {
  if (result.spawn_error) return "git_unavailable";
  if (result.timed_out) return "timeout";
  if (result.truncated) return "output_truncated";
  return null;
}

function decodeAscii(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes).trim();
}

function sha256Hex(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

function isBinary(bytes: Uint8Array): boolean {
  const probe = bytes.subarray(0, Math.min(bytes.length, BINARY_PROBE_BYTES));
  return probe.includes(0);
}

export function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

interface TreeEntry {
  mode: string;
  type: string;
  object: string;
}

/** Parses one `git ls-tree -z` record: `<mode> SP <type> SP <object> TAB <path> NUL`. */
function parseTreeEntry(bytes: Uint8Array, path: string): TreeEntry | null {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const records = text.split("\0").filter((record) => record.length > 0);
  for (const record of records) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    if (record.slice(tab + 1) !== path) continue;
    const [mode, type, object] = record.slice(0, tab).split(" ");
    if (!mode || !type || !object) continue;
    return { mode, type, object };
  }
  return null;
}

/**
 * Resolves a locator against committed objects in a host-trusted repository.
 * The caller must already have authorised the viewer for `repo_id`; this
 * function performs no access control. Results never carry the repository
 * directory or any absolute path.
 */
export async function resolveReference(
  registry: RepoRegistry,
  input: unknown,
  limitsInput: ResolveLimitsInput = {},
): Promise<ResolvedReference> {
  const limits: ResolveLimits = ResolveLimitsSchema.parse(limitsInput);
  const checked = validateLocator(input, limits);
  if (!checked.ok) return { state: "invalid", reason: checked.reason };
  const locator = checked.locator;
  const repo = registry.lookup(locator.repo_id);
  if (!repo)
    return {
      state: "unknown_repo",
      repo_id: locator.repo_id,
      commit_sha: locator.commit_sha,
      path: locator.path,
    };

  const git = registry.git;
  const git_version = await git.version();
  const located: Located = {
    repo_id: locator.repo_id,
    commit_sha: locator.commit_sha,
    path: locator.path,
    git_version,
  };
  const run = (args: string[], maxOutputBytes: number) =>
    git.run({
      args,
      cwd: repo.dir,
      timeoutMs: limits.timeout_ms,
      maxOutputBytes,
    });

  const commit = await run(
    [
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      `${locator.commit_sha}^{commit}`,
    ],
    4096,
  );
  const commitFailure = failure(commit);
  if (commitFailure)
    return { state: "error", ...located, reason: commitFailure };
  if (
    commit.exit_code !== 0 ||
    decodeAscii(commit.stdout) !== locator.commit_sha
  )
    return { state: "unavailable", ...located };

  const tree = await run(
    ["ls-tree", "-z", locator.commit_sha, "--", locator.path],
    64 * 1024,
  );
  const treeFailure = failure(tree);
  if (treeFailure) return { state: "error", ...located, reason: treeFailure };
  if (tree.exit_code !== 0)
    return { state: "error", ...located, reason: "git_error" };
  const entry = parseTreeEntry(tree.stdout, locator.path);
  if (!entry) return { state: "unavailable", ...located };
  if (entry.mode === MODE_SYMLINK)
    return { state: "unsupported_symlink", ...located };
  if (entry.mode === MODE_SUBMODULE || entry.type === "commit")
    return { state: "unsupported_submodule", ...located };
  if (entry.type === "tree") return { state: "is_directory", ...located };
  if (entry.type !== "blob" || !/^[a-f0-9]{40}$/.test(entry.object))
    return { state: "error", ...located, reason: "git_error" };
  const blob_sha = entry.object;

  const size = await run(["cat-file", "-s", blob_sha], 64);
  const sizeFailure = failure(size);
  if (sizeFailure) return { state: "error", ...located, reason: sizeFailure };
  const size_bytes = Number.parseInt(decodeAscii(size.stdout), 10);
  if (
    size.exit_code !== 0 ||
    !Number.isSafeInteger(size_bytes) ||
    size_bytes < 0
  )
    return { state: "error", ...located, reason: "git_error" };
  if (size_bytes > limits.max_blob_bytes)
    return {
      state: "oversized",
      ...located,
      blob_sha,
      size_bytes,
      max_blob_bytes: limits.max_blob_bytes,
    };

  const blob = await run(
    ["cat-file", "blob", blob_sha],
    limits.max_blob_bytes + 1,
  );
  const blobFailure = failure(blob);
  if (blobFailure) return { state: "error", ...located, reason: blobFailure };
  if (blob.exit_code !== 0 || blob.stdout.length !== size_bytes)
    return { state: "error", ...located, reason: "git_error" };
  if (isBinary(blob.stdout)) return { state: "binary", ...located, blob_sha };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(blob.stdout);
  } catch {
    return { state: "binary", ...located, blob_sha };
  }

  const lines = splitLines(text);
  const total_lines = lines.length;
  let line_start: number;
  let line_end: number;
  let truncated = false;
  if (locator.line_start !== null && locator.line_end !== null) {
    if (locator.line_start > total_lines || locator.line_end > total_lines)
      return {
        state: "range_out_of_bounds",
        ...located,
        blob_sha,
        total_lines,
      };
    line_start = locator.line_start;
    line_end = locator.line_end;
  } else {
    line_start = 1;
    line_end = Math.min(total_lines, limits.max_range_lines);
    truncated = total_lines > limits.max_range_lines;
  }
  const excerpt =
    total_lines === 0 ? "" : lines.slice(line_start - 1, line_end).join("\n");
  return {
    state: "ok",
    ...located,
    blob_sha,
    line_start: total_lines === 0 ? 1 : line_start,
    line_end: total_lines === 0 ? 1 : line_end,
    total_lines,
    text: excerpt,
    text_sha256: sha256Hex(excerpt),
    truncated,
  };
}
