/**
 * Argv-only `git` runner (same discipline as packages/watch/src/cli.ts and
 * packages/knowledge-graph/src/cli.ts): no shell, stdin detached, allowlisted
 * environment with HOME pinned to a private directory and every config,
 * credential, prompt and proxy variable dropped, bounded stdout, timeout
 * kill. Callers place validated values only after `--`.
 */
import { chmodSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface GitInvocation {
  args: string[];
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  /**
   * Called with each stdout chunk; return `false` to stop reading (the child
   * is killed and the result is marked `truncated`).
   */
  onStdout?: (chunk: Uint8Array) => boolean;
}

export interface GitResult {
  exit_code: number | null;
  stdout: Uint8Array;
  stderr: string;
  timed_out: boolean;
  truncated: boolean;
  spawn_error: string | null;
}

export interface GitSpawnOptions {
  cwd: string;
  env: Record<string, string>;
}

export type GitChild = Bun.Subprocess<"ignore", "pipe", "pipe">;

/** Test hook: wraps `Bun.spawn`; the argv and env are what git receives. */
export type GitSpawn = (argv: string[], options: GitSpawnOptions) => GitChild;

export interface GitRunner {
  run(invocation: GitInvocation): Promise<GitResult>;
  /** `git --version`, probed once; `null` when git cannot be started. */
  version(): Promise<string | null>;
}

export interface GitRunnerOptions {
  /** Defaults to `["git"]`; resolved through `PATH` only. */
  command?: string[];
  /** Private writable directory used as HOME; created 0700 if absent. */
  homeDir?: string;
  processEnv?: Record<string, string | undefined>;
  spawn?: GitSpawn;
  versionTimeoutMs?: number;
}

export const GIT_GLOBAL_FLAGS = [
  "--no-replace-objects",
  "--literal-pathspecs",
] as const;

export function gitEnvironment(options: {
  homeDir: string;
  processEnv?: Record<string, string | undefined>;
}): Record<string, string> {
  const source = options.processEnv ?? process.env;
  const env: Record<string, string> = {};
  const path = source.PATH;
  if (path !== undefined) env.PATH = path;
  if (process.platform === "win32" && source.SYSTEMROOT !== undefined)
    env.SYSTEMROOT = source.SYSTEMROOT;
  env.HOME = options.homeDir;
  env.XDG_CONFIG_HOME = options.homeDir;
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_PAGER = "cat";
  env.LC_ALL = "C";
  env.NO_COLOR = "1";
  return env;
}

const defaultSpawn: GitSpawn = (argv, options) =>
  Bun.spawn(argv, {
    cwd: options.cwd,
    env: options.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

function privateHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "mars-code-refs-"));
  chmodSync(dir, 0o700);
  return dir;
}

async function readStdout(
  stream: ReadableStream<Uint8Array> | null,
  cap: number,
  onChunk: ((chunk: Uint8Array) => boolean) | undefined,
  stop: () => void,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!stream) return { bytes: new Uint8Array(0), truncated: false };
  const chunks: Uint8Array[] = [];
  let kept = 0;
  let truncated = false;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (truncated) continue;
    const slice = value.subarray(0, Math.min(value.length, cap - kept));
    if (slice.length < value.length) truncated = true;
    chunks.push(slice);
    kept += slice.length;
    if (!truncated && onChunk && !onChunk(slice)) truncated = true;
    if (truncated) stop();
  }
  return { bytes: Buffer.concat(chunks), truncated };
}

async function readStderr(
  stream: ReadableStream<Uint8Array> | null,
  cap: number,
): Promise<string> {
  if (!stream) return "";
  const chunks: Uint8Array[] = [];
  let kept = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (kept >= cap) continue;
    const slice = value.subarray(0, Math.min(value.length, cap - kept));
    chunks.push(slice);
    kept += slice.length;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(
    Buffer.concat(chunks),
  );
}

export function createGitRunner(options: GitRunnerOptions = {}): GitRunner {
  const command = options.command ?? ["git"];
  const [executable, ...prefix] = command;
  if (!executable) throw new Error("git command must not be empty");
  const spawn = options.spawn ?? defaultSpawn;
  let homeDir: string | undefined = options.homeDir;
  if (homeDir !== undefined) {
    mkdirSync(homeDir, { recursive: true, mode: 0o700 });
    chmodSync(homeDir, 0o700);
  }
  const home = (): string => {
    if (homeDir === undefined) homeDir = privateHome();
    return homeDir;
  };
  let versionProbe: Promise<string | null> | undefined;

  const run = async (invocation: GitInvocation): Promise<GitResult> => {
    const env = gitEnvironment({
      homeDir: home(),
      ...(options.processEnv ? { processEnv: options.processEnv } : {}),
    });
    let child: GitChild;
    try {
      child = spawn(
        [executable, ...prefix, ...GIT_GLOBAL_FLAGS, ...invocation.args],
        { cwd: invocation.cwd, env },
      );
    } catch (error) {
      return {
        exit_code: null,
        stdout: new Uint8Array(0),
        stderr: "",
        timed_out: false,
        truncated: false,
        spawn_error: error instanceof Error ? error.name : "spawn_failed",
      };
    }
    let timedOut = false;
    const kill = (): void => {
      try {
        child.kill("SIGKILL");
      } catch {}
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, invocation.timeoutMs);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        readStdout(
          child.stdout,
          invocation.maxOutputBytes,
          invocation.onStdout,
          kill,
        ),
        readStderr(child.stderr, 16 * 1024),
        child.exited,
      ]);
      return {
        exit_code: timedOut ? null : exitCode,
        stdout: stdout.bytes,
        stderr,
        timed_out: timedOut,
        truncated: stdout.truncated,
        spawn_error: null,
      };
    } finally {
      clearTimeout(timer);
    }
  };

  const version = (): Promise<string | null> => {
    versionProbe ??= (async () => {
      const result = await run({
        args: ["--version"],
        cwd: home(),
        timeoutMs: options.versionTimeoutMs ?? 10_000,
        maxOutputBytes: 4096,
      });
      if (result.spawn_error || result.timed_out || result.exit_code !== 0)
        return null;
      const text = new TextDecoder().decode(result.stdout).trim();
      const match = /^git version (\S+)/.exec(text);
      return match?.[1] ?? null;
    })();
    return versionProbe;
  };

  return { run, version };
}
