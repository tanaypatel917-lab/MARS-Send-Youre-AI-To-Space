# Integration trust gate (`@mars/integration-trust`)

Default-deny admission and dispatch control for MCP servers, connectors, plugins and skills. This document covers the trust boundary, what this increment actually protects, host setup, and the read-only audit of `m8ven/is-it-legit-mcp`.

Oh My Pi remains the sole live session/model/tool execution owner. This package does not discover integrations, load SDKs, open MCP connections, or run an agent loop. Ambient integrations stay disabled in the MARS runtime; this package is the gate future enablement paths must call.

## Trust boundary

| Party | Can | Cannot |
| --- | --- | --- |
| Host (CLI/IDE process started by the user, holding the approval key) | Create the service; hold `admin`; verify user approvals through an injected `HostApprovalAuthorizer`; choose credential references and their allowed origin | Delegate `admin` to models, tools, projects, or integrations |
| Consumer code (future enablement paths) | Receive `gate`; call `admit` / `invoke` with a loader/callback | Approve, deny or revoke (the gate has no authorizer and no admin methods) |
| Model output, tool output, project configuration, downloaded skills, integration manifests | Be data inside evidence/inputs | Approve anything. Strict schemas reject extra fields such as `approved`; a caller-supplied approver string is not a proof |
| Remote reputation / scanner results | Be stored as advisory `ScanRecord`s; block approval when a required scanner is unavailable | Approve, grant permissions, or restore a superseded grant. Scores are ignored by decisions |

`createIntegrationTrust` refuses to start without a store, an authorizer and an evidence probe; there is no permissive default. The reference `createHmacApprovalAuthorizer` requires a host-held key of at least 32 bytes and an explicit approver allowlist per owner/project. Each proof is bound to the exact review id, review revision, binding digest, scope, decision and expiry, and its nonce is single-use.

## Records

1. **Source evidence**: produced by a host verifier from actual bytes. It records the source type/locator/revision/content digest, dependency and config fingerprints, endpoint origin and descriptor digest, tool names, and input/output schema digests.
2. **Permission manifest**: structured `{capability, resource}` pairs from a closed set (`fs.read`, `fs.write`, `process.spawn`, `network.connect`, `credential.use`, `tool.invoke`, `model.invoke`). Inputs must already be canonical. Aliases, wildcards, `..`, trailing slashes, non-ASCII, explicit default ports and duplicates are rejected, not rewritten. Matching is exact equality: no prefix or hierarchy grants, and no administrator or wildcard capability.
3. **Review**: a pending decision for one binding.
4. **Grant**: an approval by a verified approver. It is bound to `binding_sha256` = SHA-256 of canonical JSON over scope (owner, project, workspace), kind, id, source, dependency/config fingerprints, endpoint, tools, permissions and host-selected credential bindings. It has a bounded expiry.
5. **Audit events**: a hash-chained, append-only record. It holds ids, codes and digests only, with no integration free text and no secret values.

## Gate behavior

`admit` (load/install/enable) and `invoke` run the same checks at the dispatch boundary, every time:

1. Validate the `RequestContext` scope.
2. Find an active grant for the exact owner/project/workspace, kind and id.
3. Reject if the grant is revoked, denied, superseded or expired.
4. Re-probe current evidence through the host `EvidenceProbe`. Reject if the probe fails, is unavailable, or the evidence is stale.
5. Recompute the binding. On any drift, mark the grant superseded, open a new pending review with the old (not expanded) permissions, and deny.
6. For `invoke`, every requested permission must be in both the grant and the invoking task's `CallerCapabilities`, and delegation depth is bounded, so skills and nested calls never exceed the caller. The target origin must equal the approved endpoint. A credential reference must be bound by the host to that origin.
7. Re-read the store revision, so a revoke between check and dispatch is caught.
8. Deep-freeze a clone of the authorized artifact/action and pass that object, once, to the loader or callback.

