# Local coding workbench

## Saved context and journal recall

The local service owns one `@mars/memory` store under its private state directory.
It does not add a model loop, transcript writer, or third-party integration.
With read approval, new sessions receive a bounded, scope-checked snapshot of
saved facts, labeled as untrusted evidence. Whole entries are omitted rather than
truncating the user's request, exceeding the runtime instruction limit, or
consuming the serialized-request room the model bridge reserves against the
selected model's context window and the task token budget (system prompt,
declared tools, instruction, slack and a minimum output reserve). The
exact scope, revision, frozen text and digest are saved privately with the launch;
resume retains the original Oh My Pi conversation, not a fresh memory snapshot.

After a runtime outcome, the host projects records supplied by the authoritative
Oh My Pi SessionManager into the derived journal index. The memory adapter never
receives a journal path. The read-only `mars_history` tool returns up to five
bounded excerpts with session/entry citations from the authenticated scope; each
excerpt is positioned around the earliest matched query term and reports
whether text was cut before or after it.
Results are live keyword matches, not semantic search or verified facts. Without
read approval, neither saved facts nor the history tool are provided. Projection
failures produce a sanitized task event without changing a completed coding
outcome into failure.

This does not expose memory mutation, profile deletion, dataset registration or
automatic fact acceptance to models or RPC clients. Those still require separate
host-side provenance and approval controls. Stores in different workbench state
directories do not share recall. Deleting memory does not rewrite existing Oh My
Pi journals, frozen launch context, or already-running model context. Format-1
memory stores are rejected without modification; no automatic migration exists.

The development service composes the durable task store, concrete isolated workspace provider, existing model registry and Oh My Pi host adapter behind authenticated loopback RPC. Oh My Pi owns the only model/tool/session loop and original conversation journal. The task store owns lifecycle state, events and immutable artifacts. The provider owns the private filesystem copy, diffs and transactional checkpoints.

## Start and connect

After the root setup, configure a tool-capable model using the existing `models` commands and provide its credential in the named environment variable. Startup loads configuration but makes no model/provider request. Project configuration stays untrusted unless explicitly enabled; free-only automatic selection does not fall back to paid or unknown-price models.

```sh
bun apps/cli/src/main.ts serve --source /absolute/path/to/project
```

Supported flags: `--source`, `--state`, `--port`, `--owner`, `--project`, `--image`, `--trust-project`, `--help`. Defaults: current source directory, owner `local`, stable project id derived from the canonical source path, state `~/.mars/workbench/<project-id>`, port `7331`. Port `0` selects an ephemeral port. Source and state roots must not contain one another. Do not put private state inside the project.

The single startup JSON line reports the loopback URL, connection-file path and whether execution is enabled. It never prints the bearer token. Private state is mode 0700; `connection.json` is mode 0600. Each service start rotates its strong bearer token. Old connection files must be reimported after restart. The file contains `{schema_version:1,url,token,scope:{owner_id,project_id}}` and must stay outside any agent workspace.

Build and launch the [VS Code extension](../apps/vscode/README.md), then use **MARS: Import local connection file** to select that file, followed by **MARS: Connect**. Only the token goes to SecretStorage; only the endpoint goes to global user settings. A task executes in the server's private copy, not your open checkout. Diffs are read-only; applying task output back into your source remains manual.

## Optional command execution

Without `--image`, read/write tasks are available but command execution is disabled. With `--image REPO@sha256:DIGEST`, the configured image must already be present locally and Docker must verify successfully; there is no automatic image pull or host-shell fallback. Use an image with the runtimes needed by the project. Task-specific execute approval is also required.

The provider runs commands non-root, without network, with read-only container root, dropped capabilities and bounded resources. Only the private workspace is mounted. Workspace content is untrusted and must never be executed by host-side integrations. Source secret files are excluded from the initial copy; model/provider credentials remain in the host credential environment, never in the task copy. Permission metadata is not itself a sandbox. See [provider boundaries](../packages/workspaces/README.md).

## Recovery and privacy

Start/resume require exact revisions and saved task/workspace/model/approval identity. Resume reopens the same workspace and original private SDK journal; missing or corrupt state fails closed, never recreating from source. Checkpoints and artifacts are task-owned. Restore is refused while a task is running. Keep state intact for recovery, including unresolved restore backup/journal directories.

SIGINT/SIGTERM shutdown joins the upstream SDK cleanup registry, which waits for the host to pause active tasks, abort requests, drain jobs and close the provider/store. Oh My Pi retains its standard signal exit codes (130/143), including after clean shutdown. A process crash is recovered on the next open. Restart does not refill runtime budgets or extend their saved deadline.

Starting without an eligible configured model leaves the task pending, with no workspace or runtime created. Configure the model/credential and retry. Steering while paused is stored in durable task events, included in the next resume prompt, and acknowledged after that runtime returns. Pending steering survives a service restart; an interrupted delivery can be replayed (at-least-once delivery). Running steering still goes directly to the live runtime. Lifecycle requests for one task are serialized so paused steering cannot slip past a concurrent resume.

