import { constants, createReadStream } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  canonicalJSON,
  IntegrationTrustError,
  sha256,
} from "@mars/integration-trust";
import type { McpServerRegistry } from "./registry";
import type { StdioTransportConfig } from "./schemas";
import { resolveStdioExecutable, StdioMcpTransport } from "./transports";

export async function hashFile(path: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of createReadStream(path, { signal }))
    hasher.update(chunk);
  return hasher.digest("hex");
}

/** Evidence uses the configured paths. A launch hashes and uses private copies instead. */
export async function readStdioArtifact(
  config: StdioTransportConfig,
  signal?: AbortSignal,
  directory?: string,
) {
  const files = new Map<string, { path: string; digest: string }>();
  async function read(source: string, executable = false) {
    signal?.throwIfAborted();
    const key = resolve(source);
    const cached = files.get(key);
    if (cached) return cached;
    let path = key;
    if (directory) {
      if (executable) await access(key, constants.X_OK);
      const dir = join(directory, String(files.size));
      await mkdir(dir, { mode: 0o700 });
      path = join(dir, basename(key));
      await copyFile(
        key,
        path,
        constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL,
      );
      await chmod(path, executable ? 0o500 : 0o400);
    }
    const file = { path, digest: await hashFile(path, signal) };
    files.set(key, file);
    return file;
  }

  const executable = resolveStdioExecutable(config);
  const command = await read(executable, true);
  const args = [...config.args];
  const argFiles: Array<{ index: number; sha256: string }> = [];
  for (const [index, arg] of config.args.entries()) {
    signal?.throwIfAborted();
    const path = resolve(config.cwd ?? process.cwd(), arg);
    if (!(await stat(path).catch(() => undefined))?.isFile()) continue;
    const file = await read(path);
    args[index] = file.path;
    argFiles.push({ index, sha256: file.digest });
  }
  // An implicitly loaded entrypoint cannot be redirected to verified bytes.
  const entrypoint = config.entrypoint && resolve(config.entrypoint);
  if (directory && entrypoint && !files.has(entrypoint)) {
    throw new IntegrationTrustError("evidence_unavailable", {
      cause: new Error(
        "The stdio entrypoint must be the command or a file argument",
      ),
    });
  }
  const sha = sha256(
    canonicalJSON({
      executable,
      executableSha: command.digest,
      entrypointSha: entrypoint ? (await read(entrypoint)).digest : null,
      ...(argFiles.length ? { argFiles } : {}),
    }),
  );
  return {
    executable,
    sha,
    config: { ...config, command: command.path, args },
  };
}

function removeLaunchDirectory(directory: string) {
  return rm(directory, { recursive: true, force: true, maxRetries: 3 });
}

class CapturedStdioTransport extends StdioMcpTransport {
  constructor(
    config: StdioTransportConfig,
    private readonly directory: string,
  ) {
    super(config);
  }
  override async close() {
    try {
      await super.close();
    } finally {
      await removeLaunchDirectory(this.directory);
    }
  }
}

export async function captureStdioArtifact(
  config: StdioTransportConfig,
  signal?: AbortSignal,
  registry?: McpServerRegistry,
) {
  signal?.throwIfAborted();
  const directory = registry?.createLaunchDirectory
    ? await registry.createLaunchDirectory()
    : await mkdtemp(join(homedir(), ".mars-mcp-launch-"));
  try {
    const {
      executable,
      sha,
      config: launch,
    } = await readStdioArtifact(config, signal, directory);
    const transport = new CapturedStdioTransport(launch, directory);
    return { executable, sha, transport };
  } catch (error) {
    await removeLaunchDirectory(directory);
    throw error;
  }
}
