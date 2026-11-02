# MARS - Send You're AI To Space

An IDE-connected agent platform for completing work, retaining useful context, and promoting workflows and specialist models **only when independent evidence supports improvement**.

## Current increment: local coding workbench

The local workbench connects the VS Code client and CLI to durable tasks, isolated filesystem copies, checkpoints, and the Oh My Pi execution engine. It is a development integration, **not** a Milestone 1 acceptance claim. It contains:

- The unchanged [master specification](documentation/MASTER_SPECIFICATION.md).
- A [24-component source audit](documentation/SOURCE_REGISTER.md), with exact commits, licenses, APIs, integration owners, runtime requirements, risks, and proposed acceptance tests.
- Initial [shared TypeScript contracts](packages/contracts/src/index.ts), with runtime schemas for tasks, budgets, events, scope, and immutable artifact references.
- Oh My Pi start/resume/cancel/steer through the existing configurable model registry. No second agent loop or task database.
- Authenticated loopback RPC, private connection-file import into VS Code SecretStorage, task progress/artifacts/diffs, checkpoint/restore, and isolated task copies that leave the source checkout unchanged.
- Digest-pinned Docker execution with no host-shell fallback; command execution is disabled when no sandbox is configured.
- Offline integration tests using the actual SDK with injected model responses; these are **not** live-model or real VS Code UI acceptance evidence.
- A CLI diagnostic, source-pin validator, tests, and CI.
- The [MARS Output Format](documentation/OUTPUT_FORMAT.md): a deterministic, host-validated model-to-UI contract (`@mars/output-format`) for writing blocks, typed links, `app://` triggers, `mars://review` locations and `:mars-followup` buttons. Parsed output is untrusted text; follow-ups, app triggers and review links are proposals the host validates and the user confirms, never auto-run.

The memory service, skill service, evaluation, datasets, training, and specialist serving are **not implemented**. Research has a durable control plane and an offline-verified worker ([documentation/RESEARCH_WORKER.md](documentation/RESEARCH_WORKER.md)) that no host wires yet. The integration trust gate is a library, not an enabled third-party loader or approval UI. Real-model and real IDE acceptance remain unverified. See [local workbench setup and evidence limits](documentation/LOCAL_WORKBENCH.md) and [milestone gates](documentation/MILESTONE_0.md).

## Setup

Verified on Linux x86_64/glibc using **Bun 1.4.4**. Node alone cannot execute the upstream SDK. No API keys or GPU are needed for this increment.

