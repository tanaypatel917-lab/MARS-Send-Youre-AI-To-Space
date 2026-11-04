# Codex CLI (openai/codex) — UI research study

| | |
|---|---|
| Product | OpenAI Codex CLI (`codex`), repo https://github.com/openai/codex |
| Version run | `codex-cli 0.166.0` — GitHub release `rust-v0.166.0`, asset `codex-x86_64-unknown-linux-musl.tar.gz` |
| Source studied | tag `rust-v0.166.0` = commit `6ff1e1ca3b30fc8b914720681fcf5fe62e95f856` (2026-10-29). Links below use `S = https://github.com/openai/codex/blob/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/` |
| License | Apache-2.0 (SPDX `Apache-2.0`), `S/LICENSE` |
| Date | 2026-11-03 (UTC) |
| Ran | binary in an `xterm` on the Devin VM with a fresh `CODEX_HOME` and no OpenAI login; then with an invalid API key to reach the main screen (`/status`, `/model`, `/permissions`, `@`, `/`, `?`, F2, Ctrl+C, 401 error path). `codex --help`, `codex --version`, `codex doctor`, `codex exec`, `codex sandbox`, `codex review --help`, `codex resume --help`, `codex mcp --help`, `codex features list`. |
| Read | `codex-rs/{tui,core,protocol,apply-patch,rollout,linux-sandbox,exec,hooks}` and the insta snapshot files under `codex-rs/tui/src/**/snapshots/` (these are the rendered TUI, byte-exact, so they are treated as `[source]`); official docs at developers.openai.com/codex (Markdown twins at `https://learn.chatgpt.com/docs/<slug>.md`, read 2026-11-03); repo README. |
| Not run | anything that needs a valid OpenAI account: real turns, approval prompts, patches, review, resume picker, rate-limit display. Those are `[source]`/`[docs]`. |

Evidence tags: `[ran]` observed on the running binary · `[source]` read in code/snapshots at the pinned commit · `[docs]` official docs · `[third-party]` none used. "not verified" = could not confirm.

Notable version drift vs. the question list: in 0.166.0 there is no `--full-auto`, no `/approvals`, no `/transcript`, no `untrusted`/`on-failure` CLI values and no `codex://review` link; the replacements are documented below.

---

## 1. Approval modes and sandbox

- `[ran]` `codex --help` offers `-a, --ask-for-approval <APPROVAL_POLICY>` with only two values: `on-request` — "The model decides when to ask the user for approval" and `never` — "Never ask for user approval. Execution failures are immediately returned to the model". `-s, --sandbox <SANDBOX_MODE>` values: `read-only`, `workspace-write`, `danger-full-access`.
- `[source]` `S/codex-rs/protocol/src/protocol.rs` L1145–1168 `enum AskForApproval`: `UnlessTrusted` (serde `"untrusted"`, doc: "Internal policy for projects marked untrusted. Commands require approval unless an explicit exec policy rule allows them."), `OnRequest` (default; `#[serde(alias = "on-failure")]` — the old `on-failure` is accepted as an alias), `Granular(GranularApprovalConfig { sandbox_approval, rules, skill_approval, request_permissions, mcp_elicitations })`, `Never`.
- `[docs]` agent-approvals-security.md: `approval_policy = "untrusted"` is retired ("Codex ... no longer support approval_policy = \"untrusted\""); use `[projects."/path"] trust_level = "untrusted"` instead. The "Auto" preset is `--sandbox workspace-write --ask-for-approval on-request`. Network is off by default inside the sandbox.
- `[source]` `S/codex-rs/protocol/src/protocol.rs` L1231–1279 `enum SandboxPolicy`: `DangerFullAccess` ("No restrictions whatsoever. Use with caution."), `ReadOnly { network_access }`, `ExternalSandbox { network_access }` ("the process is already in an external sandbox"), `WorkspaceWrite { writable_roots, network_access, exclude_tmpdir_env_var, exclude_slash_tmp }`.
- **Preset names shown in the TUI** `[source]` `S/codex-rs/tui/src/chatwidget/snapshots/codex_tui__chatwidget__tests__profile_permissions_selection_popup.snap` (`/permissions`):
  ```
  Update Model Permissions
  › 1. Ask for approval (current)  Read and edit workspace files and run commands,
                                   with approval required for internet access or
                                   edits outside the workspace
    2. Approve for me              Only ask for actions detected as potentially
                                   unsafe
    3. Full Access                 Use with caution: Codex can edit files outside
                                   this workspace and access the internet without
                                   approval
    4. Read Only                   Read workspace files, with approval required
                                   for edits or internet access
  enter select · esc back
  ```
  `[ran]` the same picker appeared on 0.166.0 (screenshot `08-permissions-picker.png`). "Suggest / Auto Edit / Full Auto" do not appear anywhere in the 0.166.0 TUI source (grep) — historical only, not verified here.
- Choosing Full Access opens a second confirm `[source]` `...__full_access_confirmation_popup.snap`: "Enable full access?" / "When Codex runs with full access, it can edit any file on your computer and run commands with network, without your approval. Exercise caution when enabling full access. This significantly increases the risk of data loss, leaks, or unexpected behavior." / "1. Yes, continue anyway  Apply full access for this session" / "2. Cancel  Go back without enabling full access".
- **How the active mode is indicated** `[ran]` `/status` prints `Permissions:  Workspace (Ask for approval)`; `[source]` status snapshots also show `Custom (workspace with network access, Ask for approval)`. The persistent footer status line does **not** show the permission mode; it shows `<model> <effort> · <cwd>` (e.g. `GPT-6.1-Sol default · ~/codex-study/proj`) `[ran]`. `codex exec` prints `approval: never` / `sandbox: workspace-write [workdir, /tmp, $TMPDIR]` in its header `[ran]`.
- **Flags** `[ran]` `--full-auto` does not exist in 0.166.0 (`grep full-auto codex-rs/cli codex-rs/common` → nothing `[source]`). Present: `--dangerously-bypass-approvals-and-sandbox` ("Skip all confirmation prompts and execute commands without sandboxing. EXTREMELY DANGEROUS. Intended solely for running in environments that are externally sandboxed"), `--approve-for-me` ("Route approval requests through automatic review using the workspace-write sandbox" — an LLM auto-reviewer, see docs sandboxing_auto-review.md `[docs]`), `--dangerously-bypass-hook-trust`, `--add-dir`.
- **Sandbox implementation** `[source]` Linux = bubblewrap + seccomp (`S/codex-rs/linux-sandbox/src/{bwrap.rs,bundled_bwrap.rs,seccomp.rs,launcher.rs}`), Landlock only referenced in `linux_run_main.rs`/`seccomp.rs`; macOS = Seatbelt (`[docs]` developer-commands.md "macOS seatbelt"); Windows = elevated sandbox via `/setup-default-sandbox`. `[ran]` `codex sandbox linux --help` panicked: `bubblewrap is unavailable: no system bwrap was found on PATH and no bundled codex-resources/bwrap binary was found next to the Codex executable`. `[ran]` The TUI surfaces sandbox health as a startup **warning** (footer badge `⚠ 1 warning · f2 to view`; F2 view: "Warnings · 1 of 1 · Startup / Codex could not find bubblewrap on PATH. Install bubblewrap with your OS package manager. See the sandbox prerequisites: https://developers.openai.com/codex/concepts/sandboxing#prerequisites. Codex will use the bundled bubblewrap in the meantime." footer `k keep & next · esc dismiss & close · ^o copy · ←/→ warning`, screenshot `11-warnings.png`). The sandbox kind (seatbelt/bwrap) is otherwise not displayed in the UI.
- **Sandbox denial** `[source]` `S/codex-rs/core/src/tools/orchestrator.rs` L632–644: a sandboxed command that fails with `SandboxErr::Denied` (also `Timeout`, `Signal`) under `on-request` re-asks the user with reason string `"command failed; retry without sandbox?"`, rendered in the normal command-approval modal as `Reason: command failed; retry without sandbox?`. Under `never` the failure is returned to the model.

