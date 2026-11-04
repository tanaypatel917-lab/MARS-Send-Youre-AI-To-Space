# MARS Workbench (VS Code client)

`@mars/vscode-client` is a native VS Code sidebar for MARS tasks. It is a **client only**: it creates, starts, steers, cancels and resumes tasks through the MARS task API, shows events, usage, diffs and artifacts, and creates/restores checkpoints. Oh My Pi (behind the MARS server) remains the only session/tool/model execution owner. The extension never calls models, runs shell commands, writes workspace files or keeps its own task history; all task truth and revisions come from the server.

> Status: the [local task service](../../documentation/LOCAL_WORKBENCH.md) connects this client to durable tasks, private workspaces and Oh My Pi. HTTP/SDK integration tests use injected model responses; a real VS Code window and live model remain unverified.

## Setup

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun install --frozen-lockfile --ignore-scripts   # from the repository root
cd apps/vscode
bun run build        # dist/extension.js (Node CJS) + dist/webview.js (browser IIFE)
bun run typecheck
bun run test
bun run smoke        # builds, then loads dist/extension.js in plain Node with a stub vscode module
```

Run it in VS Code: open `apps/vscode` and launch an Extension Development Host (`code --extensionDevelopmentPath=$PWD`), then open the **MARS** activity-bar view.

1. Start a local server with `mars serve`. It never prints the token; it writes a mode-0600 `connection.json` (`{schema_version:1, url, token, scope:{owner_id, project_id}}`).
2. Run **MARS: Import local connection file** and pick that file. The file must be ≤16 KiB with exactly those keys, a `[A-Za-z0-9_-]{32,256}` token, and a root `http://` loopback URL (no path, credentials, query or fragment); on POSIX it must not be group/other accessible. The token goes only to VS Code SecretStorage (`mars.serverToken`) and the URL only to the **user** (global) `mars.serverUrl`; replacing an existing URL or token asks first. Alternatively run **MARS: Set Server Token** to paste a token into a password box. Tokens never reach the webview, logs, errors or settings.
3. Run **MARS: Connect**.

## Settings

| Setting | Default | Notes |
| --- | --- | --- |
| `mars.serverUrl` | `http://127.0.0.1:7331` | Loopback only by default. No credentials, query or fragment. |
| `mars.allowNonLoopbackServer` | `false` | Required for non-loopback servers, which must also use HTTPS and are confirmed once per exact RPC URL (`<origin><path>/v1/rpc`) per window; a different path on the same host asks again. |
| `mars.modelId` | empty | Optional model id sent with `tasks.start`; empty uses the server's free-cloud default. Paid models are governed only by server policy. |
| `mars.requestTimeoutMs` | `15000` | Per-request timeout. |

| `mars.teamChat.enabled` | `false` | Shows the **Team Chat** view (see below). |
| `mars.teamChat.source` | `fixture` | `fixture`: the deterministic in-memory dataset in `@mars/team-chat` (label `FIXTURE`, no network). `service`: the `@mars/team` service at `mars.teamServerUrl` (label `SERVICE`). |
| `mars.teamServerUrl` | `http://127.0.0.1:7332` | Base URL of the team service. Same rules as `mars.serverUrl` (loopback only unless the team-specific allow setting is on, then HTTPS only); independent of the task-server settings. |
| `mars.teamChat.allowNonLoopbackServer` | `false` | Allows an HTTPS non-loopback team service. Deliberately **not** shared with `mars.allowNonLoopbackServer`. |

Commands: `mars.connect`, `mars.importConnection`, `mars.setToken`, `mars.clearToken`, `mars.newTask`, `mars.refresh`, `mars.cancelTask`, `mars.teamChat.open`, `mars.teamChat.setToken`, `mars.teamChat.clearToken`.

## Team Chat (flag off by default)

