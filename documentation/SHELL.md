# MARS Shell (desktop client)

Status: **Desktop preview.** `apps/shell` is an Electron window (`electron@44.10.2`, see `documentation/adr/0001-shell-window-framework.md`) with a conversational Assistant, a task workbench, and a separate Team Chat demo.

## Install and open

1. Sign in to GitHub, open a successful run of [Desktop installers](https://github.com/tanaypatel917-lab/MARS-Send-Youre-AI-To-Space/actions/workflows/desktop.yml), and download and unzip the artifact for your computer:
   - **Mac:** `MARS-macOS-Apple-Silicon` (M-series) or `MARS-macOS-Intel`. Open the disk image, drag MARS to Applications, then open MARS. These preview builds are ad-hoc signed, not Apple-notarized. If Gatekeeper blocks a trusted build, use **System Settings → Privacy & Security → Open Anyway** after trying to launch it. Managed Macs may prohibit this.
   - **Ubuntu/Debian (x64):** `MARS-Ubuntu-Debian-x64`. Open the `.deb` in your package installer and launch MARS from the applications menu. If your distribution has no graphical package installer, use `sudo apt install ./MARS-0.0.1-linux-amd64.deb`.
   - There is no Windows installer.
2. MARS opens a local demo project. Use **Project → Open Project Folder…** for a checkout of your own, or **Project → Open Demo Project** to return. Task state is separate per folder; tasks run on isolated copies, not the selected source files.
3. Open **Settings → Model connection → Add API key** in the sidebar, or click **Connect model** on Chat. Create a key on the [OpenRouter API Keys page](https://openrouter.ai/settings/keys), paste it in **2. Paste your OpenRouter API key**, and click **Save & connect**. Do not paste it in a chat or task. In attach mode there is no settings dialog: set `OPENROUTER_API_KEY` in the environment that launches the desktop app, then restart it. The desktop uses the default free route; provider availability and rate limits apply. The key is saved encrypted when OS-backed storage is available and otherwise kept only for that app session. Switching projects or changing the key restarts the local workbench.

You can browse the workbench and use the **Team chat** demo without a provider key. Team chat contains local sample conversations, not a live team connection; demo messages are not durable.

For a verified patch, choose **Project → Open Verification Example**. Its README describes a small shell-script bug. The composer reports sandbox readiness before you start. If unavailable, use **Project → Set Up Verification Sandbox…**: install/start Docker if needed, then confirm the exact pinned BusyBox image download. This explicit setup is the only image pull; checks run without network access. Start a task with Read, Write and Execute approved and **Amount totals** selected, inspect the fail/pass verdict and diff, then export the verified patch. Protected tests live outside the project; later candidate edits invalidate the verdict and block export. Other projects keep execution disabled unless connected to a separately configured host.

## Add a verified extension

In the installed app, choose **Project → Add Verified Extension**, pick an item, review what it will add to the selected project, then choose **Add to project**. You don't need a model key to install. New tasks in that project can use the extension; other projects are unchanged.

- An **MCP server** supplies a callable tool. **JSON comparison** reports changed paths between supplied documents. **Diff statistics** counts added and removed lines in a supplied unified text patch. **UTC clock** returns the current UTC time. These tools need no credentials or network connection and do not open project files. Their project grants expire after 30 days; add an item again to renew.
- A **skill** supplies instructions, not executable code. Choose **Bug triage**, **Code review**, **Test planning**, **Change summary**, or **Test handoff** for focused guidance on the corresponding task.
- A **plugin** groups extensions into a single install. The **Bug investigation kit** combines triage and test planning; the **Pull request review kit** adds review, test planning, and test handoff; the **Release handoff kit** combines change summary and test handoff. Shared skills are reused and customized content is never replaced silently.

Two optional upstream reference servers are bundled, not downloaded on Add:
- **Filesystem · project browser** (2.4.0): lists file and directory names, including hidden names, and can return the selected project’s absolute path. Approval binds the canonical directory and its device, inode and birth time. If the folder is replaced, reopen it and approve the new one. The stdio server receives only that approved root, in read-only mode; only `list_allowed_directories` and `list_directory` are granted.
- **Sequential Thinking** (2.2.0): tracks supplied steps and branches in memory per connection. Thought logging is disabled; it requires no key.

Both npm packages have provenance from the [upstream release](https://github.com/modelcontextprotocol/servers/tree/c799c8552b0f27b7a33a7b9233773da144dddcf5). Packaging builds standalone files from the frozen Bun dependency graph, inlines the upstream package version, and checks the final SHA-256. The [upstream license](https://github.com/modelcontextprotocol/servers/blob/c799c8552b0f27b7a33a7b9233773da144dddcf5/LICENSE) covers MIT and Apache-2.0 contributions; the installer includes the [license texts and dependency notices](../apps/shell/src/runtime/catalog/THIRD-PARTY-NOTICES.txt). No cloud, browser, remote HTTP, or credentialed integrations are included.

An expired MCP stays in the catalog with a renewal notice; adding it again requires approval. A task encountering an expired MCP triggers a desktop renewal notice. To restore a customized active skill, add the skill or kit again and explicitly confirm **Restore bundled instructions**; cancel leaves your edits untouched. The prior content remains in the skill's version history.

Here, **verified** means the payload matches a SHA-256 pin in the catalog shipped with MARS. It is not third-party certification. There are no remote downloads or custom URLs/commands. Adding any MCP requires explicit approval; the workbench checks the grant and artifact on use. In attach-only mode the external workbench, not the shell, manages its own extensions.

## Remove a project extension

Choose **Project → Remove Project Extension…**, select an added item, and review the confirmation. Cancel makes no changes. Removal applies only to the open project; the bundled catalog stays available to add from again.

- **MCP server:** revokes any live approval and removes the project registration, including if approval has expired. Later calls are denied. The approval history and other projects’ grants stay.
- **Skill or plugin:** archives unchanged instructions supplied only by this item. The dialog names any skills that stay active because they are shared, customized, pinned, or predate the install. Removing a kit does not delete skill history or undo instructions already given to a running task.
- **Older installs:** previous versions did not record a separate Add when a skill already existed. Members of an older kit are kept as individual skills rather than guessed to be unused. You can remove those skills individually.

## No second agent loop

The Assistant makes one text completion per send. It cannot read files, run commands, edit the workspace or start tasks. **Make a task** copies a reply to the task composer; nothing runs until you choose to start the task. Oh My Pi inside the workbench is the only agent runtime. The installed Shell starts one bundled Bun workbench on an ephemeral loopback port and stops it on teardown; development Shell can still attach to `mars serve`. The renderer never receives the RPC bearer token and cannot spawn processes or access the file system. `tasks.checkpoint` and `tasks.restore` remain refused by the shell bridge.

## Process model

| Process | What it may do | What it may not do |
| --- | --- | --- |
| Main (`src/main`, Node) | Supervise the bundled workbench, accept native folder selection, handle model settings through a separate settings window, send consented chat messages to the fixed OpenRouter route, store completed turns locally per project, hold the bearer token from the private connection file, and forward strictly validated workbench and Team Chat methods over separate IPC channels. Serve exact allowlisted assets from `mars-shell://app/` with CSP and persist window size. | Arbitrary RPC or provider endpoints, remote workbench hosts, or renderer-supplied file paths or commands |
| Preload (`src/preload`, sandboxed) | Expose `window.marsWorkbench` (15 workbench methods), `window.marsTeamChat` (9 Team Chat methods), `window.marsAssistant` (load, send, model settings), and, in managed mode, `window.marsExtensions` (list bundled entries and request installation by ID) as frozen objects on separate IPC channels | Expose `ipcRenderer`, Node, or anything else |
| Renderer (`src/renderer`, Chromium sandbox, `contextIsolation`, no Node) | Build the DOM with `createElement`/`textContent`/`setAttribute` only; project transcripts with `@mars/ui-core`; re-check artifact and exported-patch SHA-256 with WebCrypto before rendering | `innerHTML` and friends (not in its DOM type), inline scripts/styles, network (`connect-src 'none'`), links, images, imports other than its own modules, `@mars/ui-core`, `@mars/output-format`, `@mars/team-chat` (types) |

Workbench bridge methods (the whitelist):
- Read methods (9): `workbench.describe`, `tasks.list`, `tasks.inspect`, `tasks.events`, `tasks.artifact`, `tasks.diff`, `tasks.verification`, `tasks.evidence`, `tasks.journal`.
- Write / lifecycle methods (6): `tasks.create`, `tasks.start`, `tasks.resume`, `tasks.steer`, `tasks.cancel`, `tasks.export`.

Team Chat bridge methods (the whitelist, separate `mars-shell:team-chat` IPC channel): `team.state`, `team.open`, `team.send`, `team.markRead`, `team.setPinned`, `team.setReaction`, `team.resolveReference`, `team.search`, `team.switchViewer`.

Anything outside the allowlists is answered `refused` without contacting the workbench.

CSP (header; the `<meta>` copy omits `frame-ancestors`): `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'none'; media-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`.

Main-process hardening: `app.enableSandbox()`, every permission request/check denied, navigation and `window.open` denied, `<webview>` refused, every request outside `mars-shell://app/` cancelled, and IPC sender origin validated against `mars-shell://app`. Only the sandboxed Model Settings window can submit a credential; it never receives the stored credential.

## What the window shows

- **Chat**: choose or start a conversation. Sending shares that conversation with OpenRouter, not your project files. Completed turns are saved in a project-scoped SQLite database under Electron user data, separate from key storage.
- **Chat vs task**: the empty Chat screen explains that Chat only talks and plans while a task edits the project, runs checks and returns a patch. **Start a coding task** (toolbar and welcome screen) opens the task composer, carrying over any Chat draft; nothing runs until the task is started. If the carried text replaces a different unsaved task request, the composer offers **Restore earlier request**.
- **Model health and cost**: the Chat composer shows the free route's last result (`Responding`, `Rate-limited`, `Key rejected`, `Needs credits`, `Unreachable`, `Unavailable`). Failed sends say what to do next, including OpenRouter's `Retry-After` wait when given. Chat is free but rate-limited; paid models are only used by tasks with explicit consent, within the task budget.
- **Setup diagnostics** (Settings): model key, chat model health, verification-check readiness, and local pilot progress (first open, key connected, first chat reply, first task created/started, first verified export) plus counts of provider failures. The record is `setup-journal.json` under Electron user data, holds only timestamps and counts, and is never sent anywhere.
- **Extensions**: view verified MCP servers, skills and plugins and their permissions when a catalog is available. Installed extensions apply to new agent tasks, not Assistant chat.
- **Sidebar**: session switcher from `tasks.list` grouped by status (glyph + word), runtime column (`oh-my-pi`), and an interactive **Team chat** toggle showing the service badge and channel count.
- **Prompt composer**: create new tasks via `tasks.create` with request text, comma-separated acceptance criteria (defaults to the request text if blank), independent read/write/execute approvals, model tier selector (`local` / `paid`), explicit paid-model consent gate, sandbox readiness with setup guidance, host checks selected by id from `workbench.describe.checks` (sent as `required_checks` on `tasks.start`; Execute approval required, and a run with no checks records no verdict and cannot be exported), and optional immediate launch.
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
- **Embedded Team Chat pane**: wired through `window.marsTeamChat` (separate from workbench RPC) with conversation state and viewer switching (`team.state`, `team.switchViewer`), cursor-paginated history (`team.open` with `before`), message composer (`team.send`; an oversized or rejected message keeps the draft editable), pins (`team.setPinned`), emoji reactions (`team.setReaction`), search (`team.search`), reference previews (`team.resolveReference`), and read-state tracking (`team.markRead`). All chat content is rendered via `textContent` with provenance labels.
- **Failure handling**: `workbench.describe`, `tasks.list` and `tasks.inspect` failures show a workbench error and **Retry**. Chat stays visible. A failed conversation load separately offers **Retry chat**. On retry the main process re-reads the connection file, so a restarted `mars serve` with a new port and token is picked up. `tasks.verification`/`tasks.diff`/`tasks.evidence`/`tasks.events` fail per section (`unavailable · …`). A failed verification read shows `Verification unavailable`, never `Unverified`. `tasks.events` is paged with `after_event_id` until an empty page, up to 1,000 events.
- **Provenance**: Team messages identify their author above inert text; references retain their own provenance. Other model/repository/workspace text is rendered as data in a quoted block with a visible provenance label (`untrusted · task request`, `untrusted · artifact … · sha256 verified`, `untrusted · exported patch · sha256 verified`, …).

## Build it

Desktop typography uses Manrope for headlines, Inter for controls and body copy, Barlow Condensed SemiBold for UI numbers, and Commit Mono for technical metadata. The unmodified variable Latin WOFF2 files come from Fontsource’s `@fontsource-variable/manrope` and `@fontsource-variable/inter` 5.2.5. The numeral face comes from `@fontsource/barlow-condensed` 5.2.6. All four faces ship with their SIL Open Font License 1.1 and copyright notices; neither build nor runtime needs a font CDN.

On macOS or Debian/Ubuntu with the pinned Bun version, run `bun install --frozen-lockfile --ignore-scripts`, `bun run --cwd apps/shell native:install`, then `bun run --cwd apps/shell package`. Installers are in `apps/shell/dist/installers`. The packager smoke-tests the bundled Bun, authenticated workbench RPC, and Oh My Pi native session before producing the installer.

## Run from source

Headless unit, security/CSP, static-scan, interactive-flow, and Electron/Xvfb checks (part of `bun run check`; the Electron/Xvfb test runs when Electron and `xvfb-run` are installed, and CI installs both, makes `chrome-sandbox` a setuid-root helper so the sandbox starts under Ubuntu 24.04's user-namespace restriction, and sets `MARS_REQUIRE_ELECTRON_XVFB=1` so a missing binary fails instead of skipping):

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

The development connection file is chosen by `--connection=PATH`, then `MARS_SHELL_CONNECTION`, then the single `~/.mars/workbench/*/connection.json`. An explicit connection opens the same attach-only mode in a packaged app. On a Linux host without unprivileged user namespaces or a setuid `chrome-sandbox` the Chromium sandbox cannot start; the Shell never disables it in code.

## Not in this build

`tasks.checkpoint` / `tasks.restore`, evidence images, notification mailbox, Apple notarization or auto-updates, and an axe accessibility test. Automated desktop verification does not use a live model.