Resume uses the saved journal for the original request and includes whole queued instructions in FIFO batches within the runtime's 128-Ki-character prompt limit. Only the delivered batch is acknowledged. If more steering remains after a completed runtime result, the task stays paused; resume again to deliver the next batch. Nothing is truncated or silently discarded. A legacy instruction that cannot fit even alone returns `too_large` before changing the task revision/status or opening a runtime, leaving its queue intact.

Runtime-result events publish token deltas against previously reported journal totals, preventing double counting after resume, including cancellation outcomes. Cost is zero for a configured free model and unknown otherwise: reserved budget dollars are not measured billing and are never presented as actual cost.

Session journal paths and launch metadata are host-only. Public events, artifacts and diffs are checked for private paths; unsafe legacy stored data is refused on reads, not rewritten or deleted. RPC authenticates every request, requires exact scope, rejects browser Origins, bounds payloads and sanitizes errors. This local endpoint is not a deployment-grade remote gateway.

Initial startup also checks the complete request plus formatted acceptance criteria against the same runtime limit (JavaScript string length). An oversized initial instruction returns `too_large` before selecting a model, changing the task revision/status, preparing a workspace, or opening a runtime. The pending task remains intact; neither its request nor its acceptance criteria are truncated.

Missing-model start/resume failures return the stable `model_unavailable` RPC code with credential/model configuration guidance, never provider details or host paths. Startup remains pending; a saved session remains paused until the same configured model is available again. Automatic selection remains free-only; this error does not authorize paid fallback.

## Frozen repository context

Read-approved tasks receive a bounded repository map from their private workspace at launch, after frozen memory context. `@mars/context` supplies definitions and relative paths; this is untrusted evidence, not instructions or permission to use tools. The request is capped at 4,096 conservative tokens and reduced to fit both the remaining runtime character budget and the model-context capacity left after frozen memory (the same selected-model/task-budget reservation that bounds saved facts). Full prompts and read-denied tasks do not request a map. Secret/ignored/private/generated files are excluded by the provider; host-private paths in returned text cause the entire map to be omitted.

The service uses fd-anchored Linux confinement only, with root/revision revalidation after scanning. It never falls back to the weaker best-effort mode. If confinement is unavailable or mapping fails, execution proceeds without a map and emits only a sanitized best-effort diagnostic. No error details or paths reach the model or RPC.

The exact text, digest, scope and initial workspace revision are persisted in private launch metadata. Resume validates that binding and uses the original Oh My Pi journal; it neither rebuilds the map nor silently injects changed repository content. The launch map may be stale after edits. Models can read current files through approved tools; there is no repository-map tool, unsaved-editor-buffer capture, or claim of semantic completeness/quality improvement.

## Specialist routing

When the service is configured with an evidence-gated specialist router (`@mars/specialists`), each `start` without an explicit `model_id` routes the task once, as a `worker` for the configured task-coverage domain, before selecting a model, preparing a workspace or opening a runtime. The decision (`decision_id`, outcome, selected ref and model) is frozen into private launch metadata; a specialist outcome also records `Task.specialist_revision` in the same revision step that marks the task running. The selected model stays pinned for the session and all resumes; there are no route hops. Baseline, unavailable and rejected outcomes fall back to the ordinary free-only default, and a routing failure leaves the task pending with `unavailable`. Routing selects a model only; the host must actually serve any adapter the specialist declares, and a routed specialist is not a quality claim beyond the signed evidence the registry verified.

## Collaboration rooms

When the service is configured with `@mars/collaboration` (`collaboration: { host, agents }`), each `start` opens one task-scoped room after the task is marked running and before a workspace or runtime exists. The room's root authority is exactly the launch approvals with `allow_delegation: false` and `paid_consent: false`, so a room never grants more than the session itself was approved for; the Oh My Pi session runs under `room.coordinator_runtime_budget` rather than the raw task budget. The room id, coordinator capability and budget are frozen into private launch metadata and reused on resume. The coordinator gets four host-bound tools (`mars_send`, `mars_inbox`, `mars_ack`, `mars_members`); the capability token stays host-side and inbox text is rendered as untrusted evidence. A room-open failure fails the task with `unavailable`. Pausing keeps the room open; completion drains it, and cancellation or failure cancels it. Because the room tools are always declared, a collaboration session requires a tool-capable model even when no file approval is granted; specialist routing advertises the same requirement. Cancelling a running or paused task, a launch that fails after the room opened, and tasks recovered as interrupted all cancel their room. 

### Delegation and child runners

