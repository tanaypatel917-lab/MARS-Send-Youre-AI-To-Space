/**
 * Host-trusted remote Git repository mirror & pinned-commit fetcher.
 *
 * Allows a Team Chat server to resolve pinned-commit code references for
 * repositories hosted remotely (e.g. GitHub HTTPS URLs) so teammates on
 * different machines can quote exact commits without sharing a local checkout.
 *
 * Security discipline:
 * - Only host-registered remote URLs (never client-supplied URLs) are fetched.
 * - Only `https://` URLs are allowed by default (`file://` requires explicit
 *   `allowLocalFileUrl: true` for offline tests); `ssh://`, `git://`, `ext::`,
 *   and option-like strings (`-...`) are rejected.
 * - Every git subprocess uses argv-only execution, isolated HOME, disabled
 *   hooks/fsmonitor/askpass/credential-helper, explicit `protocol.allow=never`
 *   with only the validated scheme re-enabled, and hard timeouts.
 * - Optional auth headers are passed only via `-c http.extraHeader=...` per
 *   command and are never written into `.git/config` or error messages.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { gitEnvironment } from "./git";
import { RepoRegistrationFailed, type RepoRegistry } from "./registry";
import { COMMIT_SHA_PATTERN, RepoIdSchema, type RepoSummary } from "./schemas";

export const RemoteRepoRegistrationSchema = z
  .object({
    repo_id: RepoIdSchema,
    url: z.string().min(1).max(2048),
    label: z.string().min(1).max(200),
    /** Optional HTTP Authorization header value (e.g. `Bearer ...` or `Basic ...`). */
    auth_header: z.string().min(1).max(4096).optional(),
  })
  .strict();

export type RemoteRepoRegistration = z.infer<
  typeof RemoteRepoRegistrationSchema
>;

export interface RemoteRepoMirrorOptions {
  /** Base directory where bare mirror clones (`<repo_id>.git`) are stored. */
  readonly cacheDir: string;
  /** Target `RepoRegistry` into which synced mirrors are registered. */
  readonly registry: RepoRegistry;
  /** Allow `file://` remote URLs (for offline tests only; default `false`). */
  readonly allowLocalFileUrl?: boolean;
  /** Timeout for clone/fetch operations in milliseconds (default 30_000). */
  readonly fetchTimeoutMs?: number;
  /** Minimum interval in ms before retrying a failed fetch of the same commit (default 15_000). */
  readonly negativeCacheMs?: number;
  /** Clock in milliseconds (tests inject). */
  readonly nowMs?: () => number;
}

export interface RemoteRepoMirror {
  /**
   * Clones (if absent) or opens the bare mirror for `input.repo_id` and
   * registers it in the backing `RepoRegistry`.
   */
  registerRemote(input: RemoteRepoRegistration): Promise<RepoSummary>;
  /**
   * Ensures `commit_sha` is present in the bare mirror for `repo_id` by
   * fetching from the registered remote URL if needed. Returns `true` if a
   * fetch succeeded, `false` if the repo is not remote-backed or fetch failed.
   */
  ensureCommit(repo_id: string, commit_sha: string): Promise<boolean>;
  /** Lists registered remote repository ids (without exposing URLs or credentials). */
  listRemotes(): string[];
}

interface RemoteEntry {
  readonly repo_id: string;
  readonly url: string;
  readonly scheme: "https" | "file";
  readonly mirrorDir: string;
  readonly authHeader: string | undefined;
}

function validateRemoteUrl(
  raw: string,
  allowLocalFileUrl: boolean,
): { url: string; scheme: "https" | "file" } | null {
  if (raw.startsWith("-") || /[\r\n\0]/.test(raw)) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol === "https:") {
    if (!parsed.hostname) return null;
    return { url: parsed.toString(), scheme: "https" };
  }
  if (parsed.protocol === "file:" && allowLocalFileUrl) {
    return { url: parsed.toString(), scheme: "file" };
  }
  return null;
}

function remoteGitConfigArgs(
  scheme: "https" | "file",
  url: string,
  authHeader: string | undefined,
): string[] {
  const configs = [
    "core.fsmonitor=false",
    "core.hooksPath=/dev/null",
    "core.pager=cat",
    "core.editor=:",
    "core.sshCommand=:",
    "core.askPass=",
    "credential.helper=",
    "protocol.allow=never",
    `protocol.${scheme}.allow=always`,
  ];
  if (authHeader && scheme === "https") {
    if (/[\r\n\0]/.test(authHeader))
      throw new RepoRegistrationFailed("invalid_registration");
    const origin = new URL(url).origin;
    configs.push(`http.${origin}/.extraHeader=Authorization: ${authHeader}`);
  }
  return [
    "--no-replace-objects",
    "--literal-pathspecs",
    ...configs.flatMap((kv) => ["-c", kv]),
  ];
}

async function runRemoteGit(options: {
  args: string[];
  cwd: string;
  homeDir: string;
  timeoutMs: number;
}): Promise<{ ok: boolean }> {
  const proc = Bun.spawn(["git", ...options.args], {
    cwd: options.cwd,
    env: gitEnvironment({ homeDir: options.homeDir }),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill("SIGKILL");
    } catch {
      // already exited
    }
  }, options.timeoutMs);
  try {
    const code = await proc.exited;
    return { ok: !timedOut && code === 0 };
  } finally {
    clearTimeout(timer);
  }
}

