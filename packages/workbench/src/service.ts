import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, realpath, rename, stat, unlink } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { type Scope, ScopeSchema } from "@mars/contracts";
import { loadModelRegistry, type ModelProviderRegistry } from "@mars/providers";
import { createTaskStore } from "@mars/tasks";
import {
  createDockerSandbox,
  createLocalWorkspaceProvider,
  WorkspaceNotFoundError,
} from "@mars/workspaces";
import { createWorkbenchHost, type WorkbenchHostOptions } from "./host";
import { serveWorkbench, WorkbenchError } from "./server";

export interface WorkbenchServiceOptions {
  sourceRoot: string;
  stateRoot: string;
  scope: Scope;
  port?: number;
  image?: string;
  trustProjectConfig?: boolean;
  registry?: ModelProviderRegistry;
  runtimeFactory?: WorkbenchHostOptions["runtimeFactory"];
}

export interface WorkbenchService {
  readonly url: string;
  readonly connectionFile: string;
  close(): Promise<void>;
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return join(await canonicalPath(dirname(path)), basename(path));
  }
}

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return (
    path === "" ||
    (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`))
  );
}

export async function createWorkbenchService(
  options: WorkbenchServiceOptions,
): Promise<WorkbenchService> {
  const scope = ScopeSchema.parse(options.scope);
  if (scope.workspace_id !== undefined)
    throw new WorkbenchError("invalid_request");
  const source = await realpath(options.sourceRoot);
  const root = await canonicalPath(resolve(options.stateRoot));
  if (contains(source, root) || contains(root, source))
    throw new WorkbenchError("forbidden");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await stat(root);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0)
    throw new WorkbenchError("forbidden");
  const hostRoot = join(root, "sessions");
  await mkdir(hostRoot, { recursive: true, mode: 0o700 });
  const registry =
    options.registry ??
    (await loadModelRegistry({
      cwd: source,
      trustProjectConfig: options.trustProjectConfig === true,
    }));
  const store = await createTaskStore({
    rootDir: join(root, "tasks"),
    workspaceRoots: [source],
  });
  let workspace:
    | Awaited<ReturnType<typeof createLocalWorkspaceProvider>>
    | undefined;
  let host: Awaited<ReturnType<typeof createWorkbenchHost>> | undefined;
  let server: ReturnType<typeof serveWorkbench> | undefined;
  try {
    const sandbox = options.image
      ? createDockerSandbox({ image: options.image })
      : undefined;
    await sandbox?.verify();
    workspace = await createLocalWorkspaceProvider({
      rootDir: join(root, "workspaces"),
      sourceRoot: source,
      artifacts: store.artifacts,
      ...(sandbox ? { sandbox } : {}),
      approveCommand: async (request) =>
        Boolean(sandbox) &&
        (await store.inspect(request.context, request.task_id)).status ===
          "running",
    });
    const provider = workspace;
    host = await createWorkbenchHost({
      scope,
      workspaceLabel: basename(source),
      stateRoot: hostRoot,
      store,
      registry,
      canExecute: Boolean(sandbox),
      workspace: {
        prepare: provider.prepare.bind(provider),
        read: provider.read.bind(provider),
        write: provider.write.bind(provider),
        execute: provider.execute.bind(provider),
        checkpoint: provider.checkpoint.bind(provider),
        restore: provider.restore.bind(provider),
        collect: provider.collect.bind(provider),
        stop: provider.stop.bind(provider),
        diff: provider.diff.bind(provider),
        cwd: provider.workspacePath.bind(provider),
        async reopen(context, taskId) {
          const workspace = await provider.discover(context, taskId);
          if (!workspace) throw new WorkspaceNotFoundError();
          return workspace;
        },
      },
      ...(options.runtimeFactory
        ? { runtimeFactory: options.runtimeFactory }
        : {}),
    });
    const token = randomBytes(32).toString("base64url");
    server = serveWorkbench({
      api: host,
      token,
      port: options.port ?? 7331,
    });
    const url = `http://127.0.0.1:${server.port}`;
    const connectionFile = join(root, "connection.json");
    const temporary = join(root, `.connection-${randomUUID()}.json`);
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(
          JSON.stringify({ schema_version: 1, url, token, scope }),
        );
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, connectionFile);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    const runningHost = host;
    const runningServer = server;
    let closing: Promise<void> | undefined;
    return {
      url,
      connectionFile,
      close() {
        closing ??= (async () => {
          const outcomes = [
            await Promise.allSettled([runningServer.stop(true)]),
            await Promise.allSettled([runningHost.close()]),
            await Promise.allSettled([provider.close()]),
            await Promise.allSettled([store.close()]),
          ].flat();
          if (outcomes.some((outcome) => outcome.status === "rejected"))
            throw new WorkbenchError("unavailable");
        })();
        return closing;
      },
    };
  } catch (error) {
    await server?.stop(true).catch(() => undefined);
    if (host) await host.close().catch(() => undefined);
    if (workspace) await workspace.close().catch(() => undefined);
    await store.close();
    throw error;
  }
}
