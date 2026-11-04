# Team Chat pilot runbook

Operator guide for the Team Chat pilot (PR 7). Status: **pilot-ready,
offline-verified only** — every procedure below was exercised by
`bun test packages/team apps/cli` and `bun run check:team` against a loopback
`mars team serve` process on one machine with the dev authenticator and
temporary `git` repositories. Nothing has been run against a live VS Code
window, a second machine, a real identity provider or a network Git provider.
Architecture and contracts: `documentation/TEAM_CHAT.md`.

Assumed owner defaults (not decisions): pilot deployment = one loopback Bun
process + SQLite store (Postgres-portable schema); identity = pluggable
`Authenticator` with the local dev provider only; Git = committed objects read
through host-trusted `--repo id=DIR` mappings with argv-only `git`; @MARS models
= free-first only, no paid path.

## 1. Start the service

```sh
mars team serve --state /private/mars-team --port 7332 --team team-local \
  --dev-users ada,grace,linus \
  --repo platform=/srv/checkouts/platform --repo site=/srv/checkouts/site \
  --repo-access site=ada,grace \
  --enable
```

- `--state DIR` (0700) holds `team/team.sqlite` (0600, WAL), `team-connection.json`
  (0600, `{schema_version: 1, url, team_id}` — **never a token**) and, for the
  dev provider, `team-dev-tokens.json` (0600). The startup line names the token
  file; tokens themselves are never printed or logged.
- Opening the store applies pending migrations and the startup line lists the
  ledger ids applied (`migrations_applied`) and the head (`ledger_head`).
- `--dev-users a,b,c`: the first user is the team `admin` (may call
  `team.metrics`), the rest are `member`s. Tokens are generated once and reused
  across restarts; new users get new tokens. `--auth-provider none` starts a
  service nobody can authenticate to (smoke only). One of the two is required.
- `--repo ID=DIR` registers a host-trusted checkout in the `@mars/code-refs`
  registry and the team store; access defaults to every dev user unless
  `--repo-access ID=user,user` narrows it. The team store never holds a path.
- `--enable` turns the kill switch on at start; without it the service starts
  **disabled** (see §2). `--agent-model ID` lets `agent.*` queue requests with
  the reference port backed by the store; the `@mars/team-agent` worker is not
  started by this command (follow-up).
- Stop with `SIGTERM`: open streams receive `event: close` and the process exits
  143 after closing the store.
- Structured log lines (`{"log":"team","op","id","method","code","status","ms"}`)
  go to stdout after the startup line (`--quiet` silences them). `id` is a
  server counter, never the client's `request_id`.

Clients: VS Code setting `mars.teamServerUrl` = the `url` from
`team-connection.json`, secret `mars.teamToken` = that user's token from the
dev token file (imported by the operator, never sent over the wire by anyone
else).

## 2. Enable / disable (kill switch)

```sh
mars team disable --state /private/mars-team   # {"enabled":false,"changed":true,...}
mars team enable  --state /private/mars-team
```

The flag is `meta.team.enabled` inside the store, **default off**, re-read on
every request. While off: every RPC except `team.describe` (which reports
`enabled: false`) answers `503 unavailable` with the fixed message, new
`events.stream` connections are refused, open streams in the serving process
are closed with `event: close {"reason":"unavailable"}` (immediately when the
flag is flipped in-process, at the next heartbeat re-poll — 15 s default — when
flipped from another process), and the agent worker claims nothing.
**Disabling never deletes anything**: conversations, messages, links, cards,
repo access and counters are untouched and readable again after `enable`. The
VS Code inbox shows the disabled state and stops polling until the user
reconnects (fatal-kind handling).

## 3. Rotate dev tokens

```sh
mars team rotate-tokens --state /private/mars-team   # {"rotated":3,"restart_required":true}
```

Rewrites `team-dev-tokens.json` with fresh tokens for every listed user. The
serving process hashed the old tokens at start, so **restart `mars team serve`**
to make the rotation effective, then re-import the new tokens into each
client's `SecretStorage`. A compromised single token: `mars team revoke --user X`
(below) removes that user and their token entry; re-add them with a new
`--dev-users` list on the next start.

## 4. Revoke a user

```sh
mars team revoke --state /private/mars-team --user linus --repo site   # repo access only
mars team revoke --state /private/mars-team --user linus               # team membership + dev token
```