export function createRemoteRepoMirror(
  options: RemoteRepoMirrorOptions,
): RemoteRepoMirror {
  if (!isAbsolute(options.cacheDir))
    throw new RepoRegistrationFailed("dir_not_absolute");
  mkdirSync(options.cacheDir, { recursive: true, mode: 0o700 });
  chmodSync(options.cacheDir, 0o700);
  const canonicalCacheDir = realpathSync.native(resolve(options.cacheDir));
  const homeDir = join(tmpdir(), "mars-code-refs-remote-home");
  mkdirSync(homeDir, { recursive: true, mode: 0o700 });

  const allowLocalFileUrl = options.allowLocalFileUrl ?? false;
  const fetchTimeoutMs = Math.max(1000, options.fetchTimeoutMs ?? 30_000);
  const negativeCacheMs = Math.max(0, options.negativeCacheMs ?? 15_000);
  const nowMs = options.nowMs ?? (() => Date.now());

  const remotes = new Map<string, RemoteEntry>();
  const inflight = new Map<string, Promise<boolean>>();
  const failedAt = new Map<string, number>();

  const ensureCommitImpl = async (
    entry: RemoteEntry,
    commitSha: string,
  ): Promise<boolean> => {
    const baseFlags = remoteGitConfigArgs(
      entry.scheme,
      entry.url,
      entry.authHeader,
    );
    // Try direct SHA fetch first (supported by GitHub and modern git servers).
    const direct = await runRemoteGit({
      args: [
        ...baseFlags,
        "fetch",
        "--no-tags",
        "--depth=1",
        "--",
        entry.url,
        commitSha,
      ],
      cwd: entry.mirrorDir,
      homeDir,
      timeoutMs: fetchTimeoutMs,
    });
    if (direct.ok) return true;

    // Fallback for remotes that disable uploadpack.allowReachableSHA1InWant:
    // fetch heads into the bare mirror so commits reachable from branches resolve.
    const heads = await runRemoteGit({
      args: [
        ...baseFlags,
        "fetch",
        "--no-tags",
        "--",
        entry.url,
        "+refs/heads/*:refs/heads/*",
      ],
      cwd: entry.mirrorDir,
      homeDir,
      timeoutMs: fetchTimeoutMs,
    });
    return heads.ok;
  };

  const mirror: RemoteRepoMirror = {
    async registerRemote(input) {
      const parsed = RemoteRepoRegistrationSchema.safeParse(input);
      if (!parsed.success)
        throw new RepoRegistrationFailed("invalid_registration");
      const { repo_id, label, auth_header } = parsed.data;
      const validated = validateRemoteUrl(parsed.data.url, allowLocalFileUrl);
      if (!validated) throw new RepoRegistrationFailed("invalid_registration");
      if (remotes.has(repo_id) || options.registry.has(repo_id))
        throw new RepoRegistrationFailed("repo_id_taken");

      const urlHash = createHash("sha256")
        .update(validated.url)
        .digest("hex")
        .slice(0, 16);
      const mirrorDir = join(canonicalCacheDir, `${repo_id}-${urlHash}.git`);
      const baseFlags = remoteGitConfigArgs(
        validated.scheme,
        validated.url,
        auth_header,
      );
      if (!existsSync(mirrorDir)) {
        const cloned = await runRemoteGit({
          args: [
            ...baseFlags,
            "clone",
            "--bare",
            "--no-tags",
            "--",
            validated.url,
            mirrorDir,
          ],
          cwd: canonicalCacheDir,
          homeDir,
          timeoutMs: fetchTimeoutMs,
        });
        if (!cloned.ok) throw new RepoRegistrationFailed("dir_not_git");
      }

      const canonicalMirror = realpathSync.native(mirrorDir);
      const summary = await options.registry.register({
        repo_id,
        dir: canonicalMirror,
        label,
      });
      remotes.set(repo_id, {
        repo_id,
        url: validated.url,
        scheme: validated.scheme,
        mirrorDir: canonicalMirror,
        authHeader: auth_header,
      });
      return summary;
    },

    async ensureCommit(repo_id, commit_sha) {
      if (!COMMIT_SHA_PATTERN.test(commit_sha)) return false;
      const entry = remotes.get(repo_id);
      if (!entry) return false;
      const key = `${repo_id}:${commit_sha}`;
      const existing = inflight.get(key);
      if (existing) return existing;

      const lastFailure = failedAt.get(key);
      if (
        lastFailure !== undefined &&
        negativeCacheMs > 0 &&
        nowMs() - lastFailure < negativeCacheMs
      )
        return false;

      const run = ensureCommitImpl(entry, commit_sha)
        .then((ok) => {
          if (ok) failedAt.delete(key);
          else failedAt.set(key, nowMs());
          return ok;
        })
        .catch(() => {
          failedAt.set(key, nowMs());
          return false;
        })
        .finally(() => {
          inflight.delete(key);
        });
      inflight.set(key, run);
      return run;
    },

    listRemotes() {
      return [...remotes.keys()];
    },
  };

  const prevEnsure = options.registry.ensureCommit;
  options.registry.ensureCommit = async (repo_id, commit_sha) => {
    if (remotes.has(repo_id)) {
      return mirror.ensureCommit(repo_id, commit_sha);
    }
    if (prevEnsure) {
      return prevEnsure(repo_id, commit_sha);
    }
    return false;
  };

  return mirror;
}
