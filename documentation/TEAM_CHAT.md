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
- **Re-entry is self-initiated.** A participant marked `removed` by a team
  departure re-enters a DM only through their own `conversations.create_dm`
  (new `joined_seq`, nothing from the absence is visible); the peer's call never
  restores someone else's access. Group re-entry is `add_member` by a member.
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

## 8. Smallest next change (PR 3 wiring; the PR 2 service already landed)

`@mars/team` (`packages/team`: SQLite store, loopback RPC server, `createDevAuthenticator`, `conversations.*` / `messages.*` methods documented at the top of this file) merged in #60, so the service no longer needs to be built. The smallest next change is the adapter: implement `TeamService` (this PR's client-facing interface in `@mars/team-chat`) over `@mars/team`'s RPC — `listConversations` → `conversations.list`, `openConversation` → `conversations.open` + `messages.history {before_seq, limit}` (map `older_cursor` to `before_seq`), `sendMessage` → `messages.send` (replay → `duplicate: true`, `conflict` → `client_message_id_reused`), `markRead` → `conversations.mark_read`, `setPinned` → `conversations.pin` — using `HttpRpcTransport` with a separate team endpoint and `SecretStorage` key in the extension host, and let `TeamChatController` choose it instead of `FixtureTeamService` behind the same `mars.teamChat.enabled` flag (fixture stays the default until identity is decided). Reactions, references and the viewer switcher stay fixture-only until `reactions.set` (PR 3) and `@mars/code-refs`-backed resolution (PR 4) are wired; port `service.test.ts` as the adapter's acceptance tests against a loopback `@mars/team` server.