## 2. Approval prompt UI

- **Command approval** `[source]` `S/codex-rs/tui/src/chatwidget/snapshots/codex_tui__chatwidget__tests__approval_modal_exec.snap` (80 cols):
  ```
  Would you like to run the following command?

  Reason: this is a test reason such as one that would be produced by the model

  $ echo hello world

  › 1. Yes, proceed (y)
    2. Yes, and don't ask again for commands that start with `echo hello world` (p)
    3. No, and tell Codex what to do differently (esc)

  Press enter to confirm or esc to cancel
  ```
  Title bold; `Reason:` italic; command shown as a `$ `-prefixed shell line; selected row BOLD|REVERSED; key letters in `( )` bold; hint line dim (styles from the snapshot buffer).
- **Full option vocabulary** `[source]` `S/codex-rs/tui/src/bottom_pane/approval_overlay.rs`: exec — `Yes, proceed` (`Yes, just this once` for network), `Yes, and don't ask again for commands that start with \`<prefix>\``, `Yes, and don't ask again for this command in this session`, `Yes, and allow these permissions for this session`, `Yes, and allow this host for this conversation`, `Yes, and allow this host in the future`, `No, and block this host in the future`, `No, continue without running it`, `No, and tell Codex what to do differently`. Network variant title: `Do you want to approve network access to "example.com"?` with `Reason: network request blocked` (snapshot `...approval_overlay__tests__network_exec_prompt.snap`). Additional-permission variant adds a line `Permission rule: network; read \`/tmp/readme.txt\`; write \`/tmp/out.txt\`` (`...approval_overlay_additional_permissions_prompt.snap`). Permission requests: `Yes, grant these permissions for this turn`, `Yes, grant for this turn with strict auto review` (r), `Yes, grant these permissions for this session`, `No, continue without permissions`. MCP elicitation: `Yes, provide the requested info`, `No, but continue without it`, `Cancel this request`.
- **Patch approval** `[source]` `...__approval_modal_patch.snap`: title `Would you like to make the following edits?`, `Description: <model text>`, `Destination: /tmp/project/README.md`, then the rendered diff, options `1. Yes, proceed (y)`, `2. Yes, and don't ask again for these files (a)`, `3. No, and tell Codex what to do differently (esc)`.
- **Keyboard** `[source]` number keys and the shown letter select directly; Enter confirms the highlighted row; Esc always maps to the "No, and tell Codex…" option; keys are configurable via the approval keymap (`approval_overlay.rs`, `keymap.rs`). Choosing "tell Codex what to do differently" drops the user into the composer to type feedback that becomes the next user message (`approval_overlay.rs`).
- **Transcript record** `[source]` `S/codex-rs/tui/src/history_cell/approvals.rs`: approved → green `✔ ` + `You approved codex to run <cmd>` / `You approved this request this time` / `You approved this request every time this session`; denied → red `✗ ` + `You did not approve …` (bold "did not approve"). An interrupted/aborted exec renders as `• Ran sleep 1` / `└ (no output)` (`...__interrupt_exec_marks_failed.snap`).

## 3. `apply_patch` format and rendering

- **Grammar** `[source]` `S/codex-rs/apply-patch/src/parser.rs` header (Lark grammar reproduced in the doc comment):
  ```
  start: begin_patch environment_id? hunk+ end_patch
  begin_patch: "*** Begin Patch" LF
  environment_id: "*** Environment ID: " filename LF
  end_patch: "*** End Patch" LF?
  hunk: add_hunk | delete_hunk | update_hunk
  add_hunk: "*** Add File: " filename LF add_line+
  delete_hunk: "*** Delete File: " filename LF
  update_hunk: "*** Update File: " filename LF change_move? change?
  add_line: "+" /(.+)/ LF
  change_move: "*** Move to: " filename LF
  change: (change_context | change_line)+ eof_line?
  change_context: ("@@" | "@@ " /(.+)/) LF
  change_line: ("+" | "-" | " ") /(.+)/ LF
  eof_line: "*** End of File" LF
  ```
  Marker constants `BEGIN_PATCH_MARKER` … `EMPTY_CHANGE_CONTEXT_MARKER`; parsing is always lenient (`PARSE_IN_STRICT_MODE = false`, comment: for gpt-4.1). `@@` context is matched by content (`seek_sequence.rs`), not by line numbers. The crate ships a standalone binary (`standalone_executable.rs`) and `codex apply` applies a patch from stdin `[ran]` (`codex --help`).
