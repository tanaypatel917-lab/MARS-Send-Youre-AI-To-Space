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
