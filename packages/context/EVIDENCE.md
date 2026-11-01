# Verification evidence

This benchmark is a deterministic navigation/budget comparison on hand-authored and synthetic fixtures only. It is not
a measurement or claim of live coding quality.

## Environment and verification

- Environment: Linux 6.8.0-1061-aws, x86_64 GNU/Linux.
- Bun: `1.4.4`.
- `bun test packages/context` → 39 pass, 0 fail, 1,476 expectations; 39 tests across 5 files.
- The 1,500-file packing test completed in **906.72 ms** in that package test run. It asserts the 65,536-token cap.
- `bun run lint` → pass; Biome checked 130 files with no fixes.
- `bun run typecheck` → pass; `tsc --noEmit`.
- `bun packages/context/bench/compare.ts` → pass; all repeated maps were deterministic using a fresh provider.
- `bun run check` → pass. The offline source audit validated 25 entries. Root tests: 414 pass, 7 skip, 0 fail,
  3,855 expectations; 421 tests across 29 files. The seven skipped tests require real containers or the
  container/model integration environment. Execution smoke reported `model_requests: 0`; build bundled 27 modules.
- The dynamic directory-swap sweep on the pre-fix inventory leaked at callback 6. After fd-anchored traversal, both
  the provider `now()` sweep and direct inventory check-callback sweep passed at every dynamically measured point.
  A fake proc-fd directory with a root-fd-named symlink was rejected before traversal; the default anchored and normal
  best-effort tests also passed.
- No dependency or `bun.lock` changes were made in this follow-up.

## Fixture comparison

Command: `bun packages/context/bench/compare.ts`. Six unchanged, hand-authored navigation tasks were measured at token
budgets 256, 512, and 1,024. “Enabled” is the repository map; “disabled” is the alphabetical whole-line file-list
baseline. The scaled fixture contains the same 31 files plus 300 deterministic linked distractor modules (331 files
total), generated from indices and a fixed word list. No randomness or task/ground-truth changes are involved.
Each target's expected source line is hand-recorded in the fixture and checked against that source line by a plain
whole-word assertion; provenance scoring does not call the map's extractors to establish the expected line.

The small fixture's complete alphabetical listing of 31 paths fits in **236 tokens**, so its baseline trivially has
100% target-file recall at all three budgets. The enabled map honestly misses `account-allowance`, `delivery-retry`,
and `retention-policy` at 256 and 512 tokens. At 1,024 tokens it finds every small-fixture target. On the scaled
fixture, enabled misses those same three tasks at 256 and 512; at 1,024 it includes the `account-allowance` file but
not its target symbol, and misses the target files for `delivery-retry` and `retention-policy`. The scaled alphabetical
baseline misses `delivery-retry` and `retention-policy` at each budget.

Means below are the benchmark command's observed means across six tasks per fixture. Recall, utilization, and target
token share are proportions in the JSON metrics and percentages in the table. First-target position is the mean
1-based position among tasks whose target file appears; it is null for an individual task whose target is absent.