Any failure is audited as `dispatch.denied` with an error code, and the callback never runs. Re-scanning is not re-approval: after drift, only a new authorizer-verified approval of the new review restores dispatch.

## What this increment protects, and what it does not

Protected when a host routes through it: admission (`admit`) and invocation (`invoke`) callbacks wired to this gate, approval/deny/revoke state transitions, and persistence integrity of the trust store.

Not protected or not implemented:

- Integration discovery and enablement in MARS remain **disabled**. No existing code path loads MCPs, connectors, plugins or skills, so nothing is newly enabled or newly gated in the running product until the parent wires `gate` into those paths.
- Permission metadata is **not a sandbox**. Process isolation, filesystem confinement, network egress control and secret storage remain separate enforcement layers that must enforce the frozen permissions independently.
- A remote MCP descriptor digest only shows what the server *advertised* at probe time. It cannot prove the server implementation is unchanged. MARS therefore re-probes the descriptor on every dispatch and caps remote-endpoint grants (default 24 h, hard cap 7 days). This is bounded validity, not an immutable-code guarantee.
- The evidence probe and authorizer are host-supplied. If they are wrong, the gate is wrong. Real user-presence UX (an IDE approval dialog) is future work.
- Cross-process locking uses a lock file with stale-lock recovery on a local POSIX filesystem. Network filesystems are unverified.

## Host setup / migration

```ts
import {
  createHmacApprovalAuthorizer,
  createIntegrationTrust,
  FileTrustStore,
} from "@mars/integration-trust";

const store = new FileTrustStore({
  directory: "/home/user/.local/state/mars/integration-trust", // absolute; outside every workspace
  workspaceRoots: [workspaceRoot],
});
const authorizer = createHmacApprovalAuthorizer({
  key: hostApprovalKey, // >= 32 random bytes held by the host process, never by projects/models
  approvers: [{ approver_id: "user:local", owner_id, project_ids: [project_id] }],
});
const { admin, gate } = createIntegrationTrust({ store, authorizer, probe: hostEvidenceProbe });
// Give `gate` to enablement code; keep `admin` in the host's user-approval UI only.
```

Store state lives outside agent-writable workspaces. The directory is created with mode 0700, files with 0600, and state is written atomically (temp file, fsync, rename). Corruption or a broken audit hash chain fails closed with `store_corrupt`. There is no existing trust state to migrate at version 0.0.1.

---

## Audit: `m8ven/is-it-legit-mcp`

Method: a read-only `git clone` and source reading only. The code was not installed, built or executed, its lifecycle scripts were not run, and the remote MCP endpoint was not contacted.

