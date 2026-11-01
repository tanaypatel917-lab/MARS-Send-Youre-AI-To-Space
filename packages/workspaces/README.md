# `@mars/workspaces`

`@mars/workspaces` implements the `ExecutionProvider` contract with isolated, local task workspaces. A provider copies a fixed source tree into a private workspace, records content-addressed checkpoints, and permits command execution only after explicit approval and sandbox verification.

## API

```ts
import {
  createDockerSandbox,
  createInMemoryArtifactStore,
  createLocalWorkspaceProvider,
  type ArtifactStore,
  type ArtifactRef,
  type Budget,
  type CheckpointRef,
  type CommandApprover,
  type LocalExecutionResult,
  type LocalWorkspaceProvider,
  type LocalWorkspaceProviderOptions,
  type RequestContext,
  type SandboxRunner,
  type WorkspaceDiff,
  type WorkspaceLimits,
  type WorkspaceRef,
} from "@mars/workspaces";
```

The provider implements `ExecutionProvider` and adds these methods:

```ts
createLocalWorkspaceProvider(options: LocalWorkspaceProviderOptions):
  Promise<LocalWorkspaceProvider>;

provider.prepare(context: RequestContext, taskId: string): Promise<WorkspaceRef>;
provider.read(context: RequestContext, workspace: WorkspaceRef, relativePath: string):
  Promise<ArtifactRef>;
provider.write(context: RequestContext, workspace: WorkspaceRef, relativePath: string,
  artifact: ArtifactRef, options?: { executable?: boolean }): Promise<void>;
provider.execute(context: RequestContext, workspace: WorkspaceRef, argv: readonly string[],
  budget: Budget, options?: { signal?: AbortSignal }): Promise<LocalExecutionResult>;
provider.checkpoint(context: RequestContext, workspace: WorkspaceRef): Promise<CheckpointRef>;
provider.restore(context: RequestContext, checkpoint: CheckpointRef, expectedRevision: string):
  Promise<WorkspaceRef>;
provider.diff(context: RequestContext, workspace: WorkspaceRef,
  options?: { base?: CheckpointRef }): Promise<WorkspaceDiff>;
provider.collect(context: RequestContext, workspace: WorkspaceRef): Promise<ArtifactRef[]>;
provider.discover(context: RequestContext, taskId: string): Promise<WorkspaceRef | null>;
provider.inspect(context: RequestContext, workspaceId: string): Promise<WorkspaceRef>;
provider.workspacePath(context: RequestContext, workspace: WorkspaceRef): Promise<string>;
provider.checkpoints(context: RequestContext, workspace: WorkspaceRef): Promise<CheckpointRef[]>;
provider.skipped(context: RequestContext, workspace: WorkspaceRef):
  Promise<Array<{ path: string; reason: "symlink" | "special" | "ignored-secret" }>>;
provider.stop(context: RequestContext, workspace: WorkspaceRef): Promise<void>;
provider.close(): Promise<void>;
```

`ArtifactStore` provides asynchronous `put(context, bytes, mediaType)` and `get(context, ref)` operations. Returned references are checked against the bytes' SHA-256 and length. `createInMemoryArtifactStore()` is a development/test store, not durable storage.

`workspacePath()` is a **host-only integration seam**. It validates workspace ownership and returns the real path to the private workspace tree, suitable for passing as `cwd` to the execution runtime's `openRuntimeSession`. Never send this path over RPC or expose it to a model. It is not the source tree or provider metadata.

`rootDir` and `sourceRoot` must be absolute, non-overlapping real paths. The provider makes `rootDir` private, leaves `sourceRoot` untouched, and uses the default provider id `mars-local-workspace` unless `providerId` is supplied.

Commands are argv arrays; shell interpretation only occurs when an explicitly approved command launches a shell. `approveCommand` is mandatory for execution. A missing approver rejects every command with `CommandNotApprovedError`. A missing sandbox or failed sandbox verification rejects execution with `SandboxUnavailableError`; commands are never run on the host as a fallback.

`createDockerSandbox({ image, ... })` requires a digest-pinned image and uses only fixed Docker hardening options. `buildDockerRunArgs(resolved, request, name)` is exported as a pure helper for inspection and testing. The injected `SandboxRunner` interface is intended for controlled tests and specialized local deployments; a stub runner is not isolation evidence.

## Limits

Default `WorkspaceLimits`:

