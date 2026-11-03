# @mars/evaluation — Harbor / Terminal-Bench 2 adapter

Independent evaluation for MARS prompt and agent candidates. Implements
`EvaluationService` and `PromptScoringBackend` from `@mars/contracts` on top of
[Harbor](https://github.com/laude-institute/harbor) 0.25.0 and the
Terminal-Bench 2 datasets. Candidates never see evaluators, hidden tests, final
holdout tasks or accounting; every verdict is derived from Harbor's on-disk
`result.json` records, never from a process exit code.

## Architecture

```
ComparisonManifest (mars.evaluation-comparison/v1, zod, immutable artifact)
        │ submitComparison(context, manifestRef, budget)
        ▼
createEvaluationService ── durable job store: <stateDir>/jobs/<job_id>.json
        │ one Harbor run per arm, same dataset pin / tasks / repeats / model / images
        ▼
createHarborRunner ── Bun.spawn(setsid harbor run …) from a pinned Python venv
        │ refuses: wrong python/harbor/mini-swe-agent version, registry drift,
        │          unpinned or locally-missing Docker images, unpinned agent bundle
        │ enforces: Budget.max_duration_ms (process-group SIGTERM→SIGKILL), max_concurrency (-n)
        ▼
<jobsDir>/<job>/result.json + <trial>/result.json ── readHarborJob → TrialRecord[]
        ▼
buildEvaluationReport (mars.evaluation-report/v1) + storeTrialBundle → ArtifactRef[]
```

| Module | Role |
| --- | --- |
| `src/manifest.ts` | `ComparisonManifestSchema`: dataset pin (name, version, registry url/revision/sha256, task source git url + 40-hex commit), ordered tasks, `final_holdout_tasks`, `repeats`, arms (`mini-swe-agent` 2.4.6 vs `mars-oh-my-pi` + `PromptCandidate`), matched model (id, base URL, **API-key env var name only**, `openai_chat_completions`), digest-pinned Docker images, timeouts, `Budget`, per-trial limits. |
| `src/harbor-records.ts` | Zod parsers for Harbor 0.25.0 job/trial `result.json`; `toTrialRecord`, `readHarborJob`. Reward validity follows Harbor's `ErrorPolicy`: only agent-attributable exceptions (`AgentTimeoutError`, context/output-length errors, safety refusals) keep a reward valid. |
| `src/report.ts` | `buildEvaluationReport`: per-arm aggregates, per-task comparison, `regressions`, `repeatability` (mean/variance/min/max/`disagree` per task × arm), `unstable_tasks`, pin-mismatch exclusions, Harbor counters for cross-checking, `verdict`. |
| `src/runner.ts` | `createHarborRunner`: `probe`, `verifyPins`, `verifyRegistry`, `verifyImages`, `buildArgv`, `run`. Docker is the only environment (`--env docker`); there is no host-shell fallback. |
| `src/service.ts` | `createEvaluationService`: `submitComparison` / `inspect` / `cancel`, atomic JSON job records, scoped access, trajectories as artifacts. |
| `src/scoring.ts` | `createHarborScoringBackend` (MARS arm only, `simulated: false`) and `createFixtureScoringBackend` (deterministic, `simulated: true`). |
| `src/trajectory.ts` | `packTrialDir` / `storeTrialBundle` (agent logs, verifier output, artifacts, trial.log; never `tests/`, `solution/`), `renderTrialFeedback` (bounded, labelled untrusted evidence for GEPA reflection). |
| `agent/main.ts` | Bundle entry executed **inside** the task container; drives `openRuntimeSession` from `@mars/execution` with local `RuntimeTools` and a registry built from the passed provider config; writes `mars-usage.json`. |
| `python/mars_harbor_agent/agent.py` | `MarsAgent(BaseAgent)`, `name() == "mars-oh-my-pi"`, selected with `-a mars_harbor_agent.agent:MarsAgent`. |
| `scripts/live-check.ts` | Live dry-run / control-arm verification against a real venv + Docker (not part of `bun test`). |

## Matched-condition guarantees

* One manifest, two arms: identical dataset pin, task list, `repeats`, model id,
  base URL, API format, key env var name, Docker images, timeouts and budget.
  The runner builds both `harbor run` command lines from the same manifest.
* Both agents run inside the Harbor task container. mini-swe-agent uses
  Harbor's installed adapter (`-a mini-swe-agent --ak version=2.4.6`); MARS
  uploads a prebuilt bundle and runs it with `cd <workdir> && mars-agent`.
* The MARS agent receives only Harbor's `instruction` plus the provider config
  and prompt components. Verifier files, `tests/`, `solution/` and final-holdout
  task ids are never passed to it; the trajectory bundle excludes them too.
* Prompt candidates reach the runtime only through the additive
  `RuntimeSessionOptions.systemPromptOverride` (default prompt unchanged when
  absent). Only the `system_prompt` component is applied today; other component
  keys are recorded in `mars-usage.json` as inert.
* Oh My Pi remains the only session/tool/model owner: `agent/main.ts` has no
  loop of its own; every model request and tool call goes through
  `openRuntimeSession`.
* Secrets: manifests, argv, job records, logs and the container config carry
  only the env var *name*; the key value is read from the host environment by
  the Python adapter and injected into the container process environment only.

## What is parsed

Per trial (`TrialRecord`): `reward` (`rewards.reward`, else first numeric
reward), `rewards`, `reward_valid`, `exception {type, message}`, `cost_usd`,
`n_input_tokens`, `n_output_tokens`, `n_cache_tokens`, `runtime_ms` (agent
execution phase), `total_ms`, task source (`git_url`, `git_commit_id`, `path`,
`checksum`), dataset, agent name/version, model name/provider.

Per job: Harbor's `n_total_trials`, `stats.n_completed_trials`,
`stats.n_errored_trials`, `stats.evals`; used only for cross-checking in
`report.harbor`. Trials with empty/unparseable `result.json` are listed in
`unreadable_trials`, and trials whose task commit, task id or agent name do not
match the manifest are listed in `pin_mismatches` and excluded.

## Repeatability semantics

For every task × arm over the `repeats` identical trials: `rewards` (valid
only), `mean_valid`, `mean_strict` (invalid/missing trials count as 0, divisor =
`max(repeats, n_trials)`), population `variance`, `min`, `max`, `disagree` (true
when valid rewards differ or when some but not all repeats are valid).
`regressions` lists tasks where `candidate.mean_strict < baseline.mean_strict`.
`verdict.complete` is true only when every expected trial of both arms has a
valid reward and nothing was excluded.

## Holdout isolation

`final_holdout_tasks` live in the manifest for the full comparison, but
`createHarborScoringBackend` refuses to construct splits containing them and
refuses any `ScoringRequest` naming them (the contract only knows
`train`/`validation`). The scoring backend only ever launches the MARS arm with
`-i <instance>` for the requested instances, so Harbor never materialises other
tasks for that run.

## Setup

```sh
curl -LsSf https://astral.sh/uv/install.sh | sh
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r packages/evaluation/python/requirements.lock
#   harbor==0.25.0  mini-swe-agent==2.4.6  pytest==8.4.2
.venv/bin/python -m pytest -q packages/evaluation/python/tests

# MARS agent bundle (host build; the Bun single-file executable needs the
# pi_natives addon beside it because `omp-legacy-pi-modules` is externalised)
bun build --compile --target=bun-linux-x64 --external omp-legacy-pi-modules \
  packages/evaluation/agent/main.ts --outfile <bundle>/mars-agent
cp node_modules/**/pi_natives.linux-x64-modern.node <bundle>/
sha256sum <bundle>/mars-agent   # → arms.candidate.bundle.sha256

# live sanity check through the runner (dry run, then nop/oracle control arms)
bun packages/evaluation/scripts/live-check.ts --venv /abs/.venv --jobs /abs/jobs \
  --image ghcr.io/laude-institute/terminal-bench/regex-log:2.0@sha256:<digest> [--run]
```

Dataset pins (`src/pins.ts`, from Harbor `registry.json` at
`a81b92d5f3cd06afaa1d3ad7bcaa926c6100fb5a`): `terminal-bench@2.0` = 89 tasks
from `laude-institute/terminal-bench-2` @ `69671fbaac6d67a7ef0dfec016cc38a64ef7a77c`;
`terminal-bench-sample@2.0` = 10 tasks from `laude-institute/terminal-bench-2-0-sample`
@ `7e917f35c281188532772312d4ad91ca9274febc`. `fixtures/registry.tb2.json` is
the two-dataset subset of that registry (the full file is 14 MB); the manifest
records the upstream sha256 and the local file's sha256, and the runner refuses
to start if the local file or any task's repo/commit differ from the pin.

## Limits (honest)

* Harbor 0.25.0 builds/pulls task images from the task definition; the
  manifest's digest pins are validated for form and checked against
  `docker image inspect` before launch, but Harbor is not forced to use them.
  Per-trial records carry the task git commit and checksum, which the report
  checks; they do not carry the image digest.
* `--dry-run` validates metadata only (Harbor skips task content and commit
  existence checks).
* `cost_usd` from Harbor is `null` for agents that do not report it; the MARS
  bundle reports the runtime ledger's `reserved_usd`, which is 0 for free
  models. Token counts come from the runtime ledger (`input_tokens`,
  `output_tokens`); cache tokens are not tracked and are reported as 0.
* `model_requests` in `mars-usage.json` counts Oh My Pi `message_start` events
  (one per assistant turn, including retries).
* The bundle is a 143 MB Bun executable plus a 122 MB native addon uploaded per
  trial; `setup()` verifies the bundle sha256 but does not deduplicate uploads.
* Only `system_prompt` is an applied component. There is no ATIF trajectory
  from the MARS agent; its Oh My Pi journal is not yet exported into the trial
  directory (only `mars-usage.json` and stdout/stderr are).
* No upstream Harbor adapter exists for Oh My Pi; `MarsAgent` is ours and is
  not registered in Harbor's agent table — always select it by import path.
* Budget metering is per trial plus a wall-clock deadline: every trial receives
  `per_trial.max_tokens` / `per_trial.max_usd` and the whole comparison is
  killed at `Budget.max_duration_ms`, but Harbor exposes no hook to stop
  dispatch when the *aggregate* `max_usd` / `max_tokens` is reached mid-run.
  The manifest validation only guarantees `per_trial ≤ total`; size
  `per_trial` so that `trials × per_trial` fits the total if the aggregate cap
  must be hard.
* GEPA `feedback` deliberately contains the verifier's stdout tail (labelled as
  untrusted evidence). If a task's verifier prints its own test code or the
  expected answer, that text reaches prompt optimisation; final-holdout tasks
  are never scored for exactly this reason, and the trajectory bundles still
  exclude `tests/` and `solution/`.

