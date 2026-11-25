# Independent evaluation and prompt optimisation (Milestone 4)

This document describes how MARS measures itself against an independent
harness and how prompt changes are proposed. It follows
[`MASTER_SPECIFICATION.md`](MASTER_SPECIFICATION.md) sections 8, 9, 11 and 16:
learning claims are measured by an independent verifier, candidates are
compared with a pinned baseline under matched conditions, costs and
regressions are recorded, and nothing is promoted automatically.

Everything below is either **verified** (actually executed in this
repository's history, with the command and output recorded) or
**unverified** (implemented and tested offline with fixtures, but not run
against the real external system). Simulated and fixture-driven results are
labelled `simulated: true` in their records and are never acceptance
evidence.

## Ownership (one owner per responsibility)

| Responsibility | Owner | Notes |
| --- | --- | --- |
| Live agent loop, tools, model calls | Oh My Pi via `@mars/execution` `openRuntimeSession` | The Harbor agent adapter drives this runtime; it does not add a second loop. |
| Benchmark harness, task environments, verifiers | Harbor 0.25.0 (pinned Python 3.12 venv) | Launched and bounded by `@mars/evaluation`; result/reward/error records are parsed, exit codes are not trusted. |
| Task set | Terminal-Bench 2 (`terminal-bench@2.0`, `terminal-bench-sample@2.0`) | Pinned per task to a git commit by the Harbor registry (see [`SOURCE_REGISTER.md`](SOURCE_REGISTER.md)). |
| Baseline agent | mini-swe-agent 2.4.6 via Harbor's installed adapter | Same task, environment, verifier and model endpoint as the candidate. |
| Comparison, repeatability, regressions, trajectories | `@mars/evaluation` | Implements `EvaluationService` and `PromptScoringBackend` from `@mars/contracts`. |
| Prompt optimisation | GEPA 0.1.4 in a separate pinned Python worker, driven by `@mars/optimization` | Implements `OptimizationService`; scores only through `PromptScoringBackend`; candidates are proposals. |

`PromptScoringBackend.score(context, request, { signal })` carries an optional `AbortSignal`: when an optimisation job is cancelled or reaches its deadline the Harbor run behind the score is killed (process group), so no evaluation outlives the job that requested it. The seed candidate is re-scored under every `evaluate` request (same repeats and backend as the candidate); earlier baselines are never compared against a new candidate. Inside the task container the credential never enters any process environment or argv: the adapter uploads it as a file, `chown`s it (from a root exec, since `docker cp` creates root-owned files) to the uid/gid the trial actually runs as, `chmod 0600`s it and verifies `test -r` as that user (all adapter commands run with a fixed `PATH=/usr/sbin:/usr/bin:/sbin:/bin`, so a task-controlled PATH entry cannot shadow them; a hostile task image that replaces `/bin` itself is outside this boundary; each of these commands carries its own 60 s `timeout_sec`). `trial_timeout_ms` bounds the adapter's `run()` — instruction upload, credential handover and the bundle exec (whole seconds of the remaining budget, refused under 1 s); Harbor's `upload_file`/`download_file` take no timeout, so they are wrapped in `asyncio.wait_for` on the remaining budget — independently of Harbor's per-task agent timeout, which is unset for tasks without one. Usage collection after the bundle exits gets the larger of the remaining budget and a 10 s grace window; a slow or missing usage file is recorded as `usage_available: false` / `usage_error` and never turns a completed trial into an agent error. `setup()` (bundle, addon and config upload) is bounded by Harbor's agent setup timeout (`DEFAULT_SETUP_TIMEOUT_SEC` × `--agent-setup-timeout-multiplier`), not by `trial_timeout_ms`. — an unreadable credential fails the trial before it starts instead of surfacing as a model authentication error — and the bundle reads and unlinks it (`MARS_AGENT_CREDENTIAL`) before any task command runs — deleting a variable from `process.env` alone would leave it readable in `/proc/<pid>/environ`. `MARS_AGENT_*` is a reserved prefix and rejected as a model `api_key_env` name. `EvaluationJobStore` serializes writes per job (each write uses a unique temp file and waits for the previous one), so the `onSpawn` pid update cannot race the completion update that follows a short Harbor run.
| Model configuration | `@mars/providers` registry (`~/.mars/models.json` or `$MARS_HOME/models.json`) | Includes the built-in `ollama` provider for local models. |

## Packages

- [`packages/evaluation`](../packages/evaluation/README.md) — Harbor adapter,
  `mars.evaluation-comparison/v1` manifests, result parsing, grader
  repeatability, regressions, trajectory artifacts, Harbor scoring backend,
  Python `mars_harbor_agent` custom agent.
- [`packages/optimization`](../packages/optimization/README.md) — bounded GEPA
  worker, train/validation/final-holdout splits, candidate lifecycle and
  proposal reports.

Workbench wiring is read-only: `WorkbenchHostOptions.optimization` (a
`candidates`/`report` view of `@mars/optimization` plus the target ids a
workbench may read) adds the host-bound `mars_proposals` tool, which renders
candidates and proposal reports as bounded, labelled untrusted text. Sessions
cannot propose, decide, publish, or see the final holdout through it.

The package READMEs carry the detailed architecture, setup commands, test
inventory and their own verified/unverified sections. This document records
the cross-cutting rules and the evidence produced in this increment.

## Rules that every run must satisfy

1. **Matched conditions.** Baseline and candidate run the same task ids at the
   same pinned task commit, the same Harbor version, the same Docker images
   (recorded by digest), the same model name and base URL, the same timeouts
   and the same number of repeats. A manifest that does not pin these is
   rejected before anything runs.
2. **Records, not exit codes.** Harbor can exit 0 with errored trials
   ([`MILESTONE_0.md`](MILESTONE_0.md)). A trial counts only when its
   `result.json` has `verifier_result.rewards` and no reward-invalidating
   exception; every exception is recorded with the trial.
3. **Repeatability.** Each trial is run N times (`repeats`); the report
   stores mean, variance, min and max per task and arm and flags tasks whose
   identical repeats disagree, so grader noise is visible before any claim.
4. **Regressions are first-class.** Any task where the candidate scores below
   the baseline is listed; a report with regressions cannot be summarised as
   an improvement.
5. **Holdout isolation.** Optimisation only ever sees `train` and
   `validation` instance ids (the `ScoringRequest.split` type has no holdout
   value). `final_holdout` ids live in a separate record read only by the
   final-report path. Verifier files never reach the candidate: the agent
   receives `instruction.md` only.
6. **Proposals only.** Optimised prompts are stored as `PromptCandidate`
   records with a `draft -> proposed -> accepted | rejected | archived`
   lifecycle. Nothing writes to the live `SYSTEM_PROMPT` or any production
   target. A result of "no improvement" is a valid, expected outcome and is
   reported as such.
7. **Bounds at the boundary.** `Budget.max_duration_ms`, `max_usd` and
   `max_concurrency` are enforced by the TypeScript side, which kills the
   Harbor or GEPA process tree on deadline or cancel. Python workers are
   untrusted; their pins are verified before launch.
8. **Untrusted evidence.** Anything shown to a model (verifier output,
   trajectories, feedback for reflection) is rendered as bounded text labelled
   as untrusted evidence with secrets scrubbed.

## Python environment (exact pins)

```sh
curl -LsSf https://astral.sh/uv/install.sh | sh
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python harbor==0.25.0 mini-swe-agent==2.4.6 gepa==0.1.4
```

DSPy is intentionally **not** installed: DSPy 3.4.1 pins GEPA 0.1.4 while the
audited GEPA HEAD differs, so GEPA runs in its own worker. Package READMEs
record the full `uv pip freeze` lock files they rely on. Harbor needs Docker;
there is no host-shell fallback.

Verified in this increment (no model):

```text
$ harbor dataset list --legacy        # terminal-bench 2.0 (89), terminal-bench-sample 2.0 (10)
$ harbor run -d terminal-bench-sample@2.0 -a nop --dry-run -o jobs --job-name dryrun-sample -y
Dry run OK — 10 trial(s); nothing was run.
$ harbor run -d terminal-bench-sample@2.0 -i regex-log -a nop    -k 2 -n 2 -o jobs --job-name nop-regex-log-k2 -y     # 2 completed, 0 errored, reward 0.0 x2, 27 s
$ harbor run -d terminal-bench-sample@2.0 -i regex-log -a oracle -k 2 -n 2 -o jobs --job-name oracle-regex-log-k2 -y  # 2 completed, 0 errored, reward 1.0 x2, 26 s
```

The two Docker runs (parsed records in
[`evidence/harbor-live-runs.txt`](evidence/harbor-live-runs.txt)) show the
grader discriminating (`nop` 0.0 vs `oracle` 1.0) with zero variance over two
identical trials on a deterministic task. This is grader-repeatability evidence
for one task without any model, not an agent comparison.

## Local model path: Ollama with Qwen3-Coder

Ollama is a built-in `openai-compatible` provider (`id: ollama`, base URL
`http://localhost:11434/v1`, no API key). Register a Qwen3-Coder model with the
existing `models` command; nothing is added to the built-in model list because
the default route would then try an unreachable local endpoint on machines
without Ollama.

```sh
curl -fsSL https://ollama.com/install.sh | sh      # CPU-only works; 18 GB download for the 30B MoE model
ollama pull qwen3-coder:30b
export MARS_HOME=~/.mars                           # or any private directory holding models.json
bun apps/cli/src/main.ts models add --provider ollama --model qwen3-coder:30b \
  --id ollama/qwen3-coder --tools --context 32768 --free
bun apps/cli/src/main.ts models test ollama/qwen3-coder
bun scripts/local-model-run.ts ollama/qwen3-coder  # tiny real Oh My Pi runtime run, write approval only
```

For Harbor runs the same endpoint is passed as `--base-url` (reachable from
the task container, e.g. `http://host.docker.internal:11434/v1` or the Docker
bridge address) with `--api-format openai_chat_completions`; the API-key
environment variable may hold any placeholder because Ollama ignores it.

### Evidence (live model, CPU-only VM, 8 vCPU / 31 GiB, no GPU)

Full transcript: [`evidence/local-model-run.txt`](evidence/local-model-run.txt).

| Step | Result |
| --- | --- |
| Direct `/v1/chat/completions`, 16-token prompt | `MARS-OK`, 26.4 s cold (model load), **verified** |
| `mars models test ollama/qwen3-coder` | `MARS model test OK`, 16 in / 6 out tokens, 2.5 s warm, **verified** |
| `scripts/local-model-run.ts` (real runtime session, 3 identical runs) | status `completed`, 1 model request, but `greet.txt` **not written**: the model returned its tool call as text, **verified failure** |
| Replay of the exact request without the MARS system prompt | structured `tool_calls` for `mars_write`, **verified** |
| MARS agent (`mars_harbor_agent.agent:MarsAgent`, compiled bundle) inside a real TB2 container on `regex-log`, two variants (default prompt, minimal prompt candidate) | both ran end to end, reward 0.0, `status: failed`, 2 model requests each cut at the 60 s per-request cap; **verified failure** ([`evidence/harbor-mars-agent-live.txt`](evidence/harbor-mars-agent-live.txt)) |
| mini-swe-agent 2.4.6 baseline inside a TB2 container with this model | **unverified**: Harbor's installed adapter started it but `litellm` failed to import (`No module named 'mcp'`) in a retry loop; no request reached the model |

Interpretation: with `qwen3-coder:30b` through Ollama, the fixed MARS system
prompt in `packages/execution/src/runtime.ts` deterministically (temperature 0)
makes the model emit a malformed native XML tool call that Ollama's
OpenAI-compatible parser does not convert, so the runtime sees prose instead of
a tool call. Removing the `i` intent parameter or the `<system-reminder>`
preamble does not change this; removing the system prompt does. The system
prompt is precisely the explicit prompt target that `@mars/optimization`
treats as a proposal, so it was **not** changed here. Inside Harbor task
containers a second limit dominates on this CPU-only machine: the runtime caps
each provider request at 60 s (`packages/execution/src/model-bridge.ts`), and
qwen3-coder:30b on CPU does not finish a ~2k-token TB2 request in that time,
so both live MARS trials failed before any tool call. A real-model comparison
therefore needs a faster endpoint (GPU) or a configurable per-request timeout,
plus an accepted prompt proposal or a different model; all remain unverified.
The per-request timeout is now configurable per model with `requestTimeoutMs`
in `models.json` (1 000 ms to 1 h; default 60 000 ms, always bounded by the
task deadline), and a failed run reports a `failure_code` (`provider_timeout`,
`deadline_exceeded`, `budget_exhausted`, `provider_error`, `no_response`) in its
error and in the workbench `runtime.result` event.
The per-request output cap is configurable per model with `maxOutputTokens`
(256 to 1 000 000; default 4 096, always bounded by the task token budget and
the context window) and applies identically to MARS arms and `omp-stock`. The
2026-11-15 Magnitude smoke run hit the old fixed 4 096 cap on every reply. Two
other smoke-run fixes apply to every OpenAI-compatible request: omp's
mid-conversation date/cwd reminder is sent as a user turn, not a late `system`
message that strict servers reject with HTTP 400, and the host workspace path is
rewritten to the placeholder `/__mars_workspace__` (mapped back to the real
root in the model's tool-call arguments, so exact-text edits still match).

## What is verified and what is not (this increment)

Verified (commands and outputs recorded above or in the package READMEs):

- Harbor 0.25.0, mini-swe-agent 2.4.6 and GEPA 0.1.4 install into a pinned
  Python 3.12 venv; `harbor run --dry-run` resolves the pinned
  `terminal-bench-sample@2.0` trials.
- Ollama + Qwen3-Coder answers through the existing providers registry with
  no API key; the runtime-level tool-calling failure above is reproducible.
- Offline test suites of both packages (fixtures, fake workers, injected
  responses) with `model_requests: 0`.

Unverified:

- A full baseline-vs-candidate Terminal-Bench 2 comparison with a real model
  (the MARS arm ran live but failed at the 60 s request cap; the
  mini-swe-agent arm did not start).
- Grader repeatability on real TB2 containers beyond the single `regex-log`
  nop/oracle check above and what the package README reports.
- A GEPA optimisation run with a real reflection model producing an improved
  validation score; a run that shows no improvement is an equally valid
  outcome and must be reported as such.
- Harbor separate-verifier (`no-network`) isolation on this VM
  ([`MILESTONE_0.md`](MILESTONE_0.md)).

Milestone 4 acceptance (spec section 16) is therefore **not claimed**.

## Milestone 7 — held-out specialist adapter-vs-base evaluation

`SpecialistRegistry.requestEvaluation` stores a
`mars.specialist-comparison-request/v1` manifest and submits it through
`EvaluationService.submitComparison`. `createSpecialistComparisonService`
(`packages/evaluation/src/specialist-comparison.ts`) is that service for
specialists:

- **Request → job.** Submission parses the request, resolves the registered
  revision (`subjectResolverFromRegistry` over `SpecialistRegistry.inspect`)
  and refuses with a `SpecialistComparisonError` unless the scope and
  `candidate_sha256` match. Refusals happen before a job exists, so the
  registry records no evaluation job for them.
- **Held-out exclusion.** The held-out split is a `mars.held-out-split/v1`
  file served by `createHeldOutGuard` from `@mars/datasets`. The candidate's
  dataset lineage (train + validation task ids and dataset digests) goes
  through `findHeldOutLeakage`: any held-out task id, normalized request digest
  or the split's own digest in the lineage refuses the job with
  `heldout_leakage`. Lineage `request_sha256s` (SHA-256 of each normalized
  training/validation request) are checked to catch matching request text
  across different task ids. Every held-out task must carry its `request` text.
  A lineage without this field (or with an empty list) is refused with
  `lineage_requests_unverifiable`, since request overlap cannot be ruled out.
  `packages/training` writes the digest of every user turn in its train and
  validation examples into the lineage it signs. An adapter without lineage
  is refused (`lineage_missing`), and an evaluator whose id equals the
  lineage's training producer is refused (`evaluator_not_independent`). Only
  split tasks covered by the request's domains, roles and complexities run.
- **Matched conditions.** Every arm (`base` and `prompt_optimized_baseline`
  on the registered base model, `current_specialist` when a production
  revision exists, `candidate`) runs the same tasks, repeats, seed (derived
  from the candidate digest and split digest) and an equal share of the job
  budget; an arm that overspends its share fails the job. A task passes when a
  strict majority of its repeats score 1.
- **Job → verdict.** The service writes a signed
  `mars.specialist-evaluation-report/v1` (HMAC, exactly as
  `createHmacEvidenceVerifier` checks it) and a
  `mars.specialist-comparison-verdict/v1` whose `outcome` is `improved` only
  when every gate passes with a positive delta vs base. Equal pass rates are
  recorded as `no_improvement` (`no_delta_vs_base`); a lower rate is
  `regressed`. Both artifacts are returned by `inspect` and handed to the
  `SpecialistVerdictSink`. In integration the sink is
  `verdictSinkFromRegistry(registry)`: `SpecialistRegistry.recordEvaluationVerdict`
  accepts the verdict only for a job it delegated (job id, input manifest,
  subject and candidate digest must match), re-runs `verifyEvidence` on the
  signed report, refuses reports that fail integrity (signature, digest,
  subject, scope, independence, or synthetic evidence the registry does not
  allow) so the job fails, and otherwise stores the verdict against the
  revision. The newest recorded report becomes the revision's gating
  evidence, so an authentic `regressed` verdict demotes it to `rejected`.
  Jobs persist under
  `<stateDir>/specialist-comparisons/`; a job left running by a restarted
  process is marked failed, never resumed silently.
- **CLI.** `runSpecialistsEvaluate` in `apps/cli/src/specialists-eval.ts`
  (`mars specialists evaluate`) refuses with `SpecialistsEvalRefusal`
  when `--model-key-env NAME` is unset, `--serving URL` is absent or does not
  answer `GET /v1/models`, or live configuration is absent. Messages
  name flags and variable names, never the key.

Offline-verified: the round trip, leakage refusals, no-improvement and
regressed verdicts, budget overrun, restart, scope isolation and every CLI
refusal, with `createFixtureArmEvaluator` (simulated, `model_requests: 0`)
and the registry's own `verifyEvidence` accepting the signed report.
Simulated reports carry `synthetic_fixture: true`, so a registry without
`allowSyntheticFixtures` rejects them. The serving-backed evaluator is now wired
and separately tested against loopback fake completions (`simulated: false`);
real vLLM with base + adapter, a GPU host and a model key remain blocked.

### Serving-backed CLI

```sh
mars specialists evaluate --specialist specialist-1@1 --held-out HELDOUT.json \
  --model-key-env MARS_EVAL_KEY --serving http://127.0.0.1:8000 \
  --registry /private/specialists --trust TRUST.json --signing-key-id local-key \
  --vllm-profile PROFILE.json --expectations EXPECTATIONS.json \
  --owner local --project my-project \
  --max-tokens 100000 --max-duration-ms 30000
```

The original `--specialist`, `--held-out`, `--model-key-env` and `--serving`
preconditions retain their order. With none of the live configuration flags,
the command still refuses `live_evaluation_unavailable` after key and serving
checks. For the default live implementation, `--registry`, `--trust`,
`--signing-key-id`, `--vllm-profile`, `--expectations` and `--project` are required.
`--owner` defaults to `local`. Optional `--max-tokens` (100000) is the total job
budget divided equally among runnable arms; `--max-duration-ms` (30000) bounds
the job. Both must be positive integers. `--prompt-optimized FILE` supplies a
UTF-8 system prompt for the prompt-optimized baseline arm only.

`--serving` is the loopback vLLM origin; this CLI has no remote-serving opt-in.
The named model key is used for the models probe and serving requests. The
profile pins the base, tokenizer and chat template as in
[SERVING.md](SERVING.md). The model catalog is extended with the base and loaded
sha256-named adapters; the registry gets a profile-backed serving attestor.
`--signing-key-id` selects an authority authorizing the owner and the fixed
evaluator id `mars-serving-evaluator`. The strict trust schema and UTF-8 secret
environment-variable semantics are in [SPECIALISTS.md](SPECIALISTS.md).

`--expectations` is strict JSON with one entry for **every** held-out split task
and a matching `split_id`:

```json
{
  "schema": "mars.held-out-expectations/v1",
  "split_id": "my-heldout-split",
  "tasks": {
    "heldout-task-1": {
      "must_include": ["expected answer"],
      "must_not_include": ["forbidden answer"]
    }
  }
}
```

Both arrays are optional. Grade is 1 exactly when all includes are present and
all excludes absent (case-sensitive substring matching), otherwise 0. An empty
rule passes every response, so it is not a meaningful quality test. Invalid or
incomplete files refuse `expectations_invalid`; invalid trust or signing
authorization refuses `trust_invalid` without printing secret values.

`createServingArmEvaluator` uses the existing OpenAI-compatible adapter. Base
and prompt-optimized arms use the profile's base served name; candidate/current
require `target.adapter.sha256`, refusing `adapter_missing` before any request
when it is absent rather than silently evaluating the base. It sends
temperature **0**, bounds each completion by the remaining per-arm token budget
and per-request cap (1024 by default), counts actual requests and reported input
and output tokens, honors cancellation, and rejects missing usage or overspend.
Every request of every arm in a job forwards the same integer `seed` in the
OpenAI-compatible body: `servingSeed(job.seed)` is the seed itself when it is
a decimal safe integer, otherwise `parseInt(sha256(seed)[0..8], 16)`. The
forwarded seed is also an input of each arm's `agent_manifest_sha256`. vLLM
applies it per request on a best-effort basis (batching, kernels and hardware
can still change outputs), so this is not a claim of bit-exact server-side
determinism. `createOpenAICompatibleAdapter` sends `seed` only when the request
sets one, and refuses a negative or non-safe-integer seed before any request.
Without `--prompt-optimized`, the prompt-optimized arm is identical to base.
Self-hosted cost is recorded as **$0**, not a measurement of GPU or host costs.

Before completions, a candidate adapter absent from `/v1/models` refuses
`candidate_not_served`. Held-out leakage is rejected by comparison planning and
surfaced as `evaluation_refused`. Both paths make **zero completions**. Missing
attestation, unloaded adapters or off-pin serving cannot authorize adapter
routing; serve falls back to an eligible baseline (or refuses initial attach).

Artifacts use `<registry>/artifacts/<sha256>` with file mode `0600`, directory
mode `0700`, and SHA-256/byte-length checks on reads. Jobs are stored under
`<registry>/evaluations/specialist-comparisons/`. The registry delegates the job,
waits for completion, re-verifies its signed report, and stores its verdict on
the revision (`evaluationVerdicts`). Output includes `outcome`, `codes`,
`triples`, `report_sha256`, `simulated: false`, and `model_requests` equal to the
completion count, including the base and prompt-optimized arms. No-improvement
is stored honestly rather than relabeled as improvement.

Offline-verified: authenticated fake vLLM with opt-in fake completions;
improved and no-improvement verdict persistence; candidate-not-served and leakage
with zero completions; invalid trust, expectations and budgets; evaluator
cancellation, malformed responses, missing usage and token overruns; and a CLI
spawn round trip. Real attestor code against fake endpoints and injected fake
attestor paths are offline checks, as are simulated fixture evaluators (zero
model requests). **Blocked/unverified:** GPU host, real pinned vLLM, real model
key, live adapter serving/completions and any resulting quality improvement.

## Edit-format benchmark: MARS harness vs stock Oh My Pi

`packages/evaluation/src/edit-benchmark/` measures whether MARS's harness
improves small models more than stock Oh My Pi (omp), and supplies the
evidence for per-model edit-format selection.

### Pre-registered success bar (written before any live run)

> MARS's default edit format for that model beats `omp-stock` on
> host-verified solve rate for small models with **p < 0.05 on the paired exact two-sided sign test** over
> tasks (a task counts as solved when a strict majority of its repeats
> solved), **and** its cost per verified solve is **not worse** (USD when
> either arm is priced, otherwise total input + output tokens per verified
> solve). Results are published whichever way they go.

(Wording amended 2026-11-14 from "MARS's best edit format"; see the
confirmatory-arm amendment below.) The bar is encoded as `PREREGISTERED_BAR`
(`mars-vs-omp-stock/v2`; `v1` was the best-format wording) in
`report.ts` and every report carries the verdict (`met`, `significant`,
`cost_not_worse`, summary). Nothing is "proven better than omp" until this
benchmark has run live on real small models; as of this writing it has not.

### Amendment 2026-11-14 (before any live run): one confirmatory arm

The v1 bar tested the *best* of the MARS arms, picked after seeing the
results, at unadjusted alpha 0.05. With three MARS arms that is a
multiple-comparisons problem: the chance of a false "MARS beats omp" is above
5%. From 2026-11-14, still before any live data:

- The confirmatory candidate is fixed before the run from the model under
  test: the MARS arm whose format is `defaultEditFormat(model)` (`hashline`,
  or `replace` for the models omp gives `replace`). Reports record it as
  `verdict.confirmatory_arm` with `verdict.confirmatory_reason:
  "static_default"`. Only that comparison against `omp-stock` computes the
  pre-registered verdict at alpha 0.05. It is a single test, so the power
  design and `MIN_POWERED_TASKS = 129` below are unchanged.
- If the confirmatory arm did not run (for example `--arms` without it), the
  verdict is `met: false`, "Not evaluable: confirmatory arm <arm> not run".
  It never falls back to the best arm.
- Every MARS arm's comparison with `omp-stock`, and the best measured arm, are
  still reported under `secondary`, labelled "secondary (exploratory, not
  adjusted for multiple comparisons)", with Holm-adjusted p-values across all
  MARS-vs-omp-stock comparisons next to the raw p-values.
- `selectEditFormat` is unchanged: routing may still use the best measured
  arm. That is a product decision, not the confirmatory test.

### Amendment 2026-11-14 (before any live run): minimum suite size

The bar's statement is unchanged; what changed is the suite it is judged on.
The sign test is per task (repeats only decide each task's majority outcome),
so v1's 10 tasks could only detect a huge effect: even with every discordant
task favouring MARS, 6 of 10 tasks must be discordant to reach p < 0.05.
`packages/evaluation/scripts/edit-bench-power.ts` computes the exact power of
the two-sided sign test (exact binomial sums over discordant counts and MARS
wins, no normal approximation; `signTestPower` / `minimumPoweredTasks` in
`power.ts`). Its output (`bun packages/evaluation/scripts/edit-bench-power.ts`):

```text
Exact two-sided sign test over tasks, alpha 0.05, target power 0.8; minimum = smallest N with power >= target for N..N+10.
| MARS share of discordant tasks | Tasks discordant | Minimum tasks | Power at minimum | Power with 10 tasks |
| --- | --- | --- | --- | --- |
| 70/30 | 20% | 258 | 0.800 | 0.001 |
| 70/30 | 30% | 172 | 0.801 | 0.005 |
| 70/30 | 40% | 129 | 0.802 | 0.018 |
| 75/25 | 20% | 168 | 0.801 | 0.001 |
| 75/25 | 30% | 112 | 0.802 | 0.008 |
| 75/25 | 40% | 84 | 0.803 | 0.027 |
| 80/20 | 20% | 115 | 0.801 | 0.002 |
| 80/20 | 30% | 77 | 0.804 | 0.012 |
| 80/20 | 40% | 58 | 0.808 | 0.041 |

Pre-registered design point: 70/30 share, 40% discordant -> MIN_POWERED_TASKS = 129.
```

The "minimum" is the smallest N whose power stays at or above 0.8 for N..N+10
(exact-test power is not monotone in N). Design point: MARS wins 70% of
discordant tasks and 40% of tasks are discordant, so **129 tasks**
(`MIN_POWERED_TASKS`). Smaller effects need the larger suites in the table;
at 20-30% discordance v2 is underpowered and a "not met" there is weak
evidence against MARS.

Amended rules, in force from 2026-11-14:

- The live command defaults to the v2 suite (144 tasks, below).
- `judgeBar` computes the pre-registered verdict only when the suite has at
  least `MIN_POWERED_TASKS` tasks. Smaller suites (v1, custom suites, samples)
  still run, but the report and Markdown label them **EXPLORATORY (no
  verdict)**: `verdict.exploratory: true`, `met: false`, `significant: false`,
  with the per-arm metrics and paired comparison reported as usual.
- The default per-task token budget is 1,000,000 (was 200,000): the model
  bridge reserves each request's serialized bytes as tokens before dispatch,
  so multi-turn edits of 40-60 KB real source files ran out of budget at the
  old default even for the oracle model. Every arm gets the same budget.

### Arms (same tasks, model, seed and per-task budget)

- `mars:<format>` for every format in `MARS_EDIT_FORMATS` (`@mars/execution`),
  in default order:
  - `mars:hashline`: the runtime's anchored `mars_read` (`line:hash|text`
    rows, `offset`/`limit` paging) plus `mars_edit` (anchored replace /
    delete / insert ops; a stale anchor is rejected atomically with recovery
    anchors);
  - `mars:replace`: `mars_read` (paged with `offset`/`limit`) plus exact-text
    `mars_replace`;
  - `mars:apply_patch`: whole-file `mars_read` plus `mars_apply_patch`.

  The drivers in `arms.ts` only set the session's `editFormat`; the tools are
  the real runtime tools from `openRuntimeSession`, not reimplementations. A
  new format plugs in by adding it to `MARS_EDIT_FORMATS` and a
  `MarsEditFormatDriver`. MARS arms run with only `mars_*` tools (read + write
  approval, no execute) and workspace-confined file tools. A rejected edit
  that the model then retries counts as an edit-call failure; the trial is
  still solved if the final tree verifies.
- `omp-stock`: the same model through Oh My Pi's `createAgentSession` with its
  own built-in `read`, `edit`, `write`, `grep` and its default, model-resolved
  edit mode (`edit.mode` default `hashline`, with omp's per-model fallback to
  `replace`; recorded per trial as `edit_mode`). Tools that spawn processes or
  reach the network are excluded so both arms run without commands. The model
  is reached through the same MARS model bridge (budget ledger, seed); tool
  calls are re-emitted with one `toolcall_delta` because omp's streamed `edit`
  consumes argument text.
- Each trial runs in a fresh throwaway copy of the task tree; process-wide
  `fetch` is replaced by a refusing guard for the trial (refusals are counted),
  and only the injected model transport reaches the endpoint. Verification is
  on the host: the copy must equal the expected tree byte for byte.

Per arm the report records solve rate with Wilson 95% interval
(`wilsonInterval` from `@mars/skills`), edit-call failure rate, mean turns
(model requests), input/output tokens, cost and tokens per verified solve with
a seeded task-bootstrap 95% interval, and wall time; plus the confirmatory
paired comparison (the model's default-format MARS arm vs `omp-stock`:
both/neither/discordant tasks, exact sign test) and the secondary comparisons
of every MARS arm with raw and Holm-adjusted p-values.
The forwarded integer seed per (task, repeat) is `servingSeed` (PR #219) of a
job seed derived like the specialist comparison's; the suite is a
`mars.held-out-split/v1` and `--training-lineage` files are checked with
`findHeldOutLeakage` (refused as `heldout_leakage`).

Outputs under `--out`: `report.json` (`mars.edit-benchmark-report/v1`,
`report_sha256` over canonical JSON, HMAC `attestation` with a signing key),
`report.md`, `trials.jsonl` and raw journals under `transcripts/`.

### Task sets

**v2 (default; 144 tasks; derived 2026-11-14)**:
`packages/evaluation/fixtures/edit-benchmark/v2`, generated by
`packages/evaluation/scripts/build-edit-bench-v2.ts --sources DIR` from
unmodified source files of eight pinned, permissively licensed public
repositories (the script refuses a checkout whose `HEAD` differs from the
pinned commit). Licences are copied to `v2/licenses/`; `suite.json` lists
each source and every `task.json` records `provenance.source` (repository,
commit, licence, path), which the loader checks against the suite's sources.

| Source | Commit | Licence | Language |
| --- | --- | --- | --- |
| github.com/pallets/click | `e38188e9e205` | BSD-3-Clause | Python |
| github.com/psf/requests | `3c7baaa05ab4` | Apache-2.0 | Python |
| github.com/expressjs/express | `43fca52d28a4` | MIT | JavaScript |
| github.com/sindresorhus/ky | `3541888878c4` | MIT | TypeScript |
| github.com/spf13/cobra | `adbc8813901b` | Apache-2.0 | Go |
| github.com/BurntSushi/toml | `d733fc535e4a` | MIT | Go |
| github.com/BurntSushi/walkdir | `6fd031c82ba5` | MIT OR Unlicense | Rust |
| github.com/antirez/sds | `5347739b1581` | BSD-2-Clause | C |

(full commits in `suite.json`). Per source: 5 multi-site tasks (rename one
identifier at every whole-word occurrence in a file), 5 whitespace-sensitive
tasks (insert a comment line at the exact indentation of an indented block),
4 large-file tasks (change one string literal, or insert a line, deep inside a
file of roughly 1,000+ lines) and 4 repeated-similar-lines tasks (edit one of
several near-identical lines, identified by line number and content). Tests,
vendored code, examples and docs are excluded; selection is a deterministic
hash order. The code is real; the edits are mechanical instructions applied
to it, not upstream commits. Task ids are disjoint from v1 and the split is
checked with `findHeldOutLeakage` like v1. Public code is likely in base
models' pretraining data; the instructed edits (e.g. `_v2` renames, marker
comments) are not, but contamination of the surrounding code is certain.

Offline oracle run on v2 (scripted perfect model, `--profile oracle
--repeats 1`; simulated, not evidence about real models): `mars:hashline`
144/144, `mars:replace` 144/144, `mars:apply_patch` 139/144, `omp-stock`
143/144. The five `apply_patch` misses touch files over 50 KiB (`ky`
`source/core/Ky.ts`, `cobra` `command.go`): Oh My Pi middle-truncates every
tool result over 50 KiB (`truncateMiddle` in its agent session), and
`mars_apply_patch` sessions have no ranged `mars_read`, so even a perfect
model cannot see the lines to patch. The `omp-stock` miss is a scripted-model
limitation with hashline anchors after several edits.

**v1 (10 tasks; retained for offline regression tests, exploratory only)**:
`packages/evaluation/fixtures/edit-benchmark/v1`: ten tasks authored for this
benchmark on 2026-11-14 (not copied from public benchmarks, MARS datasets or
training lineages): multi-site edits (rename across two files, one constant in
JSON + Python), whitespace-sensitive files (tab-indented Python, Makefile
recipes, YAML, Markdown hard breaks), large files (~1.3k and ~800 lines, one
change deep inside) and repeated similar lines (identical guard blocks, Go
`if err != nil`). Each task has `task.json` (instruction, category,
provenance), `before/` and `after/`. Third-party base models' pretraining data
cannot be inspected, so contamination is unlikely but not provable.

### Commands

```sh
# CI / offline: scripted fake models, zero real model calls (v2 and all four arms by default)
bun apps/cli/src/main.ts bench edit-formats --offline --profile small-model --out /tmp/edit-bench

# Exploratory (no verdict): the 10-task v1 suite
bun apps/cli/src/main.ts bench edit-formats --offline --suite packages/evaluation/fixtures/edit-benchmark/v1 --out /tmp/edit-bench-v1

# Live (NOT run in this repository yet): refuses without --live, --model and --max-usd
bun apps/cli/src/main.ts bench edit-formats --live --model ollama/qwen3-coder \
  --max-usd 0 --repeats 3 --out ./edit-bench-qwen3 \
  --signing-key-env MARS_BENCH_KEY --signing-key-id local
```

The model comes from the MARS model registry (`~/.mars/models.json` or
`$MARS_HOME/models.json`: Ollama, OpenRouter free/cheap models, Kimi or any
OpenAI-compatible endpoint). The run is refused up front unless
`trials × --max-usd-per-task` (default `--max-usd / trials`) fits under
`--max-usd`; each trial's ledger enforces its own token/USD/time budget.

Offline profiles (`SCRIPTED_PROFILES`) emit each format deterministically from
the forwarded seed, with failure modes per format: malformed patches and wrong
whitespace (`apply_patch`), wrong whitespace and ambiguous matches
(`replace`), stale anchors (`hashline`). `patch-fluent` and `patch-hostile`
exercise both verdict directions, `recovering` fails every format's first
edit attempt per file and retries cleanly (stale-anchor recovery for
`mars_edit`); these reports are `simulated: true`. CI runs the scripted
profiles on v1 and one full v2 run (`patch-fluent`, `mars:apply_patch` vs
`omp-stock`, 288 trials) to exercise the powered verdict path.

### Baseline vs. specialist learning benchmark

Run a no-network smoke from a checkout containing the fixture's pinned history:

```sh
bun apps/cli/src/main.ts bench learning --offline --seed p2 --out "$HOME/mars-learning-dry-run"
```

The bundled manifest projects the affected source files from three historical
MARS fixes and their exact Git parents. Both arms use the same MARS agent,
file-only tools with the apply-patch format, and execution disabled. A
host-side check compares the entire projected tree to the fix byte for byte;
it does not run the historical test suite and can reject equivalent patches.
The scripted adapters see the answer by design. This smoke tests the pipeline,
not either model; the dollar amounts and latencies are synthetic.

For a live run, curate a private, representative suite of independent real
fixes excluded from training and validation before registering the specialist.
Use the [committed suite](../packages/evaluation/fixtures/learning-benchmark.json)
as the format example: supply a single-parent fix and its exact parent, a
clear request, a routing domain/complexity, and the relevant regular text
files (including any necessary context). Review the projection and make sure
the named fixes and their variants were not used for training. The loader
refuses duplicate fix commits, request digests, and changed-content pairs.
The suite guard checks train/validation IDs, normalized request digests and
dataset digests against the supplied lineage. It cannot detect paraphrased
overlaps or contamination in an upstream base model.

```sh
bun apps/cli/src/main.ts bench learning --print-suite-pin --repo /trusted/repo --suite held-out.json
sha256sum specialist-lineage.json
```

Create a plan with those two digests and the exact model IDs from your trusted
MARS model registry (use immutable served names for the base and specialist;
the harness does not attest remote server weights). The provider must support
tool calling and both configurations must match on provider, context/capability,
request timeout and output cap. Pin the harness revision, provider settings and
checkpoint version when sharing results. The operator is responsible for matching
the lineage to the served specialist. Only send approved projections to your provider.

```json
{
  "schema": "mars.learning-plan/v1",
  "suite_sha256": "REPLACE_WITH_SUITE_SHA256",
  "seed": "pre-registered-seed-1",
  "budget_per_task": { "max_tokens": 100000, "max_usd": 0.5, "max_duration_ms": 180000 },
  "max_total_usd": 160,
  "arms": {
    "baseline": { "model": "local/base-pinned" },
    "specialist": { "model": "local/specialist-pinned", "lineage_sha256": "REPLACE_WITH_LINEAGE_SHA256" }
  }
}
```

```sh
bun apps/cli/src/main.ts bench learning --live --repo /trusted/repo --suite held-out.json \
  --plan learning-plan.json --training-lineage specialist-lineage.json --out "$HOME/mars-learning-live"
```

Per-arm overrides are refused. Each pair shares a sampling seed (best effort
at the serving endpoint); task order and within-pair arm order are seeded.
The worst-case committed per-task dollar caps must fit under the plan's
total cap. The reports record Wilson 95% intervals, a paired lift interval,
provider exclusions, failures, metered cost per verified solve, and time to
verified patch. Private transcripts are under `transcripts/`. Provider
exclusions can bias the comparison; review their counts before interpreting
conditional solve rates.

The pre-registered power design uses the exact paired sign test at
two-sided alpha .05: 40% discordant pairs and 70% of discordances favoring
the specialist imply a 16-point lift and require at least 129 complete pairs
for 80% power. Plan more tasks if provider failures are expected. A small or
underpowered run is exploratory. Routing recommendations keep the base
model when evidence is inadequate, simulated, or not covered; a positive
signal means review, not promotion. No production routing is changed.

### Evidence-based per-model edit-format selection

`selectEditFormat` (`@mars/execution`) takes `mars.edit-format-evidence/v1`
records (from `editFormatEvidenceFromReport` on a verified report) and picks,
for the session's model on this repository, the newest report's format with
the best verified solve rate (ties: lower cost per verified solve in USD, then
tokens). Without such a report, or when no available format solved anything,
it falls back to the static default: the configured `default`, else omp's
per-model default for the selected model (`defaultEditFormat`: `replace` for
Kimi, DeepSeek, MiniMax and similar, otherwise `hashline`), else
`DEFAULT_MARS_EDIT_FORMAT` (`hashline`). All three MARS formats are
selectable. Simulated
reports never decide. The workbench (`WorkbenchHostOptions.editFormats`,
`mars serve --edit-format-evidence DIR [--edit-format-repository NAME]
[--edit-format-key-env NAME --edit-format-key-id ID]`) applies it on launch and
resume, passes `editFormat` to the runtime and records an
`operation: "edit_format"` task event with the decision and `report_sha256`,
like routing evidence. Delegated children use the static default.
