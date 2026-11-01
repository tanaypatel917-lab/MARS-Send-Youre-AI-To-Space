# Verification evidence

Final verification was run after merging the latest `origin/main`. The test
image was already available locally; no test pulled an image or contacted a
model/provider.

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

17 stub-runner tests passed, 0 failed.

### Real container

Five `[real container]` tests ran (none skipped) and passed, covering the
non-root/read-only/no-network boundary, writable workspace bind mount and pids
limit, timeout cleanup, stop cancellation, and bounded output.

Package suite total: **22 passed, 0 failed, 158 expectations across 2 files**.

The required second run, `bun test packages/workspaces/tests/docker.test.ts`,
also ran all five real-container tests: **5 passed, 0 failed, 17 expectations
across 1 file**.

## Repository checks

```text
bun run lint
```

Completed with **53 warnings and no errors**.

```text
bun run typecheck
$ tsc --noEmit
```

Passed.

The final `bun run check` completed its lint, typecheck, offline source audit,
full test suite, smoke, and build steps:

```text
Validated 25 source entries, pinned URLs, master-spec hash and runtime artifact pins (offline).
250 pass
0 fail
1069 expect() calls
Ran 250 tests across 18 files.
"model_requests": 0
Bundled 21 modules
```

Specification hash:

```text
sha256sum documentation/MASTER_SPECIFICATION.md
0e535d3d592fbad5cc9af5a4290d4b981e5ad597ffdaacf91cc6c42a5b9f80a9  documentation/MASTER_SPECIFICATION.md
```

## Container cleanup

After tests and checks, `docker ps -a` showed only the header:

```text
CONTAINER ID   IMAGE     COMMAND   CREATED   STATUS    PORTS     NAMES
```

No `mars-ws` containers remained.
