# ADR 0001: MARS Shell window framework

- Status: accepted (owner may veto on the PR that adds `apps/shell`)
- Date: 2026-11-04
- Context: `documentation/UI_PROMPT.md` §3 (MARS Shell), §3.6 (contract reuse, no second loop), §7, §8.2 PR 3, A.6 open item 10

## Context

MARS Shell is a desktop window over the loopback workbench RPC (`documentation/WORKBENCH_RPC.md`). It owns no model, no tools, no history and no agent loop. Its renderer may import only `@mars/ui-core` and `@mars/output-format`. The repository is a Bun 1.4.4 TypeScript monorepo whose CI (`bun run check`) runs on headless Linux with no display and no network beyond `bun install`.

Two facts about the existing RPC shape the choice:

1. The workbench server refuses browser-origin requests, requires a bearer token from a mode-0600 connection file, and answers only `POST /v1/rpc` on `127.0.0.1`. The renderer therefore cannot and must not call it: a privileged process has to read the token, hold it, and forward a fixed set of read methods.
2. The wire contract is a set of strict zod schemas in TypeScript (`@mars/contracts`, `packages/workbench/src/protocol.ts`, mirrored in `apps/vscode/src/protocol.ts`). Whatever process forwards the calls must validate requests and results against those schemas and verify artifact SHA-256 before anything reaches the renderer.

## Criteria

| Criterion | Electron 44.10.x | Tauri 2.12.x |
| --- | --- | --- |
| Strict CSP + textContent-only rendering | Custom `mars-shell://` protocol serves the renderer with a CSP header and a matching `<meta>`; `default-src 'none'`, no `unsafe-inline`/`unsafe-eval`, no remote origins. Chromium enforces it. | Same CSP achievable (`tauri.conf.json` `security.csp`), WebKitGTK/WebView2/WKWebView enforce it, but Tauri injects its own IPC scripts and rewrites the CSP with hashes/nonces unless `dangerousDisableAssetCspModification` is set. |
| No Node/privileged API reachable from the renderer | `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`; the preload exposes one frozen object with exactly the nine read methods via `contextBridge`; navigation, `window.open`, permission requests and non-app protocols are denied in the main process. Node exists only in the main process. | No Node at all; privileged code is Rust commands gated by capabilities. Strong by construction. |
| Loopback-only RPC bridge | Main process in TypeScript: reuses `@mars/contracts` schemas directly, same strict validation and loopback/connection-file rules as `apps/vscode`, unit-testable under `bun test` with the real `serveWorkbench` transport. | Bridge in Rust: the strict schemas would be re-implemented in `serde` (a second, drifting copy of a frozen protocol the repo already polices for drift), or a Bun/Node sidecar would be added next to the Rust core (two privileged processes). |
| Binary size | Large: ~100 MB+ per platform (Chromium + Node). | Small: a few MB plus the system webview. |
| Build/test offline on headless Linux CI | Renderer, preload and main are bundled by `Bun.build`; all bridge, CSP, whitelist and DOM-serialiser tests run in `bun test` with no Electron binary and no display. `electron` 44 has no install script: the binary is fetched only by the opt-in `install-electron` step, so `bun install --frozen-lockfile --ignore-scripts` is unchanged in cost. | Native build needs a Rust toolchain, a few hundred crates from crates.io and the `webkit2gtk-4.1`/`libsoup-3.0` development packages on Linux. The VM has Rust 1.99 but none of the WebKitGTK packages; CI would need new apt provisioning plus a crates.io fetch on every cold build. Renderer tests would still run in Bun. |
| Licensing | MIT (Electron), Chromium BSD-3 + bundled third-party notices. | MIT OR Apache-2.0 (Tauri), system webview under the OS licence. |
| Reproducible pinned versions | Exact `electron@44.10.2` in `apps/shell/package.json` and `bun.lock` (sha512 integrity); `@electron/get` verifies the downloaded binary against the release `SHASUMS256.txt`. | `Cargo.lock` + npm pins; reproducible, but the WebKitGTK version is whatever the distro ships, so rendering differs per machine. |

Version choice: Electron supports the latest three majors (43, 44, 45 on 2026-11-04). 45.0.0 shipped 2026-10-21 and is the newest major, so it is not chosen. 44 shipped 2026-08-25 and has had ten minor releases; `44.10.2` is its current security patch. 43 is older but leaves support first (when 46 ships). Pin `44.10.2` exactly; move to the next patch of 44 for security fixes, and to a new major only by a PR that re-reads this ADR.

## Decision

**Electron**, pinned to `44.10.2`, in `apps/shell`.

The deciding criterion is the bridge: the only privileged code the Shell has is "read a connection file, forward nine read methods, validate strictly, verify SHA-256". In Electron that code is TypeScript that imports the same `@mars/contracts` schemas the server validates with, and it runs under `bun test` against the real loopback transport on headless CI. Tauri would move it to Rust (a second copy of a frozen protocol) or add a sidecar, and its native build cannot run on the current CI.

## Rejected: Tauri

Rejected for this scope because (1) the bridge would need a Rust re-implementation of the strict wire schemas or a second privileged sidecar process; (2) its native build needs crates.io downloads and WebKitGTK development packages that neither CI nor the VM provide today, so the native path would be untested; (3) rendering would vary with the distro's WebKitGTK. Its real advantages — a much smaller binary and no Node in the app at all — are acknowledged and are the main cost of this decision.

## Consequences

- Node exists in the Shell's main process. The main process must stay a thin, audited bridge: no model calls, no shell, no file access on behalf of the renderer, no tools. Tests in `apps/shell` assert the preload exposes exactly the nine read methods and the main-process handler refuses anything else.
- The renderer is plain DOM code bundled for the browser target; it imports only its own modules, `@mars/ui-core` and `@mars/output-format` (a test enforces the import allowlist).
- `bun run check` covers renderer, bridge, CSP and serialiser tests. Launching a window is an opt-in script (`bun run --cwd apps/shell native:install` then `start`), never part of `check`.

## Open items

1. Packaging and signing (electron-builder or `@electron/packager`), Electron fuses (`RunAsNode`, `EnableNodeCliInspectArguments`, `OnlyLoadAppFromAsar` off/on), auto-update: not in this scope; no update channel exists.
2. Electron is a dev dependency, not a borrowed source; it has no `sources/manifest.json` component entry. Add one if a later PR vendors or patches it.
3. The Linux Chromium sandbox needs unprivileged user namespaces or a setuid `chrome-sandbox`; if a machine has neither, the window does not start. The Shell never disables the sandbox in code.
4. Binary size is accepted; revisit (Tauri or a system-webview wrapper) if distribution size becomes a requirement.
5. The axe accessibility test of criterion 13 needs a fuller DOM than the PR 3a serialiser; decide jsdom vs happy-dom when the transcript lands.
