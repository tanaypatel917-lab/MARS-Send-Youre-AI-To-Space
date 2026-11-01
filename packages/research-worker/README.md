# @mars/research-worker

Production `ResearchWorker` for `@mars/research`: plan → search → guarded fetch → evidence capture → quote-verified extraction → contradiction check → evidence-backed findings. Modelled on dzhng/deep-research's breadth × depth loop with per-claim verification, budget/deadline enforcement from reported usage, SSRF/robots/rate-limit guards and deterministic replay.

See [documentation/RESEARCH_WORKER.md](../../documentation/RESEARCH_WORKER.md) for the architecture, configuration and workbench wiring. Verified offline only; `live: true` is opt-in and unverified until a human runs it.
