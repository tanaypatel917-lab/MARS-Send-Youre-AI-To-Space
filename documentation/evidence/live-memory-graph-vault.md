# Live Verification Evidence: Hermes Memory + Real `graphifyy==0.9.101` + Obsidian Vault Round-Trip

Date: 2026-11-21
Budget: **$0.00** (strictly OpenRouter free tier; `GET /api/v1/key` confirmed `usage: 0`, `usage_daily: 0`, `is_free_tier: true`).

## 1. Bugs Found & Fixed in Real `graphifyy==0.9.101` Integration (`@mars/knowledge-graph`)

Installed `graphifyy==0.9.101` in an isolated Python virtual environment (`/home/ubuntu/.venvs/graphify-0.9.101/bin/graphify`) and ran `@mars/knowledge-graph` through the real subprocess wrapper (not `fake-graphify.ts`).

1. **`GRAPHIFY_OUT` output-directory mismatch (`packages/knowledge-graph/src/cli.ts`)**
   - **Symptom**: Real `graphify extract <cwd> --code-only --out <outRoot>` wrote `graph.json` directly into `<dataRoot>/out/graph.json`, causing `ENOENT` when `service.ts` read `<outRoot>/graphify-out/graph.json`.
   - **Root cause**: `graphifyy==0.9.101` computes its output directory as `Path(out_root) / GRAPHIFY_OUT`. When `GRAPHIFY_OUT` is an absolute path, Python `pathlib` drops `out_root` and writes directly to `GRAPHIFY_OUT`.
   - **Fix**: Pin `env.GRAPHIFY_OUT = join(options.dataRoot, "out", "graphify-out")` in `packages/knowledge-graph/src/cli.ts` and mirror the same `GRAPHIFY_OUT` resolution semantics in `packages/knowledge-graph/test/fake-graphify.ts`.

2. **Slugified host-path leakage detection (`packages/knowledge-graph/src/service.ts`)**
   - **Fix**: Extended host-path leakage detection (`slugifyHostPath`, `hostPathNeedles`, `containsHostPath`) so both raw absolute paths and graphify-slugified host paths are rejected from emitted `KnowledgeGraphArtifact` payloads.

### Real `graphifyy==0.9.101` Integration Test Result

Command:
```bash
MARS_GRAPHIFY_BIN=/home/ubuntu/.venvs/graphify-0.9.101/bin/graphify \
  bun test packages/knowledge-graph/test/real-graphify.test.ts
```

Observed result:
- `1 pass, 0 fail, 21 expect() calls`
- `doctor`: `available: true`, `version: "0.9.101"`, `reason: null`
- Real graph stats on `packages/memory`: `files: 7`, `nodes: 162`, `edges: 447`, `communities: 8`, `dropped_nodes: 19`, `dropped_edges: 23`
- Content digest: `41ff113e0d52df91f71e0231c10190e25f65b426122c1be02e055548db5e9672`
- Verified `mars_graph_build`, `mars_graph_query` (`communities`, `neighbours`, `paths`, stale-revision fencing), and zero raw/slugified host-path leakage.

## 2. Live OpenRouter `:free` Verification & Daily Quota Accounting

Live runs were executed with `MARS_LIVE_E2E=1`, `MARS_LIVE_MODEL=openrouter/free` (guarded by `assertFreeOpenRouterModel` to refuse any non-free model), and `OPENAI_API_KEY` bound via environment only.

### What Ran Live Before Account Daily Quota Exhaustion
- Earlier live runs against `openrouter/free` returned `HTTP 200` (observed resolved free models included `nvidia/nemotron-3.5-super-vl:free`, `liquid/lfm-3-1.7b:free`, and `recursive/flint-v1.0:free`), created a Hermes memory proposal via `ReviewRunner` + `createRegistryReviewGateway`, passed invisible-Unicode threat scanning, accepted into `DurableMemoryStore` at revision `1`, appeared in follow-up frozen memory context (`formatSnapshot`), and exported via `mars vault export` into **19 Obsidian-compatible Markdown notes**:
  - `memory_fact: 1`, `skill: 1`, `graph_index: 1`, `graph_community: 8`, `graph_file: 7`, `project: 1`.
- During iteration on the vault-note edit assertion (editing the body before `<!-- mars:related -->`), subsequent live reruns hit OpenRouter's account-wide daily free-tier request cap (`HTTP 429`):
  - `GET https://openrouter.ai/api/v1/key` reported:
    - `usage: 0`, `usage_daily: 0`, `is_free_tier: true`
    - `free_model_daily_requests: { used: 56, limit: 50, remaining: 0 }`
    - `X-RateLimit-Reset: 1795305600000` (`2026-11-22T00:00:00.000Z`, `limit_source: "openrouter_free_tier_daily"`).
