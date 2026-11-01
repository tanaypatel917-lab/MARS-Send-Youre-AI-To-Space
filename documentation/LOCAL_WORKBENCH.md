# Local coding workbench

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

Session journal paths and launch metadata are host-only. Public events, artifacts and diffs are checked for private paths; unsafe legacy stored data is refused on reads, not rewritten or deleted. RPC authenticates every request, requires exact scope, rejects browser Origins, bounds payloads and sanitizes errors. This local endpoint is not a deployment-grade remote gateway.

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

No live model request, paid service or real VS Code window is used for this verification. Real IDE interaction, live-model task quality and the complete master-spec Milestone 1 acceptance evidence remain outstanding. Memory, research, skills, independent evaluation and training are outside this increment. A normal agent completion status does not claim independent acceptance tests passed.
