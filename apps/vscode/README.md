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

Commands: `mars.connect`, `mars.importConnection`, `mars.setToken`, `mars.clearToken`, `mars.newTask`, `mars.refresh`, `mars.cancelTask`.

## Protocol

`POST {serverUrl}/v1/rpc` with `Authorization: Bearer <token>`, body `{method, context, params}`, response `{result}` or `{error:{code,message}}`. `workbench.describe` is sent with `params:{}` and no context; every other call carries `{schema_version:1, scope:<server scope>, request_id:<fresh uuid>}`. Methods: `tasks.create|list|inspect|start|resume|steer|cancel|events|artifact|diff|checkpoint|restore` (see `src/client.ts`). All responses are validated with `@mars/contracts` schemas plus `src/protocol.ts`; anything unexpected is an error. Error codes `conflict`/`revision_conflict` (or HTTP 409) are treated as revision conflicts and trigger a reload of server state.

## Safety model

- Webview: strict CSP (`default-src 'none'`, nonce script, no connect/frame/form), no command URIs, no forms, DOM built with `textContent` only. Messages from the webview are validated with a strict schema (`src/messages.ts`).
- Start, resume, cancel and restore require native modal confirmation; restore shows the exact workspace and checkpoint ids and revisions. Execute approval defaults to off and is disabled when the server does not offer execution.
- Native diffs are read-only and never write files. Task edits live in a private copy on the server, so the local checkout normally holds BEFORE: for modified files the patch is applied forward (exact, no fuzz) to the local file inside the single open folder named by `workbench.describe.workspaceLabel` to build a virtual AFTER buffer. Added/deleted files are derived from a pure add/remove patch alone. A local file that already matches AFTER is shown against a reconstructed BEFORE. If the local file matches neither side the patch is shown read-only; unsafe paths and binary/malformed patches are refused.
- Artifacts are verified against their `ArtifactRef` (SHA-256, byte length, media type) before display.
- Event polling uses one reader per selected task, advances `after_event_id`, backs off exponentially (bounded) and is disposed on task switch and view close.

UX patterns (task list, timeline, per-file diff, checkpoint restore) are adapted from Cline as a reference only; no Cline code or assets are included.
