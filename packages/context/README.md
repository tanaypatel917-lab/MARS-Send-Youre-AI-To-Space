# `@mars/context`

`@mars/context` builds a deterministic, token-budgeted repository map for a host-authorized workspace. It returns file
paths and definition signatures with source-line provenance; it does not return implementation bodies.

## Integration

The repository root is resolved only by host code. Keep it out of RPC payloads, logs, model prompts, and other
untrusted interfaces:

```ts
import type { RequestContext } from "@mars/contracts";
import { createRepositoryMapProvider } from "@mars/context";
import type { LocalWorkspaceProvider } from "@mars/workspaces";

function createContextProvider(workspaces: LocalWorkspaceProvider) {
  return createRepositoryMapProvider({
    resolveRoot: async (context: RequestContext, workspace) => {
      const root = await workspaces.workspacePath(context, workspace);
      const inspected = await workspaces.inspect(context, workspace.workspace_id);
      return { root, revision: inspected.revision };
    },
  });
}
```

Call `map(context, { workspace, query?, mentioned_files?, mentioned_symbols?, max_output_tokens })`. The request is
strictly validated; query text is capped at 4,096 characters, mention lists at 256 items, and output budgets at 1–65,536
tokens. The resolver must return the same workspace revision as the request. If `context.scope.workspace_id` is set, it
must match the requested workspace.

## Token budget

The default `mars-conservative-v1` counter estimates tokens as `ceil(UTF-8 bytes / 3)`. This is a conservative heuristic
for typical code tokenizers, not a guarantee for every tokenizer; typical code BPE tokenization is often around 3.5–4.5
bytes per token. Supply the model's tokenizer through `tokenCounter` for an exact cap, or use the exported
`utf8ByteTokenCounter` for a strict upper bound on byte-level BPE tokenizers. Candidate symbols are added atomically;
the provider renders and counts the whole map after each tentative addition and never returns more than the requested
budget.

## Inventory and exclusions

Only `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`, and `.py` files are inventoried. Symlinks are never
followed. Dependency trees, private state, build/cache outputs, secret names and keys, generated/minified content,
binary data, and files outside configured size/depth/count limits are excluded. `.gitignore` rules are read at each
visited directory and applied with parent-to-child, last-match-wins semantics. Python extraction is line-based and
heuristic; TypeScript and JavaScript use the TypeScript compiler API.

Default limits include 5,000 files, 512 KiB per file, 32 MiB read per call, 32 path segments, 1,024 UTF-8 path bytes,
100,000 visited entries, 2,000 symbols per file, 4,000 ranking candidates, and a 10-second call timeout. The result's
`complete` flag is false if inventory stops at a count or byte limit; skipped counts are aggregated without echoing
excluded names.

## Cache, cancellation, and errors

Every `map()` call re-walks the tree, re-reads inventoried files, and hashes their contents. Content hashes—not mtimes or
sizes—control parse reuse. Map results use a bounded per-workspace LRU and are structurally cloned on return.
`invalidate(context, workspace, paths?)` only affects the caller's owner/project/workspace cache; a path invalidates
that path and descendants, and omitting paths clears that workspace cache. `close()` clears caches and rejects later
calls. Pass `{ signal }` to `map()` for cancellation.

Errors are `ContextPolicyError` (`policy`), `ContextRevisionError` (`revision_conflict`),
`ContextCancelledError` (`cancelled`), `ContextLimitError` (`limit_exceeded`), `ContextClosedError` (`closed`), and
`ContextIoError` (`io`). Error messages do not include host paths, and resolver failures are deliberately wrapped
without preserving their message or cause.

## Attribution and boundaries

The ranking implementation adapts Aider's `get_ranked_tags` algorithm from `aider/repomap.py` at revision
`5dc9490bb35f9729ef2c95d00a19ccd30c26339c`; see [NOTICE](NOTICE) and the bundled Apache-2.0 license.

This is a navigation aid—not authorization to read a workspace and not evidence that an implementation was inspected.
The parent runtime owns tool registration and prompt injection. There is no LSP integration yet. The package makes no
model/provider calls.
