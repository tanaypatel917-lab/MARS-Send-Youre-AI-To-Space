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
| Team token on the client | VS Code `SecretStorage` (own key, PR 3) | Never the workbench token, never in `ViewState`. |

## RPC (`POST /v1/rpc`, loopback only)

Envelope, limits, auth handling and error vocabulary are the workbench's
(`packages/workbench/src/server.ts`): `{method, context, params}` →
`{result}` | `{error: {code, message}}`, fixed messages, 512 KiB request /
4 MiB response, `Origin` rejected, non-loopback `Host` rejected. The context is
`TeamContextSchema = {schema_version: 1, team_id, request_id}`.

| Method | Params | Guarantees |
| --- | --- | --- |
| `team.describe` | `{}` | Caller's `team_id`, `user_id`, role, limits, capabilities (`stream`/`reactions`/`search` are `false` until PR 3). |
| `conversations.create_dm` | `{peer_user_id}` | One DM per pair per team: `UNIQUE(team_id, dm_key) WHERE kind='dm'` plus an immediate transaction; concurrent creators receive the same conversation. |
| `conversations.create_group` | `{member_ids ≤ 32, title ≤ 200}` | Creator included; every member must be an active team member. |
| `conversations.list` / `conversations.open` | `{}` / `{conversation_id}` | Only active participation; returns the conversation, the caller's participant row and member summaries (`user_id`, `state`, `joined_seq`). |
| `conversations.add_member` / `remove_member` | `{conversation_id, user_id, expected_revision}` | Groups only; `conflict` on revision mismatch; removal is effective in the same transaction. A re-added member gets a new `joined_seq`. |
| `conversations.mark_read` | `{conversation_id, read_seq}` | Monotonic; `read_seq` ≤ the conversation's `last_seq`. |
| `conversations.pin` | `{conversation_id, pinned}` | Per participant. |
| `messages.send` | `{conversation_id, client_message_id ≤ 128, body ≤ 16 KiB, reply_to?}` | `UNIQUE(conversation_id, author_id, client_message_id)`; same key + same `body_sha256` → the original `{message_id, seq}`; different body → `conflict`. Message and outbox row commit together. `reply_to` must be a message the author may see in the same conversation. |
| `messages.history` | `{conversation_id, after_seq? \| before_seq?, limit ≤ 200}` | Membership re-checked inside the read transaction; page cut by count and serialized bytes, never skipping (a single oversized message → `too_large`); a participant sees only `seq > joined_seq`. |
| `events.poll` | `{cursors: [{conversation_id, after_event_seq}] ≤ 50, limit ≤ 1000}` | Membership-filtered outbox; events carry `{conversation_id, event_seq, kind, message_seq, message_id, revision}` only — never a body. Cursors are per conversation. |

Not implemented (TODO markers in `packages/team/src/protocol.ts`): `events.stream`
(SSE), `reactions.set`, `messages.search` (PR 3); references, @MARS requests,
task links and result shares (PR 4–6; their schemas are reserved in
`packages/contracts/src/team.ts`); any VS Code wiring.

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
- **Dev authenticator only.** Tokens are hashed at construction and compared as
  SHA-256 digests in constant time; plain tokens are never retained.
- **Team administration is host-side** (`store.setTeamMember` /
  `removeTeamMember`); no RPC can change team membership in PR 2. Removing a
  team member removes them from every conversation of that team.

## Assumptions (owner defaults)

Pilot deployment is a loopback Bun process with a SQLite store whose schema is
Postgres-portable; identity is the pluggable `Authenticator` with a local dev
provider only; the Git provider (PR 4) reads committed objects through a
host-trusted repo mapping with argv-only `git`; @MARS models are free-first
only, no paid.

## Verification

Offline only: `bun test packages/team` runs through the real loopback server
with the dev authenticator and a second Bun process for the DM race. No live
identity provider, no remote host, no VS Code window.