Install [Bun](https://bun.sh/docs/installation) at the exact version:

```sh
curl -fsSL https://bun.sh/install -o install-bun.sh
bash install-bun.sh bun-v1.4.4
export PATH="$HOME/.bun/bin:$PATH"
bun --version
bun install --frozen-lockfile --ignore-scripts
bun run check
bun run doctor
```

The installer file is local setup tooling, not product source. Bun's bundled platform-native package is exercised by the smoke test. Other OS/CPU combinations and source-native builds remain unverified.

Lifecycle scripts stay disabled: optional `onnxruntime-node` and `protobufjs` postinstalls are **not required by these probes**. Voice/embedding/transformer functionality is untested; do not broadly trust dependencies to enable it.

## Commands

| Command | Purpose |
| --- | --- |
| `bun run check` | Lint, typecheck, offline source validation, tests, actual execution SDK/native initialization |
| `bun run doctor` | JSON diagnostic with explicit unimplemented features |
| `bun apps/cli/src/main.ts serve --help` | Local workbench service options; no provider request at startup |
| `bun run smoke:execution` | No-provider/no-tool SDK and native search probe |
| `bun run audit:sources` | Validate source references, spec digest, package pins, installed versions, and lockfile integrity |
| `bun run audit:sources:remote` | Fetch immutable source/license files and emit content hashes; network required |
| `bun apps/cli/src/main.ts render [file]` | Parse and render a MARS Output Format reply in the terminal (framed artifacts, numbered follow-up chooser); offline, no model call |
| `bun run format` | Apply Biome formatting and import organization |

A small Bun build emits the CLI and provider library bundles with `bun run build`; the execution package still runs TypeScript directly. There are no existing database migrations, production data, or schema-upgrade guarantees at version 0.0.1.

## Models

The model-provider package is a library for future execution integration; it does not create a second session or tool loop. Oh My Pi remains the sole live execution/session owner. The default route is `openrouter/free`, `google/gemma-4-31b-it:free`, `nvidia/nemotron-3.5-super-vl:free`, then `poolside/laguna-s-2.1:free`. These are configured presets, not live-verified availability claims. Free tiers are rate-limited, may be unavailable or change, and are not guaranteed or an entitlement. The default policy is `allowPaid: false`: paid models are skipped, with no paid fallback unless the user explicitly enables that policy.

| Provider | Credential environment variable | Free-tier note | Documentation |
| --- | --- | --- | --- |
| OpenRouter | `OPENROUTER_API_KEY` | Free model IDs; rate limits and availability may change | [Limits](https://openrouter.ai/docs/api-reference/limits) |
| Gemini | `GEMINI_API_KEY` | Rate-limited free tier; may be unavailable or change | [OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai) |
| Groq | `GROQ_API_KEY` | Rate-limited free plan; may be unavailable or change | [Rate limits](https://console.groq.com/docs/rate-limits) |
| GitHub Models | `GITHUB_TOKEN` | Free prototyping tier; may be rate-limited, unavailable, or change; check terms | [GitHub Models](https://docs.github.com/en/github-models) |
| NVIDIA | `NVIDIA_API_KEY` | Developer access may be rate-limited, unavailable, or change; check terms | [Build](https://build.nvidia.com) |
| Cerebras | `CEREBRAS_API_KEY` | Trial credits require a payment method; disabled by default and not free by default | [Rate limits](https://inference-docs.cerebras.ai/support/rate-limits) |
| Ollama | None | Local inference; no provider API key required | [Ollama](https://ollama.com) |

Use the CLI to configure a provider and model. Store only the environment variable **name** in configuration, never its value. Custom models are treated as paid by default; use `--free` only after verifying that the model is free:

```sh
bun apps/cli/src/main.ts models add-provider \
  --id custom --base-url https://models.example/v1 --api-key-env CUSTOM_API_KEY
bun apps/cli/src/main.ts models add \
  --provider custom --model vendor/model-name --id custom/model-name \
  --tools --context 32768
bun apps/cli/src/main.ts models list --free
bun apps/cli/src/main.ts models providers
```

The same configuration can be managed in `~/.mars/models.json` (or `$MARS_HOME/models.json`). A project `.mars/models.json` is ignored by default and the CLI prints a warning. Load it only for a trusted checkout with `models --trust-project <subcommand>` or `MARS_TRUST_PROJECT_CONFIG=1`; trusted project files may add providers and models, but may not redefine built-in or user providers or change the user-controlled `policy.allowPaid`. A project model claiming `free: true` on a provider the project does not define is downgraded to paid with a notice. Project providers can declare their own `apiKeyEnv` only when the project file is explicitly trusted.

```json
{
  "version": 1,
  "providers": [
    {
      "id": "custom",
      "kind": "openai-compatible",
      "baseUrl": "https://models.example/v1",
      "apiKeyEnv": "CUSTOM_API_KEY"
    }
  ],
  "models": [
    {
      "id": "custom/model-name",
      "providerId": "custom",
      "model": "vendor/model-name",
      "capabilities": {
        "tools": true,
        "vision": false,
        "contextWindow": 32768
      },
      "pricing": { "free": false }
    }
  ],
  "routes": { "default": ["openrouter/free", "custom/model-name"] },
  "policy": { "allowPaid": false }
}
```

The registry layers built-in presets, user configuration, and—only with explicit opt-in—project configuration. The router filters by model capabilities, provider availability, and paid-model policy. On retryable provider failures it observes `Retry-After` when available (otherwise a 30-second cooldown) and tries the next eligible route candidate; non-retryable failures stop routing. It never falls back to a paid model under the default policy. `models discover <providerId>` lists provider models, `--save` persists models marked free only when discovery reports zero pricing, and `models test <modelId>` explicitly makes a live test request. No live provider request was executed during development; checks use local stub servers or fixture data.

## Ownership boundaries

- **Oh My Pi** is the sole live execution/session/tool owner. Its append-only journal will be the canonical history; any MARS history index is a rebuildable projection, not a second transcript writer.
- **One MARS memory service** owns profile/project facts and scoped recall, adapting Hermes semantics. Knowledge artifacts and procedures are separate stores.
- **One MARS skill service** owns procedure revisions/drafts/undo; **one review scheduler** proposes learning changes. Do not run upstream memory/review daemons independently beside them.
- **Cline patterns** inform editor presentation/checkpoints, not another live execution engine.
- Evaluation, optimization, remote workspaces, browser work, training, and serving are versioned worker/provider adapters. A workspace interface is not an OS sandbox.

The exact [source manifest](sources/manifest.json) distinguishes audited source HEADs from installed release artifacts. A matching version string is not proof of source/binary equivalence. No upstream source is vendored; retain artifact-specific notices before redistribution.

## Next gate

Build the durable task/event adapter and VS Code workbench, with real model execution, bounded tool approvals, checkpoint restore, cancellation, and restart/resume evidence. Select the initial model/provider and a concrete OS isolation policy before enabling executable tools. Python worker environments and GPU training are later, separate gates.
