import { expect, test } from "bun:test";
import { runComparison } from "../bench/compare";
import {
  createScaledFixtureFiles,
  FIXTURE_FILES,
  NAVIGATION_TASKS,
} from "../bench/fixture";

test("benchmark target lines independently match their symbols", () => {
  for (const task of NAVIGATION_TASKS) {
    for (const target of task.targets) {
      const source = FIXTURE_FILES[target.path];
      expect(source).toBeDefined();
      const line = source?.split(/\r?\n/)[target.expected_line - 1] ?? "";
      expect(new RegExp(`\\b${target.symbol}\\b`).test(line)).toBe(true);
    }
  }
});

test("scaled fixture contains 300 deterministic linked distractor modules", () => {
  const first = createScaledFixtureFiles();
  const second = createScaledFixtureFiles();
  const modules = Object.entries(first).filter(([path]) =>
    path.startsWith("src/modules/"),
  );
  expect(Object.keys(first)).toHaveLength(331);
  expect(modules).toHaveLength(300);
  expect(second).toEqual(first);
  for (const [, source] of modules) {
    const imported = source.match(/^import /gm) ?? [];
    const exported = source.match(/^export function /gm) ?? [];
    expect(imported.length).toBeGreaterThanOrEqual(1);
    expect(imported.length).toBeLessThanOrEqual(2);
    expect(exported.length).toBeGreaterThanOrEqual(3);
    expect(exported.length).toBeLessThanOrEqual(5);
  }
});

test("small and scaled fixture comparison metrics are reproducible", async () => {
  const first = await runComparison();
  const second = await runComparison();
  expect(first.metrics.some((metric) => metric.fixture === "small")).toBe(true);
  expect(first.metrics.some((metric) => metric.fixture === "scaled")).toBe(
    true,
  );
  for (const fixture of ["small", "scaled"]) {
    expect(
      first.metrics.filter((metric) => metric.fixture === fixture),
    ).toEqual(second.metrics.filter((metric) => metric.fixture === fixture));
    expect(first.means.filter((mean) => mean.fixture === fixture)).toEqual(
      second.means.filter((mean) => mean.fixture === fixture),
    );
  }
  expect(first.metrics.every((metric) => metric.deterministic)).toBe(true);
}, 60_000);
