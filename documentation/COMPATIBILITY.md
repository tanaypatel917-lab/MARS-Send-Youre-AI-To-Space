# Compatibility matrix: Codex CLI and Claude Code conventions in MARS

MARS adopts the *file formats and ergonomics* of OpenAI Codex CLI and Anthropic
Claude Code so one repository layout works in all three tools. It does not adopt
either agent loop: Oh My Pi stays the only live session, tool and model owner
(`enableMCP: false`), every convention file becomes bounded text or a host-bound
tool, and nothing from a repository file runs without the workbench approval
gate. Sources: openai/codex at `f58acd6ede312266a7a0eaa63fd8dadacb4de239`
(Apache-2.0, ported code attributed in `packages/codex-tools`);
anthropics/claude-code is proprietary, so only its documented formats are
mirrored — no source was read or copied.

Status: **offline-verified only** (fixtures and injected runtime responses,
`model_requests: 0`). No live model has emitted an apply_patch call or read a
frozen AGENTS.md through this code.

## Matrix

| Convention | Codex CLI | Claude Code | MARS (this repository) |
| --- | --- | --- | --- |
| Repository instructions | `AGENTS.override.md`, `AGENTS.md` from project root to cwd, concatenated, byte budget, skipped for untrusted projects | `CLAUDE.md` (also `CLAUDE.local.md`, `~/.claude/CLAUDE.md`) | `AGENTS.override.md`, `AGENTS.md` **and** `CLAUDE.md` discovered from the trusted checkout root (`mars serve --source`) with `@mars/codex-tools` `discoverInstructions`; loaded only with `--trust-project`; bounded (32 KiB), frozen **whole or omitted** into `launch.json`, appended after frozen memory/skills and labelled as repository instructions that never grant tools. `CLAUDE.local.md` and home-directory files are not read. |
| Skill folders | `.codex/skills/<name>/SKILL.md`, `.agents/skills/<name>/SKILL.md` (YAML frontmatter `name`, `description`) | `.claude/skills/<name>/SKILL.md`, same frontmatter | All of `skills/<name>/SKILL.md`, `skills/vendor/<vendor>/<name>/SKILL.md`, `.claude/skills/*`, `.codex/skills/*`, `.agents/skills/*` via `@mars/skills` `discoverSkills` (flat frontmatter subset, 64 KiB per file, 256 skills, first location wins). Discovered skills are frozen with learned skills as **untrusted evidence** for read-approved sessions. |
| Hooks | — (Codex has no hook files) | `.claude/settings.json` `hooks` with `SessionStart`, `PreToolUse`, `PostToolUse`, …; shell `command` strings, JSON on stdin, exit 2 blocks | `.mars/hooks.json` (`schema_version: 1`, events `session-start`, `pre-tool`, `post-tool`; Claude Code event names accepted as aliases). Commands are **argv arrays** (no shell), `{tool}`/`{path}` whole-token placeholders, no stdin JSON. Loaded only with `--trust-project`; run by the host through `WorkspaceHost.execute` — the same Docker sandbox and task `execute` approval as `mars_execute` — and recorded as skipped otherwise. A pre-tool hook exiting 2 blocks the tool call and the model sees its stderr. The tool's own approval and claimed-path checks run before any hook, so a denied call never launches one; a hook that outlives `timeout_ms` is killed by the sandbox budget and awaited (bounded grace) before the next hook or the tool runs. Hooks wrap `mars_read`, `mars_write`, `mars_execute` and `mars_apply_patch`; every result is a `tool.completed` task event (`operation: hook.completed`). Other Claude Code events (`Notification`, `Stop`, `UserPromptSubmit`, …) are not supported. |
| Slash commands | Built-in commands only; prompt files via skills | `.claude/commands/<name>.md`, `<dir>/<name>.md` → `/dir:name`, frontmatter `description`, `argument-hint`, `allowed-tools`; `$ARGUMENTS`, `$1..$9`, `!` `cmd` `` shell inclusion, `@file` | `.mars/commands/*.md` (wins) and `.claude/commands/*.md` (+ one namespace level) via `@mars/skills` `loadCommands`/`expandCommand`; `$ARGUMENTS` and `$1..$9` expanded; `!` `cmd` `` shell inclusion is **never executed** (left literal, reported as unsupported); `@file` left as text. A task request starting with `/name` is expanded at `start` (the durable task keeps the original request; the expansion is recorded as a `conventions.applied` event). CLI: `mars commands list`, `mars commands expand "/name args"`. |
| File edits | `apply_patch` tool (`*** Begin Patch` … `*** End Patch`, Add/Delete/Update File, `*** Move to:`, `@@` context, `*** End of File`) | `Edit`/`Write`/`MultiEdit` tools (not a file format) | `mars_apply_patch` host-bound tool: `@mars/codex-tools` TypeScript port of `codex-rs/apply-patch` (grammar, lenient heredoc wrapper, `Environment ID` preamble, context search with whitespace/Unicode fallbacks, line-ending preservation, upstream scenario fixtures). Writes only through the workspace provider (`write`/`remove`), relative paths only (absolute paths refused), hunks apply in order and stop at the first failure. A patch reads before it writes (Update hunks need the file text, Delete hunks its existence), so the tool is declared only for sessions approved for both read and write when the host has the applier; `mars_write` remains available. Children of a collaboration room do not get it yet. |
| Sandbox modes | `sandbox_mode`: `read-only`, `workspace-write`, `danger-full-access` (`external-sandbox` internal) | Permission modes (`default`, `acceptEdits`, `plan`, `bypassPermissions`) | `@mars/codex-tools` `mapCodexPolicy`: `read-only` → `{read}`; `workspace-write` → `{read, write, execute-if-host-sandbox}`; `danger-full-access` → **refused** (MARS has no unsandboxed execution; execute always needs the digest-pinned Docker sandbox). Claude Code permission modes are not mapped. |
| Approval modes | `approval_policy`: `untrusted`, `on-request` (alias `on-failure`), `never`, `granular` | Per-tool allow/deny lists, interactive prompts | `untrusted` → reads only; `on-request` → the mapped approvals; `never` → same as `on-request` because MARS approvals are fixed at launch and never prompt mid-task; `granular` not supported. Mapped approvals are clamped to what the task was granted (`clampApprovals`), never widened. |
| Project trust | Codex asks to trust a directory on first use; untrusted projects skip `AGENTS.md` | Trust dialog for project settings/hooks | `mars serve --trust-project` (or `MARS_TRUST_PROJECT_CONFIG=1`) gates instruction files, hooks and project model config together. Skills and commands load without trust because they only produce labelled or user-invoked text. |
| MCP servers | `.codex/config.toml` `mcp_servers` | `.mcp.json` | Not supported: `enableMCP: false` is a master-spec constraint. |
| Where files are read from | Working directory | Working directory | The **source checkout** given to `mars serve`, once at startup. The workspace provider never copies `.mars/` into task workspaces, so a model cannot edit its own hooks or commands mid-task; changes require a restart. |

