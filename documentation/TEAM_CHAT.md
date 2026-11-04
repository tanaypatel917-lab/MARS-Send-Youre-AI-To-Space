# Team Chat

Human-to-human messaging for a MARS team, with task links and result shares
(PR 6, chat half) and @MARS answers arriving in a later PR. This document records the architecture
split, who owns what, and what exists today. Contract discovery that led here:
the Team Chat discovery report (sections 4–6); where the owner's implementation
plan and the report disagreed, the report's repo-specific adaptation was
followed (tenant is `team_id`, never "workspace"; no second agent loop; the
same RPC envelope as the workbench).

## Architecture split

```
VS Code extension host (apps/vscode)      ──HTTP loopback, team bearer token──▶  Team service (@mars/team)
   │ renderer never talks to the network                                        │ identity (Authenticator), conversations,
   │ (CSP connect-src 'none'); PR 1 inbox is fixture-fed                         │ participants, messages, outbox, idempotency
   │                                                                             │ SQLite in the repo store pattern
   └──HTTP loopback, workbench token──▶  Local workbench (@mars/workbench)        │ no model calls, no Git, no tools
                                          tasks, workspaces, Oh My Pi sessions   ▼
                                                                          future: @MARS requests are *queued* here and
                                                                          executed by a workbench session (PR 5)
```

| Responsibility | Owner | Notes |
| --- | --- | --- |
| Who the caller is (`user_id`) | `Authenticator` in `@mars/team` | Derived from the bearer token on every request; never accepted from the client. Only `createDevAuthenticator` exists; the real provider (GitHub OAuth / OIDC / MARS accounts) is an owner decision. |
| Team membership, conversations, participants, messages, read cursors, pins, delivery outbox | `@mars/team` store (`team.sqlite`) | Postgres-portable schema; first forward-only migration ledger in the repo (private to this store). |
| Tasks, workspaces, artifacts, evidence | `@mars/workbench` / `@mars/tasks` | Team Chat stores only the workbench's ids (PR 6), never copies of task state. |
| Model execution | Oh My Pi via `@mars/execution` | The team service never calls a model. |
| Agent-to-agent rooms | `@mars/collaboration` | Different thing; its idempotency / seq / delivery patterns were copied, not extended. |
| Team token on the client | VS Code `SecretStorage` (own key, VS Code wiring PR) | Never the workbench token, never in `ViewState`. |
| Repo registration (`repo_id` → directory) and repo access (`repos`, `repo_access` tables) | Host administers both: `createRepoRegistry().register` (`@mars/code-refs`) and `store.setRepo` / `setRepoAccess` / `revokeRepoAccess` (`@mars/team`) | No RPC grants access in the pilot. The team store never holds a path; `repo_id` is opaque. |
| Reading committed Git objects | `@mars/code-refs` | Argv-only `git`, pinned commit, bounded output; **no authorization in the package**. |
| Who may see a reference | `@mars/team` (`references.*`, message chips) | Re-checks team membership, conversation visibility and `repo_access` inside each call; renders `restricted` otherwise. |

## RPC (`POST /v1/rpc`, loopback only)

Envelope, limits, auth handling and error vocabulary are the workbench's
(`packages/workbench/src/server.ts`): `{method, context, params}` →
`{result}` | `{error: {code, message}}`, fixed messages, 512 KiB request /
4 MiB response, `Origin` rejected, non-loopback `Host` rejected. The context is
`TeamContextSchema = {schema_version: 1, team_id, request_id}`.

