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
