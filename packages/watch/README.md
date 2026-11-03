# @mars/watch

`@mars/watch` gives every MARS session type (coordinator, workers, reviewer, research worker, delegated children) the perception and verification capabilities of [oxbshw/watch-skill](https://github.com/oxbshw/watch-skill) 1.4.3 (MIT, Python 3.11+) without adding a second agent loop. The Python CLI is an external runtime driven as a sandboxed subprocess; Oh My Pi stays the only session and tool owner (`enableMCP: false`), and the workbench host registers the tools the same way it registers research tools.

See [documentation/WATCH.md](../../documentation/WATCH.md) for the full tool reference, verdict mapping, runtime requirements and the list of what was and was not exercised against the real CLI.

## API

```ts
import { createWatchService } from "@mars/watch";

const watch = createWatchService({
  command: ["watch-skill"],          // argv prefix; a venv path works too
  dataRoot: join(stateRoot, "watch"), // host-private WATCHSKILL_DATA_DIR
  policy: {
    allow_screen_capture: false,      // screen:/window: targets stay refused until the user opts in
    allow_network_sources: false,     // only loopback URLs unless opted in
    allow_cloud_models: false,        // WATCHSKILL_OFFLINE=1, offline_only cost policy
  },
});

const host = await createWorkbenchHost({ ..., watch });
```

`createWatchService` returns `{ policy, doctor(), toolsFor(binding) }`:

- `doctor()` runs `watch-skill version` (must equal `1.4.3`) and `watch-skill doctor --no-fix --json`; the result is cached for five minutes. When it is not available every tool answers `unavailable` (perception) or records an `inconclusive` evidence record (loop/verify). Nothing ever passes without the runtime.
- `toolsFor({ task_id, cwd, approvals: { read, execute }, evidence })` returns the `RuntimeWatch` surface the Oh My Pi runtime exposes as `mars_watch`, `mars_watch_ask`, `mars_watch_search`, `mars_watch_capture`, `mars_watch_extract`, `mars_loop`, `mars_verify` and `mars_watch_evidence`. `evidence` is the host-owned sink (`append`/`list`) the workbench backs with `tool.completed` task events (`producer: "@mars/watch"`).

## Sandbox

- argv only, no shell; stdin detached; cwd is the task workspace.
- one `WATCHSKILL_DATA_DIR` per task under `dataRoot/tasks/<sha256(task_id)>` (created `0700` on first use, as is `dataRoot` before the doctor probes), so the video index, loops, captures and verification bundles of one task are invisible to another; delegated children share their parent task's directory. `dataRoot` must lie outside the workspace.
- environment allowlist (`PATH`, `HOME`, locale, temp dirs, `VIRTUAL_ENV`) plus `WATCHSKILL_DATA_DIR`, offline flags and, only when screen capture is allowed, `DISPLAY`. Host secrets are never inherited.
- file sources must resolve inside the workspace or the task's watch directory; URLs must be http(s) and loopback unless `allow_network_sources`; `screen:`/`window:` need `allow_screen_capture`; `video_id`, `loop_id` and `run_id` are identifiers, never paths.
- verification contracts are checked before they run: read-only check types (`file_exists`, `file_digest`, `directory_manifest`, `json_*`, `numeric_invariant`, `visual_absent`, `sqlite_query`) need the session's `read` approval, executing types (`command_exit`, `live_console`, `live_evidence`, `browser_dom`, `http_request`) need `execute`; `path`/`database`/`cwd`/`expected_files` params must be relative without `..`; `command` must be an argv list; URLs go through the same loopback/network guard; unknown types are refused. Any refusal records `inconclusive` and the contract is not run.
- loop `script` steps are limited to upstream's `goto|click|fill|press|scroll|wait` with only their known fields (strict), ≤64 steps, `goto` URLs guarded like any source.
- a verdict is only read from a run that exited on its own; output captured from a timed-out or crashed process is `inconclusive` even if it already contains a passing JSON object.
- `allow_cloud_models` only lifts the CLI's offline mode when `allow_network_sources` is also on; with network off the CLI always runs `WATCHSKILL_OFFLINE=1`.
- known limit: URL guards see the hostname the model supplied; a loopback server that redirects to an external host is followed by the CLI itself. Keep `allow_network_sources` off and treat captured content as untrusted.
- output capped at 96 KiB, 120 s timeout (kill), timeouts are `inconclusive`.
- rendered text is wrapped in `[untrusted watch-skill output · <tool> · <label>]` markers and host paths are redacted.

## Evidence

`WatchEvidenceRecordSchema` (`kind`, `verdict`, `assurance`, `verified`, `advisory`, ids, required-check counts, limitations, summary) refuses `verified: true` unless the record is a `verify` run with verdict `pass`, assurance `deterministic_local` or `isolated_local` and at least one passed required check and none failed or inconclusive. THE LOOP is always `visual_advisory` and never verified. `remote_attested` is refused because upstream does not implement it. `signature_status: unsigned_hash_bound` is a hash binding, not a signature.

## Tests

`bun test packages/watch` runs offline against `test/fake-watch-skill.ts`, a Bun script that stands in for the CLI (scenario file + invocation log). No Python, network or model is used; `model_requests: 0`.
