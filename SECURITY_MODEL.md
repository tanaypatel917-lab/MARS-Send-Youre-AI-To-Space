# MARS threat model

Covers three repositories scanned together: `tanaypatel917-lab/MARS-Send-Youre-AI-To-Space` (the agent platform), `tanaypatel917-lab/mars-platform` (memory, skills, review runner, gateway probe) and `tanaypatel917-lab/MARS` (the public intro website). No infrastructure repository exists yet; the only deployment artifact is `MARS/vercel.json` (static hosting). Drafted from the code and the repositories' own docs (`documentation/LOCAL_WORKBENCH.md`, `documentation/WORKBENCH_RPC.md`, `documentation/INTEGRATION_TRUST.md`, `packages/workspaces/README.md`, `mars-platform/README.md`, `tools/gateway-probe.md`), then corrected by the owner's answers (2026-11-01).

## Owner decisions (from the user)

- **Deployment**: today everything runs locally on one developer machine, but the platform **will be exposed to remote users/hosts later**. Loopback-only, single-user assumptions in the code are therefore temporary, and findings that only matter once the service is reachable from another host still count.
- **Attackers**: *all* of the profiles below are in scope; none is ruled out.
- **Assets**: all assets below are treated as equally critical.
- **MARS website**: treated the same as the rest, not as low priority.
- **Infrastructure repo**: none yet ("not yet").
- **Finding tags**: `Component`, `CWE`, `Repository`, `OWASP`.
- Nothing has been declared out of scope or accepted risk.

## System overview and trust boundaries

```
 VS Code extension (apps/vscode)  --HTTP loopback, bearer token-->  Workbench RPC (packages/workbench)
 CLI `mars serve` (apps/cli)      ----------------------------------^        |
                                                                              v
                                   Task store (packages/tasks, SQLite) <-> Workbench host adapter
                                   Workspaces (packages/workspaces): private copy of the source + Docker sandbox
                                   Execution (packages/execution): Oh My Pi SDK session, model calls via Providers
                                   Providers (packages/providers): OpenRouter/Gemini/Groq/GitHub/NVIDIA/Cerebras/Ollama, keys from env
                                   Integration trust (packages/integration-trust): default-deny gate for MCP/plugins/skills (library only)

 mars-platform: Memory store (services/memory) + Skills (packages/skills) on local files, Review runner (services/review)
                calling an OpenAI-compatible model endpoint, Gateway probe (tools/gateway-probe) to a local OpenClaw gateway.

 MARS website: static Vite/Three.js site on Vercel; `src/how/scorer.ts` has a placeholder RemoteScorer POSTing traces to a future API.
```

Trust boundaries:

1. **Host process vs. agent workspace.** The host (CLI/IDE, holding API keys, the bearer token and the HMAC approval key) must never be influenced by workspace content, model output or tool output. The workspace copy under `~/.mars/workbench/<project-id>` is untrusted data.
2. **RPC client vs. workbench service.** `serveWorkbench` binds `127.0.0.1`, requires `Authorization: Bearer <token>` (32–256 chars, constant-time compared via SHA-256 digests), rejects `Origin` headers, non-loopback `Host`, query strings and bodies over 512 KiB (`packages/workbench/src/server.ts`). The token lives in `connection.json` (mode 0600) and in VS Code SecretStorage. This boundary becomes the main attack surface once the service is exposed remotely.
3. **Sandbox vs. host.** `createDockerSandbox` runs commands with `--network none`, `--read-only`, non-root `--user`, `--cap-drop`, memory limits, digest-pinned image only; execution is disabled without `--image` (`packages/workspaces/src/sandbox.ts`). No host-shell fallback.
4. **Untrusted project config vs. user config.** `.mars/models.json` in a project is ignored unless `--trust-project`/`MARS_TRUST_PROJECT_CONFIG=1`; only env-var *names* are stored, never key values (`packages/providers/src/models/registry.ts`).
5. **Integrations vs. platform.** `@mars/integration-trust` is a default-deny gate with HMAC-signed approvals and binding-digest drift detection; it is not yet wired into any loader.
6. **Model/review output vs. authoritative memory.** `services/review` can only `submitProposal`; `MemoryStore` is the single writer and runs the threat scanner in `services/memory/src/threats.ts` (injection, exfiltration, hardcoded secrets, invisible Unicode) on new content.
7. **Browser vs. static site.** The website runs entirely client-side; the only outbound call is the unused `RemoteScorer`.

## Components

| Component | Code | Boundary side |
| --- | --- | --- |
| `Workbench RPC` | `MARS-Send-Youre-AI-To-Space/packages/workbench`, `apps/cli` (`serve.ts`, `main.ts`) | Host service; network entry point |
| `VS Code Client` | `MARS-Send-Youre-AI-To-Space/apps/vscode` | IDE client; holds token in SecretStorage |
| `Workspaces & Sandbox` | `MARS-Send-Youre-AI-To-Space/packages/workspaces` | Host side of the filesystem/Docker boundary |
| `Execution & Tasks` | `MARS-Send-Youre-AI-To-Space/packages/execution`, `packages/tasks`, `packages/contracts` | Host; agent loop owner, durable state |
| `Providers` | `MARS-Send-Youre-AI-To-Space/packages/providers` | Host; credentials, outbound model HTTPS |
| `Integration Trust` | `MARS-Send-Youre-AI-To-Space/packages/integration-trust` | Host gate for third-party code |
| `Memory & Skills` | `mars-platform/services/memory`, `packages/skills` | Authoritative local stores of personal data |
| `Review Runner` | `mars-platform/services/review` | Background model caller, proposal-only |
| `Gateway Probe` | `mars-platform/tools/gateway-probe*` | Local OpenClaw client, handles a gateway token |
| `Website` | `MARS/src`, `MARS/index.html`, `MARS/how.html`, `MARS/scripts`, `MARS/vercel.json` | Public static site |
| `Build & CI` | `.github/workflows/*`, `scripts/`, lockfiles, `sources/` in all repos | Supply chain |

