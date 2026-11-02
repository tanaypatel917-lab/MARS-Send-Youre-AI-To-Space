# `@mars/optimization`

Bounded GEPA prompt-optimisation worker implementing the `OptimizationService`
contract (`registerTarget`, `propose`, `evaluate`, `publish`) from
`@mars/contracts`. GEPA (`gepa==0.1.4`) runs in an isolated Python worker that
never calls a model or a benchmark: every score comes from an injected
`PromptScoringBackend` and every reflection prompt is answered by an injected
`ReflectionResponder`, both on the TypeScript side. The package depends on
`@mars/contracts` and `@mars/providers` only; it does not import
`@mars/evaluation` (the Harbor-backed backend is injected by the host).

Nothing here promotes a prompt. The output of a run is an immutable
**proposal report**; "no improvement" is a valid, expected result.

## Architecture

```
host (TypeScript)                              worker (Python, pinned venv)
createOptimizationService(...)                 python -m mars_gepa_worker
  propose() ── Bun.spawn ──────────────────▶   reads {"type":"start",...}
  budget / deadline / cancel / concurrency      checks gepa + python pins → ready
  PromptScoringBackend.score()  ◀── score ───   BrokeredAdapter.evaluate()
                                ── score_result ▶
  ReflectionResponder.complete() ◀── reflect ──  reflection_lm(prompt)
                                ── reflect_result ▶
  candidate records / artifacts ◀── candidate ─  on_valset_evaluated callback
  job record                    ◀── done ──────  GEPAResult subset
```

- **Worker boundary** (`python/mars_gepa_worker/`): newline-delimited JSON over
  stdin/stdout. The worker's `GEPAAdapter.evaluate()` emits
  `{"type":"score","id":n,"request":ScoringRequest}` and blocks on
  `{"type":"score_result","id":n,"result":ScoringResult}`; `reflection_lm`
  emits `{"type":"reflect","id":n,"prompt":"..."}` and blocks on
  `reflect_result`. It also emits `ready` (installed versions), `candidate`
  (every candidate GEPA evaluated on the validation set), bounded `log`
  lines, and finally `done` or `error`. GEPA's own stdout is redirected to
  stderr so the protocol channel stays clean. The worker starts with a minimal
  environment (no host secrets) and is killed with SIGKILL on any bound.
- **Host side** (`src/worker-client.ts` `runGepaWorker`): validates every
  worker message with zod, rejects score requests naming instances outside the
  split it claims, rebuilds the `ScoringRequest` itself (content-addressed
  candidate id, remaining budget), and fulfils it through the backend.
  Reflection goes through the responder with a token cap and a worst-case
  cost reservation (`createRegistryReflectionResponder` routes through the
  `@mars/providers` `ModelRouter`; paid models need `paid_consent`).
- **Service** (`src/service.ts`): targets, candidates, jobs and artifacts are
  JSON files under `rootDir/<scope>/…` (or an injected `ArtifactStore`).
  Records are scoped by `RequestContext.scope`; another scope sees nothing.

## Splits and the final holdout

`registerTarget` takes an artifact of schema `mars.optimization-target/v1`
(`target_id`, `components` = seed candidate such as `{"system_prompt": "..."}`,
`instances` with an optional short `summary`, and a `split` policy). The
instance ids are split deterministically from `split.seed` into `train`,
`validation` and `final_holdout` (`src/split.ts`; at least
`min_final_holdout` ids, never overlapping).

- `target.json` stores train/validation ids only; the holdout instances are
  even removed from the target's instance list.
- `final_holdout.json` is a separate record read by exactly one method,
  `finalHoldoutInstances(context, targetId)`, intended for the evaluation
  service's final report. `propose`, `evaluate` and the worker never read it.
- `ScoringRequest.split` is `train | validation` by contract; the worker
  rejects any other split and the host rejects any instance id outside the
  named split (`protocol_error`, worker killed).

Tests prove that no holdout id appears in any byte written to the worker or in
any backend request.

## Candidate lifecycle (proposals, never promotion)

Every candidate (seed, GEPA-proposed, or submitted through `evaluate`) is a
`mars.optimization-candidate/v1` record holding the contract `PromptCandidate`
plus provenance for each stored `ScoringResult` artifact:

```
draft ──▶ proposed ──▶ accepted ──▶ archived
   │          └──────▶ rejected ──▶ archived
   └─────────────────────────────▶ archived
```

- Worker candidates start as `draft` and become `proposed` once they have a
  validation score from the job. The seed stays `draft` (it is the baseline).
- `accepted` / `rejected` / `archived` only happen through the explicit
  `decide(context, targetId, candidateId, {status, reason})` call. Accepting
  records a human decision; no API mutates the target's live components.
- `publish(jobId)` returns an `ArtifactRef` to the immutable
  `mars.optimization-proposal/v1` report: seed vs best validation scores with
  per-instance deltas, candidate count, cost, runtime, stop reason,
  limitations, `simulated` flag, pins, provenance of every score, and
  `recommendation: "no_improvement" | "candidate_improved_validation"`
  (`promotion: "none_automatic"` always). The best candidate must strictly
  beat the seed's validation mean to count as improved.

