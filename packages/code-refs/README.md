# @mars/code-refs

Committed Git object references over a **host-trusted repository mapping**.
This is the resolver half of Team Chat PR 4: given a locator
`{repo_id, commit_sha, path, line_start?, line_end?}` it returns the exact
committed text (or a precise reason why it cannot), by reading objects from a
local repository with argv-only `git`.

## What this package is NOT

- **Not authorization.** Nothing here decides who may see a reference. The
  caller (the chat service, later the VS Code preview panel through the host)
  must already have checked team membership and repository access for the
  viewer *before* calling `resolveReference` or `searchPaths`. A viewer who
  fails that check must get a `restricted` chip without `path`, `repo_id`,
  `commit_sha` or excerpt — that fail-closed rendering lives in the caller,
  not here.
- **Not a Git provider.** No network, no GitHub/GitLab API, no OAuth, no
  tokens, no clone/fetch. Only objects already committed in a repository the
  host registered are read. The working tree, the index and the current branch
  are never consulted; a reference pinned to a commit keeps resolving to that
  commit after the branch moves or the file is renamed.
- **Not a path-based identifier.** `repo_id` is an opaque id
  (`^[A-Za-z0-9_.-]{1,64}$`) that the host maps to a directory at startup.
  Clients never register, never pass a directory, and never see one: no
  result or error string carries the repository directory or any absolute
  path.

## API

```ts
import {
  createRepoRegistry, resolveReference, searchPaths,
  validateLocator, referenceDigest, isSameReference,
} from "@mars/code-refs";

const registry = createRepoRegistry();                 // host only
await registry.register({ repo_id: "platform", dir: "/srv/repos/platform", label: "Platform" });

const ref = await resolveReference(registry, {
  repo_id: "platform",
  commit_sha: "2ce2ddc6a6c4fa1c4f6f714cba4091916dc5f0d9",
  path: "packages/contracts/src/index.ts",
  line_start: 3, line_end: 6,
});
// ref.state === "ok" -> { blob_sha, line_start, line_end, total_lines, text, text_sha256, truncated, git_version }

const hits = await searchPaths(registry, { repo_id: "platform", commit_sha, query: "server.ts", limit: 20 });
const id = referenceDigest(locator);                  // sha256("repo_id\ncommit_sha\npath\nline_start\nline_end")
```

### Registry (`createRepoRegistry`)

`register({repo_id, dir, label})` is called by the HOST at startup. The
directory must be absolute, must not be a symlink or contain a symlinked
component (`realpath` must equal the given path), must not nest inside or
contain an already registered directory, and must be a work-tree root or a
git directory (checked with `git rev-parse --is-bare-repository
--absolute-git-dir` / `--show-toplevel`). Violations throw
`RepoRegistrationFailed` with a fixed `code` and a message that never contains
the directory. `list()` returns `{repo_id, label}` only; `lookup()` is the
host-internal accessor the resolver uses.

### Locator validation (`validateLocator`)

Runs before any `git` process starts:

| Field | Rule |
| --- | --- |
| `repo_id` | `^[A-Za-z0-9_.-]{1,64}$` |
| `commit_sha` | exactly 40 lowercase hex; no abbreviations, refs, `HEAD`, `^`, `~` |
| `path` | NFC-normalised, then the rules of `apps/vscode/src/pathSafety.ts` `checkRelativePath` (no scheme/drive, no absolute or `~`, no `.`/`..`/empty segment, no control chars, no backslash, no `<>:"|?*`, no `.git` segment, ≤ 1024 chars) plus the invisible code point denylist of `packages/memory/src/threats.ts`. `sync.test.ts` fails if either source drifts. |
| `line_start`/`line_end` | both or neither; positive integers; `line_start ≤ line_end`; inclusive span ≤ `max_range_lines` (default 400) |

### Resolution states (`resolveReference`)

| `state` | Meaning | Extra fields |
| --- | --- | --- |
| `ok` | committed text returned | `blob_sha`, `line_start`, `line_end`, `total_lines`, `text`, `text_sha256`, `truncated` |
| `invalid` | locator failed validation (git never ran) | `reason` |
| `unknown_repo` | `repo_id` is not registered (git never ran) | — |
| `unavailable` | commit missing from the repository, or no entry at `path` in that commit (also when the current branch has the file) | — |
| `is_directory` | `path` is a tree | — |
| `unsupported_symlink` | mode `120000` | — |
| `unsupported_submodule` | mode `160000` (gitlink) | — |
| `oversized` | blob larger than `max_blob_bytes` (default 1 MiB) | `blob_sha`, `size_bytes`, `max_blob_bytes` |
| `binary` | NUL in the first 8 KiB or not valid UTF-8 | `blob_sha` |
| `range_out_of_bounds` | `line_start` or `line_end` beyond the last line | `blob_sha`, `total_lines` |
| `error` | git could not run, timed out, failed or exceeded the output cap | `reason`: `git_unavailable` / `timeout` / `git_error` / `output_truncated` |

