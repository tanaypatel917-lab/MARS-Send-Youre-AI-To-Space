# @mars/review

The single proposal-only background review runner (Milestone 3). It is a host-bound service, not an agent loop: it has no tools, cannot accept proposals, cannot write authoritative memory or skills, and cannot schedule itself. Ported from `mars-platform/services/review` (Hermes background-review safety semantics, OpenClaw experience-review scheduling; see `NOTICE`). Everything here is offline-verified only; no live-model review has been run.

## Ownership

- `ReviewRunner` receives only `MemoryProposalService.submitProposal` + `snapshot` from `@mars/memory`, and `SkillProposalService` (`list`, `getRevision`, `submitProposal`) from `@mars/skills`. Hand it nothing else. `DurableMemoryStore` and `SkillStore` remain the only writers; humans/hosts call `acceptProposal`/`accept` or `rejectProposal`/`reject`.
- Model calls go through `ReviewModelGateway`. `createRegistryReviewGateway({ registry })` routes through the shared `@mars/providers` `ModelRouter` using `@mars/execution` `selectExecutionModel` (free-first; it refuses to construct if the selected model is paid). No endpoint, API key or `MARS_REVIEW_*` environment configuration exists in this repo. Offline tests inject a fake gateway; `runner.modelRequests` reports the count.
- Oh My Pi stays the only live session/tool/model owner: the runner never opens sessions and the host is what schedules it.

## Scheduling

`recordTurn(turn)` accumulates `iterations` per foreground `sessionId`; at 10 the session becomes pending (≤32 pending, oldest evicted; ≤1024 counters). `beginLiveTurn(id)` defers scheduling and aborts an in-flight review; `endLiveTurn(id)` restarts the quiet period (`idleMs`, default 30 s). One review runs at a time, bounded by `timeoutMs` (default 60 s). `ReviewRateLimit` backs off 15 min, doubling to 60 min, keeping the session pending. `stop()` clears pending work, aborts and drains.

Recursion guard (`eligible`): only `origin: "foreground"` turns with a non-empty session ID that does not match `review|background_review|cron|heartbeat|hook|subagent|acp|memory|overflow`, `active-memory`, `incognito` or `internal:` are ever reviewed. A completed review enqueues nothing. Failed turns (`success: false`) only reset the quiet timer.

## Review flow

1. Validate the transcript shape; snapshot memory (`snapshot(context)`) and skills (`getRevision`, `list`, re-check revision).
2. Render transcript + up to 200 facts + up to 64 non-archived skills (4,000 chars each) as one JSON blob flagged `untrusted_evidence: true`; reject if over 64,000 chars.
3. One model call (`maxTokens` 1024, temperature 0). Replies with tool calls, non-`stop` finish reasons or >64,000 chars are rejected.
4. `parseOutput` (`output.ts`): root exactly `{"proposals":[...]}`, ≤8 proposals, each `{tool, rationale(≤1000), ops(1–8)}`. `memory.submitProposal` ops are `{op:"add", target:"memory"|"user", content(≤2200)}` → scoped `project`/`profile` `MemoryEntry` adds; `skills.submitProposal` ops are `{op:"create"|"update", name, content(≤8000)}`. Every string is threat-scanned. Anything else is `rejected`.
5. Before each submission, re-check both revisions (`error` on drift). Memory proposals carry `expected_revision`; skill proposals carry `expectedRevision` and `reviewId`, so `undoReview(reviewId)` can reverse an accepted review.
6. `review.jsonl` under `logRoot` (0600, directory-locked) records timestamps, session/review IDs, gateway ID, transcript and output SHA-256 hashes, proposal IDs and revisions — never transcript or model text.

Result statuses: `completed`, `rejected` (schema/threat/store validation), `cancelled`, `rate-limited`, `error`, `skipped`.

## Not implemented / unverified

Live-model acceptance, automatic acceptance of any proposal, memory `patch`/`remove` proposals, and multi-scope review (one `RequestContext` per runner).
