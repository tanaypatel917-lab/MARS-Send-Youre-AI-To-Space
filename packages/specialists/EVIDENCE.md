# Verification evidence

This file records the required hermetic verification for `@mars/specialists`.
The fixtures used by the package tests are synthetic and are not real
evaluations.

## Required commands and results

| Command | Result |
| --- | --- |
| `export PATH="$HOME/.bun/bin:$PATH" && bun test packages/specialists` | PASS — 32 passed, 0 failed, 250 assertions. |
| `export PATH="$HOME/.bun/bin:$PATH" && bun run lint` | PASS — Biome checked 118 files; no fixes required. |
| `export PATH="$HOME/.bun/bin:$PATH" && bun run typecheck` | PASS — `tsc --noEmit` completed successfully. |
| `export PATH="$HOME/.bun/bin:$PATH" && bun run check` | PASS — lint and typecheck passed; source audit validated 25 entries and pinned artifacts; full test suite: 375 passed, 7 skipped, 0 failed, 2,270 assertions across 382 tests in 24 files; smoke reported `model_requests: 0`; build bundled 27 modules. |

The first `bun run check` attempt did not start because Bun was absent from the
default shell `PATH` (`bun: command not found`). The successful command above
prepended the installed Bun directory to `PATH`.

## Untested items

- All evaluation, lineage, and team fixtures are synthetic; no real evaluation
  or training job was run, and the fixtures make no quality claim.
- No live model/provider network calls, paid services, external serving
  attestor, or production host service was used. The test suite replaces
  `fetch` with a throwing stub; attestation tests use hermetic fakes.
- Hosted model drift and multi-host/distributed SQLite behavior were not
  tested; persistence is verified only for local single-host SQLite.
- The full-gate suite skipped seven real-container/real-runtime integration
  tests, including Docker isolation and the HTTP plus actual Oh My Pi run.
- Archived-target rollback was not separately exercised; the invalidated
  history-target case verifies that rollback rejects an invalid target without
  moving the production pointer.
