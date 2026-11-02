import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkbenchController } from "../src/controller";
import { WebviewMessageSchema } from "../src/messages";
import { openReviewTarget, type ReviewOpenerHost } from "../src/reviewOpener";
import {
  buildOutputView,
  isFinalText,
  tonePreamble,
} from "../src/webview/outputView";
import { describeResult, harness, makeTask } from "./fixtures";

const base = mkdtempSync(join(tmpdir(), "mars-review-"));
const root = join(base, "demo");
const outside = join(base, "outside");
mkdirSync(join(root, "src"), { recursive: true });
mkdirSync(outside);
writeFileSync(join(root, "src", "a.ts"), "one\ntwo\nthree\n");
writeFileSync(join(outside, "secret.txt"), "secret\n");
symlinkSync(outside, join(root, "link"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const PR = "https://github.com/acme/repo/pull/7";

async function connectedWithTask(
  status: "pending" | "running" | "paused" | "completed" = "running",
) {
  const h = harness();
  const controller = new WorkbenchController({
    connect: h.connect,
    ui: h.ui,
    post: (state) => h.states.push(state),
    modelId: () => null,
    newId: () => "id",
    poller: { minDelayMs: 50, maxDelayMs: 50 },
  });
  h.server.tasks.set("task-1", makeTask({ status }));
  await controller.handleMessage({ type: "ready" });
  await controller.handleMessage({ type: "selectTask", taskId: "task-1" });
  return { ...h, controller };
}

const review = {
  type: "openReview" as const,
  taskId: "task-1",
  path: "src/a.ts",
  line_start: 2,
  line_end: 3,
  side: "right" as const,
  pr: PR,
};

describe("follow-ups", () => {
  test("are sent as steering only after a confirmation that shows the full prompt", async () => {
    const ctx = await connectedWithTask("running");
    const prompt = "Add a regression test for the parser edge case";
    await ctx.controller.handleMessage({
      type: "followUp",
      taskId: "task-1",
      prompt,
    });
    expect(ctx.confirms).toHaveLength(1);
    expect(ctx.confirms[0]?.action).toBe("Send follow-up");
    expect(ctx.confirms[0]?.detail).toContain(prompt);
    expect(
      ctx.server.calls.find((c) => c.method === "tasks.steer")?.params,
    ).toEqual({ task_id: "task-1", instruction: prompt });
    ctx.controller.dispose();
  });

  test("declining the confirmation sends nothing", async () => {
    const ctx = await connectedWithTask("paused");
    ctx.answer.value = false;
    await ctx.controller.handleMessage({
      type: "followUp",
      taskId: "task-1",
      prompt: "do more",
    });
    expect(ctx.confirms).toHaveLength(1);
    expect(ctx.server.methods()).not.toContain("tasks.steer");
    ctx.controller.dispose();
  });

  test("a completed task cannot be steered by a follow-up", async () => {
    const ctx = await connectedWithTask("completed");
    await ctx.controller.handleMessage({
      type: "followUp",
      taskId: "task-1",
      prompt: "do more",
    });
    expect(ctx.confirms).toHaveLength(0);
    expect(ctx.server.methods()).not.toContain("tasks.steer");
    expect(ctx.last().notice).toMatchObject({ kind: "info" });
    expect(ctx.last().notice?.text).toContain("task is completed");
    ctx.controller.dispose();
  });
});

describe("review links", () => {
  test("a safe workspace-relative path is opened with its range and PR shown", async () => {
    const ctx = await connectedWithTask();
    await ctx.controller.handleMessage(review);
    expect(ctx.reviews).toEqual([
      {
        path: "src/a.ts",
        segments: ["src", "a.ts"],
        line_start: 2,
        line_end: 3,
        side: "right",
        pr: PR,
      },
    ]);
    expect(ctx.last().notice?.kind).toBe("info");
    expect(ctx.last().notice?.text).toContain("not fetched");
    ctx.controller.dispose();
  });

  test("traversal, absolute paths and inverted ranges never reach the opener", async () => {
    const ctx = await connectedWithTask();
    for (const bad of [
      { ...review, path: "../x" },
      { ...review, path: "/etc/passwd" },
      { ...review, path: "src/../../x" },
      { ...review, path: "C:/Windows/x" },
      { ...review, line_start: 5, line_end: 2 },
    ]) {
      await ctx.controller.handleMessage(bad);
      expect(ctx.last().notice?.kind).toBe("error");
      expect(ctx.last().notice?.text).toContain("Refused to open");
    }
    expect(ctx.reviews).toHaveLength(0);
    ctx.controller.dispose();
  });

  test("openReviewTarget resolves inside the matching folder only", async () => {
    const shown: Array<[string, number, number, string]> = [];
    const host: ReviewOpenerHost = {
      folders: () => [{ name: "demo", fsPath: root }],
      realpath,
      showRange: async (fsPath, start, end, title) => {
        shown.push([fsPath, start, end, title]);
      },
    };
    const target = {
      path: "src/a.ts",
      segments: ["src", "a.ts"],
      line_start: 2,
      line_end: 3,
      side: "left" as const,
      pr: PR,
    };
    expect(await openReviewTarget(host, describeResult, target)).toEqual({
      ok: true,
    });
    expect(shown[0]?.[0]).toBe(join(await realpath(root), "src", "a.ts"));
    expect(shown[0]?.slice(1)).toEqual([
      2,
      3,
      `MARS review: src/a.ts:2-3 (left side of ${PR})`,
    ]);
    expect(
      await openReviewTarget(host, describeResult, {
        ...target,
        path: "link/secret.txt",
        segments: ["link", "secret.txt"],
      }),
    ).toMatchObject({ ok: false });
    expect(
      await openReviewTarget(host, describeResult, {
        ...target,
        path: "src/missing.ts",
        segments: ["src", "missing.ts"],
      }),
    ).toEqual({ ok: false, reason: "The file does not exist locally." });
    expect(
      await openReviewTarget(
        { ...host, folders: () => [{ name: "other", fsPath: root }] },
        describeResult,
        target,
      ),
    ).toMatchObject({ ok: false });
    expect(shown).toHaveLength(1);
  });
});

describe("copy and schema bounds", () => {
  test("copyText goes to the host clipboard hook", async () => {
    const ctx = await connectedWithTask();
    await ctx.controller.handleMessage({ type: "copyText", text: "body" });
    expect(ctx.copied).toEqual(["body"]);
    ctx.controller.dispose();
  });

  test("over-long or malformed output messages are rejected", () => {
    expect(
      WebviewMessageSchema.safeParse({
        type: "followUp",
        taskId: "t",
        prompt: "x".repeat(8000),
      }).success,
    ).toBe(true);
    for (const bad of [
      { type: "followUp", taskId: "t", prompt: "x".repeat(8001) },
      { type: "followUp", taskId: "t", prompt: "" },
      { type: "followUp", taskId: "t", prompt: "x", auto: true },
      { ...review, line_start: 0 },
      { ...review, line_start: 1.5 },
      { ...review, side: "both" },
      { ...review, pr: "not a url" },
      { ...review, path: "x".repeat(1025) },
      { type: "copyText", text: "x".repeat(256 * 1024 + 1) },
    ])
      expect(WebviewMessageSchema.safeParse(bad).success).toBe(false);
  });
});

describe("output view model", () => {
  const text = [
    "Done. See [the PR](https://github.com/acme/repo/pull/7).",
    `[Check the loop](mars://review?pr=${PR}&path=src/a.ts&line=2&end=3)`,
    `[Too wide](mars://review?pr=${PR}&path=src/a.ts&line=1&end=99)`,
    "[$Slack](app://slack)",
    ':::writing{id="48213" variant="email" subject="Hi" recipient="bob@example.com" cc="eve@evil.example"}',
    "::tone[Formal]",
    "Dear Bob,",
    "::tone[Casual]",
    "Hey Bob,",
    ":::",
    '- :mars-followup[Add tests]{prompt="Add tests for the parser"}',
    "- :mars-followup[broken]",
  ].join("\n");

  test("demotes invalid proposals and keeps errors for display", () => {
    const task = makeTask({ request: "Email bob@example.com" });
    const view = buildOutputView(text, task);
    expect(
      view.reviews.map((item) => [item.review.label, item.blocked]),
    ).toEqual([
      ["Check the loop", null],
      ["Too wide", expect.stringContaining("99 lines")],
    ]);
    expect(view.triggers).toEqual([
      { label: "$Slack", connector_id: "slack", line: 4 },
    ]);
    expect(view.segments.map((segment) => segment.kind)).toEqual([
      "markdown",
      "writing",
      "follow_up",
      "markdown",
    ]);
    const writing = view.segments[1];
    expect(writing?.kind === "writing" && writing.tones.length).toBe(2);
    expect(view.errors.map((error) => error.code).sort()).toEqual([
      "invented_address",
      "malformed_followup",
      "review_range_too_wide",
      "unknown_connector",
    ]);
    expect(
      view.errors.find((error) => error.code === "invented_address")?.block_id,
    ).toBe("48213");
  });

  test("review links are demoted per link, not per line", () => {
    const view = buildOutputView(
      [
        `[Open](mars://review?pr=${PR}&path=src/a.ts&line=2&end=41) [Wide](mars://review?pr=${PR}&path=src/a.ts&line=1&end=41) [$Slack](app://slack)`,
        `[Bad](mars://review?pr=${PR}&path=../a.ts&line=2)`,
      ].join("\n"),
      makeTask(),
    );
    expect(
      view.reviews.map((item) => [item.review.label, item.blocked]),
    ).toEqual([
      ["Open", null],
      ["Wide", expect.stringContaining("41 lines")],
    ]);
    expect(view.errors.map((error) => [error.line, error.code])).toEqual([
      [1, "unknown_connector"],
      [1, "review_range_too_wide"],
      [2, "malformed_review_link"],
    ]);
  });

  test("tone preamble is exposed and code fences are skipped", () => {
    const view = buildOutputView(
      [
        ':::writing{id="11111" variant="note"}',
        "Introduction",
        "```",
        "::tone[Fake]",
        "```",
        "::tone[Formal]",
        "Hello",
        ":::",
      ].join("\n"),
      makeTask(),
    );
    const block = view.segments[0];
    if (block?.kind !== "writing") throw new Error("expected a writing block");
    expect(block.tones.map((tone) => tone.tone)).toEqual(["Formal"]);
    expect(tonePreamble(block)).toBe("Introduction\n```\n::tone[Fake]\n```");
    expect(tonePreamble({ ...block, tones: [] })).toBeNull();
    expect(
      tonePreamble({ ...block, body: "::tone[Formal]\nHello" }),
    ).toBeNull();
  });

  test("only text/plain artifacts are treated as output format", () => {
    expect(isFinalText("text/plain")).toBe(true);
    expect(isFinalText("text/plain; charset=utf-8")).toBe(true);
    expect(isFinalText("application/yaml")).toBe(false);
    expect(isFinalText("text/x-diff")).toBe(false);
    expect(isFinalText("text/plainish")).toBe(false);
  });
});
