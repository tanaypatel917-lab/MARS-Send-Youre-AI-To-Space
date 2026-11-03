import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type AccessKind,
  type CatalogEntry,
  FREE_TYPES,
  type FreeTierCatalog,
  type FreeType,
  parseFreeTierCatalog,
  TERMS_VERDICTS,
  type TermsVerdict,
} from "./catalog";

/**
 * Upstream files the importer reads, relative to an OmniRoute checkout.
 * The data file is hand-curated TypeScript; it is parsed as text (no eval,
 * no upstream code executed) so the importer stays offline and deterministic.
 */
export const UPSTREAM_CATALOG_FILES = [
  "open-sse/config/freeModelCatalog.data.ts",
  "open-sse/config/freeTierCatalog.ts",
  "src/shared/constants/providers/web-cookie.ts",
  "src/shared/constants/providers/noauth.ts",
] as const;

export interface UpstreamCatalogSources {
  /** `open-sse/config/freeModelCatalog.data.ts` */
  budgets: string;
  /** `open-sse/config/freeTierCatalog.ts` */
  tiers: string;
  /** `src/shared/constants/providers/web-cookie.ts` */
  webCookie: string;
  /** `src/shared/constants/providers/noauth.ts` */
  noAuth: string;
}

export interface ImportOptions {
  repositoryUrl: string;
  release: string;
  revision: string;
}

export class CatalogImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogImportError";
  }
}

const VERDICT_RANK: Record<TermsVerdict, number> = {
  ok: 0,
  unknown: 1,
  caution: 2,
  ambiguous: 3,
  avoid: 4,
};

type Scalar = string | number | boolean | null;

const FIELD_PATTERN =
  /([A-Za-z_][A-Za-z0-9_]*)\s*:\s*("(?:[^"\\]|\\.)*"|-?\d[\d_]*(?:\.\d+)?|true|false|null)/g;

function parseScalar(raw: string): Scalar {
  if (raw.startsWith('"')) return JSON.parse(raw) as string;
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  return Number(raw.replaceAll("_", ""));
}

function parseObjectLiteral(body: string): Record<string, Scalar> {
  const fields: Record<string, Scalar> = {};
  for (const match of body.matchAll(FIELD_PATTERN)) {
    const [, key, raw] = match;
    if (key && raw !== undefined) fields[key] = parseScalar(raw);
  }
  return fields;
}

function expectString(
  fields: Record<string, Scalar>,
  key: string,
  line: number,
): string {
  const value = fields[key];
  if (typeof value !== "string")
    throw new CatalogImportError(
      `Line ${line}: expected string field "${key}".`,
    );
  return value;
}

