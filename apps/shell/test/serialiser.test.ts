import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createController } from "../src/renderer/controller";
import { READ_METHODS, type ShellBridge } from "../src/shared/methods";
import { findAll, MiniDocument, serialize } from "./mini-dom";
import { fakeBridge, loadFixtureData, type RecordedCall } from "./test-utils";

test("fixture task views match deterministic snapshots and keep untrusted text inert", async () => {
  const data = await loadFixtureData();
  for (const task of data.tasks) {
    const document = new MiniDocument();
    const calls: RecordedCall[] = [];
    const controller = createController(
      fakeBridge(data, calls),
      document,
      document.root,
    );
    await controller.load();
    const session = findAll(
      document.root,
      (element) => element.getAttribute("data-task-id") === task.task_id,
    ).find((element) => element.tagName === "BUTTON");
    session?.click();
    await controller.settled();
    const snapshot = serialize(document.root);
    const snapshotPath = fileURLToPath(
      new URL(`../fixtures/snapshots/${task.task_id}.html`, import.meta.url),
    );
    if (process.env.UPDATE_SNAPSHOTS === "1") {
      await writeFile(snapshotPath, `${snapshot}\n`, "utf8");
    } else {
      expect(snapshot).toBe(
        await readFile(snapshotPath, "utf8").then((text) => text.trimEnd()),
      );
    }
    if (task.task_id === "fixture-completed-verified") {
      expect(snapshot).not.toContain("<script>");
      expect(snapshot).not.toContain("<img");
      expect(snapshot).toContain("&lt;script&gt;");
      expect(snapshot).toContain("&lt;img");
    }
    for (const block of findAll(
      document.root,
      (element) => element.getAttribute("class") === "untrusted",
    )) {
      expect(block.getAttribute("data-provenance")).toBeTruthy();
      expect(block.textContent).toContain("untrusted ·");
    }
    for (const element of findAll(document.root, () => true)) {
      for (const name of element.attributes.keys())
        expect(name).not.toMatch(/^(?:on.*|style|href|src)$/i);
    }
    expect(
      calls.every((call) => READ_METHODS.includes(call.method as never)),
    ).toBe(true);
  }
});

test("completed and unverified remain separate and the reserved control is disabled", async () => {
  const data = await loadFixtureData();
  const document = new MiniDocument();
  const controller = createController(
    fakeBridge(data),
    document,
    document.root,
  );
  await controller.load();
  const completed = findAll(
    document.root,
    (element) =>
      element.getAttribute("data-task-id") === "fixture-completed-unverified",
  ).find((element) => element.tagName === "BUTTON");
  completed?.click();
  await controller.settled();
  const serialized = serialize(document.root);
  expect(serialized).toContain("Unverified");
  expect(serialized).toContain("✔ completed");
  const chat = findAll(
    document.root,
    (element) => element.textContent === "Team chat",
  )[0];
  expect(chat?.getAttribute("disabled")).toBe("");
  expect(chat?.getAttribute("aria-disabled")).toBe("true");
});

test("session switching reloads the selected task and tampered artifact text is omitted", async () => {
  const data = await loadFixtureData();
  const calls: RecordedCall[] = [];
  const document = new MiniDocument();
  const controller = createController(
    fakeBridge(data, calls),
    document,
    document.root,
  );
  await controller.load();
  const selected = findAll(
    document.root,
    (element) =>
      element.getAttribute("data-task-id") === "fixture-completed-verified",
  ).find((element) => element.tagName === "BUTTON");
  selected?.click();
  await controller.settled();
  expect(
    calls.some(
      (call) =>
        call.method === "tasks.inspect" &&
        (call.params as { task_id: string }).task_id ===
          "fixture-completed-verified",
    ),
  ).toBe(true);
  const tampered = findAll(
    document.root,
    (element) =>
      element.getAttribute("class") === "artifact" &&
      element.textContent.includes("artifact-tampered-text"),
  )[0];
  expect(tampered?.textContent).toContain("rejected: sha256 mismatch");
  expect(tampered?.textContent).not.toContain("<script>");
  const invalidUtf8 = findAll(
    document.root,
    (element) =>
      element.getAttribute("class") === "artifact" &&
      element.textContent.includes("artifact-invalid-utf8"),
  )[0];
  expect(invalidUtf8?.textContent).toContain("not valid UTF-8 · not rendered");
  expect(invalidUtf8?.textContent).not.toContain("�");
  expect(
    calls.every((call) => READ_METHODS.includes(call.method as never)),
  ).toBe(true);
});

test("refresh repeats the read-only description and list requests", async () => {
  const data = await loadFixtureData();
  const calls: RecordedCall[] = [];
  const document = new MiniDocument();
  const controller = createController(
    fakeBridge(data, calls),
    document,
    document.root,
  );
  await controller.load();
  const before = calls.length;
  findAll(
    document.root,
    (element) => element.textContent === "Refresh",
  )[0]?.click();
  await controller.settled();
  expect(calls.slice(before, before + 2).map((call) => call.method)).toEqual([
    "workbench.describe",
    "tasks.list",
  ]);
});

test("a session click during an in-flight load queues the selected task", async () => {
  const data = await loadFixtureData();
  const delegate = fakeBridge(data);
  let shouldDefer = false;
  let resolveDeferred!: (
    result: Awaited<ReturnType<(typeof delegate)["tasks.inspect"]>>,
  ) => void;
  let notifyStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  const bridge: ShellBridge = {
    ...delegate,
    "tasks.inspect": (params) => {
      if (shouldDefer && params.task_id === "fixture-running") {
        notifyStarted();
        return new Promise((resolve) => {
          resolveDeferred = resolve;
        });
      }
      return delegate["tasks.inspect"](params);
    },
  };
  const document = new MiniDocument();
  const controller = createController(bridge, document, document.root);
  await controller.load();
  shouldDefer = true;
  findAll(
    document.root,
    (element) => element.textContent === "Refresh",
  )[0]?.click();
  await started;
  findAll(
    document.root,
    (element) =>
      element.getAttribute("data-task-id") === "fixture-completed-verified",
  )
    .find((element) => element.tagName === "BUTTON")
    ?.click();
  resolveDeferred(
    await delegate["tasks.inspect"]({ task_id: "fixture-running" }),
  );
  await controller.settled();
  expect(
    findAll(document.root, (element) => element.tagName === "H1")[1]
      ?.textContent,
  ).toContain("fixture-completed-verified");
});
