# MARS Shell (desktop client)

Status: **PR 3a scaffold, fixture-verified only.** `apps/shell` is an Electron window (`electron@44.10.2`, see `documentation/adr/0001-shell-window-framework.md`) over the loopback workbench RPC. It is read-only in this build. Specification: `documentation/UI_PROMPT.md` §3; the transcript and composer arrive in a follow-up PR once `@mars/ui-core` lands.

## No second agent loop

MARS Shell owns no model, no tools, no shell, no history store, no MCP/LSP and no permission logic. Oh My Pi inside the workbench (`mars serve`) is the only agent runtime. The Shell observes tasks through eight read methods and stores nothing except its window size in `~/.mars/shell/layout.json`. It never calls a model, starts, steers, cancels, resumes, checkpoints or restores a task, runs a command, or reads the file system on behalf of the renderer.

## Process model

| Process | What it may do | What it may not do |
| --- | --- | --- |
| Main (`src/main`, Node) | Read one mode-0600 `mars serve` connection file, hold the bearer token, forward the nine read methods to `http://127.0.0.1:<port>/v1/rpc`, validate every request and result with strict zod schemas (the server's own schemas from `packages/workbench/src/protocol.ts` and `@mars/contracts`, imported, not copied), verify `tasks.artifact` bytes against the `ArtifactRef` (`sha256`, `byte_length`, `media_type`), serve the renderer files from `mars-shell://app/` with a CSP header, persist window size | Any other RPC method, any other host, model calls, child processes, renderer-requested file access |
| Preload (`src/preload`, sandboxed) | Expose one frozen object `window.marsWorkbench` whose keys are exactly the nine method names, each forwarding over one IPC channel | Expose `ipcRenderer`, Node, or anything else |
| Renderer (`src/renderer`, Chromium sandbox, `contextIsolation`, no Node) | Build the DOM with `createElement`/`textContent`/`setAttribute` only; re-check artifact SHA-256 with WebCrypto before rendering | `innerHTML` and friends (not in its DOM type), inline scripts/styles, network (`connect-src 'none'`), links, images, imports other than its own modules, `@mars/ui-core`, `@mars/output-format` |

Bridge methods (the whitelist): `workbench.describe`, `tasks.list`, `tasks.inspect`, `tasks.events`, `tasks.artifact`, `tasks.diff`, `tasks.verification`, `tasks.evidence`, `tasks.journal` (read-only, §8.3). Anything else is answered `refused` without contacting the workbench.

CSP (header; the `<meta>` copy omits `frame-ancestors`): `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'none'; media-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`.

Main-process hardening: `app.enableSandbox()`, every permission request/check denied, navigation and `window.open` denied, `<webview>` refused, every request outside `mars-shell://app/` cancelled, no application menu.

## What the window shows

- Sidebar: session switcher from `tasks.list` grouped by status (glyph + word), runtime column (`oh-my-pi`), a workspace-tree placeholder, and a disabled **Team chat** entry (reserved; Team Chat is `team_id`-tenanted, has its own endpoint, and is not workbench RPC).
- Main: read-only task header — status from the task, verification state from `tasks.verification` shown separately (a `completed` task can be `Unverified`), model tier from the optional `tasks.inspect.model_tier` (§8.3; "not reported by host" when an older host omits it), mode shown as "not reported by host" because no read method carries the approval mode today; a transcript placeholder with the event count from `tasks.events`.
- Inspector: task request and acceptance criteria, verification verdict and records, changed files from `tasks.diff`, evidence records from `tasks.evidence`, artifacts (text artifacts rendered only after both SHA-256 checks pass; a mismatch shows "rejected" and no content).
- Every piece of model/repository/workspace text is rendered as data in a quoted block with a visible provenance label (`untrusted · task request`, `untrusted · artifact … · sha256 verified`, …).

## Run it

Headless checks (part of `bun run check`):

```sh
bun test apps/shell
```

Window (opt-in; downloads the Electron binary from GitHub once):

```sh
cd apps/shell
bun run native:install
bun run build
# against a real workbench:
mars serve --source <repo>          # writes ~/.mars/workbench/<project>/connection.json
node_modules/.bin/electron dist/main.cjs
# or against the fixture workbench (real serveWorkbench transport, fixture data):
bun run fixture-workbench --state /tmp/shell-fixture-state
node_modules/.bin/electron dist/main.cjs --connection=/tmp/shell-fixture-state/connection.json
```

The connection file is chosen by `--connection=PATH`, then `MARS_SHELL_CONNECTION`, then the single `~/.mars/workbench/*/connection.json`; with several and no flag the Shell reports "not connected" (the workbench selector of §3.2 is not built). On a Linux host without unprivileged user namespaces or a setuid `chrome-sandbox` the Chromium sandbox cannot start; the Shell never disables it in code.

## Not in this build

Transcript projection and composer (`@mars/ui-core`), start/steer/cancel/resume/restore, diff viewer, evidence images, settings UI, notification mailbox, workbench selector, Team Chat pane, packaging/signing/fuses, axe accessibility test. Screenshots in PRs are **fixture evidence**: a real Electron window under Xvfb against the fixture workbench, never a live model or a live task run.
