# apply_patch scenario fixtures

Every `0NN_*` directory here is copied verbatim from openai/codex
(`codex-rs/apply-patch/tests/fixtures/scenarios/`) at revision
`f58acd6ede312266a7a0eaa63fd8dadacb4de239`, together with the upstream
`.gitattributes` that keeps their line endings byte-exact (`023`/`024` contain
CRLF and CR terminators on purpose).

Each scenario has `patch.txt` (the apply_patch body), `input/` (workspace before)
and `expected/` (workspace after, also for scenarios that are expected to fail).
`src/apply-patch/apply-patch.test.ts` runs each one through an in-memory
`PatchFileSystem` and compares the resulting tree with `expected/`.

License: Apache License, Version 2.0 — see `../../../third_party/codex/LICENSE.txt`
and `../../../third_party/codex/NOTICE.txt` (Copyright 2025 OpenAI).
