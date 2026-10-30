# MARS - Send You're AI To Space

An IDE-connected agent platform for completing work, retaining useful context, and promoting workflows and specialist models **only when independent evidence supports improvement**.

## Current increment: source and integration baseline

This is not yet a usable coding agent or IDE extension. It contains:

- The unchanged [master specification](documentation/MASTER_SPECIFICATION.md).
- A [24-component source audit](documentation/SOURCE_REGISTER.md), with exact commits, licenses, APIs, integration owners, runtime requirements, risks, and proposed acceptance tests.
- Initial [shared TypeScript contracts](packages/contracts/src/index.ts), with runtime schemas for tasks, budgets, events, scope, and immutable artifact references.
- Actual Oh My Pi SDK initialization, native search, and journal persistence/reopen probes; **no model request, coding task, or training run**.
- A CLI diagnostic, source-pin validator, tests, and CI.

The IDE, task service, approvals/sandbox, memory service, skill service, research, evaluation, datasets, training, and serving are **not implemented**. Contracts describe intended interfaces; they do not provide enforcement or persistent services. See [milestone evidence and gates](documentation/MILESTONE_0.md).

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
| `bun run smoke:execution` | No-provider/no-tool SDK and native search probe |
| `bun run audit:sources` | Validate source references, spec digest, package pins, installed versions, and lockfile integrity |
| `bun run audit:sources:remote` | Fetch immutable source/license files and emit content hashes; network required |
| `bun run format` | Apply Biome formatting and import organization |

No application build is needed yet: Bun executes TypeScript directly. There are no existing database migrations, production data, or schema-upgrade guarantees at version 0.0.1.

## Ownership boundaries

- **Oh My Pi** is the sole live execution/session/tool owner. Its append-only journal will be the canonical history; any MARS history index is a rebuildable projection, not a second transcript writer.
- **One MARS memory service** owns profile/project facts and scoped recall, adapting Hermes semantics. Knowledge artifacts and procedures are separate stores.
- **One MARS skill service** owns procedure revisions/drafts/undo; **one review scheduler** proposes learning changes. Do not run upstream memory/review daemons independently beside them.
- **Cline patterns** inform editor presentation/checkpoints, not another live execution engine.
- Evaluation, optimization, remote workspaces, browser work, training, and serving are versioned worker/provider adapters. A workspace interface is not an OS sandbox.

The exact [source manifest](sources/manifest.json) distinguishes audited source HEADs from installed release artifacts. A matching version string is not proof of source/binary equivalence. No upstream source is vendored; retain artifact-specific notices before redistribution.

## Next gate

Build the durable task/event adapter and VS Code workbench, with real model execution, bounded tool approvals, checkpoint restore, cancellation, and restart/resume evidence. Select the initial model/provider and a concrete OS isolation policy before enabling executable tools. Python worker environments and GPU training are later, separate gates.
