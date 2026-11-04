# `@mars/team-chat`

Contracts, a deterministic fixture and pure state logic for the Team Chat
prototype (PR 1 of `documentation/TEAM_CHAT.md`). No network, no storage, no
model calls; the VS Code client consumes it behind the `mars.teamChat.enabled`
flag.

- `schemas.ts` — strict Zod records: `Team`/`Membership` (roles govern
  administration only), `Conversation`/`Participant` (per-member pin and read
  cursor, canonical DM pair), `Message`/`Reaction` (server sequence, client
  message id, reply target), `Reference`/`Share` (trusted `repo_id`, full
  40-hex `commit_sha`, normalized repo-relative `path`, optional range,
  `access_scope`), `SendMessageInput`, `TeamResult`.
- `fixture.ts` — the `FIXTURE` dataset: one team, three users, two fixture
  repos with blobs pinned at invented SHAs, a DM, a group, a reply, reactions,
  a pinned conversation, unread state, chips from both repos, and a DM the
  default viewer is not a member of.
- `service.ts` — `FixtureTeamService`: membership-filtered reads (fail closed
  with `not_found`), opaque history cursors, idempotent `sendMessage` keyed by
  author + conversation + `client_message_id` (same content replays, different
  content is rejected), reply-in-same-conversation, monotonic read cursors,
  per-requester pins, idempotent reaction set/remove, per-viewer reference
  resolution (`ok` with exact lines and highlight, `restricted` without any
  metadata, `unavailable`).
- `composer.ts`, `mentions.ts` — DOM-free reducers for the composer (`@`
  trigger, picker keyboard selection, reply context, chips) and the mention
  candidates (`path`, `path:start-end`, symbol; active repo first).

The viewer is always an argument supplied by the host; no input schema accepts
a user id. `bun test packages/team-chat` runs the offline tests.