```json
[
  {"fixture":"small","budget":256,"mode":"enabled","target_file_recall":0.5,"target_symbol_recall":0.5,"target_line_provenance":0.5,"tokens_used":248.3333,"budget_utilization":0.9701,"target_token_share":0.1444,"first_target_position":3,"tasks":6,"deterministic":true},
  {"fixture":"small","budget":256,"mode":"disabled","target_file_recall":1,"target_symbol_recall":0,"target_line_provenance":0,"tokens_used":236,"budget_utilization":0.9219,"target_token_share":0.0332,"first_target_position":13.5,"tasks":6,"deterministic":true},
  {"fixture":"small","budget":512,"mode":"enabled","target_file_recall":0.5,"target_symbol_recall":0.5,"target_line_provenance":0.5,"tokens_used":485.3333,"budget_utilization":0.9479,"target_token_share":0.0736,"first_target_position":3,"tasks":6,"deterministic":true},
  {"fixture":"small","budget":512,"mode":"disabled","target_file_recall":1,"target_symbol_recall":0,"target_line_provenance":0,"tokens_used":236,"budget_utilization":0.4609,"target_token_share":0.0332,"first_target_position":13.5,"tasks":6,"deterministic":true},
  {"fixture":"small","budget":1024,"mode":"enabled","target_file_recall":1,"target_symbol_recall":1,"target_line_provenance":1,"tokens_used":964,"budget_utilization":0.9414,"target_token_share":0.0595,"first_target_position":13.3333,"tasks":6,"deterministic":true},
  {"fixture":"small","budget":1024,"mode":"disabled","target_file_recall":1,"target_symbol_recall":0,"target_line_provenance":0,"tokens_used":236,"budget_utilization":0.2305,"target_token_share":0.0332,"first_target_position":13.5,"tasks":6,"deterministic":true},
  {"fixture":"scaled","budget":256,"mode":"enabled","target_file_recall":0.5,"target_symbol_recall":0.5,"target_line_provenance":0.5,"tokens_used":248.3333,"budget_utilization":0.9701,"target_token_share":0.1444,"first_target_position":3,"tasks":6,"deterministic":true},
  {"fixture":"scaled","budget":256,"mode":"disabled","target_file_recall":0.6667,"target_symbol_recall":0,"target_line_provenance":0,"tokens_used":256,"budget_utilization":1,"target_token_share":0.0202,"first_target_position":8,"tasks":6,"deterministic":true},
  {"fixture":"scaled","budget":512,"mode":"enabled","target_file_recall":0.5,"target_symbol_recall":0.5,"target_line_provenance":0.5,"tokens_used":485.3333,"budget_utilization":0.9479,"target_token_share":0.0736,"first_target_position":3,"tasks":6,"deterministic":true},
  {"fixture":"scaled","budget":512,"mode":"disabled","target_file_recall":0.6667,"target_symbol_recall":0,"target_line_provenance":0,"tokens_used":511,"budget_utilization":0.998,"target_token_share":0.0101,"first_target_position":8,"tasks":6,"deterministic":true},
  {"fixture":"scaled","budget":1024,"mode":"enabled","target_file_recall":0.6667,"target_symbol_recall":0.5,"target_line_provenance":0.5,"tokens_used":995,"budget_utilization":0.9717,"target_token_share":0.0396,"first_target_position":7.75,"tasks":6,"deterministic":true},
  {"fixture":"scaled","budget":1024,"mode":"disabled","target_file_recall":0.6667,"target_symbol_recall":0,"target_line_provenance":0,"tokens_used":1022,"budget_utilization":0.998,"target_token_share":0.005,"first_target_position":8,"tasks":6,"deterministic":true}
]
```

| Fixture | Budget | Mode | File recall | Symbol recall | Line provenance | Tokens used | Utilization | Target token share | First target |
| :--- | ---: | :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| small | 256 | enabled | 50.0% | 50.0% | 50.0% | 248.3333 | 97.0% | 14.4% | 3 |
| small | 256 | disabled | 100.0% | 0.0% | 0.0% | 236 | 92.2% | 3.3% | 13.5 |
| small | 512 | enabled | 50.0% | 50.0% | 50.0% | 485.3333 | 94.8% | 7.4% | 3 |
| small | 512 | disabled | 100.0% | 0.0% | 0.0% | 236 | 46.1% | 3.3% | 13.5 |
| small | 1024 | enabled | 100.0% | 100.0% | 100.0% | 964 | 94.1% | 5.9% | 13.3333 |
| small | 1024 | disabled | 100.0% | 0.0% | 0.0% | 236 | 23.1% | 3.3% | 13.5 |
| scaled | 256 | enabled | 50.0% | 50.0% | 50.0% | 248.3333 | 97.0% | 14.4% | 3 |
| scaled | 256 | disabled | 66.7% | 0.0% | 0.0% | 256 | 100.0% | 2.0% | 8 |
| scaled | 512 | enabled | 50.0% | 50.0% | 50.0% | 485.3333 | 94.8% | 7.4% | 3 |
| scaled | 512 | disabled | 66.7% | 0.0% | 0.0% | 511 | 99.8% | 1.0% | 8 |
| scaled | 1024 | enabled | 66.7% | 50.0% | 50.0% | 995 | 97.2% | 4.0% | 7.75 |
| scaled | 1024 | disabled | 66.7% | 0.0% | 0.0% | 1022 | 99.8% | 0.5% | 8 |

These are fixture-only navigation and packing results. In particular, the small fixture's baseline recall is a
consequence of its short complete path listing, not evidence of navigation quality.

## Cold/warm timing sample

One machine-dependent sample from the same benchmark command:

```json
[
  {"fixture":"small","cold_ms":8.4186,"warm_ms":6.7205,"cold_files_parsed":31,"warm_files_parsed":0},
  {"fixture":"scaled","cold_ms":76.3817,"warm_ms":46.4423,"cold_files_parsed":331,"warm_files_parsed":0}
]
```
