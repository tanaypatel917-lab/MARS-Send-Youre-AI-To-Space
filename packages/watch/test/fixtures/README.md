# Real watch-skill 1.4.3 artifacts

Produced on 2026-11-02 with the real upstream package (`pip install "watch-skill==1.4.3"`, commit `f1317c8fe64744a606c31867b05fbbe3144268c6`), not by the fake CLI:

- `real-loop-state.json` — written by upstream's `LoopState.save()` (`watch_skill.loop.runner`) for a loop with two iterations (critique `fail` score 40, then `pass` score 90) constructed in Python; no browser or vision model was involved, so the `perception` fields are empty.
- `real-loop-status.stdout` — the exact stdout of `WATCHSKILL_OFFLINE=1 WATCHSKILL_DATA_DIR=/tmp/wsreal watch-skill loop status lp_real_fixture` (exit 0) against that state.

`real-cli.test.ts` parses these to check the wrapper against upstream's real on-disk and stdout formats. A real capture → critique loop is still unverified.

- `real-verify-run.stdout` / `real-verify-show.stdout` — exact stdout of `WATCHSKILL_OFFLINE=1 WATCHSKILL_DATA_DIR=/tmp/wsv2/data watch-skill verify run contract.json --dir /tmp/wsv2/work` (exit 0) and `watch-skill verify show <run_id>` (exit 0) for a two-check `file_exists` contract (`present.txt` required, `missing.txt` optional). `verify show` prints the stored bundle (`check_results[]`, `attestation.signature_status`), which differs from the `verify run` summary (`checks[]`, `signature_status`); the wrapper normalises both.
