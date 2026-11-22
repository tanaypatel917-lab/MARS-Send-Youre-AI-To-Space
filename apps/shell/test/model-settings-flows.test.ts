import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistant } from "../src/main/assistant";
import { hasRemovableKey } from "../src/main/model-key";
import { createLoopbackTransport, TransportError } from "../src/main/transport";
import { createController } from "../src/renderer/controller";
import { settingsActions } from "../src/renderer/settings-actions";
import { bridgeFailure, type ShellBridge } from "../src/shared/methods";
import { findAll, MiniDocument } from "./mini-dom";
import { fakeBridge, loadFixtureData } from "./test-utils";

test("Remove is available for a session key or unreadable encrypted file, but not on first launch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mars-key-presence-"));
  const file = join(dir, "key.bin");
  try {
    expect(await hasRemovableKey(file)).toBe(false);
    expect(await hasRemovableKey(file, "fixture")).toBe(true);
    await writeFile(file, Buffer.from([0xff, 0, 0xff]));
    expect(await hasRemovableKey(file)).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a key pasted in chat never reaches the provider or history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mars-misplaced-key-"));
  try {
    let requests = 0;
    const assistant = createAssistant({
      directory,
      context: () => ({ workspace: "demo", key: "fixture" }),
      complete: async () => {
        requests++;
        return "unexpected";
      },
    });
    const result = await assistant.call({
      action: "send",
      workspace: createHash("sha256").update("demo").digest("hex"),
      seenMessages: 0,
      id: randomUUID(),
      text: `Here is my key: sk-or-v1-${"x".repeat(36)}`,
      consent: true,
    });
    expect(!result.ok && result.error).toContain("Settings");
    expect(requests).toBe(0);
    expect(await assistant.call({ action: "load" })).toMatchObject({
      ok: true,
      sessions: [],
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("task model failure stays distinct from offline workbench and opens native setup", async () => {
  const fixture = await loadFixtureData();
  const task = fixture.tasks[0];
  if (!task) throw new Error("No fixture task");
  task.status = "pending";
  const doc = new MiniDocument();
  let opened = 0;
  const transport = createLoopbackTransport({
    url: "http://127.0.0.1:1234",
    token: "fixture",
    fetch: Object.assign(
      async () =>
        Response.json(
          { error: { code: "model_unavailable", message: "internal message" } },
          { status: 503 },
        ),
      { preconnect: () => {} },
    ),
  });
  const bridge: ShellBridge = {
    ...fakeBridge(fixture),
    "tasks.start": async (params) => {
      try {
        await transport.send({ method: "tasks.start", params });
        throw new Error("unexpected success");
      } catch (error) {
        if (!(error instanceof TransportError)) throw error;
        return bridgeFailure(error.kind);
      }
    },
  };
  const ctl = createController(bridge, doc, doc.root, undefined, {
    request: async (req) => {
      if (req.action === "settings") opened++;
      return {
        ok: true,
        workspace: "a",
        configured: false,
        canConfigure: true,
        sessions: [],
      };
    },
  });
  await ctl.load();
  const by = (key: string, value: string) =>
    findAll(doc.root, (el) => el.getAttribute(key) === value)[0];
  by("data-page", "tasks")?.click();
  by("data-action", "start-task")?.click();
  await Bun.sleep(0);
  expect(doc.root.textContent).toContain("No OpenRouter key is configured");
  expect(doc.root.textContent).not.toContain("Workbench is unavailable");
  by("data-focus-key", "task-add-key")?.click();
  expect(opened).toBe(1);
  expect(by("data-panel", "settings")).toBeUndefined();
  expect(by("data-action", "start-task")).toBeDefined();
});

test("failed read-only launch keeps its own approvals when switching tasks and retrying", async () => {
  const fixture = await loadFixtureData();
  const [first, second] = fixture.tasks;
  if (!first || !second) throw new Error("Two tasks required");
  first.status = second.status = "pending";
  const attempted: Parameters<ShellBridge["tasks.start"]>[0][] = [];
  const { promise, resolve } = Promise.withResolvers<void>();
  const doc = new MiniDocument();
  const ctl = createController(
    {
      ...fakeBridge(fixture),
      "tasks.start": async (params) => {
        attempted.push(params);
        await promise;
        return bridgeFailure("model_unavailable");
      },
    },
    doc,
    doc.root,
  );
  await ctl.load();
  const control = (attribute: string, val: string) => {
    const el = findAll(doc.root, (el) => el.getAttribute(attribute) === val)[0];
    if (!el) throw new Error(`Missing ${val}`);
    return el;
  };
  const select = async (id: string) => {
    control("data-task-id", id).click();
    await ctl.settled();
  };
  const write = () => control("data-control", "approval-write");
  const toggle = (value: boolean) => {
    const el = write();
    el.checked = value;
    el.dispatch("change");
  };
  const start = () => control("data-action", "start-task").click();
  toggle(false);
  start();
  await select(second.task_id);
  toggle(true);
  resolve();
  await Bun.sleep(0);
  expect(doc.root.textContent).not.toContain("No available model");
  await select(first.task_id);
  expect(write().checked).toBe(false);
  expect(doc.root.textContent).toContain("No available model");
  start();
  expect(attempted.map((req) => [req.task_id, req.approvals])).toEqual(
    Array(2).fill([
      first.task_id,
      { read: true, write: false, execute: false },
    ]),
  );
  await select(second.task_id);
  expect(write().checked).toBe(true);
});

test("install preserves the library position and drafts an example without executing or replacing existing work", async () => {
  const doc = new MiniDocument();
  const calls: { method: string; params: unknown }[] = [];
  const item = {
    id: "mars-json-compare",
    name: "JSON comparison",
    kind: "mcp" as const,
    description: "Compare JSON",
    permissions: [],
    version: "1",
    installed: false,
  };
  const ctl = createController(
    fakeBridge(await loadFixtureData(), calls),
    doc,
    doc.root,
    undefined,
    {
      request: async () => ({
        ok: true,
        workspace: "test",
        configured: false,
        canConfigure: true,
        sessions: [],
      }),
    },
    {
      list: async () => [{ ...item }],
      install: async () => {
        item.installed = true;
        return "installed";
      },
    },
  );
  await ctl.load();
  const el = (attr: string, val: string) => {
    const element = findAll(doc.root, (e) => e.getAttribute(attr) === val)[0];
    if (!element) throw new Error(`Missing ${val}`);
    return element;
  };
  const open = async () => {
    el("data-page", "extensions").click();
    await Bun.sleep(0);
  };
  await open();
  el("data-library-scroll", "true").scrollTop = 480;
  const action = () => el("data-focus-key", "extension-mars-json-compare");
  action().click();
  await Bun.sleep(0);
  expect(el("data-library-scroll", "true").scrollTop).toBe(480);
  expect(action().textContent).toBe("Draft a task");
  action().click();
  const input = el("data-control", "composer-request");
  expect(input.value).toContain("changed paths");
  input.value = "Keep my existing work";
  input.dispatch("input");
  await open();
  expect(action().textContent).toBe("Open task draft");
  action().click();
  expect(el("data-control", "composer-request").value).toBe(
    "Keep my existing work",
  );
  expect(
    calls.some(
      (c) => c.method === "tasks.create" || c.method === "tasks.start",
    ),
  ).toBe(false);
});

test("attached workbench without a key explains environment setup without offering a settings window", async () => {
  const doc = new MiniDocument();
  const ctl = createController(
    fakeBridge(await loadFixtureData()),
    doc,
    doc.root,
    undefined,
    {
      request: async () => ({
        ok: true,
        configured: false,
        workspace: "scope",
        canConfigure: false,
        sessions: [],
      }),
    },
  );
  await ctl.load();
  expect(doc.root.textContent).toContain("OPENROUTER_API_KEY");
  expect(
    findAll(
      doc.root,
      (el) =>
        el.tagName === "BUTTON" && el.textContent.includes("Connect model"),
    ),
  ).toHaveLength(0);
  findAll(
    doc.root,
    (el) => el.tagName === "BUTTON" && el.textContent.includes("Settings"),
  )[0]?.click();
  expect(
    findAll(doc.root, (el) => el.getAttribute("data-panel") === "settings"),
  ).toHaveLength(1);
  expect(doc.root.textContent).toContain("OPENROUTER_API_KEY");
  expect(doc.root.textContent).not.toContain("Add API key");
});

test.each([false, true])(
  "installed Settings shows key state and opens secure entry (configured: %s)",
  async (configured) => {
    const doc = new MiniDocument();
    const calls: string[] = [];
    const ctl = createController(
      fakeBridge(await loadFixtureData()),
      doc,
      doc.root,
      undefined,
      {
        request: async (req) => {
          calls.push(req.action);
          return {
            ok: true,
            workspace: "scope",
            canConfigure: true,
            configured,
            sessions: [],
          };
        },
      },
    );
    await ctl.load();
    const button = (label: string) =>
      findAll(
        doc.root,
        (el) => el.tagName === "BUTTON" && el.textContent.includes(label),
      )[0];
    button("Tasks")?.click();
    button("Settings")?.click();
    expect(doc.root.textContent).toContain(
      configured ? "Key present" : "No key added",
    );
    expect(button("Tasks")?.getAttribute("aria-pressed")).toBe("false");
    button(configured ? "Manage API key" : "Add API key")?.click();
    expect(calls).toEqual(["load", "settings"]);
    expect(
      findAll(doc.root, (el) => el.getAttribute("type") === "password"),
    ).toHaveLength(0);
    button("Browse extensions")?.click();
    expect(
      findAll(doc.root, (el) => el.getAttribute("data-panel") === "extensions"),
    ).toHaveLength(1);
  },
);

test("changing credentials invalidates a pending turn without blocking the next credential or saving a late reply", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mars-change-key-"));
  try {
    const old = new AbortController();
    let signal = old.signal;
    let key: string | undefined = "first-fixture";
    const started = Promise.withResolvers<void>();
    const reply = Promise.withResolvers<string>();
    const chat = createAssistant({
      directory,
      context: () => ({ workspace: "p", key, signal }),
      complete: async (_messages, token, requestSignal) => {
        if (token !== "first-fixture") return "new reply";
        expect(requestSignal).toBe(old.signal);
        started.resolve();
        return reply.promise;
      },
    });
    const request = {
      action: "send",
      workspace: createHash("sha256").update("p").digest("hex"),
      seenMessages: 0,
      id: randomUUID(),
      text: "old",
      consent: true,
    };
    const pending = chat.call(request);
    await started.promise;
    old.abort();
    signal = new AbortController().signal;
    key = undefined;
    const removed = await chat.call({ ...request, text: "removed" });
    expect(!removed.ok && removed.error).toContain("API key");
    key = "second-fixture";
    expect((await chat.call({ ...request, text: "new" })).ok).toBe(true);
    reply.resolve("stale reply");
    expect((await pending).ok).toBe(false);
    const history = await chat.call({ action: "load" });
    expect(
      history.ok && history.sessions[0]?.messages.map((m) => m.content),
    ).toEqual(["new", "new reply"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("settings gives a browser fallback, preserves invalid input and clears a saved key", async () => {
  const doc = new MiniDocument();
  const controls = {
    input: doc.root,
    status: { textContent: "" },
    save: { disabled: false },
    clear: { disabled: false },
  };
  const actions = settingsActions(
    {
      hasKey: async () => false,
      openKeyPage: async () => {
        throw new Error("no browser");
      },
      setKey: async (key) => (key === "accepted-fixture" ? "saved" : "invalid"),
    },
    controls,
  );
  await actions.initialize();
  expect(controls.clear.disabled).toBe(true);
  await actions.apply(null);
  expect(controls.status.textContent).toBe("");
  await actions.openKeyPage();
  expect(controls.status.textContent).toContain("Settings → API Keys");
  controls.input.value = "typo";
  await actions.apply("typo");
  expect(controls.input.value).toBe("typo");
  expect(controls.status.textContent).toContain("Check your key");
  controls.input.value = "accepted-fixture";
  await actions.apply("accepted-fixture");
  expect(controls.input.value).toBe("");
  expect(controls.clear.disabled).toBe(false);
});
