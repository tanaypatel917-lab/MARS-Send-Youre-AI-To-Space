import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  BUNDLED_CATALOG_PATH,
  catalogAgeDays,
  loadFreeTierCatalog,
} from "./catalog";
import { exclusionReasons, summarizeExclusions } from "./exclusions";
import {
  CatalogImportError,
  importFreeTierCatalog,
  parseBrowserSessionProviders,
  parseBudgetRows,
  parseProviderVerdicts,
} from "./importer";
import { OMNIROUTE_PIN } from "./pin";

export const FIXTURE_BUDGETS = `// fixture
import type { FreeModelBudget } from "./freeModelCatalog.ts";

export const FREE_CATALOG_CURATED_AT = "2026-10-19";

export const FREE_MODEL_BUDGETS: FreeModelBudget[] = [
  { provider: "goodapi", modelId: "clean-1", displayName: "Clean \\"One\\"", monthlyTokens: 3000000, creditTokens: 0, freeType: "recurring-daily", poolKey: "goodapi", tos: "ok" },
  { provider: "goodapi", modelId: "clean-2", displayName: "Clean Two", monthlyTokens: 0, creditTokens: 1_000_000, freeType: "one-time-initial", poolKey: "goodapi", tos: "ok", hardStopGuaranteed: true },
  { provider: "cautious", modelId: "c-1", displayName: "Caution", monthlyTokens: 500000, creditTokens: 0, freeType: "recurring-monthly", poolKey: null, tos: "caution", trainsOnPrompts: true },
  { provider: "chatgpt-web", modelId: "gpt-x", displayName: "ChatGPT Web", monthlyTokens: 0, creditTokens: 0, freeType: "recurring-uncapped", poolKey: "chatgpt-web", tos: "ok" },
  { provider: "duckduckgo-web", modelId: "ddg", displayName: "DDG", monthlyTokens: 0, creditTokens: 0, freeType: "keyless", poolKey: "duckduckgo-web", tos: "avoid" },
  { provider: "overridden", modelId: "o-1", displayName: "Overridden", monthlyTokens: 1000, creditTokens: 0, freeType: "recurring-daily", poolKey: "overridden", tos: "ok" },
  { provider: "gone", modelId: "old", displayName: "Gone", monthlyTokens: 0, creditTokens: 0, freeType: "discontinued", poolKey: null, tos: "ok" },
  { provider: "gated", modelId: "g-1", displayName: "Gated", monthlyTokens: 100, creditTokens: 0, freeType: "recurring-daily", poolKey: null, tos: "unknown", eligibilityGate: "regional-identity" },
];
`;

export const FIXTURE_TIERS = `
export type TosVerdict = "ok" | "caution" | "ambiguous" | "avoid" | "unknown";
export const FREE_TIER_BUDGETS: Record<string, number> = { goodapi: 3_000_000 };
export const FREE_TIER_TOS: Record<string, TosVerdict> = {
  "duckduckgo-web": "avoid",
  overridden: "avoid", // provider-level override
};
`;

export const FIXTURE_WEB_COOKIE = `
export const WEB_COOKIE_PROVIDERS = {
  "chatgpt-web": {
    name: "ChatGPT Web",
    notice: { text: "Paste storage state" },
  },
  "claude-web": {
    name: "Claude Web",
  },
};
`;

export const FIXTURE_NO_AUTH = `
export const NO_AUTH_PROVIDERS = {
  "duckduckgo-web": {
    name: "DuckDuckGo",
    browserBacked: true,
  },
  "cloudflare-playground": {
    name: "Cloudflare Playground",
    browserBacked: true,
  },
  aihorde: {
    name: "AI Horde",
  },
};
`;

export const FIXTURE_SOURCES = {
  budgets: FIXTURE_BUDGETS,
  tiers: FIXTURE_TIERS,
  webCookie: FIXTURE_WEB_COOKIE,
  noAuth: FIXTURE_NO_AUTH,
};

const PIN = {
  repositoryUrl: OMNIROUTE_PIN.repositoryUrl,
  release: OMNIROUTE_PIN.release,
  revision: OMNIROUTE_PIN.revision,
};

