import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import {
  IntegrityError,
  LimitExceededError,
  WorkspacePolicyError,
} from "./errors";
import { hasUnsupportedPathCharacters, isIgnored, isSecret } from "./paths";

export interface WorkspaceLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxPathBytes: number;
  maxDepth: number;
  maxManifestBytes: number;
  maxOutputBytes: number;
  maxExecutionMs: number;
}

export const DEFAULT_WORKSPACE_LIMITS: WorkspaceLimits = {
  maxFiles: 20_000,
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxPathBytes: 1024,
  maxDepth: 64,
  maxManifestBytes: 16 * 1024 * 1024,
  maxOutputBytes: 1024 * 1024,
  maxExecutionMs: 120_000,
};

export interface TreeFile {
  path: string;
  mode: 420 | 493;
  size: number;
  sha256: string;
  data: Uint8Array;
}

export interface TreeSnapshot {
  files: TreeFile[];
  directories: string[];
  digest: string;
  totalBytes: number;
  skipped?: Array<{
    path: string;
    reason: "symlink" | "special" | "ignored-secret" | "unsupported-name";
  }>;
}

export interface TreeOptions {
  limits: WorkspaceLimits;
  extraIgnores?: readonly string[];
  enforceLimits?: boolean;
  includeData?: boolean;
  tolerateUnsupportedNames?: boolean;
  skipped?: Array<{
    path: string;
    reason: "symlink" | "special" | "ignored-secret" | "unsupported-name";
  }>;
}

export function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export async function snapshotTree(
  root: string,
  options: TreeOptions,
): Promise<TreeSnapshot> {
  const files: TreeFile[] = [];
  const directories: string[] = [];
  let totalBytes = 0;
  const enforce = options.enforceLimits !== false;
  const walk = async (absolute: string, parent: string): Promise<void> => {
    const entries = await readdir(absolute, { withFileTypes: true });
    entries.sort((a, b) => compareStrings(a.name, b.name));
    for (const entry of entries) {
      const path = parent ? `${parent}/${entry.name}` : entry.name;
      if (isIgnored(path, options.extraIgnores)) continue;
      if (path.includes("\\") || hasUnsupportedPathCharacters(path)) {
        if (options.tolerateUnsupportedNames) {
          options.skipped?.push({ path, reason: "unsupported-name" });
          continue;
        }
        throw new WorkspacePolicyError(
          "Workspace path contains unsupported characters",
        );
      }
      if (
        enforce &&
        (Buffer.byteLength(path, "utf8") > options.limits.maxPathBytes ||
          path.split("/").length > options.limits.maxDepth)
      ) {
        throw new LimitExceededError(`Path exceeds limits: ${path}`);
      }
      const absoluteEntry = join(absolute, entry.name);
      const stat = await lstat(absoluteEntry);
      if (stat.isSymbolicLink()) {
        options.skipped?.push({ path, reason: "symlink" });
        continue;
      }
      if (isSecret(path)) {
        options.skipped?.push({ path, reason: "ignored-secret" });
        continue;
      }
      if (stat.isDirectory()) {
        directories.push(path);
        await walk(absoluteEntry, path);
        continue;
      }
      if (!stat.isFile()) {
        options.skipped?.push({ path, reason: "special" });
        continue;
      }
      if (stat.size > options.limits.maxFileBytes && enforce) {
        throw new LimitExceededError(`File exceeds maxFileBytes: ${path}`);
      }
      totalBytes += stat.size;
      if (files.length + 1 > options.limits.maxFiles && enforce) {
        throw new LimitExceededError("Workspace exceeds maxFiles");
      }
      if (totalBytes > options.limits.maxTotalBytes && enforce) {
        throw new LimitExceededError("Workspace exceeds maxTotalBytes");
      }
      let data = new Uint8Array();
      let digest: string;
      if (options.includeData !== false) {
        data = await readFile(absoluteEntry);
        digest = sha256(data);
      } else {
        const hash = createHash("sha256");
        for await (const chunk of createReadStream(absoluteEntry))
          hash.update(chunk);
        digest = hash.digest("hex");
      }
      const mode = (stat.mode & 0o111) !== 0 ? 493 : 420;
      files.push({ path, mode, size: stat.size, sha256: digest, data });
    }
  };
  await walk(root, "");
  files.sort((a, b) => compareStrings(a.path, b.path));
  directories.sort(compareStrings);
  const lines = [
    ...files.map((file) => ({
      path: file.path,
      line: `F\0${file.path}\0${file.mode}\0${file.sha256}\n`,
    })),
    ...directories.map((path) => ({ path, line: `D\0${path}\n` })),
  ]
    .sort((a, b) => compareStrings(a.path, b.path))
    .map(({ line }) => line);
  return {
    files,
    directories,
    digest: sha256(lines.join("")),
    totalBytes,
    ...(options.skipped ? { skipped: options.skipped } : {}),
  };
}

export function assertArtifactBytes(
  data: Uint8Array,
  expected: { sha256: string; byte_length: number },
): void {
  if (
    data.byteLength !== expected.byte_length ||
    sha256(data) !== expected.sha256
  ) {
    throw new IntegrityError("Artifact bytes do not match their reference");
  }
}

export async function materializeSnapshot(
  destination: string,
  snapshot: TreeSnapshot,
): Promise<void> {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const directory of snapshot.directories) {
    await mkdir(join(destination, directory), { recursive: true, mode: 0o700 });
  }
  for (const file of snapshot.files) {
    const target = join(destination, file.path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, file.data, { mode: file.mode });
    await chmod(target, file.mode);
  }
}

export async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new IntegrityError(
      `Expected a real directory at ${relative("/", path)}`,
    );
  }
}
