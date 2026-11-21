# Harness evolution (`@mars/evolution`) — Milestone 5b

Darwin Gödel Machine–style open-ended search over MARS agent configurations,
with a production champion that is kept separate from the research archive and
moves only when a candidate passes held-out promotion gates.

Upstream: [jennyzzt/dgm](https://github.com/jennyzzt/dgm) at
`a565fd2d1dca504ef5104a7cc0f3bdc4ab9b4fd2` (Apache-2.0) and arXiv:2505.22954.
Only the mechanics were adapted (no upstream code copied); see
`packages/evolution/NOTICE` and the `dgm` entry in `sources/manifest.json`.

## Status

| Area | Status |
| --- | --- |
| Archive, lineage DAG, manifests, patch-chain replay | Implemented, offline tests |
| DGM parent selection (`score_child_prop`, `score_prop`, `random`, `best`, `latest`) | Implemented, parity tests against the upstream formulas |
| Model-driven proposer (`createModelProposer`, selection-only archive/lineage/failure traces, free-tier enforcement) | Implemented, unit + service integration tests |
| Docker-sandboxed candidate builds (`createEvolutionDockerSandbox`, `--network=none`, pinned digest) | Implemented, live Docker integration test + `live-smoke` CLI |
| Isolated builds, protected paths, control-state digests | Implemented, offline + Docker tests |
| Final-holdout promotion gates, uncertainty, `no_improvement` | Implemented, offline + Docker tests |
| Champion history, rollback, crash recovery | Implemented, reopen/restart + Docker tests |
| Live smoke (`mars evolution live-smoke`, OpenRouter `:free` + Docker `--network=none`) | Executed; honest verdict `no_improvement` (baseline built/evaluated in Docker `--network=none`; OpenRouter free-tier key hit `HTTP 429 free-models-per-day`, `$0.00` spent) — see `documentation/evidence/live-dgm-evolution-smoke.json` |
| Harbor / mini-swe-agent evaluation adapter (`createHarborEvaluator`) | Implemented; **not run live** |
| Opt-in live acceptance (`live.acceptance.test.ts`) | Wired to `createModelProposer` + `createEvolutionDockerSandbox` + Harbor (`LIVE_ACCEPTANCE_EVIDENCE` v2); opt-in, not executed against live Harbor |

## Concepts

**Agent manifest** (`mars.agent-manifest/v1`, strict zod): frozen model
`{id, provider, revision}`, prompt components, skill-store revision, sorted tool
set with revisions, retrieval/context settings, and the harness:
`base.ref`, `base.tree_sha256`, the ordered ancestor patch digests
(DGM `get_model_patch_paths`) and the resulting `tree_sha256`. The manifest's
canonical-JSON SHA-256 is its identity. Patches and tree blobs are content
addressed in the store, so any candidate is reproduced by materialising the base
snapshot and replaying its patch chain (`EvolutionService.reproduceTree`);
`verify` replays every non-rejected candidate and checks the digests.

**Run config** (`mars.evolution-run/v1`): seed, generations, children per
generation (DGM `selfimprove_size`), selection method and sigmoid λ/α0, archive
update (`keep_all` / `keep_better` with noise leeway), staged selection tasks
(DGM small→medium subsets), repeats, the held-out final test (tasks, repeats,
confidence, bootstrap samples, `max_uses`), regression families with tolerance,
cost gate, matched per-evaluation budget, whole-run budget (`max_depth` caps
lineage depth), and the harness policy: `mutable_paths`, `protected_paths`,
build argv/timeout/bundle dir, reproducible-bundle requirement and patch size
cap. The schema refuses final tasks that overlap selection or regression tasks
and a per-evaluation budget larger than the run budget.

## Search loop (research archive)

Per generation (`EvolutionService.run`):

1. **Plan** — a seeded PRNG (`seed`, generation) picks parents from the
   *eligible* archive (DGM `is_compiled_self_improve`: built, first stage
   complete, ≥1 valid trial, depth < `max_depth`) and an entry per child
   (25 % stochasticity when repeats disagreed, else a random unresolved
   selection task, else `explore`). The plan is persisted before any work, so a
   resumed run replays the same plan.
2. **Propose** — the proposer receives the parent manifest, a scratch copy of
   its tree and **selection-split feedback only**. Its output is untrusted:
   strict schema (the model cannot be changed), scrubbed hypothesis, patch size
   cap, strict git-diff parser (hunk counts honoured; renames, copies, binary,
   symlink/gitlink modes, quoted paths, `..`, `.git`, absolute paths refused),
   path policy (protected globs win over the mutable allowlist), trial apply in
   a fresh directory and a tree-diff re-check. A proposal that changes nothing
   is rejected (`empty_mutation`).
3. **Build** — each candidate is materialised into its own workspace under the
   work root (disjoint from the control root holding the store, evaluator
   config, hidden answers and permission policy — checked with `realpath`). The
   build runs through a `SandboxRunner`; protected host control files are
   re-digested before and after every build and evaluation. When reproducible
   bundles are required the build is repeated in a second fresh workspace and
   the bundle digests must match. Bundles whose files match a hidden answer by
   content are refused (`holdout_leak`).
4. **Evaluate (selection split)** — staged; a stage only continues when the
   strict score so far reaches `min_score_to_continue`. The score is the strict
   mean over *all* selection tasks (unevaluated tasks count 0). Archive
   admission follows DGM `update_archive`.
5. **Record** search metrics for the generation.

Selection formulas (DGM `choose_selfimproves`):
`p ∝ 1/(1+exp(-λ(α-α0)))` for `score_prop`, multiplied by `1/(1+children)` for
`score_child_prop`, where `children` counts archive members whose parent is in
the archive. Childless low scorers keep non-zero probability, so diverse
stepping stones remain selectable. Upstream `best` sorts ascending (selects the
worst); MARS selects the highest scores. Upstream's CLI choice list has a missing
comma (`'score_child_prop' 'best'`); not reproduced.

## Promotion (production champion)

`promote` is the **only** code path that evaluates the final split; the split
fence in the shared `evaluate` boundary refuses any other combination, and the
final set may be read at most `final_test.max_uses` times per run.

For candidate *C* and current champion *H* (a self-contained copy in the
champion history, not an archive row):

- both run the same final tasks with the same repeats, budget and **shared
  seed** (paired/common random numbers), then every regression family;
- per-task strict-mean differences give a paired percentile-bootstrap interval
  (fewer than two tasks give the uninformative `[-1, 1]`);
- gates:
  - **integrity** — ledger hash chain, champion history chain, control
    digests, evaluator digest pinned at run start, same frozen model;
  - **reproducibility** — the candidate tree is rebuilt from its manifest and
    patch chain, the bundle is rebuilt and must equal the archived digest;
  - **quality** — CI lower bound > `min_improvement`;
  - **regression** — each family's mean difference ≥ −tolerance;
  - **cost** — USD/trial ≤ champion × (1 + `max_relative_increase`); unknown
    cost fails unless `allow_unknown_cost`; a matched-budget overrun fails.
- verdict: `rejected` if any non-quality gate fails; `accepted` only if all
  pass; otherwise **`no_improvement`** (recorded, champion unchanged).

Decisions are idempotent per `(scope, idempotency_key)`. An accepted decision,
its history entry and the pointer move commit in one transaction fenced by the
pointer version observed at the start.

**Rollback** to any earlier history entry appends a `rollback` entry (nothing
is deleted) under an expected pointer version.

## Durability and service boundaries

- One SQLite file (WAL, `synchronous=FULL`, foreign keys), `0700` root,
  `0600` file, symlinked roots/files refused, format-version check.
- Hash-chained **experiment ledger**: every evaluation reserves the full
  matched budget before running and settles with the actual cost; the run
  budget counts unsettled reservations at full value (a crash can never
  under-count spend). Editing, deleting or reordering a row fails
  `verifyLedger` (`accounting_tampered`).
- Hash-chained **champion history**; evaluation outcomes and decisions store
  their own SHA-256 and are checked on read.
- **Leases with fencing tokens** on runs: every write transaction re-checks
  the token; a second driver gets `stale_lease`.
- **Crash recovery**: plans, proposals, builds (bundle digests) and
  evaluations are persisted; `run` resumes without re-proposing finished
  children or re-running finished evaluations.
- **Budgets/deadlines**: run deadline = start + `budget.max_duration_ms`;
  each evaluation gets `min(run deadline, evaluation budget)`; overrunning
  the matched evaluation budget rejects the candidate (`over_budget`).
- Untrusted text (proposer hypotheses, build stderr, errors) is scrubbed of
  secret shapes and bounded before it is stored.

## Task-solving vs search-process metrics

`metrics(run)` returns two separate blocks:

- `search_process`: children proposed, rejection reasons, eligible rate,
  archive size and leaves, max depth, best selection score per generation,
  spend vs budget — i.e. how efficiently the search uses a matched budget.
- `task_solving`: held-out decisions with their paired intervals, final-set
  uses and the current champion — the only numbers that speak to unseen-task
  ability. Selection scores are never reported as task-solving improvement.

Comparing against DGM under a matched budget means running both searches with
the same `budget`/`evaluation_budget`, the same frozen model and the same final
set and comparing `task_solving` blocks; this has **not** been done.

## CLI

```
mars evolution demo --state DIR                 # offline FAKE run (model_requests: 0)
mars evolution live-smoke --state DIR [--model ID] [--image REF] [--generations N] [--children N]
mars evolution status|lineage|metrics|verify --state DIR --run ID
mars evolution champion|history --state DIR --scope KEY
mars evolution rollback --state DIR --scope KEY --to SEQ --expect-version N
```

## Isolation caveat

`createProcessSandbox` (used offline) gives builds a separate process group,
scrubbed environment and deadline, but **is not an OS boundary**: a hostile
build can reach absolute host paths. Protection there is *detection* (digest
re-check after every build/evaluation halts the run with `tamper_detected`,
covered by a test). For prevention, pass `createDockerSandbox` from
`@mars/workspaces`, which mounts only the candidate workspace. The acceptance
evaluator always runs in the host process or behind `@mars/evaluation`, never in
a candidate workspace, and reads a host-owned copy of the bundle.

## Not verified

- `mars evolution live-smoke` ran with a real OpenRouter free-tier key and real
  Docker `--network=none` builds (`documentation/evidence/live-dgm-evolution-smoke.json`),
  but OpenRouter returned `HTTP 429` (`Rate limit exceeded: free-models-per-day`)
  for all `:free` models on the configured free-tier key, so the honest smoke
  verdict was `no_improvement` (`$0.00` spent). Re-running once the daily
  free-tier quota resets exercises live model patch generation end-to-end.
- No live Harbor run or GPU execution. `createHarborEvaluator` is exercised
  only against fake Harbor. It passes non-prompt settings as a
  `mars_agent_settings` component, but the agent applies only `system_prompt`
  today, so the evaluator declares `appliedComponents: ["system_prompt"]` and
  other mutations are refused as `inert_mutation` under Harbor. Baseline-arm
  spend is charged to the run ledger but excluded from the cost gate.
- `live.acceptance.test.ts` is wired to `createModelProposer` (OpenRouter
  `:free` by default), `createEvolutionDockerSandbox` (`--network=none`), and
  Harbor (`LIVE_ACCEPTANCE_EVIDENCE` schema v2), and remains opt-in.
  `live-evidence.json` (run root) is written only after the run ends, records
  `status: passed|failed`, establishes nothing for a failed run, and claims
  rollback only when the verdict was `accepted` and rollback actually ran.
- No claim of beating DGM; no matched-budget comparison has been run.
- Candidates are evaluated sequentially (`max_concurrency` is not used yet).

## Tests

`packages/evolution/src/unit.test.ts` (selection parity, statistics, config,
patch parser/policy), `packages/evolution/src/service.test.ts` (search, tamper,
holdout, reproducibility, promotion gates, rollback/reopen, crash resume,
leases, budgets, evaluator pinning), `packages/evolution/src/proposer-docker.test.ts`
(model proposer free-tier enforcement, selection-only context isolation,
protected-path rejection, and real Docker `--network=none` build + promotion +
rollback), and `apps/cli/src/evolution-cli.test.ts`.
