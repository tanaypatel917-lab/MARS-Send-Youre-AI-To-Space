import { describe, expect, test } from "bun:test";
import { chooseChildModel, isReviewerRole } from "./child-model";

function registry(
  models: Record<string, { free: boolean; tools: boolean }>,
  defaults: string[],
) {
  return {
    routes: { default: defaults },
    policy: { allowPaid: false },
    getModel: (id: string) =>
      models[id]
        ? {
            id,
            providerId: "p",
            pricing: { free: models[id].free },
            capabilities: { tools: models[id].tools, context_window: 32_768 },
          }
        : undefined,
    unavailableReason: () => undefined,
  } as unknown as Parameters<typeof chooseChildModel>[0];
}

describe("chooseChildModel", () => {
  const reg = registry(
    {
      "free/a": { free: true, tools: true },
      "free/b": { free: true, tools: true },
      "paid/c": { free: false, tools: true },
    },
    ["free/a", "free/b"],
  );
  test("workers take the first free default and record no independence", () => {
    expect(
      chooseChildModel(reg, null, new Set(["free/a"]), false),
    ).toMatchObject({
      model_id: "free/a",
      independent: null,
    });
  });
  test("reviewers skip the coordinator's and siblings' models", () => {
    const choice = chooseChildModel(reg, null, new Set(["free/a"]), true);
    expect(choice).toMatchObject({ model_id: "free/b", independent: true });
    expect(choice.reason).toContain("independent reviewer");
  });
  test("reviewers fall back and record a non-independent review", () => {
    const choice = chooseChildModel(
      reg,
      null,
      new Set(["free/a", "free/b"]),
      true,
    );
    expect(choice).toMatchObject({ model_id: "free/a", independent: false });
    expect(choice.reason).toContain("not independent");
  });
  test("a free tool-capable specialist is preferred unless excluded for a reviewer", () => {
    const routing = {
      decision_id: "00000000-0000-4000-8000-000000000000",
      routing_task_id: "t",
      outcome: "specialist" as const,
      ref: "spec",
      specialist_revision: "spec",
      model_id: "free/b",
    };
    expect(chooseChildModel(reg, routing, new Set(), false).model_id).toBe(
      "free/b",
    );
    expect(
      chooseChildModel(reg, routing, new Set(["free/b"]), true),
    ).toMatchObject({
      model_id: "free/a",
      independent: true,
    });
    expect(
      chooseChildModel(
        reg,
        { ...routing, model_id: "paid/c" },
        new Set(),
        false,
      ).model_id,
    ).toBe("free/a");
  });
  test("role labels containing review select the reviewer path", () => {
    expect(isReviewerRole("Reviewer")).toBe(true);
    expect(isReviewerRole("code-review")).toBe(true);
    expect(isReviewerRole("worker")).toBe(false);
  });
});