function expectInteger(
  fields: Record<string, Scalar>,
  key: string,
  line: number,
): number {
  const value = fields[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
    throw new CatalogImportError(
      `Line ${line}: expected non-negative integer field "${key}".`,
    );
  return value;
}

function expectEnum<T extends string>(
  values: readonly T[],
  value: string,
  key: string,
  line: number,
): T {
  if (!(values as readonly string[]).includes(value))
    throw new CatalogImportError(
      `Line ${line}: unknown ${key} "${value}"; update the importer for the pinned release.`,
    );
  return value as T;
}

function optionalBoolean(
  fields: Record<string, Scalar>,
  key: string,
  line: number,
): boolean | undefined {
  const value = fields[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean")
    throw new CatalogImportError(`Line ${line}: expected boolean "${key}".`);
  return value;
}

interface UpstreamBudget {
  provider: string;
  modelId: string;
  displayName: string;
  monthlyTokens: number;
  creditTokens: number;
  freeType: FreeType;
  poolKey: string | null;
  tos: TermsVerdict;
  trainsOnPrompts?: boolean;
  hardStopGuaranteed?: boolean;
  eligibilityGate?: string;
}

/** Parses the `FREE_MODEL_BUDGETS` rows of `freeModelCatalog.data.ts`. */
export function parseBudgetRows(source: string): UpstreamBudget[] {
  const rows: UpstreamBudget[] = [];
  const lines = source.split("\n");
  let inside = false;
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    if (!inside) {
      if (/^export const FREE_MODEL_BUDGETS\b/.test(line)) inside = true;
      continue;
    }
    if (/^\];/.test(line)) break;
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    if (!trimmed.endsWith("},") && !trimmed.endsWith("}"))
      throw new CatalogImportError(
        `Line ${lineNumber}: multi-line catalog row; the importer expects one row per line.`,
      );
    const fields = parseObjectLiteral(trimmed);
    const poolKey = fields.poolKey;
    if (poolKey !== null && typeof poolKey !== "string")
      throw new CatalogImportError(`Line ${lineNumber}: invalid poolKey.`);
    const eligibilityGate = fields.eligibilityGate;
    if (eligibilityGate !== undefined && typeof eligibilityGate !== "string")
      throw new CatalogImportError(
        `Line ${lineNumber}: invalid eligibilityGate.`,
      );
    const trainsOnPrompts = optionalBoolean(
      fields,
      "trainsOnPrompts",
      lineNumber,
    );
    const hardStopGuaranteed = optionalBoolean(
      fields,
      "hardStopGuaranteed",
      lineNumber,
    );
    rows.push({
      provider: expectString(fields, "provider", lineNumber),
      modelId: expectString(fields, "modelId", lineNumber),
      displayName: expectString(fields, "displayName", lineNumber),
      monthlyTokens: expectInteger(fields, "monthlyTokens", lineNumber),
      creditTokens: expectInteger(fields, "creditTokens", lineNumber),
      freeType: expectEnum(
        FREE_TYPES,
        expectString(fields, "freeType", lineNumber),
        "freeType",
        lineNumber,
      ),
      poolKey,
      tos: expectEnum(
        TERMS_VERDICTS,
        expectString(fields, "tos", lineNumber),
        "tos",
        lineNumber,
      ),
      ...(trainsOnPrompts === undefined ? {} : { trainsOnPrompts }),
      ...(hardStopGuaranteed === undefined ? {} : { hardStopGuaranteed }),
      ...(eligibilityGate === undefined ? {} : { eligibilityGate }),
    });
  }
  if (!inside)
    throw new CatalogImportError(
      "FREE_MODEL_BUDGETS not found in the budgets source.",
    );
  if (rows.length === 0)
    throw new CatalogImportError("FREE_MODEL_BUDGETS contained no rows.");
  return rows;
}

/** Parses `FREE_CATALOG_CURATED_AT = "YYYY-MM-DD"`. */
export function parseCuratedAt(source: string): string {
  const match = source.match(
    /FREE_CATALOG_CURATED_AT\s*=\s*"(\d{4}-\d{2}-\d{2})"/,
  );
  if (!match?.[1])
    throw new CatalogImportError("FREE_CATALOG_CURATED_AT not found.");
  return match[1];
}

