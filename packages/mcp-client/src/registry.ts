import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { IntegrationTrustError } from "@mars/integration-trust";
import {
  type McpRegistryState,
  McpRegistryStateSchema,
  type McpServerConfig,
  McpServerConfigSchema,
} from "./schemas";

export interface McpServerRegistry {
  /** Allocate an empty host-private directory outside workspace roots; the transport owns cleanup. */
  createLaunchDirectory?(): Promise<string>;
  list(): Promise<McpServerConfig[]>;
  get(serverId: string): Promise<McpServerConfig | undefined>;
  upsert(config: McpServerConfig): Promise<void>;
  remove(serverId: string): Promise<boolean>;
}

/**
 * In-memory host-owned registry. Starts empty (default-deny: no ambient MCPs).
 */
export class MemoryMcpRegistry implements McpServerRegistry {
  private readonly servers = new Map<string, McpServerConfig>();

  constructor(initial: McpServerConfig[] = []) {
    for (const server of initial) {
      const parsed = McpServerConfigSchema.parse(server);
      this.servers.set(parsed.id, structuredClone(parsed));
    }
  }

  async list(): Promise<McpServerConfig[]> {
    return [...this.servers.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((s) => structuredClone(s));
  }

  async get(serverId: string): Promise<McpServerConfig | undefined> {
    const found = this.servers.get(serverId);
    return found ? structuredClone(found) : undefined;
  }

  async upsert(config: McpServerConfig): Promise<void> {
    const parsed = McpServerConfigSchema.parse(config);
    this.servers.set(parsed.id, structuredClone(parsed));
  }

  async remove(serverId: string): Promise<boolean> {
    return this.servers.delete(serverId);
  }
}

async function resolveSafeRealPath(target: string): Promise<string> {
  const abs = resolve(target);
  try {
    return await realpath(abs);
  } catch {
    const parent = dirname(abs);
    if (parent === abs) return abs;
    const parentReal = await resolveSafeRealPath(parent);
    return resolve(parentReal, relative(parent, abs));
  }
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

/**
 * Host-owned file-backed MCP server registry stored outside agent-writable
 * workspace roots with restrictive permissions (0700 dir, 0600 file) and
 * atomic writes. Never auto-discovers ambient MCP configs from workspaces.
 */
export class FileMcpRegistry implements McpServerRegistry {
  private readonly filePath: string;
  private readonly lockPath: string;
  private readonly dirPath: string;
  private readonly workspaceRoots: string[];
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: { dir: string; workspaceRoots: string[] }) {
    if (!options.dir) {
      throw new IntegrationTrustError("store_location_unsafe");
    }
    this.dirPath = resolve(options.dir);
    this.filePath = resolve(this.dirPath, "servers.json");
    this.lockPath = resolve(this.dirPath, ".servers.lock");
    this.workspaceRoots = options.workspaceRoots.map((r) => resolve(r));
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    let releaseQueue!: () => void;
    const prev = this.writeQueue;
    this.writeQueue = new Promise<void>((r) => {
      releaseQueue = r;
    });
    await prev;
    try {
      await this.verifyLocation();
      await mkdir(this.dirPath, { recursive: true, mode: 0o700 });
      await chmod(this.dirPath, 0o700);
      const deadline = Date.now() + 5_000;
      let handle: Awaited<ReturnType<typeof open>> | null = null;
      while (!handle) {
        try {
          handle = await open(this.lockPath, "wx", 0o600);
        } catch (error) {
          if (
            !(
              error &&
              typeof error === "object" &&
              "code" in error &&
              (error as { code?: unknown }).code === "EEXIST"
            )
          ) {
            throw error;
          }
          try {
            const st = await stat(this.lockPath);
            if (Date.now() - st.mtimeMs > 10_000) {
              await unlink(this.lockPath).catch(() => {});
              continue;
            }
          } catch {
            continue;
          }
          if (Date.now() >= deadline) {
            throw new IntegrationTrustError("revision_conflict", {
              cause: new Error(
                `Timed out waiting for registry lock ${this.lockPath}`,
              ),
            });
          }
          await new Promise((r) => setTimeout(r, 15));
        }
      }
      try {
        return await fn();
      } finally {
        await handle.close().catch(() => {});
        await unlink(this.lockPath).catch(() => {});
      }
    } finally {
      releaseQueue();
    }
  }

  private async verifyLocation(): Promise<void> {
    const targetReal = await resolveSafeRealPath(this.dirPath);
    for (const root of this.workspaceRoots) {
      const rootReal = await resolveSafeRealPath(root);
      if (inside(rootReal, targetReal)) {
        throw new IntegrationTrustError("store_location_unsafe");
      }
    }
    try {
      const st = await lstat(this.dirPath);
      if (st.isSymbolicLink()) {
        throw new IntegrationTrustError("store_location_unsafe");
      }
    } catch (error) {
      if (error instanceof IntegrationTrustError) throw error;
    }
    try {
      const st = await lstat(this.filePath);
      if (st.isSymbolicLink()) {
        throw new IntegrationTrustError("store_location_unsafe");
      }
    } catch (error) {
      if (error instanceof IntegrationTrustError) throw error;
    }
  }

  async createLaunchDirectory(): Promise<string> {
    return this.withLock(() => mkdtemp(resolve(this.dirPath, "launch-")));
  }

  private async readState(): Promise<McpRegistryState> {
    await this.verifyLocation();
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code?: unknown }).code === "ENOENT"
      ) {
        return { schema_version: 1, servers: {} };
      }
      throw error;
    }
    const parsed = McpRegistryStateSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      throw new IntegrationTrustError("store_corrupt", { cause: parsed.error });
    }
    return parsed.data;
  }

  private async writeState(state: McpRegistryState): Promise<void> {
    await this.verifyLocation();
    const validated = McpRegistryStateSchema.parse(state);
    await mkdir(this.dirPath, { recursive: true, mode: 0o700 });
    await chmod(this.dirPath, 0o700);
    const tmp = resolve(this.dirPath, `.servers.${randomUUID()}.tmp`);
    try {
      await writeFile(tmp, `${JSON.stringify(validated, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await chmod(tmp, 0o600);
      await rename(tmp, this.filePath);
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => {});
      throw error;
    }
  }

  async list(): Promise<McpServerConfig[]> {
    const state = await this.readState();
    return Object.values(state.servers).sort((a, b) =>
      a.id.localeCompare(b.id),
    );
  }

  async get(serverId: string): Promise<McpServerConfig | undefined> {
    const state = await this.readState();
    return Object.hasOwn(state.servers, serverId)
      ? state.servers[serverId]
      : undefined;
  }

  async upsert(config: McpServerConfig): Promise<void> {
    const parsed = McpServerConfigSchema.parse(config);
    await this.withLock(async () => {
      const state = await this.readState();
      state.servers[parsed.id] = parsed;
      await this.writeState(state);
    });
  }

  async remove(serverId: string): Promise<boolean> {
    return this.withLock(async () => {
      const state = await this.readState();
      if (!Object.hasOwn(state.servers, serverId)) return false;
      delete state.servers[serverId];
      await this.writeState(state);
      return true;
    });
  }
}
