# MARS Shell (desktop client)

Status: **Interactive desktop workbench, fixture- and Xvfb-verified.** `apps/shell` is an Electron window (`electron@44.10.2`, see `documentation/adr/0001-shell-window-framework.md`) over the loopback workbench RPC, with an embedded Team Chat pane backed by `@mars/team-chat`. Specification: `documentation/UI_PROMPT.md` §3.

## No second agent loop

MARS Shell owns no model, no tools, no shell, no history store, no MCP/LSP and no permission logic. Oh My Pi inside the workbench (`mars serve`) is the only agent runtime. The Shell forwards explicit workbench RPC methods and stores nothing except its window size in `~/.mars/shell/layout.json`. It never calls a model directly, runs a child command, or reads the file system on behalf of the renderer. `tasks.checkpoint` and `tasks.restore` remain refused by the shell bridge.

## Process model

| Process | What it may do | What it may not do |
| --- | --- | --- |
| Main (`src/main`, Node) | Read one mode-0600 `mars serve` connection file, hold the bearer token, forward the 15 explicit workbench methods to `http://127.0.0.1:<port>/v1/rpc`, validate every request and result with strict zod schemas (imported from `@mars/workbench` and `@mars/contracts`, not copied), verify `tasks.artifact` and `tasks.export` bytes against `ArtifactRef` (`sha256`, `byte_length`, `media_type`), forward the 9 explicit Team Chat methods over a separate IPC channel (`mars:team-chat`), serve the renderer files from `mars-shell://app/` with a CSP header, persist window size | Any other RPC method, any other host, model calls, child processes, renderer-requested file access |
| Preload (`src/preload`, sandboxed) | Expose two frozen objects: `window.marsWorkbench` (15 workbench methods) and `window.marsTeamChat` (9 Team Chat methods), each forwarding over its own IPC channel | Expose `ipcRenderer`, Node, or anything else |
| Renderer (`src/renderer`, Chromium sandbox, `contextIsolation`, no Node) | Build the DOM with `createElement`/`textContent`/`setAttribute` only; project transcripts with `@mars/ui-core`; re-check artifact and exported-patch SHA-256 with WebCrypto before rendering | `innerHTML` and friends (not in its DOM type), inline scripts/styles, network (`connect-src 'none'`), links, images, imports other than its own modules, `@mars/ui-core`, `@mars/output-format`, `@mars/team-chat` (types) |

Workbench bridge methods (the whitelist):
- Read methods (9): `workbench.describe`, `tasks.list`, `tasks.inspect`, `tasks.events`, `tasks.artifact`, `tasks.diff`, `tasks.verification`, `tasks.evidence`, `tasks.journal`.
- Write / lifecycle methods (6): `tasks.create`, `tasks.start`, `tasks.resume`, `tasks.steer`, `tasks.cancel`, `tasks.export`.

Team Chat bridge methods (the whitelist, separate `mars:team-chat` IPC channel): `team.capabilities`, `team.conversations`, `team.messages`, `team.send`, `team.search`, `team.react`, `team.references`, `team.read`, `team.users`.

Anything outside the allowlists is answered `refused` without contacting the workbench.

CSP (header; the `<meta>` copy omits `frame-ancestors`): `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'none'; media-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`.

Main-process hardening: `app.enableSandbox()`, every permission request/check denied, navigation and `window.open` denied, `<webview>` refused, every request outside `mars-shell://app/` cancelled, IPC sender origin validated against `mars-shell://app`, no application menu.

## What the window shows

- **Sidebar**: session switcher from `tasks.list` grouped by status (glyph + word), runtime column (`oh-my-pi`), and an interactive **Team chat** toggle showing the service badge and channel count.
- **Prompt composer**: create new tasks via `tasks.create` with request text, comma-separated acceptance criteria (defaults to the request text if blank), independent read/write/execute approvals, model tier selector (`local` / `paid`), explicit paid-model consent gate, and optional immediate launch.
- **Main pane**:
  - Task header showing task status, host verification state from `tasks.verification` separately (a `completed` task can be `Unverified`), model tier, task revision, and a **Refresh** control.
  - **Approvals & Launch Consent** card on `pending` tasks with independent `read`, `write`, and `execute` toggles, model selection, explicit paid-model consent checkbox (required before `Start task` unlocks for paid models), and `Start task` / `Cancel task` actions.
  - **Lifecycle controls** on `running` tasks (`Steer` instruction composer and `Cancel task`) and `paused` tasks (`Resume task` and `Cancel task`).
  - **Interactive transcript** projected via `projectTranscript` from `@mars/ui-core` (timeline entries, tool/verification/journal summaries, usage totals, and event-cap indicators).
- **Inspector**:
  - Task request and acceptance criteria, host verification verdict and per-check records, and evidence records.
  - **Diff viewer** showing changed files, per-file line stats, unified patch hunks, and patch SHA-256 digest.
  - **Verified patch export** gated on a `pass` host verification verdict, matching candidate revision (`expected_revision`), and exact `expected_patch_sha256`; exported patch bytes are re-verified via WebCrypto SHA-256 before display, and mismatched artifacts are rejected without rendering their bytes.
  - **Artifacts** rendered only after both main-process and renderer WebCrypto SHA-256 checks pass; a mismatch shows `rejected: sha256 mismatch` and no content.
- **Embedded Team Chat pane**: wired through `window.marsTeamChat` (separate from workbench RPC) with channel switching, message history, message composer (`team.send`), emoji reactions (`team.react`), search (`team.search`), reference previews (`team.references`), and read-state tracking (`team.read`). All chat content is rendered via `textContent` with provenance labels.
- **Failure handling**: only `workbench.describe`, `tasks.list` and `tasks.inspect` failures replace the window with an error view, which has a **Retry** button. On retry the main process re-reads the connection file, so a restarted `mars serve` with a new port and token is picked up. `tasks.verification`/`tasks.diff`/`tasks.evidence`/`tasks.events` fail per section (`unavailable · …`). A failed verification read shows `Verification unavailable`, never `Unverified`. `tasks.events` is paged with `after_event_id` until an empty page, up to 1,000 events.
- **Provenance**: every piece of model/repository/workspace/chat text is rendered as data in a quoted block with a visible provenance label (`untrusted · task request`, `untrusted · artifact … · sha256 verified`, `untrusted · exported patch · sha256 verified`, …).

## Run it

Headless unit, security/CSP, static-scan, interactive-flow, and Electron/Xvfb checks (part of `bun run check`; the Electron/Xvfb test runs automatically when Electron and `xvfb-run` are installed):

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

`tasks.checkpoint` / `tasks.restore`, evidence images, settings UI, notification mailbox, workbench selector, packaging/signing/fuses, axe accessibility test. Headless Electron verification runs a real Electron window under Xvfb against the deterministic fixture workbench, never a live model or a live task run.
