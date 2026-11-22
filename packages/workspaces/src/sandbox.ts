import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { isLocalDockerHost } from "./docker-host";
import {
  DockerSandboxPrerequisiteError,
  DockerSandboxRootUserError,
  SandboxUnavailableError,
} from "./errors";
import { compareStrings, DEFAULT_WORKSPACE_LIMITS } from "./tree";
import type {
  DockerSandboxOptions,
  SandboxRunner,
  SandboxRunRequest,
  SandboxRunResult,
} from "./types";

export interface ResolvedDockerConfig {
  dockerHost?: string;
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

const PINNED_IMAGE_PATTERN = /^[a-z0-9][a-z0-9._/:-]*@sha256:[a-f0-9]{64}$/;
const SAFE_LABEL_PATTERN = /^[A-Za-z0-9._-]+$/;

export const MAX_COMMAND_ARGS = 256;
export const MAX_COMMAND_ARG_BYTES = 4096;

export function isValidArgv(argv: unknown): argv is readonly string[] {
  return (
    Array.isArray(argv) &&
    argv.length > 0 &&
    argv.length <= MAX_COMMAND_ARGS &&
    argv.every(
      (arg) =>
        typeof arg === "string" &&
        !arg.includes("\0") &&
        Buffer.byteLength(arg) <= MAX_COMMAND_ARG_BYTES,
    )
  );
}

export function resolveDockerConfig(
  options: DockerSandboxOptions,
): ResolvedDockerConfig {
  const config: ResolvedDockerConfig = {
    image: options.image,
    dockerPath: options.dockerPath ?? "/usr/bin/docker",
    ...(options.dockerHost !== undefined
      ? { dockerHost: options.dockerHost }
      : {}),
    uid: options.user?.uid ?? process.getuid?.() ?? 1000,
    gid: options.user?.gid ?? process.getgid?.() ?? 1000,
    memoryBytes: options.memoryBytes ?? 512 * 1024 * 1024,
    pids: options.pids ?? 128,
    cpus: options.cpus ?? 1,
    tmpfsBytes: options.tmpfsBytes ?? 64 * 1024 * 1024,
    maxFileBytes: options.maxFileBytes ?? DEFAULT_WORKSPACE_LIMITS.maxFileBytes,
  };
  validateResolvedConfig(config);
  return config;
}

export function buildDockerRunArgs(
  resolved: ResolvedDockerConfig,
  request: SandboxRunRequest,
  containerName: string,
): string[] {
  validateResolvedConfig(resolved);
  if (!SAFE_LABEL_PATTERN.test(containerName))
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
  if (!SAFE_LABEL_PATTERN.test(request.runId))
    throw new TypeError("Invalid workspace run id");
  if (!isValidArgv(request.argv))
    throw new TypeError("Invalid command arguments");
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
    assertSafeLabel(key, value);
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
  if (config.dockerHost !== undefined && !isLocalDockerHost(config.dockerHost))
    throw new TypeError(
      "dockerHost must be a local unix socket or Windows named pipe",
    );
  if (!PINNED_IMAGE_PATTERN.test(config.image)) {
    throw new TypeError("Docker image must be pinned to a sha256 digest");
  }
  if (!isAbsolute(config.dockerPath))
    throw new TypeError("dockerPath must be absolute");
  if (config.uid === 0 || config.gid === 0)
    throw new DockerSandboxRootUserError();
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
  if (!Number.isFinite(config.cpus) || config.cpus <= 0) {
    throw new TypeError("cpus must be a positive finite number");
  }
}

function assertSafeLabel(key: string, value: string): void {
  if (!SAFE_LABEL_PATTERN.test(key) || !SAFE_LABEL_PATTERN.test(value)) {
    throw new TypeError("Invalid Docker label");
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
        try {
          await access(resolved.dockerPath, constants.X_OK);
        } catch (error) {
          if (
            ["ENOENT", "ENOTDIR", "EACCES"].includes(
              (error as NodeJS.ErrnoException).code ?? "",
            )
          ) {
            throw new DockerSandboxPrerequisiteError(
              "Docker CLI is not executable at the configured path",
              { cause: error },
            );
          }
          throw error;
        }
        const version = await invoke(
          resolved,
          ["version", "--format", "{{.Server.Version}}"],
          5000,
        );
        if (version.exitCode !== 0) {
          const detail = version.stderr.toString().trim();
          if (
            /cannot connect to the docker daemon|permission denied while trying to connect to the docker (?:api|daemon socket)|(?:connect|connection): (?:no such file or directory|connection refused|permission denied)/i.test(
              detail,
            )
          ) {
            throw new DockerSandboxPrerequisiteError(
              "Docker daemon is unavailable",
              { cause: new Error(detail) },
            );
          }
          throw new Error(`Docker version check failed: ${detail}`);
        }
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
        if (image.exitCode !== 0) {
          const detail = image.stderr.toString().trim();
          const missing = detail.replace(
            /^Error(?: response from daemon)?:\s*/,
            "",
          );
          if (
            missing === `No such image: ${resolved.image}` ||
            missing === `No such object: ${resolved.image}`
          ) {
            throw new DockerSandboxPrerequisiteError(
              `Pinned Docker image is not available locally: ${resolved.image}`,
            );
          }
          throw new Error(`Docker image inspection failed: ${detail}`);
        }
        const repoDigests: unknown = JSON.parse(image.stdout.toString("utf8"));
        if (
          !Array.isArray(repoDigests) ||
          !repoDigests.includes(resolved.image)
        ) {
          throw new Error(
            `Docker image inspection did not verify the pinned repository digest: ${resolved.image}`,
          );
        }
      } catch (error) {
        if (error instanceof DockerSandboxPrerequisiteError) throw error;
        throw new SandboxUnavailableError(
          `Docker sandbox verification failed: ${error instanceof Error ? error.message : String(error)}`,
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
          env: sandboxEnvironment(resolved),
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
        assertSafeLabel(key, value);
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

export function sandboxEnvironment(
  config: Pick<ResolvedDockerConfig, "dockerHost">,
): Record<string, string> {
  if (config.dockerHost !== undefined && !isLocalDockerHost(config.dockerHost))
    throw new TypeError(
      "dockerHost must be a local unix socket or Windows named pipe",
    );
  return {
    PATH: "/usr/bin:/bin",
    HOME: "/nonexistent",
    ...(config.dockerHost ? { DOCKER_HOST: config.dockerHost } : {}),
  };
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
      env: sandboxEnvironment(resolved),
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