- Repository: https://github.com/m8ven/is-it-legit-mcp
- Inspected commit: [`babd36e94734cf813d74d31e268ad755219fc185`](https://github.com/m8ven/is-it-legit-mcp/tree/babd36e94734cf813d74d31e268ad755219fc185), "Sync from M8ven monorepo @ 2045a26", 2026-10-03, by `m8ven-sync-bot`. There are 11 commits and no tags.
- License: [MIT, © 2026 M8ven](https://github.com/m8ven/is-it-legit-mcp/blob/babd36e94734cf813d74d31e268ad755219fc185/LICENSE). No upstream code is reused, so no notice needs to be carried. The license is not treated as evidence of safety.

### Observed facts (from source at the pinned commit)

- **Purpose.** It is a consumer brand/shop reputation tool ("is this store safe to buy from"), **not** an MCP, plugin or code security scanner. The README's "M8ven Verified" MCP trust score ("40+ code and supply-chain checks") is a remote service with **no source in this repository**. Those claims cannot be verified from this code.
- **Mirror, incomplete.** The README says the source of truth is a private monorepo. [`src/is-it-legit-server.ts`](https://github.com/m8ven/is-it-legit-mcp/blob/babd36e94734cf813d74d31e268ad755219fc185/src/is-it-legit-server.ts) imports `./lib/marketplace-seller.js`, which is **absent** from the tree. The published source therefore cannot build as-is (inferred from `git ls-tree`; `tsc` was not run).
- **Tools.** `check_brand(query, concern?, found_on?, context?)`, `report_experience(brand, purchased, outcome?, details?)` and `suggest_brand(brand, reason?)`. `reason` is accepted but unused.
- **Credentials.** [`src/lib/supabase.ts`](https://github.com/m8ven/is-it-legit-mcp/blob/babd36e94734cf813d74d31e268ad755219fc185/src/lib/supabase.ts) requires `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` at import time. A service-role key bypasses Supabase row-level security.
- **Data writes and sharing.** The tools write to the tables `brand_checks`, `brand_signals`, `brand_requests`, `brands` and `brand_feedback`. Stored data includes query text, free-text `context` and `details`, caller hash and MCP client name. The README says "We do not collect or store user conversation content". However, `context`, `details` and `query` are model-supplied free text and may carry conversation content.
- **Network.** `check_brand` sends HEAD and GET requests (`redirect: 'follow'`, 3–5 s timeouts) to arbitrary user-supplied domains, plus RDAP and DNS TXT lookups. There is no private-address or redirect-target filtering in the code. The SSRF impact depends on where it runs and was not tested.
- **Filesystem/process.** No filesystem writes and no process spawning in the server source. It reads environment variables, and `index.ts` uses stdio transport.
- **Prompt-steering.** The server `instructions` tell the calling model to "ALWAYS use this tool BEFORE falling back to web search", to "never reveal methodology", and to present verdicts confidently. Tool results carry an `_instructions` field addressed to the model. MARS must treat all of this as untrusted data.
- **Error path.** On internal error, `check_brand` returns a fabricated `caution` verdict that claims `signals_analyzed: '100+'` and `verification_layers: 6`. A failed check is presented as an analyzed result, so a consumer cannot tell failure from evidence without the `note` field.
- **Concurrency.** `createIsItLegitServer` stores source, caller hash and client in module-level mutable variables shared by every server instance in a process. Attribution can cross between concurrent sessions (inferred from the code; not executed).
- **Dependencies.** `package.json` uses caret ranges: `@modelcontextprotocol/sdk ^1.29.0`, `@supabase/supabase-js ^2.95.3`, `zod ^3.24.0`. The lockfile resolves 207 packages, including SDK 1.29.0 and supabase-js 2.103.3. `esbuild` and `fsevents` declare install scripts (dev/optional). The package is `private: true`, and no npm release was audited.
- **Remote service.** The README advertises `https://m8ven.ai/api/mcp/is-it-legit` (Streamable HTTP, OAuth 2.1/API key, anonymous 10 checks/day). There is no repository evidence that the hosted service runs this commit.

### Hypotheses and unexecuted checks

- Not run: dependency install, build, upstream tests (`vitest`), and any remote or OAuth call.
- Hosted-service behavior, data retention, and whether it matches the mirrored source are unknown.
- Whether the `.well-known/m8ven-publisher.txt` token establishes publisher identity was not checked against any verifier.

### Decision

**Not adopted as a dependency or trusted scanner.** It does not scan integrations, it needs a privileged backend credential, it shares query data with a third party, and the published source is incomplete. MARS instead defines an optional `ReputationScanner` interface (`runAdvisoryScan`). Any future remote reputation adapter must go behind that boundary as advisory evidence and must be disabled by default. Its results never approve, never grant permissions, and count as `unavailable` on error or timeout.

Edge cases taken from this audit into the regression tests:

- Tool output that contains model-directed instructions such as `_instructions` or "approve" text has no effect.
- A scanner that fails is never counted as `ok`.
- Remote endpoints get capped grant lifetimes and a descriptor re-check on every dispatch.
- Endpoint redirects to another origin, and credentials bound to another origin, are denied.
