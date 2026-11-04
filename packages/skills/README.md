# @mars/skills

File-backed skill lifecycle store; the single writer of `SKILL.md` files, versions, drafts, proposals and the change journal. No network, model, agent-loop or database dependency. Depends on `@mars/contracts` (types) and `@mars/memory` (`scanThreat`). Ported from the OpenClaw Skill Workshop via `mars-platform/packages/skills`; see `NOTICE` and `third_party/openclaw/LICENSE.txt`.

**Status: offline-verified only** (`src/store.test.ts`, 29 tests on temporary directories). No skill has been learned from a live session.

## Integration

```ts
import { SkillStore } from "@mars/skills";
const skills = new SkillStore(join(privateStateDirectory, "skills"));
const actor = { actor: "tanay", source: "cli" };
await skills.create("release-notes", "---\nname: release-notes\ndescription: ...\n---\n...", actor);
const frozen = (await skills.list()).filter((s) => s.status !== "archived"); // freeze once at launch
const proposal = await skills.submitProposal({ source: "background_review:s1:r1", rationale: "...", ops: [{ op: "update", name: "release-notes", content }] }, { ...actor, reviewId: "r1" });
await skills.accept(proposal.id, "tanay");          // fails stale-revision if the store moved
await skills.undoReview("r1", actor);              // reverses every change journaled under r1
```

Exports: `SkillStore` (implements `SkillLifecycleService`), `SkillError` (typed `code`), `parseFrontmatter`, `withDirectoryLock`, and the `Skill`, `Version`, `Draft`, `Operation`, `Proposal`, `Change`, `MutationOptions`, `Status` types (mirrored in `@mars/contracts` as `SkillRecord`, `SkillVersion`, `SkillDraft`, `SkillOperation`, `SkillProposal`, `SkillChange`, `SkillMutationOptions`, `SkillLifecycleStatus`).

## API

Every mutation takes `MutationOptions { actor, source, expectedRevision?, reviewId? }`; `actor` and `source` are required, `expectedRevision` is checked against the store revision (`stale-revision`), `reviewId` is journaled so the change can be undone. Mutations return the new store revision.

| Group | Methods |
| --- | --- |
| Read | `get(name)`, `list()`, `getRevision()`, `listVersions(name)` |
| Lifecycle | `create`, `update`, `archive`, `restore`, `pin(name, pinned)`, `recordUse`, `restoreVersion(name, versionId)`, `applyBatch(ops)` (atomic) |
| Drafts | `saveDraft(name, content, options, rationale)`, `viewDraft`, `listDrafts`, `discardDraft`, `applyDraft` |
| Proposals | `submitProposal({ source, ops, rationale }, options?)`, `listProposals()`, `accept(id, options \| actor)`, `reject(id, reason, options?)` |
| Maintenance | `runCurator(options?)`, `undoReview(reviewId, options)` |

`Operation` is `{ name } & ({ op: "create" \| "update", content } \| { op: "archive" \| "restore" \| "recordUse" \| "stale" } \| { op: "pin", pinned } \| { op: "restoreVersion", versionId })`.

Error codes (`SkillError.code`): `invalid-name`, `invalid-content`, `frontmatter`, `threat`, `exists`, `not-found`, `archived`, `pinned`, `invalid-state`, `invalid`, `empty`, `full`, `stale-revision`, `not-pending`, `conflict`, `unsafe-path`, `corrupt`, `missing`, `locked`.

## Invariants

