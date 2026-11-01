# Local workbench RPC transport

`@mars/workbench` provides `serveWorkbench({ api, token, port? })`. `api` implements the exported `WorkbenchOperations` interface. This package is the HTTP boundary, **not** a task runner: it does not open a database, create workspaces, approve integrations, or start a second agent loop. The durable-task/workspace/Oh My Pi host adapter and CLI startup remain separate integration work.

The server binds only `127.0.0.1` (default port 7331, `0` selects an ephemeral port). Supply a cryptographically random, URL-safe bearer token of 32–256 characters from host-owned state, outside any agent workspace. Length validation does not establish entropy. Never put the token in a workspace file, query string, or log. There is no unauthenticated health route.

Only `POST /v1/rpc` with `Content-Type: application/json` and `Authorization: Bearer <token>` is accepted. Browser-origin requests, non-loopback Host headers, query strings, redirects, and other routes are not supported. Requests are limited to 512 KiB and responses to 4 MiB; there is no chunked artifact API yet. Errors use fixed messages rather than propagating provider, filesystem, or validation details. Responses use `Cache-Control: no-store` and do not enable CORS.

The frozen VS Code wire methods are:

```text
workbench.describe
tasks.create / tasks.list / tasks.inspect
tasks.start / tasks.resume / tasks.steer / tasks.cancel
tasks.events / tasks.artifact / tasks.diff
tasks.checkpoint / tasks.restore
```

Except for `workbench.describe`, every request includes a strict `context` with `schema_version: 1`, the exact host-bound owner/project/workspace scope, and a bounded `request_id`. `tasks.create` only accepts a fresh pending task with revision 0, no artifacts, and no specialist revision. Start accepts explicit read/write/execute approvals and an optional model ID; expected revisions protect start, resume, and restore operations. The host adapter must enforce the same scope, resource ownership, revisions, budgets, idempotency, and permissions at the service layer. Metadata approval is not an OS sandbox.

Responses have exactly one `result` key; steering/cancellation return `null`. Failures have one `error` with `code` and a fixed `message`. Task-store revision/transition conflicts become HTTP 409 with `code: "conflict"`, which the existing VS Code client recognizes. The transport validates result schemas, task/event identities and scopes, and duplicate list/cursor entries before serialization. Artifact ownership, bytes/hash verification, workspace identity, and safe diff generation remain mandatory responsibilities of the host adapter; the IDE client independently checks received artifacts and paths.

Tests run a real loopback server with fake operation callbacks. They include the actual VS Code `MarsClient` and `HttpRpcTransport` calling every method, plus authentication, scope, request/result validation, error sanitization, and size-limit checks. These tests do **not** demonstrate live task execution, SDK/workspace wiring, a VS Code Extension Host, or Milestone 1 completion. No model requests or third-party integration loads are made.
