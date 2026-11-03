# @mars/knowledge-graph

Derived, rebuildable code knowledge graph of a task workspace, built by the
pinned [graphify](https://github.com/Graphify-Labs/graphify) CLI
(`graphifyy==0.9.101`, Apache-2.0) running as a sandboxed Python subprocess.

## Ownership

- Owns nothing durable. The artifact is a cache in the `@mars/context` derived
  artifact store next to the repository map, keyed by scope and workspace and
  fenced by the workspace revision; delete it and `mars_graph_build` recreates
  it. SQLite-backed `@mars/memory` and the skill store stay the only owners of
  history and search.
- Oh My Pi stays the only live session/tool/model owner: the package exposes
  `RuntimeKnowledgeGraph` tools (`mars_graph_build`, `mars_graph_query`) that
  the workbench host binds per task; no MCP server, no second agent loop, no
  model call.

## Sandbox

`extract <workspace> --code-only --out <private>` and `--version` are the only
invocations. argv only, stdin detached, environment allowlist (PATH, locale,
TMPDIR, VIRTUAL_ENV) with HOME, XDG dirs and `GRAPHIFY_OUT` pinned to a
host-private data root, proxy variables pointed at a closed loopback port,
`PIP_NO_INDEX`/`UV_OFFLINE`, 96 KiB output cap, 180 s timeout. Raw graphify
output (which includes an absolute `.graphify_root`) is deleted after
normalisation; the artifact keeps relative paths only and drops anything that
escapes the workspace.

## Semantics

- Doctor: `graphify --version` must print the pinned version, otherwise every
  build answers `unavailable` and nothing is stored.
- Build: a crash, timeout, missing or malformed `graph.json`, or an empty graph
  is `failed`; nothing is stored. Only a non-empty, schema-valid graph for the
  current workspace revision is written, with a content digest independent of
  build time (same inputs, same digest).
- Query (`neighbours`, `paths`, `communities`): answers only when the stored
  artifact's workspace revision equals the current one; otherwise `not_built`
  or `stale`, never an answer from an old graph.
- Every attempt is appended as a `tool.completed` task event (`graph.build`
  record) by the host so reviewers can see what happened.
- Rendered output and launch summaries are labelled derived evidence
  (untrusted; the files take precedence) and fit the existing token budget.

## Tests

Offline only: `test/fake-graphify.ts` stands in for the CLI with JSON
scenarios; no Python, network or model (`model_requests: 0`).