| Method | Params | Guarantees |
| --- | --- | --- |
| `team.describe` | `{}` | Caller's `team_id`, `user_id`, role, limits, capabilities (`stream`/`reactions`/`search` are `true` since PR 3). |
| `conversations.create_dm` | `{peer_user_id}` | One DM per pair per team: `UNIQUE(team_id, dm_key) WHERE kind='dm'` plus an immediate transaction; concurrent creators receive the same conversation. |
| `conversations.create_group` | `{member_ids ≤ 32, title ≤ 200}` | Creator included; every member must be an active team member. |
| `conversations.list` / `conversations.open` | `{}` / `{conversation_id}` | Only active participation; returns the conversation, the caller's participant row and member summaries (`user_id`, `state`, `joined_seq`). `list` items add `unread_count` (messages after the caller's `read_seq`, excluding the caller's own) and `last_message_at` (newest message the caller may see, else `null`). |
| `conversations.add_member` / `remove_member` | `{conversation_id, user_id, expected_revision}` | Groups only; `conflict` on revision mismatch; removal is effective in the same transaction and closes the removed user's open streams on that conversation before the call answers. A re-added member gets a new `joined_seq`. |
| `conversations.leave` | `{conversation_id}` | Self-removal from a DM or a group (no `expected_revision`); the answer shows the caller's participant `removed`; emits a `membership` event; idempotent by `request_id`. DM re-entry stays `create_dm`, group re-entry stays `add_member`. |
| `conversations.mark_read` | `{conversation_id, read_seq}` | Monotonic; `read_seq` ≤ the conversation's `last_seq` (always ≥ `joined_seq`, so it is also the unread floor). |
| `conversations.pin` | `{conversation_id, pinned}` | Per participant. |
| `messages.send` | `{conversation_id, client_message_id ≤ 128, body ≤ 16 KiB, reply_to?, reference_ids? ≤ 16}` | `UNIQUE(conversation_id, author_id, client_message_id)`; same key + same `body_sha256` + same `reference_ids` → the original message; different body or references → `conflict`. Message, `message_references` rows and outbox row commit together. `reply_to` must be a message the author may see in the same conversation. Every `reference_id` must exist in the team and the sender must have `active` access to its repo at send time, else `not_found`. Returns a `MessageView` (the message plus per-viewer `references` chips). |
| `messages.history` | `{conversation_id, after_seq? \| before_seq?, limit ≤ 200}` | Membership re-checked inside the read transaction; page cut by count and serialized bytes, never skipping (a single oversized message → `too_large`); a participant sees only `seq > joined_seq`. Each message carries `references` chips rendered for the caller (see "Code references"). Each item is the stored record plus `reactions: [{emoji, count, reacted}]` (sorted by key; no user lists) and, for replies, `reply_excerpt` (first 200 UTF-16 units of the target, never splitting a surrogate pair) or `null` with `reply_restricted: true` when the target is before the caller's `joined_seq`. |
| `events.poll` | `{cursors: [{conversation_id, after_event_seq}] ≤ 50, limit ≤ 1000}` | Membership-filtered outbox; events carry `{conversation_id, event_seq, kind, message_seq, message_id, revision}` only — never a body. `kind` is `message`, `membership` or `reaction`. Cursors are per conversation. |
| `reactions.set` | `{message_id, emoji ≤ 32, on}` | Idempotent set/remove of the caller's reaction on a message they may see (`seq > joined_seq`; otherwise `not_found`). The key is validated with the invisible-code-point denylist from `packages/memory/src/threats.ts` (so no zero-width or variation-selector smuggling; `❤` is valid, `❤\ufe0f` is not) and must contain no whitespace. A change emits one outbox row `kind: "reaction"` with the message's `seq`/`message_id`; a no-op emits nothing. Returns `{message_id, emoji, count, reacted}`. Distinct keys per message are bounded (`max_reactions_per_message` → `too_large`). |
| `messages.search` | `{query 2..200, conversation_id?, limit ≤ 50, cursor?}` | Membership is applied in SQL before any body is read: `JOIN participants … state='active' AND m.seq > p.joined_seq` on the caller's team, optional conversation filter (a conversation the caller is not in → `not_found`). Case-insensitive (ASCII, SQLite `LIKE` semantics; `%`, `_`, `\` are literal) substring match, newest first (`created_at DESC, message_id DESC`), ≤ 200-UTF-16-unit excerpt around the first hit (whole code points only) with `cut_before`/`cut_after`, opaque `next_cursor` bound to (caller, query, filter) — a reused or altered cursor is `invalid_request`. Rate-limited per (team, user) in a sliding minute (`max_search_per_minute` → `unavailable`). |
| `repos.list` | `{}` | Repos of the caller's team the caller has `active` access to: `{team_id, repo_id, label, revision}`. Never a path. |
| `references.create` | `{repo_id, commit_sha (40 hex), path, line_start?, line_end?}` | Sender must be an active team member with access to `repo_id` (else `not_found`); locator validated with `validateLocator`; the object is resolved once through the host registry. `ok` (stores `blob_sha256` = SHA-256 of the excerpt), `binary` and `oversized` objects are stored; `unavailable` → `not_found`; directory / symlink / submodule / out-of-range → `invalid_request`; registry or git failure → `unavailable`. `reference_id = referenceDigest(locator)` so an identical reference dedupes per team. |
| `references.resolve` | `{reference_id}` | The reference must be attached to a message the caller can see (active participant, `seq > joined_seq`), else `not_found`. With repo access: `{state: ok, reference_id, repo_id, commit_sha, path, line_start, line_end, text, total_lines, truncated}` re-read from the pinned commit/blob (branch moves and renames do not change it), or the same locator fields with a non-`ok` state. Without repo access: exactly `{state: "restricted"}`. Rate limited per user (`max_resolves_per_minute`, excess → `unavailable`). |
| `references.search_paths` | `{repo_id, commit_sha, query ≤ 256, limit ≤ 50}` | Repo access required (else `not_found`); delegates to `searchPaths`; returns `{state: ok, matches: [{path, rank}], truncated}` or `{state: unavailable}`. Repo-relative paths only. |

Not implemented (TODO markers in `packages/team/src/protocol.ts`): `events.stream`
(SSE), `reactions.set`, `messages.search` (PR 3); @MARS requests, task links
and result shares (PR 5–6; their schemas are reserved in
`packages/contracts/src/team.ts`); any VS Code wiring (the reference picker and
preview panel are a later UI task).

## Code references (PR 4, service half)

**Reference model.** A reference is an immutable committed Git locator,
`GitRangeReferenceSchema` in `packages/contracts/src/team.ts` (the single
schema; `@mars/code-refs` re-exports it): `{kind: "git_range", reference_id,
team_id, repo_id, commit_sha, path, line_start | null, line_end | null,
blob_sha256 | null}`. `reference_id` is `referenceDigest` over the locator, so
the same locator is one row per team (`code_references`, keyed
`(team_id, reference_id)`, canonical JSON + `record_sha256` like messages).
Ledger order is `0001_initial` → `0002_task_links` (PR 6) → `0003_references`
(this PR); the tables land in `0003_references`.
`blob_sha256` is the SHA-256 of the excerpt resolved at creation (`text_sha256`
of the `ok` resolution) and null for `binary`/`oversized`; `resolved_state` and
`created_by` are stored beside the record. A message lists its references in
`reference_ids` (author order, part of the hashed record) and in
`message_references` rows. Branch movement, force pushes and renames never
alter a reference: everything is re-read at the pinned commit by blob id.

**Repo access model.** `repos (team_id, repo_id, label, revision)` and
`repo_access (team_id, repo_id, user_id, state active|removed, revision)`,
host-administered through `store.setRepo`, `store.setRepoAccess` and
`store.revokeRepoAccess`. `repo_id` is the opaque id the host also registered
in the `@mars/code-refs` registry (`createRepoRegistry().register({repo_id,
dir, label})`); the directory lives only in the registry, never in the team
store or in any response. Access means: active team member AND the repo is
registered for the team AND the `repo_access` row is `active`. It is re-read
on every call (`store.hasRepoAccess`); nothing is cached, so revoking access
restricts the very next read, including the revoking user's own earlier
messages and idempotent replays of their earlier sends.

**Access matrix** (`u1`: access to A and B; `u2`: A only; `u3`: team member
outside the conversation; stranger: valid token, not a team member):