Every state except `invalid` carries `repo_id`, `commit_sha`, `path` and
`git_version` (the `git --version` string, probed once per runner). Lines are
split on `\n` or `\r\n`; a missing final newline still counts as a line; an
empty blob is `ok` with `total_lines: 0` and `text: ""`. Without a range the
whole file is returned, cut at `max_range_lines` with `truncated: true`.

Steps, in order: `rev-parse --verify <sha>^{commit}` → `ls-tree -z <sha> --
<path>` → `cat-file -s <blob>` → `cat-file blob <blob>` → binary probe → fatal
UTF-8 decode → line slice. The blob is read by its object id from the tree
entry, never by path again.

### Path search (`searchPaths`)

`searchPaths(registry, {repo_id, commit_sha, query, limit ≤ 100})` streams
`git ls-tree -r -z --name-only <sha>` and stops after `max_entries` (default
50 000) with `truncated: true`. Matching is case-insensitive substring/prefix
ranking (0 exact file name, 1 file-name prefix, 2 path prefix, 3 file-name
substring, 4 path substring); the query is plain text, never a regex. Only
paths that pass the locator path rules are returned (`skipped` counts the
rest). Symbol search is out of scope; the `@mars/context` extractors could
back it later.

### Verification helpers

- `referenceDigest(ref)` — SHA-256 hex of
  `repo_id\ncommit_sha\npath\nline_start\nline_end` (absent bounds are empty
  strings), for an immutable reference id on the chat side.
- `isSameReference(a, b)` — field equality on the same five fields.

## How `git` is run

Same discipline as `@mars/watch` and `@mars/knowledge-graph`: `Bun.spawn`
with an argv array (never a shell string), `cwd` = the registered directory,
stdin detached, bounded stdout, SIGKILL on timeout (`timeout_ms`, default
10 s), global flags `--no-replace-objects --literal-pathspecs`, and
user-controlled values placed only after `--` (the path) or validated as 40
hex (the SHA). The environment is an allowlist: `PATH`, `HOME` and
`XDG_CONFIG_HOME` pinned to a private 0700 directory, `GIT_CONFIG_NOSYSTEM=1`,
`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_TERMINAL_PROMPT=0`,
`GIT_OPTIONAL_LOCKS=0`, `GIT_PAGER=cat`, `LC_ALL=C`, `NO_COLOR=1`. Nothing
else is inherited: proxy variables, `GIT_ASKPASS`, `GIT_SSH_COMMAND`,
`SSH_AUTH_SOCK`, `GIT_CONFIG_PARAMETERS`, `GIT_DIR`, `GIT_WORK_TREE` and all
other `GIT_*` variables are dropped. `createGitRunner({ spawn })` is the test
hook that records the exact argv and env.

## Limits (defaults)

| Limit | Default |
| --- | --- |
| `max_blob_bytes` | 1 MiB |
| `max_range_lines` | 400 |
| `timeout_ms` | 10 000 |
| search `limit` | ≤ 100 (default 20) |
| search `max_entries` | 50 000 |
| query length | 256 |

## Tests

`bun test packages/code-refs` — offline; builds a temporary repository with
`git init` (text, binary, invalid UTF-8, symlink, gitlink, nested dir, rename,
large file, CRLF, empty) and proves pinning, rename behaviour, missing
revisions, pre-git rejection (git is not spawned), entry kinds, size/binary
states, EOF ranges, the env allowlist, timeouts and that no output contains an
absolute path. When `git` is absent the suite is **skipped with a warning**,
never silently passed.

## Follow-ups

- `GitRangeReferenceSchema` is defined locally until
  `packages/contracts/src/team.ts` adds `ReferenceSchema` (kind `git_range`);
  then import it from `@mars/contracts` and delete the local copy.
- The chat service (PR 2/3) owns the `reference_id → locator` store and the
  viewer authorization; the VS Code preview panel renders `ResolvedReference`
  through the extension host.
