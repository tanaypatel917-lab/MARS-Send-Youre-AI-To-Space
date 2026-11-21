import {
  createDockerSandbox,
  type DockerSandboxOptions,
  type SandboxRunner,
  type SandboxRunRequest,
  type SandboxRunResult,
} from "@mars/workspaces";

/** Default pinned Bun image for Docker-isolated candidate builds (`--network=none`). */
export const DEFAULT_EVOLUTION_DOCKER_IMAGE =
  "oven/bun@sha256:5148f6742ac31fac28e6eab391ab1f11f6dfc0c8512c7a3679b374ec470f5982";

export type EvolutionDockerSandboxOptions = Partial<DockerSandboxOptions>;

/**
 * Docker-isolated candidate build runner (`--network=none`, `--read-only`,
 * `--cap-drop=ALL`, `--security-opt=no-new-privileges`, `--ipc=none`,
 * non-root `--user`, memory/CPU/PIDs/tmpfs limits, and only the candidate
 * workspace mounted at `/workspace`).
 *
 * Requires a pinned `image@sha256:...` digest present locally (defaults to
 * `DEFAULT_EVOLUTION_DOCKER_IMAGE`).
 */
export function createEvolutionDockerSandbox(
  options: EvolutionDockerSandboxOptions = {},
): SandboxRunner {
  return createDockerSandbox({
    image: options.image ?? DEFAULT_EVOLUTION_DOCKER_IMAGE,
    ...options,
  });
}

export interface ProcessSandboxOptions {
  /** Absolute `setsid` used to give each build its own process group. */
  setsidPath?: string;
  /** PATH handed to the build; nothing else from the host environment is passed. */
  path?: string;
  killGraceMs?: number;
}

async function readCapped(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<{ data: Uint8Array; truncated: boolean }> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  const reader = stream.getReader();
  for (;;) {
    const { done, value: chunk } = await reader.read();
    if (done) break;
    if (size >= limit) {
      truncated = true;
      continue;
    }
    const take = chunk.subarray(0, limit - size);
    if (take.byteLength < chunk.byteLength) truncated = true;
    chunks.push(take);
    size += take.byteLength;
  }
  const data = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { data, truncated };
}

function killGroup(pid: number, graceMs: number): void {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    return;
  }
  setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // already gone
    }
  }, graceMs).unref();
}

/**
 * Host-process build runner for offline tests and single-user development.
 * It gives the build a separate process group, a scrubbed environment
 * (PATH, HOME and TMPDIR inside the workspace) and a deadline, but it is
 * **not an OS boundary**: a hostile build can still reach absolute host paths.
 * The evolution guard therefore re-digests every protected control file
 * after each build (detection). Use `createDockerSandbox` from
 * `@mars/workspaces` for prevention: only the candidate tree is mounted.
 */
export function createProcessSandbox(
  options: ProcessSandboxOptions = {},
): SandboxRunner {
  const setsid = options.setsidPath ?? "/usr/bin/setsid";
  const graceMs = options.killGraceMs ?? 2000;
  return {
    isolation: "host-process-detection-only",
    async verify() {
      if (!(await Bun.file(setsid).exists()))
        throw new Error(`setsid not found at ${setsid}`);
    },
    async run(request: SandboxRunRequest): Promise<SandboxRunResult> {
      const child = Bun.spawn([setsid, ...request.argv], {
        cwd: request.workspaceDir,
        env: {
          PATH: options.path ?? "/usr/local/bin:/usr/bin:/bin",
          HOME: request.workspaceDir,
          TMPDIR: request.workspaceDir,
          LANG: "C.UTF-8",
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      let timedOut = false;
      let cancelled = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup(child.pid, graceMs);
      }, request.timeoutMs);
      const onAbort = () => {
        cancelled = true;
        killGroup(child.pid, graceMs);
      };
      if (request.signal.aborted) onAbort();
      request.signal.addEventListener("abort", onAbort, { once: true });
      try {
        const [stdout, stderr, exitCode] = await Promise.all([
          readCapped(child.stdout, request.maxOutputBytes),
          readCapped(child.stderr, request.maxOutputBytes),
          child.exited,
        ]);
        return {
          exitCode,
          stdout: stdout.data,
          stderr: stderr.data,
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
          timedOut,
          cancelled,
        };
      } finally {
        clearTimeout(timer);
        request.signal.removeEventListener("abort", onAbort);
      }
    },
    async cleanup() {},
  };
}