With `mars.teamChat.enabled` on, a second view **Team Chat** appears in the MARS container (`mars.teamChat`, `src/teamChat/*`, `src/webview/teamChat/main.ts`, `media/team-chat.css`). It is PR 1 of the Team Chat plan ([documentation/TEAM_CHAT.md](../../documentation/TEAM_CHAT.md)): a three-pane inbox (conversations | messages + composer | code panel opened by a chip click, a drawer at narrow widths) over `FixtureTeamService` — one fixture team, three users, a DM and a group, replies, reactions, pins, an unread divider, and code chips from two fixture repos that open the fixture blob at its pinned SHA with the range highlighted. Everything is labelled `FIXTURE`; the "Viewing as" switcher exists only to show membership filtering (a member outside a conversation sees nothing, a member without repo access sees `Restricted reference`). The webview follows the same safety model as the task view (strict CSP, `textContent` only, `TeamChatWebviewMessageSchema` validation in `TeamChatController`); in fixture mode it never contacts a server, and the extension's task client is untouched. `bun scripts/team-chat-harness.ts --out DIR` renders the view in headless Chrome with a stub VS Code API for screenshots (the `service` scenario drives the real adapter against an in-page stub server).

### Service mode (PR 3, client half)

`mars.teamChat.source: "service"` swaps `FixtureTeamService` for `RpcTeamService` (`src/teamChat/service.ts`) over `TeamClient` (`src/teamChat/client.ts`), a typed client for the `@mars/team` RPC built on the same `HttpRpcTransport` as the task client but with its own `rpcUrl` and its own bearer token: the **`mars.teamToken`** SecretStorage key, set with `MARS: Set team token` and removed with `MARS: Clear team token` (which also drops every cached conversation, message, draft and search result). Everything network-related runs in the extension host; the webview keeps `connect-src 'none'` and only ever receives view state (the token is never part of it — `test/teamChatService.test.ts` asserts this on the serialized states).

- Identity is server-derived: `team.describe` returns `team_id`/`user_id`; the client stamps `team_id` into every request context and rejects any record whose tenant or participant is not the caller. There is no viewer switcher in service mode.
- Reads: `conversations.list`/`open`, `messages.history` (`before_seq` pagination behind the opaque `seq:<n>` cursor), `conversations.mark_read` (only while the view is focused and scrolled to the bottom — the webview reports its viewport), `conversations.pin`.
- Sends: `messages.send` with a client message id generated once per draft and kept in memory until acknowledged; a lost acknowledgement is shown as *failed* and **Retry** resends the same id (the server replays, so one message appears, in order); `conflict` (same id, different body) is final and shows **Edit and resend**, which puts the draft back in the composer under a new id.
- Realtime (`src/teamChat/realtime.ts`): when `team.describe` advertises `stream`, an SSE reader POSTs `events.stream` to `/v1/stream` with per-conversation resume cursors (`id:`/`event:`/`data:` frames; `event: close` with `membership`/`not_found` re-lists the inbox); otherwise, or after a stream failure, it falls back to `events.poll`. New conversations are primed from cursor 0 once without notifying, so history is not announced as new. Backoff doubles from 500 ms to 10 s like `EventPoller`; an authentication failure stops until the token changes. Events are metadata only — the controller re-reads through `messages.history`, reconciles pending sends by `client_message_id`, and announces new messages through one `aria-live` region.
- Removal: `not_found`/`forbidden` on a conversation the inbox already listed removes it and clears its cached messages, pending drafts and search hits.
- Reactions and search: `reactions.set` and `messages.search` are used only when `team.describe().capabilities` says the server has them (the PR 3 service half); otherwise reaction controls are hidden and the search box filters the host-side cache of messages the server already returned to this viewer. `reference_ids` on service messages render as `Restricted reference` chips (no path, SHA or excerpt) until the reference resolution service lands.

## Protocol