| Surface | u1 | u2 | u3 | stranger |
| --- | --- | --- | --- | --- |
| `repos.list` | A, B | A | `[]` | `forbidden` |
| `references.create` on B | reference | `not_found` | `not_found` | `forbidden` |
| `messages.send` with a B reference | message | `not_found` (no row written) | `not_found` | `forbidden` |
| `messages.history` chip for A | `{reference_id, restricted: false, repo_id, commit_sha, path, line_start, line_end}` | same | `not_found` | `forbidden` |
| `messages.history` chip for B | resolved chip | `{reference_id, restricted: true}` — nothing else | `not_found` | `forbidden` |
| `references.resolve` on B | preview from the pinned commit | `{state: "restricted"}` — nothing else | `not_found` | `forbidden` |
| `references.search_paths` on B | matches | `not_found` | `not_found` | `forbidden` |
| `events.poll` | `{cursors: [{conversation_id, after_event_seq}] ≤ 50, limit ≤ 1000}` | Membership-filtered outbox; events carry `{conversation_id, event_seq, kind, message_seq, message_id, revision}` only — never a body. `kind` is `message`, `membership` or `reaction`. Cursors are per conversation. |
| `reactions.set` | `{message_id, emoji ≤ 32, on}` | Idempotent set/remove of the caller's reaction on a message they may see (`seq > joined_seq`; otherwise `not_found`). The key is validated with the invisible-code-point denylist from `packages/memory/src/threats.ts` (so no zero-width or variation-selector smuggling; `❤` is valid, `❤\ufe0f` is not) and must contain no whitespace. A change emits one outbox row `kind: "reaction"` with the message's `seq`/`message_id`; a no-op emits nothing. Returns `{message_id, emoji, count, reacted}`. Distinct keys per message are bounded (`max_reactions_per_message` → `too_large`). |
| `messages.search` | `{query 2..200, conversation_id?, limit ≤ 50, cursor?}` | Membership is applied in SQL before any body is read: `JOIN participants … state='active' AND m.seq > p.joined_seq` on the caller's team, optional conversation filter (a conversation the caller is not in → `not_found`). Case-insensitive (ASCII, SQLite `LIKE` semantics; `%`, `_`, `\` are literal) substring match, newest first (`created_at DESC, message_id DESC`), ≤ 200-UTF-16-unit excerpt around the first hit (whole code points only) with `cut_before`/`cut_after`, opaque `next_cursor` bound to (caller, query, filter) — a reused or altered cursor is `invalid_request`. Rate-limited per (team, user) in a sliding minute (`max_search_per_minute` → `unavailable`). |

**Restricted representation.** A conversation member without repo access gets
exactly `{reference_id, restricted: true}` in a chip and exactly
`{state: "restricted"}` from `references.resolve`: no path, repo label, SHA,
range, size, excerpt or resolver state. Absent and inaccessible repos and
references share `not_found`, the same choice as conversations. The server's
`validateResult` re-checks every chip, preview, repo row and search hit against
the store after the handler ran (restricted shapes have no extra keys, every
exposed `repo_id` is one the caller has access to, every path is
repo-relative), so a handler bug still fails closed. Fixed error strings only;
no response or error ever carries a directory, a repo label of a restricted
repo, or a message body.

**Same gate everywhere.** `messages.send` and `messages.history` chips,
`references.resolve` and `references.search_paths` all go through
`store.hasRepoAccess` / `store.viewReference`. `events.*` carry no reference
fields at all. Not on `main` yet, but bound to the same gate when they land:
`messages.search` (PR 3) must render hits through the chip projection and must
never index or match the path/SHA of a reference the searcher cannot see;
reply excerpts and @MARS/result-card payloads (PR 5–6) render references the
same way. The VS Code picker and preview panel call `references.search_paths`
and `references.resolve`; no client ever calls `git`.

**Limits** (`TeamLimitsSchema`): `max_references_per_message` (≤ 16),
`max_resolves_per_minute` (default 120, per user, in-memory sliding window),
`max_preview_lines` and `max_preview_blob_bytes` (the `@mars/code-refs`
defaults, 400 lines / 1 MiB, passed to the resolver as `max_range_lines` /
`max_blob_bytes`), `max_search_hits` (≤ 50).

**Host wiring.** `serveTeam({store, authenticator, repos})` takes the
registry; without it `references.*` answer `unavailable` and
`team.describe.capabilities.references` is `false`. A `mars serve`
`--team-repo <repo_id>=<dir>` option and a doctor row are not written yet.

