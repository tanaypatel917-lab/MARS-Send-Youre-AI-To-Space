import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { registerRuntimeCleanup } from "@mars/execution";
import {
  createBraveSearch,
  createSearxngSearch,
  createTavilySearch,
  type SearchProvider,
} from "@mars/research-worker";
import {
  createWorkbenchService,
  type WorkbenchResearchOptions,
} from "@mars/workbench";

/** A configuration mistake whose message is safe to print: it names flags and environment variable names only. */
import { omnirouteFromFlags } from "./omniroute";
import { ServeUsageError } from "./serve-errors";

export { ServeUsageError };

/** Search providers `mars serve` can drive; credentials are read from the named environment variable at startup only. */
export const RESEARCH_SEARCH_PROVIDERS = {
  brave: {
    api_key_env: "BRAVE_SEARCH_API_KEY",
    docs_url: "https://brave.com/search/api/",
  },
  searxng: {
    api_key_env: null,
    docs_url: "https://docs.searxng.org/",
  },
  tavily: {
    api_key_env: "TAVILY_API_KEY",
    docs_url: "https://docs.tavily.com/",
  },
} as const;
export type ResearchSearchProviderId = keyof typeof RESEARCH_SEARCH_PROVIDERS;

export interface ResearchFlags {
  search?: string;
  apiKeyEnv?: string;
  searxngUrl?: string;
  model?: string;
  denyHosts?: string[];
}

function isSearchProviderId(value: string): value is ResearchSearchProviderId {
  return Object.hasOwn(RESEARCH_SEARCH_PROVIDERS, value);
}

/**
 * Builds the live research configuration from CLI flags. Only the credential's
 * environment variable name is ever reported; its value goes to the search
 * adapter and nowhere else.
 */
