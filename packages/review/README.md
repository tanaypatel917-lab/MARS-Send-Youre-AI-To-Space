# @mars/review

The single proposal-only background review runner. It reads a completed foreground transcript plus frozen memory and skills, asks one model once, and submits bounded proposals to `@mars/memory` and `@mars/skills`. It never executes tools, never accepts proposals, never writes authoritative memory or skills, and never schedules itself. Ported from `mars-platform/services/review` (Hermes background-review safety semantics, OpenClaw experience-review scheduling); see `NOTICE`.

**Status: offline-verified only**, with an injected fake `ReviewModelGateway`. No review has run against a live model; `modelRequests` stays 0 in `bun run check` unless a test injects a fake.

## Integration

```ts
import { ReviewRunner, createRegistryReviewGateway } from "@mars/review";
const review = new ReviewRunner({
  context,                                   // exact RequestContext scope; proposals never widen it
  memory: { snapshot: memory.snapshot.bind(memory), submitProposal: memory.submitProposal.bind(memory) },
  skills,                                    // SkillProposalService: list, getRevision, submitProposal only
  model: createRegistryReviewGateway({ registry }), // free model via @mars/providers; throws if paid
  logRoot: join(privateStateDirectory, "review"),
  idleMs: 30_000, timeoutMs: 60_000,
});
review.beginLiveTurn(sessionId); /* foreground task runs */ review.endLiveTurn(sessionId);
review.recordTurn({ sessionId, origin: "foreground", iterations, transcript, success: true });
await review.stop();
```

Exports: `ReviewRunner`, `REVIEW_LIMITS`, `eligible`, `createRegistryReviewGateway`, `ReviewRateLimit`, `parseOutput`, `OUTPUT_LIMITS`, `InvalidOutput`, `SYSTEM_PROMPT`, and the `Turn`, `TurnOrigin`, `TranscriptMessage`, `ReviewDependencies`, `ReviewResult`, `ReviewModelGateway`, `ReviewModelRequest`, `ReviewModelReply`, `ReviewProposal`, `ReviewMemoryOperation`, `RegistryReviewGatewayOptions` types.

## API

- `recordTurn(turn)`: accumulate `iterations` per session; queue the session at ≥10 (`REVIEW_LIMITS.iterations_threshold`); `success: false` only resets the quiet timer. Ignored when the runner is stopped or the turn is ineligible.
- `beginLiveTurn(id)` / `endLiveTurn(id)`: foreground work defers scheduling and aborts the in-flight review (`cancelled`); the quiet timer restarts when the live turn ends.
- `reviewNow(turn)`: run one review immediately if eligible, no live turn, nothing in flight and not in cooldown; otherwise `skipped`.
- `stop()`: clear pending work and counters, abort and drain.
- `modelRequests`, `pendingSessions`: offline-test observability.
- `ReviewResult { reviewId, status: completed | rejected | cancelled | rate-limited | error | skipped, proposals: { store, id }[] }`.

## Invariants

