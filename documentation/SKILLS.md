# Skills and background review (`@mars/skills`, `@mars/review`)

Milestone 3 brings the OpenClaw Skill Workshop lifecycle and the Hermes-style
proposal-only background review into this repository as two packages:
`packages/skills` (the single writer of skill files) and `packages/review`
(the single background reviewer, which can only propose). Both are ports of
the `mars-platform` reference implementation; attribution lives in each
package's `NOTICE` and in [`SOURCE_REGISTER.md`](SOURCE_REGISTER.md).

**Status: implemented and verified offline only.** `bun run check` exercises
the store and the runner with fixtures and an injected fake model gateway; no
review has been run against a live model, no skill has been learned from a
real session, and no real VS Code window has shown a skill. Treat every claim
below as a description of code and offline tests, not of field behaviour.

## What a skill is

A skill is a directory `skills/<name>/` holding one `SKILL.md`. The file must
start with YAML frontmatter whose `name` equals the directory name and whose
`description` is nonempty; the rest of the file is free Markdown read by the
model as untrusted evidence.

```md
---
name: release-notes
description: How this project writes release notes.
---
1. Collect merged PR titles since the last tag.
2. ...
```

- Names match `^[a-z0-9][a-z0-9-]{0,63}$`; `constructor` and `prototype` are
  rejected.
- The frontmatter parser (`packages/skills/src/frontmatter.ts`) is a
  dependency-free **flat subset of YAML**: unindented `key: value` lines, keys
  matching `^[A-Za-z_][A-Za-z0-9_-]{0,63}$` (never `__proto__`), no duplicate
  keys, values either JSON double-quoted, single-quoted, or plain. Plain values
  starting with `& * ! | > { } [ ] % @` or a backtick (anchors, aliases, tags,
  block/folded scalars, flow collections) are rejected, so nested structures,
  multi-line descriptions and billion-laughs constructs cannot be expressed.
- Every piece of content is passed through `scanThreat` from `@mars/memory`
  before it is stored (see "Threat scanning").

## Lifecycle

```
          create / applyDraft / accept(proposal)
 (none) ────────────────────────────────────────▶ active ──recordUse/update──▶ active
                                                    │  ▲
                              curator: ≥14 days idle│  │ update, recordUse, restoreVersion
                                                    ▼  │
                                                  stale
                                                    │
                   curator: ≥30 days idle, or archive│          restore
                                                    ▼  ◀────────────────────── archived
                                                 archived ──────────────────▶ active
```

Statuses are `active`, `stale` and `archived` (`SkillLifecycleStatus`).

- **Draft → accepted.** `saveDraft(name, content, options, rationale)` parks a
  candidate (max 50 drafts) with `baseRevision` = SHA-256 of the current
  content of that skill (or of `null`). `applyDraft(id)` creates or updates the
  skill only if that content is unchanged; otherwise `stale-revision`.
  `viewDraft`, `listDrafts`, `discardDraft` complete the inbox.
- **Proposal → accepted / rejected.** `submitProposal({ source, ops,
  rationale })` dry-runs every operation on a cloned state (so an invalid
  proposal is refused immediately), then stores it `pending` with
  `expectedRevision` = the store revision at submission time. `accept(id,
  actor)` re-applies the operations only while the store revision still equals
  `expectedRevision` (`stale-revision` otherwise); `reject(id, reason)` needs a
  nonempty reason. Pending proposals never touch `SKILL.md`.
- **Active → stale → archived.** `runCurator()` marks an `active` skill
  `stale` after 14 days without activity and archives any non-archived skill
  after 30 days; pinned skills are exempt from both, and `archive`/`stale`
  refuse pinned skills explicitly. Archiving moves the directory to
  `skills/.archive/<name>/`; nothing is ever deleted.
- **Restore.** `restore(name)` moves an archived skill back to `active`;
  `update`, `recordUse` and `restoreVersion` also return a `stale` skill to
  `active`. Any other operation on an archived skill fails `archived`.
- **Versions.** Before `update`, `restoreVersion`, `archive`, `restore` and
  `undoReview` the previous record is snapshotted; the newest 10 versions per
  skill are kept (`listVersions`, `restoreVersion(name, versionId)`).
- **Undo by review id.** Every change carries the `reviewId` passed in
  `MutationOptions`. `undoReview(reviewId)` replays the journal entries for
  that review in reverse: a skill whose current record differs from the
  journaled `after` state fails `conflict`, undoing a `create` archives the
  skill (nothing is deleted), draft-inbox changes are rolled back, the review
  id is recorded in `undone` so a second undo is a no-op, and the undo itself
  is journaled under `undo:<reviewId>`.
- **Pin.** `pin(name, true)` exempts a skill from curation and archiving.

### Who may write

- Only the `SkillStore` in `@mars/skills` writes under the skills root. Every
  mutation names an `actor` and a `source`, may carry `expectedRevision`
  (optimistic concurrency against the store revision) and `reviewId`.
