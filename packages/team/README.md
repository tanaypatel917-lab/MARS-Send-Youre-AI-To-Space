# `@mars/team`

Team Chat service: an authenticated, loopback-bound RPC + SSE server over a
SQLite store for team membership, DM/group conversations, messages, replies,
reactions, search, read cursors, pins and a committed delivery outbox. It owns
identity resolution and conversations only — no model calls, no Git, no tools,
no task state.
Architecture and decisions: `documentation/TEAM_CHAT.md`.

```ts
import { createDevAuthenticator, createTeamStore, serveTeam } from "@mars/team";

const store = createTeamStore({ rootDir: "/private/state/team" });
store.setTeamMember({ team_id: "team-1", user_id: "alice", role: "admin" });
const server = serveTeam({
  store,
  authenticator: createDevAuthenticator([
    { token: process.env.ALICE_TOKEN!, user_id: "alice", team_ids: ["team-1"] },
  ]),
  port: 0,
});
// POST http://127.0.0.1:<port>/v1/rpc    with Authorization: Bearer <token>
// POST http://127.0.0.1:<port>/v1/stream same envelope, method "events.stream" → text/event-stream
```

- `createTeamStore({ rootDir, limits?, now?, randomId? })` — `team.sqlite`
  (`WAL`, `synchronous=FULL`, `foreign_keys=ON`, mode 0600, root 0700),
  `meta.format_version`, forward-only `migrations` ledger. Every operation takes
  a server-resolved `TeamActor = {team_id, user_id}` and authorizes team
  membership, then participation, inside one transaction.
- `Authenticator` — `authenticate(bearerToken) → {user_id, team_ids} | null`.
  `createDevAuthenticator(users)` is for tests and the pilot only.
- `serveTeam({ store, authenticator, port?, repos?, agentReferences?, log? })` — same checks, caps, envelope
  and error codes as `packages/workbench/src/server.ts`; `/v1/stream` serves
  membership-filtered outbox metadata as SSE (`id:` = `event_seq`, heartbeat
  comments, `event: close` on revocation) by re-polling the store from the
  connection's cursors whenever a commit wakes it.
- `store.subscribe(listener)` — post-commit notices (`event` /
  `removed`) for the in-process server; nothing in a notice but ids.
- `TeamLimitsSchema` / `DEFAULT_TEAM_LIMITS` — body bytes, group size, page
  size and bytes, cursors per poll, poll events, idempotency rows, open streams
  per user, heartbeat period, stream batch and buffer bytes, searches per
  minute, reaction keys per message.
- `TeamRpcRequestSchema` / `TeamStreamRequestSchema` — strict request shapes
  (see the method table in the documentation); `MessageViewSchema`,
  `ConversationListItemSchema`, `ReactionStateSchema`, `SearchResultSchema`
  describe the PR 3 results.

Tests: `bun test packages/team` (offline; loopback server + dev authenticator;
a spawned Bun process races DM creation; real SSE connections for reconnect,
backfill/live and revocation).

## Task links and result shares (PR 6, chat half)

`tasks.link_draft` → `tasks.link_confirm` → `tasks.link_created` record a
"Start task" handoff; `shares.preview` / `shares.create` post a
`kind: "result_card"` message from the requester's own `tasks.evidence`
result. The service never contacts a workbench: it stores opaque workbench ids,
the frozen conversation provenance and the attested card. See
`documentation/TEAM_CHAT.md` → "Task handoff" for the flow and the rules
(frozen provenance, one launch key per link, verification copied not judged,
stale on re-share, no scope ids to other members).

## Pilot rollout (PR 7)

`store.isEnabled()` / `store.setEnabled()` (kill switch in `meta`, default
**off**; off → only `team.describe` answers), `store.metrics` +
`team.metrics` (admin-only redacted counters, `TeamMetricsSchema`),
per-user sliding-minute limits for sends/reactions/search/agent calls
(`unavailable` + `Retry-After`), `store.exportSnapshot()` /
`importSnapshot()` (`TeamStoreSnapshotSchema`), `createAgentReferencePort`
(backs the agent `TeamReferencePort` with `repo_access` + `@mars/code-refs`).
Operated through `mars team serve|enable|disable|stats|export|import|revoke|readmit|grant|rotate-tokens`;
see `documentation/TEAM_CHAT_RUNBOOK.md`.

Only `team.describe` accepts an omitted context, and then only when the caller has exactly one authenticated team.
