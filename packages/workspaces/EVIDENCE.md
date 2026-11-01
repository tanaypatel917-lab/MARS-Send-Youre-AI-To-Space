# Verification evidence

Follow-up verification covers the recovery-isolation, Docker cleanup,
case-insensitive filtering, and text-patch changes on the feature branch after
merging the latest `origin/main`. The test image was already available locally;
no test pulled an image or contacted a model/provider.

## Install and lockfile

```text
export PATH="$HOME/.bun/bin:$PATH"
git fetch origin
git merge origin/main
# bun.lock conflicted; resolved from origin/main, then:
git restore --source=origin/main --staged --worktree -- bun.lock
bun install --ignore-scripts
```

Install output:

```text
bun install v1.4.4
1 package installed
Saved lockfile
```

`git diff origin/main -- bun.lock` contains only the `packages/workspaces`
workspace mapping (`@mars/workspaces`, `@mars/contracts: workspace:*`, and
`zod: 3.25.76`) and its `@mars/workspaces` package resolution entry.

```text
bun install --frozen-lockfile --ignore-scripts
```

```text
Checked 129 installs across 169 packages (no changes)
```

## Package tests

Command: `bun test packages/workspaces`

### Stub runner — not isolation evidence

21 stub-runner tests passed, 0 failed.

### Real container

Five `[real container]` tests ran (none skipped) and passed, covering the
non-root/read-only/no-network boundary, writable workspace bind mount and pids
limit, timeout cleanup, stop cancellation, and bounded output.

One path-filter unit test also passed. Package suite total: **27 passed,
0 failed, 220 expectations across 2 files**.

Recovery coverage includes a missing-tree workspace isolated from a healthy
workspace, rollback of a healthy workspace's restore journal, recovery of its
interrupted execution, staging/trash cleanup, corrupt metadata isolation,
fail-closed `prepare()` / `discover()`, and cleanup of an empty prepare
leftover. Text-only patch validity was verified by applying concatenated
`diff()` output with `git apply -p1 --whitespace=nowarn` outside a repository;
the test checks content, executable bits, additions, and deletions. The patch
case includes newline additions/removals and a file without a trailing newline.

The second run, `bun test packages/workspaces/tests/docker.test.ts`, also ran
all five real-container tests: **5 passed, 0 failed, 17 expectations across
1 file**.

## Repository checks

```text
bunx biome check packages/workspaces
Checked 14 files in 28ms. No fixes applied.
```

It reported **0 warnings and 0 errors**.

```text
bun run lint
$ biome check .
Checked 90 files in 76ms. No fixes applied.
```

Completed with **0 warnings and 0 errors**.

```text
bun run typecheck
$ tsc --noEmit
```

Passed.

The final `bun run check` completed lint, typecheck, offline source audit, the
full test suite, smoke, and build:

```text
Validated 25 source entries, pinned URLs, master-spec hash and runtime artifact pins (offline).
255 pass
0 fail
1131 expect() calls
Ran 255 tests across 18 files.
"model_requests": 0
Bundled 21 modules
```

Specification hash:

```text
sha256sum documentation/MASTER_SPECIFICATION.md
0e535d3d592fbad5cc9af5a4290d4b981e5ad597ffdaacf91cc6c42a5b9f80a9  documentation/MASTER_SPECIFICATION.md
```

## Container cleanup

After the final suite, `docker ps -a` showed only the header:

```text
CONTAINER ID   IMAGE     COMMAND   CREATED   STATUS    PORTS     NAMES
```

No `mars-ws` containers remained.

## Restore rollback retention follow-up

The follow-up adds a shared digest-verified rollback path for both in-process
restore failure and startup recovery. Failure-injection coverage confirms that
failed rollback keeps its journal and backup; failed digest validation also
retains the aside tree. Selective cleanup removes only resolved workspace
entries and true orphans, while healthy workspaces continue to recover.

```text
bun test packages/workspaces
32 pass
0 fail
248 expect() calls
Ran 32 tests across 2 files.
```

Five real-container tests ran and passed; the other 27 tests used stub or
non-container fixtures. The focused startup, in-process, and tampered-backup
failure-injection tests also passed: 3 pass, 0 fail, 22 expectations.

```text
bunx biome check packages/workspaces
Checked 14 files in 29ms. No fixes applied.

bun run lint
Checked 90 files. No fixes applied.

bun run typecheck
tsc --noEmit
```

The final `bun run check` completed:

```text
Validated 25 source entries, pinned URLs, master-spec hash and runtime artifact pins (offline).
260 pass
0 fail
1159 expect() calls
Ran 260 tests across 18 files.
"model_requests": 0
Bundled 21 modules
```

The master specification SHA-256 remained
`0e535d3d592fbad5cc9af5a4290d4b981e5ad597ffdaacf91cc6c42a5b9f80a`.

## Sandboxed workspace security boundary

Workspace files are produced by untrusted commands and written with the host
uid through the bind mount. Host integrations must not execute, source, or
import workspace files outside the sandbox. Secret-name filtering covers
source copying and provider `read`/`write`/`diff`/`checkpoint`; commands may
read files created by earlier sandboxed commands in the same workspace, but
those files cannot contain host secrets because source secrets are never
copied into the workspace.

## Post-merge review-fix verification

```text
export PATH="$HOME/.bun/bin:$PATH"; bun install --frozen-lockfile --ignore-scripts
bun install v1.4.4 (38afee6c8)
Checked 129 installs across 169 packages (no changes)
```

```text
bun test packages/workspaces
37 pass
0 fail
280 expect() calls
Ran 37 tests across 2 files.
```

Six real-container tests ran and passed (none skipped); 30 stub-runner tests
and one path-filter unit test also passed.

```text
bunx biome check packages/workspaces
Checked 14 files in 67ms. No fixes applied.

bun run typecheck
$ tsc --noEmit
```

Both commands passed; Biome reported zero warnings and errors.

The final repository check completed:

```text
bun run check
Checked 90 files in 77ms. No fixes applied.
Validated 25 source entries, pinned URLs, master-spec hash and runtime artifact pins (offline).
265 pass
0 fail
1191 expect() calls
Ran 265 tests across 18 files.
"model_requests": 0
Bundled 21 modules
```

The master specification SHA-256 matched
`0e535d3d592fbad5cc9af5a4290d4b981e5ad597ffdaacf91cc6c42a5b9f80a9`.

```text
docker ps -a
CONTAINER ID   IMAGE     COMMAND   CREATED   STATUS    PORTS     NAMES

git diff --check
(no output; exit status 0)
```
