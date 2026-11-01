# Verification evidence

This package's benchmark is a deterministic navigation/budget comparison on a hand-authored fixture only; it is not a
measurement or claim of live coding quality.

## Environment and verification

- Environment: Linux 6.8.0-1061-aws, x86_64 GNU/Linux.
- `bun --version` → `1.4.4`.
- `bun install --ignore-scripts` → 1 package installed; lockfile saved.
- `bun install --frozen-lockfile --ignore-scripts` → checked 134 installs across 171 packages; no changes.
- `git diff origin/main -- bun.lock` → only the `packages/context` workspace definition and `@mars/context` workspace
  link were added.
- `bun test packages/context` → 23 pass, 0 fail, 197 expectations; 23 tests across 4 files.
- `bun run lint` → pass; Biome checked 125 files with no fixes.
- `bun run typecheck` → pass; `tsc --noEmit`.
- `bun packages/context/bench/compare.ts` → pass; fixture results below.
- `bun run check` → pass. Lint, typecheck, offline source audit, root tests, execution smoke, and build all passed.
  Source audit validated 25 entries. Root tests: 366 pass, 7 skip, 0 fail, 2,217 expectations; 373 tests across 27
  files. The seven skipped tests require real containers or the container/model integration environment. Execution
  smoke reported `model_requests: 0`. Build bundled 27 modules.

## Fixture comparison

Command: `bun packages/context/bench/compare.ts`. The hand-authored fixture contains 31 files and six navigation
tasks. Enabled repository-map results are compared with the alphabetical whole-line file-list baseline at budgets
256, 512, and 1,024 tokens. Fields below are the command's per-task JSON output; `enabled` and `disabled` are each
deterministic across repeated runs.

