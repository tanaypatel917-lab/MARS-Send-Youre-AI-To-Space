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
  type BrowserPolicyAction,
  type BrowserServiceOptions,
  createBrowserService,
  type DurableBrowserService,
} from "@mars/browser";
import {
  type BrowserEngine,
  type BrowserWorkerConfigInput,
  type BrowserWorkerLogEvent,
  createBrowserWorker,
} from "@mars/browser-worker";
import {
  createDerivedArtifactStore,
  createRepositoryMapProvider,
  type RepositoryMapProvider,
} from "@mars/context";
import { type Scope, ScopeSchema } from "@mars/contracts";
import { createKnowledgeGraphService } from "@mars/knowledge-graph";
import { createMemoryStore, type DurableMemoryStore } from "@mars/memory";
import { vaultStatus } from "@mars/memory-vault";
import { loadModelRegistry, type ModelProviderRegistry } from "@mars/providers";
import {
  catalogHealth,
  createOmniRouteProcess,
  discoverOmniRouteCapabilities,
  type ExclusionOverrides,
  extendRegistryWithOmniRoute,
  type FreeTierCatalog,
  loadFreeTierCatalog,
  OMNIROUTE_DEFAULT_URL,
  OMNIROUTE_PROVIDER_ID,
  type OmniRouteProcess,
  type OmniRouteProcessOptions,
  type OmniRouteProcessStatus,
} from "@mars/providers-omniroute";
import {
  createResearchService,
  type DurableResearchService,
  type ResearchBudgetLedger,
  type ResearchConcurrencySlots,
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
import { SkillOutcomeLedger, SkillStore } from "@mars/skills";
import { createTaskStore, type DurableTaskStore } from "@mars/tasks";
import {
  type CommandApprovalRequest,
  createDockerSandbox,
  createLocalWorkspaceProvider,
  DockerSandboxPrerequisiteError,
  type LocalWorkspaceProvider,
  WorkspaceNotFoundError,
} from "@mars/workspaces";
import {
  clientFor,
  createRemoteWorkspaceProvider,
  type IsolationReport,
  type RemoteWorkspaceConfig,
  type RemoteWorkspaceProvider,
} from "@mars/workspaces-remote";
import type { WorkbenchCollaboration } from "./collaboration-context";
import type { WorkbenchConventions } from "./conventions-context";
import {
  createWorkbenchHost,
  type WorkbenchEditFormats,
  type WorkbenchHostOptions,
} from "./host";
import { loadHostChecks } from "./host-checks";
import {
  DEFAULT_WORKBENCH_PORT,
  serveWorkbench,
  WorkbenchError,
} from "./server";
import type { WorkbenchSpecialists } from "./specialist-routing";

/** How often the skill curator runs while the workbench is up. */
export const SKILL_CURATOR_INTERVAL_MS = 6 * 60 * 60 * 1000;

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
 * Background browser tasks: the durable `@mars/browser` control plane under the
 * private state root plus the `@mars/browser-worker` driving `engine` (the
 * Playwright adapter in production, the fake engine in tests). Every page
 * request goes through the worker's guarded fetch.
 */
export interface WorkbenchBrowserOptions {
  engine: BrowserEngine;
  /** Worker settings; `live: true` permits the global fetch and real DNS. */
  worker?: BrowserWorkerConfigInput;
  /**
   * Planner for jobs without scripted actions. Defaults to the registry's free
   * default route; without an eligible free model only scripted jobs run.
   */
  model?: ModelGateway;
  /** Host ceiling on actions a request may allow (default read-only browsing). */
  allowedActions?: readonly BrowserPolicyAction[];
  service?: Pick<
    BrowserServiceOptions,
    | "maxConcurrency"
    | "maxActivePerTask"
    | "maxAttempts"
    | "leaseMs"
    | "retryBackoffMs"
    | "pollMs"
  >;
  /** Page fetch for the worker; required unless `worker.live` is true. */
  fetch?: FetchLike;
  resolveHost?: HostResolver;
  env?: Record<string, string | undefined>;
  log?: (event: BrowserWorkerLogEvent) => void;
  /** Time given to running jobs before shutdown re-queues them (default 5 s). */
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
  sandboxDockerPath?: string;
  allowUnavailableSandbox?: boolean;
  verifiedExportsOnly?: boolean;
  /** Run workspace operations on an OpenHands Agent Server instead of locally. */
  remoteWorkspace?: RemoteWorkspaceConfig;
  /** Host-owned protected check definitions (JSON); clients select them by id at Start. */
  checksFile?: string;
  /** Optional existing vault to report read-only status; never imported/exported by the workbench. */
  vaultDir?: string;
  trustProjectConfig?: boolean;
  registry?: ModelProviderRegistry;
  /** Evidence-gated specialist router; launches use the registry default without it. */
  specialists?: WorkbenchSpecialists;
  /** Verified per-model edit-format evidence; launches use the static default without it. */
  editFormats?: WorkbenchEditFormats;
  /** Task-scoped collaboration rooms; launches stay single-agent without it. */
  collaboration?: WorkbenchCollaboration;
  /** Background research worker and control plane; sessions get no research tools without it. */
  research?: WorkbenchResearchOptions;
  /** Background browser worker and control plane; sessions get no browser tools without it. */
  browser?: WorkbenchBrowserOptions;
  /** Pinned graphify CLI (argv prefix); sessions get no graph tools without it. */
  knowledgeGraph?: {
    command: string[];
    timeoutMs?: number;
    /** `command` wraps graphify in an OS sandbox (bwrap, firejail, …). */
    osWrapper?: boolean;
  };
  /** Repository conventions (instruction files, skill folders, hooks, slash commands, apply_patch) loaded by the caller from the trusted checkout. */
  conventions?: WorkbenchConventions;
  /** OmniRoute provider target; absent means no OmniRoute models exist. */
  omniroute?: WorkbenchOmniRouteOptions;
  runtimeFactory?: WorkbenchHostOptions["runtimeFactory"];
  mcp?: WorkbenchHostOptions["mcp"];
}

export interface WorkbenchService {
  readonly url: string;
  readonly connectionFile: string;
  /** Null unless the service was started with `omniroute`. */
  readonly omniroute: OmniRouteProcessStatus | null;
  /** Isolation actually established by the remote workspace provider, if any. */
  readonly workspaceIsolation?: IsolationReport;
  close(): Promise<void>;
}

async function openOmniRoute(
  registry: ModelProviderRegistry,
  options: WorkbenchOmniRouteOptions,
): Promise<{
  process: OmniRouteProcess;
  registry: ModelProviderRegistry;
  providerStatus: NonNullable<WorkbenchHostOptions["providerStatus"]>;
}> {
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
      providerStatus: {
        [OMNIROUTE_PROVIDER_ID]: {
          health: discovered ? "available" : "unknown",
          catalog_stale: catalogHealth(catalog).stale,
        },
      },
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
  const browserRoot = options.browser
    ? await privateSubdirectory(root, "browser")
    : undefined;
  const graphRoot = options.knowledgeGraph
    ? await privateSubdirectory(root, "knowledge-graph")
    : undefined;
  const skillsRoot = await privateSubdirectory(root, "skills");
  const outcomesRoot = await privateSubdirectory(root, "skill-outcomes");
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
  let providerStatus: WorkbenchHostOptions["providerStatus"];
  if (options.omniroute) {
    const opened = await openOmniRoute(baseRegistry, options.omniroute);
    omniroute = opened.process;
    registry = opened.registry;
    providerStatus = opened.providerStatus;
  }
  let store: Awaited<ReturnType<typeof createTaskStore>>;
  try {
    store = await createTaskStore({
      rootDir: join(root, "tasks"),
      workspaceRoots: [source],
      hostPrivateRoots: [
        root,
        memoryRoot,
        skillsRoot,
        outcomesRoot,
        reviewRoot,
      ],
    });
  } catch (error) {
    await omniroute?.stop().catch(() => undefined);
    throw error;
  }
  let workspace: LocalWorkspaceProvider | RemoteWorkspaceProvider | undefined;
  let workspaceIsolation: IsolationReport | undefined;
  let host: Awaited<ReturnType<typeof createWorkbenchHost>> | undefined;
  let memory: DurableMemoryStore | undefined;
  let review: ReviewRunner | undefined;
  let skillOutcomes: SkillOutcomeLedger | undefined;
  let curatorTimer: ReturnType<typeof setInterval> | undefined;
  let curating: Promise<unknown> | undefined;
  let repositoryMap: RepositoryMapProvider | undefined;
  let research: DurableResearchService | undefined;
  let browser: DurableBrowserService | undefined;
  let server: ReturnType<typeof serveWorkbench> | undefined;
  // One teardown order for both close() and startup failure; each step
  // skips resources that were never opened.
  const teardown = async (researchDrainMs: number | undefined) => {
    const steps: (() => unknown)[] = [
      () => server?.stop(true),
      () => host?.close(),
      () =>
        research?.close(
          researchDrainMs === undefined
            ? undefined
            : { drainMs: researchDrainMs },
        ),
      () =>
        browser?.close(
          options.browser?.drainMs === undefined
            ? undefined
            : { drainMs: options.browser.drainMs },
        ),
      () => clearInterval(curatorTimer),
      () => curating,
      () => review?.stop(),
      () => omniroute?.stop(),
      () => repositoryMap?.close(),
      () => memory?.close(),
      () => skillOutcomes?.close(),
      () => workspace?.close(),
      () => store.close(),
    ];
    let failed = false;
    for (const step of steps) {
      try {
        await step();
      } catch {
        failed = true;
      }
    }
    return failed;
  };
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
        ...taskBudgetLedger(store),
        artifacts: store.artifacts,
        events: store,
        worker,
        hostPrivateRoots: privateRoots,
      });
    }
    if (options.browser && browserRoot) {
      const browserOptions = options.browser;
      const privateRoots = [
        source,
        memoryRoot,
        hostRoot,
        join(root, "tasks"),
        join(root, "workspaces"),
      ];
      let model = browserOptions.model;
      if (!model) {
        try {
          model = createRegistryModelGateway({
            registry,
            paidConsent: false,
            ...(browserOptions.env ? { env: browserOptions.env } : {}),
          });
        } catch {
          model = undefined;
        }
      }
      browser = await createBrowserService({
        ...browserOptions.service,
        rootDir: browserRoot,
        tasks: store,
        ...taskBudgetLedger(store),
        artifacts: store.artifacts,
        worker: createBrowserWorker({
          engine: browserOptions.engine,
          ...(model ? { model } : {}),
          ...(browserOptions.worker ? { config: browserOptions.worker } : {}),
          ...(browserOptions.fetch ? { fetch: browserOptions.fetch } : {}),
          ...(browserOptions.resolveHost
            ? { resolveHost: browserOptions.resolveHost }
            : {}),
          ...(browserOptions.log ? { log: browserOptions.log } : {}),
          hostPrivateRoots: privateRoots,
        }),
        hostPrivateRoots: privateRoots,
        ...(browserOptions.allowedActions
          ? { allowedActions: browserOptions.allowedActions }
          : {}),
      });
    }
    memory = createMemoryStore({
      rootDir: memoryRoot,
      hostPrivateRoots: [
        source,
        root,
        memoryRoot,
        skillsRoot,
        outcomesRoot,
        reviewRoot,
      ],
    });
    const skills = new SkillStore(skillsRoot);
    skillOutcomes = new SkillOutcomeLedger(
      join(outcomesRoot, "outcomes.sqlite"),
    );
    // The curator only marks idle skills stale or archives them (never
    // deletes, pinned skills exempt); a failed pass waits for the next one.
    const curate = () => {
      curating ??= skills
        .runCurator({ actor: "curator", source: "curator" })
        .catch(() => undefined)
        .finally(() => {
          curating = undefined;
        });
    };
    curate();
    curatorTimer = setInterval(curate, SKILL_CURATOR_INTERVAL_MS);
    curatorTimer.unref?.();
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
    let sandbox = options.image
      ? createDockerSandbox({
          image: options.image,
          ...(options.sandboxDockerPath
            ? { dockerPath: options.sandboxDockerPath }
            : {}),
        })
      : undefined;
    let verificationReadiness: WorkbenchHostOptions["verificationReadiness"];
    try {
      await sandbox?.verify();
      if (sandbox)
        verificationReadiness = {
          status: "ready",
          reason: "Protected checks run in a network-disabled sandbox",
        };
    } catch (error) {
      if (
        !options.allowUnavailableSandbox ||
        !(error instanceof DockerSandboxPrerequisiteError)
      )
        throw error;
      sandbox = undefined;
      verificationReadiness = {
        status: "unavailable",
        reason: error.message.startsWith("Pinned Docker image")
          ? "Sandbox image not downloaded"
          : error.message === "Docker daemon is unavailable"
            ? "Docker is not running or access is denied"
            : "Docker CLI is not installed or executable",
        setup: "Use Project → Set Up Verification Sandbox…",
      };
    }
    const checks = options.checksFile
      ? await loadHostChecks(options.checksFile)
      : [];
    const remote = options.remoteWorkspace;
    const canExecute = Boolean(sandbox) || Boolean(remote);
    const approveCommand = async (request: CommandApprovalRequest) =>
      canExecute &&
      (await store.inspect(request.context, request.task_id)).status ===
        "running";
    const remoteProvider = remote
      ? await createRemoteWorkspaceProvider({
          rootDir: join(root, "remote-workspaces"),
          sourceRoot: source,
          artifacts: store.artifacts,
          client: clientFor(remote),
          remoteRoot: remote.remoteRoot,
          approveCommand,
        })
      : undefined;
    workspaceIsolation = remoteProvider?.isolation();
    workspace = remoteProvider
      ? remoteProvider
      : await createLocalWorkspaceProvider({
          rootDir: join(root, "workspaces"),
          sourceRoot: source,
          artifacts: store.artifacts,
          ...(sandbox ? { sandbox } : {}),
          approveCommand,
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
      ...(options.mcp ? { mcp: options.mcp } : {}),
      scope,
      workspaceLabel: basename(source),
      stateRoot: hostRoot,
      store,
      registry,
      canExecute,
      ...(verificationReadiness ? { verificationReadiness } : {}),
      verifiedExportsOnly: Boolean(options.verifiedExportsOnly),
      ...(checks.length ? { checks } : {}),
      ...(sandbox && options.image ? { image: options.image } : {}),
      ...(providerStatus ? { providerStatus } : {}),
      ...(options.vaultDir
        ? {
            vault: {
              status: (context) =>
                vaultStatus(context, {
                  vaultDir: options.vaultDir as string,
                  memory: memory as DurableMemoryStore,
                  skills,
                  privateRoots: [root, source],
                }),
            },
          }
        : {}),
      memory,
      memoryProposals: memory,
      skills,
      skillOutcomes,
      skillOperator: { store: skills, ledger: skillOutcomes },
      ...(review ? { review } : {}),
      repositoryMap,
      ...(options.specialists ? { specialists: options.specialists } : {}),
      ...(options.editFormats ? { editFormats: options.editFormats } : {}),
      ...(options.collaboration
        ? { collaboration: options.collaboration }
        : {}),
      ...(research ? { research } : {}),
      ...(browser ? { browser } : {}),
      ...(knowledgeGraph ? { knowledgeGraph } : {}),
      ...(options.conventions ? { conventions: options.conventions } : {}),
      hostPrivateRoots: [
        memoryRoot,
        skillsRoot,
        reviewRoot,
        outcomesRoot,
        source,
        ...(researchRoot ? [researchRoot] : []),
        ...(graphRoot ? [graphRoot] : []),
      ],
      workspace: {
        prepare: provider.prepare.bind(provider),
        read: provider.read.bind(provider),
        write: provider.write.bind(provider),
        remove: provider.remove.bind(provider),
        execute: provider.execute.bind(provider),
        checkpoint: provider.checkpoint.bind(provider),
        restore: provider.restore.bind(provider),
        collect: provider.collect.bind(provider),
        stop: provider.stop.bind(provider),
        diff: provider.diff.bind(provider),
        ...(canExecute ? { runCheck: provider.runCheck.bind(provider) } : {}),
        exportPatch: provider.exportPatch.bind(provider),
        ...("search" in provider
          ? { search: provider.search.bind(provider) }
          : {}),
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
      port: options.port ?? DEFAULT_WORKBENCH_PORT,
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
    const researchDrainMs = options.research?.drainMs;
    let closing: Promise<void> | undefined;
    return {
      url,
      connectionFile,
      omniroute: omniroute?.status() ?? null,
      ...(workspaceIsolation ? { workspaceIsolation } : {}),
      close() {
        closing ??= (async () => {
          if (await teardown(researchDrainMs))
            throw new WorkbenchError("unavailable");
        })();
        return closing;
      },
    };
  } catch (error) {
    await teardown(0);
    throw error;
  }
}

function taskBudgetLedger(store: DurableTaskStore): {
  ledger?: ResearchBudgetLedger;
  slots?: ResearchConcurrencySlots;
} {
  const { reserveBudget, recordBudget, budgetCommitted } = store;
  if (!reserveBudget || !recordBudget || !budgetCommitted) return {};
  const { acquireSlot, releaseSlot } = store;
  return {
    ...(acquireSlot && releaseSlot
      ? {
          slots: {
            acquire: (context, taskId, key, lease) =>
              acquireSlot.call(store, context, taskId, key, lease),
            release: (context, taskId, key) =>
              releaseSlot.call(store, context, taskId, key),
          },
        }
      : {}),
    ledger: {
      reserve: (context, taskId, key, amount) =>
        reserveBudget.call(store, context, taskId, key, amount),
      record: (context, taskId, key, amount) =>
        recordBudget.call(store, context, taskId, key, amount),
      committed: (context, taskId, excludeKey) =>
        budgetCommitted.call(store, context, taskId, excludeKey),
    },
  };
}
