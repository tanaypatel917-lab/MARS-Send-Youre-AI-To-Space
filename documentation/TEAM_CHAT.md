# Team Chat

Human-to-human messaging for a MARS team, with @MARS answers, task links and
result shares arriving in later PRs. This document records the architecture
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
| `messages.send` | `{conversation_id, client_message_id ≤ 128, body ≤ 16 KiB, reply_to?}` | `UNIQUE(conversation_id, author_id, client_message_id)`; same key + same `body_sha256` → the original `{message_id, seq}`; different body → `conflict`. Message and outbox row commit together. `reply_to` must be a message the author may see in the same conversation. |
| `messages.history` | `{conversation_id, after_seq? \| before_seq?, limit ≤ 200}` | Membership re-checked inside the read transaction; page cut by count and serialized bytes, never skipping (a single oversized message → `too_large`); a participant sees only `seq > joined_seq`. Each item is the stored record plus `reactions: [{emoji, count, reacted}]` (sorted by key; no user lists) and, for replies, `reply_excerpt` (first 200 code points of the target) or `null` with `reply_restricted: true` when the target is before the caller's `joined_seq`. |
| `events.poll` | `{cursors: [{conversation_id, after_event_seq}] ≤ 50, limit ≤ 1000}` | Membership-filtered outbox; events carry `{conversation_id, event_seq, kind, message_seq, message_id, revision}` only — never a body. `kind` is `message`, `membership` or `reaction`. Cursors are per conversation. |
| `reactions.set` | `{message_id, emoji ≤ 32, on}` | Idempotent set/remove of the caller's reaction on a message they may see (`seq > joined_seq`; otherwise `not_found`). The key is validated with the invisible-code-point denylist from `packages/memory/src/threats.ts` (so no zero-width or variation-selector smuggling; `❤` is valid, `❤\ufe0f` is not) and must contain no whitespace. A change emits one outbox row `kind: "reaction"` with the message's `seq`/`message_id`; a no-op emits nothing. Returns `{message_id, emoji, count, reacted}`. Distinct keys per message are bounded (`max_reactions_per_message` → `too_large`). |
| `messages.search` | `{query 2..200, conversation_id?, limit ≤ 50, cursor?}` | Membership is applied in SQL before any body is read: `JOIN participants … state='active' AND m.seq > p.joined_seq` on the caller's team, optional conversation filter (a conversation the caller is not in → `not_found`). Case-insensitive (ASCII, SQLite `LIKE` semantics; `%`, `_`, `\` are literal) substring match, newest first (`created_at DESC, message_id DESC`), ≤ 200-code-point excerpt around the first hit with `cut_before`/`cut_after`, opaque `next_cursor` bound to (caller, query, filter) — a reused or altered cursor is `invalid_request`. Rate-limited per (team, user) in a sliding minute (`max_search_per_minute` → `unavailable`). |

Not implemented: references, @MARS requests, task links and result shares
(PR 4–6; their schemas are reserved in `packages/contracts/src/team.ts`); any
VS Code wiring (the inbox client of the stream lives in the extension host and
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
and refuses the whole stream. `events.poll` with the same cursors is the
fallback when a stream cannot be held open.

Revocation. `remove_member`, `conversations.leave` and host-side
`removeTeamMember` deliver a post-commit `removed` notice and the server closes
every open stream of that user on that conversation synchronously — the
`event: close` frame with `reason: "membership"` is written before the removing
call returns. Reconnecting, polling, reading history or searching that
conversation is then `not_found` (or `forbidden` after a team removal). Nothing
of the removed user remains server-side except their own authored rows and the
`removed` participant row that records the join window.

Limits (`TeamLimitsSchema`): `max_open_streams_per_user` (default 4; the next
connection is `too_large`), `stream_heartbeat_ms` (15 000), `max_stream_batch_events`
(200, capped by `max_poll_events`), `max_search_per_minute` (60 →
`unavailable`), `max_reactions_per_message` (64 → `too_large`).

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

## Assumptions (owner defaults)

Pilot deployment is a loopback Bun process with a SQLite store whose schema is
Postgres-portable; identity is the pluggable `Authenticator` with a local dev
provider only; the Git provider (PR 4) reads committed objects through a
host-trusted repo mapping with argv-only `git`; @MARS models are free-first
only, no paid.

## Verification

Offline only: `bun test packages/team` runs through the real loopback server
with the dev authenticator and a second Bun process for the DM race;
`packages/team/src/features.test.ts` opens real SSE connections (interrupted
acknowledgement + reconnect, backfill/live race with 4-row pages, nonmember
denial, same-call revocation, idempotent reactions, join-window search
filtering, stream/search limits). No live identity provider, no remote host, no
VS Code window.
