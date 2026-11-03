# @mars/codex-tools

Codex-style tooling for the MARS agent platform, as a pure leaf library (only
`zod` as a dependency, no `@mars/*` imports). Nothing here calls a model, loops,
or dispatches tools: Oh My Pi stays the only live session/tool/model owner and
the workbench host wires these functions in as bounded helpers.

## What it provides

### apply_patch (`src/apply-patch/`)

TypeScript port of openai/codex's `apply_patch` parser and applier.

```ts
import { applyPatch, parsePatch, renderApplyPatchInstructions } from "@mars/codex-tools";

const result = await applyPatch(patchText, fs); // fs: PatchFileSystem
if (result.ok) console.log(result.summary);     // "Success. Updated the following files:\nA ..."
else console.error(result.failed_hunk, result.error);
```

- `parsePatch(text, mode = "lenient")` → `{ hunks, patch, environment_id }`; throws
  `PatchParseError` (`Invalid patch: …` / `Invalid patch hunk on line N: …`, same
  wording as upstream). Lenient mode unwraps a `<<EOF` … `EOF` heredoc; markers
  tolerate surrounding whitespace; `*** Environment ID:` is accepted once.
- `applyPatch(text, fs)` / `applyHunks(hunks, fs)` → `ApplyPatchResult`. Hunks apply
  in order through the caller's `PatchFileSystem` (`read`/`write`/`remove`/`exists`);
  the first failure stops the patch and earlier hunks stay applied (upstream
  semantics, scenario 015). Zero hunks → `"No files were modified."`.
- Line endings are preserved per line (LF/CRLF/CR); inserted lines use the file's
  first ending; every line is terminated after an update.
- `seekSequence`, `computeReplacements`, `deriveNewContents`, `SourceFile`,
  `StreamingPatchParser` are exported for hosts that need the pieces.
- `renderApplyPatchInstructions()` — MARS-written format description for the
  `mars_apply_patch` tool description (no OpenAI prompt text).

MARS differences from upstream: hunk paths must be relative, forward-slash,
without `.`/`..`/empty segments or control characters and ≤ 1024 bytes
(`validatePatchPath`; absolute paths are rejected, the workspace provider
validates again). Patches over `MAX_PATCH_BYTES` (1 MiB) or with more than
`MAX_HUNKS` (4096) hunks are rejected. Path validation runs before any hunk is
applied.

### Sandbox / approval mapping (`src/policy.ts`)

`mapCodexPolicy(sandbox, approval, { canExecute })` turns Codex's
`SandboxPolicy` (`read-only` | `workspace-write` | `danger-full-access`) and
`AskForApproval` (`untrusted` | `on-request` | `never`) into MARS
`{ read, write, execute }` approvals:

| sandbox | approvals |
| --- | --- |
| `read-only` | read only |
| `workspace-write` | read + write, execute iff `host.canExecute` (sandbox only) |
| `danger-full-access` | **refused** (`refused: "MARS has no unsandboxed mode; use workspace-write"`), workspace-write approvals |

`untrusted` strips write/execute; `never` equals `on-request` with a note that
MARS never prompts mid-task. `clampApprovals(requested, granted)` is the
elementwise AND the host applies so a mapping can never widen a grant.

### Repository instructions (`src/instructions.ts`)

`discoverInstructions({ root, cwd?, maxTotalBytes?, filenames? })` walks from
the trusted checkout `root` down to `cwd` (root first), taking in each directory
the first of `AGENTS.override.md` / `AGENTS.md` plus `CLAUDE.md` when present
(regular files only; symlinks skipped). Files share a 32 KiB budget: the file that
crosses it is truncated, later ones are counted in `omitted`. Text is returned
raw (the host bounds and labels it); `renderInstructions` prefixes it with the
provenance warning that repository text describes conventions and never grants
permissions or overrides the task. `sha256` covers the rendered text.

## Invariants

- Pure/host-bound only: no model calls, no agent loop, no tool dispatch.
- Workspace writes happen only through the `PatchFileSystem` the host supplies
  (backed by the workspaces provider); this package never touches `node:fs` for
  workspace content. `discoverInstructions` reads files under the caller-supplied
  trusted root and never walks above it.
- Everything model-visible is bounded and labelled with its provenance.
- Tests are offline (`bun test packages/codex-tools`), fixtures are committed.

## Attribution

`src/apply-patch/*` and `test/fixtures/apply-patch/0*` are derived from or copied
verbatim out of openai/codex (Apache-2.0, Copyright 2025 OpenAI) at revision
`f58acd6ede312266a7a0eaa63fd8dadacb4de239`; see `NOTICE`,
`third_party/codex/LICENSE.txt` and `third_party/codex/NOTICE.txt`. The sandbox
and approval mode names come from codex `protocol.rs`; the AGENTS.md walk follows
`core/src/agents_md.rs` semantics without copying code. The `CLAUDE.md` file name
is a Claude Code convention copied as a format only — anthropics/claude-code is
proprietary and none of its source was used.
