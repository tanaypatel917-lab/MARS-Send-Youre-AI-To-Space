/**
 * Sandboxed subprocess runner for the external `watch-skill` CLI.
 *
 * The CLI is argv-only (no shell), stdin is detached, the environment is an
 * allowlist with the private data directory and offline policy pinned, output
 * is capped and a timeout kills the process. Python stays an external runtime:
 * nothing here owns a session, a model or a tool loop.
 */

export interface CliInvocation {
  args: string[];
  cwd: string;
  timeoutMs: number;
  /** Overrides the service-wide data directory (per-task isolation). */
  dataRoot?: string;
}

export interface CliResult {
  exit_code: number | null;
  stdout: string;
  stderr: string;
  timed_out: boolean;
  truncated: boolean;
  /** The CLI could not be started at all (missing binary, bad path). */
  spawn_error: string | null;
  duration_ms: number;
}

export interface CliRunner {
  run(invocation: CliInvocation): Promise<CliResult>;
}

export interface CliRunnerOptions {
  command: string[];
  dataRoot: string;
  offline: boolean;
  displayAllowed: boolean;
  maxOutputBytes: number;
  env?: Record<string, string>;
  processEnv?: Record<string, string | undefined>;
}

/** Host variables the CLI may inherit; everything else is dropped. */
const INHERITED_ENV = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SYSTEMROOT",
  "VIRTUAL_ENV",
] as const;

export function sandboxEnvironment(
  options: Pick<
    CliRunnerOptions,
    "dataRoot" | "offline" | "displayAllowed" | "env" | "processEnv"
  >,
): Record<string, string> {
  const source = options.processEnv ?? process.env;
  const env: Record<string, string> = {};
  for (const name of INHERITED_ENV) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  if (options.displayAllowed) {
    for (const name of ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY"]) {
      const value = source[name];
      if (value !== undefined) env[name] = value;
    }
  }
  env.PYTHONIOENCODING = "utf-8";
  env.PYTHONUNBUFFERED = "1";
  env.NO_COLOR = "1";
  env.WATCHSKILL_DATA_DIR = options.dataRoot;
  if (options.offline) {
    env.WATCHSKILL_OFFLINE = "1";
    env.WATCHSKILL_COST_POLICY = "offline_only";
    env.WATCHSKILL_CLOUD_STT_ENABLED = "0";
  }
  for (const [name, value] of Object.entries(options.env ?? {})) {
    if (/^(MARS_WATCH_|FAKE_WATCH_SKILL_)/.test(name)) env[name] = value;
  }
  return env;
}

async function readCapped(
  stream: ReadableStream<Uint8Array> | null,
  cap: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!stream) return { text: "", truncated: false };
  const chunks: Uint8Array[] = [];
  let kept = 0;
  let truncated = false;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (kept >= cap) {
      truncated = true;
      continue;
    }
    const slice = value.subarray(0, Math.min(value.length, cap - kept));
    if (slice.length < value.length) truncated = true;
    chunks.push(slice);
    kept += slice.length;
  }
  return {
    text: new TextDecoder("utf-8", { fatal: false }).decode(
      Buffer.concat(chunks),
    ),
    truncated,
  };
}

export function createCliRunner(options: CliRunnerOptions): CliRunner {
  const [executable, ...prefix] = options.command;
  if (!executable) throw new Error("watch-skill command must not be empty");
  return {
    async run(invocation) {
      const started = Date.now();
      let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
      try {
        child = Bun.spawn([executable, ...prefix, ...invocation.args], {
          cwd: invocation.cwd,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          env: sandboxEnvironment({
            ...options,
            dataRoot: invocation.dataRoot ?? options.dataRoot,
          }),
        });
      } catch (error) {
        return {
          exit_code: null,
          stdout: "",
          stderr: "",
          timed_out: false,
          truncated: false,
          spawn_error: error instanceof Error ? error.message : String(error),
          duration_ms: Date.now() - started,
        };
      }
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGKILL");
        } catch {}
      }, invocation.timeoutMs);
      try {
        const [stdout, stderr, exitCode] = await Promise.all([
          readCapped(child.stdout, options.maxOutputBytes),
          readCapped(child.stderr, Math.min(options.maxOutputBytes, 16 * 1024)),
          child.exited,
        ]);
        return {
          exit_code: timedOut ? null : exitCode,
          stdout: stdout.text,
          stderr: stderr.text,
          timed_out: timedOut,
          truncated: stdout.truncated || stderr.truncated,
          spawn_error: null,
          duration_ms: Date.now() - started,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
