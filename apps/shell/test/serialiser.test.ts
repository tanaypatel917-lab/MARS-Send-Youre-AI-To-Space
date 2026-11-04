import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { EventEnvelope } from "@mars/contracts";
import { createController } from "../src/renderer/controller";
import { READ_METHODS, type ShellBridge } from "../src/shared/methods";
import { findAll, MiniDocument, serialize } from "./mini-dom";
import { fakeBridge, loadFixtureData, type RecordedCall } from "./test-utils";

function pagedBridge(
  data: Awaited<ReturnType<typeof loadFixtureData>>,
  events: EventEnvelope[],
  cursors: (string | undefined)[],
): ShellBridge {
  const delegate = fakeBridge(data);
  return {
    ...delegate,
    "tasks.events": async ({ after_event_id }) => {
      cursors.push(after_event_id);
      const offset = after_event_id
        ? Number(after_event_id.slice("page-".length))
        : 0;
      return {
        ok: true,
        result: events.slice(offset, offset + 100),
      };
    },
  };
}

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
    expect(calls.some((call) => call.method === "tasks.journal")).toBe(false);
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

test("pending task details stay visible when workspace sections are unavailable", async () => {
  const data = await loadFixtureData();
  const document = new MiniDocument();
  const controller = createController(
    fakeBridge(data),
    document,
    document.root,
  );
  await controller.load();
  findAll(
    document.root,
    (element) => element.getAttribute("data-task-id") === "fixture-pending",
  )
    .find((element) => element.tagName === "BUTTON")
    ?.click();
  await controller.settled();

  const snapshot = serialize(document.root);
  expect(snapshot).toContain('data-task-id="fixture-pending"');
  expect(snapshot).toContain("<h1>Task fixture-pending</h1>");
  expect(snapshot).toContain("Pending sample task.");
  expect(snapshot).toContain("unavailable · Workbench resource was not found.");
  expect(
    snapshot.match(/unavailable · Workbench resource was not found\./g),
  ).toHaveLength(2);
});

test("verification and event failures are section-local and verification stays unverified", async () => {
  const data = await loadFixtureData();
  const delegate = fakeBridge(data);
  const notFound = {
    ok: false as const,
    error: {
      kind: "not_found" as const,
      message: "Workbench resource was not found.",
    },
  };
  const bridge: ShellBridge = {
    ...delegate,
    "tasks.verification": (params) =>
      params.task_id === "fixture-pending"
        ? Promise.resolve(notFound)
        : delegate["tasks.verification"](params),
    "tasks.events": (params) =>
      params.task_id === "fixture-pending"
        ? Promise.resolve(notFound)
        : delegate["tasks.events"](params),
  };
  const document = new MiniDocument();
  const controller = createController(bridge, document, document.root);
  await controller.load();
  findAll(
    document.root,
    (element) => element.getAttribute("data-task-id") === "fixture-pending",
  )
    .find((element) => element.tagName === "BUTTON")
    ?.click();
  await controller.settled();

  const snapshot = serialize(document.root);
  expect(snapshot).toContain("Unverified");
  expect(snapshot).toContain("unavailable · Workbench resource was not found.");
  expect(snapshot).toContain("Task fixture-pending");
  expect(snapshot).toContain("fixture-completed-verified");
});

test("task events page with cursors and stop at 1,000 entries", async () => {
  const data = await loadFixtureData();
  const baseEvent = data.details["fixture-running"]?.events[0];
  if (!baseEvent) throw new Error("Fixture event missing.");

  for (const [count, expectedCalls, expectedCount] of [
    [250, 3, "250 task events"],
    [1500, 10, "1000+ task events"],
  ] as const) {
    const events = Array.from({ length: count }, (_, index) => ({
      ...baseEvent,
      event_id: `page-${index + 1}`,
    }));
    const cursors: (string | undefined)[] = [];
    const document = new MiniDocument();
    const controller = createController(
      pagedBridge(data, events, cursors),
      document,
      document.root,
    );
    await controller.load();

    expect(cursors).toHaveLength(expectedCalls);
    expect(cursors[0]).toBeUndefined();
    expect(cursors.slice(1)).toEqual(
      Array.from(
        { length: expectedCalls - 1 },
        (_, index) => `page-${(index + 1) * 100}`,
      ),
    );
    expect(
      findAll(document.root, (element) => element.tagName === "P")
        .map((element) => element.textContent)
        .join(" "),
    ).toContain(expectedCount);
  }
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

test("connection error view retries the controller load", async () => {
  const data = await loadFixtureData();
  const delegate = fakeBridge(data);
  let describeCalls = 0;
  const bridge: ShellBridge = {
    ...delegate,
    "workbench.describe": (params) => {
      describeCalls++;
      if (describeCalls === 1)
        return Promise.resolve({
          ok: false,
          error: {
            kind: "not_connected",
            message: "Workbench is unavailable.",
          },
        });
      return delegate["workbench.describe"](params);
    },
  };
  const document = new MiniDocument();
  const controller = createController(bridge, document, document.root);

  await controller.load();
  expect(
    findAll(document.root, (element) => element.textContent === "Retry"),
  ).toHaveLength(1);
  findAll(
    document.root,
    (element) => element.textContent === "Retry",
  )[0]?.click();
  await controller.settled();

  expect(describeCalls).toBe(2);
  expect(serialize(document.root)).toContain("Connected");
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
