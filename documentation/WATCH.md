# Watch and verify (`@mars/watch`)

`@mars/watch` wraps the external [oxbshw/watch-skill](https://github.com/oxbshw/watch-skill)
Python CLI (v1.4.3, commit `f1317c8fe64744a606c31867b05fbbe3144268c6`, MIT) as
host-bound tools so a session can record a running target, ask questions about a
recording, run THE LOOP (capture → critique → iterate) and run deterministic
verification contracts. This page is the authoritative description of the
integration on the `devin/1793662589-watch-skill` branch. It describes the
design and the fixture-tested behaviour; the only live CLI evidence is listed
in [What was actually run](#what-was-actually-run).

**Status:** design and offline fixture coverage only. No `watch`, `ask`,
`search`, `capture`, `loop` or `extract` command, no vision provider and no URL
source has been exercised against the real CLI through the wrapper.

## 1. Purpose and ownership

Oh My Pi remains the only live session/tool owner (`enableMCP: false`). The
integration adds no second agent loop and no MCP server or client. watch-skill
runs as a CLI subprocess behind host-bound tools, the same pattern as the
`@mars/research` tools: `packages/workbench/src/host.ts` registers the tools
(`watchFor(taskId, cwd)` next to `researchFor` / `research-context.ts`) and
`packages/execution/src/runtime.ts` declares them (`RuntimeWatch` interface and
`WATCH_TOOL_DEFS`, next to `RESEARCH_TOOL_DEFS`), with strict zod parameter
parsing and a 128 KiB bound on tool output.

Roles that receive the tools: the coordinator, workers, the reviewer, the
research worker session and delegated child sessions. `watchFor` spreads
`watch: service.toolsFor(...)` into every `runtimeFactory` call (start and
resume); the tools are counted in `toolsRequired`, `initialRequestAllowance`
and `optionalInstructionCapacity` (`watch: boolean`); and
`createOhMyPiChildAdapter({ watchFor })` gives children the same tools, bound
to the parent task (`ChildLaunch.task_id`).

The feature is optional. A host created without the `watch` option
(`WorkbenchHostOptions.watch?: WorkbenchWatch`) exposes none of the tools.

### Service API

```ts
createWatchService({
  command?: string[],        // default ["watch-skill"]; a venv path or ["bun", fixture] works
  expectedVersion?: "1.4.3",
  dataRoot: string,          // private, host-side; becomes WATCHSKILL_DATA_DIR
  policy?: Partial<WatchPolicy>,
  timeoutMs?: number,        // default 120 s
  maxOutputBytes?: number,   // default 96 KiB
  doctorTtlMs?: number,      // default 5 min
  env?: Record<string, string>, // only MARS_WATCH_* / FAKE_WATCH_SKILL_* names pass through (fixtures)
  now?: () => number,
});

service.doctor();  // { available, version, reason, checks, checked_at } — cached 5 min
service.toolsFor({
  task_id,
  cwd,                       // the task workspace; file sources must resolve inside it
  approvals?: { read, execute }, // gate read-only vs executing check types in contracts
  evidence: { append(record), list() }, // host-owned sink (workbench: watch-context.ts)
}); // RuntimeWatch
```

## 2. Runtime requirements and the doctor gate

Python is an external runtime, not a dependency of the monorepo.

| Requirement | Role | When missing |
| --- | --- | --- |
| Python >= 3.11 | runs the CLI | every tool answers `unavailable` (perception) or `inconclusive` (loop/verify) |
| `watch-skill==1.4.3` (pinned) | the CLI | same; a different `--version` fails the gate |
| ffmpeg (5.1+ recommended upstream) | capture, frame extraction | same |
| extras `perceive` / `index` / `ocr` / `loop` | vision, indexing, OCR, THE LOOP | the affected commands fail or degrade per the CLI; the wrapper reports `error` / `inconclusive`, never `pass` |
| Playwright chromium | URL capture (`browser` target) | `capture-capabilities` lists `browser` as unavailable |
| yt-dlp | URL video sources | URL sources fail; doctor reports `yt-dlp` fail |

Doctor gate: `watch-skill --version` must equal `1.4.3` and
`watch-skill doctor --no-fix --json` must report `ok: true`. Otherwise every
tool answers `unavailable` (perception tools) or returns verdict
`inconclusive` (loop/verify). A failing gate is never turned into a pass. The
doctor result is cached for five minutes.

Sandbox for every subprocess:

- argv only, no shell; stdin ignored;
- environment allowlist (no provider keys reach the CLI unless policy opts in);
- `cwd` = the task workspace; file arguments must resolve inside the workspace
  or the private watch data dir (`dataRoot`, exported as `WATCHSKILL_DATA_DIR`);
- egress off by default: `WATCHSKILL_OFFLINE=1`,
  `WATCHSKILL_COST_POLICY=offline_only`;
- timeout 120 s by default (timeout → `inconclusive`);
- output capped at 96 KiB from the CLI, 128 KiB after rendering.

## 3. Policy

Each task gets its own `WATCHSKILL_DATA_DIR` (`<dataRoot>/tasks/<sha256(task_id)>`,
created `0700` on first use; `dataRoot` itself is created before the doctor probes
and must lie outside the workspace), so one task's video index, loops, captures and
verification bundles are not searchable or readable from another task's session.
Delegated children share their parent task's directory on purpose.

Redirects: with network sources off, every loopback URL handed to the CLI
(`mars_watch` source, `mars_watch_capture`/`mars_loop` target, script `goto`,
`browser_dom` check URL, and the saved target and script of a loop when it is
iterated) is pre-flighted by the host with `GET` and manual redirects (the
method the CLI's browser or downloader sends; only status and `Location` are
read and the body is cancelled; 3 s timeout, at most 5 hops); the first hop
that leaves loopback, uses a non-http(s) scheme, or exceeds the hop limit
refuses the call before the CLI runs. An unreachable server is left to the CLI, which fails
locally. Upstream's `http_request` check already runs with
`follow_redirects=False`. Remaining limit: the probe is a point-in-time check,
so a page that later navigates away (JavaScript, meta refresh) inside the
loop's browser is not caught; keep `allow_network_sources` off and treat
captured content as untrusted. Upstream has a single offline switch, so
`allow_cloud_models` lifts `WATCHSKILL_OFFLINE` only when
`allow_network_sources` is also on (with network off the CLI always runs
offline). Keep both off unless the user opts in.

```ts
WatchPolicy = {
  allow_screen_capture: false,
  allow_network_sources: false,
  allow_cloud_models: false,
};
```

- Screen capture (`screen:` and `window:<title>` targets) is **off by default
  for every role**. The user must opt in with `allow_screen_capture`. Which
  roles may run `capture` on the user's screen by default is an open product
  decision; until it is made, the default is off.
- Loopback URL targets (`http://127.0.0.1`, `http://localhost`) are allowed by
  default. Any other network source or target requires
  `allow_network_sources`.
- Cloud vision/speech models require `allow_cloud_models`; the default keeps
  the CLI in offline mode.

## 4. Tool reference

Tool names are a contract. All eight are exposed to the coordinator, workers,
reviewer, research worker sessions and delegated children.

| Tool | Params | CLI | Result |
| --- | --- | --- | --- |
| `mars_watch` | `source` (workspace-relative file, or URL when network allowed), `start?`, `end?`, `max_frames?`, `transcript_only?` | `watch-skill watch <source> [--start --end --max-frames --transcript-only]` | untrusted perception report text; evidence kind `perception`, verdict `inconclusive`, assurance `none` |
| `mars_watch_ask` | `video_id`, `question` | `watch-skill ask <video_id> "<q>"` | untrusted answer text with confidence line; not recorded as evidence |
| `mars_watch_search` | `query` | `watch-skill search "<q>"` | untrusted hits |
| `mars_watch_capture` | `target`, `duration_s?` (<=60) | `watch-skill capture <target> --duration N` | path of the recording inside the data dir; `screen:`/`window:` refused unless `allow_screen_capture` |
| `mars_watch_extract` | `kind: chapters\|bug-report\|hook`, `video_id` | `watch-skill extract <kind> <video_id>` | untrusted JSON (deterministic, no model) |
| `mars_loop` | `action: start\|iterate\|status`, `target?`, `pass_criteria?`, `script?` (JSON steps), `loop_id?`, `max_iterations?` (<=10), `duration_s?` (<=60) | `watch-skill loop start\|iterate\|status …` then reads `<data>/loops/<loop_id>/state.json` | rendered critique; evidence kind `loop`, verdict = critique verdict (`pass`/`fail`; no iteration => `inconclusive`; CLI error => `error`), assurance `visual_advisory`, `verified: false`, `advisory: true` |
| `mars_verify` | `action: run\|show\|checks`, `contract?` (object: `contract_id`, `title`, `checks[]`, `required_assurance?` default `isolated_local`, `allowed_origins?`), `run_id?` | `watch-skill verify run <contract.json> --dir <cwd>` (never `--in-process`), `verify show <run_id>`, `verify checks` | parsed JSON `{run_id, verdict, assurance, limitations, signature_status, checks[]}`; evidence kind `verify`; `verified` only when verdict `pass`, assurance `deterministic_local`/`isolated_local` and >=1 required check passed; `required_assurance: remote_attested` refused -> `inconclusive`; non-loopback `allowed_origins` without `allow_network_sources` -> `inconclusive` (contract is frozen, never edited) |
| `mars_watch_evidence` | — | reads task events | lists this task's watch evidence records (verdict, assurance, verified/advisory, ids) so a reviewer can require loop/verify evidence; "no evidence" is stated explicitly |

`mars_verify` takes the contract as an object; the host serialises it to a file
under the private watch data dir and passes that path to `verify run`. The
model never supplies a filesystem path for a contract, and `--in-process` is
never used.

Contract checks follow upstream's shape: `{ id, type, required?, description?,
params: {...}, timeout_seconds? }` (strict; parameters live in `params`). Before a
contract runs the host checks it against policy; any refusal records an
`inconclusive` evidence record and the contract is **not** run:

- `required_assurance: remote_attested`;
- a non-loopback `allowed_origins` entry or `params.url` without `allow_network_sources`;
- read-only check types (`file_exists`, `file_digest`, `directory_manifest`,
  `json_schema`, `json_value`, `numeric_invariant`, `visual_absent`, `sqlite_query`)
  when the session has no `read` approval;
- executing check types (`command_exit`, `live_console`, `live_evidence`,
  `browser_dom`, `http_request`) when the session has no `execute` approval
  (children in a read-only workspace never have it); `human_approval` needs neither;
- an unknown check type;
- `params.path`, `params.database`, `params.cwd` or an `expected_files` entry that
  is absolute or contains `..` (checks stay inside the `--dir` workspace);
- `params.command` that is not a non-empty argv list of strings.

A verdict is only read from a run that exited on its own: stdout captured from a
timed-out or crashed CLI is `inconclusive` even if it already holds a passing JSON
object (the same applies to `verify show`). An upstream `pass` without at least one
passed required check is recorded as `inconclusive`. `verify show` renders a stored
run but writes no new record.

Loop `script` steps are validated against upstream 1.4.3's step set
(`goto {url}`, `click {selector, timeout_ms?}`, `fill {selector, value}`,
`press {key}`, `scroll {dy?}`, `wait {seconds<=30}`), strict fields, at most 64
steps; `goto` URLs pass the same loopback/network guard as any source.

## 5. Verdict and assurance mapping

Verdicts (upstream semantics, `docs/verification.md`):

| Verdict | Meaning |
| --- | --- |
| `pass` | every required check passed |
| `fail` | a required check failed |
| `inconclusive` | a required check could not run (timeout, missing tool, denied by policy), never ran, or the contract has no required check |
| `error` | the verifier or the CLI itself failed |

Assurance levels:

| Level | Meaning | In `@mars/watch` |
| --- | --- | --- |
| `visual_advisory` | a model looked at frames; no deterministic check decided anything | THE LOOP critiques; always `advisory: true`, `verified: false` |
| `deterministic_local` | checks ran in the CLI process, as this user | may be `verified` |
| `isolated_local` | checks ran in a separate process with a sanitized environment and bounded roots | default `required_assurance`; may be `verified` |
| `remote_attested` | checks ran on an independent machine and signed the result | **not implemented upstream**; a contract requiring it is refused and recorded as `inconclusive` |
| `none` | no check ran | perception records |

Rules:

- `verified: true` only when kind `verify`, verdict `pass`, assurance
  `deterministic_local` or `isolated_local`, and at least one required check
  passed. Everything else is `verified: false`.
- Visual critique is `advisory`. A loop whose only criterion is visual never
  produces `verified`.
- Absent evidence is never a pass: no iteration, no frames, timeout, missing
  runtime and failed doctor gate all map to `inconclusive`.
- The CLI exit code is **not** the verdict. `verify run` exits 1 when the
  verdict is `fail`; the wrapper reads the JSON `verdict` field. A CLI error
  JSON `{error, message, fix, details}` (exit 1) maps to verdict `error` with
  the code and `fix` shown to the model.
- `signature_status: unsigned_hash_bound` means the evidence bundle is bound
  by a SHA-256 over its canonical form. It detects later edits; it says nothing
  about who produced the bundle. It must never be described as a signature.
  Ed25519 signing is an upstream extra (`watch-skill[attest]`); nothing in
  this integration claims it.
- Contracts are frozen and digested before the run. The wrapper never edits a
  contract to make it runnable; an unrunnable contract yields `inconclusive`.

## 6. Evidence records

Every `mars_watch`, `mars_watch_capture`, `mars_loop` and `mars_verify run` call,
including one that fails, times out, is refused by host policy (unreadable or
out-of-workspace source, screen capture without opt-in, non-loopback URL, bad
loop script, denied contract checks) or submits an invalid contract,
produces a `WatchEvidenceRecord` (zod `WatchEvidenceRecordSchema`) that the
host appends as a `tool.completed` task event with `producer: "@mars/watch"`
and `versions: [{component:"@mars/watch",revision:"0.0.1"},{component:"watch-skill",revision:"1.4.3"}]`:

```jsonc
{
  "schema_version": 1,
  "operation": "watch.evidence",
  "kind": "loop" | "verify" | "perception" | "doctor",   // doctor is reserved; unavailability is recorded on the loop/verify record
  "tool": "mars_loop" | "mars_verify" | "mars_watch" | "mars_watch_capture",
  "verdict": "pass" | "fail" | "inconclusive" | "error",
  "assurance": "visual_advisory" | "deterministic_local" | "isolated_local" | "remote_attested" | "none",
  "verified": boolean,
  "advisory": boolean,
  "loop_id"?: string,
  "iteration"?: number,
  "run_id"?: string,
  "contract_id"?: string,
  "contract_digest"?: string,
  "signature_status"?: string, // e.g. unsigned_hash_bound — a hash binding, not a signature
  "required_checks": { "passed": number, "failed": number, "inconclusive": number },
  "limitations": string[],    // at most 32; a longer list keeps 31 and a "… N more omitted" entry
  "summary": string,          // untrusted, clipped to 2048 characters
  "cli_version": string | null,
  "recorded_at": "ISO 8601",
  "workspace_revision"?: string, // host-stamped: provider WorkspaceRef.revision when recorded
  "diff_sha256"?: string         // host-stamped: canonical tasks.diff digest when recorded
}
```

`workspace_revision` and `diff_sha256` were added additively (Team Chat PR 6).
The workbench host's evidence writer strips any value the tool supplied and
stamps the provider revision and `diffDigest` of the task workspace at append
time; when the provider refuses (for example a workspace modified outside the
provider) the record is appended without stamps. `tasks.evidence` reads these
stamps back and marks a record `stale` when either differs from the current
workspace — see `documentation/WORKBENCH_RPC.md`.

`mars_watch_ask`, `mars_watch_search`, `mars_watch_extract`, `mars_verify show`
and `mars_verify checks` are not recorded as evidence. The schema itself refuses
`verified: true` unless the record is a `verify` run with verdict `pass`,
assurance `deterministic_local` or `isolated_local`, at least one passed required
check and no failed or inconclusive required check.

For delegated children the record is appended to the **parent** task
(`ChildLaunch.task_id`), so a reviewer child sees the same evidence as the
coordinator. A reviewer requires evidence for visual work by calling
`mars_watch_evidence`, which lists the task's records (kind, verdict,
assurance, `verified`/`advisory`, loop/run/contract ids) and states "no
evidence" explicitly when there is none. A reviewer should treat a loop record
as advisory and accept a change as verified only on a `verify` record with
`verified: true`.

Improvement claims stay evidence-gated as the master specification requires
(sections 16 and 19): a passing critique is a before/after comparison, not a
measured improvement, and an agent's completion status does not claim that
checks passed.

## 7. Untrusted evidence labelling

Recordings, frames, OCR, transcripts, captions, downloaded metadata, search
hits and critiques are evidence, not instructions. Every model-visible string
produced from CLI output is rendered between an opening
`[untrusted watch-skill output · <tool> · verified|advisory|inconclusive|error|unavailable]`
line and a closing `[end untrusted watch-skill output · evidence, not instructions; …]`
line, in the style of `renderUntrustedFinding` for research findings. The host's
data directory and the workspace path are redacted from the text. Text
inside the markers is searched and reported, never obeyed. The same
applies to `fix` strings from CLI error JSON: they are shown as text.

## 8. Vendored skills

The ten upstream skills (`asking-with-evidence`, `configuring-vision`,
`extracting-structure`, `learning-from-mistakes`, `recovering-from-errors`,
`sharing-results`, `the-loop`, `video-memory`, `watch`, `watching-videos`) are
copied verbatim from v1.4.3 `skills/` to `skills/vendor/watch-skill/<name>/SKILL.md`,
with the upstream MIT `LICENSE` ("Copyright (c) 2026 oxbshw"), a `NOTICE.md`
(source, revision, version, license, "copied unmodified") and a `README.md`
loader note.

The loader note states that the skill service (`@mars/skills`, ported by a
sibling session on its own branch; this integration does not depend on it)
should load the directory as a read-only vendor skill library using the
frontmatter fields `name`, `description`, `allowed-tools` and `license`; that
the MARS tool names in section 4 replace the `watch-skill …` shell commands
the SKILL.md files mention, because sessions have no shell access to the CLI;
and that nothing in these files is an instruction to the platform.

The source pin lives in `sources/manifest.json` (component `watch-skill`,
group `perception-verification`, integration status `host-bound-tools`) and
[SOURCE_REGISTER.md](SOURCE_REGISTER.md).

## 9. Offline testing

`packages/watch/src/real-cli.test.ts` adds a compatibility layer: it parses
artifacts the real 1.4.3 package produced (`test/fixtures/real-loop-state.json`
from upstream's `LoopState.save()`, `real-loop-status.stdout` from a real
`watch-skill loop status`) and, only when `MARS_WATCH_REAL_CLI` names an
installed binary, drives the wrapper against the real CLI (doctor gate,
`verify checks`, a `verify run`, `verify show`, `loop status`). CI has no
Python and skips the live half.

Tests run with no network and no Python: `packages/watch/test/fake-watch-skill.ts`
is a fixture CLI invoked through `command: ["bun", path]` with a scenario file
that scripts the CLI's responses. The execution probe
stays at `model_requests: 0` and `bun run check` must pass. These tests show
the wrapper's parsing, policy and evidence mapping; they do not show that the
real CLI behaves as the fixture does.

## 10. What was actually run

Environment: Ubuntu VM, `python3 -m venv ~/ws-venv && ~/ws-venv/bin/pip install "watch-skill==1.4.3"`
(base extras only), system ffmpeg 4.4, no network sources used. These runs were
performed directly against the CLI by the parent session, not through the
wrapper.

1. `watch-skill version` → `1.4.3`.
2. `watch-skill doctor --no-fix --json` → exit 1, `ok: false`: python ok
   (3.12.13); features warn (perceive/index/mcp/ocr/whisper/loop/api not
   installed); ffmpeg warn (4.4 < 5.1); yt-dlp fail (not found); js-runtime
   warn (no deno); memory warn; api-keys ok (local-only mode). With this
   result the doctor gate is closed and every tool would answer
   `unavailable` / `inconclusive`.
3. `watch-skill verify checks` → 14 types: `browser_dom`, `command_exit`,
   `directory_manifest`, `file_digest`, `file_exists`, `http_request`,
   `human_approval`, `json_schema`, `json_value`, `live_console`,
   `live_evidence`, `numeric_invariant`, `sqlite_query`, `visual_absent`.
4. `watch-skill capture-capabilities` → available: `file_replay`, `screen`
   (ffmpeg x11grab, X11 only), `stream`; degraded: `camera`, `microphone`;
   unavailable: `browser` (needs `pip install 'watch-skill[loop]' && playwright install chromium`),
   `window` ("per-window capture is implemented for Windows only"), `webrtc`.
5. `WATCHSKILL_OFFLINE=1 WATCHSKILL_DATA_DIR=/tmp/wsv/data watch-skill verify run contract.json --dir /tmp/wsv/work`
   with contract `{contract_id: mars-smoke-v1, required_assurance: isolated_local, checks: [file_exists present.txt required, file_exists missing.txt optional]}`
   → exit 0, `{run_id: vr_5881743307c6, verdict: pass, assurance: isolated_local, limitations: [], signature_status: unsigned_hash_bound, checks: [present pass required, absent fail optional]}`;
   bundle written under `<data>/verifications/vr_5881743307c6/`; `verify list`
   shows it.
6. `watch-skill loop status nope` → exit 1,
   `{"error":"loop.not_found","message":"unknown loop_id: nope","fix":"start one with loop_start; state lives under ~/.watch-skill/loops","details":{}}`.

7. Through the wrapper (`packages/watch/src/real-cli.test.ts`, live half), after
   `~/ws-venv/bin/pip install yt-dlp` made `doctor --no-fix --json` report
   `ok: true` (remaining warnings: features not installed, ffmpeg 4.4, no deno,
   memory probe, tesseract):
   `MARS_WATCH_REAL_CLI=$HOME/ws-venv/bin/watch-skill PATH=$HOME/ws-venv/bin:$PATH bun test packages/watch/src/real-cli.test.ts`
   → 3 pass, 0 fail (3.4 s). The real CLI passed the doctor gate (`version`
   `1.4.3`, `available: true`), `mars_verify checks` listed `file_exists`,
   `mars_verify run` on a two-check `file_exists` contract returned
   `verdict pass · assurance isolated_local`, recorded `verified: true` with
   `required_checks {1,0,0}` and a `vr_…` run id, `mars_verify show` of that run
   rendered `verified`, `mars_loop status` on the real `state.json` fixture
   rendered `verdict pass · visual_advisory · advisory, not verified · loop
   status passed` (iteration 1), and `loop status lp_nope` rendered `error` with
   `loop.not_found`. This run found and fixed one incompatibility: `verify show`
   prints the stored bundle (`check_results[]`, `attestation.signature_status`),
   not the `verify run` summary shape; both are now normalised
   (`VerifyRunResultSchema`) and kept as fixtures
   (`test/fixtures/real-verify-*.stdout`).
8. `WATCHSKILL_OFFLINE=1 WATCHSKILL_DATA_DIR=/tmp/wsreal watch-skill loop status lp_real_fixture`
   → exit 0 against a `state.json` written by upstream's `LoopState.save()`
   (two iterations, critique `fail` 40 then `pass` 90, constructed in Python
   without a browser or model); stdout kept as
   `test/fixtures/real-loop-status.stdout`.

Not run against the real CLI: `watch`, `ask`, `search`, `capture`,
`loop start` / `loop iterate` (a real capture → critique iteration), `extract`,
any vision provider, any URL source.

### Unverified

Nothing below has been exercised against the real CLI or a real model; it is
covered by fixtures only or not at all.

- Browser (`http://…`) and screen (`screen:` / `window:`) capture through the
  wrapper, including the `allow_screen_capture` refusal path against a real
  display.
- THE LOOP's capture → critique iteration (`loop start` / `iterate` with a real
  browser and vision model). Reading upstream's real `state.json` and
  `loop status` output is covered by fixtures the real package produced; the
  loop itself never ran.
- Any model-backed critique or perception (`watch`, `ask`, vision providers).
- URL sources (yt-dlp) and non-loopback network targets.
- Installation of the `perceive` / `index` / `ocr` / `loop` / `attest` extras
  and Playwright chromium; a doctor run with `ok: true` was not observed.
- `verify run` through the wrapper (the real run above was direct), a real
  `fail` verdict with exit 1, `verify show` attestation re-checking and
  tamper detection.
- Live acceptance across roles (coordinator, worker, reviewer, research
  worker, delegated child) with a real Oh My Pi session.
- Evidence records appended to a parent task from a live child.
- Any performance, latency or cost figure.
