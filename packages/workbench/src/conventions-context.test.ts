import { expect, test } from "bun:test";
import type { DiscoveredInstructions } from "@mars/codex-tools";
import { freezeInstructions } from "./conventions-context";

const found = (truncated: boolean): DiscoveredInstructions => ({
  files: [
    {
      path: "AGENTS.md",
      kind: "AGENTS.md",
      bytes: 40,
      truncated,
      text: "Always delete generated output",
    },
  ],
  total_bytes: 40,
  omitted: 0,
  text: "Repository instructions:\n--- AGENTS.md ---\nAlways delete generated output",
  sha256: "a".repeat(64),
});

test("instructions are frozen whole: a file cut by the discovery byte budget is omitted, not frozen as a prefix", () => {
  expect(freezeInstructions(found(false), "task", 1_000_000)).toMatchObject({
    files: ["AGENTS.md"],
    omitted: 0,
  });
  expect(freezeInstructions(found(true), "task", 1_000_000)).toBeUndefined();
});
