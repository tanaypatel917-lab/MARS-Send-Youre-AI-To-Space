# MARS UI: implementation prompt and design specification

Status: specification, not implementation. Nothing in this document is built yet; the interactive `mars` session and the MARS Shell desktop app have no code. Section 9 is the prompt an engineering session is given verbatim; sections 1–8 are what it references. The research behind every borrowed idea is in Appendix A and in `documentation/ui-research/`.

Scope: (1) the MARS terminal client — the interactive `mars` session in `apps/cli`, built from Oh My Pi's `@oh-my-pi/pi-tui` components as a client of the workbench RPC; (2) the MARS Shell desktop app, specified here for the first time; (3) the VS Code extension (`apps/vscode`), which stays a secondary client and must only remain consistent with the contracts below.

Direction, in the owner's words: "heavily inspired by the usability of Claude Code and Codex but the design of Hermes and Oh My Pi." Where those pull apart, section 1.3 says which won and why.

Evidence tags used throughout: `[ran]` observed by running the product, `[source]` read in source at a pinned revision, `[docs]` official documentation, `[third-party]` other published material, `[repo]` this repository. A claim with no tag is a MARS design decision, not an observation.

## 0. What already exists (read before designing)

| Piece | Where | What the UI inherits |
| --- | --- | --- |
| Runtime | `packages/execution/src/runtime.ts` | Oh My Pi `createAgentSession` with `hasUI: false`, `interactivePrompts: false`, `enableMCP: false`, `enableLsp: false`, `disableExtensionDiscovery: true`, `restrictToolNames: true`, compaction and retry off. Every tool the model can call is host-bound (`mars_read/write/execute/apply_patch`, `mars_history`, `mars_delegate/children/results`, `mars_research/findings`, `mars_proposals`, `mars_watch_*`, `mars_loop`, `mars_verify`). The client never talks to the model. |
| Workbench RPC | `documentation/WORKBENCH_RPC.md` | Loopback `POST /v1/rpc`, bearer token from the connection file; `workbench.describe`, `tasks.create/list/inspect/start/resume/steer/cancel/events/artifact/diff/checkpoint/restore`. Approvals (`read`, `write`, `execute`) and the model id are given at `tasks.start`/`tasks.resume`; MARS never prompts mid-task. `tasks.events` pages by `after_event_id` (1,000 cap, 4 MiB response). Steer text ≤ 8,000 chars. |
| Event journal | `packages/contracts/src/index.ts` `EventEnvelopeSchema` | `event_type` ∈ `task.created, task.updated, execution.observed, tool.completed, research.proposed, research.stale, memory.revised, skill.revised, evaluation.completed, training.updated, promotion.decided`; `TaskStatus` ∈ `pending, running, paused, completed, cancelled, failed`; optional `usage {input_tokens, output_tokens, cost_usd}` per event. The transcript is a projection of these events plus Oh My Pi's journal; the client stores nothing of its own. |
| Output format | `documentation/OUTPUT_FORMAT.md`, `packages/output-format` | `parseOutput` (total, never throws), `processOutput(text, {connector_ids, allowed_addresses})`, `renderTerminal`. Constructs: `:::writing{id variant}` blocks, `::tone[]`, typed links (`external/local/anchor/app/review/other`), `mars://review?pr&path&line&end&side` (≤ 40 lines by default), `:mars-followup[label]{prompt}` (hidden prompt ≤ 8,000 chars, shown before submit). Nothing parsed may execute without an explicit user action. `codex://review` and `:codex-followup` are import aliases only. |
| Existing CLI | `apps/cli/src/{main,render,serve}.ts` | Commands `doctor`, `smoke`, `models`, `render`, `serve`, `commands` (PR #53). `render` is the only output-format UI today: 80-column frames, numbered follow-up chooser, "Proposed actions (not executed)", "Format errors". No interactive session exists. |
| VS Code | `apps/vscode/README.md` | Sidebar webview over the same RPC: textContent-only DOM, strict CSP, native confirm dialogs for start/resume/cancel/restore, read-only diffs, follow-up buttons with confirmation, review links open `path:line`, `app://` chips disabled (no connector registry), artifacts verified by SHA-256. |
| Conventions (PR #53) | `packages/codex-tools`, `@mars/skills` | `AGENTS.override.md`/`AGENTS.md`/`CLAUDE.md` discovery (32 KiB, labelled untrusted), `.mars/commands` + `.claude/commands` slash commands expanded at `tasks.start` (`conventions.applied` event), `.mars/hooks.json` hooks recorded as `tool.completed` with `operation: hook.completed`, Codex policy names mapped to MARS approvals (`danger-full-access` refused). `--trust-project` gates instructions and hooks. |
| Model policy | `README.md`, `packages/providers` | Free-first routing; `allowPaid: false` default; a paid model needs explicit selection plus known prices; children never inherit a paid model. `model_unavailable` is a first-class state. |
| Watch / verify | `packages/watch`, `documentation/WATCH.md` | `verify` records and `watch.evidence` artifacts; `allow_screen_capture` is off for every role (open product decision). |
| Master spec UX | `documentation/MASTER_SPECIFICATION.md` §14 | Surfaces: task workspace, research panel, changes panel, memory explorer, skills, learning activity, experiments, model lab, specialist registry. "Improved 8 of 20" language only with evidence. Autonomy controls are a requirement, not a nicety. |

## 1. Design principles

Each principle names the usability rule it enforces and where it was observed. The builder treats these as tie-breakers for every unlisted decision.

| # | Principle | Rule | Observed in |
| --- | --- | --- | --- |
| P1 | One place to look. The transcript is the only timeline; approvals, diffs, child results, research findings and proposals appear inline as cards at the moment they happen, and the same cards are what the side panels filter. | Recognition over recall; no state lives only in a panel. | Claude Code's single-stream transcript with inline tool cards; Codex's typed history cells. (Appendix A.1, A.2) |
| P2 | The model never acts; the user always sees what is about to happen before it does. Every destructive or paid step is a card with a default-safe answer, and every decision is logged in the transcript. | Visibility of system status; error prevention. | Codex `[source]` approval modal: question, `Reason:`, verbatim `$ command`, numbered options with hotkeys, `Esc` = safe no-with-feedback; decisions logged as `✔ You approved …` / `✗ You did not approve …` (A.2). Claude Code permission prompts (A.1). MARS already enforces the gate in the host. |
| P3 | Collapse by default, expand by one key. Tool output shows a short preview and a count; the full text is one keystroke away and never auto-expands. | Progressive disclosure; aesthetic and minimalist design. | Codex `[source]`: 5-line middle-truncated preview, `… +N lines (⌃t to view transcript)`, read-only commands grouped under `Explored › Read/List/Search`, reasoning kept out of the main view (A.2). Claude Code transcript expansion (A.1). Oh My Pi `thinking-display`/`read-tool-group`. |
| P4 | Quiet motion. One spinner per running thing, braille frames, no shimmer when `reduced motion` is set, nothing animates after completion. | Minimise distraction; accessibility. | Oh My Pi `SPINNER_FRAMES` (`status`/`activity` sets, ASCII fallback) and `shimmer.ts` with a `disabled` mode `[source]`; Hermes' restrained streaming (Appendix A.3). |
| P5 | Dense but legible. One-column transcript, 2-space indents, framed cards only for things that need a boundary (approvals, diffs, writing blocks); plain text for prose. | Match the medium: terminals reward density, punish chrome. | Oh My Pi `message-frame`/`tool-card`; Hermes layout density (Appendix A.3, A.4). |
| P6 | Keys do the same thing everywhere. The same binding cancels, expands, approves and switches in the CLI, MARS Shell and VS Code; help is always `?`/`/help`, and bindings are remappable from one file. | Consistency and standards. | Codex `[ran]/[source]`: `Esc` interrupt, `Ctrl+C` twice to quit, `/` commands with descriptions, `@` mentions, `?` shortcut sheet, `/keymap` remap (A.2); Claude Code (A.1). |
| P7 | Context is a gauge, not a surprise. Remaining context, tokens and cost are always visible; compaction and budget exhaustion are announced before they happen; startup warnings are collected and viewable, not fatal. | Visibility of system status. | Codex `[ran]` footer `N% context left`, `⚠ 1 warning · f2 to view`, `/status` as one truthful page (model, provider, directory, permissions, AGENTS.md, session id, tokens, context window) (A.2); Claude Code context indicator and `/compact` (A.1); Oh My Pi `chrome/context-thresholds.ts`: `warning` at ≥50 % or 150k tokens, `purple` at ≥70 % or 270k, `error` at ≥90 % or 500k, driving the `context_pct` colour `[source]` (A.4). |
| P8 | Say what was checked, not what was done. Completion states cite the `verify` record, acceptance criteria and reviewer result; "task completed" without evidence renders as "finished, unverified". | Honesty; master spec §14, §17. | MARS master spec; Codex review flow summarising findings rather than claiming success. |
| P9 | Free by default, paid by choice. The model indicator shows tier and price; selecting a paid model is a two-step confirmation that names the price and scope; children stay free. | Error prevention; user control. | MARS provider policy `[repo]`; Claude Code `/cost` transparency; Aider per-message cost table (Appendix A.5). |
| P10 | Resume is first-class. Every session is listed with time, branch, request and last state; resuming replays the projection, never re-executes. | User control and freedom. | Claude Code `--resume` picker; Codex `codex resume`; Oh My Pi `session-selector` `[source]`. |
| P11 | Untrusted text looks untrusted. Repository instructions, research excerpts, model-proposed follow-ups and watch evidence are rendered in the same "quoted" style with their provenance, never as system text. | Security boundary made visible. | MARS security model `[repo]`; Codex labelling of AGENTS.md as project docs. |

### 1.1 Where usability (Claude Code / Codex) and design (Hermes / Oh My Pi) conflict

<!-- RESEARCH: finalise each row against Appendix A findings -->

| Conflict | Claude Code / Codex convention | Hermes / Oh My Pi look | MARS choice | Why |
| --- | --- | --- | --- | --- |
| Permission prompts | Codex `/permissions`: four presets (`Read Only`, `Ask for approval`, `Approve for me`, `Full Access`), each with a one-line consequence and a second confirm for `Full Access` `[source]`; Claude Code modes cycled with `Shift+Tab` (A.1). | Hermes has no per-tool permission prompt (A.3); Oh My Pi has `approval-dialog` overlay. | Inline card for task-start approvals rendered with Oh My Pi `approval-dialog` styling, one consequence line per approval, never an overlay that hides the transcript. No `Full Access` and no `Approve for me`: MARS has no unsandboxed mode and the model is never the approver. | Usability wins: the user must read what they are approving against the request. MARS has no mid-task prompts, so the card appears once per start/resume. |
| Colour accent | Claude Code: single warm accent; Codex: cyan/magenta. | Oh My Pi dark accent `#febc38` amber, light `teal`; Hermes palette (A.3). | Oh My Pi tokens verbatim; MARS adds no new accent. A MARS theme file only re-maps semantic tokens (section 4). | Native feel on the runtime's own TUI; theme switching stays `/theme`. |
| Tool output density | Claude Code: 1 summary line + "+N lines (ctrl+o)" (A.1); Codex 5-line middle-truncated preview `[source]` (A.2). | Oh My Pi `ToolCard`/`renderOutputBlock` with `collapsedMaxLines=10` and coloured background bands (`toolPendingBg/SuccessBg/ErrorBg`) `[source]` (A.4). | Keep the bands and the component; set `collapsedMaxLines=5` (setting `display.toolPreviewLines`) and use the count line. | Bands carry status; the cap carries calm. |
| Status line placement | Claude Code and Codex: footer below the prompt (A.1, A.2). | Oh My Pi default composer shape `band`: status as a powerline band *above* the prompt, `╰─ ` cue `[ran]` (A.4). | Band above the prompt (Oh My Pi), one state-driven hint row below it (Codex). | The band is the native Oh My Pi silhouette; the hint row carries the Codex discoverability without moving the status. |
| `Shift+Tab` | Claude Code cycles the permission mode (A.1). | Oh My Pi cycles the thinking level (`app.thinking.cycle`) `[ran]` (A.4). | Mode cycle; thinking level moves to `Alt+T` and `/thinking`. | Mode is a safety control and must be the cheaper gesture. |
| Colour depth | Codex inherits the terminal palette (named colours only) `[source]` (A.2). | pi-tui has exactly two `ColorMode`s, `truecolor` and `256color`; `NO_COLOR` only disables OSC 8 links `[source]` (A.4). | `@mars/ui-core` adds a colour policy above pi-tui: `NO_COLOR` → monochrome theme (all tokens terminal-default, status by glyph/indent), 16-colour terminals → `mars-ansi.json` built from the theme's `terminal.ansi` table. | Accessibility and `NO_COLOR` are MARS requirements that the base library does not meet. |
| Thinking display | Claude Code collapses thinking; Codex keeps reasoning out of the main view and uses its headline as the status text `[source]`. | Oh My Pi colours thinking by effort level (`thinkingOff…thinkingXhigh`). | Collapsed by default, Oh My Pi effort colour on the one-line header, `Ctrl+T` expands. | Both. |
| Status line | Claude Code: configurable command; Codex: footer hints. | Oh My Pi `status-line` segments and presets with per-segment colours. | Oh My Pi segments; MARS adds `model-tier`, `budget`, `approvals`, `children`, `verify` segments. | Reuse the preset system instead of a second config. |
| Slash command discovery | Claude Code/Codex: typed `/` opens a popup with descriptions. | Oh My Pi has the same (`autocomplete.ts`, `slash-commands/`). | Oh My Pi autocomplete; MARS supplies its own command list (section 5.2). | No conflict; listed so nobody writes a new popup. |
| Interrupt key | Codex `[source]`: `Esc` interrupts, `Esc Esc` on an empty composer edits the previous message (fork), `Ctrl+C` interrupts during a turn and quits on the second idle press; Claude Code similar (A.1). | Oh My Pi: `[source]` see A.4. | `Esc` = cancel current task turn (RPC `tasks.cancel` with reason `user_interrupt`); `Ctrl+C` twice = quit client (tasks keep running in the workbench). | The workbench owns execution, so "interrupt" and "quit" are different operations and both must be visible. |

## 2. Terminal client information architecture

`mars` with no subcommand (or `mars session`) opens the interactive client. It is a `@oh-my-pi/pi-tui` program (`TUI` root, component tree, differential renderer) that speaks the workbench RPC; it does not import `createAgentSession`, `AgentSession` or any Oh My Pi mode. `pi-tui` itself depends on `@oh-my-pi/pi-agent-core`, `pi-ai` and `pi-wire` `[source: pi-tui/package.json]`, so a lint rule (biome `noRestrictedImports`) must forbid `@oh-my-pi/pi-coding-agent`, `pi-agent-core` and `pi-ai` in `apps/cli/src/session/**` and `packages/ui-core/**`. Connection: the `mars serve` connection file at `~/.mars/workbench/<project>/connection.json` (`--state` override), parsed with the same strict reader as `apps/vscode/src/connectionFile.ts`. Layout, top to bottom, one column:

```
┌ header (1 line, optional, hidden < 30 rows) ─ project · branch · task title · task status
│ transcript (live region; settled entries retire into native terminal scrollback, Oh My Pi `TranscriptContainer` model)
│ pending card (approval / paid consent / proposal review; only when one is pending)
│ status band (1 line; pi-tui `band` composer shape: powerline band flush left, above the prompt)
│ composer (1–8 lines, grows; `╰─ ` cue)
└ hint row (1 line; `composer-hints` by state)
```

### 2.1 Transcript

Projection of `tasks.events` + Oh My Pi journal entries for the selected task, oldest first, appended live (poll `tasks.events` with `after_event_id`; the client keeps only the rendered projection in memory, bounded to the last 2,000 entries with "load earlier" on `PgUp` at the top).

| Entry | Source | Default render | Expanded (`Ctrl+O` on focused entry) |
| --- | --- | --- | --- |
| User request / steer | `tasks.inspect.request`, `tasks.steer` | Oh My Pi `user-message` frame (`userMessageBg`), full text. | — |
| Assistant text (streaming) | `execution.observed` text deltas | Markdown via pi-tui `markdown` component; final turn re-rendered through `processOutput` (section 2.9). | — |
| Thinking | `execution.observed` reasoning | One dim line `thinking · 12s` coloured by effort token; collapsed. | Full text, `thinkingText` colour. |
| Tool call | `tool.completed` (`mars_*`) | Oh My Pi `tool-card`: glyph + tool name + primary argument (path, command, question) + status band; 5-line middle-truncated preview (pi-tui `ToolCard` with `collapsedMaxLines=5`, default 10); `… +N lines (Ctrl+O to expand)` footer. Consecutive read-only calls (`mars_read`, listings, `mars_history`, `mars_research_findings`) fold into one `Explored › read 4 · search 2` group card (Codex pattern, A.2). | Full output in `output-pane` with its own scroll; `y` copies. |
| Hook run | `tool.completed`, `operation: hook.completed` | Same card, label `hook pre-tool ./scripts/lint` and exit code; exit 2 shows the block reason. | stdout/stderr (4 KiB cap from the host). |
| Diff | `tasks.diff`, `mars_write`/`mars_apply_patch` results | Summary first: `Edited 2 files (+14 −3)` then `└ src/x.ts (+12 −3)` per file (`old → new` for moves), line-numbered unified hunks via pi-tui `chrome/diff.ts` in `toolDiffAdded/Removed` only, max 40 lines per file by default (Codex `apply_patch` rendering, A.2). | Full file diff; `Enter` opens the diff viewer (2.5). |
| Child session | `tool.completed` for `mars_delegate`, `child.result` | Card `child worker-2 · running · 3 tool calls · free model`; nested cards collapsed one level. | Child transcript in the same component, read-only; `Esc` returns. |
| Research | `research.proposed`, `research.stale` | Card listing findings: claim, source link, confidence, `used/unused` flag; stale findings struck through. | Full finding text and excerpt in quoted style (P11). |
| Watch evidence / verify | `watch.evidence` artifact, `verify` record | Card: check name, pass/fail, evidence file names; screenshots are listed, never inlined (opt-in `Enter` opens via `$MARS_IMAGE_VIEWER` or the kitty graphics protocol when the terminal supports it). | Record JSON pretty-printed. |
| Proposal (memory / skill / GEPA) | `memory.revised`, `skill.revised`, `promotion.decided`, `mars_proposals` | Card with kind, scope, revision fence, before/after excerpt and the three actions `accept · reject · later`. Nothing is accepted on `Enter` alone. | Full diff of the proposed change. |
| Budget / model events | `task.updated` budget fields, `model_unavailable` | Notice line (`chrome/status-notice`): `model openrouter/free-x unavailable → paused`. | Reason and the actions available. |
| Compaction | Oh My Pi compaction entries (off in MARS runtime today) | `compaction-summary-message` style notice if/when enabled. | Summary text. |
| Error | `task.updated` → `failed`, RPC errors | `error-block` with the host's error code and the one next action. | Stack/log if the host supplied one. |

Rules: no entry re-orders after rendering; streaming text updates in place; a card changes its band colour when its status changes but never its position. Entries older than the viewport do not animate.

### 2.2 Composer

Oh My Pi `prompt/composer.ts` reused as-is: multi-line editor, `Shift+Enter`/`Ctrl+J` newline, `Enter` submit, bracketed paste, history (`Up`/`Down` when the cursor is on the first/last line), `Ctrl+R` history search. Autocomplete providers: `/` commands (section 5.2), `@` workspace paths (from `tasks.inspect` workspace listing; never the host filesystem outside the task root), `#` acceptance criteria ids, `!` prefix is **not** a shell escape (MARS has no client-side shell; `!` shows a hint "use /run to request an approved execution").

Submit while a task is `running` sends `tasks.steer` (injected into the current turn by the host); `Tab` instead queues the text for after the current turn (`queued-messages` above the composer, `Ctrl+X` removes, Codex queue-vs-inject pattern, A.2). While `pending`/`paused` the submission is the new request and opens the start card (2.4).

Composer hints row (`composer-hints`) changes with state, left = next most likely key, right = health (Codex footer pattern, A.2): idle `Enter send · Shift+Enter newline · ? shortcuts`; running `Enter steer · Tab queue · Esc cancel turn`; after one `Ctrl+C` `Ctrl+C again to quit (tasks keep running)`; warnings present `⚠ 2 warnings · /status`. Replaced by the autocomplete popup when open; the right side hides first on narrow widths.

### 2.3 Status line

Oh My Pi `status-line` segment system with a MARS preset. Default segments, left to right, truncating from the right on narrow widths:

`[mode] [model · tier] [context ▮▮▮▯ 68%] [cost $0.00 / budget] [approvals r w ·] [children 2] [verify ✓3 ✗1] [path]`

- `mode`: `ask` (default: approvals card before every start/resume), `plan` (read-only: `read` only, `write`/`execute` refused), `auto-edit` (`read`+`write` pre-approved for this project session), `sandbox` (`read`+`write`+`execute`, only when the host reports a digest-pinned image). Cycled with `Shift+Tab`; the current mode is also the colour of the composer prompt glyph. No "bypass everything" mode exists; `danger-full-access` is shown as `refused by host` if a repository asks for it.
- `model · tier`: provider/model id and `free` / `local` / `paid $in/$out per 1M`; `paid` renders in `warning` colour.
- `context`: Oh My Pi `context-usage` bar and thresholds; the MARS host supplies `usage` per event, the client sums.
- `cost`: `cost_usd` sum vs `budget.max_cost_usd`; `—` when all usage is free.
- `approvals`: three glyphs for read/write/execute granted on this task (dim when not granted).
- `children`, `verify`: counts; hidden when zero.

### 2.4 Approval prompts

MARS asks once, at `tasks.start`/`tasks.resume`, for `read`, `write`, `execute` and (if a paid model is selected) paid consent. The card (inline, above the composer, Oh My Pi `approval-dialog` styling) shows: the request text (first 6 lines), the workspace root, the model and tier, the three approvals as toggles with defaults from the mode, and the hook/instruction summary from PR #53 (`AGENTS.md 1.2 KiB · 2 hooks · 1 slash command expanded`). Each approval row carries one consequence sentence (`write: files change only inside the task's private workspace; nothing touches your checkout`). Keys: `y` start with shown approvals, `n` cancel (composer keeps the request for editing), `1`/`2`/`3` toggle read/write/execute, `m` change model, `e` edit request. `execute` is unavailable (dim, reason shown) unless `workbench.describe` reports an image digest. The decision is written into the transcript as `✔ You started with read, write` / `✗ You did not start` so the log is auditable. Oh My Pi `approval-dialog` behaviours kept verbatim (A.4): the card is docked above the composer, arms 500 ms after it appears, `Esc` denies, and when the composer holds a draft the deny choice reads `Deny and send message` so a refusal becomes a steer.

There are no mid-task prompts (runtime has `interactivePrompts: false`); if a tool needs an approval it lacks, the host fails the tool call and the transcript shows the `error-block` with `Reason: write not approved for this task` and `resume with write approval` as the one action, which opens the card again on `tasks.resume`. A sandbox denial is rendered the same way (exact denied path or resource, default answer no); there is no "retry without sandbox".

### 2.5 Diff viewer

Full-screen overlay (`overlay-box`) over `tasks.diff` output: file list left (≥ 100 cols) or as a top strip, unified hunks right with `toolDiffAdded/Removed/Context` tokens and line numbers; `j/k` move hunks, `n/p` files, `Enter` on a line creates a `mars://review?path&line` steer draft in the composer, `q` closes. Read-only: the client never writes to the workspace. Side-by-side only in MARS Shell.

### 2.6 Task list

`/tasks` overlay (`select-list`): status glyph, title (first line of the request), branch, model tier, age, cost; `Enter` switches the transcript, `c` cancels (confirm), `r` resumes (card 2.4), `/` filters. Sort: running, paused, pending, then finished by recency.

### 2.7 Child sessions and collaboration

Children (`mars_delegate`) appear as cards (2.1) and as an indented tree in `/children` (`tree-view`): role, model tier (always free), status, tool count, cost. Rooms (`mars_send/inbox`) render messages as quoted entries with sender role; the user can post to a room with `/say <room> text` only if the host exposes it. No client-side fan-out: every child is created by the runtime.

### 2.8 Research and watch evidence panels

`/research` and `/evidence` overlays filter the same cards as 2.1 (P1): research by question → findings → sources, with `stale` struck; evidence by acceptance criterion → verify records → files. Excerpts are always in the quoted style and prefixed with their origin (`web · example.com`, `screen · capture 3`). The screen-capture notice (`allow_screen_capture` state) is shown at the top of `/evidence`.

### 2.9 Output-format rendering

The final assistant artifact (`text/plain`, `task.artifacts`) and any assistant turn are passed through `processOutput(text, {connector_ids: describe.connectors ?? [], allowed_addresses: request.addresses ?? []})`:

- Writing blocks: framed with the `variant` label (`email`, `message`, `document`…), `::tone` shown dim in the header, `y` copies the body; `app://` chips are disabled with "no connector" until a registry exists (same as VS Code).
- `mars://review` links: rendered `review src/x.ts:12–30`; `Enter` opens the diff viewer at that range; ranges > 40 lines are shown as the host clamped them.
- `:mars-followup` buttons: numbered list under the message, label visible, `Tab` focuses, `Enter` reveals the hidden prompt in the composer for editing — never submits by itself (OUTPUT_FORMAT.md rule).
- Format errors: a dim notice "format: 2 issues" with the catalogue codes; the message text still renders.
- `renderTerminal` stays as the non-interactive path (`mars render`) and the two must agree on fixtures (section 8).

### 2.10 Model and cost indicator; free-first and paid consent

`/model` opens Oh My Pi `model-picker` fed from `mars models` registry: grouped `free · local · paid`, with price columns and `unavailable` rows dimmed with the reason. Choosing a paid model does not switch anything: it stages the choice for the next start/resume card, which then shows a second line `Paid: $X in / $Y out per 1M · budget cap $Z · children stay free · confirm with p`. Without `p` the card starts on the free route. The status line's `paid` colour persists for the whole task.

## 3. MARS Shell desktop information architecture

MARS Shell is a desktop window over the same workbench RPC. It owns no model, no tools, no history and no agent loop; Oh My Pi inside the workbench remains the only runtime owner. Every view below is a projection of the same events, artifacts and RPC methods the terminal client uses, so a session opened in one client is identical in the other.

Technology constraint for the builder: a Bun-compatible desktop shell (Tauri or Electron; decide in PR 1 of the Shell track with a one-page ADR) whose renderer uses the same TypeScript projection module as the CLI (`packages/ui-core`, section 8) and the same output-format package. The renderer must enforce the VS Code webview's rules: textContent-only DOM for model text, strict CSP, no remote content, artifacts verified by SHA-256.

### 3.1 Windows and panes

One main window per workbench connection; additional windows are plain duplicates (no state). Panes (resizable, collapsible, layout saved locally in `~/.mars/shell/layout.json`, never in the workbench):

```
┌ sidebar ──────┬ main ───────────────────────────────┬ inspector ─────────┐
│ session       │ transcript (same entries as 2.1,    │ task: request,     │
│ switcher      │ same collapse rules)                │ approvals, model,  │
│ workspace     │                                     │ budget, criteria   │
│ tree          │                                     │ changes / evidence │
│ tasks         ├ composer ───────────────────────────┤ research / children│
│               │ same providers as 2.2               │ proposals          │
└───────────────┴ status bar (same segments as 2.3) ──┴────────────────────┘
```

### 3.2 Session switcher

Sidebar list of tasks (`tasks.list`), grouped by status, with the same columns as `/tasks`; a workbench selector when more than one connection file exists (`~/.mars/workbench/*/connection.json`). Switching never restarts anything.

### 3.3 Workspace and task views

- Workspace tree: read-only listing of the task's private workspace from `tasks.inspect`; clicking a file opens a read-only viewer with the task's diff for that file overlaid. No editing — edits happen through the agent with approvals, or in the user's own editor on the real repository.
- Task view (inspector): request, acceptance criteria with their verify state, approvals granted, model and tier, budget gauges, checkpoints (`tasks.checkpoint`/`tasks.restore` behind a confirm dialog), and the conventions summary (instructions loaded, hooks, slash commands).
- Changes: side-by-side or unified diff (user setting) from `tasks.diff`, per-file accept-into-review is a `mars://review` steer draft, never a write.

### 3.4 Evidence and recording viewer

Tabbed inspector pane: verify records (pass/fail per criterion), watch evidence files (images shown inline here — the one place MARS renders captures — with the capture policy banner), recorded runs (`documentation/evidence/*` artifacts fetched via `tasks.artifact` with hash check), research findings with source links opened in the system browser after a confirm (external text is untrusted and never fetched by the Shell itself).

### 3.5 Settings

Local-only (per machine): theme (dark/light/system, maps to the same token table as section 4), font, density (comfortable/compact), reduced motion, notification sounds, default mode (`ask`/`plan`/`auto-edit`; `sandbox` only if the host has an image), workbench connections. Workbench-owned settings (model policy, `allowPaid`, capture roles, budgets) are displayed read-only with "set in `mars serve` flags / policy file" and are never editable from the Shell in this scope.

### 3.6 Contract reuse and the no-second-loop rule

- The Shell imports `@mars/output-format` and `@mars/ui-core` (projection + keymap + strings) and nothing from `@oh-my-pi/*` except `pi-tui` theme JSON for tokens.
- Every mutation is one of the RPC methods in section 0; the Shell adds no endpoints and the workbench adds none for it beyond what the CLI needs.
- Children, research, proposals and verification are observed, not driven: the Shell never calls a model, schedules a job or runs a command.
- If a feature cannot be expressed as an RPC call that the terminal client also makes, it is out of scope for the Shell.

## 4. Visual system

Derived from Oh My Pi's shipped themes (the MARS client is a pi-tui program, so Oh My Pi's semantic tokens are the base) with Hermes-informed rules for density and calm. Values below are from `@oh-my-pi/pi-tui@18.14.0` `src/theme/dark.json` and `light.json` `[source]`; note that the coding agent's shipped default dark theme is `titanium` (`settings.ts` `theme.dark`), not `dark.json` (A.4). `themes/mars-dark.json` therefore extends `titanium` (accent `#00b4ff`, `borderMuted` `#1f252d`, `success` `#00ff88`, `error` `#ff4757`, `warning` `#ffb347`, `muted` `#9ca3b0`, `dim` `#6b7280`, `selectedBg` `#0082b3`, `userMessageBg`/`toolPendingBg`/`toolSuccessBg`/`statusLineBg` `#0f1216`, `toolErrorBg` `#1a0f10`, `mdCode`/`toolDiffAdded` `#00ff88`, `toolDiffRemoved` `#ff4757`, `statusLineSpend`/`statusLineCost` `#d4c090`) and `themes/mars-light.json` extends `light.json`; both re-map semantics only and introduce no new hex values in the terminal. The full 67-token table for `dark.json`, `light.json` and `titanium` is in `documentation/ui-research/oh-my-pi/REPORT.md` Q1.

### 4.1 Typography

- Terminal: the user's monospace font; the client assumes nothing beyond the Unicode set in pi-tui `symbols.ts` `unicode` preset, with `nerd` opt-in and `ascii` fallback (`/symbols` or `MARS_SYMBOLS=ascii`). No italics by default (many terminals render them as reverse video); bold only for user text and card titles; dim for provenance and hints.
- MARS Shell: a monospace stack for transcript code and diffs (`JetBrains Mono`, `Cascadia Code`, `SF Mono`, `Menlo`, `monospace`), a UI sans stack for chrome (`Inter`, `system-ui`). Sizes: 13 px transcript, 12 px chrome, 11 px status bar at the default density; line-height 1.45. <!-- RESEARCH: Hermes font/weights -->

### 4.2 Colour tokens

Base palette variables (dark / light):

| var | dark | light |
| --- | --- | --- |
| accent | `#febc38` | teal `#5a8080` |
| cyan / teal | `#0088fa` | `#5a8080` |
| blue | `#178fb9` | `#547da7` |
| green | `#89d281` | `#588458` |
| red | `#fc3a4b` | `#aa5555` |
| yellow | `#e4c00f` | `#9a7326` |
| gray / mediumGray | `#777d88` | `#6c6c6c` |
| dimGray | `#5f6673` | `#767676` |
| darkGray / lightGray | `#3d424a` | `#b0b0b0` |
| selectedBg | `#31363f` | `#d0d0e0` |
| userMsgBg | `#221d1a` | `#e8e8e8` |
| toolPendingBg | `#1d2129` | `#e8e8f0` |
| toolSuccessBg | `#161a1f` | `#e8f0e8` |
| toolErrorBg | `#291d1d` | `#f0e8e8` |
| customMsgBg | `#2a2530` | `#ede7f6` |
| terminal background / foreground | `#18181e` / `#cccccc` | `#f8f8f8` / `#3b3b3b` |
| export pageBg / cardBg / infoBg (used by MARS Shell) | `#18181e` / `#1e1e24` / `#26262e` | `#f8f8f8` / `#ffffff` / `#fffae6` |

Semantic tokens the client uses (Oh My Pi name → MARS use; dark → light where the value differs from the var above):

| token | MARS use | dark | light |
| --- | --- | --- | --- |
| `accent` | focused card border, prompt glyph in `ask` mode, selected list item text | accent | teal |
| `border` / `borderAccent` / `borderMuted` | card frames / focused frame / dividers | blue / cyan / darkGray | blue / teal / lightGray |
| `success` / `error` / `warning` | verify pass, tool ok / failures, blocked hooks / paid tier, budget ≥ 80 % | green / red / yellow | green / red / yellow |
| `muted` / `dim` | provenance lines, hints, counts | gray / dimGray | mediumGray / dimGray |
| `thinkingText`, `thinkingOff…thinkingXhigh` | thinking header by effort | gray; darkGray, dimGray, `#178fb9`, `#0088fa`, `#b281d6`, `#e5c1ff` | mediumGray; lightGray, `#767676`, blue, teal, `#875f87`, `#8b008b` |
| `userMessageBg/Text` | user requests and steers | userMsgBg | userMsgBg |
| `customMessageBg/Label` | quoted untrusted text (research excerpts, repo instructions, evidence) — label `#b281d6` | customMsgBg | customMsgBg / `#7e57c2` |
| `toolPendingBg/SuccessBg/ErrorBg`, `toolTitle`, `toolOutput` | tool and hook cards | as vars; output gray | as vars; output mediumGray |
| `toolDiffAdded/Removed/Context` | diffs everywhere | green / red / gray | green / red / mediumGray |
| `mdHeading`, `mdLink`, `mdLinkUrl`, `mdCode`, `mdCodeBlock`, `mdCodeBlockBorder`, `mdQuote`, `mdQuoteBorder`, `mdHr`, `mdListBullet` | assistant markdown | `#febc38`, `#0088fa`, dimGray, `#e5c1ff`, `#9CDCFE`, gray, gray, darkGray, darkGray, accent | yellow, blue, dimGray, teal, green, mediumGray, mediumGray, mediumGray, mediumGray, green |
| `syntax*` | code blocks and diff bodies | VS Code Dark+ set (`#6A9955 #569CD6 #DCDCAA #9CDCFE #CE9178 #B5CEA8 #4EC9B0 #D4D4D4`) | Light+ set (`#008000 #0000FF #795E26 #001080 #A31515 #098658 #267F99 #000000`) |
| `statusLineBg`, `statusLineModel`, `statusLinePath`, `statusLineContext`, `statusLineSpend`, `statusLineSubagents` | status line segments (2.3); MARS `tier`, `approvals`, `verify` segments reuse `statusLineModel`, `statusLineGitClean`/`Dirty`, `success`/`error` | `#121212`, `#d787af`, `#00afaf`, `#8787af`, `#5fafaf`, accent | `#e0e0e0`, `#875f87`, `#005f87`, `#5f5f87`, `#005f5f`, teal |
| `bashMode`, `pythonMode` | unused in MARS (no client shell); reserved | — | — |
| `link` | external links (dim URL after label) | `#0088fa` | blue |

MARS adds exactly these semantic tokens in its theme file (`themes/mars-dark.json`, `themes/mars-light.json`, pi-tui theme schema, loaded with `/theme mars-dark`): `paidTier` → `warning`, `freeTier` → `success`, `localTier` → `blue`, `untrustedLabel` → `customMessageLabel`, `verifyPass` → `success`, `verifyFail` → `error`, `staleFinding` → `dim`. They are aliases of existing tokens so the theme degrades to the base Oh My Pi dark/light look when the MARS file is absent.

Colour depth: pi-tui detects `truecolor` or `256color` only (`theme/color.ts`, `terminal-capabilities.ts`) and honours `NO_COLOR` only for OSC 8 hyperlinks `[source]` (A.4). `@mars/ui-core` therefore owns a colour policy in front of the theme loader: `COLORTERM=truecolor`/`24bit` → truecolor; otherwise 256; `TERM` without 256 support → `mars-ansi.json` (tokens mapped to the theme's `terminal.ansi` indices); `NO_COLOR` → a monochrome theme in which every colour token is the terminal default and status is carried by glyph, word and indent. Oh My Pi's `colorBlindMode` (shifts `toolDiffAdded` toward blue) is exposed as `/settings colourblind on`.

### 4.3 Spacing and density

- Indent unit: 2 columns. Card content indented 2 from its frame; nested child cards +2.
- Vertical: 0 blank lines between entries of the same turn, 1 between turns, 1 above and below a card with a frame. Never 2 consecutive blank lines.
- Frames only for: user messages, approvals and consent, writing blocks, proposals, errors. Tool cards use a background band, not a box. Assistant prose has no frame.
- Width: content wraps at `min(cols − 2, 120)`; diffs never wrap (horizontal scroll in the viewer, truncated with `…` inline).
- MARS Shell densities: comfortable 8 px grid, compact 4 px grid; both share the terminal rules above expressed in rem.

### 4.4 Motion and reduced motion

- Spinners: Oh My Pi `SPINNER_FRAMES` — `status` braille `⣾⣽⣻⢿⡿⣟⣯⣷` for the running task indicator in the status line, `activity` `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` on the one running tool card; ASCII `| / - \` under `ascii`. 80 ms per frame; one spinner per running thing (P4).
- Streaming text: appended per delta, no character-by-character typing effect; a trailing `▍` cursor only on the live assistant entry.
- Shimmer (`theme/shimmer.ts`, modes `classic | kitt | disabled`, 30 cells/s) only on the "working" label; `disabled` when reduced motion is set. `display.smoothStreaming` (per-character pacing) is off: MARS appends deltas as they arrive.
- Reduced motion: pi-tui has no TUI-wide reduced-motion setting (only `display.shimmer=disabled`, `display.smoothStreaming=false` and the native-surface `reduceMotion` flag `[source]`, A.4), so `@mars/ui-core` adds one: `MARS_REDUCED_MOTION=1`, `/settings motion off`, or the terminal's reduced-motion signal (pi-tui `native/node.ts`) → static `●` instead of spinners, no shimmer, no cursor blink. MARS Shell also honours `prefers-reduced-motion`.
- Nothing animates after completion; status band colour changes are instant.

## 5. Interaction specifications

### 5.1 Keyboard

Global (transcript focused or composer empty):

| Key | Action |
| --- | --- |
| `Enter` | Submit request/steer; on a focused card, the card's default (open, not approve) |
| `Shift+Enter`, `Ctrl+J` | Newline in composer |
| `Esc` | Cancel the current turn (`tasks.cancel`, reason `user_interrupt`); if nothing runs, clear the composer; if an overlay is open, close it |
| `Esc Esc` (empty composer) | Edit the previous request/steer: the text returns to the composer and the rewind picker offers the matching checkpoint (`tasks.restore` after confirm; Codex edit-previous and Claude Code rewind, A.1/A.2) |
| `Ctrl+C` | First press: hint `press again to quit (tasks keep running)`; second within 2 s: quit client |
| `Ctrl+D` | Quit when the composer is empty (Codex uses it as delete-forward; MARS follows the shell/Claude convention and says so in `?`) |
| `Ctrl+L` | Redraw |
| `Ctrl+O` | Expand/collapse focused entry; `Ctrl+Shift+O` expand all tool output in view (Codex binds `Ctrl+O` to copy and `Ctrl+T` to its transcript; MARS keeps `Ctrl+T` for thinking and uses `y` for copy — documented in `?`) |
| `Ctrl+T` | Toggle thinking visibility for the whole transcript |
| `Shift+Tab` | Cycle mode `ask → plan → auto-edit → sandbox(if available) → ask` (Oh My Pi binds this to thinking level; MARS moves that to `Alt+T`) |
| `Alt+T` | Cycle thinking level (`/thinking`); shows the pi-tui `thinking*` colour for the level |
| `Alt+M` | Model picker (`/model`): free and local models first, paid ones labelled and gated by the consent card |
| `Ctrl+Enter` | Approve the pending card outright (Oh My Pi `app.approval.approve`); the card arms 500 ms after it appears so a stray `Enter` cannot approve |
| remap | `~/.mars/ui/keybindings.yml`, same schema as Oh My Pi `KeybindingsManager` (`action-id: "Ctrl+P"`, `[]` disables); every hint renders from the live map (`appKeyHint`) so hints never drift from bindings. MARS never reads `~/.omp` |
| `Tab` | In a non-empty composer while running: queue the message for the next turn; otherwise move focus between composer, pending card, follow-up buttons |
| `Up`/`Down` | History when composer cursor is at the first/last line; otherwise move the cursor |
| `PgUp`/`PgDn`, `Ctrl+U`/`Ctrl+D` in transcript | Scroll; `g`/`G` top/bottom when transcript focused |
| `Ctrl+R` | History search |
| `Ctrl+X` | Remove the focused queued steer |
| `y` on a focused entry | Copy entry text (OSC 52 when supported, else writes `~/.mars/clipboard.txt` and says so) |
| `?` | Keybinding help overlay (pi-tui `hotkeys-markdown`); `F2` warnings list from `workbench.describe` health |
| `/` at line start | Command autocomplete; `@` path autocomplete; `#` acceptance-criterion id |

Cards: `y`/`n` answer, `1 2 3` toggle approvals, `m` model, `e` edit request, `p` confirm paid, `a`/`r`/`l` accept/reject/later on proposals, `o` open the diff viewer on a review link. Diff viewer: `j/k` hunks, `n/p` files, `Enter` review-link draft, `q` close. Lists: `Enter` select, `/` filter, `c` cancel task, `r` resume.

All bindings come from one `keymap.json` in `@mars/ui-core` (pi-tui keybinding format) so MARS Shell and VS Code read the same table; user overrides in `~/.mars/keybindings.json`.

### 5.2 Slash commands

`/help`, `/permissions` (alias `/mode`: the four MARS modes, each with its consequence sentence; the current one marked `(current)`), `/tasks`, `/new [request]`, `/resume [id]`, `/cancel`, `/model`, `/approve` (reopen the card), `/diff [path]`, `/review <path>:<line>[-<end>]` (drafts a `mars://review` steer), `/children`, `/research`, `/evidence`, `/proposals`, `/cost`, `/context`, `/status` (the `workbench.describe` summary: owner, project, image digest, policy, conventions loaded), `/theme`, `/symbols`, `/settings`, `/commands` (repository commands from PR #53, shown with their expansion preview before use), `/export [file]` (projection as Markdown, nothing executed), `/quit`. Repository commands appear as `/<dir>:<name>` with a `repo` badge and are expanded by the host at start (`conventions.applied`), never by the client. There is no `/compact` until the runtime enables compaction; the command exists and answers "compaction is disabled by the host".

### 5.3 Approval and permission flows

| Flow | Trigger | Card content | Answer | Result |
| --- | --- | --- | --- | --- |
| Read | start/resume | always granted in every mode; shown for completeness | — | `approvals.read = true` |
| Write | start/resume in `ask`; pre-set in `auto-edit`/`sandbox` | files are written only inside the private workspace; diff appears in Changes | `2` toggles, `y` | `approvals.write` |
| Execute | start/resume when `describe.image` present | image digest, network policy, timeout; dim with reason otherwise | `3` toggles, `y` | `approvals.execute`; refused with reason if no image |
| Paid consent | a paid model staged via `/model` | price in/out per 1M, budget cap, "children stay free", provider name | `p` then `y` | `model` id passed to start; status line `paid` |
| Screen capture opt-in | user runs `/evidence capture on` (only if policy exposes it) | role list that would gain `mars_watch_capture`, what is stored, how to turn it off | `y` | host policy call; if the host refuses (default today), the card shows `disabled by workbench policy` and the flag to change it |
| Restore checkpoint | `Esc Esc` or `/rewind` | checkpoint id, time, files affected | `y` | `tasks.restore`; transcript marks the fork |
| Cancel | `Esc` while running, `/cancel`, `c` in `/tasks` | none for `Esc` (immediate, visible as `cancelling…`); confirm for list cancel | — | `tasks.cancel` |

Repository instruction files, hooks and slash commands are shown on the start card and in `/status` with `trusted: --trust-project` or `not loaded`; they are never silently applied.

### 5.4 Error and unavailable states

| State | Render | One action |
| --- | --- | --- |
| Workbench unreachable | header `disconnected · retrying 3s`; composer disabled | `/status` shows the connection file path and `mars serve` hint |
| Auth failure (401) | error-block "token rejected" | re-read connection file (`/status reconnect`) |
| `model_unavailable` | notice + task `paused` | `/model` to pick another free model, then `r` |
| Budget exhausted | notice with the cap | `/resume` with a new budget (card shows the field) |
| 409 conflict (`task_not_running`, `revision_mismatch`…) | notice with the code | refresh projection; no retry loop |
| Execute requested without image | dim toggle with reason | none; link to `documentation/EXECUTION_WORKBENCH.md` |
| Format errors in output | dim notice, text still shown | `Ctrl+O` lists codes |
| Oversized response (4 MiB) / event cap | page again automatically; notice only if paging fails | — |
| Terminal < 60×16 | single-line "resize to at least 60×16"; nothing else renders | — |

### 5.5 Long output

Tool output > 6 lines collapses to head 4 + `… +N lines (Ctrl+O)` + last line. Expanded output lives in `output-pane` with its own viewport (max 60 % of rows) and never pushes the composer off screen. Binary or > 128 KiB outputs show size and a hash only. Diffs cap at 40 lines per file inline. Streaming assistant text longer than the viewport auto-scrolls only while the user is at the bottom; any scroll-up pins the view and shows `↓ new output` in the status line.

### 5.6 Interruption, cancel, resume

- `Esc` → `tasks.cancel`; the running card gets `cancelled` band immediately, the host's final `task.updated` confirms. Steers typed during `cancelling…` queue.
- Quitting the client never cancels tasks; on next launch the client lists running/paused tasks first.
- `/resume` → card 2.4 pre-filled with prior approvals and model; the projection replays from `tasks.events` without re-running anything; a `resumed` divider marks the point.
- Restores are forks: entries after the checkpoint stay visible, dimmed, with a `superseded` label.

## 6. Accessibility, terminal compatibility, performance budgets

- Sizes: minimum 60×16; full layout ≥ 100×30; header hidden < 30 rows; status line collapses segments right-to-left; inspector-style panels are overlays, never side panes, in the terminal.
- Colour depths: truecolor, 256, 16, and `NO_COLOR`; every status is also carried by a glyph or word (`✓`/`ok`, `✗`/`fail`) so colour is never the only channel.
- Glyphs: `unicode` default, `nerd` opt-in, `ascii` fallback auto-selected when `LANG`/`LC_ALL` lack UTF-8 or `MARS_SYMBOLS=ascii`.
- Screen readers: `/settings accessible on` switches to a linear mode: no spinners, no in-place updates, each completed entry printed once as plain text with its status word, prompts as plain questions; MARS Shell uses semantic roles (`log` for transcript with `aria-live=polite`, `dialog` for cards, `button`s for follow-ups) and full keyboard operability.
- Multiplexers: tmux/screen detected via pi-tui `terminal-multiplexer.ts`; passthrough for OSC 52 and kitty graphics only when the multiplexer allows it; otherwise copy falls back to a file and images to a path.
- Performance budgets (measured in the snapshot harness, section 8): first frame ≤ 150 ms after connection; render ≤ 16 ms per frame at 120×40 with 2,000 entries; CPU idle < 1 % with one spinner; memory ≤ 150 MB for a 10,000-event task (projection trims to 2,000 rendered entries); RPC polling 250 ms while running, 2 s idle, exponential to 30 s when disconnected; MARS Shell: cold start ≤ 2 s, transcript scroll 60 fps on 5,000 entries (virtualised list).

## 7. Non-goals and constraints

From `documentation/MASTER_SPECIFICATION.md` §3, §5, §14, `SECURITY_MODEL.md` and `HANDOFF.md` decisions:

- No competing agent loop. Neither client imports `createAgentSession`, runs Oh My Pi's interactive mode, calls a model, schedules a job or executes a command. All execution is `tasks.*` over the workbench RPC. `enableMCP: false`, `enableLsp: false`, `disableExtensionDiscovery: true` stay as they are; the clients do not add MCP, LSP or extension surfaces.
- One owner per store. The clients persist only local UI preferences (`~/.mars/shell/`, `~/.mars/keybindings.json`, theme choice). History, memory, skills, research, evidence and tasks are read through RPC and never cached to disk by a client.
- Untrusted external text. Model output, repository instruction files, research excerpts, evidence text and child results render as data (textContent / pi-tui text nodes), carry provenance, and never trigger actions. Follow-ups and review links require an explicit key press and show their payload first. `app://` triggers stay disabled until a connector registry exists.
- Approvals are host-enforced at start/resume; the UI never implements its own permission logic or "allow always" rules beyond the four modes in 2.3, and never offers a bypass-all mode.
- Free-first. Paid selection is two-step, named, and task-scoped; children never inherit it.
- Evidence language. "Completed" is a task status; "verified" requires a `verify` record or acceptance-criterion evidence. No "improved" claims without the experiment record.
- No parity claims. This document borrows observed conventions; MARS does not claim compatibility or parity with Claude Code, Codex, Hermes, Warp, Zed, Cursor or Aider, and no proprietary source or assets are copied. The output format accepts `codex://review` and `:codex-followup` only as import aliases for text written against a third-party description; the Codex CLI source at `rust-v0.166.0` contains no `codex://review` link and no follow-up or writing-block syntax (only `codex://threads/*`) `[source]` (A.2), so the UI must not present these aliases as Codex compatibility.
- Out of scope for this spec: editing files in the Shell, a web dashboard (spec §15 `apps/dashboard`), mobile, remote (non-loopback) connections, voice, screen-capture by default, and any change to the runtime or RPC beyond additive read-only fields listed in 8.3.

## 8. Acceptance criteria and staged build plan

### 8.1 Offline-verifiable acceptance criteria

All checks run under `bun run check` with `model_requests: 0`, on fixtures in `packages/ui-core/fixtures/` and `documentation/ui-research/fixtures/`.

1. Projection: given `fixtures/events/*.jsonl` (one file per event type in 2.1, plus a 10,000-event task), `projectTranscript` produces the expected entry list (golden JSON) and trims to 2,000 rendered entries.
2. Snapshot rendering: pi-tui renders each fixture at 60×16, 80×24, 120×40, 200×50 in truecolor, 256, 16 and `NO_COLOR`, `unicode` and `ascii` presets; snapshots are stored as text under `fixtures/snapshots/` and compared byte-exact. Includes: every card type, collapsed and expanded tool output, a 40-line diff clamp, a writing block with disabled `app://` chip, a follow-up list before and after reveal, each error state in 5.4, the start card with and without an image digest, the paid consent line.
3. Output-format agreement: for every fixture in `packages/output-format/fixtures/`, the interactive renderer and `renderTerminal` produce the same visible text when the interactive view is fully expanded.
4. Keymap: one table drives CLI and Shell; a test asserts no duplicate bindings per context and that every slash command in 5.2 has help text.
5. RPC client: against the fixture workbench (`packages/workbench` test harness), the client performs start with the three approvals, steer, cancel, resume and restore, sends no other method, and never sends `execute: true` when `describe` has no image.
6. No-execution guarantee: a test feeds output containing follow-ups, review links, `app://` and shell-looking text; the client emits zero RPC calls until a key press, and the only call after `Enter` on a follow-up is a composer fill (no network).
7. Resume: a recorded run (events + user keystrokes as a fixture) replayed from the middle yields the same final snapshot as the uninterrupted run.
8. Performance: the 10,000-event fixture renders its first frame in ≤ 150 ms and each subsequent frame ≤ 16 ms on the CI runner (measured, recorded in the test output, soft-fail only above 2× budget).
9. Theme: `themes/mars-{dark,light}.json` validate against pi-tui's theme schema and only alias existing tokens.
10. Recorded run: one `documentation/evidence/ui/<date>-cli-fixture-run.cast` (asciinema) of the fixture workbench session, plus PNG frames, checked in with the PR that claims the criterion — labelled as fixture evidence, not live-model evidence.
11. Shell: the Shell renderer passes the same projection and snapshot tests through a DOM serialiser; a CSP test asserts no `unsafe-inline`, no remote origins; an accessibility test (axe) on the fixture transcript reports no violations.

### 8.2 Staged plan

- **PR 1 — `@mars/ui-core` and `mars session` read-only.** New package `packages/ui-core` (projection, keymap, strings, theme files, fixtures), `apps/cli` gains `mars session [task]`: connect, task list, transcript projection with all card types collapsed/expanded, status line, `/help`, `/tasks`, `/resume` (view only), `/export`, `Esc` cancel. No start/steer yet. Criteria 1, 2, 3, 4, 8, 9, 10.
- **PR 2 — write path.** Start card with approvals and paid consent, `/model`, `/mode`, steer, queued steers, diff viewer, review-link drafts, follow-up reveal, `/rewind`, error states, accessible mode. Criteria 5, 6, 7. VS Code: adopt the shared keymap/strings and the paid-consent line (no new features).
- **PR 3 — MARS Shell MVP.** `apps/shell` with the ADR, sidebar/main/inspector, session switcher, transcript, composer, changes (side-by-side), evidence viewer with inline images, settings; reuses `@mars/ui-core` and `@mars/output-format`. Criterion 11 plus 1–7 through the DOM serialiser.
- Later (not in this spec's PRs): `/research` and `/proposals` actions once the proposal RPC exists; `/evidence capture on` once the policy call exists; compaction UI when the runtime enables it.

### 8.3 Additive host changes the plan may need (read-only, decided in PR 1)

`workbench.describe` → `connectors: []`, `image: {digest} | null`, `conventions: {instructions, hooks, commands}`, `policy: {allow_paid, allow_screen_capture}`; `tasks.inspect` → `model_tier`, `usage_totals`. Nothing else; no new write methods.

## 9. Final implementation prompt

<!-- DRAFT: tighten after research is folded in; keep < 2,500 words -->

You are building the MARS terminal client and the MARS Shell desktop app for `tanaypatel917-lab/MARS-Send-Youre-AI-To-Space` (Bun 1.4.4 TypeScript monorepo). Read `documentation/UI_PROMPT.md` in full first; this prompt is its section 9 and defers to sections 0–8 for every detail. Then read `HANDOFF.md`, `README.md`, `documentation/MASTER_SPECIFICATION.md` §3 §5 §14, `documentation/WORKBENCH_RPC.md`, `documentation/OUTPUT_FORMAT.md`, `packages/output-format`, `apps/cli`, `apps/vscode`, and the installed `@oh-my-pi/pi-tui@18.14.0` source under `node_modules/.bun/`.

**What you are building.** An interactive `mars session` TUI in `apps/cli`, a shared `packages/ui-core`, and (PR 3) `apps/shell`. Both are thin clients of the loopback workbench RPC. Oh My Pi inside the workbench is the only agent runtime; you add no model calls, no tools, no shell, no history store, no MCP/LSP, and no permission logic beyond displaying the four modes and sending the three approvals at `tasks.start`/`tasks.resume`.

**Build order.** Three PRs as in §8.2. Each PR: branch `devin/<timestamp>-ui-pr<N>`, `bun run check` green offline (`model_requests: 0`), fixtures and snapshots committed, HANDOFF.md status row updated, no runtime or RPC changes except the additive read-only fields in §8.3 (PR 1 only, with their own tests).

**Terminal client.** Compose it from pi-tui, instantiating `new TUI(new ProcessTerminal())` yourself (never Oh My Pi's `Composer`/`InteractiveMode`, which own an agent session): `TranscriptContainer`-style root whose settled rows retire into terminal scrollback, `components/editor` with the `band` composer shape, `status-line` segments with a MARS preset, `overlay-box` for the diff viewer and lists, `approval-dialog` styling for the inline start card, `tool-card`/`output-pane` for tools, `chrome/diff.ts` for hunks, `markdown` for assistant text, `select-list`/`tree-view` for `/tasks` and `/children`, `hotkeys-markdown` for `?`. Follow §2 for what each entry shows collapsed and expanded, §2.3 for the status segments and the four modes (`ask`, `plan`, `auto-edit`, `sandbox`), §2.4 for the start card (`y n 1 2 3 m e p`), §2.9 for output-format rendering through `processOutput` (writing blocks framed, `mars://review` → diff viewer, `:mars-followup` → reveal into composer, never submit), §5.1 for the full keymap, §5.2 for slash commands, §5.3–5.6 for approvals, errors, long output, cancel and resume.

**Visual system.** Use Oh My Pi's semantic tokens exactly as listed in §4.2; ship `themes/mars-dark.json` and `themes/mars-light.json` that only alias tokens (`paidTier`, `freeTier`, `localTier`, `untrustedLabel`, `verifyPass`, `verifyFail`, `staleFinding`). Spacing and frames per §4.3 (frames only for user messages, approvals, writing blocks, proposals, errors; tool cards use background bands). Motion per §4.4 (pi-tui `SPINNER_FRAMES`, 80 ms, one spinner per running thing, reduced-motion → static glyphs, nothing animates after completion). Glyph presets `unicode`/`nerd`/`ascii`; `NO_COLOR` and 16-colour must stay usable.

**MARS Shell.** Tauri or Electron (write the ADR first), renderer imports `@mars/ui-core` and `@mars/output-format` only; panes per §3.1; textContent-only model text, strict CSP, SHA-256-verified artifacts; evidence images inline only here; settings local-only; workbench policy read-only. If a Shell feature is not an RPC call the CLI also makes, do not build it.

**Hard rules.** Model output, repo instructions, research excerpts and evidence are untrusted text with visible provenance (`customMessageBg`, label `#b281d6`). Nothing parsed from output executes without a key press that first shows the payload. Paid models: two-step consent naming price, cap and "children stay free". No `/compact` behaviour (runtime compaction is off). No bypass-all mode; `danger-full-access` renders as refused. "Completed" ≠ "verified". No claims of parity with Claude Code, Codex, Hermes or others in code, docs or strings.

**Acceptance.** Implement every criterion in §8.1 for your PR; store fixtures under `packages/ui-core/fixtures/`, snapshots under `fixtures/snapshots/` at 60×16, 80×24, 120×40, 200×50 × {truecolor, 256, 16, NO_COLOR} × {unicode, ascii}; record one asciinema fixture run per PR under `documentation/evidence/ui/` labelled fixture evidence. Budgets: first frame ≤ 150 ms, frame ≤ 16 ms, idle CPU < 1 %, ≤ 150 MB at 10,000 events.

**Report.** In the PR description: what was built against which section numbers, which criteria pass with the command that proves it, what remains, and anything in this document that turned out wrong (file an issue, do not silently diverge).

## Appendix A. Research evidence

<!-- RESEARCH: filled from documentation/ui-research/<product>/REPORT.md -->

| Product | Version / revision studied | License | Method | Report |
| --- | --- | --- | --- | --- |
| Claude Code | — | proprietary (behaviour only) | — | `documentation/ui-research/claude-code/REPORT.md` |
| Codex CLI | — | Apache-2.0 | — | `documentation/ui-research/codex/REPORT.md` |
| Hermes Agent | — | — | — | `documentation/ui-research/hermes/REPORT.md` |
| Oh My Pi | `@oh-my-pi/pi-coding-agent` 18.14.0, `pi-tui` 18.14.0; manifest audited revision `5d30c790b883ad0ae05dac2a4d2ccc8ecd103611`, npm release revision `31147f9d1a76608549821c3759f8487b4d66c72d` | MIT | source in `node_modules`, run | `documentation/ui-research/oh-my-pi/REPORT.md` |
| Warp, Zed, Cursor, Aider | — | — | — | `documentation/ui-research/others/REPORT.md` |
| MARS repository | `main` at `aa85da5` + PR #53 | — | source | this document §0 |

### A.1 Claude Code
### A.2 Codex CLI

Report: `documentation/ui-research/codex-cli/REPORT.md` (13 screenshots in the same directory). Studied `codex-cli` 0.166.0 = `openai/codex` tag `rust-v0.166.0` @ `6ff1e1ca3b30fc8b914720681fcf5fe62e95f856`, Apache-2.0; `[ran]` the TUI without a login and with an invalid key, `[source]` `codex-rs/{tui,core,protocol,apply-patch}` and insta snapshots, `[docs]` developers.openai.com/codex (2026-11-03).

Borrowed (section → finding): P2/§2.4 approval modal anatomy and `✔/✗` decision log; P3/§2.1 5-line preview, `Explored ›` grouping, reasoning off the main view; §2.1 diff summary-first (`Edited N files (+a −b)` → `└ path`); §2.2 footer hints by state, `Tab` queue vs `Enter` inject, `Esc Esc` edit-previous; §5.2 `/permissions` presets with consequence lines and `/status` as one page; §6 narrow-width behaviour (right-side footer hides first). Not borrowed: `Full Access`/`danger-full-access`, `Approve for me` (LLM as approver), paid-first model list, `/agents`, account and plan surfaces, `!` shell mode, arbitrary `notify` programs, hidden reasoning, `Ctrl+O` = copy. Correction to this repo's assumptions: no `codex://review` or follow-up syntax exists at this tag (§7).
### A.3 Hermes Agent
### A.4 Oh My Pi

Report: `documentation/ui-research/oh-my-pi/REPORT.md` (13 screenshots). Studied `@oh-my-pi/pi-coding-agent` and `@oh-my-pi/pi-tui` 18.14.0 as installed in this repo (npm release revision `31147f9d1a76608549821c3759f8487b4d66c72d`; `sources/manifest.json` audits `5d30c790b883ad0ae05dac2a4d2ccc8ecd103611`), MIT; `[ran]` the real TUI with no API key (setup wizard, `/model`, `/hotkeys`, band status line, slash popup), `[source]` `pi-tui/src/{theme,components,chrome,prompt,status-line,overlays}` and `coding-agent/src/modes`, `[docs]` the repository `docs/` at the release revision. `/theme` and `/help` were not reached interactively (documented from source).

Borrowed: §4 token names and the `titanium` default; §2 `band` composer and `╰─ ` cue; `TranscriptContainer` scrollback model; `ToolCard` bands with a lower `collapsedMaxLines`; `renderDiff` unified diff with inverse intraline highlight; approval dialog docking, 500 ms arm delay, `Deny and send message`; context thresholds 50/70/90 %; status-line segment ids and presets; `KeybindingsManager` + `appKeyHint`; symbol presets `unicode|nerd|ascii`; braille spinners at 80 ms; shimmer modes; `colorBlindMode`; `WizardStep` live preview for first run. Not borrowed: `tools.approvalMode` default `yolo` and `--auto-approve`; headless `yolo` subagents and the Agent Hub; paid-first provider wizard and `/model` ordering; OSC 8 link activation and `/open` from model text; `/bash`, `!`, `/ssh`, Python REPL (host execution); speech, share, marketplace, self-updater, telemetry; `~/.omp` config root; embedding `Composer`/`InteractiveMode`. Corrections to this document's earlier assumptions: pi-tui has no 16-colour mode and ignores `NO_COLOR` for theme colours; there is no TUI-wide reduced-motion setting; the default dark theme is `titanium`, not `dark.json`. `omp --mode rpc` (JSONL: `prompt` with `streamingBehavior: steer|followUp`, `abort`, model/thinking commands, approval/ask sub-protocol) is a useful checklist for the workbench RPC, which MARS clients speak instead.
### A.5 Warp, Zed, Cursor, Aider
### A.6 Critical review

<!-- RESEARCH: reviewer child findings and how each was resolved -->