```json
[
  {"id":"session-validation","budget":256,"mode":"enabled","target_file_recall":1,"target_symbol_recall":1,"target_line_provenance":1,"tokens_used":248,"budget_utilization":0.9688,"target_token_share":0.3024,"first_target_position":1,"deterministic":true},
  {"id":"session-validation","budget":256,"mode":"disabled","target_file_recall":1,"target_symbol_recall":0,"target_line_provenance":0,"tokens_used":236,"budget_utilization":0.9219,"target_token_share":0.0297,"first_target_position":5,"deterministic":true},
  {"id":"credential-expiry","budget":256,"mode":"enabled","target_file_recall":1,"target_symbol_recall":0,"target_line_provenance":0,"tokens_used":242,"budget_utilization":0.9453,"target_token_share":0.0826,"first_target_position":2,"deterministic":true},
  {"id":"credential-expiry","budget":256,"mode":"disabled","target_file_recall":1,"target_symbol_recall":0,"target_line_provenance":0,"tokens_used":236,"budget_utilization":0.9219,"target_token_share":0.0297,"first_target_position":5,"deterministic":true},
  {"id":"invoice-assembly","budget":256,"mode":"enabled","target_file_recall":1,"target_symbol_recall":1,"target_line_provenance":1,"tokens_used":254,"budget_utilization":0.9922,"target_token_share":0.2559,"first_target_position":1,"deterministic":true},
  {"id":"invoice-assembly","budget":256,"mode":"disabled","target_file_recall":1,"target_symbol_recall":0,"target_line_provenance":0,"tokens_used":236,"budget_utilization":0.9219,"target_token_share":0.0339,"first_target_position":6,"deterministic":true},
  {"id":"account-allowance","budget":256,"mode":"enabled","target_file_recall":0,"target_symbol_recall":0,"target_line_provenance":0,"tokens_used":242,"budget_utilization":0.9453,"target_token_share":0,"first_target_position":null,"deterministic":true},
  {"id":"account-allowance","budget":256,"mode":"disabled","target_file_recall":1,"target_symbol_recall":0,"target_line_provenance":0,"tokens_used":236,"budget_utilization":0.9219,"target_token_share":0.0381,"first_target_position":16,"deterministic":true},
  {"id":"delivery-retry","budget":256,"mode":"enabled","target_file_recall":0,"target_symbol_recall":0,"target_line_provenance":0,"tokens_used":242,"budget_utilization":0.9453,"target_token_share":0,"first_target_position":null,"deterministic":true},
  {"id":"delivery-retry","budget":256,"mode":"disabled","target_file_recall":1,"target_symbol_recall":0,"target_line_provenance":0,"tokens_used":236,"budget_utilization":0.9219,"target_token_share":0.0297,"first_target_position":26,"deterministic":true},
  {"id":"retention-policy","budget":256,"mode":"enabled","target_file_recall":1,"target_symbol_recall":0,"target_line_provenance":0,"tokens_used":242,"budget_utilization":0.9453,"target_token_share":0.0372,"first_target_position":10,"deterministic":true},
  {"id":"retention-policy","budget":256,"mode":"disabled","target_file_recall":1,"target_symbol_recall":0,"target_line_provenance":0,"tokens_used":236,"budget_utilization":0.9219,"target_token_share":0.0381,"first_target_position":23,"deterministic":true},
  {"id":"session-validation","budget":512,"mode":"enabled","target_file_recall":1,"target_symbol_recall":1,"target_line_provenance":1,"tokens_used":511,"budget_utilization":0.998,"target_token_share":0.1468,"first_target_position":1,"deterministic":true},
  {"id":"session-validation","budget":512,"mode":"disabled","target_file_recall":1,"target_symbol_recall":0,"target_line_provenance":0,"tokens_used":236,"budget_utilization":0.4609,"target_token_share":0.0297,"first_target_position":5,"deterministic":true},
  {"id":"credential-expiry","budget":512,"mode":"enabled","target_file_recall":1,"target_symbol_recall":0,"target_line_provenance":0,"tokens_used":501,"budget_utilization":0.9785,"target_token_share":0.0399,"first_target_position":2,"deterministic":true},
  {"id":"credential-expiry","budget":512,"mode":"disabled","target_file_recall":1,"target_symbol_recall":0,"target_line_provenance":0,"tokens_used":236,"budget_utilization":0.4609,"target_token_share":0.0297,"first_target_position":5,"deterministic":true},
  {"id":"invoice-assembly","budget":512,"mode":"enabled","target_file_recall":1,"target_symbol_recall":1,"target_line_provenance":1,"tokens_used":511,"budget_utilization":0.998,"target_token_share":0.1272,"first_target_position":1,"deterministic":true},
  {"id":"invoice-assembly","budget":512,"mode":"disabled","target_file_recall":1,"target_symbol_recall":0,"target_line_provenance":0,"tokens_used":236,"budget_utilization":0.4609,"target_token_share":0.0339,"first_target_position":6,"deterministic":true},
  {"id":"account-allowance","budget":512,"mode":"enabled","target_file_recall":0,"target_symbol_recall":0,"target_line_provenance":0,"tokens_used":501,"budget_utilization":0.9785,"target_token_share":0,"first_target_position":null,"deterministic":true},
  {"id":"account-allowance","budget":512,"mode":"disabled","target_file_recall":1,"target_symbol_recall":0,"target_line_provenance":0,"tokens_used":236,"budget_utilization":0.4609,"target_token_share":0.0381,"first_target_position":16,"deterministic":true},
  {"id":"delivery-retry","budget":512,"mode":"enabled","target_file_recall":0,"target_symbol_recall":0,"target_line_provenance":0,"tokens_used":501,"budget_utilization":0.9785,"target_token_share":0,"first_target_position":null,"deterministic":true},
  {"id":"delivery-retry","budget":512,"mode":"disabled","target_file_recall":1,"target_symbol_recall":0,"target_line_provenance":0,"tokens_used":236,"budget_utilization":0.4609,"target_token_share":0.0297,"first_target_position":26,"deterministic":true},
  {"id":"retention-policy","budget":512,"mode":"enabled","target_file_recall":1,"target_symbol_recall":0,"target_line_provenance":0,"tokens_used":501,"budget_utilization":0.9785,"target_token_share":0.018,"first_target_position":20,"deterministic":true},
  {"id":"retention-policy","budget":512,"mode":"disabled","target_file_recall":1,"target_symbol_recall":0,"target_line_provenance":0,"tokens_used":236,"budget_utilization":0.4609,"target_token_share":0.0381,"first_target_position":23,"deterministic":true},
  {"id":"session-validation","budget":1024,"mode":"enabled","target_file_recall":1,"target_symbol_recall":1,"target_line_provenance":1,"tokens_used":964,"budget_utilization":0.9414,"target_token_share":0.0778,"first_target_position":1,"deterministic":true},
  {"id":"session-validation","budget":1024,"mode":"disabled","target_file_recall":1,"target_symbol_recall":0,"target_line_provenance":0,"tokens_used":236,"budget_utilization":0.2305,"target_token_share":0.0297,"first_target_position":5,"deterministic":true},
  {"id":"credential-expiry","budget":1024,"mode":"enabled","target_file_recall":1,"target_symbol_recall":1,"target_line_provenance":1,"tokens_used":964,"budget_utilization":0.9414,"target_token_share":0.0778,"first_target_position":2,"deterministic":true},
  {"id":"credential-expiry","budget":1024,"mode":"disabled","target_file_recall":1,"target_symbol_recall":0,"target_line_provenance":0,"tokens_used":236,"budget_utilization":0.2305,"target_token_share":0.0297,"first_target_position":5,"deterministic":true},
  {"id":"invoice-assembly","budget":1024,"mode":"enabled","target_file_recall":1,"target_symbol_recall":1,"target_line_provenance":1,"tokens_used":964,"budget_utilization":0.9414,"target_token_share":0.0674,"first_target_position":1,"deterministic":true},
  {"id":"invoice-assembly","budget":1024,"mode":"disabled","target_file_recall":1,"target_symbol_recall":0,"target_line_provenance":0,"tokens_used":236,"budget_utilization":0.2305,"target_token_share":0.0339,"first_target_position":6,"deterministic":true},
  {"id":"account-allowance","budget":1024,"mode":"enabled","target_file_recall":1,"target_symbol_recall":1,"target_line_provenance":1,"tokens_used":964,"budget_utilization":0.9414,"target_token_share":0.0488,"first_target_position":22,"deterministic":true},
  {"id":"account-allowance","budget":1024,"mode":"disabled","target_file_recall":1,"target_symbol_recall":0,"target_line_provenance":0,"tokens_used":236,"budget_utilization":0.2305,"target_token_share":0.0381,"first_target_position":16,"deterministic":true},
  {"id":"delivery-retry","budget":1024,"mode":"enabled","target_file_recall":1,"target_symbol_recall":1,"target_line_provenance":1,"tokens_used":964,"budget_utilization":0.9414,"target_token_share":0.0456,"first_target_position":25,"deterministic":true},
  {"id":"delivery-retry","budget":1024,"mode":"disabled","target_file_recall":1,"target_symbol_recall":0,"target_line_provenance":0,"tokens_used":236,"budget_utilization":0.2305,"target_token_share":0.0297,"first_target_position":26,"deterministic":true},
  {"id":"retention-policy","budget":1024,"mode":"enabled","target_file_recall":1,"target_symbol_recall":1,"target_line_provenance":1,"tokens_used":964,"budget_utilization":0.9414,"target_token_share":0.0394,"first_target_position":24,"deterministic":true},
  {"id":"retention-policy","budget":1024,"mode":"disabled","target_file_recall":1,"target_symbol_recall":0,"target_line_provenance":0,"tokens_used":236,"budget_utilization":0.2305,"target_token_share":0.0381,"first_target_position":23,"deterministic":true}
]
```

