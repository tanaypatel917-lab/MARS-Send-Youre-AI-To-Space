import { describe, expect, test } from "bun:test";
import {
  clampApprovals,
  DANGER_FULL_ACCESS_REFUSAL,
  mapCodexPolicy,
} from "./policy";
import type {
  CodexApprovalMode,
  CodexSandboxMode,
  WorkbenchApprovals,
} from "./types";

type Row = [CodexSandboxMode, CodexApprovalMode, WorkbenchApprovals, boolean];

const CAN_EXECUTE: Row[] = [
  [
    "read-only",
    "untrusted",
    { read: true, write: false, execute: false },
    false,
  ],
  [
    "read-only",
    "on-request",
    { read: true, write: false, execute: false },
    false,
  ],
  ["read-only", "never", { read: true, write: false, execute: false }, false],
  [
    "workspace-write",
    "untrusted",
    { read: true, write: false, execute: false },
    false,
  ],
  [
    "workspace-write",
    "on-request",
    { read: true, write: true, execute: true },
    false,
  ],
  [
    "workspace-write",
    "never",
    { read: true, write: true, execute: true },
    false,
  ],
  [
    "danger-full-access",
    "untrusted",
    { read: true, write: false, execute: false },
    true,
  ],
  [
    "danger-full-access",
    "on-request",
    { read: true, write: true, execute: true },
    true,
  ],
  [
    "danger-full-access",
    "never",
    { read: true, write: true, execute: true },
    true,
  ],
];

describe("mapCodexPolicy with canExecute=true", () => {
  test.each(CAN_EXECUTE)("%s + %s", (sandbox, approval, approvals, refused) => {
    const mapping = mapCodexPolicy(sandbox, approval, { canExecute: true });
    expect(mapping.approvals).toEqual(approvals);
    expect(mapping.sandbox).toBe(sandbox);
    expect(mapping.approval).toBe(approval);
    expect(mapping.execute_requires_sandbox).toBe(true);
    expect(mapping.refused).toBe(
      refused ? DANGER_FULL_ACCESS_REFUSAL : undefined,
    );
    expect("refused" in mapping).toBe(refused);
  });
});

describe("mapCodexPolicy with canExecute=false", () => {
  test.each(CAN_EXECUTE)(
    "%s + %s never executes",
    (sandbox, approval, approvals) => {
      const mapping = mapCodexPolicy(sandbox, approval, { canExecute: false });
      expect(mapping.approvals).toEqual({ ...approvals, execute: false });
    },
  );
});

test("notes explain sandboxing, never-prompting and refusal", () => {
  const never = mapCodexPolicy("workspace-write", "never", {
    canExecute: true,
  });
  expect(
    never.notes.some((note) => note.includes("never prompts mid-task")),
  ).toBe(true);
  expect(never.notes.some((note) => note.includes("sandbox"))).toBe(true);
  const onRequest = mapCodexPolicy("workspace-write", "on-request", {
    canExecute: true,
  });
  expect(onRequest.approvals).toEqual(never.approvals);
  const danger = mapCodexPolicy("danger-full-access", "on-request", {
    canExecute: true,
  });
  expect(danger.notes.some((note) => note.includes("refused"))).toBe(true);
  const readOnly = mapCodexPolicy("read-only", "on-request", {
    canExecute: true,
  });
  expect(readOnly.notes).toEqual([]);
});

describe("clampApprovals", () => {
  const all: WorkbenchApprovals[] = [];
  for (const read of [false, true]) {
    for (const write of [false, true]) {
      for (const execute of [false, true]) {
        all.push({ read, write, execute });
      }
    }
  }
  test("is elementwise AND for every pair", () => {
    for (const requested of all) {
      for (const granted of all) {
        expect(clampApprovals(requested, granted)).toEqual({
          read: requested.read && granted.read,
          write: requested.write && granted.write,
          execute: requested.execute && granted.execute,
        });
      }
    }
  });
  test("never widens a mapping", () => {
    const granted = { read: true, write: false, execute: false };
    const mapped = mapCodexPolicy("workspace-write", "on-request", {
      canExecute: true,
    });
    expect(clampApprovals(mapped.approvals, granted)).toEqual(granted);
  });
});
