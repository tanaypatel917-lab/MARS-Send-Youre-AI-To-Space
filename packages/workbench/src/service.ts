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
import {
  createDerivedArtifactStore,
  createRepositoryMapProvider,
  type RepositoryMapProvider,
} from "@mars/context";
import { type Scope, ScopeSchema } from "@mars/contracts";
import { createKnowledgeGraphService } from "@mars/knowledge-graph";
import { createMemoryStore, type DurableMemoryStore } from "@mars/memory";
import { loadModelRegistry, type ModelProviderRegistry } from "@mars/providers";
import {
  createOmniRouteProcess,
  discoverOmniRouteCapabilities,
  type ExclusionOverrides,
  extendRegistryWithOmniRoute,
  type FreeTierCatalog,
  loadFreeTierCatalog,
  OMNIROUTE_DEFAULT_URL,
  type OmniRouteProcess,
  type OmniRouteProcessOptions,
  type OmniRouteProcessStatus,
} from "@mars/providers-omniroute";
import {
  createResearchService,
  type DurableResearchService,
  type ResearchServiceOptions,
} from "@mars/research";
import {
  createRegistryModelGateway,
  createResearchWorker,
  type FetchLike,
  type HostResolver,
  type ModelGateway,
  parseResearchWorkerConfig,
  type ResearchWorkerConfigInput,
  type SearchProvider,
  type WorkerLogEvent,
} from "@mars/research-worker";
import { createRegistryReviewGateway, ReviewRunner } from "@mars/review";
import { SkillStore } from "@mars/skills";
import { createTaskStore } from "@mars/tasks";
import {
  createDockerSandbox,
  createLocalWorkspaceProvider,
  WorkspaceNotFoundError,
} from "@mars/workspaces";
import type { WorkbenchCollaboration } from "./collaboration-context";
import { createWorkbenchHost, type WorkbenchHostOptions } from "./host";
import { serveWorkbench, WorkbenchError } from "./server";
import type { WorkbenchSpecialists } from "./specialist-routing";

/**
 * Background research for every session: the durable `@mars/research` control
 * plane is opened under the private state root and the `@mars/research-worker`
 * claim loop runs while the service runs. Credentials never enter this object;
 * search adapters receive values the caller read from its environment.
 */
export interface WorkbenchResearchOptions {
  /** Web search the worker queries (`createBraveSearch`, `createSearxngSearch`, ...). */
  search: SearchProvider;
  /** Worker settings; `live: true` permits the global fetch and real DNS. */
  worker?: ResearchWorkerConfigInput;
  /**
   * Model gateway for planning and extraction. Defaults to the registry's
   * free default route (or `worker.model`), refusing paid models unless
   * `worker.paid_consent` is set.
   */
  model?: ModelGateway;
  /** Control-plane limits: concurrency, leases, retries and polling. */
  service?: Pick<
    ResearchServiceOptions,
    | "maxConcurrency"
    | "maxActivePerScope"
    | "maxActiveTotal"
    | "maxAttempts"
    | "leaseMs"
    | "retryBackoffMs"
    | "pollMs"
  >;
  /** Page fetch for the worker; required unless `worker.live` is true. */
  fetch?: FetchLike;
  resolveHost?: HostResolver;
  /** Environment the default registry gateway reads provider credentials from. */
  env?: Record<string, string | undefined>;
  log?: (event: WorkerLogEvent) => void;
  /** Time given to running requests before shutdown re-queues them (default 5 s). */
  drainMs?: number;
}

/**
 * Optional self-hosted OmniRoute gateway as one more provider target. MARS
 * keeps model policy: only free, non-excluded catalog entries are
 * registered, the user's `allowPaid` is untouched, and every request carries
 * the task's paid-consent state. OmniRoute's own configuration, gateway key
 * and upstream credentials stay in its data directory; MARS never reads them.
 */
export interface WorkbenchOmniRouteOptions {
  /** Origin or `/v1` URL; default `http://localhost:20128`. */
  url?: string;
  /** Start a pinned instance on loopback when none answers (default: attach only). */
  start?: boolean;
  command?: string[];
  allowVersionMismatch?: boolean;
  /** Opt-ins over the default exclusions (web-session, browser-session, terms risk). */
  overrides?: ExclusionOverrides;
  /**
   * Paid consent carried to OmniRoute for non-free routes. Default false:
   * the user's `allowPaid` alone never counts as task consent.
   */
  paidConsent?: boolean;
  /** Catalog to use instead of the bundled `free-tier-catalog.json`. */
  catalog?: FreeTierCatalog;
  env?: Record<string, string | undefined>;
  fetch?: OmniRouteProcessOptions["fetch"];
  spawn?: OmniRouteProcessOptions["spawn"];
  run?: OmniRouteProcessOptions["run"];
  log?: OmniRouteProcessOptions["log"];
}