## Verified

Run on this package's development VM (Bun 1.4.4, Python 3.12.13, Docker 29.7.2):

* `bun test packages/evaluation` — 15 offline tests, `model_requests: 0`:
  manifest validation, real nop/oracle record parsing, exit-0-but-errored and
  null-reward trials, agent-timeout validity, report aggregates / regressions /
  repeatability / holdout flag / pin exclusion, trajectory bundle excludes
  `tests/`, pin refusal (harbor/mini-swe-agent/python), registry drift
  refusal, argv matching, process-group kill on deadline and on cancel (fake
  `harbor` that ignores SIGTERM and owns a grandchild), durable service
  end-to-end, scoring backend holdout refusal, fixture backend determinism.
* `packages/execution/src/runtime.test.ts` — `systemPromptOverride` applies
  only when supplied; default prompt unchanged; empty/oversized overrides
  rejected.
* `python -m pytest packages/evaluation/python/tests` — 7 tests with a fake
  environment: identity, bundle upload + sha check, config without secrets,
  instruction-only run, usage reporting, missing-usage handling, kwarg
  validation.
* Harbor `nop --dry-run` for `terminal-bench-sample@2.0 -i regex-log -k 2`
  through `createHarborRunner` (see `scripts/live-check.ts`): exit 0,
  `Dry run OK — 2 trial(s); nothing was run.`
* Real Docker runs of `nop` and `oracle` on `regex-log` with `-k 2` parsed by
  `readHarborJob` (fixtures under `fixtures/harbor/{nop,oracle}-regex-log` are
  copies of the real records): nop → reward 0.0 × 2, oracle → reward 1.0 × 2,
  `n_errored_trials: 0`.
* `bun build --compile` of `agent/main.ts` succeeds with
  `--external omp-legacy-pi-modules`; the executable runs the real runtime
  (verified against an unreachable endpoint: it attempts model requests, fails
  closed and writes `mars-usage.json` with `status: "failed"`).

## Unverified

* No live-model trial of either arm has been run: mini-swe-agent 2.4.6 and the
  MARS bundle were **not** executed against a real model (no Ollama/API model
  was available in this session). The `synthetic-*` fixtures are hand-built in
  Harbor's record shape to exercise parsing/reporting paths and are labelled
  as such.
* `MarsAgent` has not been executed by Harbor inside a real task container;
  `setup()/run()` were exercised only with the fake environment.
* Cost figures for paid models and cache-token accounting.
