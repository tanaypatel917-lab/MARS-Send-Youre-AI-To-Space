import { expect, test } from "bun:test";
import { runComparison } from "../bench/compare";

test("fixture comparison metrics are reproducible", async () => {
  const first = await runComparison();
  const second = await runComparison();
  expect(first.metrics).toEqual(second.metrics);
  expect(first.means).toEqual(second.means);
  expect(first.metrics.every((metric) => metric.deterministic)).toBe(true);
});
