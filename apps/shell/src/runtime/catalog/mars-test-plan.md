---
name: mars-test-plan
description: Derive a lean test plan from a behavior change and its failure modes.
---

State the user-visible contract in one sentence. Identify the smallest set of cases that distinguishes correct behavior from likely mistakes: the normal path, the relevant boundary, and a recovery or cancellation path. Include a regression case for each known defect.

For each case specify the starting state, action, and observable result. Prefer the lowest layer that can verify it honestly. Mark proposed checks as not run; keep already observed results in a separate section.