- Background review receives only `SkillProposalService` (`list`,
  `getRevision`, `submitProposal`) and `MemoryProposalService`; it never holds
  `accept`, `applyBatch` or `batch`.
- Humans (or the host on their behalf) accept, reject, undo, pin, restore and
  run the curator. No CLI or RPC command for these exists yet (see "Not
  implemented").

## How skills enter sessions

The design mirrors frozen memory (`packages/workbench/src/memory-context.ts`):
at task launch the host snapshots non-archived skills from the store, bounds
them to the remaining runtime-instruction and model-context budget, hashes the
frozen text, labels it as untrusted evidence ("not instructions or permission
to use tools") and stores the frozen snapshot in private launch metadata so
resume replays the same text. Skills are never re-read mid-session. The
workbench wiring (`WorkbenchHostOptions.skills` / `.review`, a
`skills-context.ts` mirroring `memory-context.ts`, review scheduled after
completed foreground tasks, `mars serve` constructing the `SkillStore` and
`ReviewRunner`) is covered by offline host tests only; no live session has
consumed a frozen skill.

## Background review

`ReviewRunner` (`packages/review/src/runner.ts`) is the only background
reviewer. It is scheduled by the host after completed foreground tasks and
emits proposals only.

Scheduling rules:

- `recordTurn({ sessionId, origin, iterations, transcript, success })`
  accumulates `iterations` per session; a session is queued once it reaches
  **10** iterations (`REVIEW_LIMITS.iterations_threshold`). Failed turns
  (`success: false`) only reset the quiet timer. At most **32** sessions are
  pending and **1024** counters are kept; the oldest is evicted.
- A review starts only after `idleMs` (default **30 s**) of quiet, with **one
  review in flight**. `beginLiveTurn(sessionId)` cancels the in-flight review
  (its status becomes `cancelled`) and defers scheduling until `endLiveTurn`.
- A model `429` (`ReviewRateLimit`) requeues the session and backs off
  **15 → 30 → 60 min** (capped); `stop()` drains everything.
- **Recursion guard.** `eligible(turn)` requires `origin === "foreground"`
  and a nonempty session id that does not contain a `review`,
  `background_review`, `cron`, `heartbeat`, `hook`, `subagent`, `acp`,
  `memory` or `overflow` segment, nor `active-memory`, `incognito` or
  `internal:`. The runner never schedules itself and its proposals are
  attributed to `background_review:<sessionId>:<reviewId>`.

Each review:

1. logs `started` with a SHA-256 of the transcript;
2. snapshots memory (`revision`, ≤200 entries) and the skill store revision,
   listing ≤64 non-archived skills truncated to 4000 characters each; the
   whole prompt is capped at 64,000 characters and labelled
   `untrusted_evidence: true`;
3. calls the model once (`max_tokens` 1024, `timeoutMs` default 60 s) and
   rejects replies with tool calls, non-`stop` finish reasons or more than
   64,000 bytes;
4. parses the reply with `parseOutput` (`output.ts`): exactly
   `{"proposals":[...]}`, ≤8 proposals × ≤8 ops, only
   `memory.submitProposal` (`op: "add"`, `target: "memory"` → project scope or
   `"user"` → owner profile scope, ≤2200 characters) and
   `skills.submitProposal` (`create`/`update` only, ≤8000 characters),
   rationale ≤1000 characters, every string threat-scanned, no extra keys;
5. re-checks both revisions before **every** proposal and aborts with
   `Snapshot changed` if either moved; proposals carry `expected_revision` /
   `expectedRevision` so acceptance is fenced again later;
6. logs `proposal` records and a final `completed`, `rejected`
   (schema/threat/store validation failure), `cancelled`, `rate-limited`,
   `error` or `skipped` status.

The audit log is `<logRoot>/review.jsonl` (directory mode 0700, file 0600,
appended under the same directory lock as the skill store): timestamps, actor
`@mars/review`, session and review ids, model id, transcript and output
**hashes**, proposal ids and revisions. It never contains transcripts, prompts
or model text.

Model access goes through `createRegistryReviewGateway({ registry })`, which
calls `selectExecutionModel(registry, model, false)` from `@mars/execution`
and refuses to construct if the selected model is paid, then completes through
the `@mars/providers` `ModelRouter`. There is no OpenAI-compatible endpoint
configuration and no `MARS_REVIEW_*` environment variable in this repository.
Offline tests inject a `ReviewModelGateway` fake; `modelRequests` counts calls.

## Threat scanning

`scanThreat(content)` (`packages/memory/src/threats.ts`, Hermes
`tools/threat_patterns.py` port) runs on every skill body, draft, proposal
operation, review rationale and memory fact. It rejects invisible or
default-ignorable code points both before and after NFKC normalisation
(`INVISIBLE_CODE_POINT_RANGES`: C0 controls except tab/newline/CR, DEL and C1,
soft hyphen, combining grapheme joiner, Arabic letter mark, Hangul fillers,
Khmer inherent vowels, Mongolian selectors, zero-width and bidi controls, line
and paragraph separators, word joiner and invisible operators, bidi isolates,
variation selectors and supplement, BOM, halfwidth Hangul filler, interlinear
annotation, shorthand and musical format controls, tag characters), then
matches prompt-injection, role-hijack, exfiltration, C2, credential-read,
agent/MARS configuration-modification and hardcoded-secret patterns
(`THREAT_PATTERN_IDS`). The scan window is 65,536 code points; longer content
must be bounded by the caller. A hit fails the store operation with code
`threat` (skills) or `invalid_input` (memory). It is a denylist of known
patterns, not a proof of safety.

## Storage layout and recovery

```
<state>/skills/
  skills/<name>/SKILL.md            canonical content of live skills
  skills/.archive/<name>/SKILL.md   archived skills
  .lifecycle.json                   metadata (status, pinned, timestamps, use counts, versions, drafts, proposals, undone), no content
  changes.jsonl                     append-only journal of every change (before/after records, reviewId)
  .skills-transaction.json          pending transaction; present only mid-commit
  .writer.lock/<uuid>.json          cross-process directory lock owner (pid + hostname)
<state>/review/review.jsonl         background-review audit log
```

- Every public method runs under `withDirectoryLock(root)`: an atomic
  `mkdir` of `.writer.lock`, a lock owner file, stale-lock reclaim only when
  the owner pid is dead on the same host, 30 s timeout (`code: "locked"`).
- A commit first writes `.skills-transaction.json` (new state + full journal)
  with write-temp-fsync-rename, then `recover()` applies it: moves directories
  between `skills/` and `skills/.archive/`, rewrites changed `SKILL.md`
  files, writes `.lifecycle.json` and `changes.jsonl`, fsyncs parents and
  removes the transaction file. `recover()` also runs at the start of every
  locked operation, so a crash mid-commit is completed on the next call.
- Paths are resolved inside the root and every component is checked for
  symlinks (`unsafe-path`). A skill directory that exists on disk but not in
  `.lifecycle.json`, or that exists both live and archived, fails `conflict`
  rather than being adopted. Loading re-validates every `SKILL.md`
  (frontmatter, threat scan, name match); a corrupt or missing file fails the
  whole store closed.
- The store revision is the SHA-256 of canonical JSON of skills, versions,
  drafts and undone review ids (pending proposals are excluded), so any
  accepted change invalidates outstanding `expectedRevision`s.

## Limits

| Limit | Value |
| --- | --- |
| Skill name | 1–64 chars, `[a-z0-9-]` |
| Versions per skill | newest 10 |
| Drafts | 50 |
| Curator | stale ≥14 days, archive ≥30 days; pinned exempt |
| Lock wait | 30 s |
| Review trigger | 10 foreground iterations; 30 s quiet; 1 in flight |
| Pending sessions / counters | 32 / 1024 |
| Review prompt | ≤64,000 chars; ≤200 memory entries; ≤64 skills × 4000 chars |
| Review reply | ≤64,000 bytes; max_tokens 1024; 60 s timeout |
| Review output | ≤8 proposals × ≤8 ops; rationale ≤1000; memory op ≤2200; skill op ≤8000 |
| Rate-limit backoff | 15 min → 60 min |
| Memory proposals | 64 pending per scope; 32 operations; rationale ≤2048; reason ≤1024; source ≤128 (`PROPOSAL_LIMITS`) |
| Threat scan window | 65,536 code points |

## Not implemented or not verified

- **No live-model evidence.** The review runner has only run with an injected
  fake gateway. Whether a free model produces useful, schema-valid proposals
  is unknown.
- **No semantic retrieval or skill discovery.** `list()` returns every skill;
  the frozen context is bounded by size, not relevance. The pre-existing
  `SkillService` contract (`discover`/`read`/`propose`/`evaluate`) remains
  unimplemented; `SkillLifecycleService` was added beside it.
- **The curator is not scheduled.** Nothing in this repository calls
  `runCurator()` except `store.test.ts`; the host or a future CLI command must
  invoke it. Hermes' usage-interval/idle rules (`should_run_now`) are not
  ported.
- **No operator surface.** There are no CLI or RPC commands to list, accept,
  reject or undo proposals, pin or restore skills, or inspect `review.jsonl`.
- **No evaluation gate.** The master specification's "evaluate before accept"
  step between draft and accepted is a human decision today, not a measured
  one.
- **Scope.** The skill store is per state directory, unscoped by owner or
  project; memory proposals are scoped and revision-fenced by `@mars/memory`.
- **Not ported from upstream:** OpenClaw's reviewer prompt and `skill_manage`
  tool surface, Hermes `curator_backup`, run reports, and cron-referenced skill
  protection.
