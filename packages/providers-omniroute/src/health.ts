import { catalogAgeDays, type FreeTierCatalog } from "./catalog";
import {
  type ExclusionOverrides,
  type ExclusionSummary,
  summarizeExclusions,
} from "./exclusions";
import { OMNIROUTE_PIN } from "./pin";
import { omnirouteRequestHeaders } from "./policy";
import type { DiscoveredCapabilities } from "./provider";
import {
  OMNIROUTE_API_KEY_ENV,
  OMNIROUTE_DEFAULT_URL,
  omnirouteBaseUrl,
} from "./provider";

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export interface ProbeOptions {
  url?: string;
  fetch?: FetchLike;
  env?: Record<string, string | undefined>;
  apiKeyEnv?: string;
  timeoutMs?: number;
}

/** Booleans and counts only; the probe never reports header or key values. */
export interface OmniRouteProbe {
  url: string;
  reachable: boolean;
  models_endpoint: boolean;
  /** False when OmniRoute answered 401/403; null when it never answered. */
  authorized: boolean | null;
  status: number | null;
  model_count: number | null;
  api_key_env_present: boolean;
}

/**
 * Field names match OmniRoute's `/v1/models` catalog at the pinned revision
 * (`src/app/api/v1/models/catalog.ts`: `capabilities.tool_calling`,
 * `capabilities.vision`, `context_length`, `max_input_tokens`,
 * `input_modalities`); verified against source, not against a live gateway.
 */
interface ModelRow {
  id: string;
  tools: boolean;
  vision: boolean;
  contextWindow: number | undefined;
}

function readModelRows(payload: unknown): ModelRow[] {
  if (typeof payload !== "object" || payload === null) return [];
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const rows: ModelRow[] = [];
  for (const row of data) {
    if (typeof row !== "object" || row === null) continue;
    const record = row as Record<string, unknown>;
    if (typeof record.id !== "string") continue;
    const capabilities =
      typeof record.capabilities === "object" && record.capabilities !== null
        ? (record.capabilities as Record<string, unknown>)
        : {};
    const context = [
      record.context_length,
      record.max_input_tokens,
      record.context_window,
    ].find((value) => typeof value === "number" && value > 0);
    const inputModalities = Array.isArray(record.input_modalities)
      ? record.input_modalities
      : [];
    rows.push({
      id: record.id,
      tools:
        capabilities.tool_calling === true ||
        capabilities.tools === true ||
        record.tool_calling === true,
      vision:
        capabilities.vision === true ||
        record.vision === true ||
        inputModalities.includes("image"),
      contextWindow: typeof context === "number" ? context : undefined,
    });
  }
  return rows;
}

async function fetchModels(
  options: ProbeOptions,
): Promise<{ status: number | null; rows: ModelRow[] | null }> {
  const fetcher = options.fetch ?? fetch;
  const env = options.env ?? process.env;
  const apiKey = env[options.apiKeyEnv ?? OMNIROUTE_API_KEY_ENV];
  const headers = new Headers(omnirouteRequestHeaders("absent"));
  headers.set("Accept", "application/json");
  if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? 2_000,
  );
  try {
    const response = await fetcher(
      `${omnirouteBaseUrl(options.url ?? OMNIROUTE_DEFAULT_URL)}/models`,
      { method: "GET", headers, signal: controller.signal },
    );
    if (!response.ok) return { status: response.status, rows: null };
    const payload: unknown = await response.json().catch(() => undefined);
    return { status: response.status, rows: readModelRows(payload) };
  } catch {
    return { status: null, rows: null };
  } finally {
    clearTimeout(timer);
  }
}

/** One `GET /v1/models`; never a chat completion, so `model_requests` stays 0. */
export async function probeOmniRoute(
  options: ProbeOptions = {},
): Promise<OmniRouteProbe> {
  const env = options.env ?? process.env;
  const url = omnirouteBaseUrl(options.url ?? OMNIROUTE_DEFAULT_URL);
  const { status, rows } = await fetchModels(options);
  return {
    url,
    reachable: status !== null,
    models_endpoint: rows !== null,
    authorized: status === null ? null : status !== 401 && status !== 403,
    status,
    model_count: rows?.length ?? null,
    api_key_env_present: Boolean(
      env[options.apiKeyEnv ?? OMNIROUTE_API_KEY_ENV],
    ),
  };
}

/** Capability discovery from the same endpoint; undefined when it is unavailable. */
export async function discoverOmniRouteCapabilities(
  options: ProbeOptions = {},
): Promise<DiscoveredCapabilities | undefined> {
  const { rows } = await fetchModels(options);
  if (!rows) return undefined;
  const listed = new Set<string>();
  const toolCapable = new Set<string>();
  const visionCapable = new Set<string>();
  const contextWindows = new Map<string, number>();
  for (const row of rows) {
    listed.add(row.id);
    if (row.tools) toolCapable.add(row.id);
    if (row.vision) visionCapable.add(row.id);
    if (row.contextWindow !== undefined)
      contextWindows.set(row.id, row.contextWindow);
  }
  return { listed, toolCapable, visionCapable, contextWindows };
}

/** Catalogs older than this are reported stale; the importer should be re-run. */
export const CATALOG_STALE_AFTER_DAYS = 120;

export interface CatalogHealth {
  present: boolean;
  release: string | null;
  revision_pinned: boolean;
  curated_at: string | null;
  age_days: number | null;
  stale: boolean;
  entries: ExclusionSummary | null;
}

export function catalogHealth(
  catalog: FreeTierCatalog | undefined,
  options: { now?: Date; overrides?: ExclusionOverrides } = {},
): CatalogHealth {
  if (!catalog)
    return {
      present: false,
      release: null,
      revision_pinned: false,
      curated_at: null,
      age_days: null,
      stale: true,
      entries: null,
    };
  const age = catalogAgeDays(catalog, options.now);
  return {
    present: true,
    release: catalog.source.release,
    revision_pinned: catalog.source.revision === OMNIROUTE_PIN.revision,
    curated_at: catalog.source.curated_at,
    age_days: age,
    stale: age > CATALOG_STALE_AFTER_DAYS,
    entries: summarizeExclusions(catalog, options.overrides),
  };
}
