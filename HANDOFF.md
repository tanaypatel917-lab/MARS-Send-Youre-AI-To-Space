# HANDOFF

Running log of where the MARS project stands, what was decided, and what is next.
Maintained by the active Devin session; update it in every PR that changes scope.
Covers all three repositories:

- `tanaypatel917-lab/MARS-Send-Youre-AI-To-Space` (this repo) — the agent platform, Bun 1.4.4 monorepo.
- `tanaypatel917-lab/mars-platform` — earlier Node 24 / pnpm core: Hermes-style `@mars/memory`, OpenClaw-style `@mars/skills`, proposal-only `@mars/review`, OpenClaw gateway probe.
- `tanaypatel917-lab/MARS` — public Vite/Three.js intro site (`/` planet, `/how` loop).

Authoritative spec: `documentation/MASTER_SPECIFICATION.md` (10 milestones, section 16).

## Status (2026-11-02)

All 67 PRs across the three repos are merged; no open PRs. CI green on `main` here (`Foundation checks`) and in `mars-platform` (`CI`). `MARS` builds on Vercel only.

| Spec milestone | State | Where |
| --- | --- | --- |
| 0 Source baseline | done | `packages/contracts`, `sources/manifest.json`, `documentation/SOURCE_REGISTER.md` (#1) |
| 1 Coding workbench | code complete; **acceptance unverified** (no live model run, no real VS Code window) | `packages/{providers,execution,tasks,workspaces,workbench}`, `apps/{cli,vscode}` (#2-#20, #23) |
| 2 Memory & research | partial: memory service + frozen recall (#22-#29), Aider-style repo map (#28, #31, #34), research control plane wired to sessions (#26, #39), research worker package (#41) wired into `mars serve --research-search brave\|searxng\|tavily` (offline e2e verified; **live search/model run unverified**); no browser worker | `packages/{memory,context,research,research-worker}`, `apps/cli/src/serve.ts` |
| 3 Skill learning | **not in this repo**; `mars-platform` has `@mars/skills` + `@mars/review` with no link to this repo | `mars-platform/packages/skills`, `mars-platform/services/review` |
| 4 Measured improvement (Harbor / Terminal-Bench, GEPA, mini-swe baseline, verifiers) | **not started**; only the evidence-gated specialist registry/routing exists (#30, #35, #38, #40) | `packages/specialists` |
| 5-8 Remote execution, SFT, vLLM serving, RL | not started | — |
| Collaboration (bounded delegation, rooms) | library + workbench wiring; fixture child adapter only (#32, #33, #36, #37) | `packages/collaboration` |
| Output format (model-to-UI contract) | contracts + parser/validator/serializer + prompt fragment in the shared runtime prompt + CLI `render` + VS Code webview rendering (artifact panels, confirmed follow-ups, review jumps); no host connector registry, no live-model evidence | `packages/contracts/src/output-format.ts`, `packages/output-format`, `apps/cli/src/render.ts`, `apps/vscode/src/webview` |
| Integration trust gate | library only; no loader or approval UI (#8, #10) | `packages/integration-trust` |

Everything is verified offline only: fixtures, injected model responses, `model_requests: 0`. Nothing has been run against a live model, a real search provider, a GPU, or a real IDE window.

### Lost work (previous Devin account hit its limit before pushing)

- Workflow `mars-source-integration` child tasks: *Run local Qwen3-Coder*, *Refine GEPA feedback*, *Verify TB2 grader repeatability*, *Wire real-model GEPA*. No GEPA, Terminal-Bench, Harbor or Qwen3-Coder code exists in any repo or branch. Treat Milestone 4 as starting from zero.
- *Build the MARS Shell desktop* — no code anywhere; intent unknown until the owner describes it.
- *Create Agent Context File* — no AGENTS.md in any repo.

### Unmerged branches worth knowing about

- `MARS`: `origin/devin/v5-landscape{,-ground,-sky,-colony,-flora}` — a full Martian landscape for `/how` (~1.9k lines, last commit 2026-11-01, 34 commits behind `main`). `devin/v5-passes`, `devin/v5-carousel` are abandoned alternatives.

## Decisions

- One owner per responsibility (spec section 3). Oh My Pi stays the only live session/tool owner; everything else connects through host-bound tools and contracts.
- `mars-platform` and this repo both ship a `@mars/memory`. This repo's `packages/memory` (scoped durable MemoryService + journal index) is the one wired into sessions; `mars-platform`'s Hermes port is the reference for threat scanning and single-writer semantics. Reconciling the two is Milestone 3 work.
- Free-first model routing (`allowPaid: false`) stays the default; no live provider keys are stored in repos.
- The MARS Output Format is MARS-owned (`documentation/OUTPUT_FORMAT.md`), modelled on an unverified description of a third-party format; it claims no compatibility with OpenAI products. `codex://review` and `:codex-followup` are accepted on parse as import aliases; the serializer preserves a follow-up's original tag and never rewrites review links inside Markdown text.
- Model output is untrusted: writing-block addresses are validated against addresses the user supplied in the request, `app://` connector ids against the host registry, review ranges against a line cap. Follow-ups, app triggers and review links are proposals; the host never runs a tool because the model emitted a link.
- `OUTPUT_FORMAT_PROMPT` is appended once to the execution runtime system prompt, so coordinator, workers, reviewer and delegated children all receive it. The research worker's extraction model is deliberately excluded: its contract is a single JSON object, not Markdown.
- Claims of "improvement" require independent evidence (holdout, baseline, cost) — a finished job is not evidence (spec sections 16-17).
- Research in `mars serve` is opt-in (`--research-search`), credentials are referenced by environment variable name only, the worker uses the registry's free default model and refuses paid ones (no CLI paid opt-in), and startup fails fast when no free model is configured rather than queuing requests that cannot run. The research store's private needles are the sibling state directories (`memory`, `sessions`, `tasks`, `workspaces`) plus the source checkout, because the store refuses a private root that contains it.

## Next steps

Dispatched 2026-11-02 as parallel child sessions, each opening its own PR against `main`:

1. ~~Wire `@mars/research-worker` into `mars serve`~~ — done (`WorkbenchServiceOptions.research`, `mars serve --research-search`, `mars doctor` research section). Remaining: a human run with a real Brave/Tavily/SearXNG endpoint and a free model to verify live mode; recorded provider responses as fixtures.
2. Milestone 4: Harbor / Terminal-Bench 2 adapter and GEPA prompt-optimisation worker behind the spec's evaluation and optimisation interfaces, with a documented local-model (Qwen3-Coder via Ollama) path.
3. Milestone 3: bring `@mars/skills` and the proposal-only review runner from `mars-platform` into this repo behind the skill service interface, wired to workbench sessions.
4. `MARS` site: rebase and land the `/how` landscape branches.

5. Output format follow-ups: a host connector registry so `app://` triggers resolve to real tools (today both clients list them as unresolved); host-side `processOutput` on the final `text/plain` artifact plus an explicit final-response role in task metadata (the VS Code client infers it from a bare `text/plain` artifact on the task); live-model and real-window verification.

Parked: the MARS Shell desktop app (needs a description from the owner).

## How to verify locally

```sh
curl -fsSL https://bun.sh/install -o install-bun.sh   # installer is not tracked; see README
bash install-bun.sh bun-v1.4.4
export PATH="$HOME/.bun/bin:$PATH"
bun install --frozen-lockfile --ignore-scripts
bun run check && bun run doctor
```