- Repo access revocation is effective on the next call: `references.resolve`
  answers `{state: "restricted"}`, chips become `{reference_id, restricted: true}`,
  `references.search_paths`/`create` and sends with that repo's references
  answer `not_found`, including the user's own earlier messages. @MARS
  selections containing such a reference are `restricted`/refused.
- Team removal removes the user from every conversation of the team, closes
  their streams (immediately in-process, at the next heartbeat when done from
  another process) and answers `forbidden` to every later call even though the
  old token still authenticates until restart. The dev token entry is dropped
  from the token file so a restart does not re-add them; a user who should keep
  a token but lose the team is not a supported state in the pilot.

## 5. Export and restore

```sh
mars team export --state /private/mars-team --out /backup/team-2026-11-04.json
mars team import --state /private/mars-team-restored --in /backup/team-2026-11-04.json
```

The export is a JSON snapshot (`TeamStoreSnapshotSchema`, file mode 0600):
`schema_version`, `format_version`, the migration `ledger` it was written under,
`enabled` at export time, `exported_at`, and every row of `members`,
`conversations`, `participants`, `messages`, `reactions`, `outbox`,
`idempotency`, `task_links`, `result_shares`, `repos`, `repo_access`,
`code_references`, `message_references`, `agent_requests`, `metrics`. It
contains message bodies and code locators (repo id, SHA, repo-relative path),
so store it as you would the SQLite file. It never contains a token (the store
has none) or a filesystem path.

`import` refuses a store that already has rows (`conflict`) and a snapshot whose
ledger differs from the binary's (`conflict`): restore into a **fresh** state
directory with the **same** `mars` version, then start `mars team serve` on it.
The restored store is **disabled** regardless of the flag at export; enable it
deliberately. Re-register repos with `--repo` (the registry is runtime
configuration, not store data); `repo_access` rows are restored.

## 6. Roll back a migration

Migrations are forward-only (`TEAM_MIGRATIONS`, applied in one immediate
transaction on open). To roll back after a bad upgrade:

1. Stop the service (`SIGTERM`).
2. Restore the **previous state directory** (the copy or export taken before the
   upgrade — take one every time, `cp -a` of the state dir with the service
   stopped, or `mars team export`).