- No paid model was ever invoked (`$0.00` spent).

## 3. Complete Automated End-to-End Pipeline Verification (Real `graphifyy==0.9.101` + Hermes Memory + Obsidian Vault)

To verify every downstream step end-to-end without exceeding the `$0.00` free-tier daily quota, `packages/memory-vault/test/live-memory-graph-vault.test.ts` shares a single `runMemoryGraphVaultE2E` runner across:
1. **Deterministic review gateway mode** (runs whenever `MARS_GRAPHIFY_BIN` is set — exercises real `graphifyy==0.9.101`, real `ReviewRunner`, real `DurableMemoryStore`, real `SkillStore`, and real `mars vault export|status|import`).
2. **Live OpenRouter `:free` mode** (runs when `MARS_LIVE_E2E=1`, `MARS_GRAPHIFY_BIN`, and `OPENAI_API_KEY` are set).

### Executed Receipt (Deterministic Review Gateway + Real `graphifyy==0.9.101`)

Command:
```bash
MARS_GRAPHIFY_BIN=/home/ubuntu/.venvs/graphify-0.9.101/bin/graphify \
MARS_LIVE_EVIDENCE_OUT=/tmp/e2e-receipt.json \
  bun test packages/memory-vault/test/live-memory-graph-vault.test.ts
```

Result: **`1 pass, 1 skip (live-gated), 0 fail, 108 expect() calls` (1.75s)**

Verified assertions:
- **Real `graphifyy==0.9.101`**:
  - `mars_graph_build · built` (`files: 7`, `nodes: 162`, `edges: 447`, `communities: 8`, `dropped_nodes: 19`, `dropped_edges: 23`)
  - `mars_graph_query · communities`, `neighbours` (`DurableMemoryStore`), `paths` (`DurableMemoryStore -> scanThreat()`), and `stale` on revision change (`rev-live-1` -> `rev-live-2`).
- **Hermes Persistent Memory & Threat Scanning**:
  - `scanThreat("Safe\u200blesson") === "invisible_unicode"` and `memory.submitProposal(...)` with invisible Unicode rejected with `MemoryStoreError(code="invalid_input", details={ threat: "invisible_unicode" })`.
  - `ReviewRunner.reviewNow(...)` created pending proposal `dd8b680ac02c56067e2a9b4f7f7364ed` without mutating live memory (revision remained `0`).
  - `memory.acceptProposal(...)` applied revision `1`; follow-up `formatSnapshot(await memory.snapshot(ctx))` contained the accepted lesson.
- **Obsidian-Compatible Vault Round-Trip (`mars vault export` / `status` / `import`)**:
  - `mars vault export` wrote `19` Markdown notes (`memory_fact: 1`, `skill: 1`, `graph_index: 1`, `graph_community: 8`, `graph_file: 7`, `project: 1`); all `19/19` parsed with valid YAML frontmatter (`mars_kind`) and Obsidian `[[wikilinks]]`.
  - Edited exported memory note body (before `<!-- mars:related -->`) and added `vault-added-lesson.md`.
  - `mars vault status` before import reported `{ modified: 1, added: 1, pending_vault_proposals: 0 }`.
  - `mars vault import` created `2` revision-fenced pending proposals (`expected_revision: [1, 1]`) and did **not** write to SQLite (`memory.snapshot(ctx).revision` remained `1`).
  - `mars vault status` after import reported `pending_vault_proposals: 2`.
- **Revert & Follow-Up Frozen Context**:
  - Rejected the 2 vault-imported proposals via `memory.rejectProposal(...)`.
  - Reverted the accepted proposal via `memory.revertProposal(ctx, proposalId, 1, ...)`: status `"reverted"`, revision advanced to `2`, and the lesson disappeared from `formatSnapshot(await memory.snapshot(ctx))`.

## 4. Reproducing Live with OpenRouter `:free` ($0.00)

Once the account's daily OpenRouter free-tier quota resets (after `2026-11-22T00:00:00Z`), run the exact same test file in live mode:

```bash
MARS_LIVE_E2E=1 \
MARS_GRAPHIFY_BIN=/home/ubuntu/.venvs/graphify-0.9.101/bin/graphify \
MARS_LIVE_MODEL=openrouter/free \
MARS_LIVE_EVIDENCE_OUT=/tmp/live-e2e-receipt.json \
  bun test packages/memory-vault/test/live-memory-graph-vault.test.ts
```
