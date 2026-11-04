# @mars/memory-vault

Obsidian-compatible mirror of MARS curated memory: plain Markdown, YAML
frontmatter, `[[wikilinks]]`.

## Ownership

This package owns **no persistent store**.

- `@mars/memory` (SQLite) owns memory facts, their history, revisions and
  proposals.
- `@mars/skills` (`SkillStore`, files) owns skill content, versions,
  lifecycle and proposals.
- `@mars/knowledge-graph` owns graph artifacts.

The vault is a derived view that is fully rebuildable from those stores with
`exportVault`. It never writes to SQLite or to skill files. Vault edits only
become `pending` proposals through the existing proposal APIs
(`DurableMemoryStore.submitProposal`, `SkillStore.submitProposal`); the store
owners accept or reject them. Graph and project notes are read-only mirrors.

Every changed note body and rationale is scanned with `scanThreat` from
`@mars/memory` at the vault boundary and refused when flagged; the stores scan
again on acceptance.

## API

- `exportVault(ctx, { vaultDir, memory, skills, graph? })`
- `importVault(ctx, { vaultDir, memory, skills, actor, source: "memory-vault", allowRemove?, strict? })`
- `vaultStatus(ctx, { vaultDir, memory, skills })`

CLI: `mars vault export|import|status` (see `apps/cli/src/vault.ts`).

Full documentation: `documentation/MEMORY_VAULT.md`. Tests are offline
(`bun test packages/memory-vault`), `model_requests: 0`; no live Obsidian or
model run was performed.