3. Start the **previous** `mars` binary on it. An older binary that meets a
   newer ledger refuses to open the store (`corrupt_record`, ledger "does not
   match this version") without modifying it, so a wrong binary/state pairing
   fails closed instead of migrating down.
4. Roll forward later by starting the newer binary on the restored directory:
   pending ledger entries are applied and listed in the startup line.

Drill (`packages/team/src/rollout.test.ts` "migration drill"): a store at ledger
N-1 rolls forward to N keeping members and messages; a ledger with an extra
future id is refused with the rows and ledger left exactly as found.

## 7. Telemetry: what exists and what it never contains

- `team.metrics` RPC (team admins only) and `mars team stats --state DIR` return
  `TeamMetricsSchema`: integers under fixed keys — `sends`, `send_replays`,
  `conflicts`, `stream_connects`, `stream_disconnects`, `backfill_pages`,
  `links`, `shares`, `rate_limit_hits`, `disabled_refusals`,
  `denied_reads.<code>`, `agent_requests.<status>`, `rpc_errors.<code>`. Names
  come from `TEAM_METRIC_COUNTERS`; an unknown name is a programming error. The
  counters are durable rows (`metrics` table, migration `0005_metrics`).
- Server log lines carry `op`, a server-minted `id`, `method`, `code`, `status`,
  `ms`.
- Never present anywhere in telemetry: message bodies, excerpts, paths, repo
  labels, commit SHAs, tokens, user ids, conversation ids, client request ids
  or any other user-supplied text. Proven by `rollout.test.ts` ("team.metrics
  … never carries a body, path, SHA, token or user text") and the staging
  script's "redacted stats" row.
- Limits (`TeamLimitsSchema`, per serving process, sliding minute per team+user):
  `max_sends_per_minute` 120 (send/edit/delete/`shares.create`),
  `max_reactions_per_minute` 240, `max_search_per_minute` 60,
  `max_agent_requests_per_minute` 10, `max_resolves_per_minute` 120; exceeding
  answers `503 unavailable` with a `Retry-After` header (the RPC vocabulary is
  frozen, so there is no separate rate-limit code). Sizes: body 16 KiB, 16
  references per message, groups of 32, 200-message / 4 MiB pages, 4 open
  streams per user.

## 8. Staging checklist (three accounts, two repos)

`bun run check:team` runs `scripts/team-chat-staging.ts`, which performs this
checklist automatically (≈ 6 s) and prints a table; to do it by hand:

1. Prepare two git checkouts; `mars team serve --dev-users ada,grace,linus --repo a=… --repo b=… --repo-access b=ada,grace --enable`.
2. Import the three tokens into three VS Code profiles (`mars.teamToken`), set `mars.teamServerUrl`.
3. Duplicate send + reconnect: ada sends to grace, retries the same `client_message_id` after a killed acknowledgement, grace disconnects and reconnects from her last `event_seq` → one message, same order on both, no duplicate event.
4. Boundaries: linus (not in the DM) gets `not_found` on history/search/poll/stream and zero search hits; in the group, ada attaches a repo-b reference → linus sees `{reference_id, restricted: true}` only, `references.resolve` → `{state: "restricted"}`, `repos.list` omits b.
5. Exact code: grace attaches a repo-a range; move the branch and rename the file; linus still opens the text at the original SHA. `mars team revoke --user linus --repo a` → his next resolve is `restricted`, search/create/send with that reference are `not_found`.
6. Stale share: link → confirm → created → share card A; share again with another `diff_sha256` → card A reads `stale: true`, `superseded_by` card B; a wrong `preview_sha256` conflicts.
7. Kill switch: `mars team disable` → `503` on RPC, new streams refused, `team.describe.enabled === false`; `enable` → history intact.
8. `mars team stats` shows counters only.
9. Record (plan criteria): time to first code reference, whether the teammate could open it, whether the conversation yielded a next action — **by hand, not collected by the software.**

## 9. Acceptance matrix

| Plan scenario | Proof | Status |
| --- | --- | --- |
| Duplicate send and reconnect (two sessions, interrupted ack, retry, reconnect, same order) | `packages/team/src/server.test.ts` (b), (c); `features.test.ts` (a)–(c) SSE reconnect/backfill; `scripts/team-chat-staging.ts` "duplicate send + reconnect" | proven offline over loopback HTTP; not with two real VS Code windows |
| Conversation and repo boundaries (nonmember: no history/search/event; member without repo access: redacted chip, no metadata/excerpt/derived answer) | `server.test.ts` (a), (e); `features.test.ts` nonmember stream denial, search join window; `references.test.ts` (b), (c), (g); `agent.test.ts` reference-access audience; `rollout.test.ts` agent reference port; staging "conversation + repo boundaries" | proven offline |
| Exact code and revoked access (opens at original SHA after branch move; revocation closes preview, denies deep links and search) | `references.test.ts` (d), (e); staging "exact code + revoked access" | proven offline with temp repos; "clears protected cache entries" on the client = VS Code side, not proven in a live window |
| Local execution and verification (HEAD/index/diff hashes, exact tested patch, protected checks, isolation) | workbench: `packages/workbench/src/service.test.ts`, `host.test.ts`; chat side copies `tasks.evidence` only (`handoff.test.ts` (c)) | workbench half offline-verified in its own PRs; no live model run |
| Stale and interrupted runs (one task, correct run status, stale review for the new patch) | `handoff.test.ts` (a), (d), (g), (h); staging "stale share card" | proven offline for the chat side; checkpoint recovery is workbench scope |
| Desktop usability (two developers discuss a bug across two repos without pasting snippets) | — | **not proven**: no live VS Code window, no second machine |
| Pilot release criteria: flag disables new operations and ends subscriptions while preserving data | `rollout.test.ts` "kill switch"; `apps/cli/src/team-cli.test.ts`; staging "kill switch" | proven offline (cross-process flip closes streams at the heartbeat, in-process immediately) |
| Migration rollback or compatible roll-forward | `rollout.test.ts` "migration drill"; `upgrade.test.ts` (0003→0004 data) | proven offline |
| Revocation, restore, credential rotation | `team-cli.test.ts` (revoke, export/import); `rotate-tokens` command (manual restart documented) | revoke/restore proven offline; rotation = file rewrite, client re-import not proven |
| Redacted monitoring (sends, reconnect failures, unauthorized-access results, handoff failures; no content) | `rollout.test.ts` metrics redaction; staging "redacted stats" | proven offline; "handoff failures" = `rpc_errors`/`conflicts` on `tasks.link_*`/`shares.*`, not a dedicated counter |
| Real identity provider, network Git provider, second machine, live @MARS answer | — | **not proven / not implemented** (owner decisions) |
