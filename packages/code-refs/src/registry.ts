/**
 * Host-trusted `repo_id -> directory` mapping. Only the host registers
 * entries at startup; nothing a client sends can add a repository or look
 * one up by path. Directories must be absolute, free of symlinks, disjoint
 * from every other registered directory, and either a work tree root or a
 * git directory.
 */
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { createGitRunner, type GitRunner } from "./git";
import {
  type RepoRegistration,
  RepoRegistrationSchema,
  type RepoSummary,
} from "./schemas";

export type RepoRegistrationError =
  | "invalid_registration"
  | "dir_not_absolute"
  | "dir_not_directory"
  | "dir_is_symlink"
  | "dir_not_canonical"
  | "dir_not_git"
  | "repo_id_taken"
  | "dir_overlaps_registered"
  | "git_unavailable";

/** Fixed-message error; never carries the directory. */
export class RepoRegistrationFailed extends Error {
  constructor(readonly code: RepoRegistrationError) {
    super(`Repository registration rejected: ${code}`);
    this.name = "RepoRegistrationFailed";
  }
}

export interface RegisteredRepo {
  repo_id: string;
  label: string;
  /** Host-internal; never returned to clients or placed in results. */
  dir: string;
}

export interface RepoRegistry {
  register(input: RepoRegistration): Promise<RepoSummary>;
  has(repo_id: string): boolean;
  list(): RepoSummary[];
  /** Host-internal lookup used by the resolver; undefined for unknown ids. */
  lookup(repo_id: string): RegisteredRepo | undefined;
  readonly git: GitRunner;
}

export interface RepoRegistryOptions {
  git?: GitRunner;
  /** Milliseconds allowed for the `git rev-parse` probe at registration. */
  probeTimeoutMs?: number;
}

function contains(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  if (rel === "") return true;
  if (rel === ".." || rel.startsWith(`..${sep}`)) return false;
  return !isAbsolute(rel);
}

function stripTrailingSeparator(path: string): string {
  let out = path;
  while (out.length > 1 && out.endsWith(sep)) out = out.slice(0, -1);
  return out;
}

export function createRepoRegistry(
  options: RepoRegistryOptions = {},
): RepoRegistry {
  const git = options.git ?? createGitRunner();
  const probeTimeoutMs = options.probeTimeoutMs ?? 10_000;
  const repos = new Map<string, RegisteredRepo>();

  const probe = async (dir: string, args: string[]): Promise<string[]> => {
    const result = await git.run({
      args,
      cwd: dir,
      timeoutMs: probeTimeoutMs,
      maxOutputBytes: 64 * 1024,
    });
    if (result.spawn_error) throw new RepoRegistrationFailed("git_unavailable");
    if (result.timed_out || result.exit_code !== 0 || result.truncated)
      throw new RepoRegistrationFailed("dir_not_git");
    return new TextDecoder("utf-8", { fatal: false })
      .decode(result.stdout)
      .split("\n")
      .map((line) => line.trim());
  };

  const canonical = (path: string): string => {
    try {
      return stripTrailingSeparator(realpathSync.native(path));
    } catch {
      throw new RepoRegistrationFailed("dir_not_directory");
    }
  };

  let chain: Promise<unknown> = Promise.resolve();

  const registerUnlocked = async (
    input: RepoRegistration,
  ): Promise<RepoSummary> => {
    const parsed = RepoRegistrationSchema.safeParse(input);
    if (!parsed.success)
      throw new RepoRegistrationFailed("invalid_registration");
    const { repo_id, label } = parsed.data;
    if (!isAbsolute(parsed.data.dir))
      throw new RepoRegistrationFailed("dir_not_absolute");
    const dir = stripTrailingSeparator(parsed.data.dir);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(dir);
    } catch {
      throw new RepoRegistrationFailed("dir_not_directory");
    }
    if (stat.isSymbolicLink())
      throw new RepoRegistrationFailed("dir_is_symlink");
    if (!stat.isDirectory())
      throw new RepoRegistrationFailed("dir_not_directory");
    if (canonical(dir) !== dir)
      throw new RepoRegistrationFailed("dir_not_canonical");
    if (repos.has(repo_id)) throw new RepoRegistrationFailed("repo_id_taken");
    for (const existing of repos.values())
      if (contains(existing.dir, dir) || contains(dir, existing.dir))
        throw new RepoRegistrationFailed("dir_overlaps_registered");

    const [isBare, gitDir] = await probe(dir, [
      "rev-parse",
      "--is-bare-repository",
      "--absolute-git-dir",
    ]);
    if (gitDir === undefined || (isBare !== "true" && isBare !== "false"))
      throw new RepoRegistrationFailed("dir_not_git");
    if (canonical(gitDir) !== dir) {
      if (isBare === "true") throw new RepoRegistrationFailed("dir_not_git");
      const [toplevel] = await probe(dir, ["rev-parse", "--show-toplevel"]);
      if (toplevel === undefined || toplevel === "")
        throw new RepoRegistrationFailed("dir_not_git");
      if (canonical(toplevel) !== dir)
        throw new RepoRegistrationFailed("dir_not_git");
    }

    repos.set(repo_id, { repo_id, label, dir });
    return { repo_id, label };
  };

  return {
    git,
    /** Serialised: the duplicate/overlap checks and the insert never interleave across awaits. */
    register(input) {
      const next = chain.then(() => registerUnlocked(input));
      chain = next.catch(() => undefined);
      return next;
    },
    has(repo_id) {
      return repos.has(repo_id);
    },
    list() {
      return [...repos.values()].map(({ repo_id, label }) => ({
        repo_id,
        label,
      }));
    },
    lookup(repo_id) {
      return repos.get(repo_id);
    },
  };
}
