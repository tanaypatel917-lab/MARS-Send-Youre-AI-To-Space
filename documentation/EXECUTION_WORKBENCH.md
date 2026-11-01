# Coding-workbench execution boundary

`@mars/execution` exposes `openRuntimeSession` for the task API. Oh My Pi remains the only agent loop, tool dispatcher and conversation writer. This is a library integration, not a complete workbench or Milestone 1 acceptance claim.

## Integration

The caller supplies a validated task, a private workspace directory, a protected state directory **outside** the workspace, the existing MARS model registry, explicit read/write/execute approvals and `RuntimeTools`. The task API must authenticate the caller, serialize runs for a task, enforce its scope/revision and provide the workspace implementation. The callback methods are a trusted host boundary, not a sandbox. Never supply unrestricted host filesystem or shell callbacks in production.

Only approved `mars_read`, `mars_write` and `mars_execute` tools are registered. Ambient tools, extensions, project instructions, MCP, LSP, IRC, custom-tool discovery, prompt-cache warming, title generation and automatic model substitution are disabled. The active tool set is verified after initialization. The workspace provider must enforce path confinement and secret exclusions independently, and execute commands in its verified no-network container boundary. There is no host-shell fallback in this package.

Automatic model selection uses an available tool-capable model in the configured default route and skips paid models even if the user's registry permits paid routing. Explicit paid selection requires `allowPaid` and known input/output prices. The selected model is pinned to the persisted session: model changes require a new task/session rather than silently substituting providers on resume. This first execution bridge supports text and function tools, not images or portable reasoning blocks.

## Persistence and recovery

Keep `journalPath` and `sessionId` in the task service's protected runtime reference. Resume by supplying that same journal path; it must reside under the runtime state directory. The journal binding checks task/session/scope, workspace, model and unchanged budget. Oh My Pi's original journal is the authoritative conversation. Task event adapters should store `RuntimeObservation` journal/entry references and lifecycle metadata, not become another conversation writer. Stream observations do not assert an entry has already been committed; consumers reconcile against the journal after `run` returns and flush completes.

Recovery rejects a missing or invalid persisted budget rather than replenishing the allowance, and closes the reopened journal on validation failure. Cancellation still flushes the journal if stopping a workspace fails. Disposal independently attempts workspace stop, SDK disposal, provider unregistration and auth release before reporting a sanitized cleanup failure. Provider dispatch defaults to the registry's environment, limited to the selected provider's credential reference; callers do not need to repeat credentials in runtime options.

`mars.budget` journal entries reserve an allowance before every model dispatch and settle only after a successful stream. Failed/ambiguous requests retain their reservation. The original wall-clock deadline survives restart; resume does not refill the budget. Serialized transport UTF-8 bytes plus overhead provide a conservative input allowance, not an exact tokenizer measurement. Output is provider-limited using `maxTokens`; missing usage retains the full reserved output allowance. Unexpected reported usage fails the run instead of being silently accepted. This accounting is not an independently verified provider invoice or a guarantee that a third-party service honors its declared price/token limits.

Cancellation aborts the provider transport and asks the workspace provider to stop its process tree. A cancelled controller cannot dispatch another run; reopening its durable task/session is a separate, policy-controlled operation. Observation persistence failure prevents subsequent model/tool dispatch. A `completed` outcome means the agent returned normally, **not** that independent acceptance tests passed. The task service must expose checks actually run and remaining unverified criteria separately.

## Verification

Run `bun test packages/execution/src/runtime.test.ts` and `bun run check`. The runtime tests embed the actual Oh My Pi SDK while substituting provider HTTP responses with injected fixtures and dummy keys. They are not live-provider, real-model coding-task or full task-service restart acceptance evidence. The existing smoke continues to make zero model requests. The shared API, durable task service, isolated workspace provider and VS Code client must be integrated and tested together before Milestone 1 is declared complete.
