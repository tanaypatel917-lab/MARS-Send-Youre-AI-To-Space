# Collaboration package

`@mars/collaboration` provides bounded delegation, directed agent messaging,
lease-based child execution, and reviewable result proposals. It is a
coordination layer—not another execution engine.

## Design rationale

The package borrows coordination patterns, not implementation internals:

- [Factory Droids](https://www.factory.ai/product/droids) motivates fresh,
  bounded work contexts, model inheritance or host-controlled override,
  enforced tool boundaries, background execution and resume, and passing task
  complexity to an external model-selection policy.
- [Devin Fusion](https://devin.ai/blog/devin-fusion) illustrates a lead that
  plans and reviews while implementation can be delegated to sidekicks, with
  one user-facing owner.
- [Oh My Pi](https://github.com/can1357/oh-my-pi) informs the bounded task-tool
  model: a shallow depth cap, concurrency limits, isolated work, and messaging
  restricted to parent/child relationships unless explicitly permitted.

These are product-level analogies. This package does not copy their private
internals, grant authority based on a role name, or make a claim about measured
quality improvement.

## Ownership boundaries

| Concern | Owner |
| --- | --- |
| Live sessions, model calls, tools, and canonical conversation journal | Oh My Pi through `@mars/execution` |
| Delegation graph, capabilities, budgets, messages, leases, and result proposals | `@mars/collaboration` |
| Workspace creation, snapshots, and diff/application | Host workspace provider |
| Durable task lifecycle and task usage events | `@mars/tasks` |
| Model selection | Injected `ModelSelectionPolicy`; a future router may provide it |
| Accepting/applying code or memory/skill changes | Host review flows and their owning services |

The collaboration database is SQLite in WAL mode and is scoped to one
host-private `rootDir`. It stores hashed capability tokens and coordination
records, never plaintext tokens, transcripts, tool output, or journal contents.
Session references are private lease metadata in the jobs table and are not
included in agent or host view objects. Room and agent views expose no database
paths.

Delegation is bounded by the caller's stored authority, room and host limits,
remaining token/cost budget, deadlines, and write-path claims. A role label such
as `worker` is metadata only. A child cannot gain approvals, paid-model
permission, or delegation authority that its parent does not possess.

Each member's envelope is split into an own-runtime allowance and a
delegation pool. `OpenRoomInput.delegation_pool` reserves part of the task
budget for descendants, and `RoomView.coordinator_runtime_budget` is the
remainder. **The host must launch the coordinator's own runtime with
`room.coordinator_runtime_budget`, not `task.budget`.** This is what keeps the
coordinator plus all child runtimes within the task envelope. A delegated
member may similarly reserve `delegation_pool_tokens` and
`delegation_pool_usd`; its runner receives only the envelope minus that pool
and its own prior runtime charges.

Messages are directed to named active members. Parent/child relationships and
explicit peer grants define the normal address set; a valid reply path can
authorize a response. Inbox bodies are bounded, expiring, and marked untrusted.
Messages do not grant permissions or override instructions.

The host reviews child summaries and artifact references. Accepting a result
does not apply a patch, write memory, or publish a skill. The workspace or
service owner performs any follow-up action.

## Parent wiring guide

1. **Create and recover host state.** Place the store under a private state
   root, for example `<stateRoot>/collaboration`. At process startup, create
   the collaboration instance, call `runner.recover()`, then call `runner.tick()`
   on a host-controlled interval. When opening the room, choose its
   `delegation_pool`; launch the coordinator's own `openRuntimeSession` with
   `room.coordinator_runtime_budget` rather than the full task budget. Shut
   down the runner before closing the collaboration store.
2. **Bind agent tools in the host.** Expose selected `AgentPort` methods as
   Oh My Pi custom tools such as `mars_delegate`, `mars_message`, `mars_inbox`,
   `mars_ack`, `mars_results`, `mars_review_result`, and `mars_cancel_child`.
   Extending `openRuntimeSession` with those tools is parent-owned integration
   work; it is not done by this package. Capture each capability in a trusted
   host closure, never in model-visible tool arguments or results.
3. **Keep RPC views narrow.** Workbench or VS Code RPC may expose
   `inspectRoom`, `stats`, selected member information, and reviewable results.
   Never expose `host.jobs`, bearer capabilities, `session_ref`, journal paths,
   or internal state-root paths over RPC.
4. **Provide child workspaces.** Implement `workspaceFor(launch)` with the
   host's workspace provider, such as `@mars/workspaces` preparation for
   `child_task_id` and its workspace path. A read-only child must receive
   read-only tools; `write` and `execute` must fail closed. Writable children
   must be constrained to their claimed paths.
5. **Review through owning services.** Accepted artifacts remain proposals.
   Apply diffs through workspace/diff owners; send memory or skill proposals
   through their service-specific review flows.
6. **Inject routing policy.** Supply a `ModelSelectionPolicy` that consumes
   role, complexity, solution-space hints, parent model, paid consent, and
   depth. The default policy inherits the parent model. A separate router can
   be integrated when it exists; this package does not implement routing.
7. **Publish usage deltas.** Translate newly accounted child usage into
   deltas for `@mars/tasks` `appendEvent`; do not publish cumulative totals as
   repeated increments.

## Operational properties

- The SQLite store uses WAL, full synchronous writes, foreign keys, and
  immediate transactions for state changes. It is a single-host coordination
  store, not a distributed lock service.
- Each child job has an owner and monotonically increasing lease epoch.
  Heartbeat and finalization are fenced by owner and epoch. On recovery, a
  journal's cumulative usage is reconciled and only the uncharged delta is
  applied. If usage cannot be read, the runner fails closed and consumes the
  outstanding reservation.
- `tick()` claims only jobs that fit room concurrency. Queued jobs remain
  queued until a slot is available. `shutdown()` stops claiming, requests
  cancellation for local jobs, and waits for finalization where possible.
- OMP child state is private and outside the workspace. The adapter checks
  persisted task/model/budget bindings on resume and reads only the bounded
  budget custom entry when reconciling usage.
- `assertPublishable` rejects secret-like values and host-private paths from
  message bodies, instructions, role labels, and published summaries. Unsafe
  child summaries are stored as empty with an `unsafe_summary` marker so
  accounting can still complete.
- Non-collaboration errors while opening `openRuntimeSession` map to
  `invalid_input`; opening does not make a model request, so that pre-run
  failure accrues zero usage. `forbidden` and `invalid_input` from
  `adapter.start` before a `ChildRun` is returned are also zero-usage
  failures. Once a `ChildRun` exists, failures use its reported usage or fail
  closed if usage cannot be reconciled.
- Results are marked stale when the source task revision changes. Acceptance
  also checks the expected task revision and, where present, the current
  workspace base revision.
- Child artifact references pass the same `assertPublishable` check as
  message artifacts. Unsafe or malformed references are dropped and counted in
  the result's `unsafe_artifacts` field.
- A closed room (after drain or cancel) still allows read-only calls and
  `reviewResult`, so the parent can review proposals produced during a drain.
  `send` and `delegate` fail with `closed`.
- Reservations stay held for active descendants: when a member ends before its
  own children, its orphaned descendants are cancelled and its envelope is
  released only up to the part they still hold; each descendant releases its
  own part when its job ends, through any ancestors that have already ended.
- Adapters report `steps` per attempt; the runner adds the steps charged by
  earlier attempts, launches retries with the remaining allowance, and fails a
  retry with no steps left before the adapter starts. A retry that resumes a
  journal reuses the persisted model instead of re-running the model policy,
  so the runtime binding stays valid.

## Not verified

- No live model call, paid service, or network-dependent model test has been
  run as part of this package's deterministic suite.
- No real multi-host deployment, distributed coordination, or concurrent
  process stress test has been verified. SQLite coordination is single-host.
- No UI/RPC integration, production parent wiring, or measured quality
  improvement is verified. Oh My Pi custom-tool wiring remains parent-owned and
  is not implemented here.
- Reconciled step counts are derived from journal assistant messages and are
  approximate; usage totals come from the persisted execution budget ledger.
- PID reuse and host clock skew are not handled by the lease design.
- Workspace preparation and accepted-result application are host-owned
  integrations and are not verified by this package.
