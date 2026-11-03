import type { ModelConfig, ProviderConfig } from "@mars/contracts";
import type { ModelProviderRegistry } from "@mars/providers";
import {
  type CatalogEntry,
  catalogModelKey,
  type FreeTierCatalog,
  type TermsVerdict,
} from "./catalog";
import { type ExclusionOverrides, isRoutable } from "./exclusions";
import { OMNIROUTE_PIN } from "./pin";
import {
  createOmniRouteAdapterFactory,
  type OmniRoutePolicyOptions,
} from "./policy";

export const OMNIROUTE_PROVIDER_ID = "omniroute";
export const OMNIROUTE_DEFAULT_URL = "http://localhost:20128";
/** OmniRoute's own gateway key, never an upstream provider credential. */
export const OMNIROUTE_API_KEY_ENV = "OMNIROUTE_API_KEY";
export const OMNIROUTE_FREE_ROUTE = "omniroute-free";
/** Context window assumed when `/v1/models` reports none; tagged `context:assumed`. */
export const ASSUMED_CONTEXT_WINDOW = 32_768;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function isLoopbackUrl(url: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Normalizes an OmniRoute origin or `/v1` URL to the `/v1` base the adapter posts to. */
export function omnirouteBaseUrl(url: string = OMNIROUTE_DEFAULT_URL): string {
  const parsed = new URL(url);
  if (parsed.search || parsed.hash || parsed.username || parsed.password)
    throw new Error("OmniRoute URL must be a bare origin or /v1 base URL.");
  const path = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = path.endsWith("/v1") ? path : `${path}/v1`;
  return parsed.toString().replace(/\/+$/, "");
}

export interface OmniRouteProviderOptions {
  url?: string;
  apiKeyEnv?: string;
}

export function omnirouteProvider(
  options: OmniRouteProviderOptions = {},
): ProviderConfig {
  return {
    id: OMNIROUTE_PROVIDER_ID,
    kind: "openai-compatible",
    baseUrl: omnirouteBaseUrl(options.url),
    apiKeyEnv: options.apiKeyEnv ?? OMNIROUTE_API_KEY_ENV,
    docsUrl: OMNIROUTE_PIN.repositoryUrl,
    freeTier: `Self-hosted OmniRoute ${OMNIROUTE_PIN.release} gateway; free tiers come from the bundled MARS catalog and MARS policy decides what routes.`,
  };
}

export function catalogModelId(
  entry: Pick<CatalogEntry, "provider" | "model">,
): string {
  return `${OMNIROUTE_PROVIDER_ID}/${catalogModelKey(entry)}`;
}

/** Capability facts observed from a live `GET /v1/models` (no model request). */
export interface DiscoveredCapabilities {
  /** Canonical `provider/model` ids OmniRoute currently lists. */
  listed: ReadonlySet<string>;
  toolCapable: ReadonlySet<string>;
  visionCapable: ReadonlySet<string>;
  contextWindows: ReadonlyMap<string, number>;
}

export interface OmniRouteModelsOptions {
  overrides?: ExclusionOverrides;
  /**
   * Without discovery nothing is known about tools or vision, so every
   * catalog model is registered as text-only and tool-less; the execution
   * runtime then never selects it, while tool-less callers still can.
   */
  discovered?: DiscoveredCapabilities;
}

const VERDICT_ORDER: Record<TermsVerdict, number> = {
  ok: 0,
  unknown: 1,
  caution: 2,
  ambiguous: 3,
  avoid: 4,
};

/** Free-first order: cleaner terms first, then larger documented quotas. */
export function compareCatalogEntries(
  a: CatalogEntry,
  b: CatalogEntry,
): number {
  return (
    VERDICT_ORDER[a.terms_risk.verdict] - VERDICT_ORDER[b.terms_risk.verdict] ||
    b.quota.monthly_tokens - a.quota.monthly_tokens ||
    b.quota.credit_tokens - a.quota.credit_tokens ||
    catalogModelKey(a).localeCompare(catalogModelKey(b))
  );
}

export function routableEntries(
  catalog: FreeTierCatalog,
  overrides: ExclusionOverrides = {},
): CatalogEntry[] {
  return catalog.entries
    .filter((entry) => isRoutable(entry, overrides))
    .sort(compareCatalogEntries);
}

export function omnirouteModels(
  catalog: FreeTierCatalog,
  options: OmniRouteModelsOptions = {},
): ModelConfig[] {
  const discovered = options.discovered;
  return routableEntries(catalog, options.overrides).map((entry) => {
    const key = catalogModelKey(entry);
    const contextWindow = discovered?.contextWindows.get(key);
    const tags = [
      "omniroute",
      `tos:${entry.terms_risk.verdict}`,
      `free:${entry.free_type}`,
      ...(discovered ? [] : ["capabilities:unknown"]),
      ...(discovered && !discovered.listed.has(key) ? ["unlisted"] : []),
      ...(contextWindow === undefined ? ["context:assumed"] : []),
    ];
    return {
      id: catalogModelId(entry),
      providerId: OMNIROUTE_PROVIDER_ID,
      model: key,
      capabilities: {
        tools: discovered?.toolCapable.has(key) ?? false,
        vision: discovered?.visionCapable.has(key) ?? false,
        contextWindow: contextWindow ?? ASSUMED_CONTEXT_WINDOW,
      },
      pricing: { free: true },
      tags,
    };
  });
}

export interface OmniRouteRegistryOptions extends OmniRouteModelsOptions {
  catalog: FreeTierCatalog;
  url?: string;
  apiKeyEnv?: string;
  /**
   * Appends the OmniRoute free route after the existing default route so
   * configured free models keep priority and OmniRoute is the fallback.
   * Default true.
   */
  extendDefaultRoute?: boolean;
  policy?: Omit<OmniRoutePolicyOptions, "catalog" | "overrides">;
}

/**
 * Layers the OmniRoute target over a loaded registry: one provider, one
 * model per routable catalog entry, an `omniroute-free` route, and the
 * policy-guarding adapter factory. The user's `allowPaid` is untouched.
 */
export function extendRegistryWithOmniRoute(
  registry: ModelProviderRegistry,
  options: OmniRouteRegistryOptions,
): ModelProviderRegistry {
  const provider = omnirouteProvider({
    ...(options.url ? { url: options.url } : {}),
    ...(options.apiKeyEnv ? { apiKeyEnv: options.apiKeyEnv } : {}),
  });
  const models = omnirouteModels(options.catalog, {
    ...(options.overrides ? { overrides: options.overrides } : {}),
    ...(options.discovered ? { discovered: options.discovered } : {}),
  });
  const ids = models.map((model) => model.id);
  const routes: Record<string, string[]> = { [OMNIROUTE_FREE_ROUTE]: ids };
  if (options.extendDefaultRoute !== false) {
    const current = registry.routes.default ?? [];
    routes.default = [...current, ...ids.filter((id) => !current.includes(id))];
  }
  return registry.extend({
    providers: [provider],
    models,
    routes,
    adapterFactory: createOmniRouteAdapterFactory({
      ...options.policy,
      catalog: options.catalog,
      ...(options.overrides ? { overrides: options.overrides } : {}),
    }),
    notice: `OmniRoute target enabled at ${provider.baseUrl}: ${models.length} free catalog models routable under MARS policy (MCP/A2A unused, compression off).`,
  });
}
