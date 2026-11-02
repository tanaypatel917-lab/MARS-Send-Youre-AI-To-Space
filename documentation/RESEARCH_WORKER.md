# Research worker (`@mars/research-worker`)

`@mars/research-worker` is the production `ResearchWorker` for the durable
research control plane in `@mars/research`. The control plane owns requests,
leases, usage ceilings, evidence storage and findings; this package owns
planning, web search, guarded fetching, extraction, verification and
publishing. It implements `ResearchWorker` / `ResearchWorkerContext` /
`FindingProposal` from `@mars/research` without changing those contracts.

**Status:** verified offline only. Every test runs against recorded fixtures
and fakes; `bun run check` makes no network or model call and the execution
probe stays at `model_requests: 0`. Live mode (`live: true`) exists but is
**unverified until a human runs it** against a real search provider and model.

## Architecture

The loop replicates [dzhng/deep-research](https://github.com/dzhng/deep-research)
(breadth × depth): a model proposes `breadth` search queries each with a
research goal; each query is searched, the top pages are fetched, claims are
extracted per page against the goal, and verified learnings feed one round of
follow-up queries per depth level, bounded by `min(config.max_depth,
budget.max_depth)` and `budget.max_concurrency`.

```
plan ─▶ search ─▶ canonicalise/dedupe ─▶ SSRF + allow/deny ─▶ robots.txt + rate limit
     ─▶ guarded fetch (max bytes, media type, redirects) ─▶ captureEvidence
     ─▶ extract {claim, quote, recommendation} ─▶ verify quote ∈ page text
     ─▶ follow-up queries (depth) ─▶ group ─▶ contradiction check ─▶ publish
```

Improvements over the surveyed open-source agents:

| Property | Implementation |
|---|---|
| Evidence first | `captureEvidence` runs on the raw bytes before the page is decoded or shown to a model; findings cite only returned `ArtifactRef`s (`worker.ts`). |
| Per-claim verification | Each extracted claim carries a verbatim quote; `quoteSupported` checks it against the normalised page text and drops claims that fail (`extract.ts`). The quote is published inside the claim. |
| Contradiction detection | Numeric-disagreement heuristic between groups from different hosts plus one bounded model pass; conflicts set `confidence: "low"` and are listed in `remaining_uncertainty`. |
| Budget and deadline | `UsageLedger` starts from the usage the control plane already holds for the request (`ResearchWorkerInput.usage`, so retried leases never spend the allowance twice), reserves estimated input + max output tokens and the gateway's worst-case USD **synchronously before each model call is awaited** (concurrent queries cannot admit against the same balance; a paid call against a zero-dollar budget is refused before dispatch), settles reservations with actual usage, and stops cleanly at `deadline - deadline_margin_ms`; verified work is still published (`ledger.ts`). |
| Truthful usage | Provider-reported token counts are forwarded; if a provider omits usage the gateway estimates (`usage_estimated: true`) and USD is derived from registry pricing (0 for free models). |
| Deterministic replay | A `ResearchJournal` records search results, fetched bytes and model exchanges keyed by a canonical SHA-256 of the input; a replay journal reproduces findings with no network, DNS or model access and reports zero new usage (`journal.ts`). Journaled bodies and prompts are redacted with the same needles as findings, and a page the control plane refused to capture is journaled as `capture_rejected`; treat persisted journals as containing public web content and protect them like the research store. |
| SSRF guard | Every hop (initial URL and each redirect) rejects credentials, non-HTTP(S) schemes, `localhost`/`.local`/`.internal`, IP literals and DNS answers in private, loopback, link-local, CGNAT, multicast, documentation, NAT64, 6to4-private and unspecified ranges (`net.ts`). |
| Robots / politeness | `robots.txt` per origin with longest-match rules and `Crawl-delay`, evaluated for the first URL **and every redirect target**; 4xx means allow, other failures deny; per-host minimum interval via `HostRateLimiter`. A page the control plane rejects at `captureEvidence` (private text) is skipped and logged; only lease-level errors abort the run. |
| Bounded pages | Content-type allow-list, `content-length` pre-check and streamed byte cap (`max_page_bytes`), redirect cap, request timeout bounded by the deadline. |
| Untrusted content | Page text is redacted before it reaches the model or the journal and enters prompts only inside `<<<UNTRUSTED_WEB_CONTENT … >>>` fences with instructions to ignore it as commands; model output is parsed with zod; the worker holds no tools. |
| Privacy | `redact` strips host private roots, `private_needles` and common secret shapes from claims, quotes, recommendations and log events; logs carry hostnames and counts only. |
| Idempotent retries | `finding_key = sha256(task_id, question, normalised claim)[:40]`; keys in `published_finding_keys` are skipped so a retried lease never duplicates findings. |
| Model ownership | `createRegistryModelGateway` uses `selectExecutionModel` and `ModelRouter` from the existing registry — the same primitives as the Oh My Pi model bridge — with free models by default and a `PaidModelConsentError` unless `paid_consent` is set. |

## Configuration

`ResearchWorkerConfigSchema` (zod, strict). Defaults in parentheses.

| Field | Meaning |
|---|---|
| `live` (false) | Allow the global `fetch` and real DNS. Without it an injected `fetch` is required and DNS resolution must be injected too. |
| `paid_consent` (false) | Permit a non-free registry model. |
| `model` | Registry model id; defaults to the registry's `default` route (free models only). |
| `user_agent` | Sent on every request and matched against `robots.txt` groups. |
| `breadth` (3), `max_depth` (1) | Queries per level and follow-up levels; depth is further capped by `budget.max_depth`. |
| `max_results_per_query` (5), `max_pages_per_query` (3) | Search results requested and pages fetched per query. |
| `max_page_bytes` (1 MiB), `max_text_chars` (16 000) | Byte cap per page and characters shown to the model. |
| `max_claims_per_page` (4), `max_findings` (8) | Extraction and publication caps. |
| `max_model_output_tokens` (1024) | Reserved output tokens per model call. |
| `max_redirects` (5), `per_host_min_interval_ms` (1000), `respect_robots` (true) | Fetch politeness. |
| `allow_hosts`, `deny_hosts` | Exact or `*.suffix` host patterns; deny wins. |
| `deadline_margin_ms` (5000) | Time kept free before the request deadline for publishing. |
| `private_needles` | Extra strings to redact from all emitted text. |

## Wiring into the workbench host

The workbench host (`createWorkbenchHost` on branch
`devin/1793573824-workbench-research`, PR #39) accepts a parent-owned
`research?: WorkbenchResearch` service (`submit`, `readFindings`, `inspect`,
`reconcileTask`). Build the worker, hand it to `createResearchService`, and pass
the service to the host:

```ts
import { registerRuntimeCleanup } from "@mars/execution";
import { loadModelRegistry } from "@mars/providers";
import { createResearchService } from "@mars/research";
import {
  createRegistryModelGateway,
  createResearchWorker,
  createSearxngSearch,
} from "@mars/research-worker";
import { createTaskStore } from "@mars/tasks";
import { createWorkbenchHost } from "@mars/workbench";

const store = await createTaskStore({ rootDir: taskRoot, workspaceRoots });
const registry = await loadModelRegistry({ trustProjectConfig });

const worker = createResearchWorker({
  config: { live: true, deny_hosts: ["*.internal.example"] },
  search: createSearxngSearch({ baseUrl: process.env.MARS_SEARXNG_URL ?? "", fetch }),
  model: createRegistryModelGateway({ registry, fetch, env: process.env }),
  fetch,
  hostPrivateRoots: [stateRoot, ompSessionDir],
  log: (event) => logger.info(event),
});

const research = await createResearchService({
  rootDir: researchRoot,
  tasks: store,
  artifacts: store.artifacts,
  events: store,
  worker,
  hostPrivateRoots: [stateRoot, ompSessionDir],
});
registerRuntimeCleanup("research", () => research.close({ drainMs: 5000 }));

const host = await createWorkbenchHost({ ...hostOptions, store, registry, research });
```

Notes:

- `hostPrivateRoots` must list the same roots given to the control plane so
  the worker redacts them before `publish` would reject them.
- Pass the host's `fetch` explicitly even in live mode so tests and sandboxes
  can swap it. Search adapters (`createSearxngSearch`, `createBraveSearch`,
  `createTavilySearch`) are optional; any object implementing
  `SearchProvider` works. API keys are passed as values read by the host from
  its environment and are never logged or stored by the worker.
- The host already bounds each request's budget and deadline
  (`researchTools` in `packages/workbench/src/research-context.ts`); the worker
  enforces them again from its own ledger.
- For an auditable run, pass `journal: createRecordingJournal()` and persist
  `journal.entries()`; replay with `createReplayJournal(entries)` and a
  throwing `fetch`/search/model to reproduce the findings offline.

## Verification

```sh
bun test packages/research-worker
bun run check   # lint, typecheck, source audit, all tests, execution smoke (model_requests: 0), build
```

Covered by fixtures: planning and breadth bounding, plan fallback, the full
search → fetch → capture → extract → verify → cite pipeline (capture precedes
publish, unverifiable quotes dropped, multi-source grouping), contradiction
detection, deadline stop, token-budget stop with truthful usage, SSRF (loopback,
private, IPv6, `localhost`, DNS to private, redirect to link-local, mixed
public/private answers), allow/deny lists, `robots.txt` rules, crawl delay and
5xx handling, byte and media-type caps, cancellation, redaction, idempotent
finding keys, deterministic replay, the registry model gateway (free model via
injected fetch, paid refusal), and an end-to-end run through the real
`@mars/research` service and `@mars/tasks` artifact store.

## Contract change

`ResearchWorkerInput` gained one additive field, `usage: ResearchUsage` (the request's accumulated reported usage), so a worker can enforce the remaining ceiling on a retried lease. No other `@mars/research` contract changed.

## Known gaps

- Live mode is unverified: no human has run the worker against a real search
  provider or model yet.
- DNS is checked before the request, but `fetch` resolves the hostname again;
  a DNS-rebinding attacker could race the two. Firecrawl shares this limit and
  delegates it to a proxy; a pinned-IP dispatcher is future work.
- Pages that require JavaScript, PDFs and other binary formats are skipped
  (not captured), so findings never cite them.
- `robots.txt` responses are fetched but not stored as evidence because they
  are never cited.
- Quote verification confirms the wording exists in the captured page, not
  that it is true or that the page is authoritative.
- When a provider omits token usage, reported usage is an estimate (flagged on
  the gateway reply) rather than a measured count.
