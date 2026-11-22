import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistant } from "../src/main/assistant";
import { createController } from "../src/renderer/controller";
import { settingsActions } from "../src/renderer/settings-actions";
import { findAll, MiniDocument } from "./mini-dom";
import { fakeBridge, loadFixtureData } from "./test-utils";

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
      configured ? "Key configured" : "No key added",
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
