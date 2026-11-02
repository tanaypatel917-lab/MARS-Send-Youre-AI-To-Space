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
| Model configuration | `@mars/providers` registry (`~/.mars/models.json` or `$MARS_HOME/models.json`) | Includes the built-in `ollama` provider for local models. |

## Packages

- [`packages/evaluation`](../packages/evaluation/README.md) — Harbor adapter,
  `mars.evaluation-comparison/v1` manifests, result parsing, grader
  repeatability, regressions, trajectory artifacts, Harbor scoring backend,
  Python `mars_harbor_agent` custom agent.
- [`packages/optimization`](../packages/optimization/README.md) — bounded GEPA
  worker, train/validation/final-holdout splits, candidate lifecycle and
  proposal reports.

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

Verified in this increment (no model, no container):

```text
$ harbor dataset list --legacy        # terminal-bench 2.0 (89), terminal-bench-sample 2.0 (10)
$ harbor run -d terminal-bench-sample@2.0 -a nop --dry-run -o jobs --job-name dryrun-sample -y
Dry run OK — 10 trial(s); nothing was run.
```

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
| Any Terminal-Bench task with this model | **unverified** (not run) |

Interpretation: with `qwen3-coder:30b` through Ollama, the fixed MARS system
prompt in `packages/execution/src/runtime.ts` deterministically (temperature 0)
makes the model emit a malformed native XML tool call that Ollama's
OpenAI-compatible parser does not convert, so the runtime sees prose instead of
a tool call. Removing the `i` intent parameter or the `<system-reminder>`
preamble does not change this; removing the system prompt does. The system
prompt is precisely the explicit prompt target that `@mars/optimization`
treats as a proposal, so it was **not** changed here. A real-model comparison
on this machine therefore needs either an accepted prompt proposal or a
different local model; both remain unverified.

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

- A full baseline-vs-candidate Terminal-Bench 2 comparison with a real model.
- Grader repeatability on real TB2 containers beyond what the package README
  reports.
- A GEPA optimisation run with a real reflection model producing an improved
  validation score; a run that shows no improvement is an equally valid
  outcome and must be reported as such.
- Harbor separate-verifier (`no-network`) isolation on this VM
  ([`MILESTONE_0.md`](MILESTONE_0.md)).

Milestone 4 acceptance (spec section 16) is therefore **not claimed**.
