import { expect, test } from "bun:test";
import { MIN_POWERED_TASKS } from "./edit-benchmark/power";
import { learningRouteEvidence } from "./learning-benchmark";

test("a powered, positive sign test recommends review even when the lift interval includes zero", () => {
  const win = {
    baseline: { solved: false, provider_failure: null },
    specialist: { solved: true, provider_failure: null },
  };
  const loss = { baseline: win.specialist, specialist: win.baseline };
  const tie = { baseline: win.baseline, specialist: win.baseline };
  const pairs = [
    ...Array.from({ length: 35 }, () => win),
    ...Array.from({ length: 18 }, () => loss),
    ...Array.from({ length: MIN_POWERED_TASKS - 53 }, () => tie),
  ];
  const positive = learningRouteEvidence("live", pairs);
  expect(positive.pairs).toBe(129);
  expect(positive.sign_test_p_two_sided ?? 1).toBeLessThan(0.05);
  expect(positive.ci_95?.lower ?? 1).toBeLessThanOrEqual(0);
  expect(positive.recommendation).toBe("review_specialist");
  expect(learningRouteEvidence("live", pairs.slice(1)).reason).toBe(
    "insufficient_complete_pairs",
  );
  const negative = learningRouteEvidence(
    "live",
    pairs.map(({ baseline, specialist }) => ({
      baseline: specialist,
      specialist: baseline,
    })),
  );
  expect(negative.sign_test_p_two_sided).toBe(positive.sign_test_p_two_sided);
  expect(negative.reason).toBe("positive_lift_not_established");
});
