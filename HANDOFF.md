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
| 2 Memory & research | partial: memory service + frozen recall (#22-#29), Aider-style repo map (#28, #31, #34), research control plane wired to sessions (#26, #39), research worker package (#41) **not wired into `mars serve`**; no browser worker | `packages/{memory,context,research,research-worker}` |
| 3 Skill learning | **not in this repo**; `mars-platform` has `@mars/skills` + `@mars/review` with no link to this repo | `mars-platform/packages/skills`, `mars-platform/services/review` |
| 4 Measured improvement (Harbor / Terminal-Bench, GEPA, mini-swe baseline, verifiers) | **code complete, acceptance unverified**: `@mars/evaluation` (Harbor 0.25.0 adapter, TB2 pins, result/reward parsing, N-repeat variance, regressions, trajectories, `mars_harbor_agent` Oh My Pi agent) and `@mars/optimization` (GEPA 0.1.4 in a bounded Python worker, train/validation/final-holdout, proposal-only candidates) behind the existing contracts; Ollama + Qwen3-Coder path documented with real-run evidence; no real-model TB2 comparison yet (M4 PR) | `packages/{evaluation,optimization}`, `documentation/EVALUATION.md`, `documentation/evidence/local-model-run.txt` |
| 5-8 Remote execution, SFT, vLLM serving, RL | not started | — |
| Collaboration (bounded delegation, rooms) | library + workbench wiring; fixture child adapter only (#32, #33, #36, #37) | `packages/collaboration` |
| Integration trust gate | library only; no loader or approval UI (#8, #10) | `packages/integration-trust` |

Everything is verified offline only: fixtures, injected model responses, `model_requests: 0`. Nothing has been run against a live model, a real search provider, a GPU, or a real IDE window.

### Lost work (previous Devin account hit its limit before pushing)

- Workflow `mars-source-integration` child tasks: *Run local Qwen3-Coder*, *Refine GEPA feedback*, *Verify TB2 grader repeatability*, *Wire real-model GEPA*. Rebuilt from zero in the Milestone 4 PR (see status table); the real-model GEPA run and a real-model TB2 comparison remain unverified.
- *Build the MARS Shell desktop* — no code anywhere; intent unknown until the owner describes it.
- *Create Agent Context File* — no AGENTS.md in any repo.

### Unmerged branches worth knowing about

- `MARS`: `origin/devin/v5-landscape{,-ground,-sky,-colony,-flora}` — a full Martian landscape for `/how` (~1.9k lines, last commit 2026-11-01, 34 commits behind `main`). `devin/v5-passes`, `devin/v5-carousel` are abandoned alternatives.

## Decisions

- One owner per responsibility (spec section 3). Oh My Pi stays the only live session/tool owner; everything else connects through host-bound tools and contracts.
- `mars-platform` and this repo both ship a `@mars/memory`. This repo's `packages/memory` (scoped durable MemoryService + journal index) is the one wired into sessions; `mars-platform`'s Hermes port is the reference for threat scanning and single-writer semantics. Reconciling the two is Milestone 3 work.
- Free-first model routing (`allowPaid: false`) stays the default; no live provider keys are stored in repos.
- Claims of "improvement" require independent evidence (holdout, baseline, cost) — a finished job is not evidence (spec sections 16-17).
- Milestone 4 layout: Harbor, mini-swe-agent and GEPA run in a pinned Python 3.12 venv (`harbor==0.25.0`, `mini-swe-agent==2.4.6`, `gepa==0.1.4`, no DSPy) launched and bounded by Bun-side services; Harbor result/reward/error records are parsed, exit codes are never trusted; Terminal-Bench 2 is consumed through Harbor datasets pinned to task commits (`sources/manifest.json` `terminal-bench-2`), never vendored.
- Prompt optimisation scores only through the additive `PromptScoringBackend` contract (`train`/`validation` splits; no holdout value exists in the type), final-holdout ids live in a separate record, and GEPA candidates are stored proposals (`draft -> proposed -> accepted|rejected|archived`); "no improvement" is a valid reported outcome. The live `SYSTEM_PROMPT` is never mutated by a run.
- Local models: register them with `mars models add --provider ollama ...`; nothing local goes into `BUILTIN_MODELS` because the default route would then hit an unreachable endpoint. Finding recorded in `documentation/evidence/local-model-run.txt`: with `qwen3-coder:30b` the fixed MARS system prompt deterministically produces text-form tool calls that Ollama does not parse, so a real-model comparison on CPU needs an accepted prompt proposal or another model.

## Next steps

Dispatched 2026-11-02 as parallel child sessions, each opening its own PR against `main`:

1. Wire `@mars/research-worker` into `mars serve` (host option, config, docs) so `mars_research` can retrieve live evidence when a search provider is configured.
2. Milestone 4 (delivered in the M4 PR; follow-ups): run a baseline-vs-candidate `terminal-bench-sample@2.0` comparison with a real tool-calling model and record it under `documentation/evidence/`; run one bounded GEPA optimisation with a real reflection model and publish the proposal report (improvement or not); evaluate a system-prompt proposal that restores Qwen3-Coder tool calling through the proposal gate instead of editing `SYSTEM_PROMPT` directly.
3. Milestone 3: bring `@mars/skills` and the proposal-only review runner from `mars-platform` into this repo behind the skill service interface, wired to workbench sessions.
4. `MARS` site: rebase and land the `/how` landscape branches.

Parked: the MARS Shell desktop app (needs a description from the owner).

## How to verify locally

```sh
curl -fsSL https://bun.sh/install -o install-bun.sh   # installer is not tracked; see README
bash install-bun.sh bun-v1.4.4
export PATH="$HOME/.bun/bin:$PATH"
bun install --frozen-lockfile --ignore-scripts
bun run check && bun run doctor
```
