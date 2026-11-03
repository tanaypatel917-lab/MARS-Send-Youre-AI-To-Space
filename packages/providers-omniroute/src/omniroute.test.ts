import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadModelRegistry, ModelRouter } from "@mars/providers";
import type { FreeTierCatalog } from "./catalog";
import type { ExclusionOverrides } from "./exclusions";
import {
  catalogHealth,
  discoverOmniRouteCapabilities,
  probeOmniRoute,
} from "./health";
import { importFreeTierCatalog } from "./importer";
import { FIXTURE_SOURCES } from "./importer.test";
import { OMNIROUTE_PIN } from "./pin";
import {
  decideOmniRouteRoute,
  OmniRoutePolicyError,
  PAID_CONSENT_HEADER,
} from "./policy";
import {
  extendRegistryWithOmniRoute,
  OMNIROUTE_FREE_ROUTE,
  omnirouteBaseUrl,
  omnirouteModels,
  omnirouteProvider,
} from "./provider";
import {
  type FakeOmniRoute,
  startFakeOmniRoute,
} from "./testing/fake-omniroute";

const PIN = {
  repositoryUrl: OMNIROUTE_PIN.repositoryUrl,
  release: OMNIROUTE_PIN.release,
  revision: OMNIROUTE_PIN.revision,
};

let catalog: FreeTierCatalog;
let fake: FakeOmniRoute;
let home: string;

beforeAll(async () => {
  catalog = importFreeTierCatalog(FIXTURE_SOURCES, PIN);
  fake = await startFakeOmniRoute({
    apiKey: "fake-gateway-key",
    models: [
      { id: "goodapi/clean-1", tool_calling: true, context_length: 128_000 },
      { id: "goodapi/clean-2" },
      { id: "chatgpt-web/gpt-x", tool_calling: true },
      { id: "paid/premium", tool_calling: true },
    ],
  });
  home = await mkdtemp(join(tmpdir(), "mars-omniroute-"));
});

afterAll(async () => {
  await fake.stop();
  await rm(home, { recursive: true, force: true });
});

function env(extra: Record<string, string> = {}) {
  return { MARS_HOME: home, OMNIROUTE_API_KEY: "fake-gateway-key", ...extra };
}

async function registryWithOmniRoute(options: {
  allowPaid?: boolean;
  discovered?: boolean;
  overrides?: ExclusionOverrides;
}) {
  if (options.allowPaid) {
    await Bun.write(
      join(home, "models.json"),
      JSON.stringify({
        version: 1,
        providers: [],
        models: [],
        policy: { allowPaid: true },
      }),
    );
  } else {
    await rm(join(home, "models.json"), { force: true });
  }
  const base = await loadModelRegistry({ cwd: home, home, env: env() });
  expect(base.providers.some((p) => p.id === "omniroute")).toBe(false);
  const discovered = options.discovered
    ? await discoverOmniRouteCapabilities({ url: fake.url, env: env() })
    : undefined;
  return extendRegistryWithOmniRoute(base, {
    catalog,
    url: fake.url,
    ...(discovered ? { discovered } : {}),
    ...(options.overrides ? { overrides: options.overrides } : {}),
  });
}