## Guarantees and limits

- Repository text never grants permissions: instruction files are labelled,
  skills are labelled untrusted, commands only change the user's request, and
  hooks are the only thing that executes — through the sandbox with execute
  approval, or not at all.
- Everything model-visible is bounded: instructions 32 KiB (omitted whole when
  they do not fit the remaining model-context capacity), skills 4,000 chars each
  within the 16 KiB skills block, command bodies 16 KiB / expanded prompt 64 KiB,
  hook stdout/stderr 4 KiB each for the host (task events record only their
  sizes, exit code and outcome — like `mars_execute`, command output is never
  published through the events API), patch text 1 MiB, apply_patch context
  search 20M line comparisons per hunk, tool output 128 KiB.
- Not implemented: Claude Code stdin JSON for hooks and its other hook events,
  `allowed-tools` enforcement for commands, shell inclusion in commands,
  `CLAUDE.local.md`/home-directory instruction files, Codex `granular`
  approvals and `external-sandbox`, apply_patch for delegated children, any
  live-model verification.

## Where the code lives

- `packages/codex-tools` — apply_patch parser/applier, policy mapping,
  instruction discovery (attributed port; `NOTICE`, `third_party/codex/`).
- `packages/skills/src/{discovery,hooks,commands}.ts` — skill folders, hooks
  registry, slash commands (formats only).
- `packages/workbench/src/conventions-context.ts`,
  `conventions-loader.ts`, `host.ts` — freezing, hook dispatch, apply_patch
  binding, slash expansion; `packages/workspaces` `remove()`.
- `apps/cli/src/serve.ts` (`--no-conventions`), `apps/cli/src/commands.ts`.
