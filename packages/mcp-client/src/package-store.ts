import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { IntegrationTrustError } from "@mars/integration-trust";

export function within(root: string, path: string) {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function physical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== "ENOENT" ||
      dirname(path) === path
    )
      throw error;
    return join(await physical(dirname(path)), basename(path));
  }
}

type Entry = { name: string } & (
  | { type: "directory" }
  | { type: "link"; target: string }
  | { type: "file"; source: string; hash: string; executable: boolean }
);

async function digest(path: string, signal?: AbortSignal) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { signal }))
    hash.update(chunk);
  return hash.digest("hex");
}

export interface PackageSource {
  /** Regular file or directory explicitly selected by the operator. */
  path: string;
  /** A venv can have file aliases to its explicitly selected host executable. */
  externalExecutable?: string;
  /** Mutable paths; files also reserve their SQLite journal companion names. */
  exclude?: readonly string[];
}

/** Host-only, outside writable workspaces. No fallback to HOME or cwd. */
export class McpPackageStore {
  constructor(
    private readonly options: {
      directory: string;
      workspaceRoots: readonly string[];
    },
  ) {}

  private async root() {
    const requested = resolve(this.options.directory);
    const root = await physical(requested);
    for (const workspace of this.options.workspaceRoots) {
      const ws = resolve(workspace);
      const canonical = await physical(ws);
      if (
        within(ws, requested) ||
        within(canonical, root) ||
        within(root, canonical)
      )
        throw new IntegrationTrustError("store_location_unsafe");
    }
    await mkdir(root, { mode: 0o700, recursive: true });
    const meta = await lstat(root);
    if (
      !meta.isDirectory() ||
      (process.getuid &&
        (meta.uid !== process.getuid() || (meta.mode & 0o077) !== 0))
    )
      throw new IntegrationTrustError("store_location_unsafe");
    return root;
  }

  /** Fingerprint source bytes. Only explicit installation ever writes a revision. */
  async inspect(source: PackageSource, signal?: AbortSignal) {
    const root = await this.root();
    const origin = await realpath(source.path);
    if (within(origin, root) || within(root, origin))
      throw new IntegrationTrustError("store_location_unsafe");
    const external =
      source.externalExecutable && (await realpath(source.externalExecutable));
    const excluded = new Set<string>();
    for (const p of source.exclude ?? []) {
      if (!isAbsolute(p))
        throw new Error("Data exclusions must be absolute paths.");
      const data = await physical(p);
      excluded.add(data);
      const meta = await stat(data).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return undefined;
      });
      if (!meta || meta.isFile()) {
        // Reserve exact sibling names before SQLite creates them, not symlink targets.
        for (const suffix of ["-wal", "-shm", "-journal"])
          excluded.add(data + suffix);
      }
    }
    const entries: Entry[] = [];
    let count = 0;
    let bytes = 0;
    const walk = async (path: string, name: string): Promise<void> => {
      signal?.throwIfAborted();
      if (excluded.has(path)) return;
      if (++count > 32_768)
        throw new Error(
          "MCP package exceeds the file limit; select a smaller folder.",
        );
      let meta = await lstat(path);
      if (meta.isSymbolicLink()) {
        const target = await realpath(path);
        if ([...excluded].some((data) => within(data, target)))
          throw new Error("Package link points to excluded data.");
        if (within(origin, target)) {
          entries.push({
            name,
            type: "link",
            target: relative(dirname(path), target) || ".",
          });
          return;
        }
        if (target !== external)
          throw new Error(
            `MCP package link leaves the selected folder: ${name}`,
          );
        path = target;
        meta = await lstat(path);
      }
      if (meta.isDirectory()) {
        if (name) entries.push({ name, type: "directory" });
        for (const child of (await readdir(path)).sort())
          await walk(join(path, child), join(name, child));
      } else if (meta.isFile()) {
        bytes += meta.size;
        if (bytes > 512 * 1024 * 1024)
          throw new Error(
            "MCP package exceeds 512 MiB; select a smaller folder.",
          );
        entries.push({
          name,
          type: "file",
          source: path,
          hash: await digest(path, signal),
          executable: Boolean(meta.mode & 0o111),
        });
      } else throw new Error(`Not a regular MCP package file: ${name}`);
    };
    const tree = (await stat(origin)).isDirectory();
    await walk(origin, tree ? "" : basename(source.path));
    const identity = entries.map((e) =>
      e.type === "file"
        ? [e.name, e.type, e.hash, e.executable]
        : e.type === "link"
          ? [e.name, e.type, e.target]
          : [e.name, e.type],
    );
    const sha = createHash("sha256")
      .update(JSON.stringify([1, identity]))
      .digest("hex");
    const directory = join(root, sha, "files");
    return {
      sha,
      directory,
      install: async () => {
        await this.sweep(root);
        if ((await lstat(directory).catch(() => undefined))?.isDirectory())
          return;
        const stage = await mkdtemp(join(root, `.stage-${process.pid}-`));
        try {
          const files = join(stage, "files");
          await mkdir(files, { mode: 0o700 });
          for (const e of entries) {
            signal?.throwIfAborted();
            const dest = join(files, e.name);
            if (e.type === "directory") await mkdir(dest, { mode: 0o700 });
            else if (e.type === "link") await symlink(e.target, dest);
            else {
              await copyFile(
                e.source,
                dest,
                constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
              );
              await chmod(dest, e.executable ? 0o500 : 0o400);
              if ((await digest(dest, signal)) !== e.hash)
                throw new IntegrationTrustError("drift");
            }
          }
          try {
            await rename(stage, dirname(directory));
          } catch (error) {
            if (
              !["EEXIST", "ENOTEMPTY"].includes(
                (error as NodeJS.ErrnoException).code ?? "",
              ) ||
              !(await lstat(directory)).isDirectory()
            )
              throw error;
          }
        } finally {
          await rm(stage, { recursive: true, force: true });
        }
      },
    };
  }

  private async sweep(root: string) {
    for (const name of await readdir(root)) {
      const match = /^\.stage-([1-9]\d*)-[a-zA-Z0-9]+$/.exec(name);
      if (!match) continue;
      try {
        process.kill(Number(match[1]), 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH")
          await rm(join(root, name), { recursive: true, force: true });
      }
    }
  }
}
