# @mars/research

`@mars/research` is a durable, scoped control plane for research requests and evidence-backed findings. It stores requests, leases, usage, evidence provenance, findings, and an optional task-event outbox in a hardened SQLite database. It does not fetch sources or invoke models.

## API

Create the service with a `rootDir`, a `ResearchTaskReader`, an artifact store, and a `ResearchWorker`. The returned service implements the contracts `ResearchService` methods and adds `inspect`, `list`, `readFindings`, `markUsed`, `reconcileTask`, `pump`, and `close`. Worker input intentionally omits caller scope, request context, and filesystem paths. Worker writes are guarded by the durable request lease and abort signal.

## Persistence and enforcement

Requests and findings survive restarts in `research.sqlite`. SQLite transactions use immediate locking; lease ownership, retries, idempotency, deadlines, active-request backpressure, and per-instance worker concurrency are enforced. Token and USD limits are enforced only against usage reported by a worker; usage the worker does not report cannot be enforced. `ResearchJob.enforcement` identifies this distinction.

Workers report each usage delta through `reportUsage`. Evidence is stored through the configured artifact store, and finding records refer to those captured artifacts. The optional event sink is an outbox: event failures are retained as pending and retried on later pumps.

## Citations and privacy

Citation URLs are validated as HTTP(S) provenance labels only. The service performs no DNS lookup, URL retrieval, or network request. A capture records the URL, retrieval timestamp, media type, and artifact reference; it does not establish that a claim is true. Findings may cite only evidence captured for that same scoped request.

Inputs and captured text are checked against configured private paths and the research-store path. Store directories and database files are restricted to owner-only permissions. Never expose `rootDir` or stored scope over RPC; methods should receive the caller's `RequestContext`.

## Parent wiring hooks

- Construct with `tasks: taskStore`, `artifacts: taskStore.artifacts`, and `events: taskStore` using the workbench's shared `DurableTaskStore`.
- Call `reconcileTask` after each task revision change (update, steer, or resume) and before presenting findings.
- Call `markUsed` when a worker actually consumes a finding (for example, when the research panel records it as used).
- Register `close()` through `registerRuntimeCleanup` from `@mars/execution` in the host.
- Map RPC methods one-to-one to service methods while supplying the caller's context.

## Live dispatch status

No live research or browser worker is available. Live research dispatch is unwired: this package ships no worker that talks to models or networks, and it performs no URL fetching. A production worker belongs in the parent on top of the Oh My Pi runtime, using `openRuntimeSession` with approvals `{ read: true, write: false, execute: false }`; evidence capture requires a future approved read-only retrieval tool.

## Known gaps

- There is no production worker or approved live evidence-retrieval tool.
- Token and USD ceilings depend on truthful worker-reported usage.
- Citation capture records provenance, not source authenticity or truth.
- Parent lifecycle wiring, task-revision reconciliation, and RPC privacy boundaries remain the host's responsibility.
