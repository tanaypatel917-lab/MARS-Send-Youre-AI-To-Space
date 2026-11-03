# @mars/providers-omniroute

Optional, self-hosted [OmniRoute](https://github.com/cheaper-inference/OmniRoute)
gateway as **one more provider target** for the MARS model gateway. Pinned to
OmniRoute `v3.8.52` (`ad6f33f66bda34eba98645d3bfdabbde294bc843`, MIT; see
`sources/manifest.json` and `documentation/SOURCE_REGISTER.md`).

MARS stays the owner of model policy. OmniRoute is reached through the
existing `openai-compatible` adapter (`/v1/chat/completions`, `/v1/models`),
so every existing router caller can use it without a new code path, and it
is never asked to decide what is free or allowed.

## What it adds

| Piece | Where | Notes |
| --- | --- | --- |
| `omniroute` provider | `src/provider.ts` | `kind: openai-compatible`, default `http://localhost:20128/v1`, `apiKeyEnv: OMNIROUTE_API_KEY` (OmniRoute's own gateway key, read by name; upstream provider credentials stay in OmniRoute's data directory and are never read, stored or logged by MARS). Plain `http` is accepted for loopback only; a remote gateway must be `https` so the key never travels in cleartext. |
| Free-tier catalog | `catalog/free-tier-catalog.json`, `src/catalog.ts` | MARS-owned, rebuildable: provider, model, monthly/daily/credit token quota, cost (`0` for free access, `null` otherwise), terms-risk verdict and flag, access kind. Rebuild with `bun run omniroute:catalog <omniroute-checkout>` at the pinned revision. |
| Importer | `src/importer.ts` | Parses upstream `open-sse/config/freeModelCatalog.data.ts`, `freeTierCatalog.ts` and the web-cookie / no-auth provider registries **as text** (no eval, nothing upstream is executed). Fails on rows it cannot account for. |
| Policy guard | `src/policy.ts` | Adapter factory in front of the adapter: a route is free only when its catalog entry grants free access and survives the exclusions; anything else is refused (`OmniRoutePolicyError`, non-retryable, no request leaves MARS) unless the MARS task carries paid consent (`paidConsent`, default `false`; the user's `allowPaid` alone is never read as task consent because the router can reach a paid model without an explicit selection). Every request carries `X-MARS-Paid-Consent: granted|absent` and `X-MARS-Policy-Owner: mars`. |
| Registry extension | `extendRegistryWithOmniRoute()` | Adds the provider, one model per routable entry (`omniroute/<provider>/<model>`, `pricing.free: true`), an `omniroute-free` route ordered by terms verdict then documented quota, and appends it after the existing default route. The user's `policy.allowPaid` is untouched. |
| Health | `src/health.ts` | `probeOmniRoute` (one `GET /v1/models`; booleans, status and counts only) and `catalogHealth` (presence, release, pin match, curation date, age in days, stale after 120 days, exclusion counts). |
| Lifecycle | `src/process.ts` | `createOmniRouteProcess({ mode: "attach" | "start" })`: attach to a running instance (usable only when `/v1/models` answers with authorization; a 401/403 fails startup with an explicit key error instead of registering dead models), or start the pinned `omniroute` CLI on `127.0.0.1` (`PORT`, `HOST`, `HOSTNAME` forced; env allowlist `PATH HOME TMPDIR LANG DATA_DIR`; stdout/stderr discarded; `--version` must report `3.8.52`), wait for `/v1/models`, stop with `SIGTERM` then `SIGKILL`. Non-loopback URLs are never started. |
| Fake gateway | `src/testing/fake-omniroute.ts` | Loopback `Bun.serve` stand-in used by the offline tests; records requests (credentials redacted). |

`mars serve --omniroute [--omniroute-url URL] [--omniroute-start] [--omniroute-allow ...]`
wires all of this into the workbench; `mars doctor` prints the `omniroute`
section (reachable, models endpoint, authorized, catalog present/age/stale,
exclusion counts). Both are booleans and counts only.

## Default exclusions (configurable, off by default)

| Excluded | Why | Opt-in |
| --- | --- | --- |
| Every **web-session** provider: ChatGPT Web, Claude Web, Grok Web, Gemini Web and the other 31 ids of OmniRoute's web-cookie registry (`access: "web-session"`) | They run on pasted consumer logins (cookies, storage state), which are personal sessions outside provider API terms and outside MARS's credential model. | `--omniroute-allow web-session` |
| **Browser-session** providers (`duckduckgo-web`, `cloudflare-playground`, `veoaifree-web`; `access: "browser-session"`) | Anonymous or reverse-engineered browser transports (Playwright, undocumented WebSocket protocols). | `--omniroute-allow browser-session` |
| Terms verdict **`avoid`** (row or provider-level `FREE_TIER_TOS`) | OmniRoute itself keeps these out of automatic routing; MARS never allows them. | never |
| Terms verdicts **`caution`, `ambiguous`, `unknown`** (`terms_risk.flagged: true`) | Terms are unclear or restrict automated use; MARS routes only `ok` by default. | `--omniroute-allow caution|ambiguous|unknown` |
| **Discontinued** free tiers | Grant no free access; a request would be paid. | never (needs paid consent) |
| OmniRoute **MCP** (`/api/mcp/stream`) and **A2A** features | Oh My Pi is the only tool and session owner; `enableMCP: false` stays and no second agent loop exists. MARS never calls these endpoints. | not exposed |
| OmniRoute **token compression (RTK / Caveman)** | Not enabled, not configured and not exposed per task. Upstream savings figures are **unverified** by MARS and are not repeated. | not exposed |

With the pinned catalog: 467 rows, 53 routable by default (15 providers), 414
excluded (50 web-session, 6 browser-session, 71 `avoid`, 343 other terms risk,
7 discontinued; a row can carry several reasons).

## Capabilities and quotas

The catalog has no capability data. Without a live `GET /v1/models` every
catalog model is registered tool-less and text-only (tag
`capabilities:unknown`), so the execution runtime, which requires tools, never
selects it; `mars serve --omniroute` performs one discovery GET and refines
tools, vision and context window from the response. Catalog models the
gateway does not list are dropped from the routes (a 404 is non-retryable
and would otherwise stop fallback to the next free model). Quotas are upstream's
hand-curated approximations (`FREE_CATALOG_CURATED_AT`); `daily_tokens` is
derived (`monthly / 30`) for `recurring-daily` rows only.

## Verified / unverified

Verified offline only: importer against a fixture and the pinned checkout,
exclusions, policy refusals, consent header, streaming and non-streaming
requests against the fake gateway, attach/start/stop with an injected process,
`mars serve` and `mars doctor` wiring. `model_requests: 0`.

Not verified: any call to a real OmniRoute instance or upstream provider,
starting the real `omniroute` CLI, tool calling through OmniRoute, compression.
