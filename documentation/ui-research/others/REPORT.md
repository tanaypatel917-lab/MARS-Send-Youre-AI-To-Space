# Warp, Zed, Cursor: agent UI study (docs-only)

Scope: the desktop/IDE agent surfaces that `documentation/UI_PROMPT.md` §3 (MARS Shell) borrows from. All three products were studied from their official documentation only (`[docs]`, fetched 2026-11-03/04 as Markdown: `docs.warp.dev/*.md`, `zed.dev/docs/ai/*`, `cursor.com/docs/*.md`). None was installed or run, no source was read (Warp and Cursor are proprietary; Zed is GPL-3.0/AGPL-3.0 and MARS borrows conventions only, no code). Every claim below is therefore about documented behaviour at fetch time, not observed behaviour. Nothing here is a parity or compatibility claim.

Why these three: each is a *host* with a multi-pane desktop UI around agents it does not fully own (Warp runs third-party CLI agents, Zed hosts ACP External Agents and Terminal Threads, Cursor's Agents Window manages local and cloud agents). That is the MARS Shell's situation: a thin window over a workbench it does not run.

## 1. Warp (docs.warp.dev)

Observed in docs:

- **Two modes with explicit switching.** Terminal mode is the clean default; Agent conversation view has an alternative background and shows model select, voice, image attach, conversation management. A message bar states what the next key does depending on state: `⌘↩ for new agent` (empty input), `⌘↩ to send to agent`, `⌘↑ attach '<cmd>' output as agent context` after a failed command, `⌘Y to continue conversation`. Auto-detect labels input `agent`/`shell` `(autodetected)` before submit.
- **Profiles & Permissions.** Per profile: base model, planning model, and one autonomy level per permission type — *Apply code diffs, Read files, Create plans, Execute commands, Interact with running commands, Ask questions* — with levels `Agent Decides / Always ask / Always allow / Never`. A command **denylist takes precedence** over `Always allow`. All-allow is called "YOLO mode". `Agent decides` for diffs currently equals `Always ask`.
- **Code diffs.** Built-in diff editor grouped into hunks: `↑/↓` hunks, `←/→` files, `Enter` accept, `R` refine with natural language (regenerates), `E` edit manually, `Esc` leave. Nothing is applied until accepted unless the permission is `Always allow`.
- **Interactive Code Review.** Inline comments anchored to file+line, batched, submitted once; the agent returns an updated diff. Works for third-party CLI agents too; requires a Git directory.
- **Agent questions card.** Multiple-choice (single/multi-select), optional `Other` free text, a flagged recommended option, several questions per card with navigation, **Skip** (agent receives the skipped state).
- **Prompt queueing.** Auto-queue toggle, `/queue`, a collapsible queued-prompts panel *above the input* (view/reorder/edit/remove), sequential auto-send, `Enter` on empty input sends the top queued row, per-conversation persistent queue.
- **Conversation forking** preserving context, model and profile. **Blocks as context**: attach terminal output blocks (`⌘↑`/`⌘↓`), error-block attach hint.
- **Notifications.** Three types — `Complete`, `Request` (blocked on approval/permission/idle prompt), `Error`; toasts (max two, hover pauses, click jumps to the session), a mailbox panel with `All / Unread / Errors` filters and mark-all-read, plus desktop alerts.
- **Planning.** `/plan` writes a plan document in a rich editor with clickable file paths; each agent revision creates a new **version** with history/restore; execute all or one phase; reference with `@`.
- **Task lists.** Auto-created for complex requests; statuses `●` current, `✔` done, `○` not started, `■` cancelled; inline completion markers; a chip bottom-right opens the list; the summary explains skipped tasks.
- **Model choice.** Curated list plus `auto`, `auto-efficient`, `auto-genius`, `auto-open` routing ids; reasoning-level suffixes `low..max`.

## 2. Zed (zed.dev/docs/ai)

- **Agent Panel / threads.** Threads Sidebar grouped by project with status indicator and *which agent runs the thread*; `ctrl-tab` thread switcher; archive and Thread History restore; optional Git-worktree isolation per thread; "New From Summary" = manual compaction seeded with a summary.
- **Edit and re-submit any sent message** (effectively a fork). **Queued messages** by default with a per-message *Steer* toggle (interrupt at the next step; Zed Agent only, because Zed cannot detect step boundaries in external agents); edit/remove queued; "Send Now".
- **Checkpoints.** A "Restore Checkpoint" button sits on each user message that led to edits, and appears even after an interrupt.
- **Tool permissions** (`agent.tool_permissions`, v0.224+). Global `default` `confirm|allow|deny`; per-tool `always_allow / always_deny / always_confirm` regex patterns matched against the tool's input (terminal command string, `edit_file` path, `fetch` URL, `mcp:<server>:<tool>`). Precedence: built-in security rules > `always_deny` > `always_confirm` > `always_allow` > tool default > global default. Chained shell commands are parsed per sub-command. A user-invoked `/skill` does not re-prompt. Global allow still blocks settings-directory paths.
- **Sandboxing** is separate from permissions: OS-level (`bwrap` on Linux, WSL on Windows, native on macOS) for the `terminal` and `fetch` tools only; restricts filesystem writes and outbound network, protects Git metadata. Docs state the split plainly — permissions decide *whether* a tool runs, the sandbox limits *what it can do once running* — and list what is **not** sandboxed (Zed itself, language servers, extensions, External Agents, Terminal Threads; Windows weaker).
- **Terminal Threads vs External Agents.** For a CLI/TUI in a terminal thread Zed owns only the thread surface (sidebar entry, grouping, switching); the CLI owns auth, model, tools, skills, MCP — and Zed states that its own profiles/permissions *do not apply*. External Agents (ACP; registry lists Claude, Codex, OpenCode, Copilot, Cursor, **Pi Coding Agent**) own their runtime; "features vary per agent" (history, checkpoints, token usage display).
- **AI Privacy page.** A request-path table (Zed-hosted / provider keys / subscriptions / gateways / local) stating who handles requests under whose terms; keys live in the system keychain, not `settings.json`.

## 3. Cursor (cursor.com/docs)

- **Agents Window** is an agent-first window distinct from the editor: multi-workspace, a diffs view (review/commit/PR), parallel cloud agents, local↔cloud handoff, `/in-cloud`, `/autopilot`, worktrees. Both UIs are kept; the docs frame the choice as abstraction level.
- **Checkpoints** are taken automatically before significant changes, stored locally and *separate from Git*; the docs say to use them only to undo agent changes.
- **Ask questions** tool: the agent keeps reading/editing while waiting for the answer. **Queued messages.** **Plan Mode** (`Shift+Tab` rotates modes): clarifying questions → research → an editable Markdown plan (saved in the home dir, "Save to workspace" opt-in) → build; advice to "start over from the plan" (revert, refine, rerun) instead of patching a drifting run.
- **Agent Review**: a dedicated review of local changes, triggered automatically after commit, by `/agent-review`, or from Source Control against main; two depths `Quick (fast, low cost)` / `Deep (slow, high cost)`; reads `BUGBOT.md`.
- **Subagents**: own context window, *foreground* (blocks) vs *background*; start with a clean context so the parent must pass what matters.
- **PR Routing & Approval** (server-side automation): risk score with a maximum approval threshold; `APPROVAL_POLICY.md` trusted by **exact basename only**; refuses to approve while review findings need a human.
- **Models & Pricing**: third-party models are billed at API list price from prepaid credit, i.e. paid use is an explicit purchase, not a default. **Reviewing and testing** guide: watch the live diff and Stop early; small semantic commits for human reviewers.

## 4. What MARS borrows (and what it does not)

Borrow (all already expressible over existing workbench RPC/events; no new host behaviour):

| Idea | From | Where in `UI_PROMPT.md` |
| --- | --- | --- |
| Status-dependent hint line naming the next key (`Enter send · Esc cancel · a approve`) | Warp message bar | §2.2, §2.3 |
| Queued-prompts strip above the composer: view/reorder/edit/remove; `Enter` on empty composer sends the top row; per-task queue persists | Warp, Zed | §2.2, §5.6 |
| Questions card: options, flagged recommendation, `Other`, Skip with the skipped state recorded | Warp | §2.4 (rendered from `agent.question` events only) |
| Diff viewer keys `↑/↓` hunk, `←/→` file, `Esc`; reviewer comments anchored to file+line, batched into *one* `tasks.steer` | Warp | §2.5 |
| Notification classes `complete / request / error`; a mailbox with `Unread` and `Errors` filters in the Shell | Warp | §3.1, §3.5 |
| Task-list glyphs `● ✔ ○ ■` and inline completion markers | Warp | §2.6 (ASCII fallback `* x o #`) |
| Sidebar entries that say *which runtime/agent* and *which worktree* own a thread | Zed, Cursor | §3.2 |
| Restore-checkpoint affordance on the user turn that caused edits (`tasks.checkpoint`/`tasks.restore`) | Zed, Cursor | §2.1, §5.6 |
| A "who handles this request, under whose terms" table in Settings for each configured provider (local / OmniRoute / direct paid) | Zed privacy page | §3.5 |
| Permission rule precedence shown as a *read-only* explanation (deny > confirm > allow) | Zed | §5.3 (MARS policy is host-owned; the client only displays it) |
| Review depth as an explicit cost choice (`quick` vs `deep`) before a review child is spawned | Cursor | §2.7 |
| "Start over from the plan" as a first-class recovery path (restore checkpoint → edit plan → resume) | Cursor | §5.6 |

Do **not** borrow:

- `Always allow` / all-allow "YOLO" profiles, `Agent Decides` autonomy, or any client-side pattern-based auto-approval. MARS approvals are three task-scoped host decisions at `tasks.start`/`tasks.resume` (§5.3); the client never computes a permission answer.
- Client-owned sandboxes or denylists. Zed's own docs split permissions from sandboxing; in MARS both live in the host (`@mars/sandbox`, `mars_execute` policy). The Shell shows the active policy and never edits it.
- Checkpoints that are "separate from Git" and stored by the client. MARS checkpoints are workbench RPC objects.
- Interrupt-at-next-step "Steer" implemented client-side. MARS exposes `tasks.steer`; whether the message lands between steps is the host's decision and the UI must not promise timing.
- Auto-detect of shell vs prompt. The MARS client has no shell; everything is a prompt or a slash command.
- Auto-run Agent Review after every commit and risk-based auto-approval. Review children cost tokens and are explicit (`/review`), and completion ≠ verification (P8).
- Model routers that silently pick a paid model (`auto`, `auto-genius`). P9: free by default, paid by task-scoped consent.
- Local↔cloud handoff and cloud subagents: out of scope for a loopback workbench (§7).

## 5. Limitations of this study

Docs-only; nothing was run, so keystrokes, visual density and failure behaviour are unverified. Warp and Cursor docs describe hosted/cloud features that have no MARS equivalent and were skipped. Page content was fetched on one day; features marked "currently" in the docs (e.g. Warp's `Agent decides` for diffs, Zed's `v0.224` permission schema) can change.
