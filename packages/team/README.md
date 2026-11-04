# `@mars/team`

Team Chat service foundation: an authenticated, loopback-bound RPC server over a
SQLite store for team membership, DM/group conversations, messages, read
cursors, pins and a committed delivery outbox. It owns identity resolution and
conversations only — no model calls, no Git, no tools, no task state.
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
// POST http://127.0.0.1:<port>/v1/rpc with Authorization: Bearer <token>
```

- `createTeamStore({ rootDir, limits?, now?, randomId? })` — `team.sqlite`
  (`WAL`, `synchronous=FULL`, `foreign_keys=ON`, mode 0600, root 0700),
  `meta.format_version`, forward-only `migrations` ledger. Every operation takes
  a server-resolved `TeamActor = {team_id, user_id}` and authorizes team
  membership, then participation, inside one transaction.
- `Authenticator` — `authenticate(bearerToken) → {user_id, team_ids} | null`.
  `createDevAuthenticator(users)` is for tests and the pilot only.
- `serveTeam({ store, authenticator, port? })` — same checks, caps, envelope
  and error codes as `packages/workbench/src/server.ts`.
- `TeamLimitsSchema` / `DEFAULT_TEAM_LIMITS` — body bytes, group size, page
  size and bytes, cursors per poll, poll events, idempotency rows.
- `TeamRpcRequestSchema` — strict request union (see the method table in the
  documentation).

Tests: `bun test packages/team` (offline; loopback server + dev authenticator;
a spawned Bun process races DM creation).