With `collaboration.delegation` configured (`{ pool: { max_tokens, max_usd? }, adapter?, tickMs? }`) the room opens with `allow_delegation: true` and the given delegation pool, and the coordinator gains five more host-bound tools: `mars_delegate`, `mars_cancel_child`, `mars_children`, `mars_results` and `mars_review_result`. Children are bounded by construction: omitted child approvals default to read-as-the-coordinator with write and execute off, anything beyond the parent's own approvals fails with `forbidden`, `paid_models` and `may_delegate` are always false, and every child carries its own token/duration/step/message budget drawn from the pool. The host runs children through `createChildRunner` with the Oh My Pi child adapter (`createOhMyPiChildAdapter`); `runner.recover()` runs at startup, `runner.tick()` runs on `tickMs` (default 1 s) and right after each `mars_delegate`, and `runner.shutdown()` runs before the service closes. Each child gets a separate workspace prepared by the same workspace provider under its own child task id and prepared under the child task id (or a stable `child.<sha256>` alias when the suffixed id exceeds the workspace provider's 128-character limit) and seeded once with the coordinator's current changes (the coordinator workspace's `diff` is replayed into the child, executable bits included; a deleted file makes the child launch fail with `unavailable`; a retried attempt reopens the child's own tree without re-seeding), so children see the coordinator's work rather than the source checkout. The proposal's `base_revision` is the coordinator revision the child was seeded from, recorded privately under the host state root, and `mars_review_result` compares it with the coordinator workspace's live revision at review time. Without write authority the collaboration package confines a child to `read_only` and its runtime tools fail closed for write and execute; a writable child that claims `write_paths` may write only at or under those paths, spelled canonically (no `./`, `..`, doubled or trailing separators), and may not execute at all, because execution cannot be confined to paths. Child runtime state stays under the host's private collaboration root, never inside a workspace. Adapters must report usage for a finished child: an outcome without usage is charged as the child's full remaining budget and recorded as failed.

When a specialist registry is configured, each child is routed through it like a launch (role `worker`, the workbench domain, `paid_consent: false`, a minimum context derived from the child's own instruction, approvals and room tools); a verified specialist is pinned only when it is free and tool-capable, every other outcome uses the free tool-capable default. Each child attempt's outcome is mirrored into the parent task's events as a `tool.completed` / `child.result` record (child and agent ids, role, attempt, status, model, routing decision) carrying the delta of the collaboration store's charged usage over what earlier events recorded (sweeps run per task in series, after each attempt, when the room closes and when a restarted host reattaches to the room, so recovery charges are mirrored too and overlapping attempts are never counted twice); the collaboration store remains authoritative for budgets.

Child results are proposals: `mars_results` renders each one with its status, outcome, task revision, base revision and artifact count, with the summary between `untrusted summary` markers; a review passes `decision` plus `expected_task_revision` (the current room revision is printed at the top of `mars_results`) and the host supplies the coordinator's current workspace revision, so a proposal against an older base fails with `stale_base`. Accepting a result never applies a patch, writes memory or publishes a skill. Steering a task revises its room: the room's task revision advances (the durable task revision does not), proposed results become `stale`, live children are cancelled, and the coordinator receives a fresh capability that replaces the frozen one in launch metadata and in the live tools, so the model never sees a token at any point. A room whose children are still running drains rather than closes when the coordinator finishes. Children never inherit the coordinator's model: the host's model policy picks the registry's free, tool-capable default for every child, so a coordinator on a paid model can still delegate; routing children through the specialist registry is not wired by this increment.

## Reproducible verification and limits

```sh
bun run check
bun run --cwd apps/vscode typecheck
bun run --cwd apps/vscode smoke

# Optional real-container coverage; pre-pull this exact test image yourself.
MARS_WORKSPACES_DOCKER_TEST=1 \
MARS_WORKSPACES_TEST_IMAGE=mirror.gcr.io/library/busybox@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec \
bun test packages/workbench/src/service.test.ts packages/workspaces
```

The service tests send authenticated HTTP through the actual VS Code typed client and actual Oh My Pi SDK, using injected model HTTP responses and dummy keys. They cover private file writes, progress/artifact/diff retrieval, checkpoint/restore, source immutability, shutdown/restart with the same journal/workspace, steering, cancellation and token rotation. The optional Docker flow has the SDK write a file and invoke a real sandbox command that verifies its contents and non-root identity. CLI tests cover private connection credentials, no-credential startup, sanitized failures and signal cleanup releasing the provider lock. These tests demonstrate harness integration, **not model quality**.

No live model request, paid service or real VS Code window is used for this verification. Live-model task quality and the complete master-spec Milestone 1 acceptance evidence remain outstanding. Frozen memory, journal recall, repository maps, evidence-gated specialist routing and single-agent collaboration rooms are connected; live research, specialist routing for child models, learned skills, independent evaluation and training are not connected by this increment. Delegation is verified only with a fixture child adapter; no child Oh My Pi session ran against a live model. A normal agent completion status does not claim independent acceptance tests passed.
