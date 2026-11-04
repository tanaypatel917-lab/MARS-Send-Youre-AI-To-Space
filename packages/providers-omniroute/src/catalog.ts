import { readFile } from "node:fs/promises";
import { z } from "zod";

/** OmniRoute's terms-of-service verdict vocabulary, copied verbatim. */
export const TERMS_VERDICTS = [
  "ok",
  "caution",
  "ambiguous",
  "avoid",
  "unknown",
] as const;
export type TermsVerdict = (typeof TERMS_VERDICTS)[number];

/** OmniRoute's free-tier regimes, copied verbatim. */
export const FREE_TYPES = [
  "recurring-daily",
  "recurring-monthly",
  "recurring-credit",
  "recurring-uncapped",
  "one-time-initial",
  "keyless",
  "discontinued",
] as const;
export type FreeType = (typeof FREE_TYPES)[number];

/**
 * How a provider is reached through OmniRoute. `web-session` is a pasted
 * consumer login (cookie / storage state); `browser-session` is an anonymous
 * or reverse-engineered browser transport. Both are excluded by default.
 */
export const ACCESS_KINDS = ["api", "web-session", "browser-session"] as const;
export type AccessKind = (typeof ACCESS_KINDS)[number];

const tokens = z.number().int().nonnegative();

export const CatalogEntrySchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    display_name: z.string(),
    free_type: z.enum(FREE_TYPES),
    /** False only for `discontinued` rows; such rows are never routable. */
    grants_free_access: z.boolean(),
    access: z.enum(ACCESS_KINDS),
    quota: z.object({
      /** Upstream's pool-deduplicated steady monthly figure (0 = none documented). */
      monthly_tokens: tokens,
      /** Derived: `monthly_tokens / 30` for `recurring-daily` rows, otherwise null. */
      daily_tokens: tokens.nullable(),
      /** One-time or recurring credit grants expressed as tokens (0 = none). */
      credit_tokens: tokens,
      pool_key: z.string().nullable(),
    }),
    /** USD per million tokens; 0 for every free-access row, null when no free access is granted. */
    cost_usd_per_mtok: z.literal(0).nullable(),
    terms_risk: z.object({
      /** Effective verdict: the stricter of the row verdict and the provider override. */
      verdict: z.enum(TERMS_VERDICTS),
      row_verdict: z.enum(TERMS_VERDICTS),
      provider_verdict: z.enum(TERMS_VERDICTS).optional(),
      /** True whenever the effective verdict is not `ok`. */
      flagged: z.boolean(),
      trains_on_prompts: z.boolean().optional(),
      hard_stop_guaranteed: z.boolean().optional(),
      eligibility_gate: z.string().optional(),
    }),
  })
  .strict();
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;

export const FreeTierCatalogSchema = z
  .object({
    schema_version: z.literal(1),
    source: z
      .object({
        component: z.literal("omniroute"),
        repository_url: z.string().url(),
        release: z.string().min(1),
        revision: z.string().regex(/^[0-9a-f]{40}$/),
        /** Upstream `FREE_CATALOG_CURATED_AT`; the catalog's age is measured from here. */
        curated_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        files: z.array(z.string().min(1)).min(1),
      })
      .strict(),
    /** Provider ids upstream lists under its web-cookie (pasted consumer login) registry. */
    web_session_providers: z.array(z.string().min(1)),
    /** Provider ids upstream marks `browserBacked` or names `*-web` in its no-auth registry. */
    browser_session_providers: z.array(z.string().min(1)),
    /** Upstream provider-level verdict overrides (`FREE_TIER_TOS`). */
    provider_verdicts: z.record(z.string(), z.enum(TERMS_VERDICTS)),
    entries: z.array(CatalogEntrySchema),
  })
  .strict();
export type FreeTierCatalog = z.infer<typeof FreeTierCatalogSchema>;

export const BUNDLED_CATALOG_PATH = new URL(
  "../catalog/free-tier-catalog.json",
  import.meta.url,
).pathname;

export function parseFreeTierCatalog(value: unknown): FreeTierCatalog {
  return FreeTierCatalogSchema.parse(value);
}

export async function loadFreeTierCatalog(
  path: string = BUNDLED_CATALOG_PATH,
): Promise<FreeTierCatalog> {
  return parseFreeTierCatalog(JSON.parse(await readFile(path, "utf8")));
}

export function catalogModelKey(
  entry: Pick<CatalogEntry, "provider" | "model">,
) {
  return `${entry.provider}/${entry.model}`;
}

export function findCatalogEntry(
  catalog: FreeTierCatalog,
  modelKey: string,
): CatalogEntry | undefined {
  return catalog.entries.find((entry) => catalogModelKey(entry) === modelKey);
}

/** Days between the upstream curation date and `now` (never negative). */
export function catalogAgeDays(
  catalog: Pick<FreeTierCatalog, "source">,
  now: Date = new Date(),
): number {
  const curated = Date.parse(`${catalog.source.curated_at}T00:00:00Z`);
  return Math.max(0, Math.floor((now.getTime() - curated) / 86_400_000));
}