Means from the command output:

```json
[
  {"budget":256,"mode":"enabled","target_file_recall":0.6667,"target_symbol_recall":0.3333,"target_line_provenance":0.3333,"tokens_used":245,"budget_utilization":0.957,"target_token_share":0.113,"first_target_position":3.5,"tasks":6,"deterministic":true},
  {"budget":256,"mode":"disabled","target_file_recall":1,"target_symbol_recall":0,"target_line_provenance":0,"tokens_used":236,"budget_utilization":0.9219,"target_token_share":0.0332,"first_target_position":13.5,"tasks":6,"deterministic":true},
  {"budget":512,"mode":"enabled","target_file_recall":0.6667,"target_symbol_recall":0.3333,"target_line_provenance":0.3333,"tokens_used":504.3333,"budget_utilization":0.985,"target_token_share":0.0553,"first_target_position":6,"tasks":6,"deterministic":true},
  {"budget":512,"mode":"disabled","target_file_recall":1,"target_symbol_recall":0,"target_line_provenance":0,"tokens_used":236,"budget_utilization":0.4609,"target_token_share":0.0332,"first_target_position":13.5,"tasks":6,"deterministic":true},
  {"budget":1024,"mode":"enabled","target_file_recall":1,"target_symbol_recall":1,"target_line_provenance":1,"tokens_used":964,"budget_utilization":0.9414,"target_token_share":0.0595,"first_target_position":12.5,"tasks":6,"deterministic":true},
  {"budget":1024,"mode":"disabled","target_file_recall":1,"target_symbol_recall":0,"target_line_provenance":0,"tokens_used":236,"budget_utilization":0.2305,"target_token_share":0.0332,"first_target_position":13.5,"tasks":6,"deterministic":true}
]
```

| Budget | Mode | File recall | Symbol recall | Line provenance | Tokens used | Utilization | Target token share | First target |
| ---: | :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 256 | enabled | 66.7% | 33.3% | 33.3% | 245 | 95.7% | 11.3% | 3.5 |
| 256 | disabled | 100.0% | 0.0% | 0.0% | 236 | 92.2% | 3.3% | 13.5 |
| 512 | enabled | 66.7% | 33.3% | 33.3% | 504.3333 | 98.5% | 5.5% | 6 |
| 512 | disabled | 100.0% | 0.0% | 0.0% | 236 | 46.1% | 3.3% | 13.5 |
| 1024 | enabled | 100.0% | 100.0% | 100.0% | 964 | 94.1% | 5.9% | 12.5 |
| 1024 | disabled | 100.0% | 0.0% | 0.0% | 236 | 23.1% | 3.3% | 13.5 |

At budgets 256 and 512, this fixture's enabled map had lower mean target-file recall than the alphabetical baseline.
The benchmark is intentionally reported as observed and is not a live-quality claim.

## Cold/warm timing sample

One machine-dependent sample from the same benchmark command:

```json
{"cold_ms":14.5465,"warm_ms":5.095,"cold_files_parsed":31,"warm_files_parsed":0}
```