`POST {serverUrl}/v1/rpc` with `Authorization: Bearer <token>`, body `{method, context, params}`, response `{result}` or `{error:{code,message}}`. `workbench.describe` is sent with `params:{}` and no context; every other call carries `{schema_version:1, scope:<server scope>, request_id:<fresh uuid>}`. Methods: `tasks.create|list|inspect|start|resume|steer|cancel|events|artifact|diff|checkpoint|restore|verification` (see `src/client.ts`). `start` may carry `required_checks`; `verification` returns the host's verdict for the task's current candidate revision. The task panel shows that verdict as a badge beside the status once a task is finished — "Verified" only when every required check passed for the exact candidate being shown, otherwise "Verification failed", "Verification inconclusive", "Verification stale" (the workspace moved after the verdict, e.g. a restore) or "Unverified" (no checks were declared). The client recomputes the state from the returned records with `verificationStateFor`; it never infers verification from `completed`. All responses are validated with `@mars/contracts` schemas plus `src/protocol.ts`; anything unexpected is an error. Error codes `conflict`/`revision_conflict` (or HTTP 409) are treated as revision conflicts and trigger a reload of server state.

## Output format

When you **Inspect** the model's final text (the bare `text/plain` artifact listed on the task; command stdout/stderr and other text artifacts stay a raw `<pre>`), the webview parses it as the [MARS Output Format](../../packages/output-format/src/parse.ts) with `parseOutput` + `validateOutput` (no connectors registered; allowed email addresses are those found in the task request and acceptance criteria). Model text only ever becomes text nodes:

- Markdown segments are shown verbatim in a `<pre>`; no HTML or Markdown is rendered from model text.
- Each `:::writing{...}` block becomes a panel with its variant, id and email fields (subject/to/cc/bcc), one sub-panel per `::tone[...]` section (or the body), and a **Copy** button that puts the raw body on the clipboard.
- `- :mars-followup[phrase]{prompt="..."}` becomes a button labelled with the phrase whose tooltip is the hidden prompt. Clicking opens a native confirmation showing the full prompt; only **Send follow-up** sends it through the normal steer path, and only when the task is running or paused (otherwise a notice explains that a follow-up can only steer a live task).
- `mars://review?pr=...&path=...&line=N&end=M&side=...` becomes a button that opens `path` from the single open workspace folder matching the server's workspace label (same path checks as diffs: workspace-relative only, no `..`, no absolute/URI paths, symlinks must stay inside) and selects lines `N`–`M`. The `side` and `pr` are shown in the notice and status bar; the PR is never fetched.
- `[$label](app://id)` is shown as a disabled chip "label (connector id not registered)" because this client has no connector registry.
- Parse and validation errors are listed under the output. A review link whose range exceeds the validator's limit is shown as plain text, never as a button.

Nothing runs because the model emitted a link: every action above needs an explicit click, and follow-ups need a second confirmation.

## Safety model

- Webview: strict CSP (`default-src 'none'`, nonce script, no connect/frame/form), no command URIs, no forms, DOM built with `textContent` only. Messages from the webview are validated with a strict schema (`src/messages.ts`).
- Start, resume, cancel and restore require native modal confirmation; restore shows the exact workspace and checkpoint ids and revisions. Execute approval defaults to off and is disabled when the server does not offer execution.
- Native diffs are read-only and never write files. Task edits live in a private copy on the server, so the local checkout normally holds BEFORE: for modified files the patch is applied forward (exact, no fuzz) to the local file inside the single open folder named by `workbench.describe.workspaceLabel` to build a virtual AFTER buffer. Added/deleted files are derived from a pure add/remove patch alone. A local file that already matches AFTER is shown against a reconstructed BEFORE. If the local file matches neither side the patch is shown read-only; unsafe paths and binary/malformed patches are refused.
- Artifacts are verified against their `ArtifactRef` (SHA-256, byte length, media type) before display.
- Event polling uses one reader per selected task, advances `after_event_id`, backs off exponentially (bounded) and is disposed on task switch and view close.

UX patterns (task list, timeline, per-file diff, checkpoint restore) are adapted from Cline as a reference only; no Cline code or assets are included.