| Limit | Default |
| --- | ---: |
| Files | 20,000 |
| Individual file size | 10 MiB |
| Total checkpoint tree content | 256 MiB |
| Relative path length | 1,024 UTF-8 bytes |
| Relative path depth | 64 |
| Checkpoint manifest | 16 MiB |
| Captured stdout and stderr, each | 1 MiB |
| Execution duration | 120 seconds |

Docker defaults add a non-root host uid/gid, 512 MiB memory (and equal swap), 128 pids, one CPU, 64 MiB `/tmp`, a 10 MiB per-file `fsize` ulimit, no network, read-only container root, all capabilities dropped, `no-new-privileges`, and a 1024 descriptor limit. The workspace bind mount is the only writable host directory exposed to the container.

The tree file-count and total-byte limits are checked while copying, writing, checkpointing, and restoring. Execution itself can create an over-limit tree; its post-run scan updates the revision, and a later checkpoint or write rejects an over-limit tree. There is **no per-workspace disk quota**: `fsize` limits one file, not the sum of files, so a command can consume disk before the post-run scan notices. Operators should use a volume/filesystem quota when that risk is unacceptable.

## Filtering and path policy

The same path filter is used when preparing, reading, writing, checkpointing, diffing, hashing, and validating a restore. Filtering is by path segment:

- Ignored segments: `.git`, `.hg`, `.svn`, `.mars`, `node_modules`, `.venv`, `venv`, `__pycache__`, `.pytest_cache`, `.mypy_cache`, `.tox`, `.gradle`, and `.terraform`. Ignored directories are not traversed.
- Secret files: `.env` and `.env.*` other than `.env.example`, `.env.sample`, and `.env.template`; `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.keystore`, `*.jks`; `id_rsa*`, `id_dsa*`, `id_ecdsa*`, and `id_ed25519*`; `.npmrc`, `.pypirc`, `.netrc`, `.git-credentials`, and `.htpasswd`.
- Secret directories: `.ssh`, `.aws`, `.gnupg`, `.docker`, `.kube`, `.azure`, and `.config/gcloud`.
- `extraIgnores` can add exact segment names or simple `*` segment globs; it cannot remove built-in ignores.
- Symlinks and special files are not copied. Source secrets and symlinks are reported by `skipped()`; ignored directories are not individually reported.
- Relative paths must not be absolute, empty, contain backslashes, control characters, empty segments, `.` or `..`; path byte length and depth are bounded. Host operations reject symlink components and use `O_NOFOLLOW` for final file reads.

## Threat model

This package is for local task workspaces operated by a trusted MARS service process. It reduces the effect of untrusted task commands by requiring an approval callback, pinning the container image by digest, removing network access and capabilities, using a non-root container user, restricting writable paths, and bounding runtime, memory, process count, file size, output, and metadata.

It is **not** a VM or a boundary against a compromised Docker daemon, host kernel, host administrator, or an attacker with the same host uid. The workspace process must own its `rootDir`; the Docker daemon is privileged. Containers receive the workspace tree, not the original `sourceRoot`. The provider never modifies `sourceRoot`. The image must already exist locally; verification never pulls it. On startup, a configured sandbox removes containers labeled for the root and provider creation fails if cleanup cannot be verified. The provider lock allows only one live provider process per real `rootDir`, and callers should close the provider to release it.

Host-side operations reject symlinks, but a separate process with the same host permissions can still race filesystem changes or directly alter a workspace. Revision checks detect ordinary out-of-band changes before restore; they are not a defense against a hostile same-uid process racing the provider. Keep `rootDir` private and do not share its tree with unrelated processes.

## Known gaps

- No aggregate disk quota exists beyond per-file `fsize` and post-run tree scanning.
- A digest-pinned image must be pre-pulled by the operator; tests do not pull images.
- Only one provider process may use a given root directory at a time.
- In-memory artifacts are neither durable nor suitable for production retention.
- Docker containment depends on the host daemon and kernel; it does not isolate kernel vulnerabilities.
- A process crash during restore is recovered from the on-disk journal on next provider creation. Abrupt host power loss and filesystem-specific durability characteristics remain dependent on the host filesystem.

## Verification evidence

See [EVIDENCE.md](./EVIDENCE.md) for the executed test, lint, typecheck, build/check, Docker, lockfile, and specification-hash results. Real-container results are explicitly separated from stub-runner test results.
