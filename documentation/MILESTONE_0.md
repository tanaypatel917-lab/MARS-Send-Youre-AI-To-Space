# Milestone 0: source and integration baseline

## Scope and verdict

The source/contract baseline and local SDK/native/journal probes are verified. This is an initial integration increment, **not completion of Foundation/Milestone 1** and not evidence that the full component set interoperates.

The unchanged master specification is authoritative. The manifest records its SHA-256 digest. Interfaces are initial version-1 contracts; only the task/event/budget/scope/artifact schemas currently perform runtime validation. Authentication, authorization, budgets, optimistic concurrency, deletion, holdout access, promotion, and compatibility policies are requirements for the service implementations—not features supplied by TypeScript interfaces.

## What works

- Bun workspace with exact direct dependencies and a committed transitive lockfile.
- Canonical scoped event envelope, task lifecycle/budget/artifact schemas, and intended task/execution/research/memory/skill/evaluation/optimization/dataset/training/registry service interfaces.
- Real Oh My Pi `createAgentSession` with isolated in-memory auth/settings/session state, no discovered extensions/context, no MCP/LSP, no tools, no cache warming, and no provider prompt.
- The installed platform native addon performs a real search in a temporary fixture.
- The upstream session manager writes a custom entry to disk, closes, reopens, and reads the entry. This is a journal capability probe, **not a complete task-resume or workspace-checkpoint test**.
- CLI `doctor` and `smoke`, offline manifest/lock checks, and optional remote source-content checks.

## Source audit interpretation

Five independent source audits inspected the 24 component boundaries in `sources/manifest.json`. Their original observed checks and unexecuted acceptance plans remain explicitly separated. The source register indexes exact commit/license/module URLs, integration owners, runtime needs, adaptation decisions, dependencies, and separately licensed portions. Hosted docs and directory links are labeled background references, not runtime pins.

Oh My Pi is the only installed component from the upstream audit: `@oh-my-pi/pi-coding-agent@18.14.0` and `@oh-my-pi/pi-natives@18.14.0`, plus their locked transitive dependencies. Zod supplies MARS contract validation. The two artifact integrities are pinned independently of source audit HEAD `5d30c790b883ad0ae05dac2a4d2ccc8ecd103611` and release-source candidate `31147f9d1a76608549821c3759f8487b4d66c72d`. Package/source equivalence is **not attested**. Installed behavior is tested directly instead.

No upstream code was modified. The probes test the installed artifact, not an upstream source build. No claim is made that all upstream tests passed.

## Evidence

- `documentation/evidence/source-verification.json`: remote GET checks and SHA-256 hashes for the manifest's unique immutable module/license URLs. No external code from these responses is executed.
- `documentation/evidence/local-checks.txt`: actual command, environment, exit-status and output evidence for this increment.
- `.github/workflows/checks.yml`: repeats the offline checks and SDK probes from a frozen, lifecycle-script-disabled install without provider credentials.

The tests cover valid transport round trips; malformed/missing scope, provenance, versions, hashes and budgets; terminal task transitions; missing/duplicate/conflicting source pins; installed/locked artifact identity; native SDK initialization; journal persistence/reopen; and CLI behavior.

## Unresolved gates (not suppressed)

| Area | Dependency / required evidence |
| --- | --- |
| Actual agent execution | Choose initial model/provider; supply scoped credentials only when needed. Demonstrate a real coding task and cost/usage evidence. No provider is assumed. |
| Permissions and isolation | Define and implement process/container boundary, approvals, cancellation, network policy, secret scoping and hard budget enforcement. Empty tool selection is not a sandbox. |
| IDE and tasks | VS Code client; authoritative event adapter; durable task record; restart/resume; file diffs; workspace checkpoints and tested restore. |
| Memory/skills | Separate Python >=3.11 environment for current Hermes; audited lockfile has a newer-Python constraint. Persist/concurrency/scoping/correction/deletion tests; one writer and one scheduler. |
| Prompt optimization | Audited DSPy pins GEPA 0.1.4; audited GEPA HEAD differs. Select a common exact dependency set or isolate direct GEPA in its own worker before integration. No upstream Harbor/GEPA adapter was found. |
| Evaluation | Harbor trials may report process exit 0 despite failed results: inspect result/error/reward records. Independent verifier/egress isolation and comparable mini-swe baseline remain untested in MARS. |
| Remote/browser workers | OpenHands interfaces do not establish OS isolation; Browser Use needs a controlled Chromium/CDP session and explicit action authorization. |
| GPU and models | No CUDA/GPU validation was available. Select licensed base model/tokenizer/datasets/hardware; run genuine SFT and held-out agent evaluation before claiming a specialist. |
| Serving/router | vLLM adapter/base identity must be checked by MARS; do not assume upstream rejects mismatched bases. Serving, fallback and rollback require integration tests. |
| Reward training | Current Agent Lightning v1 API and documented vLLM/verl versions require a compatible pinned environment. No RL job was executed. |
| Licensing | Do not redistribute model weights, benchmark datasets, Cline assets, DGM evaluation materials or optional native packages on the strength of a root code license alone. Preserve per-artifact notices. |

## Next acceptance gate

Milestone 1 is a usable coding workbench: one Oh My Pi session owner shared by CLI and IDE; persistent task/event records; bounded approved tools; artifacts/diffs; cancellation; a workspace checkpoint/restore; and restart/resume of a task. A restart test must use the durable task service—not just reopen the upstream journal fixture.

Later “improvement” claims require a recoverable baseline, independent task results, quality/cost/runtime/regression evidence, inaccessible final holdouts, and an explicit promotion/rollback decision. Saving a lesson or finishing a job is not improvement evidence.
