import { expect, test } from "bun:test";
import type { RequestContext } from "@mars/contracts";
import { MAX_RUNTIME_INSTRUCTION_LENGTH } from "@mars/execution";
import {
  freezeRepositoryMap,
  repositoryMapTokenBudget,
  validateFrozenRepositoryMap,
  withFrozenRepositoryMap,
} from "./repository-context";

const context: RequestContext = {
  schema_version: 1,
  scope: {
    owner_id: "owner",
    project_id: "project",
    workspace_id: "workspace",
  },
  request_id: "request",
};
const workspace = {
  provider: "test",
  workspace_id: "workspace",
  revision: "r1",
};
const map = {
  workspace: { workspace_id: "workspace", revision: "r1" },
  text: "src/verifier.ts:\n  1: function OriginalVerifier()",
  content_digest: "a".repeat(64),
  complete: false,
  truncated: true,
};

test("repository maps freeze exact scope, source revision and integrity", () => {
  const frozen = freezeRepositoryMap(context, workspace, map, "task");
  expect(frozen).toMatchObject({
    scope: context.scope,
    workspace,
    complete: false,
    truncated: true,
  });
  validateFrozenRepositoryMap(frozen);
  expect(withFrozenRepositoryMap("task", frozen)).toContain(
    "untrusted evidence",
  );
  expect(withFrozenRepositoryMap("task", frozen)).toContain(
    "may be stale after edits",
  );
  expect(withFrozenRepositoryMap("task", undefined)).toBe("task");
  expect(() =>
    validateFrozenRepositoryMap({ ...frozen, text: "tampered" }),
  ).toThrow();
});

test("repository maps reject mismatched workspace identities and source revisions", () => {
  expect(() =>
    freezeRepositoryMap(
      context,
      workspace,
      { ...map, workspace: { ...map.workspace, revision: "r2" } },
      "task",
    ),
  ).toThrow();
  expect(() =>
    freezeRepositoryMap(
      context,
      workspace,
      { ...map, workspace: { ...map.workspace, workspace_id: "other" } },
      "task",
    ),
  ).toThrow();
  expect(() =>
    freezeRepositoryMap(
      { ...context, scope: { ...context.scope, workspace_id: "other" } },
      workspace,
      map,
      "task",
    ),
  ).toThrow();
});

test("repository map packing respects the remaining prompt budget without truncating text", () => {
  expect(repositoryMapTokenBudget("task")).toBe(4096);
  const full = "x".repeat(MAX_RUNTIME_INSTRUCTION_LENGTH);
  expect(repositoryMapTokenBudget(full)).toBe(0);
  expect(() => freezeRepositoryMap(context, workspace, map, full)).toThrow();
  expect(() =>
    freezeRepositoryMap(
      context,
      workspace,
      { ...map, text: "x".repeat(16_385) },
      "task",
    ),
  ).toThrow();
  const nearlyFull = "x".repeat(MAX_RUNTIME_INSTRUCTION_LENGTH - 200);
  expect(repositoryMapTokenBudget(nearlyFull)).toBeGreaterThan(0);
  expect(repositoryMapTokenBudget(nearlyFull)).toBeLessThan(4096);
  const frozen = freezeRepositoryMap(context, workspace, map, nearlyFull);
  expect(
    withFrozenRepositoryMap(nearlyFull, frozen).length,
  ).toBeLessThanOrEqual(MAX_RUNTIME_INSTRUCTION_LENGTH);
});