- **Recursion guard.** `eligible(turn)` requires `origin === "foreground"` and a nonempty `sessionId` with no `review`, `background_review`, `cron`, `heartbeat`, `hook`, `subagent`, `acp`, `memory` or `overflow` segment and no `active-memory`, `incognito` or `internal:` substring. Proposals are attributed to `background_review:<sessionId>:<reviewId>`, which is itself ineligible.
- **Single flight, quiet period, backoff.** One review at a time; starts after `idleMs` quiet; a provider 429 (`ReviewRateLimit`, detected directly or inside `ModelRouter`'s exhausted `NoModelAvailableError` attempts) requeues the session and backs off 15 → 30 → 60 min (`backoff_initial_ms`, `backoff_max_ms`). Pending sessions ≤32, counters ≤1024, oldest evicted.
- **Bounded, labelled input.** Transcript messages must be `{ role: user | assistant | tool, content: string }`. The prompt is JSON with `untrusted_evidence: true`, ≤200 memory entries (`target`, `fact` only), ≤64 non-archived skills truncated to 4000 chars, and both store revisions; total ≤64,000 chars or the review is `rejected`.
- **Strict output.** The reply must have no tool calls, finish reason `stop` (or null) and ≤64,000 bytes. `parseOutput` accepts exactly `{"proposals":[...]}` with ≤8 proposals of `{ tool, rationale, ops }` and ≤8 ops each: `memory.submitProposal` ops are `{ op: "add", target: "memory" | "user", content ≤2200 }`; `skills.submitProposal` ops are `{ op: "create" | "update", name, content ≤8000 }`; rationale ≤1000; no extra keys; every string passes `scanThreat`. Anything else is `rejected`.
- **Scope and revision fencing.** Memory `target: "memory"` becomes a `project` entry in the exact review `context.scope`; `target: "user"` becomes a `profile` entry for `{ owner_id, project_id }`. Entry ids are `review:<reviewId>:<n>`, `source_event_ids` `review:<reviewId>`, and the request id is suffixed with the review id. Entry ids are `review:<reviewId>:<proposalIndex>:<opIndex>`, so several lessons from one review never collide. Memory and skill revisions are captured at snapshot time, re-checked before every `submitProposal`, and passed as `expected_revision` / `expectedRevision`; the memory owner rebases add-only proposals onto later writes, so all of a review's memory lessons can be accepted sequentially, while skill proposals stay revision-fenced.
- **All-or-nothing.** If a later submission fails after earlier ones succeeded, the runner withdraws (rejects) its own just-submitted proposals through the optional `memory.rejectProposal` / `skills.reject` hooks and logs `withdrawn`; the reported status and the proposal inbox never disagree. Without those hooks the remaining ids are logged.
- **Model access.** `createRegistryReviewGateway` selects via `selectExecutionModel(registry, model, false)` (no paid consent) and throws if the selected model is paid; completions go through `ModelRouter` with `temperature: 0`, the request's `maxTokens`, timeout and abort signal; 429 maps to `ReviewRateLimit`. No OpenAI-compatible endpoint configuration or `MARS_REVIEW_*` environment variables exist.
- **Audit log.** `<logRoot>/review.jsonl` (dir 0700, file 0600, appended under `withDirectoryLock`): `ts`, `actor: "@mars/review"`, `source: "background_review"`, `sessionId`, `reviewId`, `model`, `event` (`started`, `proposal`, final status), `transcriptHash`, `outputHash`, `proposals`, revisions, `cooldownUntil`. No transcript, prompt or model text is logged.
- **Dependencies are narrowed** in the constructor to `memory.snapshot`/`memory.submitProposal` and `skills.list`/`getRevision`/`submitProposal`; `context` is cloned. Handing the runner a full `MemoryService` or `SkillLifecycleService` is a host bug, not a capability.

## Limits

`REVIEW_LIMITS`: iterations 10, pending sessions 32, counters 1024, context 64,000 chars, memory entries 200, skills 64 × 4000 chars, max_tokens 1024, backoff 15–60 min. `OUTPUT_LIMITS`: proposals 8, ops 8, rationale 1000, memory content 2200, skill content 8000, output 64,000 bytes. Defaults: `idleMs` 30 s, `timeoutMs` 60 s.

## Not implemented

Live-model acceptance; host-side `review.jsonl` inspection or proposal accept/reject/undo commands; a `skip_background_review`-style flag on the execution session (eligibility is decided from `Turn.origin`/`sessionId` supplied by the host); Hermes `_digest_history` summarisation (the transcript is passed as supplied, bounded by size); multi-model or paid routing.

## Attribution

Safety semantics from `NousResearch/hermes-agent` `agent/background_review.py` at `7020ea3e96c3fdbc768c5296493e186df46f075b` (MIT); scheduling from `openclaw/openclaw` `src/skills/workshop/experience-review-scheduler.ts` at `7d9677ce36db4aeea2ce36a3bb78588829e80933` (MIT); license texts in `../memory/third_party/hermes-agent/LICENSE.txt` and `../skills/third_party/openclaw/LICENSE.txt`. MARS modifications listed in `NOTICE`.