describe("catalog importer", () => {
  test("parses upstream rows without executing them", () => {
    const rows = parseBudgetRows(FIXTURE_BUDGETS);
    expect(rows).toHaveLength(8);
    expect(rows[0]?.displayName).toBe('Clean "One"');
    expect(rows[1]?.creditTokens).toBe(1_000_000);
    expect(rows[1]?.hardStopGuaranteed).toBe(true);
    expect(rows[2]?.poolKey).toBeNull();
    expect(parseProviderVerdicts(FIXTURE_TIERS)).toEqual({
      "duckduckgo-web": "avoid",
      overridden: "avoid",
    });
    expect(parseBrowserSessionProviders(FIXTURE_NO_AUTH)).toEqual([
      "duckduckgo-web",
      "cloudflare-playground",
    ]);
  });

  test("builds the MARS catalog with quotas, cost, access and terms risk", () => {
    const catalog = importFreeTierCatalog(FIXTURE_SOURCES, PIN);
    expect(catalog.source).toMatchObject({
      release: "v3.8.52",
      revision: OMNIROUTE_PIN.revision,
      curated_at: "2026-10-19",
    });
    expect(catalog.web_session_providers).toEqual([
      "chatgpt-web",
      "claude-web",
    ]);
    const byKey = new Map(
      catalog.entries.map((entry) => [
        `${entry.provider}/${entry.model}`,
        entry,
      ]),
    );
    expect(byKey.get("goodapi/clean-1")?.quota).toEqual({
      monthly_tokens: 3_000_000,
      daily_tokens: 100_000,
      credit_tokens: 0,
      pool_key: "goodapi",
    });
    expect(byKey.get("goodapi/clean-2")?.quota.daily_tokens).toBeNull();
    expect(byKey.get("goodapi/clean-1")?.cost_usd_per_mtok).toBe(0);
    expect(byKey.get("gone/old")).toMatchObject({
      grants_free_access: false,
      cost_usd_per_mtok: null,
    });
    expect(byKey.get("chatgpt-web/gpt-x")?.access).toBe("web-session");
    expect(byKey.get("duckduckgo-web/ddg")?.access).toBe("browser-session");
    expect(byKey.get("overridden/o-1")?.terms_risk).toEqual({
      verdict: "avoid",
      row_verdict: "ok",
      provider_verdict: "avoid",
      flagged: true,
    });
    expect(byKey.get("cautious/c-1")?.terms_risk).toMatchObject({
      verdict: "caution",
      flagged: true,
      trains_on_prompts: true,
    });
    expect(byKey.get("gated/g-1")?.terms_risk.eligibility_gate).toBe(
      "regional-identity",
    );
  });

  test("default exclusions keep only ok, api-key, free-access entries", () => {
    const catalog = importFreeTierCatalog(FIXTURE_SOURCES, PIN);
    const reasons = Object.fromEntries(
      catalog.entries.map((entry) => [
        `${entry.provider}/${entry.model}`,
        exclusionReasons(entry),
      ]),
    );
    expect(reasons).toEqual({
      "goodapi/clean-1": [],
      "goodapi/clean-2": [],
      "cautious/c-1": ["terms-risk"],
      "chatgpt-web/gpt-x": ["web-session"],
      "duckduckgo-web/ddg": ["browser-session", "terms-risk-avoid"],
      "overridden/o-1": ["terms-risk-avoid"],
      "gone/old": ["discontinued"],
      "gated/g-1": ["terms-risk"],
    });
    expect(summarizeExclusions(catalog)).toMatchObject({
      total: 8,
      routable: 2,
      excluded: 6,
    });
    // Opt-ins widen the set, but `avoid` never routes.
    expect(
      summarizeExclusions(catalog, {
        allowWebSession: true,
        allowTermsRisk: ["caution", "unknown", "avoid"],
      }).routable,
    ).toBe(5);
  });

  test("refuses rows it cannot account for", () => {
    const broken = FIXTURE_BUDGETS.replace(
      'freeType: "keyless"',
      'freeType: "weekly"',
    );
    expect(() => parseBudgetRows(broken)).toThrow(CatalogImportError);
    const multiline = FIXTURE_BUDGETS.replace(
      '{ provider: "gone"',
      '{\n provider: "gone"',
    );
    expect(() => parseBudgetRows(multiline)).toThrow(/multi-line/);
    expect(() =>
      importFreeTierCatalog(
        { ...FIXTURE_SOURCES, tiers: "export const nothing = 1;" },
        PIN,
      ),
    ).toThrow(/FREE_TIER_TOS/);
  });

  test("bundled catalog validates and matches the source pin", async () => {
    const catalog = await loadFreeTierCatalog(BUNDLED_CATALOG_PATH);
    expect(catalog.source.revision).toBe(OMNIROUTE_PIN.revision);
    expect(catalog.source.release).toBe(OMNIROUTE_PIN.release);
    const manifest = JSON.parse(
      await readFile(
        new URL("../../../sources/manifest.json", import.meta.url),
        "utf8",
      ),
    ) as { components: { id: string; revision: string }[] };
    const component = manifest.components.find(({ id }) => id === "omniroute");
    expect(component?.revision).toBe(catalog.source.revision);
    expect(catalog.entries.length).toBeGreaterThan(400);
    for (const name of ["chatgpt-web", "claude-web", "grok-web", "gemini-web"])
      expect(catalog.web_session_providers).toContain(name);
    expect(catalog.browser_session_providers).toContain(
      "cloudflare-playground",
    );
    const summary = summarizeExclusions(catalog);
    expect(summary.routable).toBeGreaterThan(0);
    expect(summary.routable).toBeLessThan(summary.total / 4);
    for (const entry of catalog.entries) {
      const reasons = exclusionReasons(entry);
      if (entry.access !== "api") expect(reasons.length).toBeGreaterThan(0);
      if (entry.terms_risk.verdict === "avoid")
        expect(reasons).toContain("terms-risk-avoid");
    }
    expect(catalogAgeDays(catalog, new Date("2026-10-29T12:00:00Z"))).toBe(10);
  });
});
