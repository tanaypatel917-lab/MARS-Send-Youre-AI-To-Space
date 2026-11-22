import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHistory, saveTurn } from "../src/main/assistant-history";
import { createController } from "../src/renderer/controller";
import type { AssistantApi, AssistantResult } from "../src/shared/assistant";
import { findAll, MiniDocument } from "./mini-dom";
import { fakeBridge, loadFixtureData } from "./test-utils";

test("chat history rolls back a hot journal after the writer exits abruptly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mars-hot-journal-"));
  try {
    const file = join(dir, "chat.sqlite");
    const original = { id: randomUUID(), title: "Before exit", messages: [] };
    await saveTurn(file, original, 0);
    const writer = spawnSync(process.execPath, [
      "-e",
      `
      const {DatabaseSync} = require("node:sqlite");
      const db = new DatabaseSync(process.argv[1]);
      db.exec("PRAGMA journal_mode=DELETE; PRAGMA cache_size=2; BEGIN IMMEDIATE; UPDATE chats SET data=zeroblob(500000);");
      process.kill(process.pid, "SIGKILL");
    `,
      file,
    ]);
    expect(writer.signal).toBe("SIGKILL");
    expect(await readHistory(file)).toEqual([original]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function button(doc: MiniDocument, text: string) {
  const result = findAll(
    doc.root,
    (el) => el.tagName === "BUTTON" && el.textContent.includes(text),
  )[0];
  if (!result) throw new Error(`Missing button: ${text}`);
  return result;
}

test("chat load waits for another process to release a brief SQLite write lock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mars-history-busy-"));
  try {
    const file = join(dir, "chat.sqlite");
    const original = { id: randomUUID(), title: "Saved", messages: [] };
    await saveTurn(file, original, 0);
    const writer = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
      const {DatabaseSync} = require("node:sqlite");
      const db = new DatabaseSync(process.argv[1]);
      db.exec("BEGIN EXCLUSIVE"); console.log("locked");
      setTimeout(() => {db.exec("COMMIT"); db.close()}, 150);
    `,
        file,
      ],
      { stdout: "pipe" },
    );
    try {
      expect(
        new TextDecoder().decode(
          (await writer.stdout.getReader().read()).value,
        ),
      ).toContain("locked");
      expect(await readHistory(file)).toEqual([original]);
    } finally {
      await writer.exited;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("task Refresh keeps keyboard focus while a separate offline banner offers Retry", async () => {
  const doc = new MiniDocument();
  const base = fakeBridge(await loadFixtureData());
  let online = true;
  const ctl = createController(
    {
      ...base,
      "workbench.describe": (args) =>
        online
          ? base["workbench.describe"](args)
          : Promise.resolve({
              ok: false,
              error: { kind: "not_connected", message: "Offline" },
            }),
    },
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
  button(doc, "Tasks").click();
  online = false;
  const refresh = button(doc, "Refresh");
  refresh.focus();
  refresh.click();
  await ctl.settled();
  expect(button(doc, "Retry")).toBeDefined();
  expect(doc.activeElement?.textContent).toBe("Refresh");
});

test("chat exposes a disconnected workbench with Retry and recovers its configured model", async () => {
  let online = false;
  const base = fakeBridge(await loadFixtureData());
  const doc = new MiniDocument();
  let attempts = 0;
  const assistant: AssistantApi = {
    request: async () => {
      attempts++;
      return online
        ? {
            ok: true,
            sessions: [],
            configured: true,
            workspace: "scope",
            canConfigure: false,
          }
        : { ok: false, error: "Connect to a workbench." };
    },
  };
  const ctl = createController(
    {
      ...base,
      "workbench.describe": async (args) =>
        online
          ? base["workbench.describe"](args)
          : {
              ok: false,
              error: { kind: "not_connected", message: "Demo host offline." },
            },
    },
    doc,
    doc.root,
    undefined,
    assistant,
  );
  await ctl.load();
  expect(doc.root.textContent).toContain("Demo host offline.");
  online = true;
  button(doc, "Retry").click();
  await ctl.settled();
  expect(attempts).toBe(2);
  expect(doc.root.textContent).not.toContain("Demo host offline.");
  expect(doc.root.textContent).not.toContain("Connect to a workbench.");
  expect(doc.root.textContent).toContain("OpenRouter’s free model route");
});

test("a failed chat load retries even when the workbench itself is available", async () => {
  const doc = new MiniDocument();
  let attempts = 0;
  const ctl = createController(
    fakeBridge(await loadFixtureData()),
    doc,
    doc.root,
    undefined,
    {
      request: async () => {
        if (++attempts === 1) throw new Error("temporary");
        return {
          ok: true,
          sessions: [],
          configured: true,
          workspace: "scope",
          canConfigure: false,
        };
      },
    },
  );
  await ctl.load();
  button(doc, "Retry chat").click();
  await ctl.settled();
  expect(attempts).toBe(2);
  expect(doc.root.textContent).toContain("OpenRouter’s free model route");
});

test("model refresh preserves drafts while a workspace switch resets chat and consent", async () => {
  const doc = new MiniDocument();
  let workspace = "a";
  let configured = false;
  const first = { id: randomUUID(), title: "First project chat", messages: [] };
  const ctl = createController(
    fakeBridge(await loadFixtureData()),
    doc,
    doc.root,
    undefined,
    {
      request: async () => ({
        ok: true,
        workspace,
        configured,
        canConfigure: true,
        sessions: workspace === "a" ? [first] : [],
      }),
    },
  );
  const field = (key: string) =>
    findAll(doc.root, (el) => el.getAttribute("data-focus-key") === key)[0]!;
  await ctl.load();
  field("assistant-input").value = "unsent first project draft";
  field("assistant-input").dispatch("input");
  configured = true;
  await ctl.load();
  expect(field("assistant-input").value).toBe("unsent first project draft");
  field("chat-consent").checked = true;
  field("chat-consent").dispatch("change");
  workspace = "b";
  await ctl.load();
  expect(doc.root.textContent).not.toContain(first.title);
  expect(field("assistant-input").value).toBe("");
  expect(field("chat-consent").checked).toBeFalsy();
});

test("switching conversations cannot misplace a failed in-flight draft", async () => {
  const doc = new MiniDocument();
  const pending = Promise.withResolvers<AssistantResult>();
  const sessions = ["Original", "Other session"].map((title) => ({
    id: randomUUID(),
    title,
    messages: [],
  }));
  const ctl = createController(
    fakeBridge(await loadFixtureData()),
    doc,
    doc.root,
    undefined,
    {
      request: async (payload) =>
        payload.action === "send"
          ? pending.promise
          : {
              ok: true,
              configured: true,
              workspace: "scope",
              canConfigure: true,
              sessions,
            },
    },
  );
  await ctl.load();
  const field = () =>
    findAll(
      doc.root,
      (el) => el.getAttribute("data-focus-key") === "assistant-input",
    )[0];
  const box = findAll(
    doc.root,
    (el) => el.getAttribute("data-focus-key") === "chat-consent",
  )[0];
  if (!box) throw new Error("Missing consent checkbox");
  box.checked = true;
  box.dispatch("change");
  const input = field();
  if (!input) throw new Error("Missing composer");
  input.value = "Keep this question";
  input.dispatch("input");
  button(doc, "Send ↗").click();
  button(doc, "New conversation").click();
  button(doc, "Other session").click();
  pending.resolve({ ok: false, error: "Could not send; draft kept." });
  await Bun.sleep(0);
  expect(field()?.value).toBe("Keep this question");
  expect(doc.root.textContent).toContain("Could not send; draft kept.");
});