function recordBody(source: string, name: string): string {
  const start = source.search(
    new RegExp(`export const ${name}\\b[^=]*=\\s*\\{`),
  );
  if (start === -1)
    throw new CatalogImportError(`${name} not found in upstream source.`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  throw new CatalogImportError(`${name} is not terminated.`);
}

/** Parses the provider-level `FREE_TIER_TOS` overrides of `freeTierCatalog.ts`. */
export function parseProviderVerdicts(
  source: string,
): Record<string, TermsVerdict> {
  const verdicts: Record<string, TermsVerdict> = {};
  const body = recordBody(source, "FREE_TIER_TOS").replace(/\/\/[^\n]*/g, "");
  for (const match of body.matchAll(/"?([A-Za-z0-9_-]+)"?\s*:\s*"([a-z]+)"/g)) {
    const [, id, verdict] = match;
    if (!id || !verdict) continue;
    verdicts[id] = expectEnum(TERMS_VERDICTS, verdict, "tos", 0);
  }
  return verdicts;
}

interface RegistryBlock {
  id: string;
  body: string;
}

/** Splits a `Record<string, {...}>` provider registry source into top-level id blocks. */
function registryBlocks(source: string): RegistryBlock[] {
  const blocks: RegistryBlock[] = [];
  const lines = source.split("\n");
  let current: RegistryBlock | undefined;
  for (const line of lines) {
    const header = line.match(/^ {2}"?([a-z0-9][a-z0-9_-]*)"?\s*:\s*\{/);
    if (header?.[1]) {
      if (current) blocks.push(current);
      current = { id: header[1], body: "" };
      continue;
    }
    if (current) current.body += `${line}\n`;
  }
  if (current) blocks.push(current);
  return blocks;
}

/** Provider ids of the web-cookie (pasted consumer login) registry. */
export function parseWebSessionProviders(source: string): string[] {
  const ids = registryBlocks(source).map((block) => block.id);
  if (ids.length === 0)
    throw new CatalogImportError("web-cookie registry contained no providers.");
  return ids;
}

/**
 * Provider ids of the no-auth registry that run through a browser: upstream
 * marks them `browserBacked: true` or names them `*-web`.
 */
export function parseBrowserSessionProviders(source: string): string[] {
  const blocks = registryBlocks(source);
  if (blocks.length === 0)
    throw new CatalogImportError("no-auth registry contained no providers.");
  return blocks
    .filter(
      (block) =>
        block.id.endsWith("-web") || /browserBacked:\s*true/.test(block.body),
    )
    .map((block) => block.id);
}

function accessKind(
  provider: string,
  webSession: ReadonlySet<string>,
  browserSession: ReadonlySet<string>,
): AccessKind {
  if (webSession.has(provider)) return "web-session";
  if (browserSession.has(provider)) return "browser-session";
  if (provider.endsWith("-web")) return "web-session";
  return "api";
}

export function importFreeTierCatalog(
  sources: UpstreamCatalogSources,
  options: ImportOptions,
): FreeTierCatalog {
  const rows = parseBudgetRows(sources.budgets);
  const curated_at = parseCuratedAt(sources.budgets);
  const provider_verdicts = parseProviderVerdicts(sources.tiers);
  const web_session_providers = parseWebSessionProviders(sources.webCookie);
  const browser_session_providers = parseBrowserSessionProviders(
    sources.noAuth,
  );
  const webSession = new Set(web_session_providers);
  const browserSession = new Set(browser_session_providers);
  const seen = new Set<string>();
  const entries: CatalogEntry[] = rows.map((row) => {
    const key = `${row.provider}/${row.modelId}`;
    if (seen.has(key))
      throw new CatalogImportError(`Duplicate catalog row "${key}".`);
    seen.add(key);
    const providerVerdict = provider_verdicts[row.provider];
    const verdict =
      providerVerdict && VERDICT_RANK[providerVerdict] > VERDICT_RANK[row.tos]
        ? providerVerdict
        : row.tos;
    const grants = row.freeType !== "discontinued";
    return {
      provider: row.provider,
      model: row.modelId,
      display_name: row.displayName,
      free_type: row.freeType,
      grants_free_access: grants,
      access: accessKind(row.provider, webSession, browserSession),
      quota: {
        monthly_tokens: row.monthlyTokens,
        daily_tokens:
          row.freeType === "recurring-daily"
            ? Math.floor(row.monthlyTokens / 30)
            : null,
        credit_tokens: row.creditTokens,
        pool_key: row.poolKey,
      },
      cost_usd_per_mtok: grants ? 0 : null,
      terms_risk: {
        verdict,
        row_verdict: row.tos,
        ...(providerVerdict ? { provider_verdict: providerVerdict } : {}),
        flagged: verdict !== "ok",
        ...(row.trainsOnPrompts === undefined
          ? {}
          : { trains_on_prompts: row.trainsOnPrompts }),
        ...(row.hardStopGuaranteed === undefined
          ? {}
          : { hard_stop_guaranteed: row.hardStopGuaranteed }),
        ...(row.eligibilityGate === undefined
          ? {}
          : { eligibility_gate: row.eligibilityGate }),
      },
    };
  });
  return parseFreeTierCatalog({
    schema_version: 1,
    source: {
      component: "omniroute",
      repository_url: options.repositoryUrl,
      release: options.release,
      revision: options.revision,
      curated_at,
      files: [...UPSTREAM_CATALOG_FILES],
    },
    web_session_providers,
    browser_session_providers,
    provider_verdicts,
    entries,
  });
}

export async function readUpstreamSources(
  checkout: string,
): Promise<UpstreamCatalogSources> {
  const [budgets, tiers, webCookie, noAuth] = await Promise.all(
    UPSTREAM_CATALOG_FILES.map((file) =>
      readFile(join(checkout, file), "utf8"),
    ),
  );
  if (
    budgets === undefined ||
    tiers === undefined ||
    webCookie === undefined ||
    noAuth === undefined
  )
    throw new CatalogImportError("Upstream catalog sources are incomplete.");
  return { budgets, tiers, webCookie, noAuth };
}