## Entry points and who can reach them

- `POST /v1/rpc` on the workbench (today: any process on the same host that has the token; later: remote users). Methods: `tasks.create/start/resume/steer/cancel/events/artifact/diff/checkpoint/restore`, `workbench.describe`.
- `connection.json` import into VS Code (any local file the user picks; parsed strictly in `apps/vscode/src/connectionFile.ts`).
- Files in the task workspace, task prompts, model and tool output (reach Execution, Workspaces, Tasks; indirectly the IDE via diffs/artifacts — `apps/vscode/src/pathSafety.ts`, `patch.ts`).
- Project `.mars/models.json` and `~/.mars/models.json` (Providers).
- Integration manifests, evidence and approval proofs (Integration Trust).
- Memory/skill content from users, curators and the review model; `MARS_REVIEW_BASE_URL` responses (Memory & Skills, Review Runner).
- OpenClaw gateway WebSocket frames and `OPENCLAW_GATEWAY_TOKEN` / dev config (Gateway Probe).
- Website: user-uploaded trace JSON (`tracesFromJson`), query-string `?frame=` review states, `innerHTML` templating in `src/main.ts`; future `RemoteScorer` endpoint.
- CI: `push`/`pull_request` workflows with `contents: read`; `bun install --frozen-lockfile --ignore-scripts`, `pnpm install --frozen-lockfile`, pinned source digests in `sources/`.

## Assets and data sensitivity (all equally critical per owner)

- Provider API keys in the host environment (`OPENROUTER_API_KEY`, `GEMINI_API_KEY`, …) and the OpenClaw gateway token.
- Workbench bearer token (`connection.json`, SecretStorage) and the integration-trust HMAC approval key.
- The user's real source checkout (must never be modified by tasks) and the rest of the host filesystem.
- Task store, journals and checkpoints (`tasks.sqlite`, Oh My Pi session journal; `session_file` paths are host-private).
- `MEMORY.md`, `USER.md`, `journal.jsonl`, skills: personal data and preferences, mode 0600.
- Integrity of model configuration (`allowPaid: false`, free-only routing) and of approval/grant state.
- Website integrity and visitor browsers (XSS, supply chain through fonts/scripts).

## Attacker profiles (all in scope)

1. **Malicious repository / prompt injection**: content in the scanned project or workspace that steers the agent, smuggles secrets out via diffs/artifacts, or escapes the private copy (path traversal, symlinks).
2. **Malicious or compromised model / tool output**: forged events, artifact paths, approval-looking strings, review proposals with injection.
3. **Malicious third-party integration, skill or MCP server**: tries to get admitted or invoked without a verified grant, or to drift after approval.
4. **Co-resident local process or malicious website**: reaches the loopback RPC (token theft from files/logs, DNS rebinding, CSRF), reads 0600/0700 state, races lock files.
5. **Remote network attacker** (future exposure): authentication bypass, token brute force, request smuggling, DoS through oversized payloads, missing TLS.
6. **Supply chain**: compromised npm/bun/pnpm dependencies, unpinned actions, tampered `sources/` mirrors, Docker images not digest-pinned.

## Existing controls

- Loopback bind, bearer token with constant-time compare, Origin/Host rejection, 512 KiB/4 MiB limits, fixed error messages, `Cache-Control: no-store` (`packages/workbench/src/server.ts`).
- Token rotation on every `mars serve` start; 0700 state dir, 0600 connection file; token never logged (`apps/cli/src/serve.ts`).
- Strict Zod schemas on contracts, RPC context with exact owner/project/workspace scope and expected revisions; `assertPublishable` keeps host-private paths out of public events (`packages/tasks`).
- Private workspace copy, secret-file exclusion (`ignored-secret`), symlink/special-file rejection, content-addressed checkpoints, fail-closed `IntegrityError` (`packages/workspaces/src/provider.ts`).
- Digest-pinned, network-less, read-only, non-root Docker sandbox; execution disabled without it (`sandbox.ts`).
- Untrusted project config by default; env-var names only; no paid fallback (`packages/providers`).
- Default-deny integration gate with HMAC approvals, nonce single use, binding digest drift → superseded (`packages/integration-trust`).
- Memory single writer with cross-process lock, atomic transactions, threat scanner with NFKC normalization, 0600 files; review runner is proposal-only, HTTPS required off-loopback, redirects rejected, bounded tokens/bytes (`mars-platform`).
- Gateway probe: loopback-only `ws://127.0.0.1`, token from env, redaction of credential fields.
- CI with `contents: read`, pinned action SHAs (platform repo), frozen lockfiles, `--ignore-scripts`, source digest audit (`scripts/check-sources.ts`).

## Out of scope / accepted risk

None declared by the owner. The unimplemented features named in the README (memory service wiring, research, evaluation, training, specialist serving) are not reachable yet but are not excluded from reporting.

## Open questions

- When the platform goes remote, what authentication replaces the single bearer token (per-user identity, TLS termination, reverse proxy)? Findings about multi-tenant scope enforcement will be judged assuming untrusted remote callers.
- Will the website's `RemoteScorer` endpoint ever ship, and if so, where will it be hosted?
- Which host will run `mars-platform` memory/review services once shared across users?
