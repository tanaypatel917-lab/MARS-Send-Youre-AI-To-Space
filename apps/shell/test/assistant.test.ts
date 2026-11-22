import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistant } from "../src/main/assistant";
import { type IpcEventLike, registerAssistantBridge } from "../src/main/ipc";
import { renderAssistant } from "../src/renderer/assistant-view";
import { ASSISTANT_CHANNEL } from "../src/shared/assistant";
import { ipcFixture } from "./ipc-fixture";
import { findAll, MiniDocument } from "./mini-dom";

const observed = (project: string, seenMessages = 0) => ({
  workspace: createHash("sha256").update(project).digest("hex"),
  seenMessages,
});

test("chat remembers multiple turns privately, survives restart, and isolates projects", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mars-chat-"));
  let workspace = "project-a";
  const seen: string[][] = [];
  const options = {
    directory,
    context: () => ({ workspace, key: "fixture-only" }),
    complete: async (messages: { content: string }[]) => {
      seen.push(messages.map((message) => message.content));
      return "A helpful answer";
    },
  };
  try {
    const chat = createAssistant(options);
    const id = randomUUID();
    expect(
      (
        await chat.call({
          action: "send",
          ...observed(workspace),
          id,
          text: "First question",
          consent: true,
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await chat.call({
          action: "send",
          ...observed(workspace, 2),
          id,
          text: "And a follow-up?",
          consent: true,
        })
      ).ok,
    ).toBe(true);
    expect(seen[1]).toEqual([
      "First question",
      "A helpful answer",
      "And a follow-up?",
    ]);
    const restarted = await createAssistant(options).call({ action: "load" });
    expect(restarted.ok && restarted.sessions[0]?.messages).toHaveLength(4);
    const filename = (await readdir(directory))[0];
    expect(filename).toBeDefined();
    expect((await stat(join(directory, filename ?? ""))).mode & 0o777).toBe(
      0o600,
    );
    expect(
      await readFile(join(directory, filename ?? ""), "utf8"),
    ).not.toContain("fixture-only");
    workspace = "project-b";
    const isolated = await chat.call({ action: "load" });
    expect(isolated.ok && isolated.sessions).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing keys, missing consent, invalid actions, and oversized prompts never reach the provider", async () => {
  let calls = 0;
  const chat = createAssistant({
    directory: "/not-written",
    context: () => ({ workspace: "project" }),
    complete: async () => {
      calls++;
      return "unexpected";
    },
  });
  for (const payload of [
    {
      action: "send",
      ...observed("project"),
      id: randomUUID(),
      text: "hello",
      consent: true,
    },
    {
      action: "send",
      ...observed("project"),
      id: randomUUID(),
      text: "hello",
      consent: false,
    },
    {
      action: "send",
      ...observed("project"),
      id: "../../escape",
      text: "hello",
      consent: true,
    },
    {
      action: "send",
      ...observed("project"),
      id: randomUUID(),
      text: "x".repeat(8001),
      consent: true,
    },
    { action: "execute", command: "anything" },
  ])
    expect((await chat.call(payload)).ok).toBe(false);
  expect(calls).toBe(0);
});

test("provider failures do not save partial turns or leak errors, and retries work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mars-chat-retry-"));
  let fail = true;
  const chat = createAssistant({
    directory,
    context: () => ({ workspace: "a", key: "private-fixture" }),
    complete: async () => {
      if (fail) throw new Error("private-fixture");
      return "recovered";
    },
  });
  try {
    const request = {
      action: "send",
      ...observed("a"),
      id: randomUUID(),
      text: "hello",
      consent: true,
    };
    const failed = await chat.call(request);
    expect(failed.ok).toBe(false);
    expect(JSON.stringify(failed)).not.toContain("private-fixture");
    expect(await readdir(directory)).toEqual([]);
    fail = false;
    const result = await chat.call(request);
    expect(result.ok && result.sessions[0]?.messages).toHaveLength(2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("two attached instances preserve distinct conversations and reject a stale turn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mars-chat-concurrent-"));
  const options = {
    directory,
    context: () => ({ workspace: "shared", key: "fixture" }),
  };
  const immediate = createAssistant({
    ...options,
    complete: async () => "fast",
  });
  try {
    for (const same of [false, true]) {
      const started = Promise.withResolvers<void>();
      const reply = Promise.withResolvers<string>();
      const other = createAssistant({
        ...options,
        complete: async () => {
          started.resolve();
          return reply.promise;
        },
      });
      const request = {
        action: "send",
        ...observed("shared"),
        consent: true,
        id: randomUUID(),
        text: "one",
      };
      const first = other.call(request);
      await started.promise;
      expect(
        (
          await immediate.call({
            ...request,
            id: same ? request.id : randomUUID(),
            text: "two",
          })
        ).ok,
      ).toBe(true);
      reply.resolve("slow");
      expect((await first).ok).toBe(!same);
    }
    const result = await immediate.call({ action: "load" });
    expect(result.ok && result.sessions).toHaveLength(3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("send rejects changed project and unseen turns before inference", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-scope-"));
  let workspace = "first";
  let calls = 0;
  const chat = createAssistant({
    directory,
    context: () => ({ workspace, key: "fixture" }),
    complete: async () => {
      calls++;
      return "answer";
    },
  });
  const request = {
    action: "send",
    id: randomUUID(),
    text: "first message",
    consent: true,
    ...observed(workspace),
  };
  try {
    expect((await chat.call(request)).ok).toBe(true);
    expect(await chat.call({ ...request, text: "stale answer" })).toMatchObject(
      { ok: false, reloadHistory: true },
    );
    workspace = "second";
    expect(
      await chat.call({
        ...request,
        seenMessages: 2,
        text: "first project only",
      }),
    ).toMatchObject({ ok: false, reloadHistory: true });
    expect(await chat.call({ action: "load" })).toMatchObject({
      ok: true,
      sessions: [],
    });
    expect(calls).toBe(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("only one model request can be in flight", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mars-chat-busy-"));
  const pending = Promise.withResolvers<string>();
  const started = Promise.withResolvers<void>();
  const chat = createAssistant({
    directory,
    context: () => ({ workspace: "a", key: "fixture" }),
    complete: () => {
      started.resolve();
      return pending.promise;
    },
  });
  try {
    const first = chat.call({
      action: "send",
      ...observed("a"),
      id: randomUUID(),
      text: "first",
      consent: true,
    });
    await started.promise;
    const second = await chat.call({
      action: "send",
      ...observed("a"),
      id: randomUUID(),
      text: "second",
      consent: true,
    });
    expect(second.ok).toBe(false);
    pending.resolve("done");
    expect((await first).ok).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("assistant IPC denies foreign senders before invoking the service", async () => {
  let calls = 0;
  const { options, owner, otherWindow, childFrame } = ipcFixture();
  const handlers = new Map<
    string,
    (event: IpcEventLike, payload: unknown) => unknown
  >();
  registerAssistantBridge(
    {
      handle: (channel, handler) => {
        handlers.set(channel, handler);
      },
    },
    {
      call: async () => {
        calls++;
        return {
          ok: true,
          sessions: [],
          workspace: "scope",
          configured: false,
          canConfigure: false,
        };
      },
    },
    options,
  );
  const load = (event: IpcEventLike) =>
    handlers.get(ASSISTANT_CHANNEL)?.(event, { action: "load" });
  for (const event of [
    otherWindow,
    childFrame,
    { ...owner, senderFrame: null },
  ]) {
    expect(await load(event)).toEqual({
      ok: false,
      error: "Chat request refused.",
    });
  }
  for (const url of [
    "https://evil.example",
    "mars-shell://other/index.html",
    "mars-shell://user@app/index.html",
    "mars-shell://app/recovery.html",
  ]) {
    owner.senderFrame.url = url;
    const result = await load(owner);
    expect(result).toEqual({ ok: false, error: "Chat request refused." });
  }
  expect(calls).toBe(0);
  const newMainFrame = { url: "mars-shell://app/index.html" };
  owner.sender.mainFrame = newMainFrame;
  expect(await load({ ...owner, senderFrame: newMainFrame })).toMatchObject({
    ok: true,
  });
});

test("assistant output is inert text and task handoff is always explicit", () => {
  const doc = new MiniDocument();
  let handoff = "";
  const content = '<img src=x onerror="run()">';
  const view = renderAssistant(doc, {
    sessions: [
      {
        id: randomUUID(),
        title: "A chat",
        messages: [{ role: "assistant", content }],
      },
    ],
    activeId: "new",
    draft: "",
    configured: false,
    consent: false,
    busy: false,
    loading: false,
  });
  expect(
    findAll(
      view as import("./mini-dom").MiniElement,
      (element) => element.tagName === "IMG",
    ),
  ).toHaveLength(0);
  const id = randomUUID();
  const transcript = renderAssistant(doc, {
    sessions: [
      { id, title: "A chat", messages: [{ role: "assistant", content }] },
    ],
    activeId: id,
    draft: "",
    configured: true,
    consent: true,
    busy: false,
    loading: false,
    onTask: (text) => {
      handoff = text;
    },
  });
  expect(transcript.textContent).toContain(content);
  expect(handoff).toBe("");
  findAll(
    transcript as import("./mini-dom").MiniElement,
    (element) => element.textContent === "Make a task  ↗",
  )[0]?.click();
  expect(handoff).toBe(content);
});
