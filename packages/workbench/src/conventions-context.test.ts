import { expect, test } from "bun:test";
import type { DiscoveredInstructions } from "@mars/codex-tools";
import { freezeInstructions, hookResultRecord } from "./conventions-context";

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

test("hook evidence records output sizes, never the command output itself", () => {
  const record = hookResultRecord({
    event: "pre-tool",
    tool: "mars_write",
    argv: ["sh", "-c", "env"],
    outcome: "ran",
    exit_code: 0,
    stdout: "AWS_SECRET_ACCESS_KEY=hunter2\n",
    stderr: "wärn",
    blocked: false,
  });
  expect(record).toEqual({
    event: "pre-tool",
    tool: "mars_write",
    argv: ["sh", "-c", "env"],
    outcome: "ran",
    exit_code: 0,
    stdout_bytes: 30,
    stderr_bytes: 5,
    blocked: false,
  });
  expect(JSON.stringify(record)).not.toContain("hunter2");
});
