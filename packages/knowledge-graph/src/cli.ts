/**
 * Sandboxed subprocess runner for the pinned `graphify` CLI (same shape as
 * packages/watch/src/cli.ts). Argv only, stdin detached, allowlisted
 * environment with HOME and the output directory pinned to a private data
 * root, no network-facing variables, capped output, timeout kill. Python is
 * an external runtime: nothing here owns a session, a model or a tool loop.
 */

export interface GraphifyInvocation {
  args: string[];
  cwd: string;
  timeoutMs: number;
  /** Private directory graphify may write to (HOME, GRAPHIFY_OUT, cache). */
  dataRoot: string;
}

export interface GraphifyResult {
  exit_code: number | null;
  stdout: string;
  stderr: string;
  timed_out: boolean;
  truncated: boolean;
  /** The CLI could not be started at all (missing binary, bad path). */
  spawn_error: string | null;
  duration_ms: number;
}

export interface GraphifyRunner {
  run(invocation: GraphifyInvocation): Promise<GraphifyResult>;
}

export interface GraphifyRunnerOptions {
  command: string[];
  maxOutputBytes: number;
  env?: Record<string, string>;
  processEnv?: Record<string, string | undefined>;
}

const INHERITED_ENV = [
  "PATH",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SYSTEMROOT",
  "VIRTUAL_ENV",
] as const;

export function sandboxEnvironment(
  options: Pick<GraphifyRunnerOptions, "env" | "processEnv"> & {
    dataRoot: string;
  },
): Record<string, string> {
  const source = options.processEnv ?? process.env;
  const env: Record<string, string> = {};
  for (const name of INHERITED_ENV) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  env.HOME = options.dataRoot;
  env.XDG_CACHE_HOME = options.dataRoot;
  env.XDG_CONFIG_HOME = options.dataRoot;
  env.GRAPHIFY_OUT = options.dataRoot;
  env.PYTHONIOENCODING = "utf-8";
  env.PYTHONUNBUFFERED = "1";
  env.PYTHONDONTWRITEBYTECODE = "1";
  env.PYTHONNOUSERSITE = "1";
  env.NO_COLOR = "1";
  /* Deny egress at the client-library level: graphify never needs the network
   * for `extract --code-only`, and these make accidental calls fail closed. */
  env.HTTP_PROXY = "http://127.0.0.1:9";
  env.HTTPS_PROXY = "http://127.0.0.1:9";
  env.ALL_PROXY = "http://127.0.0.1:9";
  env.NO_PROXY = "";
  env.PIP_NO_INDEX = "1";
  env.UV_OFFLINE = "1";
  for (const [name, value] of Object.entries(options.env ?? {})) {
    if (/^(MARS_GRAPH_|FAKE_GRAPHIFY_)/.test(name)) env[name] = value;
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

export function createGraphifyRunner(
  options: GraphifyRunnerOptions,
): GraphifyRunner {
  const [executable, ...prefix] = options.command;
  if (!executable) throw new Error("graphify command must not be empty");
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
            dataRoot: invocation.dataRoot,
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
