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

### 0.1 Added on `main` since the first draft (the UI must show these, not re-implement them)

- `@mars/knowledge-graph` (PR #54): coordinator-only host tools `mars_graph_build` / `mars_graph_query`, a derived, revision-fenced graph (`not_built · building · ready r<N> · stale · unavailable · failed`); `graph.build` records arrive inside `tool.completed`; `@mars/context`, `@mars/memory` and the skill store stay the owners. Nothing for the client to call: it renders the tool cards and the state.
- `@mars/memory-vault` (PR #54): `mars vault export|import|status` operator commands; imports become revision-fenced *proposals*, never direct writes; deleted skills are archived. The client lists vault proposals under `/proposals` and shows the status counts; it never reads or writes the vault directory.
- `@mars/providers-omniroute` (PR #55): OmniRoute `v3.8.52` as one `openai-compatible` target; ids `omniroute/<provider>/<model>`; MARS keeps free/paid classification and consent (`X-MARS-Paid-Consent`, `X-MARS-Policy-Owner` headers are set by the host, never by a client); `capabilities: unknown` until discovery; curated catalog reported stale by `mars doctor` after 120 days. Live OmniRoute behaviour is unverified (fake gateway only).
- `@mars/codex-tools` and conventions (PR #53): `AGENTS.md`/`CLAUDE.md` discovery, `.mars/hooks.json`, slash-command expansion, attributed `apply_patch`; already summarised on the start card (2.4).
- Team Chat (PR #58, open): `@mars/team-chat` contracts and a feature-flagged, fixture-backed `mars.teamChat` view in `apps/vscode`; `team_id` is the tenant key, the host supplies the viewer identity, no network or durable storage yet. It is **not** workbench RPC and is not a terminal feature; §3.1 reserves a Shell pane for it.

## 1. Design principles

Each principle names the usability rule it enforces and where it was observed. The builder treats these as tie-breakers for every unlisted decision.

| # | Principle | Rule | Observed in |
| --- | --- | --- | --- |
| P1 | One place to look. The transcript is the only timeline; approvals, diffs, child results, research findings and proposals appear inline as cards at the moment they happen, and the same cards are what the side panels filter. | Recognition over recall; no state lives only in a panel. | Claude Code's single-stream transcript with inline tool cards; Codex's typed history cells. (Appendix A.1, A.2) |
| P2 | The model never acts; the user always sees what is about to happen before it does. Every destructive or paid step is a card with a default-safe answer, and every decision is logged in the transcript. | Visibility of system status; error prevention. | Codex `[source]` approval modal: question, `Reason:`, verbatim `$ command`, numbered options with hotkeys, `Esc` = safe no-with-feedback; decisions logged as `✔ You approved …` / `✗ You did not approve …` (A.2). Claude Code permission prompts (A.1). MARS already enforces the gate in the host. |
| P3 | Collapse by default, expand by one key. Tool output shows a short preview and a count; the full text is one keystroke away and never auto-expands. | Progressive disclosure; aesthetic and minimalist design. | Codex `[source]`: 5-line middle-truncated preview, `… +N lines (⌃t to view transcript)`, read-only commands grouped under `Explored › Read/List/Search`, reasoning kept out of the main view (A.2). Claude Code transcript expansion (A.1). Oh My Pi `thinking-display`/`read-tool-group`. |
| P4 | Quiet motion. One spinner per running thing, braille frames, no shimmer when `reduced motion` is set, nothing animates after completion. | Minimise distraction; accessibility. | Oh My Pi `SPINNER_FRAMES` (`status`/`activity` sets, ASCII fallback) and `shimmer.ts` with a `disabled` mode `[source]`; Hermes `[source]`: motion confined to chrome — spinner, verb and elapsed live only in the composer's top rule or status rule (braille 60–180 ms, cursor `▍` 420 ms), never in scrollback (A.3). |
| P5 | Dense but legible. One-column transcript, 2-space indents, framed cards only for things that need a boundary (approvals, diffs, writing blocks); plain text for prose. | Match the medium: terminals reward density, punish chrome. | Oh My Pi `message-frame`/`tool-card`; Hermes layout density (Appendix A.3, A.4). |
| P6 | Keys do the same thing everywhere. The same binding cancels, expands, approves and switches in the CLI, MARS Shell and VS Code; help is always `?`/`/help`, and bindings are remappable from one file. | Consistency and standards. | Codex `[ran]/[source]`: `Esc` interrupt, `Ctrl+C` twice to quit, `/` commands with descriptions, `@` mentions, `?` shortcut sheet, `/keymap` remap (A.2); Claude Code (A.1). |
| P7 | Context is a gauge, not a surprise. Remaining context, tokens and cost are always visible; compaction and budget exhaustion are announced before they happen; startup warnings are collected and viewable, not fatal. | Visibility of system status. | Codex `[ran]` footer `N% context left`, `⚠ 1 warning · f2 to view`, `/status` as one truthful page (model, provider, directory, permissions, AGENTS.md, session id, tokens, context window) (A.2); Claude Code context indicator and `/compact` (A.1); Oh My Pi `chrome/context-thresholds.ts`: `warning` at ≥50 % or 150k tokens, `purple` at ≥70 % or 270k, `error` at ≥90 % or 500k, driving the `context_pct` colour `[source]` (A.4). |
| P8 | Say what was checked, not what was done. Completion states cite the `verify` record, acceptance criteria and reviewer result; "task completed" without evidence renders as "finished, unverified". | Honesty; master spec §14, §17. | MARS master spec; Codex review flow summarising findings rather than claiming success. |
| P9 | Free by default, paid by choice. The model indicator shows tier and price; selecting a paid model is a two-step confirmation that names the price and scope; children stay free. | Error prevention; user control. | MARS provider policy `[repo]`; Claude Code `/cost` transparency; Aider per-message cost table (Appendix A.5). |
| P10 | Resume is first-class. Every session is listed with time, branch, request and last state; resuming replays the projection, never re-executes. | User control and freedom. | Claude Code `--resume` picker; Codex `codex resume`; Oh My Pi `session-selector` `[source]`. |
| P11 | Untrusted text looks untrusted. Repository instructions, research excerpts, model-proposed follow-ups and watch evidence are rendered in the same "quoted" style with their provenance, never as system text. | Security boundary made visible. | MARS security model `[repo]`; Codex labelling of AGENTS.md as project docs. |

### 1.1 Where usability (Claude Code / Codex) and design (Hermes / Oh My Pi) conflict

| Conflict | Claude Code / Codex convention | Hermes / Oh My Pi look | MARS choice | Why |
| --- | --- | --- | --- | --- |
| Permission prompts | Codex `/permissions`: four presets (`Read Only`, `Ask for approval`, `Approve for me`, `Full Access`), each with a one-line consequence and a second confirm for `Full Access` `[source]`; Claude Code `[ran]`: modes `manual`, `accept edits`, `plan`, `auto` (classifier-screened, now the default), `bypassPermissions`; footer `⏸ manual mode on · ? for shortcuts` / `⏵⏵ accept edits on (shift+tab to cycle)`; prompt `Yes` / `Yes, and don't ask again for: npm test *` / `Yes, and switch to auto mode` / `No`, `Tab to amend` (A.1). | Hermes has no per-tool permission prompt (A.3); Oh My Pi has `approval-dialog` overlay. | Inline card for task-start approvals rendered with Oh My Pi `approval-dialog` styling, one consequence line per approval, never an overlay that hides the transcript. No `Full Access`, no `Approve for me`, no `auto`/`bypassPermissions`: MARS has no unsandboxed mode and neither the model nor a classifier is the approver. The mode segment shows glyph and word (`⏸ ask`, `⏵ auto-edit`) with the next key. | Usability wins: the user must read what they are approving against the request. MARS has no mid-task prompts, so the card appears once per start/resume. |
| Colour accent | Claude Code: single warm accent; Codex: cyan/magenta. | Oh My Pi dark accent `#febc38` amber, light `teal`; Hermes palette (A.3). | Oh My Pi tokens verbatim; MARS adds no new accent. A MARS theme file only re-maps semantic tokens (section 4). | Native feel on the runtime's own TUI; theme switching stays `/theme`. |
| Status segment overflow | Codex hides the footer's right side when it would overlap `[source]` (A.2). | Hermes drops status segments by an explicit breakpoint table (72→110 cols) `[source]` (A.3); Oh My Pi presets `default/minimal/compact/full` (A.4). | Priority-ordered segments with a breakpoint table in `status-line/presets` (§2.3): < 72 cols keep mode · model · context only; ≥ 88 add cost; ≥ 104 add task title; ≥ 120 add git and session. | One explicit table is testable in snapshots; implicit overlap rules are not. |
| Tool output density | Claude Code: 1 summary line + "+N lines (ctrl+o)" (A.1); Codex 5-line middle-truncated preview `[source]` (A.2). | Oh My Pi `ToolCard`/`renderOutputBlock` with `collapsedMaxLines=10` and coloured background bands (`toolPendingBg/SuccessBg/ErrorBg`) `[source]` (A.4). | Keep the bands and the component; set `collapsedMaxLines=5` (setting `display.toolPreviewLines`) and use the count line. | Bands carry status; the cap carries calm. |
| Status line placement | Claude Code and Codex: footer below the prompt (A.1, A.2). | Oh My Pi default composer shape `band`: status as a powerline band *above* the prompt, `╰─ ` cue `[ran]` (A.4). | Band above the prompt (Oh My Pi), one state-driven hint row below it (Codex). | The band is the native Oh My Pi silhouette; the hint row carries the Codex discoverability without moving the status. |
| `Shift+Tab` | Claude Code cycles the permission mode (A.1). | Oh My Pi cycles the thinking level (`app.thinking.cycle`) `[ran]` (A.4). | Mode cycle; thinking level moves to `Alt+T` and `/thinking`. | Mode is a safety control and must be the cheaper gesture. |
| Colour depth | Codex inherits the terminal palette (named colours only) `[source]` (A.2). | pi-tui has exactly two `ColorMode`s, `truecolor` and `256color`; `NO_COLOR` only disables OSC 8 links `[source]` (A.4). | `@mars/ui-core` adds a colour policy above pi-tui: `NO_COLOR` → monochrome theme (all tokens terminal-default, status by glyph/indent), 16-colour terminals → `mars-ansi.json` built from the theme's `terminal.ansi` table. | Accessibility and `NO_COLOR` are MARS requirements that the base library does not meet. |
| Thinking display | Claude Code collapses thinking; Codex keeps reasoning out of the main view and uses its headline as the status text `[source]`. | Oh My Pi colours thinking by effort level (`thinkingOff…thinkingXhigh`). | Collapsed by default, Oh My Pi effort colour on the one-line header, `Ctrl+T` expands. | Both. |
| Status line | Claude Code: configurable command; Codex: footer hints. | Oh My Pi `status-line` segments and presets with per-segment colours. | Oh My Pi segments; MARS adds `model-tier`, `budget`, `approvals`, `children`, `verify` segments. | Reuse the preset system instead of a second config. |
| Slash command discovery | Claude Code/Codex: typed `/` opens a popup with descriptions. | Oh My Pi has the same (`autocomplete.ts`, `slash-commands/`). | Oh My Pi autocomplete; MARS supplies its own command list (section 5.2). | No conflict; listed so nobody writes a new popup. |
| Context cost | Claude Code `/context` category grid (A.1); Aider `/tokens` lists every item with tokens, cost and a remedy (`/drop`, `/clear`) `[ran]` (A.5). | Oh My Pi `context-usage` bar only (A.4). | `/context` = Oh My Pi bar in the status line **plus** the Aider-style per-row table (tokens · $ · source · remedy) in the overlay (§2.11). | A gauge says *how full*; only the table says *what to drop*. |
| Auto-allow rules | Codex approval presets; Claude Code `Yes, and don't ask again for: npm test *` (A.1); Warp per-permission `Always allow` and Zed regex `always_allow` with a deny > confirm > allow precedence `[docs]` (A.5). | — | None in the client. Approvals are three task-scoped host decisions at start/resume; the client shows the host's policy precedence read-only in `/permissions`. | A rule the client evaluates is a second permission system (§7). |
| Interrupt key | Codex `[source]`: `Esc` interrupts, `Esc Esc` on an empty composer edits the previous message (fork), `Ctrl+C` interrupts during a turn and quits on the second idle press; Claude Code `[docs]`: `Esc` stops the response, `Esc Esc` opens Rewind, `Ctrl+C` clears then exits (A.1). | Oh My Pi `[source]`: `Esc` = `app.interrupt`, double `Esc` = rewind, `Ctrl+C` clear/exit, `Ctrl+D` exit (A.4). | `Esc` = cancel current task turn (RPC `tasks.cancel` with reason `user_interrupt`); `Ctrl+C` twice = quit client (tasks keep running in the workbench). | The workbench owns execution, so "interrupt" and "quit" are different operations and both must be visible. |

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
| Assistant text | **Today**: only the final artifact (`task.artifacts`, `text/plain`, via `tasks.artifact`) carries assistant text; a live `execution.observed` payload (`packages/workbench/src/host.ts`) is `{upstream: {runtime, session_id, entry_ids}, kind, summary?}` — journal entry ids, no text. So a running task renders a `turn` marker per observed event (kind + summary, spinner while running) and the full text appears when the final artifact lands. **With the PR 1 read-only addition** `tasks.journal` (§8.3) the client resolves `entry_ids` to Oh My Pi journal text and renders turns as they arrive; there are still no token-level deltas, so "streaming" fixtures are sequences of observed events + journal replies | Markdown via pi-tui `markdown` component; final turn re-rendered through `processOutput` (section 2.9). | — |
| Thinking | `execution.observed.kind` is the Oh My Pi *agent event type* the runtime observed (`packages/execution/src/runtime.ts`), not a journal entry kind, so the client never infers "reasoning" from it. Reasoning is identified only from the entry kind that `tasks.journal` returns for the observed `entry_ids`; without `tasks.journal`, or when the runtime does not journal reasoning, there is no thinking row at all — only the generic turn marker above | One dim line `thinking · 12s` coloured by effort token; collapsed. | Full text, `thinkingText` colour. |
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

Transcript grammar: user turns are a `❯` row (inverse pill in Claude Code, plain glyph in Hermes; MARS uses the Hermes row with `userMessageBg` only on the first line), results indent four columns under a `⎿` connector (Claude Code, A.1), and each turn ends with a collapsed tree summary `├─ ▸ Thinking ~N tok · ├─ ▾ Tools (N) · └─ Σ 12 s · 2.1k tok · $0.00` whose sections are `hidden|collapsed|expanded` per `/details` setting (Hermes turn tree, A.3; activity hidden by default, failures stay inline). Hard budgets live in one `limits.ts` shared with MARS Shell (live tail 240 lines / 16k chars, tool preview 5 lines, system notices collapse at 400 chars) and every truncation says what was omitted (Hermes, A.3). Rules: no entry re-orders after rendering; streaming text updates in place; a card changes its band colour when its status changes but never its position. Entries older than the viewport do not animate.

### 2.2 Composer

Oh My Pi `prompt/composer.ts` reused as-is: multi-line editor, `Shift+Enter`/`Ctrl+J` newline, `Enter` submit, bracketed paste, history (`Up`/`Down` when the cursor is on the first/last line), `Ctrl+R` history search. Autocomplete providers: `/` commands (section 5.2), `@` workspace paths (from `tasks.inspect` workspace listing; never the host filesystem outside the task root), `#` acceptance criteria ids, `!` prefix is **not** a shell escape (MARS has no client-side shell; `!` shows a hint "use /run to request an approved execution").

Submit while a task is `running` sends `tasks.steer` (injected into the current turn by the host); `Tab` instead queues the text for after the current turn (`queued-messages` above the composer, shown dim until sent; `Alt+Up` pulls it back into the composer and `Ctrl+X` removes it — Codex queue-vs-inject, Oh My Pi `app.message.dequeue`, Claude Code `Up`, A.1/A.2/A.4). While `pending`/`paused` the submission is the new request and opens the start card (2.4).

Pinned-context strip (`pinned-context`, one row above the queue when non-empty; Aider files-in-chat strip, A.5): the files the current task has pinned via `@` plus the repository instruction files the host reports loaded (`AGENTS.md`, `CLAUDE.md`, `.mars/hooks.json`) with their size in KiB, trust label (`trusted` / `not loaded`), and the context share each costs; `Ctrl+P` opens it as a list where `Enter` on a row drafts `/drop <path>` (a steer; the host decides). Hidden when the task has nothing pinned.

Queue rows follow Warp/Zed `[docs]` (A.5): `Enter` on an empty composer sends the top queued row now, `Alt+Up`/`Alt+Down` reorder, `Alt+Up` on the top row pulls it back into the composer, `Ctrl+X` removes; the queue is per task and survives quitting the client (stored in `~/.mars/shell/queue/<task>.json`, never in the workbench). `/queue <text>` is an alias for `Tab`.

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
- `graph`: knowledge-graph state from `describe.graph` (`graph r12`, `graph stale`, `graph —` for `not_built`); hidden when `unavailable`. Shown only for coordinator-capable sessions, since only the coordinator may build or query it.
- `route`: when the selected model is served through OmniRoute, a dim `via omniroute` suffix on the model segment; `catalog stale` in `warning` colour when `describe.providers[].catalog_stale` is true.

### 2.4 Approval prompts

MARS asks once, at `tasks.start`/`tasks.resume`, for `read`, `write`, `execute` and (if a paid model is selected) paid consent. The card (inline, above the composer, Oh My Pi `approval-dialog` styling) shows: the request text (first 6 lines), the workspace root, the model and tier, the three approvals as toggles with defaults from the mode, and the hook/instruction summary from PR #53 (`AGENTS.md 1.2 KiB · 2 hooks · 1 slash command expanded`). Each approval row carries one consequence sentence (`write: files change only inside the task's private workspace; nothing touches your checkout`). Keys: `y` start with shown approvals, `n` cancel (composer keeps the request for editing), `1`/`2`/`3` toggle read/write/execute, `m` change model, `e` edit request. `execute` is unavailable (dim, reason shown) unless `workbench.describe` reports an image digest. The decision is written into the transcript as `✔ You started with read, write` / `✗ You did not start` so the log is auditable. Oh My Pi `approval-dialog` behaviours kept verbatim (A.4): the card is docked above the composer, arms 500 ms after it appears, `Esc` denies, and when the composer holds a draft the deny choice reads `Deny and send message` so a refusal becomes a steer. From Claude Code (A.1): `Tab` amends — the user attaches a note to the answer and it becomes the first steer of the task; choosing `auto-edit` for the project persists a rule that is shown in full (`write: allowed in task workspaces of <project>`) and is scoped to the sandbox, never to host actions. First run in a checkout asks the trust question before any instruction file or hook loads (`--trust-project`, PR #53) with the default `No, continue without project instructions` (Claude Code's folder trust gate defaults to exit, A.1).

When the model is an `omniroute/<provider>/<model>` id the card adds `route: OmniRoute (local gateway) · classified free by MARS catalog · capabilities: unknown until discovery` or the paid line of 2.10; the client never adds consent headers — the host does.

Questions from the agent (`agent.question` events, if the runtime emits them) render as a card with the options, a flagged recommended option, an `Other` free-text row and `s` **skip** (the skipped state is sent as the answer; Warp `[docs]`, A.5). The card is a projection of an event; the client never invents a question.

There are no mid-task prompts (runtime has `interactivePrompts: false`); if a tool needs an approval it lacks, the host fails the tool call and the transcript shows the `error-block` with `Reason: write not approved for this task` and `resume with write approval` as the one action, which opens the card again on `tasks.resume`. A sandbox denial is rendered the same way (exact denied path or resource, default answer no); there is no "retry without sandbox".

### 2.5 Diff viewer

Full-screen overlay (`overlay-box`) over `tasks.diff` output: file list left (≥ 100 cols) or as a top strip, unified hunks right with `toolDiffAdded/Removed/Context` tokens and line numbers; `j/k` move hunks, `n/p` files, `Enter` on a line adds a reviewer comment anchored to `path:line` to a pending review list (shown as a strip at the bottom of the overlay, `c` edits, `x` removes), `R` submits **all** pending comments as one `tasks.steer` whose text is the `mars://review?path&line` list with the comments (Warp Interactive Code Review `[docs]`, A.5; one steer instead of one per comment), `←/→` also switch files, `q` closes (the pending list is kept until submitted or the task ends). Read-only: the client never writes to the workspace. Side-by-side only in MARS Shell.

### 2.6 Task list

`/tasks` overlay (`select-list`): status glyph, title (first line of the request), branch, model tier, age, cost; `Enter` switches the transcript, `c` cancels (confirm), `r` resumes (card 2.4), `/` filters. Sort: running, paused, pending, then finished by recency.

### 2.7 Child sessions and collaboration

Children (`mars_delegate`) appear as cards (2.1) and as an indented tree in `/children` (`tree-view`): role, model tier (always free), status, tool count, cost. Rooms (`mars_send/inbox`) render messages as quoted entries with sender role; the user can post to a room with `/say <room> text` only if the host exposes it. No client-side fan-out: every child is created by the runtime. `/review` (a review child via `mars_delegate` role `reviewer`) asks for a depth first — `quick` (one pass, free model, ≈ cost shown) or `deep` (full diff + tests, longer) — and shows the estimate before sending the steer (Cursor Agent Review depth table `[docs]`, A.5); it is never automatic after a commit or checkpoint.

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

### 2.11 Context, knowledge graph, vault and provider panels

- `/context` overlay: the Oh My Pi usage bar at the top, then an Aider-style table `[ran]` (A.5) with one row per item in the live window — system prompt, repository instructions (per file, with trust label), tools, skills, pinned files, messages, graph answers, research excerpts — columns `tokens · $ (— when free) · source · remedy`, remedies being literal commands the user can run (`/drop path`, `/clear` is **not** offered: runtime compaction is off, so the remedy is `/new` with a summary). Totals and the free/autocompact buffer close the table.
- `/graph`: read-only view of `describe.graph` (state, revision, built-at, counts) and the last `graph.build` record (`tool.completed` card): stages, model requests (always 0 for the fake CLI fixtures), isolation (`process_env` is shown as "process-level confinement, not a kernel sandbox" verbatim from the package README), and the stale-revision explanation. `graph.query` results appear only as tool cards in the transcript (neighbours / paths / communities), quoted and labelled `graph · derived from revision r<N>`. The client does not call `mars_graph_build`; a `stale` graph shows the one action `ask the coordinator to rebuild` as a steer draft.
- `/proposals`: one list for skill, memory and **vault import** proposals (`describe.vault.pending_proposals`), each with revision fence, threat-scan result and a `view` action (read-only text); accept/reject stay operator commands (`mars vault import --accept`, `mars skills …`) until the proposal RPC exists (§8.2 later) — the overlay prints the exact command, it does not run it.
- `/model` (2.10) groups rows `free · local · paid` across all providers; OmniRoute rows are `omniroute/<provider>/<model>` with `free` only when the MARS catalog says `pricing.free`, `capabilities: unknown` dimmed until discovery, `terms`/`web-session`/`browser-session` exclusions shown as `unavailable · <reason>` rows, and a `catalog curated <date> · stale` banner after 120 days. Picking an OmniRoute paid row goes through exactly the same two-step consent as any paid model.

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

Reserved, not in PR 3: a `team chat` sidebar entry that mounts the `@mars/team-chat` fixture view from `apps/vscode` (PR #58) behind the same feature flag, talking to the separate team endpoint with the host-supplied viewer identity and `team_id`; it shares `@mars/output-format` and the token table but **no** workbench RPC, and nothing from it reaches the terminal client. A notification mailbox (bell in the status bar) collects `complete · request · error` items per task with `Unread` and `Errors` filters and mark-all-read (Warp `[docs]`, A.5); at most two toasts at a time, click jumps to the task, nothing auto-dismisses a `request`.

### 3.2 Session switcher

Sidebar list of tasks (`tasks.list`), grouped by status, with the same columns as `/tasks` plus which runtime owns the task (always `oh-my-pi` today — the column exists so the Shell never implies it runs anything) and the task's private-workspace path (Zed Threads Sidebar `[docs]`, A.5); a workbench selector when more than one connection file exists (`~/.mars/workbench/*/connection.json`). Switching never restarts anything.

### 3.3 Workspace and task views

- Workspace tree: read-only listing of the task's private workspace from `tasks.inspect`; clicking a file opens a read-only viewer with the task's diff for that file overlaid. No editing — edits happen through the agent with approvals, or in the user's own editor on the real repository.
- Task view (inspector): request, acceptance criteria with their verify state, approvals granted, model and tier, budget gauges, checkpoints (`tasks.checkpoint`/`tasks.restore` behind a confirm dialog), and the conventions summary (instructions loaded, hooks, slash commands).
- Changes: side-by-side or unified diff (user setting) from `tasks.diff`, per-file accept-into-review is a `mars://review` steer draft, never a write.

### 3.4 Evidence and recording viewer

Tabbed inspector pane: verify records (pass/fail per criterion), watch evidence files (images shown inline here — the one place MARS renders captures — with the capture policy banner), recorded runs (`documentation/evidence/*` artifacts fetched via `tasks.artifact` with hash check), research findings with source links opened in the system browser after a confirm (external text is untrusted and never fetched by the Shell itself).

### 3.5 Settings

Local-only (per machine): theme (dark/light/system, maps to the same token table as section 4), font, density (comfortable/compact), reduced motion, notification sounds, default mode (`ask`/`plan`/`auto-edit`; `sandbox` only if the host has an image), workbench connections. A read-only **providers** table lists every configured route from `describe.providers` with `who handles the request · under whose terms · policy owner` (`local llama.cpp · your machine · MARS`, `omniroute (loopback) · gateway + upstream provider terms · MARS`, `direct paid · provider terms · MARS`), after the Zed AI-privacy table `[docs]` (A.5); keys are never displayed. Workbench-owned settings (model policy, `allowPaid`, capture roles, budgets) are displayed read-only with "set in `mars serve` flags / policy file" and are never editable from the Shell in this scope.

### 3.6 Contract reuse and the no-second-loop rule

- The Shell imports `@mars/output-format` and `@mars/ui-core` (projection + keymap + strings) and nothing from `@oh-my-pi/*` except `pi-tui` theme JSON for tokens.
- Every mutation is one of the RPC methods in section 0; the Shell adds no endpoints and the workbench adds none for it beyond what the CLI needs.
- Children, research, proposals and verification are observed, not driven: the Shell never calls a model, schedules a job or runs a command.
- If a feature cannot be expressed as an RPC call that the terminal client also makes, it is out of scope for the Shell.

## 4. Visual system

Derived from Oh My Pi's shipped themes (the MARS client is a pi-tui program, so Oh My Pi's semantic tokens are the base) with Hermes-informed rules for density and calm: Hermes authors ~15 seed colours (`primary #FFD700`, `accent #FFBF00`, `border #CD7F32`, `text #FFF8DC`, `label #DAA520`, `ok #4caf50`, `error #ef5350`, `warn #ffa726`) and derives muted/label/surface tones in code with contrast floors and light-terminal lifting `[source]` (A.3); MARS keeps Oh My Pi's token *names* but adopts the Hermes rule that legibility is enforced by code — `@mars/ui-core` checks every theme file against a minimum contrast table at load and in the theme-schema test (§8). Values below are from `@oh-my-pi/pi-tui@18.14.0` `src/theme/dark.json` and `light.json` `[source]`; note that the coding agent's shipped default dark theme is `titanium` (`settings.ts` `theme.dark`), not `dark.json` (A.4). `themes/mars-dark.json` therefore extends `titanium` (accent `#00b4ff`, `borderMuted` `#1f252d`, `success` `#00ff88`, `error` `#ff4757`, `warning` `#ffb347`, `muted` `#9ca3b0`, `dim` `#6b7280`, `selectedBg` `#0082b3`, `userMessageBg`/`toolPendingBg`/`toolSuccessBg`/`statusLineBg` `#0f1216`, `toolErrorBg` `#1a0f10`, `mdCode`/`toolDiffAdded` `#00ff88`, `toolDiffRemoved` `#ff4757`, `statusLineSpend`/`statusLineCost` `#d4c090`) and `themes/mars-light.json` extends `light.json`; both re-map semantics only and introduce no new hex values in the terminal. The full 67-token table for `dark.json`, `light.json` and `titanium` is in `documentation/ui-research/oh-my-pi/REPORT.md` Q1.

### 4.1 Typography

- Terminal: the user's monospace font; the client assumes nothing beyond the Unicode set in pi-tui `symbols.ts` `unicode` preset, with `nerd` opt-in and `ascii` fallback (`/symbols` or `MARS_SYMBOLS=ascii`). No italics by default (many terminals render them as reverse video); bold only for user text and card titles; dim for provenance and hints. Every status glyph is paired with a word and routed through `theme.sym` so the `ascii` preset loses nothing: Claude Code's `⏸`/`⏵⏵` mode glyphs rendered as nothing in xterm `[ran]` (A.1).
- MARS Shell: a monospace stack for transcript code and diffs (`JetBrains Mono`, `Cascadia Code`, `SF Mono`, `Menlo`, `monospace`), a UI sans stack for chrome (`Inter`, `system-ui`). Sizes: 13 px transcript, 12 px chrome, 11 px status bar at the default density; line-height 1.45. Hermes assumes no Nerd Font and uses plain Unicode glyphs only (`❯ ┊ ● ✓ ✗ ∴ ├─ └─ Σ`) `[source]` (A.3); MARS Shell does the same and never depends on icon fonts.

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

Colour depth: pi-tui detects `truecolor` or `256color` only (`theme/color.ts`, `terminal-capabilities.ts`) and honours `NO_COLOR` only for OSC 8 hyperlinks `[source]` (A.4). `@mars/ui-core` therefore owns a colour policy in front of the theme loader: `COLORTERM=truecolor`/`24bit` → truecolor; otherwise 256; `TERM` without 256 support → `mars-ansi.json` (tokens mapped to the theme's `terminal.ansi` indices); `NO_COLOR` → a monochrome theme in which every colour token is the terminal default and status is carried by glyph, word and indent. `/theme` lists `mars-dark`, `mars-light`, a colour-blind variant and an ANSI-only variant, each row previewing a 4-line diff sample (Claude Code first-run theme picker, A.1). Oh My Pi's `colorBlindMode` (shifts `toolDiffAdded` toward blue) is exposed as `/settings colourblind on`.

### 4.3 Spacing and density

- Indent unit: 2 columns. Card content indented 2 from its frame; nested child cards +2.
- Vertical: 0 blank lines between entries of the same turn, 1 between turns, 1 above and below a card with a frame. Never 2 consecutive blank lines.
- Frames only for: approvals and consent, writing blocks, proposals, errors. Tool cards use a background band, not a box. Assistant prose has no frame; user turns are a one-glyph row (`❯`) and assistant text runs beside a `┊` rail so history survives resize (Hermes one-glyph, width-independent rows, A.3). Markdown has no code-block borders: code indents two columns under a muted `─ lang` label, quotes use `│` (A.3).
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
| `Ctrl+T` | Toggle thinking visibility for the whole transcript (Claude Code uses `Ctrl+T` for its task checklist and Codex for the transcript; MARS tasks live in `/tasks` and `Ctrl+B`) |
| `Shift+Tab` | Cycle mode `ask → plan → auto-edit → sandbox(if available) → ask` (Oh My Pi binds this to thinking level; MARS moves that to `Alt+T`) |
| `Alt+T` | Cycle thinking level (`/thinking`); shows the pi-tui `thinking*` colour for the level |
| `Alt+M` | Model picker (`/model`): free and local models first, paid ones labelled and gated by the consent card |
| `Ctrl+Enter` | Approve the pending card outright (Oh My Pi `app.approval.approve`); the card arms 500 ms after it appears so a stray `Enter` cannot approve |
| remap | `~/.mars/keybindings.json` (one file, one format), same schema as Oh My Pi `KeybindingsManager` (`action-id: "Ctrl+P"`, `[]` disables); every hint renders from the live map (`appKeyHint`) so hints never drift from bindings. MARS never reads `~/.omp` |
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

`/help`, `/permissions` (alias `/mode`: the four MARS modes, each with its consequence sentence; the current one marked `(current)`), `/context` (category grid of the live context window: system prompt, repository instructions, tools, skills, messages, free, autocompact buffer — Claude Code `/context`, A.1), `/tasks`, `/new [request]`, `/resume [id]`, `/cancel`, `/model`, `/approve` (reopen the card), `/diff [path]`, `/review <path>:<line>[-<end>]` (drafts a `mars://review` steer), `/children`, `/research`, `/evidence`, `/proposals`, `/graph` (2.11), `/queue <text>`, `/drop <path>` (steer asking the runtime to unpin), `/undo` (restore the checkpoint taken before the last MARS-authored edit turn — scoped like Aider's `/undo` to agent commits `[ran]` (A.5); shown as the `Restore checkpoint` flow, never a `git` command), `/cost`, `/status` (the `workbench.describe` summary: owner, project, image digest, policy, conventions loaded), `/theme`, `/symbols`, `/settings`, `/commands` (repository commands from PR #53, shown with their expansion preview before use), `/export [file]` (projection as Markdown, nothing executed), `/quit`. Repository commands appear as `/<dir>:<name>` with a `repo` badge and are expanded by the host at start (`conventions.applied`), never by the client. There is no `/compact` until the runtime enables compaction; the command exists and answers "compaction is disabled by the host".

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

Every error is one line in the form `what happened · why · what to do` (Aider's three slots — raw error, plain-English cause, next step — `[ran]` A.5, collapsed to one line; the raw host error is one `Ctrl+O` away), the fix typed as the literal command (`Workbench unreachable · run mars serve` — Claude Code `Not logged in · Please run /login`, A.1), rendered in `error` colour with the `■` glyph; a persistent right-aligned status in the hint row repeats it until resolved.

| State | Render | One action |
| --- | --- | --- |
| Workbench unreachable | header `disconnected · retrying 3s`; composer disabled | `/status` shows the connection file path and `mars serve` hint |
| Auth failure (401) | error-block "token rejected" | re-read connection file (`/status reconnect`) |
| `model_unavailable` | notice + task `paused` | `/model` to pick another free model, then `r` |
| Budget exhausted | notice with the cap | `/new` seeded from the request with a larger budget; `/resume` cannot change the budget (frozen launch settings) |
| 409 conflict (`task_not_running`, `revision_mismatch`…) | notice with the code | refresh projection; no retry loop |
| OmniRoute gateway unreachable (`describe.providers[]` health `down`) | model rows for `omniroute/*` dimmed `gateway down` · task `paused` if it was using one | `mars doctor` hint; `/model` to pick a local/free row, then `r` |
| Paid route without consent (host refuses `X-MARS-Paid-Consent` missing) | notice `paid consent required · this model is not free · press p on the start card` | `/approve` reopens the card |
| Knowledge graph `stale` / `failed` | dim `graph stale r11 (workspace at r14)` in `/graph` and the status segment | steer draft `rebuild the knowledge graph` for the coordinator |
| Execute requested without image | dim toggle with reason | none; link to `documentation/EXECUTION_WORKBENCH.md` |
| Format errors in output | dim notice, text still shown | `Ctrl+O` lists codes |
| Oversized response (4 MiB) / event cap | page again automatically; notice only if paging fails | — |
| Terminal < 60×16 | single-line "resize to at least 60×16"; nothing else renders | — |

### 5.5 Long output

Tool output > 6 lines collapses to head 4 + `… +N lines (Ctrl+O)` + last line. Expanded output lives in `output-pane` with its own viewport (max 60 % of rows) and never pushes the composer off screen. Binary or > 128 KiB outputs show size and a hash only. Diffs cap at 40 lines per file inline. Streaming assistant text longer than the viewport auto-scrolls only while the user is at the bottom; any scroll-up pins the view and shows `↓ new output` in the status line.

### 5.6 Interruption, cancel, resume

- `Esc` → `tasks.cancel`; the running card gets `cancelled` band immediately, the host's final `task.updated` confirms. Steers typed during `cancelling…` queue.
- Quitting the client never cancels tasks; on next launch the client lists running/paused tasks first.
- `/resume` → card 2.4 showing the prior approvals, model and budget **read-only** (`tasks.resume` takes only `task_id` and `expected_revision`, so the launch settings are frozen); changing any of them means `/new` seeded with the task's request text. The projection replays from `tasks.events` without re-running anything; a `resumed` divider marks the point.
- Restores are forks: entries after the checkpoint stay visible, dimmed, with a `superseded` label.
- "Start over from the plan" (Cursor `[docs]`, A.5) is a named recovery path, not a feature: `Esc` → `/rewind` to the checkpoint before the drift → edit the request in the composer → `r`. The client adds no plan store; the plan is the request text and the acceptance criteria the host already holds.

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
- Not borrowed from Warp/Zed/Cursor (A.5): `Always allow` / all-allow profiles and `Agent decides` autonomy; client-side regex allow/deny rules; client-owned sandboxes, denylists or checkpoints "separate from Git"; shell-vs-prompt auto-detect (the client has no shell); automatic review after every commit or risk-scored auto-approval; `auto*` model routers that may pick a paid model; cloud hand-off.
- Team Chat is a VS Code/Shell pane over its own team endpoint (`team_id` tenant, host-supplied identity); it is never multiplexed over the workbench RPC and never appears in the terminal client. Agent collaboration rooms (`mars_send`/`mars_inbox`) stay agent-only.
- Out of scope for this spec: editing files in the Shell, a web dashboard (spec §15 `apps/dashboard`), mobile, remote (non-loopback) connections, voice, screen-capture by default, and any change to the runtime or RPC beyond additive read-only fields listed in 8.3.

## 8. Acceptance criteria and staged build plan

### 8.1 Offline-verifiable acceptance criteria

All checks run under `bun run check` with `model_requests: 0`, on fixtures in `packages/ui-core/fixtures/` and `documentation/ui-research/fixtures/`.

1. Projection: given `fixtures/events/*.jsonl` (one file per event type in 2.1, plus a 10,000-event task) and `fixtures/journal/*.json` replies for `tasks.journal` (including a "method not available" case that must degrade to turn markers), `projectTranscript` produces the expected entry list (golden JSON) and trims to 2,000 rendered entries.
2. Snapshot rendering: pi-tui renders each fixture at 60×16, 80×24, 120×40, 200×50 in truecolor, 256, 16 and `NO_COLOR`, `unicode` and `ascii` presets; snapshots are stored as text under `fixtures/snapshots/` and compared byte-exact. Includes: every card type, collapsed and expanded tool output, a 40-line diff clamp, a writing block with disabled `app://` chip, a follow-up list before and after reveal, each error state in 5.4, the start card with and without an image digest, the paid consent line.
3. Output-format agreement: for every fixture in `packages/output-format/fixtures/`, the interactive renderer and `renderTerminal` produce the same visible text when the interactive view is fully expanded.
4. Keymap: one table drives CLI and Shell; a test asserts no duplicate bindings per context and that every slash command in 5.2 has help text.
5. RPC client: against the fixture workbench (`packages/workbench` test harness), the client performs start with the three approvals, steer, cancel, resume and restore, sends no other method, and never sends `execute: true` when `describe` has no image.
6. No-execution guarantee: a test feeds output containing follow-ups, review links, `app://` and shell-looking text; the client emits zero RPC calls until a key press, and the only call after `Enter` on a follow-up is a composer fill (no network).
7. Resume: a recorded run (events + user keystrokes as a fixture) replayed from the middle yields the same final snapshot as the uninterrupted run.
8. Performance: the 10,000-event fixture renders its first frame in ≤ 150 ms and each subsequent frame ≤ 16 ms on the CI runner (measured, recorded in the test output, soft-fail only above 2× budget).
9. Theme: `themes/mars-{dark,light}.json` validate against pi-tui's theme schema and only alias existing tokens.
10. Recorded run: one `documentation/evidence/ui/<date>-cli-fixture-run.cast` (asciinema) of the fixture workbench session, plus PNG frames, checked in with the PR that claims the criterion — labelled as fixture evidence, not live-model evidence.
11. Platform states: fixtures cover `describe.graph` in every state (`not_built`, `ready`, `stale`, `unavailable`, `failed`), a `graph.build` record and a `graph.query` card, a `/proposals` list with a vault import proposal (revision fence + threat-scan result), `/model` with OmniRoute free, paid, `capabilities: unknown` and `unavailable · terms` rows plus the stale-catalog banner, and the `/context` table with `$ —` for free rows; snapshots at the same matrix as criterion 2.
12. Three-slot errors and recovery: every row in 5.4 has a fixture whose rendered line contains all three slots, and the `/undo`, review-comment batch (`R` sends exactly one `tasks.steer`) and questions-card skip paths are asserted against the fixture workbench.
13. Shell: the Shell renderer passes the same projection and snapshot tests through a DOM serialiser; a CSP test asserts no `unsafe-inline`, no remote origins; an accessibility test (axe) on the fixture transcript reports no violations.

### 8.2 Staged plan

- **PR 1 — `@mars/ui-core` and `mars session` read-only.** New package `packages/ui-core` (projection, keymap, strings, theme files, fixtures), `apps/cli` gains `mars session [task]`: connect, task list, transcript projection with all card types collapsed/expanded, status line, `/help`, `/tasks`, `/resume` (view only), `/export`. No mutation at all: no start, steer or cancel (`Esc` only closes overlays in PR 1), so criterion 5's RPC test asserts the read-only client sends nothing but `workbench.describe`, `tasks.list`, `tasks.inspect`, `tasks.events`, `tasks.artifact`, `tasks.diff`, `tasks.journal` (read methods only; `tasks.journal` is the §8.3 addition and the test also covers the host answering "method not available"). Criteria 1, 2, 3, 4, 8, 9, 10 and the read-only parts of 11 (`/graph`, `/proposals`, `/model`, `/context` views over fixtures).
- **PR 2 — write path.** Start card with approvals and paid consent, `/model`, `/mode`, `Esc` cancel (`tasks.cancel`), steer, queued steers, diff viewer, review-link drafts, follow-up reveal, `/rewind`, `/undo`, `/review` depth, review-comment batch, questions card, pinned-context strip and queue reorder, error states, accessible mode. Criteria 5, 6, 7, 12. VS Code: adopt the shared keymap/strings and the paid-consent line (no new features).
- **PR 3 — MARS Shell MVP.** `apps/shell` with the ADR, sidebar/main/inspector, session switcher, transcript, composer, changes (side-by-side), evidence viewer with inline images, settings; reuses `@mars/ui-core` and `@mars/output-format`. Criterion 13 plus 1–7, 11, 12 through the DOM serialiser, and the notification mailbox.
- Later (not in this spec's PRs): `/research` and `/proposals` actions once the proposal RPC exists; `/evidence capture on` once the policy call exists; compaction UI when the runtime enables it.

### 8.3 Additive host changes the plan may need (read-only, decided in PR 1)

`workbench.describe` → `connectors: []`, `image: {digest} | null`, `conventions: {instructions, hooks, commands}`, `policy: {allow_paid, allow_screen_capture}`, `graph: {state, revision, built_at, isolation} | null`, `vault: {pending_proposals, last_export_at} | null`, `providers: [{id, kind: 'local' | 'omniroute' | 'direct', health, catalog_stale, policy_owner: 'mars'}]`; `tasks.inspect` → `model_tier`, `usage_totals`, `pinned: [{path, bytes, trust}]`, `context_rows` (the `/context` table source); **one new read method** `tasks.journal {task_id, entry_ids}` → `[{entry_id, kind, text, usage?}]` resolving the `entry_ids` that `execution.observed` already carries (host-side read of the Oh My Pi journal for that task's session only, same access check as `tasks.events`, text returned as untrusted data). Without it the transcript has no live assistant text (A.6 §10). Nothing else; no new write methods — `/drop`, `/review`, review comments, `/undo` and graph rebuild requests are all `tasks.steer` or `tasks.restore`.

## 9. Final implementation prompt

You are building the MARS terminal client and the MARS Shell desktop app for `tanaypatel917-lab/MARS-Send-Youre-AI-To-Space` (Bun 1.4.4 TypeScript monorepo). Read `documentation/UI_PROMPT.md` in full first; this prompt is its section 9 and defers to sections 0–8 for every detail. Then read `HANDOFF.md`, `README.md`, `documentation/MASTER_SPECIFICATION.md` §3 §5 §14, `documentation/WORKBENCH_RPC.md`, `documentation/OUTPUT_FORMAT.md`, `packages/output-format`, `apps/cli`, `apps/vscode`, and the installed `@oh-my-pi/pi-tui@18.14.0` source under `node_modules/.bun/`.

**What you are building.** An interactive `mars session` TUI in `apps/cli`, a shared `packages/ui-core`, and (PR 3) `apps/shell`. Both are thin clients of the loopback workbench RPC. Oh My Pi inside the workbench is the only agent runtime; you add no model calls, no tools, no shell, no history store, no MCP/LSP, and no permission logic beyond displaying the four modes and sending the three approvals at `tasks.start`/`tasks.resume`.

**Build order.** Three PRs as in §8.2. Each PR: branch `devin/<timestamp>-ui-pr<N>`, `bun run check` green offline (`model_requests: 0`), fixtures and snapshots committed, HANDOFF.md status row updated, no runtime or RPC changes except the additive read-only fields in §8.3 (PR 1 only, with their own tests).

**Terminal client.** Compose it from pi-tui, instantiating `new TUI(new ProcessTerminal())` yourself (never Oh My Pi's `Composer`/`InteractiveMode`, which own an agent session): `TranscriptContainer`-style root whose settled rows retire into terminal scrollback, `components/editor` with the `band` composer shape, `status-line` segments with a MARS preset, `overlay-box` for the diff viewer and lists, `approval-dialog` styling for the inline start card, `tool-card`/`output-pane` for tools, `chrome/diff.ts` for hunks, `markdown` for assistant text, `select-list`/`tree-view` for `/tasks` and `/children`, `hotkeys-markdown` for `?`. Follow §2 for what each entry shows collapsed and expanded, §2.3 for the status segments and the four modes (`ask`, `plan`, `auto-edit`, `sandbox`), §2.4 for the start card (`y n 1 2 3 m e p`), §2.9 for output-format rendering through `processOutput` (writing blocks framed, `mars://review` → diff viewer, `:mars-followup` → reveal into composer, never submit), §5.1 for the full keymap, §5.2 for slash commands, §5.3–5.6 for approvals, errors, long output, cancel and resume.

**Visual system.** Use Oh My Pi's semantic tokens exactly as listed in §4.2; ship `themes/mars-dark.json` and `themes/mars-light.json` that only alias tokens (`paidTier`, `freeTier`, `localTier`, `untrustedLabel`, `verifyPass`, `verifyFail`, `staleFinding`). Spacing and frames per §4.3 (frames only for user messages, approvals, writing blocks, proposals, errors; tool cards use background bands). Motion per §4.4 (pi-tui `SPINNER_FRAMES`, 80 ms, one spinner per running thing, reduced-motion → static glyphs, nothing animates after completion). Glyph presets `unicode`/`nerd`/`ascii`; `NO_COLOR` and 16-colour must stay usable.

**MARS Shell.** Tauri or Electron (write the ADR first), renderer imports `@mars/ui-core` and `@mars/output-format` only; panes per §3.1; textContent-only model text, strict CSP, SHA-256-verified artifacts; evidence images inline only here; settings local-only; workbench policy read-only. If a Shell feature is not an RPC call the CLI also makes, do not build it.

**Platform surfaces (§0.1, §2.11).** Render, do not drive: the knowledge graph (`describe.graph` states, `graph.build`/`graph.query` tool cards, the "process-level confinement" wording verbatim), vault proposals (list + exact operator command, no execution), OmniRoute model rows (`omniroute/<provider>/<model>`, free only per the MARS catalog, `capabilities: unknown` until discovery, stale-catalog banner, consent headers set by the host only) and the `/context` tokens·$·source·remedy table. Team Chat is a Shell/VS Code pane over its own team endpoint (`team_id`), never the workbench RPC, never the terminal.

**Borrowed, bounded (A.5).** Queue strip with `Enter`-on-empty send and reorder; pinned-context strip; questions card with skip; diff-viewer review comments batched into one `tasks.steer`; `/review quick|deep` cost choice; `/undo` as a scoped checkpoint restore; three-slot error lines; notification mailbox in the Shell. Not borrowed: any `Always allow`/auto-approve rule, client sandboxes or denylists, client-owned checkpoints, shell/prompt auto-detect, automatic review, `auto*` paid routing.

**Hard rules.** Model output, repo instructions, research excerpts and evidence are untrusted text with visible provenance (`customMessageBg`, label `#b281d6`). Nothing parsed from output executes without a key press that first shows the payload. Paid models: two-step consent naming price, cap and "children stay free". No `/compact` behaviour (runtime compaction is off). No bypass-all mode; `danger-full-access` renders as refused. "Completed" ≠ "verified". No claims of parity with Claude Code, Codex, Hermes, Aider, Warp, Zed, Cursor or others in code, docs or strings; no live-model, live-OmniRoute or real-window claims from fixture runs.

**Acceptance.** Implement every criterion in §8.1 for your PR; store fixtures under `packages/ui-core/fixtures/`, snapshots under `fixtures/snapshots/` at 60×16, 80×24, 120×40, 200×50 × {truecolor, 256, 16, NO_COLOR} × {unicode, ascii}; record one asciinema fixture run per PR under `documentation/evidence/ui/` labelled fixture evidence. Budgets: first frame ≤ 150 ms, frame ≤ 16 ms, idle CPU < 1 %, ≤ 150 MB at 10,000 events.

**Report.** In the PR description: what was built against which section numbers, which criteria pass with the command that proves it, what remains, and anything in this document that turned out wrong (file an issue, do not silently diverge).

## Appendix A. Research evidence

| Product | Version / revision studied | License | Method | Report |
| --- | --- | --- | --- | --- |
| Claude Code | `@anthropic-ai/claude-code` 2.1.317 | proprietary (behaviour and short UI strings only) | ran without login; docs 2026-11-03 | `documentation/ui-research/claude-code/REPORT.md` |
| Codex CLI | `codex-cli` 0.166.0 = `rust-v0.166.0` @ `6ff1e1ca` | Apache-2.0 | ran without login; source; docs | `documentation/ui-research/codex-cli/REPORT.md` |
| Hermes Agent | `NousResearch/hermes-agent` @ `cabaf053b5b4` | MIT | ran against a fake SSE server; source; docs | `documentation/ui-research/hermes-agent/REPORT.md` |
| Oh My Pi | `@oh-my-pi/pi-coding-agent` 18.14.0, `pi-tui` 18.14.0; manifest audited revision `5d30c790b883ad0ae05dac2a4d2ccc8ecd103611`, npm release revision `31147f9d1a76608549821c3759f8487b4d66c72d` | MIT | source in `node_modules`, run | `documentation/ui-research/oh-my-pi/REPORT.md` |
| Aider | `aider-chat` 0.86.2 = `v0.86.2` @ `253f0368` | Apache-2.0 | ran with a dummy key (local UI only); docs | `documentation/ui-research/aider/REPORT.md` |
| Warp, Zed, Cursor | docs as fetched 2026-11-03/04 | proprietary / GPL-3.0+AGPL-3.0 (Zed; conventions only) / proprietary | docs only, nothing run | `documentation/ui-research/others/REPORT.md` |
| MARS repository | `main` at `aa85da5` + PR #53 | — | source | this document §0 |

### A.1 Claude Code

Report: `documentation/ui-research/claude-code/REPORT.md` (22 xterm screenshots). Studied `@anthropic-ai/claude-code` 2.1.317 (proprietary; behaviour and short UI strings only, no source or assets) `[ran]` without an Anthropic login (onboarding, trust gate, theme picker, `/help`, `/permissions`, `/model`, `/config`, `/context`, `/hooks`, resume picker, footer modes, error lines) and `[docs]` docs.anthropic.com/en/docs/claude-code (permission modes, permissions, interactive-mode, memory, hooks, skills, slash-commands, statusline, costs; 2026-11-03). Not observed live (no model reply): `⏺` tool rows, inline edit diffs, plan approval, spinner verbs — all `[docs]`.

Borrowed: §2.3 one footer mode indicator with glyph + word + next key; §2.4 prompt anatomy (what · why · exact command · scoped yes / no), `Tab` to amend, trust gate defaulting to no, rules shown in full; §2.1 transcript grammar (inverse pill, `⎿`, four-column indent, dim turn footer); §5.2 `/context` grid and `/compact [focus]`; §4 first-run theme picker with diff sample and colour-blind/ANSI-only rows; §5.4 `what · what to do` error lines; §5.1 `Esc Esc` rewind anchored to user turns, queue shown dim; panels that end with a key legend; `/model` rows showing price with `s` = this session only (consent at the point of choice). Not borrowed: `auto` default and classifier approvals, `bypassPermissions`/`--dangerously-skip-permissions`/`dontAsk`, broad `Bash(prefix *)` persisted rules for host actions, paid-by-default model picker, `/effort`/`/fast` toggles, subagents/teams/worktrees/cloud commands, the 86-command list, prompt/agent hooks that run shell from model output, reads outside the working directory, Unicode glyphs without fallback, overloaded `Esc`, remote managed-settings fetch. Correction to this document: Claude Code's `#` memory shortcut and the "Context left until auto-compact: N%" string are absent from current docs and builds.
### A.2 Codex CLI

Report: `documentation/ui-research/codex-cli/REPORT.md` (13 screenshots in the same directory). Studied `codex-cli` 0.166.0 = `openai/codex` tag `rust-v0.166.0` @ `6ff1e1ca3b30fc8b914720681fcf5fe62e95f856`, Apache-2.0; `[ran]` the TUI without a login and with an invalid key, `[source]` `codex-rs/{tui,core,protocol,apply-patch}` and insta snapshots, `[docs]` developers.openai.com/codex (2026-11-03).

Borrowed (section → finding): P2/§2.4 approval modal anatomy and `✔/✗` decision log; P3/§2.1 5-line preview, `Explored ›` grouping, reasoning off the main view; §2.1 diff summary-first (`Edited N files (+a −b)` → `└ path`); §2.2 footer hints by state, `Tab` queue vs `Enter` inject, `Esc Esc` edit-previous; §5.2 `/permissions` presets with consequence lines and `/status` as one page; §6 narrow-width behaviour (right-side footer hides first). Not borrowed: `Full Access`/`danger-full-access`, `Approve for me` (LLM as approver), paid-first model list, `/agents`, account and plan surfaces, `!` shell mode, arbitrary `notify` programs, hidden reasoning, `Ctrl+O` = copy. Correction to this repo's assumptions: no `codex://review` or follow-up syntax exists at this tag (§7).
### A.3 Hermes Agent

Report: `documentation/ui-research/hermes-agent/REPORT.md` (15 screenshots). Studied `NousResearch/hermes-agent` @ `cabaf053b5b4` (2026-11-02), MIT (checked at the pinned commit; nothing unusual); `[ran]` `setup-hermes.sh`, `hermes --help`, the no-key setup gate and wizard, then the classic CLI and the Ink TUI against a local fake OpenAI-compatible SSE server; `[source]` `theme.ts`, skins YAML, TUI components; `[docs]` hermes-agent.nousresearch.com/docs. Hermes is itself a host plus thin clients (classic CLI, Ink TUI, Electron desktop over one gateway with a shared durable prompt queue and one slash registry) — the closest analogue to MARS's loopback-RPC clients.

Borrowed: §4 seed-palette-with-derived-tones rule and contrast floors (as a load-time check over Oh My Pi tokens); §2.1 one-glyph width-independent rows, `┊` rail, turn-tree summary with per-section modes, hard output budgets in one `limits.ts` with explicit "omitted" labels; §4.4 motion confined to chrome; §2.3 status segments dropped by an explicit breakpoint table; §2.7 staging queue semantics for memory/skill proposals (ids + one-line gist, `diff`, approve/reject pinned to content hash, `[auto]` tag); §3 host-side queue rendered identically by every client and the live session switcher glyph set (idle/starting/waiting/working, `✎ draft`); §2.9 Markdown without boxes. Not borrowed: `Always allow`, `/yolo`, `/approvals off`; `!cmd` host shell escape and shell interpolation into prompts; inconsistent Enter defaults across surfaces (Classic Enter = deny vs TUI allow-once); per-TUI in-process gateway; Nous Portal `/topup`/`/subscription`/`/login` and spending prompts inside the chat; Markdown stripping in the classic CLI; busy-input default `interrupt` (typing redirects the running turn); `Ctrl+C` double-press exit with `Esc` not interrupting; kaomoji/pets/fortunes; auto-derived session titles with raw `**`; ~100 slash commands; telemetry opt-in dialog.
### A.4 Oh My Pi

Report: `documentation/ui-research/oh-my-pi/REPORT.md` (13 screenshots). Studied `@oh-my-pi/pi-coding-agent` and `@oh-my-pi/pi-tui` 18.14.0 as installed in this repo (npm release revision `31147f9d1a76608549821c3759f8487b4d66c72d`; `sources/manifest.json` audits `5d30c790b883ad0ae05dac2a4d2ccc8ecd103611`), MIT; `[ran]` the real TUI with no API key (setup wizard, `/model`, `/hotkeys`, band status line, slash popup), `[source]` `pi-tui/src/{theme,components,chrome,prompt,status-line,overlays}` and `coding-agent/src/modes`, `[docs]` the repository `docs/` at the release revision. `/theme` and `/help` were not reached interactively (documented from source).

Borrowed: §4 token names and the `titanium` default; §2 `band` composer and `╰─ ` cue; `TranscriptContainer` scrollback model; `ToolCard` bands with a lower `collapsedMaxLines`; `renderDiff` unified diff with inverse intraline highlight; approval dialog docking, 500 ms arm delay, `Deny and send message`; context thresholds 50/70/90 %; status-line segment ids and presets; `KeybindingsManager` + `appKeyHint`; symbol presets `unicode|nerd|ascii`; braille spinners at 80 ms; shimmer modes; `colorBlindMode`; `WizardStep` live preview for first run. Not borrowed: `tools.approvalMode` default `yolo` and `--auto-approve`; headless `yolo` subagents and the Agent Hub; paid-first provider wizard and `/model` ordering; OSC 8 link activation and `/open` from model text; `/bash`, `!`, `/ssh`, Python REPL (host execution); speech, share, marketplace, self-updater, telemetry; `~/.omp` config root; embedding `Composer`/`InteractiveMode`. Corrections to this document's earlier assumptions: pi-tui has no 16-colour mode and ignores `NO_COLOR` for theme colours; there is no TUI-wide reduced-motion setting; the default dark theme is `titanium`, not `dark.json`. `omp --mode rpc` (JSONL: `prompt` with `streamingBehavior: steer|followUp`, `abort`, model/thinking commands, approval/ask sub-protocol) is a useful checklist for the workbench RPC, which MARS clients speak instead.
### A.5 Aider, Warp, Zed, Cursor

**Aider.** Report: `documentation/ui-research/aider/REPORT.md`. Studied `aider-chat` 0.86.2 (tag `v0.86.2` @ `253f0368`, Apache-2.0) `[ran]` with `--no-auto-commits` and a dummy API key so every model call failed with an auth error and only the local UI was exercised (`/help /add /drop /ls /tokens /settings /diff /undo /run /map /architect /ask /code /model`), plus `[docs]` aider.chat; the report's "beats X" comparisons are marked `[comparison: not re-verified]` and are not relied on here. Borrowed: `/tokens` → the per-row `tokens · $ · source · remedy` table in `/context` (2.11); the files-in-chat strip → pinned-context strip (2.2); quantified consent ("+N tokens, $X") before adding output to context → shown on every `/context` remedy and on the `/review deep` estimate; mode/model banner on every switch → the `mode` card in the transcript; three-slot errors → 5.4; `/undo` scoped to agent-authored commits → `/undo` as a scoped checkpoint restore (5.2); `AI!`/`AI?` watch-file triggers → watcher *proposals*, never actions. Not borrowed: auto-commit, `/run` host shell, URL auto-open defaulting to yes, a paid default model, executing suggested shell commands on `y`.

**Warp, Zed, Cursor.** Report: `documentation/ui-research/others/REPORT.md`, `[docs]` only (Markdown docs fetched 2026-11-03/04; nothing installed or run, no source read). Borrowed, each as a projection of existing RPC/events: Warp's state-dependent hint line, queued-prompts panel with `Enter`-on-empty send and reorder, questions card with recommended option and skip, diff keys and batched inline review comments sent once, notification classes `complete/request/error` with a mailbox, task-list glyphs `● ✔ ○ ■`; Zed's sidebar "which agent/worktree owns this thread", restore-checkpoint on the causing turn, the privacy "who handles this request" table, and the *display* of permission precedence deny > confirm > allow; Cursor's review depth as an explicit cost choice and "start over from the plan". Not borrowed: `Always allow`/YOLO profiles, `Agent decides`, regex auto-approval, client sandboxes/denylists (Zed's own docs split "may it run" from "what it can do" — both are host concerns in MARS), checkpoints separate from Git, client-side "steer at next step" promises, shell/prompt auto-detect, auto review after commit, risk-scored auto-approval, `auto*` paid routing, cloud hand-off.

### A.6 Critical review

Self-review of this specification against the repository state on `main` (PRs #53–#55 merged, #58 open) and the research reports; each finding and its resolution:

1. **Appendix A paths were wrong** (`codex/`, `hermes/`, `others/` for Aider). Fixed to the directories that exist; Aider has its own row.
2. **`/context` promised a category grid but nothing told the user what to remove.** Resolved by adopting Aider's per-row remedy table (2.11) and an additive `tasks.inspect.context_rows` field (8.3) instead of client-side token counting, which would have been a second estimator.
3. **Knowledge graph, vault and OmniRoute landed after §0 was written and were invisible to the UI.** Added §0.1, §2.11, status segments, error rows, fixtures (criterion 11) and `describe` fields. Every addition is read-only; the only write paths remain `tasks.steer`/`tasks.restore`, which is consistent with the packages' own READMEs (coordinator-only graph tools, proposals not writes, host-set consent headers).
4. **Review comments as one steer per line would have flooded the runtime.** Changed 2.5 to batch comments and send one `tasks.steer` on `R` (Warp pattern), asserted in criterion 12.
5. **`/undo` could have been read as a `git` operation on the user's checkout.** Defined as a scoped `tasks.restore` to the checkpoint before the last MARS-authored edit turn; the client never touches the real repository.
6. **Queue persistence location.** Queued text is user input, not workbench state; it persists under `~/.mars/shell/`, consistent with §7 "one owner per store". If the host later gains a queue, the client-side file is dropped.
7. **Team Chat scope creep.** PR #58 is a fixture-backed VS Code view over a separate team endpoint; the Shell reserves a pane and shares contracts, nothing more; the terminal never gets it. Recorded in §3.1 and §7 to stop a later PR multiplexing chat over the workbench RPC.
8. **Research honesty.** Warp/Zed/Cursor findings are docs-only and Aider was run offline; A.5 and the reports say so, and §9 forbids live-model, live-OmniRoute and real-window claims from fixture runs. No parity claims were added; the list of products in the no-parity rule was extended.
9. **Live assistant text had no data path** (review flag, second round). `execution.observed` carries journal entry ids, not text, and the runtime keeps the journal private. Resolved by (a) stating the today-behaviour honestly — turn markers while running, full text from the final artifact — and (b) adding one read-only method `tasks.journal` to §8.3 for PR 1, scoped to the task's own session and the same access check as `tasks.events`. If the owner rejects (b), PR 1 ships with (a) and the streaming fixtures are dropped.
10. **Open, not resolved here:** whether `tasks.resume` should gain optional `approvals`/`model`/`budget` fields (today they are frozen and the UI says so; a change is a write-method change outside §8.3); whether `agent.question` events exist in the runtime (2.4 renders them only if emitted); the Shell window framework ADR; the notification policy (owner decision in `HANDOFF.md`); whether `describe.providers` should expose OmniRoute health or defer to `mars doctor` only.