- **Content validation.** Name `^[a-z0-9][a-z0-9-]{0,63}$` (not `constructor`/`prototype`); nonempty content; frontmatter parsed by `parseFrontmatter` (flat `key: value` subset only; anchors, aliases, tags, block scalars, flow collections, indentation, duplicate keys and `__proto__` rejected) with `name` equal to the skill name and nonempty `description`; `scanThreat` clean. Validation runs on create/update/restoreVersion, on every stored skill at load, and on undo results.
- **Status machine.** `active` → `stale` (curator ≥14 days idle, or `stale` op) → `archived` (curator ≥30 days idle, or `archive`); `restore` returns to `active`; `update`/`recordUse`/`restoreVersion` also return to `active`. Archived skills accept only `restore`/`restoreVersion`. Pinned skills cannot be archived or marked stale and are skipped by the curator. Nothing is deleted.
- **Versions.** Snapshot before `update`, `restoreVersion`, `archive`, `restore`, `undoReview`; newest 10 kept per skill.
- **Drafts.** Max 50. `baseRevision` = SHA-256 of the skill's current content (or `null`); `applyDraft` fails `stale-revision` if it changed.
- **Proposals.** Dry-run on a cloned state at submission; `expectedRevision` captured; `accept` fails `stale-revision` if the store revision moved; `reject` needs a reason. Pending proposals are not part of the revision hash and never touch files.
- **Undo.** `undoReview` replays that review's journal entries in reverse; `conflict` if a touched skill or the draft inbox no longer matches the journaled `after` state; undoing `create` archives; idempotent via `undone`; the undo is journaled under `undo:<reviewId>`.
- **Revision.** SHA-256 of canonical JSON of `{ skills, versions, drafts, undone }`.
- **Persistence.** All operations run under `withDirectoryLock(root)` (`.writer.lock` directory, owner file `{pid, hostname}`, stale reclaim only for a dead pid on the same host, 30 s timeout). Commits write `.skills-transaction.json` (state + journal) atomically (temp, fsync, rename, parent fsync) and then `recover()` moves directories between `skills/` and `skills/.archive/`, writes `SKILL.md`, `.lifecycle.json` (metadata without content) and `changes.jsonl`, and deletes the transaction file; `recover()` also runs before every operation. Files are created 0600.
- **Path safety.** Resolved paths must stay inside the root; every path component is checked with `lstat` for symlinks. Unmanaged directories under `skills/` or `skills/.archive/`, or a skill present in both, fail `conflict`. Missing or invalid `SKILL.md` for a listed skill fails the whole load (fail closed).
- **Clock.** Injectable `clock` for deterministic curation tests.

## Limits

Name 64 chars; 10 versions; 50 drafts; curator 14/30 days; lock 30 s; threat scan 65,536 code points. There is no content-size limit in the store itself: callers (the review output whitelist caps skill content at 8000 characters) must bound it.

## Not implemented

Scoping by owner/project; semantic discovery; a scheduler for `runCurator` (nothing in this repository calls it outside tests); CLI/RPC commands for accept/reject/undo/pin; an evaluation gate before acceptance; OpenClaw's reviewer prompt and tool surface; Hermes curator backups and run reports.

## Attribution

Lifecycle semantics adapted from `openclaw/openclaw` at `7d9677ce36db4aeea2ce36a3bb78588829e80933` (`src/skills/workshop/{skill-versions,drafts,review-undo,unused-archive,changes}.ts`, MIT) and stale/archive policy characterised from `NousResearch/hermes-agent` `agent/curator.py` at `7020ea3e96c3fdbc768c5296493e186df46f075b` (MIT). MARS modifications: Bun/TypeScript port, directory lock, transactional persistence, proposal queue, threat scanning, contracts adapter. Details in `NOTICE`.

## Repository conventions

`discovery.ts`, `hooks.ts` and `commands.ts` read Claude Code / Codex CLI style convention files from a **trusted project checkout** and turn them into bounded data for the workbench host. They are pure, offline libraries: no model call, no agent loop, no process spawn, no writes. Everything they return is repository text — the host labels it with its provenance and bounds it; it never grants permissions. Shared types live in `src/conventions-types.ts` (`DiscoveredSkill`, `SkillDiscoveryResult`, `HookSpec`, `HookExecutor`, `HookResult`, `SlashCommand`, `ExpandedCommand`).

**Attribution.** anthropics/claude-code is proprietary; only its *formats* are reproduced here (file names `.claude/skills/<name>/SKILL.md`, `.claude/commands/<dir>/<name>.md`; frontmatter keys `name`, `description`, `argument-hint`, `allowed-tools`; hook event names `SessionStart`/`PreToolUse`/`PostToolUse`; the `$ARGUMENTS` / `$1`…`$9` placeholders; "exit code 2 blocks"). No Claude Code source was read or copied. Codex CLI's `.codex/skills` and `.agents/skills` folders are supported as plain file layouts.

### Skill folders (`discoverSkills`)

```ts
const report = await discoverSkills({ root, maxSkills: 256, maxContentBytes: 65_536 });
report.skills   // DiscoveredSkill[]: { name, description, path, source, content, bytes, frontmatter }
report.shadowed // later copies of a name already taken by an earlier source
report.skipped  // { path, reason: "symlink" | "oversize" | "encoding" | "frontmatter" | "missing-name-or-description" | "invalid-name" | "limit" | ... }
report.warnings // e.g. frontmatter name differs from the folder name
const records = toSkillRecords(report); // SkillRecord[] (status "active", unpinned, epoch timestamps, useCount 0) for freezeSkills
```