export function researchFromFlags(
  flags: ResearchFlags,
  env: Record<string, string | undefined>,
): WorkbenchResearchOptions | undefined {
  if (flags.search === undefined) {
    for (const [flag, value] of Object.entries({
      "--research-api-key-env": flags.apiKeyEnv,
      "--research-searxng-url": flags.searxngUrl,
      "--research-model": flags.model,
      "--research-deny-host": flags.denyHosts,
    })) {
      if (value !== undefined)
        throw new ServeUsageError(
          `${flag} requires --research-search <${Object.keys(RESEARCH_SEARCH_PROVIDERS).join("|")}>.`,
        );
    }
    return undefined;
  }
  if (!isSearchProviderId(flags.search))
    throw new ServeUsageError(
      `Unknown research search provider "${flags.search}"; expected one of ${Object.keys(RESEARCH_SEARCH_PROVIDERS).join(", ")}.`,
    );
  const provider = RESEARCH_SEARCH_PROVIDERS[flags.search];
  const pageFetch = (input: string, init?: RequestInit) => fetch(input, init);
  let search: SearchProvider;
  if (flags.search === "searxng") {
    if (flags.apiKeyEnv !== undefined)
      throw new ServeUsageError(
        "--research-api-key-env does not apply to SearXNG.",
      );
    const baseUrl = flags.searxngUrl;
    if (!baseUrl || !/^https?:\/\//.test(baseUrl))
      throw new ServeUsageError(
        "--research-search searxng requires --research-searxng-url http(s)://HOST[:PORT].",
      );
    search = createSearxngSearch({ baseUrl, fetch: pageFetch });
  } else {
    if (flags.searxngUrl !== undefined)
      throw new ServeUsageError(
        "--research-searxng-url applies only to --research-search searxng.",
      );
    const apiKeyEnv = flags.apiKeyEnv ?? provider.api_key_env;
    if (apiKeyEnv === null || !/^[A-Z_][A-Z0-9_]*$/.test(apiKeyEnv))
      throw new ServeUsageError(
        "--research-api-key-env must be an environment variable name.",
      );
    const apiKey = env[apiKeyEnv];
    if (!apiKey)
      throw new ServeUsageError(
        `Research search provider "${flags.search}" needs the ${apiKeyEnv} environment variable; it is not set.`,
      );
    search =
      flags.search === "brave"
        ? createBraveSearch({ apiKey, fetch: pageFetch })
        : createTavilySearch({ apiKey, fetch: pageFetch });
  }
  return {
    search,
    worker: {
      live: true,
      ...(flags.model ? { model: flags.model } : {}),
      ...(flags.denyHosts ? { deny_hosts: flags.denyHosts } : {}),
    },
    env,
  };
}

export async function runServer(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      source: { type: "string" },
      state: { type: "string" },
      port: { type: "string" },
      owner: { type: "string" },
      project: { type: "string" },
      image: { type: "string" },
      "trust-project": { type: "boolean" },
      "research-search": { type: "string" },
      "research-api-key-env": { type: "string" },
      "research-searxng-url": { type: "string" },
      "research-model": { type: "string" },
      "research-deny-host": { type: "string", multiple: true },
      graphify: { type: "string", multiple: true },
      "graphify-os-wrapper": { type: "boolean" },
      omniroute: { type: "boolean" },
      "omniroute-url": { type: "string" },
      "omniroute-start": { type: "boolean" },
      "omniroute-allow": { type: "string", multiple: true },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      [
        "Usage: mars serve [--source DIR] [--state PRIVATE_DIR] [--port 7331] [--owner ID] [--project ID] [--image REPO@sha256:DIGEST] [--trust-project]",
        "                  [--research-search brave|searxng|tavily] [--research-api-key-env NAME] [--research-searxng-url URL] [--research-model ID] [--research-deny-host PATTERN]... [--graphify ARG]... [--graphify-os-wrapper]",
        "                  [--omniroute] [--omniroute-url http://localhost:20128] [--omniroute-start] [--omniroute-allow web-session|browser-session|caution|ambiguous|unknown]...",
        "Without a pre-pulled digest-pinned image, command execution is disabled. No model request is made at startup. Connection credentials are written only to the private connection file.",
        "Code knowledge graph tools (mars_graph_build, mars_graph_query) are offered only with --graphify ARG (repeatable; the argv prefix of the pinned graphify 0.9.101 executable from a uv/venv install, optionally behind an OS sandbox such as bwrap, then pass --graphify-os-wrapper). Confinement without a wrapper is process-level only (argv, env allowlist, offline flags); the graph is a derived, rebuildable artifact.",
        "Background research runs only with --research-search. The search credential is read from BRAVE_SEARCH_API_KEY / TAVILY_API_KEY (or --research-api-key-env NAME) at startup and never stored; the worker uses the free default model unless --research-model names another free model. Live research is unverified.",
        "--omniroute adds a self-hosted OmniRoute gateway as the `omniroute` provider target (attach to a running instance; --omniroute-start spawns the pinned omniroute CLI on 127.0.0.1). Only free, non-excluded catalog models route; MARS keeps policy and sends its paid-consent state. OMNIROUTE_API_KEY (OmniRoute's own key) is read by name; upstream credentials stay in OmniRoute. Live OmniRoute use is unverified.",
      ].join("\n"),
    );
    return;
  }
  const research = researchFromFlags(
    {
      ...(values["research-search"] !== undefined
        ? { search: values["research-search"] }
        : {}),
      ...(values["research-api-key-env"] !== undefined
        ? { apiKeyEnv: values["research-api-key-env"] }
        : {}),
      ...(values["research-searxng-url"] !== undefined
        ? { searxngUrl: values["research-searxng-url"] }
        : {}),
      ...(values["research-model"] !== undefined
        ? { model: values["research-model"] }
        : {}),
      ...(values["research-deny-host"] !== undefined
        ? { denyHosts: values["research-deny-host"] }
        : {}),
    },
    process.env,
  );
  const omniroute = omnirouteFromFlags({
    ...(values.omniroute !== undefined ? { enabled: values.omniroute } : {}),
    ...(values["omniroute-url"] !== undefined
      ? { url: values["omniroute-url"] }
      : {}),
    ...(values["omniroute-start"] !== undefined
      ? { start: values["omniroute-start"] }
      : {}),
    ...(values["omniroute-allow"] !== undefined
      ? { allow: values["omniroute-allow"] }
      : {}),
  });
  const source = await realpath(resolve(values.source ?? process.cwd()));
  const project =
    values.project ??
    `project-${createHash("sha256").update(source).digest("hex").slice(0, 24)}`;
  const state = resolve(
    values.state ?? join(homedir(), ".mars", "workbench", project),
  );
  const service = await createWorkbenchService({
    sourceRoot: source,
    stateRoot: state,
    scope: { owner_id: values.owner ?? "local", project_id: project },
    port: values.port === undefined ? 7331 : Number(values.port),
    ...(values.image ? { image: values.image } : {}),
    ...(research ? { research } : {}),
    ...(values.graphify?.length
      ? {
          knowledgeGraph: {
            command: values.graphify,
            osWrapper: values["graphify-os-wrapper"] === true,
          },
        }
      : {}),
    ...(omniroute ? { omniroute } : {}),
    trustProjectConfig:
      values["trust-project"] === true ||
      process.env.MARS_TRUST_PROJECT_CONFIG === "1",
  });
  await new Promise<void>((resolve, reject) => {
    registerRuntimeCleanup("mars-workbench", async () => {
      try {
        await service.close();
        resolve();
      } catch {
        reject(new Error("Workbench shutdown failed."));
      }
    });
    console.log(
      JSON.stringify({
        status: "listening",
        url: service.url,
        connection_file: service.connectionFile,
        execute_enabled: Boolean(values.image),
        research: research ? { search: research.search.id, live: true } : null,
        knowledge_graph: values.graphify?.length
          ? {
              command: values.graphify,
              isolation: values["graphify-os-wrapper"]
                ? "os_wrapper"
                : "process_env",
            }
          : null,
        omniroute: service.omniroute,
      }),
    );
  });
}