- **Rendering** `[source]` `S/codex-rs/tui/src/diff_render.rs` + snapshots `S/codex-rs/tui/src/snapshots/codex_tui__diff_render__tests__*.snap`:
  ```
  • Edited example.txt (+1 -1)
      1  line one
      2 -line two
      2 +line two changed
      3  line three
  ```
  ```
  • Edited 6 files (+9 -9)
    └ assets/banner.txt (+3 -0)
      1 +HEADER    VALUE
      2 +rocket    🚀
    └ examples/new_sample.rs (+3 -0)
    └ legacy/old_script.py (+0 -3)
    └ scripts/calc.txt → scripts/calc.py (+1 -1)
  ```
  Summary line `Edited <file>` / `Edited N files (+a -b)` (bold file names), per-file `└ path (+a -b)`, renames as `old → new`, right-aligned line numbers, `+`/`-`/space gutter, vertical ellipsis between non-adjacent hunks (`...vertical_ellipsis_between_hunks.snap`), long lines wrapped to width (`...wraps_long_lines`). Colours: additions `Color::Green`, deletions `Color::Red`; with true-colour a `DiffTheme::{Light,Dark}` background tint is added, `DiffColorLevel::{Ansi16,Ansi256,TrueColor}` fall back to plain fg (L1289–1357). Collapsed vs full: the history cell shows the summary + per-file lines; full hunks are in the patch-approval modal and in the transcript overlay (Ctrl+T). `/diff` shows `git diff` including untracked files `[docs]`.

## 4. Transcript and composer layout

- **History cell taxonomy** `[source]` `S/codex-rs/tui/src/history_cell/`: `messages.rs` (user, agent, reasoning summary), `exec.rs` + `exec_cell/` (commands, "Explored" groups), `patches.rs`, `approvals.rs`, `mcp.rs`/`mcp_result.rs`/`mcp_preview.rs`, `plans.rs`, `notices.rs`, `warnings.rs`/`startup_warnings.rs`, `request_user_input.rs`, `async_questions.rs`/`async_replies.rs`, `search.rs`, `session.rs` (session header), `separators.rs`, `hook_cell.rs`, `computer_activity.rs`, `activity_*.rs`. Prefix glyphs: user `› ` (bold dim; red-bold variant) , agent `• ` (dim) , error `■ `, warning `⚠ `, approved `✔ `, denied `✗ `, tree child `└ `.
- **Agent/tool cells** `[source]` `...chatwidget_exec_and_status_layout_vt100_snapshot.snap`:
  ```
  • I'm going to search the repo for where "Change Approved" is rendered …
  • Explored
    └ Search Change Approved
      Read diff_render.rs
  • Investigating rendering code (0s • esc to interrupt)
  › Summarize recent commits
    tab to queue message                                       100% context left
  ```
  Read-only commands are grouped under bold `Explored` with sub-rows `Read <file>`, `List <path>`, `Search <pattern>`; other commands render as `• Ran <cmd>` with output below (`exec_cell/render.rs` L331–480).
- **Truncation** `[source]` `exec_cell/render.rs` L43–44: model command output preview `TOOL_CALL_MAX_LINES = 5`, user `!` shell commands `USER_SHELL_TOOL_CALL_MAX_LINES = 50`, live streaming preview `LIVE_COMMAND_OUTPUT_MAX_LINES = 50` (`exec_cell/live_output.rs`). Middle truncation with a dim line `… +N lines (⌃t to view transcript)`. Full output lives in the transcript overlay (Ctrl+T, F3 find, PgUp/PgDn, Ctrl+Home/End); `/raw` toggles raw scrollback mode (`/transcript` does not exist in 0.166.0; the pager titles are spaced-letter, e.g. `S T A T I C`, `pager_overlay.rs`).
- **Reasoning** `[source]` `messages.rs` L833–870: reasoning summaries are created `transcript_only = true` — not shown in the main history; the summary's leading `**bold**` header becomes the status-indicator header (e.g. `• Investigating rendering code`).
- **Status indicator** `[source]` `S/codex-rs/tui/src/status_indicator_widget.rs`: header default `Working`, format `• <Header> (<elapsed> • esc to interrupt)`, elapsed `Ns`/`MmSs`/`HhMmSs` (`fmt_elapsed_compact`), optional suffix. `[ran]` during retries: `◦ Reconnecting... 5/5 (7s • esc to interrupt)`. The header text is animated with `shimmer.rs`: 2-second sweep, band half-width 5 chars, cosine blend from default fg toward default bg, RGB+bold under true colour, plain fallback otherwise; master switch `animations = false`, per-effect `tui_effects`.
- **Composer** `[ran]` `› Ask Codex to do anything` placeholder; typed text keeps the `› ` prompt; `!` prefix switches to shell mode (`! git status`, footer right `Shell mode`) `[source]`; `@` opens mentions; `/` opens commands.
- **Queued messages** `[docs]` developer-commands.md: Tab while Codex is working queues a follow-up prompt/slash command/shell command for the next turn; Enter while working *injects* into the current turn. `[source]` footer hint `tab to queue message`; queued items are editable via `⇧←`/`⌥↑` (`edit_queued_message`) and `⇧→`/`⌥↓` (`prompt_stack_back`), `keymap.rs`; snapshots `...compact_queues_user_messages_snapshot.snap`, `...review_queues_user_messages_snapshot.snap` show queued prompts held while `/compact`/`/review` run.
- **Footer** `[ran]` two-line footer: status line `GPT-6.1-Sol default · ~/codex-study/proj` (model cyan, effort, path green) then hints `? for shortcuts` left and `⚠ 1 warning · f2 to view` right. `[source]` variants: `? for shortcuts … 100% context left` (empty composer), `tab to queue message … 98% context left`, `⌃c again to quit`, `esc esc to edit previous message`, `esc again to edit previous message`, `reverse-i-search: c  enter accept · esc cancel`, right-side `Goal paused (/goal resume)`; alternate status-line format `gpt-5.4 xhigh fast · Context 100% left · /tmp/project` (`/statusline` configurable).

## 5. AGENTS.md

- `[docs]` guides/agents-md (learn.chatgpt.com/docs/agent-configuration/agents-md.md): global scope `$CODEX_HOME/AGENTS.override.md` else `AGENTS.md` (first non-empty); project scope walks project root → cwd, per directory `AGENTS.override.md`, then `AGENTS.md`, then `project_doc_fallback_filenames`; one file per directory; concatenated root-first with blank lines; empty files skipped; combined cap `project_doc_max_bytes` default 32 KiB; rebuilt each run. Example: `project_doc_fallback_filenames = ["TEAM_GUIDE.md", ".agents.md"]`, `project_doc_max_bytes = 65536`.
- `[source]` `S/codex-rs/core/src/agents_md.rs` L43–45 `DEFAULT_AGENTS_MD_FILENAME = "AGENTS.md"`, `LOCAL_AGENTS_MD_FILENAME = "AGENTS.override.md"`; L273–288 candidate list = those two + fallbacks (non-filename entries are warned and ignored).
- **UI** `[ran]` `/status` line `Agents.md:  <none>` (lists file paths when present per status snapshots `[source]`); `/init` "Generate an AGENTS.md scaffold in the current directory" `[docs]`. Nothing else in the main transcript announces loaded instructions.