Scanned in order: `skills/<name>/SKILL.md` (plus `skills/vendor/<vendor>/<name>/SKILL.md`, the layout this repository vendors watch-skill in), `.claude/skills/<name>/SKILL.md`, `.codex/skills/<name>/SKILL.md`, `.agents/skills/<name>/SKILL.md`. One folder level only; dot-folders (for example the store's `skills/.archive`) are ignored. Frontmatter goes through `parseFrontmatter`; `name` and `description` are required and `name` must satisfy the store rule `^[a-z0-9][a-z0-9-]{0,63}$`. First location wins; results are ordered by source then path, so output is deterministic. Symlinked folders or files, non-UTF-8 content, files over `maxContentBytes` (default 64 KiB) and anything past `maxSkills` (default 256) are skipped and reported.

### Hooks (`loadHooks`, `runHooks`)

`<root>/.mars/hooks.json`, validated with a strict zod schema (unknown keys and events rejected, ≤ 256 KiB, not a symlink):

```json
{ "schema_version": 1,
  "hooks": {
    "session-start": [ { "command": ["bun", "run", "lint"], "timeout_ms": 60000 } ],
    "pre-tool":  [ { "matcher": "mars_write|mars_apply_patch", "command": ["bun", "run", "check:fast", "{tool}", "{path}"], "timeout_ms": 30000 } ],
    "post-tool": [ { "matcher": "mars_write", "command": ["bun", "run", "biome", "format", "--write", "{path}"] } ] } }
```

- Events: `session-start`, `pre-tool`, `post-tool`; `SessionStart`, `PreToolUse`, `PostToolUse` are accepted as aliases (configuring both spellings of one event is an error).
- `command` is an argv array — never a shell string. A token equal to `{tool}` or `{path}` is replaced by the value (`renderHookArgv`); a placeholder with no value drops its token; partial matches such as `x{path}y` are literal. ≤ 64 tokens of ≤ 1024 bytes, no control characters.
- `matcher` is `*` or a `|`-separated list of exact tool names (absent = every tool); `session-start` takes no matcher. ≤ 32 hooks per event; `timeout_ms` 1 000–300 000 (default 60 000).
- `loadHooks(root)` → `HooksRegistry | null` (null when the file is missing; `HooksError` with code `invalid`/`unreadable` otherwise). `registry.select(event, toolName?)`, `registry.list()`, `parseHooksFile(json)`.
- `runHooks(registry, event, { tool?, path? }, executor)` runs the selected hooks **in order through the injected executor** — the host passes its approval-gated, sandboxed `WorkspaceHost.execute`. The executor may answer `{ skipped: reason }` (no execute approval, no sandbox); nothing here ever spawns a process. Each `HookResult` carries `outcome: "ran" | "skipped" | "timeout" | "error"`, `exit_code`, `stdout`/`stderr` truncated to 4 KiB and `blocked`. For `pre-tool`, exit code 2 ⇒ `blocked: true` and the remaining pre-tool hooks are not run; the host refuses the tool call with the hook's stderr. Any other non-zero exit is recorded and does not block; exit 2 outside `pre-tool` does not block. A hook that outlives `timeout_ms` is recorded as `timeout`. `isBlocked(results)` is the one-line check.

### Slash commands (`loadCommands`, `expandCommand`)

`<root>/.mars/commands/<name>.md` and `<root>/.claude/commands/<name>.md`; one level of `<dir>/<name>.md` namespacing yields `dir:name`. Names are the file stem, `^[a-z0-9][a-z0-9_-]{0,63}$` per segment. Optional frontmatter (`description`, `argument-hint`; `allowed-tools` and other keys are preserved in `frontmatter` but never enforced here). `.mars/commands` wins over `.claude/commands`; shadowed copies and skipped files (bad name, symlink, oversize, bad frontmatter, non-UTF-8, past the 128-command cap) are reported on the registry. Bodies are capped at 16 KiB.

```ts
const registry = await loadCommands(root); // registry.list(), registry.get(name), .shadowed, .skipped
expandCommand(registry, "/review src/foo.ts security");
// → { name: "review", prompt: "Review src/foo.ts for bugs. Focus: security. …", command }
```

Expansion substitutes `$ARGUMENTS` (everything after the name) and `$1`…`$9` (whitespace-split, quotes not interpreted, missing → empty) in a single pass, so argument text is never re-expanded. When the body uses no placeholder the argument text is appended after a blank line. Returns `null` when the input is not `/name …` or the name is unknown; throws `CommandError("too-large")` when the expanded prompt exceeds 64 KiB. `` !`command` `` shell inclusion is **never executed**: it is listed in `command.unsupported` and left verbatim; `@file` references are left as-is for the host.

Tests: `src/discovery.test.ts`, `src/hooks.test.ts`, `src/commands.test.ts` with committed fixtures under `test/fixtures/{discovery,hooks,commands}` (the fixtures' `.gitignore` re-includes `.mars/`, which the repository root ignores). `discovery.test.ts` also loads the real `skills/vendor/watch-skill/*/SKILL.md` folders.
