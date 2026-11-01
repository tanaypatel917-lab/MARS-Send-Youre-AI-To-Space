# @mars/memory

Local durable evidence memory; no network, provider, model, agent loop, task or workspace service dependency. Oh My Pi journals remain authoritative; this package maintains a disposable derived index.

**WARNING: `delete(ctx)` hard-erases the OWNER-LEVEL PROFILE across ALL of that owner's projects, plus this project's project-wide memory, the context's own workspace overlay, and the journal index for the exact context scope. It is NOT project-only deletion.** Other workspace overlays and other exact journal scopes remain intact.

**Host authorization must also gate profile-target mutations like `delete`: `forgetEntry` hard-erases a visible profile entry owner-wide, and `batch`/`batchWithReport` can patch or soft-remove profile evidence across projects.** Source event IDs and observed/verified timestamps are schema-validated but **not authenticated**; the host must authenticate them before either batch API. No `created_by` identity is recorded.

For **project-only** deletion, obtain `snapshot(ctx)`, filter entries to `target === "project"`, then `batch(ctx, snapshot.revision, entries.map(e => ({ operation: "remove", entry_id: e.entry_id })))` for soft deletion, or call `forgetEntry(ctx, e.entry_id)` on each for hard erasure. Profile stays intact. For journal cleanup, call `excludeJournal` for each session indexed under this exact context; journal cleanup is explicit and independent. Per-entry hard erasure is not an atomic multi-entry operation.

## Integration

**Storage format 2 is required.** Existing format-1 stores fail closed with `unknown_format`; there is no automatic migration because legacy journal evidence IDs are ambiguous. Preserve old stores and perform a host-controlled export/reimport and lineage reconciliation before replacing them. Do not change `user_version` manually. Exports also identify format 2.

```ts
import { createMemoryStore, formatSnapshot } from "@mars/memory";
const memory = createMemoryStore({ rootDir: privateMemoryDirectory });
const context = { schema_version: 1, scope: { owner_id: "me", project_id: "app" }, request_id: "request-1" } as const;
const frozen = await memory.snapshot(context);
// Propose MemoryOperation[] with the contract's full MemoryEntry for adds.
await memory.batch(context, frozen.revision, operations);
const prompt = formatSnapshot(frozen); // Freeze once at session start.
await memory.close();
```

Exports: `createMemoryStore`, `DurableMemoryStore`, `MemoryStoreError` (typed `code`, optional `details`), `RequestContextSchema`, `MemoryEntrySchema`, `MEMORY_STORE_FORMAT_VERSION`, `DEFAULT_BUDGETS`, `DISCLOSURE`, `canonicalJson`, `formatSnapshot`, and associated option/result types. The store implements `MemoryService`: `snapshot`, `batch`, `search`, `provenance`, `export`, `delete`. Extras: `snapshotAt`, `readExport`, `forgetEntry`, `datasetCandidates`, `recordDatasetUse`, `indexJournal`, `searchHistory`, `excludeJournal`, `dropHistory`, `close`. `@mars/memory/journal` separately exports the pure `parseJournal` adapter and its types/error.

SQLite uses WAL, FULL synchronization, secure deletion, busy timeout, FTS5 secure-delete and immediate transactions. All writers on an instance queue; separate processes coordinate through SQLite. A global commit sequence advances only on successful batches/erasure. Visible stream revisions provide optimistic concurrency; a conflict exposes `details.current_revision`. Entry histories are immutable, canonical-JSON hashed, checked on reads and reconstructible with `snapshotAt`. Hard-erased history cannot be reconstructed. Unknown format versions and corrupt hashes fail closed. Error messages do not include storage paths.

Freeze the actual snapshot at session start and key frozen views/caches by **scope + revision**, not revision alone: different contexts may share a revision number with different content. `snapshotAt(ctx, revision)` returns that supplied historical cutoff, not the current revision; hard erasure prevents reconstructing erased history. Budgets and `hostPrivateRoots` are **per instance**, not persisted or reconciled across instances opening the same store; hosts must configure all instances consistently.

Profile streams belong to an owner, visible across projects; their project records writer provenance and they cannot carry workspace IDs. Project streams belong to owner/project plus optional workspace. Project-wide entries are shared; overlays are visible only to their own workspace. SQL scope predicates precede retrieval/ranking. Adds require exact context owner/project and absent-or-matching workspace; inaccessible mutations/provenance fail `not_found`.

Corrections require the predecessor to have the **identical target and scope** (owner, provenance project, and workspace, including both being project-wide). Scope/target mismatches return `not_found`, just like inaccessible predecessors; correction cannot widen an overlay into project-wide memory or cross profile provenance projects. Patch cannot change an entry's scope or target.

Hermes characterization: pinned upstream reference `7020ea3e96c3fdbc768c5296493e186df46f075b`; mirrored defaults 1375 profile / 2200 project, Unicode code-point lengths (not UTF-16 units), `\n§\n` fact joining, final-state batch budgets (including all workspace overlays), and frozen session-start snapshots. No Hermes source was copied. Budgets are configurable. Facts are trimmed, must be nonempty, and reject C0 controls except newline/tab, invisible/bidi controls, and the separator. Threat-pattern scanning is **not** implemented: these checks are not a prompt-injection defense.

