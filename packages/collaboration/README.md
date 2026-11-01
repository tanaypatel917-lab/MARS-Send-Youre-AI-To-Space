# `@mars/collaboration`

Bounded agent delegation and agent-to-agent coordination for MARS. The package
persists coordination state and result proposals; it does not own model
execution, sessions, tools, workspaces, or result application.

## Ownership and safety

- Oh My Pi sessions, model execution, tools, and the canonical conversation
  journal remain owned by `@mars/execution`. The default child adapter calls
  `openRuntimeSession`; hosts may inject a `ChildRuntimeAdapter` for tests.
- The collaboration store persists only coordination envelopes, bounded
  messages, summaries, artifact references, counters, leases, and usage. It
  never stores transcripts or tool output.
- Role labels are metadata. Authority is derived from the root's stored
  approvals and only narrows as work is delegated.
- Child results are proposals. `reviewResult` records acceptance or rejection;
  it never applies workspace changes or writes memory/skills.
- Agent capabilities are bearer tokens. Keep them in host-owned closures and
  never expose them, `host.jobs`, session references, or private state paths to
  a model or RPC client.
- Messages and results are untrusted data. `renderUntrustedMessage` preserves
  that boundary when a host supplies messages to a child.
- Publishable text is rejected if it contains the collaboration root, a
  configured host-private root at a path-segment boundary, or a recognized
  secret-like value.

## Basic host flow

```ts
import {
  createCollaboration,
  createChildRunner,
  createOhMyPiChildAdapter,
} from "@mars/collaboration";

const collaboration = await createCollaboration({
  rootDir: `${stateRoot}/collaboration`,
  hostPrivateRoots: [stateRoot],
});

const { room, coordinator } = await collaboration.host.openRoom(context, {
  task,
  idempotency_key: "task-run-1",
  delegation_pool: { max_tokens: 800 },
  authority: {
    approvals: { read: true, write: false, execute: false },
    allow_delegation: true,
    paid_consent: false,
  },
});

const runner = createChildRunner({
  collaboration,
  adapter: createOhMyPiChildAdapter({
    registry,
    stateRoot,
    workspaceFor: hostWorkspaceProvider,
  }),
});

await runner.recover();
await runner.tick();
```

**The host must launch the coordinator's own runtime with
`room.coordinator_runtime_budget`, not `task.budget`.** The delegation pool is
reserved for descendants; subtracting it before running the coordinator keeps
the coordinator and all child runtimes within the task budget. Each delegated
member likewise has an envelope split between its own runtime and an optional
delegation pool.

The host binds a capability to the child runtime or custom tool closures; the
model must not choose or receive another agent's capability. Call `tick()` on a
host-controlled interval, `idle()` to wait for local jobs, and `shutdown()` to
stop claiming and cancel active work. Call `close()` when the host no longer
needs the store. `host.jobs` is a runner-only interface and must never be
exposed over RPC.

The `AgentPort` supports directed `send`, `inbox`, and `ack`; bounded
`delegate`, `children`, and `cancelChild`; and direct-child `results` and
`reviewResult`. Every operation requires the request context and capability.
There is no broadcast message, global directory, or implicit authority grant.

## Default limits

Per-room limits can only be lower than the host caps. Room values omit the
host-only operational limits.

| Limit | Default |
| --- | ---: |
| Delegation depth | 2 |
| Children per agent / total children | 4 / 8 |
| Recipients per message | 4 |
| Message body | 8 KiB (hard ceiling 32 KiB) |
| Delegation instruction | 16 KiB |
| Result summary | 4 KiB |
| Artifacts per message/result | 8 |
| Unacknowledged inbox backlog | 32 |
| Messages per room / ordered pair | 256 / 16 |
| Reply hops | 6 |
| Default / maximum message TTL | 10 min / 60 min |
| Page size | 50 (maximum 500) |
| Job lease / attempts | 30 sec / 2 |

Budgets narrow down the delegation tree. Outstanding child token and cost
reservations reduce what a parent can allocate; actual usage is charged to the
child and each ancestor. Concurrency is enforced at job claim time and includes
the root task. `OpenRoomInput.delegation_pool` reserves part of the task
envelope for descendants, and `RoomView.coordinator_runtime_budget` provides
the remainder for the host's coordinator runtime. Delegated children can
reserve their own `delegation_pool_tokens` and `delegation_pool_usd`.

## Error codes

`invalid_input`, `forbidden`, `not_found`, `conflict`, `stale_revision`,
`stale_base`, `backpressure`, `budget_exceeded`, `limit_exceeded`,
`loop_limit`, `expired`, `cancelled`, `lease_lost`, `usage_unaccounted`,
`single_agent`, `write_conflict`, `unsafe_content`, `recursive_delegation`,
`unknown_cursor`, `closed`, and `corrupt_record`.

Error messages are generic and must not include host paths, tokens, or journal
content. Validation and identity failures are fail-closed.
The OMP adapter maps non-collaboration failures while opening
`openRuntimeSession` to `invalid_input`; opening makes no model request, so
these pre-run failures accrue zero usage. `forbidden` and `invalid_input` from
`adapter.start` before it returns a `ChildRun` are also zero-usage failures.
Failures after a `ChildRun` exists use reported usage or fail closed when usage
cannot be reconciled.

## Verification status

Follow-up verification passed: the collaboration suite passed three consecutive
runs (31 tests each), and typecheck, package Biome, package build, and root
`bun run check` passed. The limitations listed in
`documentation/COLLABORATION.md` remain unverified.
A fake adapter can test orchestration without network or model calls. The OMP
adapter's injected `runtimeFactory` is the test seam for an offline runtime
fixture.