| `tasks.link_draft` | `{conversation_id, message_ids 1–50, reference_ids ≤ 16}` | Requester must be a participant and every message visible to them (`seq > joined_seq`). Creates a `TaskLink` (`status: draft`, server-generated `launch_key`, provenance `{message_id, seq, body_sha256}` frozen now) and returns bounded excerpts (≤ 280 chars each) for the confirmation step. Idempotent on `request_id`. |
| `tasks.link_confirm` | `{link_id, workbench: {scope, task_id, request_id}, target: {repo_id?, base_revision?}}` | Requester only (`forbidden` for other members, `not_found` for non-participants). `draft → confirmed`. A retry with the same binding returns the same link (same `launch_key`); a different binding → `conflict`. |
| `tasks.link_created` | `{link_id, task_revision}` | Requester only. `confirmed → created`; a `shared` link keeps `shared` while recording a newer revision; the revision may only move forward (`conflict` otherwise). |
| `tasks.link_inspect` | `{link_id}` | Participants who can read every quoted message (`provenance[*].seq > joined_seq`); a member who joined or rejoined later gets `not_found`, like history. The requester gets `{view: "requester", link}`; everyone else `{view: "member", link}` with `launch_key`, `target` and `workbench` **omitted** (never another user's scope ids). |
| `shares.preview` | `{link_id, evidence: <caller's tasks.evidence result>, run_status, selection: {summary ≤ 2000, include_diff_digest, verify_event_ids ≤ 8, artifacts?}}` | Requester only; link must be `created`/`shared`. Returns `{preview_sha256, card}` — exactly what `shares.create` would post. `artifacts` non-empty → `unavailable` (artifact access gate is a later PR). |
| `shares.create` | `{link_id, preview_sha256, ...same}` | Recomputes the card; `preview_sha256` must match byte-for-byte (`conflict` otherwise). Posts a message `kind: "result_card"` whose `body` is the summary and whose `payload` is the `ResultShare` (returned as a `MessageView`, like `messages.send`); link becomes `shared`. A card that would not fit one `messages.history` page (with its stale overlay) is refused with `too_large`. Idempotent on `request_id`; the replay re-reads the stale overlay so it agrees with history. |

Not implemented (TODO markers in `packages/team/src/protocol.ts`): `events.stream`
(SSE), `reactions.set`, `messages.search` (PR 3); references and @MARS
requests (PR 4–5; their schemas are reserved in
`packages/contracts/src/team.ts`); artifact shares (artifact access gate);
any VS Code wiring.

## Task handoff (PR 6, chat half)

The team service never opens a workbench connection. The desktop client (today
the VS Code extension host) talks to both with the user's own credentials and
carries only ids between them:

```
   client (user's desktop)                 team service (@mars/team)          workbench (user's own)
   ───────────────────────                 ─────────────────────────          ──────────────────────
1. select messages ─────── tasks.link_draft ─────────────▶ TaskLink{draft, launch_key,
                                                             provenance frozen} + excerpts
2. user confirms ───────── tasks.link_confirm ───────────▶ TaskLink{confirmed, workbench ids,
      {scope, task_id, request_id, target}                   target}
3. ─────────────────────────────────────────────────────────────── tasks.create ────────────▶ task
      {launch_key, provenance:{source:"team_chat", ...}}     (same key + same task → replay)
4. ─────────────────────── tasks.link_created ───────────▶ TaskLink{created, task_revision}
   ... the task runs in the workbench; chat sees nothing until the user shares ...
5. ──────────────────────────────────────────────────────────────── tasks.evidence ─────────▶ {task_revision,
                                                                                               workspace, diff_sha256,
                                                                                               verify_records}
6. ─────────────────────── shares.preview {evidence, run_status, selection} ─▶ {preview_sha256, card}
7. user reviews card ───── shares.create {preview_sha256, ...} ──────────────▶ message kind:"result_card"
```

| Owns | Team service | Workbench |
| --- | --- | --- |
| Conversation provenance (`message_id`, `seq`, `body_sha256`), `launch_key`, link status, who requested | ✔ | reads `provenance` as opaque input |
| Task state, workspace, diff, verification evidence | stores the ids/digests the requester submitted | ✔ |
| Result card content and its `preview_sha256`, `attested_by`, stale overlay | ✔ | — |

Rules the implementation keeps:

- **Frozen provenance.** `provenance` is written once at draft time from the
  stored `seq` and `body_sha256`; a later edit or deletion (no RPC exists yet;
  the test mutates the row directly) never changes it. A new draft after an
  edit gets a new link and the new hash.
- **One launch per link.** The `launch_key` is minted by the service
  (`tc-<sha256(team_id, link_id)[0:48]>`, unique per team) and returned on
  every replay, so an interrupted confirm — same `request_id` or a fresh one
  with the same workbench binding — never creates a second link, and the
  workbench's launch-key rule makes `tasks.create` retries land on one task.
- **Verification is copied, never judged.** `verified: true` only when a
  selected `verify_records` entry has `verified: true`, `stale: false`, and
  the same `diff_sha256`/`workspace_revision` as the evidence head; anything
  else yields `verified: false` with `verified_reason` ∈ `missing | stale |
  failed | inconclusive | skipped` (first match in that order across the
  selected records). The contract refuses `verified: true` on a non-`pass`
  record. `run_status`, `verified`, `export_status` (`not_exported` until the
  artifact gate) and `git_status` (`unknown`: the service cannot observe git)
  are four separate fields and are never merged into one badge.
- **Attested, not verified by the service.** The card records
  `attested_by: requester_id` and `evidence_sha256` (canonical digest of the
  submitted `tasks.evidence` result). `SharedEvidenceSchema` in
  `packages/contracts/src/team.ts` mirrors the workbench's
  `EvidenceResultSchema` (parity test in `packages/team/src/handoff.test.ts`).
- **Stale on re-share.** Every share binds the candidate `diff_sha256` (even
  when `include_diff_digest: false` hides it from the card). A later share of
  the same link with a different digest makes earlier cards read back from
  `messages.history` with `stale: true` and `superseded_by: <message_id>`;
  the posted content is immutable (`card_json` + `record_sha256`).
- **Nothing leaks across members.** Result cards carry no workbench `scope`,
  `task_id` or `launch_key`; other members' `tasks.link_inspect` view omits
  those keys; non-participants get `not_found` for links and cards alike;
  outbox rows stay metadata-only.

Follow-ups the workbench contract needs (not edited here): `tasks.evidence`
does not return the task's execution status, so the client passes
`run_status` from `tasks.inspect` alongside the evidence (the card therefore
attests two reads, not one); an artifact access gate before `ArtifactRef`
shares; the client wiring in `apps/vscode` (PR 1's webview is fixture-only).

Not implemented: @MARS requests (PR 5; schema reserved in
`packages/contracts/src/team.ts`); any VS Code wiring (the inbox client of the stream lives in the extension host and
is a separate task after the PR 1 prototype).

## Streaming (`POST /v1/stream`, Server-Sent Events)

The second and only other route. It passes exactly the checks of `/v1/rpc`
(loopback `Host`, no `Origin`, bearer token, `application/json`, 512 KiB
body) and takes the same envelope with `method: "events.stream"` and
`params: {cursors: [{conversation_id, after_event_seq}]}` (1..50 cursors,
distinct conversations). `GET` is `not_found`; sending `events.stream` to
`/v1/rpc` is `invalid_request`. Every rejection is the usual JSON error before
any stream byte; an accepted request answers `200 text/event-stream` with
`Cache-Control: no-store`.

Frames:

```
: connected                         ← comment on open; ": heartbeat" every stream_heartbeat_ms
id: <event_seq>
event: message | membership | reaction
data: {"conversation_id","event_seq","kind","message_seq","message_id","revision"}

event: close                         ← only when the server ends the stream on purpose
data: {"reason":"membership"|"not_found"|"unavailable"|"internal_error"}
```

`data` is the outbox row — generic metadata only, never a body, title or
display name; the client fetches what it may see through `messages.history`.
`id:` is the per-conversation `event_seq` (informational; the resume protocol
is the cursor list, not `Last-Event-ID`, because the request is a `POST`).

Backfill → live. Live delivery is "wake and re-poll": the connection is
registered for store notices *before* its first poll, a committed write only
marks the conversation dirty, and the stream re-runs the same
membership-filtered query as `events.poll` from its own cursors in pages of
`max_stream_batch_events`. One query produces both the backfill and the live
frames, so the switch can neither skip nor repeat an event (tested under
concurrent sends with 4-row pages). The per-connection fan-out state is a set of
dirty conversation ids (≤ 50), never a queue of events. Each heartbeat also
re-polls every cursor, which catches writes from another process (the store is
multi-process safe; notices are in-process) and re-verifies membership.

Reconnect. The client keeps the last `event_seq` per conversation and resumes
with those as `after_event_seq`. A cursor above the conversation's
`last_event_seq`, negative, or duplicated is `invalid_request` (the workbench's
`unknown_cursor` mapping); a conversation the caller cannot see is `not_found`
and refuses the whole stream. Every cursor is authorized and bounds-checked
before any row is read (in `events.poll` too), so a full first page cannot hide
an invalid later cursor. `events.poll` with the same cursors is the
fallback when a stream cannot be held open.

Revocation. `remove_member`, `conversations.leave` and host-side
`removeTeamMember` deliver a post-commit `removed` notice and the server closes
every open stream of that user on that conversation synchronously — the
`event: close` frame with `reason: "membership"` is written before the removing
call returns. Reconnecting, polling, reading history or searching that
conversation is then `not_found` (or `forbidden` after a team removal). Nothing
of the removed user remains server-side except their own authored rows and the
`removed` participant row that records the join window.

Backpressure. The response body is pull-driven: frames wait in the stream's
own byte-bounded queue until the HTTP sink asks for them. A consumer that stops
reading and falls more than `max_stream_buffer_bytes` behind receives only
`event: close {"reason":"unavailable"}` and is disconnected; it resumes from
its cursors. Nothing is queued per connection beyond that bound plus one
backfill page.

Limits (`TeamLimitsSchema`): `max_open_streams_per_user` (default 4; the next
connection is `too_large`), `stream_heartbeat_ms` (15 000), `max_stream_batch_events`
(200, capped by `max_poll_events`), `max_stream_buffer_bytes` (1 MiB →
`unavailable` close), `max_search_per_minute` (60 → `unavailable`),
`max_reactions_per_message` (64 → `too_large`).

## Decisions recorded

- **`not_found` for "absent" and "not yours".** Every conversation-scoped read
  and write answers `not_found` whether the conversation does not exist, is in
  another team, or the caller is not (or no longer) an active participant, so
  existence never leaks. `forbidden` is reserved for team-level denial (valid
  token, but `context.team_id` is not one of the caller's teams or the member
  row is missing/removed), mirroring the workbench's scope mismatch.
- **Idempotency** is keyed `(team_id, user_id, request_id, operation,
  input_sha256)` like `packages/tasks`: equal input replays the stored result,
  a reused `request_id` with other input is `conflict`. Rows are bounded per
  user (`max_pending_idempotency_rows`, oldest pruned). `client_message_id` is
  the durable key for sends and survives pruning.
- **Migration ledger.** `TEAM_MIGRATIONS` is an ordered list applied inside one
  immediate transaction; ids and positions are verified against the ledger, and
  a ledger from newer or diverged code is rejected (`corrupt_record`). The five
  older stores are untouched.
- **Re-entry is self-initiated.** A participant marked `removed` by a team
  departure re-enters a DM only through their own `conversations.create_dm`
  (new `joined_seq`, nothing from the absence is visible); the peer's call never
  restores someone else's access. Group re-entry is `add_member` by a member.
- **Dev authenticator only.** Tokens are hashed at construction and compared as
  SHA-256 digests in constant time; plain tokens are never retained.
- **Team administration is host-side** (`store.setTeamMember` /
  `removeTeamMember`); no RPC can change team membership in PR 2. Removing a
  team member removes them from every conversation of that team.
- **Streams re-poll instead of pushing (PR 3).** A store notice never carries
  an event; it wakes the stream, which re-reads through the membership-filtered
  outbox query from its cursors. This is what makes backfill and live delivery
  one code path and bounds per-connection state. Notices are delivered after
  commit, in commit order, inside the writing call, so a removal closes the
  stream before the remover's RPC answers.
- **Search is `LIKE`, not FTS5.** `bun:sqlite` in Bun 1.4.4 does ship FTS5
  (checked), but FTS5 is token-based (no substring hits), needs shadow tables
  and triggers, and would make results depend on the SQLite build; a `LIKE`
  with an escaped pattern is deterministic, Postgres-portable (`ILIKE`) and
  adequate for a pilot. Case folding is ASCII-only (SQLite `LIKE` without ICU);
  the excerpt uses the same folding so the highlighted hit matches the SQL hit.
- **Rate limits and stream counts are per process.** The search window and the
  open-stream count live in the serving process (the pilot runs one); the
  store itself stays multi-process safe and streams converge through the
  heartbeat re-poll.
- **Reaction keys follow the memory denylist literally**, including U+FE0F
  (variation selector 16). Clients that render emoji with VS16 must strip it
  before calling `reactions.set` (and will see the stripped key in summaries).
  Whether to strip server-side instead is an owner call.
- **Repo administration is host-side too** (`store.setRepo` / `setRepoAccess`
  / `revokeRepoAccess`, plus the `@mars/code-refs` registry); no RPC grants
  repo access in the pilot. Repo and reference reads answer `not_found` for
  "absent" and "no access" alike; a member of the conversation who lacks repo
  access gets the `restricted` shape instead, because the message itself is
  theirs to see.
- **Rate-limit code.** The RPC vocabulary is frozen to the workbench's eight
  codes, so an exceeded `references.resolve` budget answers `unavailable`
  (503), the same code a failing host registry answers.

## Assumptions (owner defaults)

Pilot deployment is a loopback Bun process with a SQLite store whose schema is
Postgres-portable; identity is the pluggable `Authenticator` with a local dev
provider only; the Git provider reads committed objects through a host-trusted
repo mapping with argv-only `git` (`@mars/code-refs`, wired in PR 4); @MARS
models are free-first only, no paid.

## Verification

Offline only: `bun test packages/team` runs through the real loopback server
with the dev authenticator and a second Bun process for the DM race;
`packages/team/src/features.test.ts` opens real SSE connections (interrupted
acknowledgement + reconnect, backfill/live race with 4-row pages, nonmember
denial, same-call revocation, idempotent reactions, join-window search
filtering, stream/search limits); `handoff.test.ts` covers link draft/confirm/created with interrupted confirms,
frozen provenance, every unverified reason, stale-on-re-share, member/non-member
visibility and `preview_sha256` mismatch with fixture evidence only; the
reference tests (`packages/team/src/references.test.ts`) build two temporary
`git init` repositories and prove the access matrix above, pinning across a
branch move and rename, immediate revocation, the rate limit and that no
response to a restricted viewer contains a directory, the restricted repo's
label, path or SHA (skipped with a warning when `git` is absent). No live
identity provider, no remote host, no workbench process, no VS Code window, no
real multi-GiB repo.


---

# Team Chat — PR 1: desktop prototype and contract discovery

Status: **fixture prototype, feature-flagged, offline only.** Nothing in this PR talks to a network, stores anything durably or authenticates anyone (the `@mars/team` service above landed separately in #60 and is not yet wired to this view). It exists so the owner can see the first team workflow (DM, small group, replies, reactions, pins, unread state, cross-repo code chips, exact-revision preview) in the existing UI harness before any backend is chosen.

Reviewed `main`: `2ce2ddc6a6c4fa1c4f6f714cba4091916dc5f0d9` (merge of #54, after #53 and #55). The plan's baseline commit `06d3f1f` is the OmniRoute #55 merge; every path below was read at `2ce2ddc`. `documentation/UI_PROMPT.md` is **not** on `main` (branch `devin/1793672868-ui-prompt` only) and is not relied on here.

## 1. Where the prototype lives and why

There is no MARS desktop client in this repository (HANDOFF: "Build the MARS Shell desktop — no code anywhere"). The only UI harness is the VS Code extension `apps/vscode`, so the prototype is a **second webview view** in the same MARS activity-bar container:

- `mars.teamChat` view, declared with `"when": "config.mars.teamChat.enabled"`, provider registered only when the flag is on (`apps/vscode/src/extension.ts`, `TeamChatViewProvider`). Flag `mars.teamChat.enabled` defaults to **off**; with it off the manifest, activation and `scripts/node-smoke.cjs` expectations are unchanged except for the always-registered command `mars.teamChat.open` (which, when the flag is off, only shows a message explaining how to enable the view).
- A separate view rather than a mode inside `mars.workbench` because the workbench view is a per-server task console with its own connection state machine; Team Chat has a different data owner (a team service, later) and must stay usable without a task server. Sharing a container keeps navigation in one place; sharing a controller would couple the prototype to `WorkbenchController` and to `mars serve`.
- Same safety model as the workbench webview: `buildWebviewHtml` CSP (`default-src 'none'`, nonce script, `connect-src 'none'`, no frames/forms/command URIs), DOM built with `textContent` through `webview/dom.ts`, no `innerHTML`, strict Zod message schema (`apps/vscode/src/teamChat/messages.ts`) validated in `TeamChatController.handleMessage`; anything else is dropped. Nothing runs because a chip exists: opening a reference is a click that the host resolves against the fixture.
- All data lives in the extension host (`@mars/team-chat` fixture); the webview receives view state only. Bundled as `dist/team-chat.js` with `media/team-chat.css`.

## 2. Integration points found at `2ce2ddc`

| Area | What exists | Team Chat use |
| --- | --- | --- |
| UI surface | One `WebviewView` (`mars.workbench`), `apps/vscode/src/extension.ts`; renderer `src/webview/main.ts` rebuilt by `render()`; helpers `src/webview/dom.ts` | Second view, same helpers, same CSP (`src/html.ts`, now with an optional title) |
| IPC validation | `WebviewMessageSchema` (strict discriminated union) → `WorkbenchController.handleMessage` `safeParse`; `HostMessage` carries `ViewState` only | `TeamChatWebviewMessageSchema` / `TeamChatHostMessage` with the same discipline; viewer identity is never a request field |
| RPC + scope | `POST /v1/rpc` with `{method, context:{schema_version, scope, request_id}, params}`; `ScopeSchema {owner_id, project_id, workspace_id?}` (`packages/contracts`); frozen method list in `documentation/WORKBENCH_RPC.md`; fixed error vocabulary in `packages/workbench/src/protocol.ts`; client `HttpRpcTransport` + `MarsClient` | PR 2 copies the envelope and error codes for a **separate** team endpoint; the workbench RPC does not grow chat methods. `scope.workspace_id` is a workbench private copy, so the plan's tenant is `team_id` in code |
| Credentials | Per-`mars serve` bearer token in `connection.json` (0600), imported to `SecretStorage` key `mars.serverToken`; never posted to the webview; `endpoint.ts` loopback/HTTPS rule | A team token gets its own `SecretStorage` key, its own endpoint rule, host-side only. The workbench token is a process capability, not an identity |
| Identity / Git identity | None. `owner_id` is a free string (`"local"`), no users table in any store, no OAuth/OIDC, `.git` excluded from workspace copies, the workbench never runs `git`, no commit SHA in any contract | Gap (§4) |
| Task creation | webview `createTask` → `buildPendingTask` (`taskFactory.ts`, revision 0, fresh uuids) → `tasks.create` with a fresh `request_id` per call → store idempotency on `(request_id, task_id, canonical task)` | A retry after a lost ack creates a second task today; PR 6 must persist a launch record first ("stable launch key" is a gap) |
| Artifact lookup | `tasks.artifact` → `ownedArtifact` → `assertPublicBytes`; client re-verifies `ArtifactRef {sha256, byte_length, media_type}`; `tasks.diff` has no digest | Result cards (PR 6) can carry `ArtifactRef`; a patch digest must be added |
| Host verification | `@mars/watch` (`WatchEvidenceRecordSchema`, `VerificationContractInputSchema`), `verified: true` only for `verify` + `pass` + verifiable assurance; **not** in `packages/contracts` | PR 6 badge = one evidence record bound to task revision + workspace revision + diff digest |
| Agent rooms | `packages/collaboration`: task-scoped, TTL'd, capability-token agent messaging with `UNIQUE(room_id, seq)` and `UNIQUE(room_id, sender_id, idempotency_key)` + digest compare | Patterns reused (server sequence, idempotent send with digest compare, cursor paging); rooms are **not** extended into human chat |

## 3. Adapted contracts (what this PR defines)

`packages/team-chat/src/schemas.ts` (`@mars/team-chat`), strict Zod, snake_case, bounded strings, `TEAM_CHAT_SCHEMA_VERSION = 1`:

| Plan record | Schema | Notes |
| --- | --- | --- |
| Workspace and membership | `TeamSchema {team_id, name}`, `MembershipSchema {team_id, user_id, role: owner\|admin\|member, state: active\|invited\|removed}` | `team_id`, never `workspace_id`; roles govern administration only, repo access is a separate grant (`RepoAccessSchema`) |
| Conversation and participant | `ConversationSchema {conversation_id, team_id, kind: dm\|group, title, canonical_pair, created_at}`, `ParticipantSchema {conversation_id, user_id, pinned, read_cursor, joined_at_sequence}` | `canonicalPair(a, b)` = sorted ids joined with `\|`, required for DMs and forbidden for groups (refined) |
| Message and reaction | `MessageSchema {message_id, conversation_id, author_id, sequence, client_message_id, body ≤ 4000, reply_to, created_at}`, `ReactionSchema {message_id, user_id, emoji}` | Server sequence dense per conversation; `client_message_id` unique per author and conversation; one emoji set |
| Reference and share | `ReferenceSchema {reference_id, kind: file\|range\|symbol, repo_id, commit_sha (40 hex), path (normalized repo-relative), line_start/line_end, symbol, access_scope {team_id, repo_id}}`, `ShareSchema {message_id, reference_id}` | `isNormalizedRepoPath` rejects absolute, drive, backslash, NUL, empty/`.`/`..` segments; ranges need both ends and `start ≤ end` |
| Operations | `SendMessageInputSchema {conversation_id, client_message_id, body, reply_to, references: ReferenceInput[] ≤ 8}`; `TeamResult<T> = {ok, value} \| {ok:false, code}` with `TeamErrorCodeSchema` | No `user_id` in any input: the host supplies the viewer |

`FixtureTeamService` (`src/service.ts`) implements the plan's operations in memory: membership-filtered `listConversations`/`openConversation` (a team member outside a conversation gets `not_found`; existence is never revealed), opaque history cursor with pages in sequence order, `sendMessage` (atomic message + references + shares; same `client_message_id` + same content → the original `{message_id, sequence, duplicate: true}`; same id + different content → `client_message_id_reused`; reply target must be visible in the same conversation; a reference is attachable only if the sender can read that repo and the blob exists at that exact SHA), monotonic `markRead` to an accessible sequence, `setPinned` per requester, idempotent `setReaction(on)`, `resolveReference` (share must exist on a message the viewer can read; no repo access → `restricted` with no path/SHA/excerpt; missing blob → `unavailable`), `mentionIndex` filtered to the viewer's repos. Tests: `src/service.test.ts`, `src/composer.test.ts` (28 tests).

Pure UI logic in `src/composer.ts` and `src/mentions.ts`: `reduceComposer` (text/caret, `@` trigger, picker move/select/close, reply context, chips capped at 8), `keyIntent` (Enter sends, Shift+Enter newline, picker owns arrows/Enter/Tab/Escape, IME composition ignored), `buildSend`, `mentionCandidates` (`path`, `path:start-end`, symbol; active repo first, then the other repos the viewer can read), `chipLabel` (repo · path:range @ short SHA).

## 4. Gaps (identity, realtime, repo access) — carried into PR 2–PR 6

- **Identity:** nothing in the repo models a person. The prototype's "Viewing as" switcher is a fixture affordance (`fixtureSwitchViewer`) and is removed in PR 2; a real viewer comes from a server-derived user id, never from the client.
- **Realtime:** the only delivery mechanism is `tasks.events` polling via `EventPoller`; the webview cannot open connections (`connect-src 'none'`), so any stream lives in the extension host. The prototype has no delivery events at all.
- **Repo access / references:** no Git provider integration, no commit SHA anywhere, repos are identified locally by `project_id` (path hash) and `workspaceLabel` (folder name). The fixture's `repo_id → blob at SHA` mapping stands in for a provider-backed trusted repo table and a per-viewer permission check (PR 4). A local folder path or repo name is never an access identifier; the fixture labels show "(fixture)" to make this visible.
- **Stable launch key / verified badge:** `tasks.create` is idempotent only on an identical `(request_id, task_id, canonical task)` triple and the client mints fresh ids; `tasks.diff` has no digest. Both are PR 6 additions.
- **No durable store, no migrations:** the existing stores reject unknown `format_version`; PR 2 introduces the first migration ledger inside the team store only.

## 5. Data-ownership rules kept by this design

- The team service (fixture today) can never run commands on a desktop, receive ambient checkout contents, or grant workbench permissions. The prototype has no path to `tasks.*`, `WorkspaceHost` or any provider.
- The renderer never talks to a service: it posts validated intents to the extension host and receives view state. Tokens (none yet) stay in `SecretStorage`.
- References are committed Git objects: trusted `repo_id` + full 40-hex SHA + normalized path + optional range. A sender's access never authorizes a viewer; every chip and preview is resolved per viewer and fails closed (`restricted`).
- A local folder path or repo name is never an access identifier.
- Logs: the prototype logs nothing; failure reasons shown in the UI are fixed strings that contain no message body, path or code.

## 6. What is fixture-only

- `FIXTURE` dataset (`packages/team-chat/src/fixture.ts`): one team, three users (Ada owner, Grace, Linus), two fixture repos (`repo_fixture_platform` @ `3f2c9a1e…`, `repo_fixture_site` @ `a1b2c3d4…`) with four blobs and symbol tables, DM Ada↔Grace (pinned by Ada, reply, reactions, Ada's read cursor at #2 so #3–#4 are unread), group "Release triage" (one message with chips from both repos, a reply with a third chip), and a DM Grace↔Linus that Ada must never see. Linus has access to the platform repo only, so the site chip is `Restricted reference` for him.
- Invented SHAs, blob text, times and names; `FIXTURE` badge in the inbox header, "(fixture)" in repo names, "Team Chat (fixture)" as the view name.
- The viewer switcher, the simulated send delay (`sendDelayMs`) and the 3-message page size (`pageSize`, so "Load older messages" is visible) are prototype knobs in `TeamChatController`.
- Screenshots are produced by `apps/vscode/scripts/team-chat-harness.ts` (stub `acquireVsCodeApi` over an in-page `TeamChatController`, headless Chrome under the same CSP). It is a development aid, not part of `bun run check`.

## 7. UI behaviour implemented

Three panes at ≥ 900 px (conversations | messages + composer | code panel, opened only by a chip click), code panel as a bottom drawer below 900 px. Enter sends, Shift+Enter newline; `@` opens the mention picker with keyboard selection (↑/↓, Enter/Tab, Escape) over files, symbols and `path:start-end` ranges from both repos; explicit reply context with a clear button; reaction toggles (`aria-pressed`); unread divider at the first unread sequence when the conversation was opened (stays while reading; the read cursor advances to the latest message only once the first unread message is actually loaded, so unread history on older pages is never marked read unseen) plus "Jump to latest"; an overlength draft (> 4000 characters) is kept with an inline error instead of being sent or discarded; pending ("Sending…") and failed sends with Retry (idempotent) and Discard; scroll position preserved across "Load older messages"; focus returns to the originating chip when the code panel closes; chips show repo · path:range @ short SHA and open the fixture blob at that revision with the stored range highlighted and scrolled into view; the inbox remembers the last conversation via `vscode.setState`.

## 8. Smallest next change (PR 3 wiring; the PR 2 service already landed) — done in §9

`@mars/team` (`packages/team`: SQLite store, loopback RPC server, `createDevAuthenticator`, `conversations.*` / `messages.*` methods documented at the top of this file) merged in #60, so the service no longer needs to be built. The smallest next change is the adapter: implement `TeamService` (this PR's client-facing interface in `@mars/team-chat`) over `@mars/team`'s RPC — `listConversations` → `conversations.list`, `openConversation` → `conversations.open` + `messages.history {before_seq, limit}` (map `older_cursor` to `before_seq`), `sendMessage` → `messages.send` (replay → `duplicate: true`, `conflict` → `client_message_id_reused`), `markRead` → `conversations.mark_read`, `setPinned` → `conversations.pin` — using `HttpRpcTransport` with a separate team endpoint and `SecretStorage` key in the extension host, and let `TeamChatController` choose it instead of `FixtureTeamService` behind the same `mars.teamChat.enabled` flag (fixture stays the default until identity is decided). Reactions, references and the viewer switcher stay fixture-only until `reactions.set` (PR 3) and `@mars/code-refs`-backed resolution (PR 4) are wired; port `service.test.ts` as the adapter's acceptance tests against a loopback `@mars/team` server.

## 9. PR 3, client half: the VS Code inbox over `@mars/team`

Where it lives: `apps/vscode/src/teamChat/{protocol,client,service,realtime}.ts`
plus the async `TeamChatController`; `packages/team-chat` keeps the shared
operation shapes (`TeamService` is now `MaybePromise`-returning, carries a
`label` of `FIXTURE` | `SERVICE`, `capabilities {reactions, search, realtime}`
and `searchMessages`). `mars.teamChat.source` selects fixture (default) or
service; the fixture path is unchanged and still labelled.

Extension host only. `TeamClient` sits on `HttpRpcTransport<TeamRpcMethod,
TeamContext>` (the transport gained two type parameters, nothing else) with
its own `rpcUrl` (`mars.teamServerUrl`, default `http://127.0.0.1:7332`,
validated by `checkServerUrl` with the team-specific
`mars.teamChat.allowNonLoopbackServer`) and `getToken` reading the
`mars.teamToken` SecretStorage key. Every result is validated against the
contracts schemas (`ConversationSchema`, `ParticipantSchema`, `MessageSchema`)
and cross-checked against the authenticated `team_id`/`user_id` from
`team.describe`; a record for another tenant or participant is a `protocol`
error. The webview CSP is untouched (`connect-src 'none'`); the view state it
receives contains no token, transport error text or service handle.

Methods wired (all on `main` since #60, #64 and #66): `team.describe`,
`conversations.list` (`ConversationListItemSchema`, counters preferred over
the sequence distance), `conversations.open/mark_read/pin`,
`messages.send/history` (`MessageViewSchema` items: chips, reaction summaries,
`reply_excerpt`/`reply_restricted`), `events.poll`, and — when
`team.describe().capabilities` says so — `events.stream` on `POST /v1/stream`,
`reactions.set` and `messages.search`:

| Method | Request | Result the client validates | When the capability is false |
| --- | --- | --- | --- |
| `events.stream` on `POST /v1/stream` | RPC envelope `{method: "events.stream", context, params: {cursors: [{conversation_id, after_event_seq}]}}` | `text/event-stream`: `: connected`/`: heartbeat` comments, `id:` / `event: message\|membership\|reaction` / `data: <TeamDeliveryEvent>`, `event: close` `{reason}` (`membership`/`not_found` re-list the inbox) | `events.poll` every 2 s with the same cursors |
| `reactions.set` | `{message_id, emoji, on}` | `{message_id, emoji, count, reacted}` merged into the message's summaries | reaction controls hidden |
| `messages.search` | `{query (2..200), conversation_id?, limit ≤ 50}` | `{hits: [{conversation_id, message_id, seq, author_id, created_at, excerpt, cut_before, cut_after}], next_cursor}` | substring search over the host cache of messages the server already returned |

`capabilities` accepts any further boolean flag (`references` since PR 4) so
an additive capability never breaks the client.

Client behaviour (all tested offline in `apps/vscode/test/teamChatService.test.ts`
with `FakeTeamServer`, an in-memory stand-in for `@mars/team` behind the
transport interface):

- Identity: `team.describe` first; no `user_id` in any request; the fixture's
  viewer switcher is not offered for the service.
- Sends: one `client_message_id` per draft, kept until acknowledged; a lost
  acknowledgement retries the **same** id and the replay yields one message in
  order; `conflict` → status `conflict`, retry refused, "Edit and resend" puts
  the draft back under a new id.
- Read cursor: advanced only when the first unread message is loaded **and**
  the webview reported `focused && atBottom`; the unread divider is computed
  from `read_seq`/`joined_seq` once per open.
- Realtime: per-conversation resume cursors, priming from cursor 0 without
  announcing history, exponential backoff 500 ms → 10 s, `unauthenticated`
  state on an auth failure, `event: close` for `membership`/`not_found` and
  `not_found`/`forbidden` on a poll re-list the inbox.
- Removal: a `not_found`/`forbidden` for a listed conversation drops it and
  purges cached messages, pending drafts and search hits.
- References: the PR 4 server's per-viewer `references` chips drive the view
  (`restricted: true` → `Restricted reference`, an allowed chip shows its
  locator); a record without chips falls back to one restricted chip per
  `reference_id`. No picker or preview panel yet.
- Unread counters come from `conversations.list` (`unread_count` excludes the
  viewer's own posts); after `conversations.open` the client keeps that
  counter while `last_seq`/`read_seq` are unchanged, otherwise counts cached
  messages by others over a contiguous span and falls back to the sequence
  distance. The first-unread boundary is taken from the cache only while it
  is contiguous from the read cursor.
- A reply excerpt is shown only when the target belongs to the same
  conversation; a mismatched `reply_to` from the server reveals nothing.
- Search hits open their conversation, page back until the hit's sequence is
  loaded (bounded by the in-memory cap) and highlight it; polling rotates the
  cursor order after a full page so one busy conversation cannot starve the
  others; the SSE reader bounds only the incomplete frame tail.
- Fixed strings only: transport failures map to `unavailable`/`unauthorized`
  notices; server text never reaches the view.

Plan vs. discovery report: the plan's SSE "Last-Event-ID" resume is replaced by
the cursor list in the request body (the stream is a `POST`), and the plan's
"workspace" is `team_id`, both per the discovery report and the service.

Verified offline only: `cd apps/vscode && bun run typecheck && bun run test &&
bun run smoke`, `bun run check`, the headless harness `service` scenario (real
adapter + realtime poll against an in-page stub that speaks the `main`
protocol shapes). Not verified: a VS Code window against a running
`@mars/team` (the SSE frame layout and request envelope mirror
`packages/team/src/server.ts`; no live stream has been held open from the
extension host).