## 6. Model and reasoning pickers

- `[ran]` `/model` → `Select Model and Effort` list, screenshot `09-model-picker.png`:
  ```
  › 1. GPT-6.1-Sol (current)  Latest workhorse model for coding and everyday work.
    2. GPT-6-Astra            Frontier intelligence for the most demanding work.
    3. GPT-6-Sol              Previous generation workhorse model.
    4. GPT-6-Luna             Fast and affordable model for easier tasks.
    5. GPT-5.6-Sol            Older generation workhorse model.
    6. GPT-6.1 Terra          GPT-6.1 Terra Codex model.
    7. GPT-5.6-Terra          Older balanced model for straightforward work.
    8. GPT-5.6-Luna           Older fast and efficient model.
  ↓
  enter select · esc back
  ```
  (model list comes from the server's model catalog; `(current)` marks the active one; `↓` shows overflow.)
- `[source]` `...__model_reasoning_selection_popup.snap`: `Select Reasoning Level for GPT-5.5` → `1. Low  Fast responses with lighter reasoning`, `2. Medium (default)  Balances speed and reasoning depth for everyday tasks`, `› 3. High (current)  Greater reasoning depth for complex problems`, `4. Extra high  Extra high reasoning depth for complex problems`, `5. Persistent  Continue working until put to sleep`, `6. More reasoning…  Max and Ultra consume usage limits faster`; footer `enter default · s session · esc back` (Enter persists as default, `s` applies to this session only). Warning line `⚠ Consumes usage limits faster` (cyan) for Max/Ultra (`model_popups.rs` L702). `⌥,`/`⌥.` step effort down/up from the composer (`keymap.rs`).
- **Config keys** `[docs]` config-reference: `model`, `model_reasoning_effort` (`low|medium|high|xhigh`…), `model_reasoning_summary` (`"none"` disables), `model_verbosity` (`low|medium|high`, Responses API providers only), `[models.new_thread].model_reasoning_effort`, `service_tier` (Fast mode, `/fast` = "2x speed, increased usage" `[ran]`). **Profiles** `[docs]` config-advanced: since 0.134.0 `--profile <name>` reads a profile *file*, not `[profiles.<name>]` in `config.toml`, and the top-level `profile = ` selector is gone.
- `[ran]` `/status` shows `Model: GPT-6.1-Sol (reasoning low, summaries auto)` and the footer shows `GPT-6.1-Sol default`.

## 7. Session resume and forking

- `[ran]` `codex resume [SESSION_ID|name] [PROMPT] --last --all --include-non-interactive`; `codex fork --last --all`; also `codex archive|unarchive|delete`, `codex migrate-rollouts`.
- `[source]` storage: `$CODEX_HOME/sessions/` and `archived_sessions/` (`S/codex-rs/rollout/src/lib.rs` L86–87, `SESSIONS_SUBDIR`, `ARCHIVED_SESSIONS_SUBDIR`); rollouts are JSONL (`auto-review-rollout-<thread_id>.jsonl` naming in `chatwidget.rs` L1066; `codex exec --json` streams the same event model). Session id is a UUIDv7 shown in `/status` (`Session: 01a19f44-…`) `[ran]`.
- **Picker** `[source]` `S/codex-rs/tui/src/resume_picker.rs`: header `Resume a previous session`; layout `header / toolbar / search / list / footer` (`resume_picker/layout.rs`, 7 fixed chrome rows, min 6 list rows); rows are title + date in dense columns, with a cwd column when `--all`; sort key column header `Created` or `Updated` (L917–922); Ctrl+T toggles a transcript preview of the highlighted session (`keymap/chords.rs` `resume_picker.toggle_transcript`). Exact column order/ordering direction: not verified at runtime.
- `/new` "Start a new chat inside the same CLI session", `/fork` "Fork the current chat into a new chat", `/resume` "Resume a saved chat from your session list", `/rename`, `/archive`, `/delete`, `/clear` (new chat + clear screen; Ctrl+L only clears the view) `[docs]`. Esc Esc on an empty composer edits the previous user message and **forks** the chat from that point `[docs]` `[source]` footer hints.

## 8. Review flow and link schemes

- `[ran]` `codex review [PROMPT] --uncommitted | --base <BRANCH> | --commit <SHA> | --title <TITLE>`.
- `[source]` `/review` popup `S/codex-rs/tui/src/chatwidget/review_popups.rs`: `Review against a base branch` `(PR Style)`, `Review uncommitted changes`, `Review a commit`, `Custom review instructions`.
- **Presentation** `[source]` `chatwidget.rs` L1310/1322: transcript banners `>> Code review started: <hint> <<` and `<< Code review finished >>`; findings arrive as a normal agent message (markdown) — no dedicated findings widget found. Queued user prompts are held during review (`...review_queues_user_messages_snapshot.snap`).
- **`codex://` links** `[source]` only two schemes exist at this tag: `codex://threads/new?path=<urlencoded cwd>` (`S/codex-rs/cli/src/desktop_app/mac.rs` L156, `windows.rs` L73 — used by `/app` to hand off to the ChatGPT desktop app) and `codex://threads/<thread_id>` (`S/codex-rs/tui/src/app/history_ui.rs` L288). **There is no `codex://review?...` link and no follow-up/"writing-block" syntax** in the TUI source (grep `codex://`). `/status` renders `https://chatgpt.com/settings/usage` as an OSC-8 hyperlink `[ran]` (underlined in xterm).

## 9. Slash commands and popups

- `[source]` `S/codex-rs/tui/src/slash_command.rs` enum (popup order): `/model /presets /daybreak /ide /permissions /keymap /vim /setup-default-sandbox /experimental /approve /memories /skills /import /hooks /review /rename /new /archive /delete /resume /fork /worktree /app /init /compact /config /recap /plan /voice /goal /agents /side /btw /copy /export /raw /tui /diff /mention /status /daemon /warnings /cd /pwd(/cwd) /usage /debug-config /title /statusline /theme /pets /mcp /apps /plugins /logout /quit /exit /feedback /rollout /ps /stop(/clean) /clear /test-approval /subagents` (+ debug entries). Not present: `/approvals`, `/transcript`. `/fast` also appears in the live popup `[ran]`.
- `[ran]` popup (screenshot `07-slash-popup.png`): `› /model  choose what model and reasoning effort to use`, `/fast  2x speed, increased usage`, `/presets  run or save reusable prompts and slash commands`, `/daybreak  Manage broader access for cybersecurity work`, `/ide  include current selection, open files, and other context from your IDE`, `/permissions  choose what Codex is allowed to do`, `/keymap  remap TUI shortcuts`, `/vim  toggle Vim mode for the composer` — 8 rows, selected row inverse, descriptions dim, filtered as you type; Tab queues a slash command while a turn runs `[docs]`; `■ '/resume' is disabled while a task is in progress.` `[source]`.
- **`@` mentions** `[ran]` screenshot `10-mention-popup.png`: title `Mentions`, subtitle `Files, directories, plugins, skills and tasks`, tabs `All Results | Filesystem Only | Plugins` (←/→), placeholder `Type to search mentions`, rows `name  description  <Kind>` (kind right-aligned: `Skill`, `Plugin`), footer `enter/tab insert · esc close · ↑/↓ select · ←/→ filter`. Fuzzy file search is `S/codex-rs/file-search/`.

## 10. `/status`, context indicator, rate limits

- `[ran]` 0.166.0 `/status` (screenshot `04-status-output.png`):
  ```
  >_ OpenAI Codex (v0.166.0)
  Visit https://chatgpt.com/settings/usage for up-to-date information on rate limits and credits
  Model:              GPT-6.1-Sol (reasoning low, summaries auto)
  Model provider:     openai
  Directory:          ~/codex-study/proj
  Permissions:        Workspace (Ask for approval)
  Agents.md:          <none>
  Account:            API key configured (run codex login to use ChatGPT)
  Collaboration mode: Default
  Session:            01a19f44-9436-7522-b918-ded2bd0e38de
  Token usage:        0 total  (0 input + 0 output)
  Limits:             data not available yet
  ```
- `[source]` with a ChatGPT account (`S/codex-rs/tui/src/status/snapshots/codex_tui__status__tests__status_snapshot_includes_credits_and_limits.snap`): `Account: user@example.com (Pro 200)`, `Token usage: 1.9K total (1K input + 900 output)`, `Context window: 100% left (2.25K used / 272K)`, `5h limit: [███████████░░░░░░░░░] 55% left (resets 09:25)`, `Weekly limit: [...] NN% left (resets …)`, `Credits: Available`.
- **Context indicator** `[source]` footer right `100% context left` / `98% context left` (percent of window remaining, hidden when the footer is too narrow — `footer_mode_indicator_narrow_overlap_hides.snap`); alt statusline item `Context 100% left` / `Context 0% used`. `/compact` "Summarize the visible chat to free tokens" `[docs]`; `compaction_running_narrow.snap` exists.
- **Rate limits** `[source]` `■ rate limit exceeded: Please try again in 10s.`; `Usage limit reached. You've reached your usage limit. Increase your limits to continue using codex.` (`turn_runtime.rs` L512); `/usage` "view account usage or use a usage limit reset" with a reset picker (`reset_credits.rs`, `rate_limit_reset_picker_narrow.snap`).

## 11. Keyboard shortcuts

`[source]` defaults in `S/codex-rs/tui/src/keymap.rs` L1680–1830, `[ran]` overlay via `?` (screenshot `06-shortcut-overlay.png`), `[docs]` developer-commands.md "Interactive shortcuts".

| Key | Action | Evidence |
|---|---|---|
| `Enter` | submit; while working: inject into current turn | source/docs |
| `Tab` | queue message for next turn | source/docs |
| `Shift+Enter`, `Ctrl+J` | newline (`insert_newline`) | source |
| `Esc` | interrupt turn; `Esc Esc` on empty composer = edit previous message (fork) | source/docs |
| `Ctrl+C` | during a turn: interrupts (`■ Conversation interrupted …` [ran]); on idle composer first press shows `⌃c again to quit`, second quits | source |
| `Ctrl+D` | delete-forward in the editor (not quit) | source L1778 |
| `Ctrl+T` | open transcript overlay; `F3` find; `PgUp/PgDn`; `Ctrl+Home/End`; `Ctrl+Space` start selection; `⇧⌥,`/`⇧⌥.` top/latest | source |
| `Ctrl+V` | paste image | overlay |
| `Ctrl+G` | open external editor | source/docs |
| `Ctrl+O` | copy latest response (`/copy` menu) | source/docs |
| `Ctrl+R` / `Ctrl+S` | history search backward/forward (`reverse-i-search:`) | source/docs |
| `Up/Down` | draft history (when composer empty) | docs |
| `Ctrl+L` | clear terminal view | source/docs |
| `Alt+R` | toggle raw output; `Ctrl+/` side conversation | source |
| `Alt+,` / `Alt+.` | less/more reasoning effort | source/overlay |
| `Alt+←/→` | switch subagents (empty prompt) | overlay |
| `F2` warnings · `F4` inspect activity · `F8/F9` voice | | source |
| `Shift+←`/`Alt+↑` | edit queued message; `Shift+→`/`Alt+↓` prompt stack back | source |
| `Ctrl+]` | skip question | source |
| `?` | shortcuts overlay (`? / esc close`) | [ran] |
| `/`, `@`, `!` | commands, mentions, shell mode | [ran] |
| emacs: `Ctrl+B/F/P/N/A/E/K/Y`, `Alt+B/F` | cursor/kill/yank | source |
| Vim mode | `/vim` toggles normal/insert | source/docs |

Bindings are remappable via `/keymap` → `tui.keymap.*` in `config.toml` using names like `ctrl-a`, `shift-enter`, `page-down` `[docs]`. `Ctrl+Alt+V`: not verified (not in defaults).

## 12. Visual language

- **Glyphs** `[ran]/[source]` `›` composer prompt and selected-row marker; `•` agent/tool bullet (dim); `◦` status while reconnecting; `■` error; `⚠` warning; `✔`/`✗` approvals; `└` tree child; `→` rename; `…` truncation; `>_` app header (`>_ OpenAI Codex (v0.166.0)` bold + dim cwd); braille/dot-matrix OpenAI logo on the empty screen (`onboarding/snapshots/...welcome_logo_160x48.snap`, screenshot `03-main-screen-empty.png`); `↑`/`↓` list overflow markers; keycap glyphs `⌃ ⌥ ⇧` in hints.
- **Colour** `[source]` ratatui named colours only (`Color::Cyan` model name, `Color::Green` path/additions/✔, `Color::Red` deletions/✗/errors, `Color::Magenta` user slash-command echo and `codex`/`exec` labels in `codex exec`, `Color::Cyan` `user` label and ⚠ usage warning); emphasis via `dim`, `bold`, `italic`, `REVERSED` (selection). No hex palette is defined — the TUI inherits the terminal theme; the shimmer and diff tints derive from the terminal's default fg/bg when true colour is available (`shimmer.rs`, `diff_render.rs`). `/theme` exists for diff/markdown themes `[source]` slash list. Dim is used for: reasoning (transcript only), descriptions in pickers, hints, cwd, truncation lines.
- **Spinner** `[source]` there is no rotating glyph spinner; "working" is the shimmer sweep across the status header text plus elapsed seconds (`• Working (12s • esc to interrupt)`), and `◦`/`•` leading glyph. `animations` config disables effects.
- **Long output** `[source]` 5-line previews with middle truncation, `Explored` grouping of read-only commands, reasoning hidden from main view, `/compact`, `/raw` and the Ctrl+T pager with find.
- **Narrow terminals** `[source]` snapshots `*_narrow.snap`: pickers wrap descriptions under the label, footer right-side indicators hide when they would overlap (`footer_mode_indicator_narrow_overlap_hides.snap`), diff gallery has 80x24 and narrower variants, list rows preserved (`list_selection_narrow_width_preserves_rows.snap`).
- **Onboarding** `[ran]` screenshot `01-onboarding-sign-in.png`: `Welcome to Codex, OpenAI's command-line coding agent` / `Choose how you want to use Codex.` / `> 1. Sign in with ChatGPT  Usage included with Plus, Pro, Business, and Enterprise plans` / `2. Sign in with Device Code  Sign in from another device with a one-time code` / `3. Use an OpenAI API key  Pay for what you use` / `4. Use Amazon Bedrock  Connect using your AWS credentials` / `Press enter to continue`. API key page (`02-onboarding-api-key.png`): `> Use your own OpenAI API key for usage-based billing` / `Paste or type your API key below.` / `Detected OPENAI_API_KEY environment variable. Paste a different key if you prefer to use another account.` / boxed cyan field titled `API key` / `Press enter to save` / `Press esc to go back`. Setting `OPENAI_API_KEY` alone does not skip onboarding. Trust page `[source]` `...trust_directory__tests__renders_snapshot_for_git_repo.snap`: `Folder access` / path / `Trust this folder? Codex can read, edit, and run files here, subject to your permission settings. Folder settings can run code automatically, even without a model request. Continue only if you trust these files. Your trust decision will be saved.` / `› 1. Trust and continue` / `2. Quit` / `enter continue and create sandbox · esc quit`.
- **`codex exec`** `[ran]`: stderr header
  ```
  OpenAI Codex v0.166.0
  --------
  workdir: /home/ubuntu/codex-study/proj
  model: gpt-6.1-sol
  provider: openai
  approval: never
  sandbox: workspace-write [workdir, /tmp, $TMPDIR]
  reasoning effort: none
  reasoning summaries: none
  session id: 01a19f48-…
  --------
  user
  say hi
  warning: Codex could not find bubblewrap on PATH. …
  ERROR: Reconnecting... 2/5
  ```
  then `codex` (magenta italic) for agent text, `exec` (magenta italic) for commands, `tokens used` (dim) at the end (`S/codex-rs/exec/src/event_processor_with_human_output.rs`). Only the final message goes to stdout; `--json` emits JSONL events `thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.*`, `error`; `-o/--output-last-message`, `--output-schema` `[docs]` non-interactive-mode.md. Default policy for `exec` is `approval: never` `[ran]`.

## 13. Notifications, hooks, MCP

- **`notify`** `[source]` `S/codex-rs/core/src/config/mod.rs` L780–803: `notify = ["notify-send", "Codex"]` → spawned after each completed turn as `notify-send Codex '{"type":"agent-turn-complete","turn-id":"12345"}'`; `tui_notifications` (enabled events, delivery method, focus condition) controls terminal (OSC) notifications; `/config` "Adjust the theme, notifications, keyboard shortcuts" `[docs]`.
- **Hooks** `[source]` `S/codex-rs/hooks/src/lib.rs` L30–45 event names include `PreToolUse`, `SessionStart`, `SubagentStop`, `Stop`; `/hooks` "View and manage lifecycle hooks… trust new or changed hooks"; `--dangerously-bypass-hook-trust` flag `[ran]`; docs hooks.md `[docs]`.
- **MCP** `[ran]` `codex mcp list|get|add|remove|login|logout`, `codex mcp list --json`; `/mcp` "List configured MCP tools" `[docs]`. `[source]` startup header shows MCP boot state (`mcp_startup_header_booting.snap`), startup failures become ⚠ warning history (`app_server_mcp_startup_failure_renders_warning_history.snap`); MCP tool calls render via `history_cell/mcp.rs` with `Error: <msg>` on failure; elicitations use the approval overlay.

## 14. Errors and unavailable states (exact phrasing)

- Auth `[ran]`: `codex doctor` → `✗ auth  no Codex credentials were found - Run codex login or provide an API key through a supported auth env var.`; invalid key in TUI → `◦ Reconnecting... 5/5 (7s • esc to interrupt)` with `└ Unexpected status 401 Unauthorized: Incorrect API key provided: sk-proj-****…0000. You can find your API key at https://platform.openai.com/account/api-keys., url: wss://api.openai.com/v1/responses, cf-ray: …, request id: req_…, auth error:…` (key masked by Codex; 5 retries; screenshot `12-error-fake-key.png`). `/status` → `Account: API key configured (run codex login to use ChatGPT)`.
- Rate limit `[source]`: `■ rate limit exceeded: Please try again in 10s.`; `Usage limit reached. You've reached your usage limit. Increase your limits to continue using codex.`; `/status` `Limits: data not available yet` `[ran]`.
- Network/transport `[ran]`: `warning: Falling back from WebSockets to HTTPS transport. unexpected status 401 …`; `ERROR: Reconnecting... N/5`; `[source]` `Reconnecting to server…` status header, `Automatic reconnect could not restore this session. Your draft is still editable. Copy it before quitting with Ctrl+C, then reconnect with the same command.` (`chatwidget/reconnect.rs` L51, L259); `codex doctor` `⚠ websocket Responses WebSocket failed; HTTPS fallback may still work`.
- Interrupt `[ran]`: Ctrl+C during a turn → `■ Conversation interrupted - use /feedback if something went wrong` (screenshot `13-ctrl-c-footer.png`).
- Sandbox `[ran]`: startup warning text in §1; `[source]` approval reason `command failed; retry without sandbox?`; `warning: Code Mode is unavailable because failed to spawn code-mode host … Code mode will fail closed; enable \`features.code_mode_host\` …` `[ran]`.
- Busy state `[source]`: `■ '/resume' is disabled while a task is in progress.`

---

## Patterns worth borrowing (rule → MARS action)

1. **Separate "what may it do" (sandbox) from "when does it ask" (approval), and name presets in user terms.** Codex: `Read Only / Ask for approval / Approve for me / Full Access`, each with a one-line consequence, plus a second confirm for the dangerous one. → MARS `mars` TUI: a `/permissions` picker over the existing sandbox policy with 2–3 presets, each row = label + consequence sentence; show the active preset in `/status` and require a typed confirm before anything that leaves the approved sandbox.
2. **Approval dialog = question, reason, verbatim action, numbered options with hotkeys, Esc = safe "no + feedback".** → Reuse pi-tui's selector; render the command as a `$ ` line and patches as the same diff cell used in history; offer `Yes / Yes for this session (scoped by prefix) / No, tell the agent what to do differently`. Record every decision in the transcript as `✔ You approved …` / `✗ You did not approve …` so the log is auditable.
3. **Sandbox denial becomes a question, not a crash.** `Reason: command failed; retry without sandbox?` → MARS: when the sandbox denies a syscall/path, surface the denial as an approval request with the exact denied resource; the default answer is "No".
4. **Collapsed tool output with explicit expansion.** 5-line middle-truncated preview, `… +N lines (⌃t to view transcript)`, read-only commands grouped under `Explored › Read/List/Search`, reasoning off the main view. → Same constants are a good default for a pi-tui client; give the transcript a full-height pager with find.
5. **Patch summary first, hunks second.** `Edited N files (+a -b)` / `└ path (+a -b)` / `old → new`, then line-numbered +/- hunks; green/red only, no hex. → Render MARS patch proposals with this header and reuse it in the approval modal.
6. **Status indicator = header text + elapsed + escape hint**, animated by a shimmer rather than a spinner glyph; the header is the model's own reasoning headline. → `• <headline> (12s • esc to interrupt)`; take the headline from the runtime's current step label.
7. **Footer hint line that changes with state** (`? for shortcuts`, `tab to queue message`, `⌃c again to quit`, `esc esc to edit previous message`, `N% context left`, `⚠ 1 warning · f2 to view`). → One line, left = next most likely key, right = resource/health indicators; hide right side when narrow.
8. **Discoverable surfaces: `/` commands with descriptions, `@` mentions with kind tabs, `?` full shortcut sheet, `/keymap` remap.** → Implement all four; keep the slash list filtered as you type and show the command's one-line description.
9. **`/status` as a single truthful page** (model + effort + summaries, provider, directory, permissions, AGENTS.md, account, session id, tokens, context window, limits). → Mirror this with MARS fields: runtime, model (free/paid + consent state), sandbox profile, instruction files loaded, session id, token/cost.
10. **Non-interactive mode mirrors the TUI**: header block with policy, progress on stderr, final answer on stdout, `--json` JSONL events. → `mars exec` should reuse the same RPC events and print a header with the active policy.
11. **Startup warnings are collected, not fatal**, viewable (F2) and dismissible. → Warnings view fed by runtime health checks (sandbox tooling missing, model unreachable).
12. **Queue vs. steer**: Tab queues for the next turn, Enter injects into the current turn, Esc Esc edits+forks. → Expose all three on the loopback RPC.

## Do not borrow / conflicts with MARS constraints

- **"Full Access" / `danger-full-access` / `--dangerously-bypass-approvals-and-sandbox`** — MARS executes only inside an approved sandbox; do not offer an unsandboxed preset. The "retry without sandbox?" prompt must instead become "ask to widen the sandbox policy for this resource".
- **"Approve for me" (LLM auto-review of approvals)** — model output is untrusted in MARS; an LLM must not be the approver. Follow-up actions stay proposals that the user confirms.
- **Model picker that lists paid tiers first / `More reasoning… consume usage limits faster`** — MARS is free-models-first; order free models first, mark paid ones, and require explicit consent on selection (Codex only warns).
- **Multi-agent features** (`/agents`, `/subagents`, `⌥←/→` switch, `SubagentStop`) — MARS has a single agent runtime; omit.
- **Account/plan surfaces** (`Sign in with ChatGPT`, `Pro 200`, 5h/weekly limit bars, `/usage` reset, `/daybreak`, `/app` desktop hand-off via `codex://threads/...`) — not applicable; show cost/budget instead.
- **Shell mode `!` under the agent's policy** — only if routed through the same approved sandbox; otherwise omit.
- **Hooks that run arbitrary user commands at lifecycle events and `notify` spawning programs** — keep notifications to the host (OS notification via the MARS Shell), not arbitrary processes from the TUI.
- **Hidden reasoning** — Codex hides reasoning from the main view; MARS treats model output as evidence, so reasoning/plan text should stay inspectable (collapsed, not removed).
- **Clipboard image paste and external editor** — fine in principle, but both read local files; gate behind the same path policy as `@` mentions.

---

## Evidence appendix

### Commands run (Devin VM, Ubuntu, 2026-11-03 UTC)
```
gh release list -R openai/codex --limit 5            # → rust-v0.166.0 (latest stable)
gh release download rust-v0.166.0 -R openai/codex -p 'codex-x86_64-unknown-linux-musl.tar.gz'
./codex --version                                    # codex-cli 0.166.0
./codex --help; ./codex exec --help; ./codex review --help; ./codex resume --help; ./codex fork --help
./codex mcp --help; ./codex mcp list --help; ./codex login --help; ./codex sandbox --help; ./codex sandbox linux --help
./codex doctor; ./codex features list
git clone https://github.com/openai/codex src && git -C src checkout rust-v0.166.0   # 6ff1e1ca3b30fc8b914720681fcf5fe62e95f856
xterm -e 'codex --no-daemon'  (CODEX_HOME=fresh dir; first without any key, then with an invalid OPENAI_API_KEY)
  keys sent: 3 ⏎ ⏎ (API key), ? , / , /status ⏎ , /permissions ⏎ , /model ⏎ , @ , F2 , "say hi" ⏎ , ^C (during the retrying turn)
RUST_LOG=error codex exec --skip-git-repo-check "say hi"   (invalid key → header + 401 path)
```

### Source files cited (all at `6ff1e1ca3b30fc8b914720681fcf5fe62e95f856`)
- `codex-rs/protocol/src/protocol.rs` (AskForApproval L1145, GranularApprovalConfig L1170, SandboxPolicy L1231)
- `codex-rs/core/src/tools/orchestrator.rs` L632–644 (sandbox denial → retry prompt)
- `codex-rs/core/src/agents_md.rs` L43–45, L273–288; `codex-rs/core/src/config/mod.rs` L780–810 (notify, tui_notifications, animations)
- `codex-rs/apply-patch/src/parser.rs` (grammar + markers), `codex-rs/apply-patch/src/lib.rs`
- `codex-rs/rollout/src/lib.rs` L86–87 (sessions dirs)
- `codex-rs/linux-sandbox/src/{launcher.rs,bwrap.rs,seccomp.rs}`
- `codex-rs/exec/src/event_processor_with_human_output.rs`
- `codex-rs/hooks/src/lib.rs` L30–45
- `codex-rs/cli/src/desktop_app/{mac.rs L156, windows.rs L73}`; `codex-rs/tui/src/app/history_ui.rs` L288 (`codex://` schemes)
- `codex-rs/tui/src/slash_command.rs`; `bottom_pane/approval_overlay.rs`; `history_cell/{approvals.rs,messages.rs,notices.rs,mod.rs}`; `exec_cell/{render.rs,live_output.rs}`; `diff_render.rs`; `status_indicator_widget.rs`; `shimmer.rs`; `keymap.rs` L1680–1830; `keymap/chords.rs`; `resume_picker.rs` + `resume_picker/layout.rs`; `chatwidget.rs` L1066, L1310–1322; `chatwidget/{review_popups.rs,reconnect.rs,turn_runtime.rs,model_popups.rs}`; `pager_overlay.rs`
- Snapshots: `codex-rs/tui/src/chatwidget/snapshots/codex_tui__chatwidget__tests__{approval_modal_exec,approval_modal_patch,approvals_selection_popup,profile_permissions_selection_popup,full_access_confirmation_popup,model_selection_popup,model_reasoning_selection_popup,rate_limit_exceeded_error,interrupted_turn_error_message,status_widget_active,esc_interrupt_goal_paused_footer,status_line_model_with_reasoning_context_remaining_footer,disabled_slash_command_while_task_running_snapshot,interrupt_exec_marks_failed,chatwidget_exec_and_status_layout_vt100_snapshot}.snap`; `codex-rs/tui/src/bottom_pane/snapshots/codex_tui__bottom_pane__chat_composer__tests__{empty,footer_collapse_queue_full,footer_mode_ctrl_c_quit,footer_mode_ctrl_c_then_esc_hint,footer_mode_esc_hint_backtrack,footer_mode_shortcut_overlay,default_unified_mention_popup,footer_mode_shell_command_absorbs_bang,footer_mode_history_search}.snap`; `...approval_overlay__tests__{network_exec_prompt,approval_overlay_additional_permissions_prompt}.snap`; `codex-rs/tui/src/snapshots/codex_tui__diff_render__tests__{diff_gallery_80x24,apply_update_block,apply_multiple_files_block}.snap`; `codex-rs/tui/src/status/snapshots/codex_tui__status__tests__status_snapshot_includes_{credits_and_limits,reasoning_details}.snap`; `codex-rs/tui/src/onboarding/snapshots/codex_tui__onboarding__{trust_directory__tests__renders_snapshot_for_git_repo,welcome__tests__welcome_logo_160x48,auth__tests__api_key_entry}.snap`

### Official docs read (2026-11-03)
- https://developers.openai.com/codex/cli/ (Markdown: https://learn.chatgpt.com/docs/codex/cli.md)
- https://developers.openai.com/codex/security/ ; agent approvals: https://learn.chatgpt.com/docs/agent-approvals-security.md ; https://learn.chatgpt.com/docs/sandboxing.md ; https://learn.chatgpt.com/docs/sandboxing/auto-review.md
- https://developers.openai.com/codex/guides/agents-md/ (https://learn.chatgpt.com/docs/agent-configuration/agents-md.md)
- https://learn.chatgpt.com/docs/developer-commands.md (commands, interactive shortcuts, slash table, `codex sandbox`)
- https://learn.chatgpt.com/docs/cli-customization.md ; non-interactive-mode.md ; config-file/config-reference.md ; config-file/config-advanced.md ; config-file/config-basic.md ; hooks.md ; permissions.md ; customization/memories.md ; agent-configuration/rules.md ; glossary.md
- README: https://github.com/openai/codex/blob/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/README.md (repo `docs/*.md` at this tag are stubs redirecting to developers.openai.com)

### Screenshots (PNG, this directory; all taken by me unless marked official)
| File | Caption |
|---|---|
| `00-readme-splash-official.png` | Official README splash image, © OpenAI, Apache-2.0 repo asset: https://github.com/openai/codex/blob/main/.github/codex-cli-splash.png (resized) |
| `01-onboarding-sign-in.png` | First launch, no credentials: welcome + four sign-in choices |
| `02-onboarding-api-key.png` | API-key entry page (env var detected, boxed field, enter/esc hints) |
| `03-main-screen-empty.png` | Main screen: `>_ OpenAI Codex (v0.166.0)` header, logo, `› Ask Codex to do anything`, status line, `? for shortcuts`, warning badge |
| `04-status-output.png` | `/status` output on 0.166.0 with API key |
| `06-shortcut-overlay.png` | `?` keyboard-shortcut overlay (Compose / Session / Transcript columns) |
| `07-slash-popup.png` | `/` command popup with descriptions |
| `08-permissions-picker.png` | `/permissions` → Update Model Permissions picker |
| `09-model-picker.png` | `/model` → Select Model and Effort |
| `10-mention-popup.png` | `@` Mentions popup with tabs and kind column |
| `11-warnings.png` | F2 warnings view (bubblewrap missing) |
| `12-error-fake-key.png` | 401 auth error with `◦ Reconnecting... 5/5 (7s • esc to interrupt)` |
| `13-ctrl-c-footer.png` | After Ctrl+C during the failing turn: `■ Conversation interrupted - use /feedback if something went wrong`; footer badge now `⚠ 2 warnings · f2 to view` (the transient `⌃c again to quit` hint had already expired when captured) |
