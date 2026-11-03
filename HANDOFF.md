# HANDOFF

Running log of where the MARS project stands, what was decided, and what is next.
Maintained by the active Devin session; update it in every PR that changes scope.
Covers all three repositories:

- `tanaypatel917-lab/MARS-Send-Youre-AI-To-Space` (this repo) — the agent platform, Bun 1.4.4 monorepo.
- `tanaypatel917-lab/mars-platform` — earlier Node 24 / pnpm core: Hermes-style `@mars/memory`, OpenClaw-style `@mars/skills`, proposal-only `@mars/review`, OpenClaw gateway probe. **Reference-only once Milestone 3 lands here**; not modified.
- `tanaypatel917-lab/MARS` — public Vite/Three.js intro site (`/` planet, `/how` loop).

Authoritative spec: `documentation/MASTER_SPECIFICATION.md` (10 milestones, section 16).

## Status (2026-11-02)

All 67 PRs across the three repos are merged; no open PRs. CI green on `main` here (`Foundation checks`) and in `mars-platform` (`CI`). `MARS` builds on Vercel only.

| Spec milestone | State | Where |
| --- | --- | --- |
| 0 Source baseline | done | `packages/contracts`, `sources/manifest.json`, `documentation/SOURCE_REGISTER.md` (#1) |
| 1 Coding workbench | code complete; **acceptance unverified** (no live model run, no real VS Code window) | `packages/{providers,execution,tasks,workspaces,workbench}`, `apps/{cli,vscode}` (#2-#20, #23) |
| 2 Memory & research | partial: memory service + frozen recall (#22-#29), Aider-style repo map (#28, #31, #34), research control plane wired to sessions (#26, #39), research worker package (#41) wired into `mars serve --research-search brave\|searxng\|tavily` (offline e2e verified; **live search/model run unverified**); no browser worker | `packages/{memory,context,research,research-worker}`, `apps/cli/src/serve.ts` |
| 3 Skill learning | implemented, **offline-verified only**: `@mars/skills` store (versions, drafts, proposals, `undoReview`, curator, directory lock, transactional recovery; 29 tests), `@mars/review` proposal-only runner (recursion guard, revision fencing, strict output whitelist, free-first registry gateway; offline tests with an injected fake model gateway), Hermes threat scanner with complete invisible-Unicode denylist + memory proposal API in `@mars/memory`; workbench wiring (frozen untrusted skill context via `skills-context.ts`, `WorkbenchHostOptions.skills`/`.review`, review scheduled after completed foreground tasks, `mars serve` constructs the store and runner) verified by offline host tests. No live-model review, no operator CLI, curator not scheduled | `packages/{skills,review,memory}`, `documentation/SKILLS.md` |
| 4 Measured improvement (Harbor / Terminal-Bench, GEPA, mini-swe baseline, verifiers) | **code complete, acceptance unverified**: `@mars/evaluation` (Harbor 0.25.0 adapter, TB2 pins, result/reward parsing, N-repeat variance, regressions, trajectories, `mars_harbor_agent` Oh My Pi agent) and `@mars/optimization` (GEPA 0.1.4 in a bounded Python worker, train/validation/final-holdout, proposal-only candidates) behind the existing contracts; Ollama + Qwen3-Coder path documented with real-run evidence; no real-model TB2 comparison yet (M4 PR) | `packages/{evaluation,optimization}`, `documentation/EVALUATION.md`, `documentation/evidence/local-model-run.txt` |
| 5-8 Remote execution, SFT, vLLM serving, RL | not started | — |
| 1b OmniRoute provider gateway (optional) | implemented, **offline-verified only**: `@mars/providers-omniroute` (`omniroute` target via the existing openai-compatible adapter, MARS-owned free-tier catalog imported from pinned OmniRoute v3.8.52, policy guard + `X-MARS-Paid-Consent`, default exclusions, loopback attach/start lifecycle, fake gateway tests), `mars serve --omniroute`, `mars doctor` omniroute section; **no live OmniRoute or upstream call** | `packages/providers-omniroute`, `apps/cli/src/omniroute.ts`, `packages/workbench/src/service.ts` |
| Collaboration (bounded delegation, rooms) | library + workbench wiring; fixture child adapter only (#32, #33, #36, #37) | `packages/collaboration` |
| Output format (model-to-UI contract) | contracts + parser/validator/serializer + prompt fragment in the shared runtime prompt + CLI `render` + VS Code webview rendering (artifact panels, confirmed follow-ups, review jumps); no host connector registry, no live-model evidence | `packages/contracts/src/output-format.ts`, `packages/output-format`, `apps/cli/src/render.ts`, `apps/vscode/src/webview` |
| Integration trust gate | library only; no loader or approval UI (#8, #10) | `packages/integration-trust` |
| Perception & verification (watch-skill) | `@mars/watch` host-bound tools for every session type, THE LOOP + deterministic `verify` mapped to task evidence, ten vendored SKILL.md files; **offline fixture only** — real `watch`, `capture`, `loop` and model critique never run here | `packages/watch`, `skills/vendor/watch-skill`, `documentation/WATCH.md` |

Everything is verified offline only: fixtures, injected model responses, `model_requests: 0`. Nothing has been run against a live model, a real search provider, a GPU, or a real IDE window.

### Lost work (previous Devin account hit its limit before pushing)

- Workflow `mars-source-integration` child tasks: *Run local Qwen3-Coder*, *Refine GEPA feedback*, *Verify TB2 grader repeatability*, *Wire real-model GEPA*. Rebuilt from zero in the Milestone 4 PR (see status table); the real-model GEPA run and a real-model TB2 comparison remain unverified.
- *Build the MARS Shell desktop* — no code anywhere; intent unknown until the owner describes it.
- *Create Agent Context File* — no AGENTS.md in any repo.

### Unmerged branches worth knowing about

- `MARS`: `origin/devin/v5-landscape{,-ground,-sky,-colony,-flora}` — a full Martian landscape for `/how` (~1.9k lines, last commit 2026-11-01, 34 commits behind `main`). `devin/v5-passes`, `devin/v5-carousel` are abandoned alternatives.

## Decisions

- One owner per responsibility (spec section 3). Oh My Pi stays the only live session/tool owner; everything else connects through host-bound tools and contracts.
- `mars-platform` and this repo both ship a `@mars/memory`. This repo's `packages/memory` (scoped durable MemoryService + journal index) is the one wired into sessions; the Hermes threat scanner and proposal API were ported into it in Milestone 3.
- `mars-platform` is reference-only once Milestone 3 lands; it is not modified, and future changes to memory, skills and review happen in this repo.
- Background review calls models through the provider registry (`selectExecutionModel`, free-first, refuses paid), not through an OpenAI-compatible endpoint env (`MARS_REVIEW_*` does not exist here).
- Memory proposals are scoped to the exact review context and revision-fenced (`expected_revision` checked at submission and again at acceptance); skill proposals likewise carry `expectedRevision`. Review can only submit; humans/host accept.
- The SKILL.md frontmatter parser is a flat `key: value` subset with no YAML dependency (anchors, aliases, block scalars, nesting rejected).
- Free-first model routing (`allowPaid: false`) stays the default; no live provider keys are stored in repos.
- The MARS Output Format is MARS-owned (`documentation/OUTPUT_FORMAT.md`), modelled on an unverified description of a third-party format; it claims no compatibility with OpenAI products. `codex://review` and `:codex-followup` are accepted on parse as import aliases; the serializer preserves a follow-up's original tag and never rewrites review links inside Markdown text.
- Model output is untrusted: writing-block addresses are validated against addresses the user supplied in the request, `app://` connector ids against the host registry, review ranges against a line cap. Follow-ups, app triggers and review links are proposals; the host never runs a tool because the model emitted a link.
- `OUTPUT_FORMAT_PROMPT` is appended once to the execution runtime system prompt, so coordinator, workers, reviewer and delegated children all receive it. The research worker's extraction model is deliberately excluded: its contract is a single JSON object, not Markdown.
- Claims of "improvement" require independent evidence (holdout, baseline, cost) — a finished job is not evidence (spec sections 16-17).
- Milestone 4 layout: Harbor, mini-swe-agent and GEPA run in a pinned Python 3.12 venv (`harbor==0.25.0`, `mini-swe-agent==2.4.6`, `gepa==0.1.4`, no DSPy) launched and bounded by Bun-side services; Harbor result/reward/error records are parsed, exit codes are never trusted; Terminal-Bench 2 is consumed through Harbor datasets pinned to task commits (`sources/manifest.json` `terminal-bench-2`), never vendored.
- Prompt optimisation scores only through the additive `PromptScoringBackend` contract (`train`/`validation` splits; no holdout value exists in the type), final-holdout ids live in a separate record, and GEPA candidates are stored proposals (`draft -> proposed -> accepted|rejected|archived`); "no improvement" is a valid reported outcome. The live `SYSTEM_PROMPT` is never mutated by a run.
- Local models: register them with `mars models add --provider ollama ...`; nothing local goes into `BUILTIN_MODELS` because the default route would then hit an unreachable endpoint. Finding recorded in `documentation/evidence/local-model-run.txt`: with `qwen3-coder:30b` the fixed MARS system prompt deterministically produces text-form tool calls that Ollama does not parse, so a real-model comparison on CPU needs an accepted prompt proposal or another model.
- watch-skill (MIT, Python 3.11+) is an external runtime, never a second loop: `@mars/watch` drives the CLI as an argv-only subprocess with an env allowlist, bounded roots, offline flags and a doctor gate (`version` must be 1.4.3, `doctor --no-fix --json` must be ok); if either fails the tools are `unavailable`/`inconclusive`, never `pass`. THE LOOP is `visual_advisory` and never `verified`; only a `verify` run with a passed required deterministic check at `deterministic_local`/`isolated_local` is. Screen/window capture is off for every role until the user sets `allow_screen_capture`; which roles may capture by default is an open product decision for the owner. `remote_attested` is refused because upstream does not implement it.
- Vendored upstream text is allowed when copied verbatim with its license and a NOTICE (`skills/vendor/watch-skill`); the skill service (`@mars/skills`, ported on a separate branch) loads it as a read-only library — see the loader note there.

- **OmniRoute is one provider target, never the policy owner.** It is reached through the existing `openai-compatible` adapter (`ProviderConfig.kind` unchanged); `@mars/providers` only gained `AdapterOptions.headers` and `ModelProviderRegistry.extend()` (in-memory additions with an optional default adapter factory the router falls back to). The MARS-owned catalog (`catalog/free-tier-catalog.json`, parsed as text from upstream `freeModelCatalog.data.ts` + `freeTierCatalog.ts` + web-cookie/no-auth registries; no upstream code vendored or executed) decides what is free; the adapter-factory guard refuses any OmniRoute model that is not a free, non-excluded catalog entry unless MARS classified it as paid under `allowPaid` with explicit selection, and sends `X-MARS-Paid-Consent: granted|absent`. Default exclusions: web-session (35 web-cookie ids incl. ChatGPT/Claude/Grok/Gemini Web), browser-session (`duckduckgo-web`, `cloudflare-playground`, `veoaifree-web`), every verdict other than `ok` (`avoid` can never be opted in), discontinued tiers, MCP/A2A (never called), compression (not exposed, unverified). Capabilities are unknown offline, so catalog models are tool-less until one `GET /v1/models` discovery at serve time; the execution runtime therefore never selects them without discovery. `--omniroute-start` spawns `omniroute` only on `127.0.0.1` with an env allowlist, requires `--version` to report 3.8.52, discards child output, and stops with SIGTERM then SIGKILL. `OMNIROUTE_API_KEY` is OmniRoute's gateway key by name; upstream credentials stay in `~/.omniroute`. Review fixes (#55): discovered-but-unlisted catalog models are dropped (404 would stop fallback); a gateway is ready/attachable only when `/v1/models` answers authorized (401 fails startup); plain `http` only on loopback, remote needs `https`; `paidConsent` is an explicit option defaulting to `false` (`allowPaid` alone is never task consent); the registry extension carries the probe's env so `OMNIROUTE_API_KEY` resolves consistently.

## Next steps

Dispatched 2026-11-02 as parallel child sessions, each opening its own PR against `main`:

1. ~~Wire `@mars/research-worker` into `mars serve`~~ — done (`WorkbenchServiceOptions.research`, `mars serve --research-search`, `mars doctor` research section). Remaining: a human run with a real Brave/Tavily/SearXNG endpoint and a free model to verify live mode; recorded provider responses as fixtures.
2. Milestone 4 (delivered in the M4 PR; follow-ups): run a baseline-vs-candidate `terminal-bench-sample@2.0` comparison with a real tool-calling model and record it under `documentation/evidence/`; run one bounded GEPA optimisation with a real reflection model and publish the proposal report (improvement or not); evaluate a system-prompt proposal that restores Qwen3-Coder tool calling through the proposal gate instead of editing `SYSTEM_PROMPT` directly.
3. ~~Milestone 3: bring `@mars/skills` and the proposal-only review runner into this repo~~ — landed by the Milestone 3 PR (offline-verified only).
4. `MARS` site: rebase and land the `/how` landscape branches.

5. Output format follow-ups: a host connector registry so `app://` triggers resolve to real tools (today both clients list them as unresolved); host-side `processOutput` on the final `text/plain` artifact plus an explicit final-response role in task metadata (the VS Code client infers it from a bare `text/plain` artifact on the task); live-model and real-window verification.
6. Wire `@mars/watch` into `mars serve`: a `--watch-command`/venv option, a `WATCH_DATA_DIR` under the state root, policy flags (`allow_screen_capture`, `allow_network_sources`, `allow_cloud_models`), then run the real CLI end to end (`watch` on a local file, `loop start` on a loopback URL with Playwright) and record the commands and results in `documentation/WATCH.md`. Done so far through the wrapper against the real 1.4.3 CLI: doctor gate, `verify checks/run/show`, `loop status` (`packages/watch/src/real-cli.test.ts`, opt-in via `MARS_WATCH_REAL_CLI`).
7. Make the skill service load `skills/vendor/watch-skill` and let the reviewer require a `verify` record for visual work (reviewer policy, not yet enforced anywhere).

Milestone 3 follow-ups:

- Live-model acceptance of background review: run a real free model against a recorded transcript, record `review.jsonl` and the resulting proposals as evidence; until then the schema/threat whitelist is untested against real output.
- CLI/RPC commands for proposals (`list`/`accept`/`reject`), `undoReview`, `pin`/`restore`, and `runCurator` (nothing schedules the curator today).
- Scope the skill store by owner/project (it is per state directory) and add relevance-based selection instead of size-bounded `list()`.
- Evaluation gate between proposal and acceptance (spec: evaluate before accept) once Milestone 4 provides verifiers.

Parked: the MARS Shell desktop app (needs a description from the owner). Open product decision: which agent roles, if any, may run `mars_watch_capture` on the user's screen by default (currently none).

- OmniRoute: run a real `omniroute@3.8.52` locally (no upstream keys) and record only what is observed (`/v1/models` reachable, auth behaviour, model id form, capability fields); confirm the `capabilities`/`context_length` field names discovery reads; decide whether to add a `mars models omniroute` operator command for opt-ins; rebuild the catalog when upstream bumps `FREE_CATALOG_CURATED_AT` (doctor reports stale after 120 days).

## How to verify locally

```sh
curl -fsSL https://bun.sh/install -o install-bun.sh   # installer is not tracked; see README
bash install-bun.sh bun-v1.4.4
export PATH="$HOME/.bun/bin:$PATH"
bun install --frozen-lockfile --ignore-scripts
bun run check && bun run doctor
```
