import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { SandboxUnavailableError } from "./errors";
import { compareStrings, DEFAULT_WORKSPACE_LIMITS } from "./tree";
import type {
  DockerSandboxOptions,
  SandboxRunner,
  SandboxRunRequest,
  SandboxRunResult,
} from "./types";

export interface ResolvedDockerConfig {
  image: string;
  dockerPath: string;
  uid: number;
  gid: number;
  memoryBytes: number;
  pids: number;
  cpus: number;
  tmpfsBytes: number;
  maxFileBytes: number;
}

export function resolveDockerConfig(
  options: DockerSandboxOptions,
): ResolvedDockerConfig {
  if (!/^[a-z0-9][a-z0-9._/:-]*@sha256:[a-f0-9]{64}$/.test(options.image)) {
    throw new TypeError("Docker image must be pinned to a sha256 digest");
  }
  const dockerPath = options.dockerPath ?? "/usr/bin/docker";
  if (!isAbsolute(dockerPath))
    throw new TypeError("dockerPath must be absolute");
  const config: ResolvedDockerConfig = {
    image: options.image,
    dockerPath,
    uid: options.user?.uid ?? process.getuid?.() ?? 1000,
    gid: options.user?.gid ?? process.getgid?.() ?? 1000,
    memoryBytes: options.memoryBytes ?? 512 * 1024 * 1024,
    pids: options.pids ?? 128,
    cpus: options.cpus ?? 1,
    tmpfsBytes: options.tmpfsBytes ?? 64 * 1024 * 1024,
    maxFileBytes: options.maxFileBytes ?? DEFAULT_WORKSPACE_LIMITS.maxFileBytes,
  };
  if (
    !Number.isSafeInteger(config.uid) ||
    config.uid <= 0 ||
    !Number.isSafeInteger(config.gid) ||
    config.gid <= 0
  ) {
    throw new TypeError(
      "Docker uid and gid must be positive non-root integers",
    );
  }
  for (const [name, value] of Object.entries({
    memoryBytes: config.memoryBytes,
    pids: config.pids,
    tmpfsBytes: config.tmpfsBytes,
    maxFileBytes: config.maxFileBytes,
  })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive safe integer`);
    }
  }
  for (const [name, value] of Object.entries({ cpus: config.cpus })) {
    if (!Number.isFinite(value) || value <= 0)
      throw new TypeError(`${name} must be a positive finite number`);
  }
  return config;
}

export function buildDockerRunArgs(
  resolved: ResolvedDockerConfig,
  request: SandboxRunRequest,
  containerName: string,
): string[] {
  validateResolvedConfig(resolved);
  if (!/^[A-Za-z0-9._-]+$/.test(containerName))
    throw new TypeError("Invalid Docker container name");
  if (containerName !== `mars-ws-${request.runId}`)
    throw new TypeError("Container name must match the run id");
  if (
    !isAbsolute(request.workspaceDir) ||
    !/^[A-Za-z0-9._/-]+$/.test(request.workspaceDir) ||
    request.workspaceDir.split("/").includes("..")
  ) {
    throw new TypeError("Unsafe Docker workspace mount path");
  }
  if (!/^[A-Za-z0-9._-]+$/.test(request.runId))
    throw new TypeError("Invalid workspace run id");
  if (
    !Array.isArray(request.argv) ||
    request.argv.length === 0 ||
    request.argv.length > 256 ||
    request.argv.some(
      (arg) =>
        typeof arg !== "string" ||
        arg.includes("\0") ||
        Buffer.byteLength(arg) > 4096,
    )
  ) {
    throw new TypeError("Invalid command arguments");
  }
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0) {
    throw new TypeError("Invalid timeout");
  }
  if (
    !Number.isSafeInteger(request.maxOutputBytes) ||
    request.maxOutputBytes <= 0
  ) {
    throw new TypeError("Invalid output limit");
  }
  const args = ["run", "--rm", "--pull=never", "--name", containerName];
  for (const [key, value] of Object.entries(request.labels).sort(([a], [b]) =>
    compareStrings(a, b),
  )) {
    if (!/^[A-Za-z0-9._-]+$/.test(key) || !/^[A-Za-z0-9._-]+$/.test(value)) {
      throw new TypeError("Invalid Docker label");
    }
    args.push("--label", `${key}=${value}`);
  }
  args.push(
    "--network",
    "none",
    "--read-only",
    "--user",
    `${resolved.uid}:${resolved.gid}`,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    String(resolved.pids),
    "--memory",
    String(resolved.memoryBytes),
    "--memory-swap",
    String(resolved.memoryBytes),
    "--cpus",
    String(resolved.cpus),
    "--ipc",
    "none",
    "--init",
    "--ulimit",
    "nofile=1024:1024",
    "--ulimit",
    `fsize=${resolved.maxFileBytes}`,
    "--tmpfs",
    `/tmp:rw,noexec,nosuid,nodev,size=${resolved.tmpfsBytes}`,
    "--mount",
    `type=bind,src=${request.workspaceDir},dst=/workspace`,
    "--workdir",
    "/workspace",
    "--env",
    "HOME=/tmp",
    resolved.image,
    ...request.argv,
  );
  return args;
}

function validateResolvedConfig(config: ResolvedDockerConfig): void {
  if (!/^[a-z0-9][a-z0-9._/:-]*@sha256:[a-f0-9]{64}$/.test(config.image)) {
    throw new TypeError("Docker image must be pinned to a sha256 digest");
  }
  if (!isAbsolute(config.dockerPath))
    throw new TypeError("dockerPath must be absolute");
  if (
    !Number.isSafeInteger(config.uid) ||
    config.uid <= 0 ||
    !Number.isSafeInteger(config.gid) ||
    config.gid <= 0
  ) {
    throw new TypeError(
      "Docker uid and gid must be positive non-root integers",
    );
  }
  for (const value of [
    config.memoryBytes,
    config.pids,
    config.tmpfsBytes,
    config.maxFileBytes,
  ]) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(
        "Docker integer limits must be positive safe integers",
      );
    }
  }
  if (!Number.isFinite(config.cpus) || config.cpus <= 0) {
    throw new TypeError("Docker CPU limit must be positive and finite");
  }
}

export function createDockerSandbox(
  options: DockerSandboxOptions,
): SandboxRunner {
  const resolved = resolveDockerConfig(options);
  return {
    isolation: "docker-container",
    async verify(): Promise<void> {
      try {
        await access(resolved.dockerPath, constants.X_OK);
        const version = await invoke(
          resolved,
          ["version", "--format", "{{.Server.Version}}"],
          5000,
        );
        if (version.exitCode !== 0) throw new Error(version.stderr.toString());
        const image = await invoke(
          resolved,
          [
            "image",
            "inspect",
            "--format",
            "{{json .RepoDigests}}",
            resolved.image,
          ],
          5000,
        );
        let repoDigests: unknown;
        try {
          repoDigests = JSON.parse(image.stdout.toString("utf8"));
        } catch {
          repoDigests = undefined;
        }
        if (
          image.exitCode !== 0 ||
          !Array.isArray(repoDigests) ||
          !repoDigests.includes(resolved.image)
        ) {
          throw new Error("Pinned Docker image is not available locally");
        }
      } catch (error) {
        throw new SandboxUnavailableError(
          "Docker daemon or pinned local image is unavailable",
          { cause: error },
        );
      }
    },
    async run(request): Promise<SandboxRunResult> {
      const name = `mars-ws-${request.runId}`;
      const args = buildDockerRunArgs(resolved, request, name);
      let processRef: Bun.Subprocess<"ignore", "pipe", "pipe">;
      try {
        processRef = Bun.spawn([resolved.dockerPath, ...args], {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          env: sandboxEnvironment(),
        });
      } catch (error) {
        throw new SandboxUnavailableError("Unable to start Docker", {
          cause: error,
        });
      }
      const stdoutPromise = readLimited(
        processRef.stdout,
        request.maxOutputBytes,
      );
      const stderrPromise = readLimited(
        processRef.stderr,
        request.maxOutputBytes,
      );
      let timedOut = false;
      let cancelled = false;
      let terminating: Promise<void> | undefined;
      const terminate = (reason: "timeout" | "cancel"): Promise<void> => {
        if (terminating) return terminating;
        timedOut = reason === "timeout";
        cancelled = reason === "cancel";
        terminating = (async () => {
          await invoke(
            resolved,
            ["kill", "--signal", "KILL", name],
            3000,
          ).catch(() => undefined);
          await invoke(resolved, ["rm", "-f", name], 3000).catch(
            () => undefined,
          );
          try {
            processRef.kill("SIGKILL");
          } catch {}
          await waitForContainerGone(resolved, name);
        })();
        void terminating.catch(() => undefined);
        return terminating;
      };
      let timeout: ReturnType<typeof setTimeout> | undefined = setTimeout(
        () => {
          void terminate("timeout");
        },
        request.timeoutMs,
      );
      const abort = (): void => {
        void terminate("cancel");
      };
      request.signal.addEventListener("abort", abort, { once: true });
      if (request.signal.aborted) abort();
      try {
        const [exitCode, stdout, stderr] = await Promise.all([
          processRef.exited,
          stdoutPromise,
          stderrPromise,
        ]);
        if (terminating) await terminating;
        await waitForContainerGone(resolved, name);
        return {
          exitCode: timedOut ? 124 : cancelled ? 130 : exitCode,
          stdout: stdout.bytes,
          stderr: stderr.bytes,
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
          timedOut,
          cancelled,
        };
      } catch (error) {
        if (terminating) await terminating.catch(() => undefined);
        if (error instanceof SandboxUnavailableError) throw error;
        throw new SandboxUnavailableError("Docker command failed", {
          cause: error,
        });
      } finally {
        if (timeout) clearTimeout(timeout);
        timeout = undefined;
        request.signal.removeEventListener("abort", abort);
      }
    },
    async cleanup(labels): Promise<void> {
      const args = ["ps", "-aq"];
      for (const [key, value] of Object.entries(labels).sort(([a], [b]) =>
        compareStrings(a, b),
      )) {
        if (
          !/^[A-Za-z0-9._-]+$/.test(key) ||
          !/^[A-Za-z0-9._-]+$/.test(value)
        ) {
          throw new TypeError("Invalid Docker label");
        }
        args.push("--filter", `label=${key}=${value}`);
      }
      const list = await invoke(resolved, args, 5000);
      if (list.exitCode !== 0)
        throw new SandboxUnavailableError("Unable to list orphaned containers");
      const ids = list.stdout.toString("utf8").split(/\s+/).filter(Boolean);
      if (ids.length === 0) return;
      const removed = await invoke(resolved, ["rm", "-f", ...ids], 5000);
      if (removed.exitCode !== 0)
        throw new SandboxUnavailableError(
          "Unable to remove orphaned containers",
        );
    },
  };
}

function sandboxEnvironment(): Record<string, string> {
  return { PATH: "/usr/bin:/bin", HOME: "/nonexistent" };
}

interface LimitedOutput {
  bytes: Uint8Array;
  truncated: boolean;
}

async function readLimited(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<LimitedOutput> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = Math.max(0, limit - size);
      if (value.byteLength > remaining) truncated = true;
      if (remaining > 0) {
        const part = value.subarray(0, remaining);
        chunks.push(part);
        size += part.byteLength;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes: result, truncated };
}

async function invoke(
  resolved: ResolvedDockerConfig,
  args: string[],
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: Buffer; stderr: Buffer }> {
  let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    child = Bun.spawn([resolved.dockerPath, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: sandboxEnvironment(),
    });
  } catch (error) {
    throw new SandboxUnavailableError("Unable to start Docker CLI", {
      cause: error,
    });
  }
  const outputs = Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).arrayBuffer(),
  ]);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const exitCode = await Promise.race([
      child.exited,
      new Promise<number>((_, reject) => {
        timeout = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {}
          reject(new SandboxUnavailableError("Docker CLI command timed out"));
        }, timeoutMs);
      }),
    ]);
    const [stdout, stderr] = await outputs;
    return {
      exitCode,
      stdout: Buffer.from(stdout),
      stderr: Buffer.from(stderr),
    };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function waitForContainerGone(
  resolved: ResolvedDockerConfig,
  name: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await invoke(resolved, ["container", "inspect", name], 2000);
    if (result.exitCode !== 0) {
      const output = `${result.stdout.toString("utf8")}\n${result.stderr.toString("utf8")}`;
      if (/no such (?:object|container)/i.test(output)) return;
      throw new SandboxUnavailableError(
        `Unable to verify Docker container cleanup: ${output.trim()}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new SandboxUnavailableError(
    `Docker container leaked after termination: ${name}`,
  );
}