describe("omniroute provider target", () => {
  test("normalizes URLs and uses the existing openai-compatible adapter kind", () => {
    expect(omnirouteBaseUrl()).toBe("http://localhost:20128/v1");
    expect(omnirouteBaseUrl("http://127.0.0.1:20128/")).toBe(
      "http://127.0.0.1:20128/v1",
    );
    expect(omnirouteBaseUrl("http://localhost:20128/v1/")).toBe(
      "http://localhost:20128/v1",
    );
    expect(() => omnirouteBaseUrl("http://user:pw@localhost:20128")).toThrow();
    const provider = omnirouteProvider();
    expect(provider).toMatchObject({
      id: "omniroute",
      kind: "openai-compatible",
      apiKeyEnv: "OMNIROUTE_API_KEY",
    });
    expect(provider.headers).toBeUndefined();
  });

  test("catalog models are free, tool-less until discovered, ordered by terms then quota", () => {
    const models = omnirouteModels(catalog);
    expect(models.map((model) => model.model)).toEqual([
      "goodapi/clean-1",
      "goodapi/clean-2",
    ]);
    for (const model of models) {
      expect(model.pricing).toEqual({ free: true });
      expect(model.capabilities.tools).toBe(false);
      expect(model.tags).toContain("capabilities:unknown");
    }
  });

  test("probe and discovery use only GET /v1/models and report booleans", async () => {
    fake.requests.length = 0;
    const probe = await probeOmniRoute({ url: fake.url, env: env() });
    expect(probe).toMatchObject({
      reachable: true,
      models_endpoint: true,
      authorized: true,
      status: 200,
      model_count: 4,
      api_key_env_present: true,
    });
    expect(JSON.stringify(probe)).not.toContain("fake-gateway-key");
    const unauthorized = await probeOmniRoute({
      url: fake.url,
      env: { MARS_HOME: home },
    });
    expect(unauthorized).toMatchObject({
      reachable: true,
      models_endpoint: false,
      authorized: false,
      api_key_env_present: false,
    });
    const down = await probeOmniRoute({
      url: "http://127.0.0.1:1",
      env: env(),
      timeoutMs: 500,
    });
    expect(down).toMatchObject({
      reachable: false,
      models_endpoint: false,
      authorized: null,
    });
    const discovered = await discoverOmniRouteCapabilities({
      url: fake.url,
      env: env(),
    });
    expect(discovered?.toolCapable.has("goodapi/clean-1")).toBe(true);
    expect(discovered?.contextWindows.get("goodapi/clean-1")).toBe(128_000);
    expect(
      fake.requests.every((r) => r.method === "GET" && r.path === "/v1/models"),
    ).toBe(true);
    for (const request of fake.requests)
      expect(request.headers[PAID_CONSENT_HEADER.toLowerCase()]).toBe("absent");
  });

  test("routes a free catalog model through the gateway with consent absent", async () => {
    const registry = await registryWithOmniRoute({ discovered: true });
    expect(registry.policy.allowPaid).toBe(false);
    expect(registry.routes[OMNIROUTE_FREE_ROUTE]).toEqual([
      "omniroute/goodapi/clean-1",
      "omniroute/goodapi/clean-2",
    ]);
    expect(registry.routes.default?.at(-1)).toBe("omniroute/goodapi/clean-2");
    expect(
      registry.getModel("omniroute/goodapi/clean-1")?.capabilities,
    ).toEqual({
      tools: true,
      vision: false,
      contextWindow: 128_000,
    });
    fake.requests.length = 0;
    const router = new ModelRouter(registry);
    const response = await router.complete(
      { messages: [{ role: "user", content: "hi" }] },
      { route: OMNIROUTE_FREE_ROUTE, require: { tools: true } },
    );
    expect(response.content).toBe("fake reply from goodapi/clean-1");
    const request = fake.requests.find(
      (r) => r.path === "/v1/chat/completions",
    );
    expect(request?.headers[PAID_CONSENT_HEADER.toLowerCase()]).toBe("absent");
    expect(request?.headers["x-mars-policy-owner"]).toBe("mars");
    expect(request?.headers.authorization).toBe("<redacted>");
    expect(fake.requests.some((r) => r.path.startsWith("/api/"))).toBe(false);
    // Streaming goes through the same guard and headers.
    fake.requests.length = 0;
    let text = "";
    for await (const event of router.stream(
      { messages: [{ role: "user", content: "hi" }] },
      { model: "omniroute/goodapi/clean-1" },
    ))
      if (event.type === "text-delta") text += event.text;
    expect(text).toBe("fake reply from goodapi/clean-1");
    expect(fake.requests[0]?.headers[PAID_CONSENT_HEADER.toLowerCase()]).toBe(
      "absent",
    );
  });

  test("refuses excluded or unknown OmniRoute models without paid consent", async () => {
    const registry = await registryWithOmniRoute({ discovered: true });
    // A user could hand-register an excluded web-session model as "free";
    // the catalog guard still refuses it before any request leaves MARS.
    const smuggled = registry.extend({
      models: [
        {
          id: "omniroute/chatgpt-web/gpt-x",
          providerId: "omniroute",
          model: "chatgpt-web/gpt-x",
          capabilities: { tools: true, vision: false, contextWindow: 8192 },
          pricing: { free: true },
        },
        {
          id: "omniroute/paid/premium",
          providerId: "omniroute",
          model: "paid/premium",
          capabilities: { tools: true, vision: false, contextWindow: 8192 },
          pricing: { free: true },
        },
      ],
    });
    fake.requests.length = 0;
    const router = new ModelRouter(smuggled);
    for (const model of [
      "omniroute/chatgpt-web/gpt-x",
      "omniroute/paid/premium",
    ]) {
      const failure = await router
        .complete({ messages: [{ role: "user", content: "hi" }] }, { model })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(failure).toBeInstanceOf(Error);
      expect(String((failure as Error).message)).toMatch(
        /without paid consent/,
      );
    }
    expect(fake.requests).toHaveLength(0);
    expect(
      decideOmniRouteRoute(catalog, "chatgpt-web/gpt-x", "absent"),
    ).toMatchObject({
      allowed: false,
      reasons: ["web-session"],
    });
    expect(
      decideOmniRouteRoute(catalog, "nope/none", "absent").reasons,
    ).toEqual(["not in the MARS free-tier catalog"]);
    expect(
      new OmniRoutePolicyError("omniroute", "x", ["web-session"]).retryable,
    ).toBe(false);
  });

  test("a paid, explicitly selected model under allowPaid carries consent granted", async () => {
    const registry = await registryWithOmniRoute({
      allowPaid: true,
      discovered: true,
    });
    expect(registry.policy.allowPaid).toBe(true);
    const paid = registry.extend({
      models: [
        {
          id: "omniroute/paid/premium",
          providerId: "omniroute",
          model: "paid/premium",
          capabilities: { tools: true, vision: false, contextWindow: 8192 },
          pricing: { free: false, inputPerMTokUsd: 1, outputPerMTokUsd: 2 },
        },
      ],
    });
    fake.requests.length = 0;
    const response = await new ModelRouter(paid).complete(
      { messages: [{ role: "user", content: "hi" }] },
      { model: "omniroute/paid/premium" },
    );
    expect(response.content).toBe("fake reply from paid/premium");
    expect(fake.requests[0]?.headers[PAID_CONSENT_HEADER.toLowerCase()]).toBe(
      "granted",
    );
    // The same paid model is skipped without allowPaid even when requested.
    const noConsent = (
      await registryWithOmniRoute({ discovered: true })
    ).extend({
      models: paid.models.filter(
        (model) => model.id === "omniroute/paid/premium",
      ),
    });
    fake.requests.length = 0;
    await expect(
      new ModelRouter(noConsent).complete(
        { messages: [{ role: "user", content: "hi" }] },
        { model: "omniroute/paid/premium" },
      ),
    ).rejects.toThrow();
    expect(fake.requests).toHaveLength(0);
  });

  test("opt-ins widen routing but avoid stays excluded", async () => {
    const registry = await registryWithOmniRoute({
      discovered: true,
      overrides: {
        allowWebSession: true,
        allowTermsRisk: ["caution", "avoid"],
      },
    });
    const ids = registry.routes[OMNIROUTE_FREE_ROUTE] ?? [];
    expect(ids).toContain("omniroute/chatgpt-web/gpt-x");
    expect(ids).toContain("omniroute/cautious/c-1");
    expect(ids).not.toContain("omniroute/overridden/o-1");
    expect(ids).not.toContain("omniroute/duckduckgo-web/ddg");
  });

  test("catalog health is booleans, counts and age only", () => {
    const health = catalogHealth(catalog, {
      now: new Date("2027-04-01T00:00:00Z"),
    });
    expect(health).toMatchObject({
      present: true,
      release: "v3.8.52",
      revision_pinned: true,
      curated_at: "2026-10-19",
      stale: true,
    });
    expect(health.age_days).toBeGreaterThan(120);
    expect(catalogHealth(undefined)).toMatchObject({
      present: false,
      stale: true,
    });
  });
});