export interface WorkbenchServiceOptions {
  sourceRoot: string;
  stateRoot: string;
  scope: Scope;
  port?: number;
  image?: string;
  trustProjectConfig?: boolean;
  registry?: ModelProviderRegistry;
  /** Evidence-gated specialist router; launches use the registry default without it. */
  specialists?: WorkbenchSpecialists;
  /** Task-scoped collaboration rooms; launches stay single-agent without it. */
  collaboration?: WorkbenchCollaboration;
  /** Background research worker and control plane; sessions get no research tools without it. */
  research?: WorkbenchResearchOptions;
  /** Pinned graphify CLI (argv prefix); sessions get no graph tools without it. */
  knowledgeGraph?: {
    command: string[];
    timeoutMs?: number;
    /** `command` wraps graphify in an OS sandbox (bwrap, firejail, …). */
    osWrapper?: boolean;
  };
  /** OmniRoute provider target; absent means no OmniRoute models exist. */
  omniroute?: WorkbenchOmniRouteOptions;
  runtimeFactory?: WorkbenchHostOptions["runtimeFactory"];
}

export interface WorkbenchService {
  readonly url: string;
  readonly connectionFile: string;
  /** Null unless the service was started with `omniroute`. */
  readonly omniroute: OmniRouteProcessStatus | null;
  close(): Promise<void>;
}

