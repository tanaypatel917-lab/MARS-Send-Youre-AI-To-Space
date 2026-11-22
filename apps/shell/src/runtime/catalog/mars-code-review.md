---
name: mars-code-review
description: Review a patch for concrete correctness and regression risks.
---

Start from the intended user behavior. Trace changed inputs through validation, state updates, error handling, and cleanup. Check whether tests would fail if the behavior regressed. Read neighboring callers before inferring a contract.

Report each confirmed finding with the affected location, triggering condition, observable impact, and smallest useful fix or regression test. Separate questions from findings. If you find no defect, say so and identify any material behavior you could not assess.