Search is deterministic FTS5 unicode61 keyword AND recall (underscore is a token character), with a small stopword list, bm25 then ID. It is not semantic retrieval. Current entries order by first commit then ID. `provenance(id)` visits the visible correction predecessor chain, then each entry's revisions oldest-first, then visible successors (deduplicated). Corrections tombstone predecessors atomically. Soft-deleted facts remain in provenance/export but not recall or dataset candidates.

## Explicit journal adapter

```ts
// Host loads the authoritative journal using the pinned Oh My Pi SessionManager.
const session = await SessionManager.open(hostPrivateJournalPath);
const header = session.getHeader();
await memory.indexJournal(context, {
  session_id: header.id,
  entries: [header, ...session.getEntries()],
  // includeToolResults: true, // opt-in; default false
});
const hits = await memory.searchHistory(context, "deployment decision", { before: 2, after: 1 });
await session.close();
```

The adapter accepts records only, never paths. Version-3 headers must match session ID. Header path fields are discarded, as are thinking/images/tool calls; user/assistant text is indexed, optionally toolResult text. Configure `hostPrivateRoots` to redact occurrences in text to `<private-path>`; the store root is always redacted too. Memory facts containing configured private roots or the store root are rejected without echoing the path. A session is permanently claimed by its first exact scope (even after deletion). Journal history is **never profile-scoped**: searchHistory, datasetCandidates and export require exact owner/project/workspace equality. Workspace contexts do not see project-wide journal sessions. Profile search only searches memory facts, never journal evidence. Reindex atomically replaces its derived messages, respecting hashed exclusions. History context follows parent chains backwards and the first child in file order forwards. `dropHistory` is rebuildable; `excludeJournal` is permanent. Unknown record types are ignored; malformed messages reject the entire input.

## Export, deletion, datasets

`export` writes/fsyncs a scope-bound content-addressed JSON artifact, with visible entry revision histories (including tombstones), indexed sessions and message text, dataset-use records, and disclosure. `readExport` checks exact requesting scope, hash and size. Artifacts are local references, not paths.

`datasetCandidates` supplies live facts and indexed messages with source IDs. Pass those IDs to `recordDatasetUse(context, manifestId, sourceIds)` to track evidence. `forgetEntry`, `delete` and `excludeJournal` return affected manifest IDs and the disclosure: **Deletion cannot erase influence on already-trained model weights; retire or retrain these manifests.** `batchWithReport` is an extended batch API returning `{ revision, affected_training_manifests, disclosure }` for soft removal, patching and corrections; the contract's `batch` preserves its numeric revision result. Hosts must retire datasets when soft-removing evidence too.

Journal source IDs are `journal:` followed by a canonical JSON array `[session_id, entry_id]` (for example `journal:["S","E"]`); treat returned source IDs as opaque. All nonempty identifier strings remain supported, including colons, quotes and Unicode. Duplicate message IDs within one input session are rejected before claiming/indexing; different sessions may reuse message IDs. Dataset-use rows retain separate exact session and entry components; session erasure uses equality, never prefix matching. Journal exclusion hashes likewise encode scope/session/optional entry as a JSON tuple, distinguishing whole sessions from individual messages.

Lineage disclosure uses **exact recording-scope equality**: export and all affected-manifest reports include only records made under the caller's exact owner/project/workspace scope, even when the underlying profile or project-wide evidence is shared. Erasure still removes the covered evidence globally; returned manifests are deliberately not a complete cross-scope impact inventory. Hosts needing global model-retirement orchestration must keep their own authorized cross-scope lineage registry. Manifest IDs are caller-supplied, not authenticated by this package.

Dropping derived history or reindexing fewer messages preserves dataset-use records. Journal exclusion and scope deletion report recorded evidence even if its message is no longer indexed. Hard erasure removes the reported evidence's dataset-use records only for the caller's exact recording scope; other scopes' lineage remains intact.

`delete(ctx)` reports and clears **all** dataset-use records recorded under that exact scope, including orphaned records whose shared evidence was already erased by another scope. `forgetEntry` can report and clear the caller's remaining lineage for an already-erased entry; without visible evidence or caller-owned lineage it still returns `not_found`. `excludeJournal` likewise uses retained caller-scope lineage rather than requiring currently indexed messages. Scope deletion intentionally covers all sessions in that scope, not a single session.

Hard erasure removes all covered history/FTS text and checkpoints/truncates WAL; content-free hashed exclusions prevent reindexing erased journal sessions/messages and reuse of forgotten memory IDs. Stream revisions persist so stale writers conflict. Delete covers exactly visible memory and journal rows, including profile across projects but no other workspace overlay. To avoid stale copies of erased evidence, any hard erasure invalidates all cached exports for that owner (a conservative cache eviction, not deletion of other scopes' database evidence). Exported copies already taken by callers, backups, filesystem snapshots and trained weights are outside this store's erasure boundary. The local SQLite/fsync durability model assumes a functioning local filesystem, not multi-host coordination. Host-private directory/symlink hardening is the host's responsibility.

Not implemented: semantic retrieval, OpenClaw consolidation, external providers, comprehensive threat scanning or automatic training/model retirement.