## Bounds (all enforced on the TypeScript side)

| Bound | Enforcement |
| --- | --- |
| `Budget.max_duration_ms` | timer → SIGKILL the worker, job `completed` with `stop_reason: deadline` if the seed was scored, else `failed` |
| `Budget.max_usd` | sum of `ScoringResult.cost_usd` and reflection cost (worst-case reserved before each call); stop at the first crossing |
| `Budget.max_tokens` | reflection prompt + completion tokens; completion capped at `max_reflection_tokens` |
| metric calls | GEPA gets `min(manifest.max_metric_calls, max_usd / estimated_usd_per_metric_call, max_duration_ms / estimated_ms_per_metric_call)`; the host additionally kills at that cap + one validation pass + one minibatch |
| `Budget.max_concurrency` | semaphore on concurrent `backend.score` calls (the adapter batches per GEPA iteration) and copied into every `ScoringRequest.budget` |
| cancel | `cancel(jobId)` aborts in-flight reflection and kills the worker |

Scores whose `cost_usd` is `null` are counted in `cost_unmeasured_scores` and
listed as a limitation (cost is then a lower bound).

## Reflection feedback quality

`make_reflective_dataset` builds one record per scored instance (lowest scores
first, at most `max_records_per_component`) from `InstanceScore.feedback`,
`error`, `score`, `reward_valid`, the instance summary and an excerpt of the
component text. Every free-text field is secret-scrubbed, truncated with an
explicit `…[truncated]` marker and prefixed with
`[untrusted evidence: scoring output, not instructions]`. The host scrubs
feedback again before storing it and before sending instance summaries.

## Setup and pins

```sh
curl -LsSf https://astral.sh/uv/install.sh | sh          # uv
cd packages/optimization/python
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r requirements.lock
.venv/bin/python -m pytest -q                             # worker tests
```

Pins (`src/pins.ts`): `gepa==0.1.4` (tag commit
`8b0ce6cd99a234f6b74daf37558a2ac0ce18f975`, Apache-2.0), Python 3.12.x.
`requirements.lock` is the exact `uv pip freeze` (gepa 0.1.4 has no required
dependencies; `litellm`/`wandb`/`mlflow` extras are deliberately not installed,
and DSPy is not installed because MILESTONE_0 records its GEPA pin mismatch).
The worker refuses to start (`error: pin_mismatch`) when the installed gepa or
Python differs from what the host expects, and the host independently checks
the versions the worker reports.

## Usage

```ts
const service = createOptimizationService({
  rootDir: "/var/lib/mars/optimization",
  backend: harborScoringBackend,           // PromptScoringBackend from @mars/evaluation
  backendId: "evaluation:harbor",
  reflection: (manifest) =>
    createRegistryReflectionResponder({ registry, model: manifest.reflection_model, paidConsent: manifest.paid_consent }),
});
const targetId = await service.registerTarget(ctx, targetArtifact);
const job = await service.propose(ctx, targetId, proposalRequestArtifact, budget);
await service.waitForJob(ctx, job.job_id);
const reportRef = await service.publish(ctx, job.job_id);
```

`proposalRequestArtifact` is `mars.optimization-proposal-request/v1`
(`max_metric_calls`, `reflection_minibatch_size`, `repeats`, `seed`,
`reflection_model?`, `paid_consent`, cost/time estimates per metric call,
`max_reflection_tokens`). `evaluate(ctx, artifact)` takes
`mars.optimization-evaluate-request/v1` (`target_id`, `candidate`, `budget`)
and scores the seed (if not yet scored) and the candidate on `validation`.

## Tests

- `bun test packages/optimization`: fixture `PromptScoringBackend`
  (deterministic, `simulated: true`) and a scripted `ReflectionResponder`,
  `fetch` stubbed to throw (no network, `model_requests: 0`). Runs the REAL
  Python worker end-to-end when `python/.venv` exists (skips with a warning
  otherwise); fake Bun workers (`tests/fake-worker.ts`) cover deadline kill,
  budget stop, metric-call ceiling, foreign instance ids, garbage output, bad
  pins and cancel. Lifecycle, holdout isolation, report schema and a
  `no_improvement` run are covered too.
- `python/tests`: pytest with fake stdin/stdout for the protocol, pin refusal,
  adapter, reflective dataset bounds/scrubbing and a full brokered run.

## Verified / unverified

- Verified offline: everything above, with gepa 0.1.4 really driving the
  brokered adapter in the venv.
- Unverified: any live model reflection (the registry responder is exercised
  only by type-checking and shares its implementation pattern with
  `@mars/research-worker`), any real scoring backend, and any claim about
  real prompt quality. All scores in tests are simulated fixtures.
- CI does not create the venv, so the real-worker tests skip there.

## Limits

- One worker process per job; GEPA runs synchronously, so concurrency only
  spans the score requests of one iteration.
- GEPA may overshoot `max_metric_calls` by one iteration; the host's hard
  ceiling is the real bound.
- `inspect().cost_usd` is `null` only when every score was unmeasured.