async function openOmniRoute(
  registry: ModelProviderRegistry,
  options: WorkbenchOmniRouteOptions,
): Promise<{ process: OmniRouteProcess; registry: ModelProviderRegistry }> {
  const url = options.url ?? OMNIROUTE_DEFAULT_URL;
  const env = options.env ?? process.env;
  const omniroute = createOmniRouteProcess({
    mode: options.start ? "start" : "attach",
    url,
    env,
    ...(options.command ? { command: options.command } : {}),
    ...(options.allowVersionMismatch
      ? { allowVersionMismatch: options.allowVersionMismatch }
      : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.spawn ? { spawn: options.spawn } : {}),
    ...(options.run ? { run: options.run } : {}),
    ...(options.log ? { log: options.log } : {}),
  });
  await omniroute.start();
  try {
    const catalog = options.catalog ?? (await loadFreeTierCatalog());
    // One GET /v1/models refines tools/vision/context; never a model request.
    const discovered = await discoverOmniRouteCapabilities({
      url,
      env,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    return {
      process: omniroute,
      registry: extendRegistryWithOmniRoute(registry, {
        catalog,
        url,
        ...(options.overrides ? { overrides: options.overrides } : {}),
        ...(discovered ? { discovered } : {}),
        // The registry resolves OMNIROUTE_API_KEY from the same environment
        // the probe used, so a discovered gateway is also routable.
        ...(options.env ? { env: options.env } : {}),
        policy: { paidConsent: options.paidConsent === true },
      }),
    };
  } catch (error) {
    await omniroute.stop().catch(() => undefined);
    throw error;
  }
}

async function privateSubdirectory(
  root: string,
  name: string,
): Promise<string> {
  const path = await canonicalPath(join(root, name));
  if (path !== join(root, name)) throw new WorkbenchError("forbidden");
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await stat(path);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0)
    throw new WorkbenchError("forbidden");
  return path;
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
  const memoryRoot = await privateSubdirectory(root, "memory");
  const researchRoot = options.research
    ? await privateSubdirectory(root, "research")
    : undefined;
  const graphRoot = options.knowledgeGraph
    ? await privateSubdirectory(root, "knowledge-graph")
    : undefined;
  const skillsRoot = await privateSubdirectory(root, "skills");
  const reviewRoot = await privateSubdirectory(root, "review");
  const hostRoot = join(root, "sessions");
  await mkdir(hostRoot, { recursive: true, mode: 0o700 });
  const baseRegistry =
    options.registry ??
    (await loadModelRegistry({
      cwd: source,
      trustProjectConfig: options.trustProjectConfig === true,
    }));
  let omniroute: OmniRouteProcess | undefined;
  let registry = baseRegistry;
  if (options.omniroute) {
    const opened = await openOmniRoute(baseRegistry, options.omniroute);
    omniroute = opened.process;
    registry = opened.registry;
  }
  let store: Awaited<ReturnType<typeof createTaskStore>>;
  try {
    store = await createTaskStore({
      rootDir: join(root, "tasks"),
      workspaceRoots: [source],
      hostPrivateRoots: [root, memoryRoot, skillsRoot, reviewRoot],
    });
  } catch (error) {
    await omniroute?.stop().catch(() => undefined);
    throw error;
  }
  let workspace:
    | Awaited<ReturnType<typeof createLocalWorkspaceProvider>>
    | undefined;
  let host: Awaited<ReturnType<typeof createWorkbenchHost>> | undefined;
  let memory: DurableMemoryStore | undefined;
  let review: ReviewRunner | undefined;
  let repositoryMap: RepositoryMapProvider | undefined;
  let research: DurableResearchService | undefined;
  let server: ReturnType<typeof serveWorkbench> | undefined;
  try {
    if (options.research && researchRoot) {
      const researchOptions = options.research;
      // The research store refuses roots that contain it, so its private
      // needles are the sibling state directories rather than the state root.
      const privateRoots = [
        source,
        memoryRoot,
        hostRoot,
        join(root, "tasks"),
        join(root, "workspaces"),
      ];
      const workerConfig = parseResearchWorkerConfig(researchOptions.worker);
      const worker = createResearchWorker({
        config: workerConfig,
        search: researchOptions.search,
        model:
          researchOptions.model ??
          createRegistryModelGateway({
            registry,
            ...(workerConfig.model ? { model: workerConfig.model } : {}),
            paidConsent: workerConfig.paid_consent,
            ...(researchOptions.env ? { env: researchOptions.env } : {}),
          }),
        ...(researchOptions.fetch ? { fetch: researchOptions.fetch } : {}),
        ...(researchOptions.resolveHost
          ? { resolveHost: researchOptions.resolveHost }
          : {}),
        ...(researchOptions.log ? { log: researchOptions.log } : {}),
        hostPrivateRoots: privateRoots,
      });
      research = await createResearchService({
        ...researchOptions.service,
        rootDir: researchRoot,
        tasks: store,
        artifacts: store.artifacts,
        events: store,
        worker,
        hostPrivateRoots: privateRoots,
      });
    }
    memory = createMemoryStore({
      rootDir: memoryRoot,
      hostPrivateRoots: [source, root, memoryRoot, skillsRoot, reviewRoot],
    });
    const skills = new SkillStore(skillsRoot);
    // Background review is proposal-only and free-model-only; without an
    // eligible free model the workbench simply runs without it.
    try {
      review = new ReviewRunner({
        context: { schema_version: 1, scope, request_id: randomUUID() },
        memory,
        skills,
        model: createRegistryReviewGateway({ registry }),
        logRoot: reviewRoot,
      });
    } catch {
      review = undefined;
    }
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
    repositoryMap = createRepositoryMapProvider({
      confinement: "anchored",
      async resolveRoot(context, ref) {
        const current = await provider.inspect(context, ref.workspace_id);
        if (current.provider !== ref.provider)
          throw new WorkbenchError("forbidden");
        return {
          root: await provider.workspacePath(context, ref),
          revision: current.revision,
        };
      },
    });
    const knowledgeGraph =
      options.knowledgeGraph && graphRoot
        ? createKnowledgeGraphService({
            command: options.knowledgeGraph.command,
            ...(options.knowledgeGraph.timeoutMs !== undefined
              ? { timeoutMs: options.knowledgeGraph.timeoutMs }
              : {}),
            ...(options.knowledgeGraph.osWrapper !== undefined
              ? { osWrapper: options.knowledgeGraph.osWrapper }
              : {}),
            dataRoot: graphRoot,
            artifacts: createDerivedArtifactStore({
              rootDir: join(graphRoot, "artifacts"),
            }),
          })
        : undefined;
    host = await createWorkbenchHost({
      scope,
      workspaceLabel: basename(source),
      stateRoot: hostRoot,
      store,
      registry,
      canExecute: Boolean(sandbox),
      memory,
      skills,
      ...(review ? { review } : {}),
      repositoryMap,
      ...(options.specialists ? { specialists: options.specialists } : {}),
      ...(options.collaboration
        ? { collaboration: options.collaboration }
        : {}),
      ...(research ? { research } : {}),
      ...(knowledgeGraph ? { knowledgeGraph } : {}),
      hostPrivateRoots: [
        memoryRoot,
        skillsRoot,
        reviewRoot,
        source,
        ...(researchRoot ? [researchRoot] : []),
        ...(graphRoot ? [graphRoot] : []),
      ],
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
    const runningMemory = memory;
    const runningReview = review;
    const runningRepositoryMap = repositoryMap;
    const runningResearch = research;
    const researchDrainMs = options.research?.drainMs;
    let closing: Promise<void> | undefined;
    return {
      url,
      connectionFile,
      omniroute: omniroute?.status() ?? null,
      close() {
        closing ??= (async () => {
          const outcomes = [
            await Promise.allSettled([runningServer.stop(true)]),
            await Promise.allSettled([runningHost.close()]),
            await Promise.allSettled([
              runningResearch
                ? runningResearch.close(
                    researchDrainMs === undefined
                      ? undefined
                      : { drainMs: researchDrainMs },
                  )
                : Promise.resolve(),
            ]),
            await Promise.allSettled([
              runningReview?.stop() ?? Promise.resolve(),
            ]),
            await Promise.allSettled([omniroute?.stop() ?? Promise.resolve()]),
            await Promise.allSettled([runningRepositoryMap.close()]),
            await Promise.allSettled([runningMemory.close()]),
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
    if (research) await research.close({ drainMs: 0 }).catch(() => undefined);
    if (review) await review.stop().catch(() => undefined);
    if (omniroute) await omniroute.stop().catch(() => undefined);
    if (repositoryMap) await repositoryMap.close().catch(() => undefined);
    if (workspace) await workspace.close().catch(() => undefined);
    if (memory) await memory.close().catch(() => undefined);
    await store.close();
    throw error;
  }
}
