import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUILTIN_MODELS,
  BUILTIN_PROVIDERS,
  createOpenAICompatibleAdapter,
} from "@mars/providers";
import { ProviderError } from "../../../packages/providers/src/models/errors";
import {
  classifyProviderFailure,
  createAssistant,
} from "../src/main/assistant";
import { createSetupJournal, observeBridge } from "../src/main/setup-journal";
import { renderAssistant } from "../src/renderer/assistant-view";
import { createController } from "../src/renderer/controller";
import { renderSettings } from "../src/renderer/settings-view";
import type { SetupSummary } from "../src/shared/setup";
import { findAll, MiniDocument, type MiniElement } from "./mini-dom";
import { fakeBridge, loadFixtureData } from "./test-utils";

const fail = (status: number | undefined, extra = {}) =>
  new ProviderError("openrouter", "private-fixture", {
    retryable: false,
    ...(status === undefined ? {} : { status }),
    ...extra,
  });

test("provider failures map to actionable model health", () => {
  expect(classifyProviderFailure(fail(429, { retryAfterMs: 1500 }))).toEqual({
    issue: "rate_limited",
    retryAfterSeconds: 2,
  });
  expect(classifyProviderFailure(fail(401)).issue).toBe("auth_failed");
  expect(classifyProviderFailure(fail(403)).issue).toBe("auth_failed");
  expect(classifyProviderFailure(fail(402)).issue).toBe("credits");
  expect(
    classifyProviderFailure(fail(undefined, { retryable: true })).issue,
  ).toBe("network");
  expect(classifyProviderFailure(fail(undefined)).issue).toBe("unavailable");
  expect(classifyProviderFailure(fail(504, { timedOut: true })).issue).toBe(
    "network",
  );
  expect(classifyProviderFailure(fail(503)).issue).toBe("unavailable");
  expect(classifyProviderFailure(fail(200)).issue).toBe("unavailable");
  expect(classifyProviderFailure(new Error("x")).issue).toBe("unavailable");
});

test("chat reports rate limits and recovery, and the journal records setup locally", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mars-setup-"));
  const journalPath = join(directory, "journal", "setup.json");
  const journal = createSetupJournal(
    journalPath,
    () => new Date("2026-11-25T00:00:00Z"),
  );
  let error: Error | undefined = fail(429, { retryAfterMs: 30_000 });
  const chat = createAssistant({
    directory: join(directory, "history"),
    context: () => ({ workspace: "a", key: "private-fixture" }),
    complete: async () => {
      if (error) throw error;
      return "ok";
    },
    journal,
    now: () => new Date("2026-11-25T00:00:00Z"),
  });
  try {
    const loaded = await chat.call({ action: "load" });
    expect(loaded.ok && loaded.health?.state).toBe("unchecked");
    const request = {
      action: "send",
      workspace: createHash("sha256").update("a").digest("hex"),
      seenMessages: 0,
      id: randomUUID(),
      text: "hi",
      consent: true,
    };
    const limited = await chat.call(request);
    expect(limited.ok).toBe(false);
    if (limited.ok) throw new Error("expected failure");
    expect(limited.health).toMatchObject({
      state: "rate_limited",
      retryAfterSeconds: 30,
    });
    expect(limited.error).toContain("rate-limited");
    expect(limited.error).toContain("30s");
    expect(limited.setup?.issues).toEqual({ rate_limited: 1 });
    expect(JSON.stringify(limited)).not.toContain("private-fixture");
    error = fail(401);
    const rejected = await chat.call(request);
    expect(!rejected.ok && rejected.error).toContain("OPENROUTER_API_KEY");
    error = undefined;
    const ok = await chat.call(request);
    expect(ok.ok && ok.health?.state).toBe("ok");
    expect(ok.ok && ok.setup).toEqual({
      milestones: {
        key_connected: "2026-11-25T00:00:00.000Z",
        first_chat_reply: "2026-11-25T00:00:00.000Z",
      },
      issues: { rate_limited: 1, auth_failed: 1 },
    });
    expect((await stat(journalPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(journalPath, "utf8")).not.toContain("hi");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bridge results mark task milestones once and count model setup failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mars-setup-"));
  const path = join(directory, "setup.json");
  let clock = 0;
  const journal = createSetupJournal(path, () => new Date(++clock * 1000));
  try {
    observeBridge(journal, "tasks.create", { ok: true, result: {} });
    observeBridge(journal, "tasks.create", { ok: true, result: {} });
    observeBridge(journal, "tasks.export", {
      ok: true,
      result: { verified: false },
    });
    observeBridge(journal, "tasks.start", {
      ok: false,
      error: { kind: "model_unavailable", message: "x" },
    } as never);
    observeBridge(journal, "tasks.export", {
      ok: true,
      result: { verified: true },
    });
    const summary = await journal.snapshot();
    expect(summary.milestones).toEqual({
      first_task_created: new Date(1000).toISOString(),
      first_verified_export: new Date(2000).toISOString(),
    });
    expect(summary.issues).toEqual({ task_model_unavailable: 1 });
    const reopened = await createSetupJournal(path).snapshot();
    expect(reopened).toEqual(summary);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("chat entry explains tasks, offers Start a coding task, and shows cost and health", () => {
  const doc = new MiniDocument();
  let handoff: string | undefined;
  const view = renderAssistant(doc, {
    sessions: [],
    activeId: "new",
    draft: "  Fix the login bug  ",
    configured: true,
    consent: false,
    busy: false,
    loading: false,
    health: { state: "rate_limited" },
    onTask: (text) => {
      handoff = text;
    },
  });
  const text = view.textContent ?? "";
  expect(text).toContain("can’t read your files");
  expect(text).toContain("OpenRouter · Free · Rate-limited");
  expect(text).toContain("Paid models are only used by tasks you approve");
  const starts = findAll(
    view as MiniElement,
    (element) => element.textContent === "Start a coding task  ↗",
  );
  expect(starts).toHaveLength(2);
  starts[0]?.click();
  expect(handoff).toBe("Fix the login bug");
});

test("settings diagnostics show key, model, verification, and local pilot progress", () => {
  const doc = new MiniDocument();
  const view = renderSettings(
    doc,
    {
      sessions: [],
      activeId: "new",
      draft: "",
      configured: true,
      canConfigure: true,
      consent: false,
      busy: false,
      loading: false,
      health: { state: "auth_failed", at: "2026-11-25T01:02:03.000Z" },
      setup: {
        milestones: { opened: "2026-11-24T00:00:00.000Z" },
        issues: { rate_limited: 3 },
      },
    },
    undefined,
    () => {},
    () => {},
    {
      checks: 1,
      readiness: { status: "unavailable", reason: "Docker is not running" },
    },
  );
  const text = view.textContent ?? "";
  expect(text).toContain("Setup diagnostics");
  expect(text).toContain("Key rejected · 2026-11-25");
  expect(text).toContain("Docker is not running");
  expect(text).toContain("First opened MARS2026-11-24");
  expect(text).toContain("First task startedNot yet");
  expect(text).toContain("Chat rate-limited by provider3×");
  expect(text).toContain("Nothing here is sent anywhere");
  const demo = renderSettings(
    doc,
    { ...emptyModel(), configured: false },
    undefined,
    () => {},
    () => {},
    { checks: 0 },
  );
  expect(demo.textContent).toContain("No host checks configured");
  expect(demo.textContent).not.toContain("Connect to your workbench");
});

test("Start a coding task hands off the live, unrendered draft", () => {
  const doc = new MiniDocument();
  let handoff: string | undefined;
  const view = renderAssistant(doc, {
    ...emptyModel(),
    draft: "old",
    onTask: (text) => {
      handoff = text;
    },
  }) as MiniElement;
  const input = findAll(view, (element) => element.tagName === "TEXTAREA")[0];
  if (!input) throw new Error("missing composer");
  input.value = " fresh draft ";
  findAll(
    view,
    (element) => element.textContent === "Start a coding task  ↗",
  )[0]?.click();
  expect(handoff).toBe("fresh draft");
  input.value = "";
  findAll(
    view,
    (element) => element.textContent === "Start a coding task  ↗",
  )[1]?.click();
  expect(handoff).toBe("");
});

const emptyModel = () => ({
  sessions: [],
  activeId: "new",
  draft: "",
  configured: true,
  canConfigure: true,
  consent: false,
  busy: false,
  loading: false,
});

test("a Chat handoff that replaces an unsaved task request can restore it", async () => {
  const doc = new MiniDocument();
  const ctl = createController(
    fakeBridge(await loadFixtureData()),
    doc,
    doc.root,
    undefined,
    {
      request: async () => ({
        ok: true,
        sessions: [],
        configured: true,
        workspace: "scope",
        canConfigure: false,
      }),
    },
  );
  await ctl.load();
  const one = (match: (el: MiniElement) => boolean, label: string) => {
    const el = findAll(doc.root, match)[0];
    if (!el) throw new Error(`Missing ${label}`);
    return el;
  };
  const nav = (page: string) =>
    one((el) => el.getAttribute("data-page") === page, page).click();
  const request = () =>
    one(
      (el) => el.getAttribute("data-control") === "composer-request",
      "task prompt",
    );
  const handoff = (text: string) => {
    nav("chat");
    one((el) => el.tagName === "TEXTAREA", "chat input").value = text;
    one(
      (el) => el.textContent === "Start a coding task  ↗",
      "Start a coding task",
    ).click();
  };
  const restore = () =>
    findAll(
      doc.root,
      (el) => el.getAttribute("data-action") === "restore-task-request",
    )[0];

  nav("tasks");
  request().value = "Keep my existing work";
  request().dispatch("input");
  handoff("Fix the login bug");
  expect(request().value).toBe("Fix the login bug");
  expect(doc.root.textContent).toContain("replaced your earlier task request");
  restore()?.click();
  expect(request().value).toBe("Keep my existing work");
  expect(restore()).toBeUndefined();

  handoff("Keep my existing work");
  expect(restore()).toBeUndefined();

  handoff("Fix the login bug");
  request().value = "";
  request().dispatch("input");
  handoff("Add a settings page");
  expect(request().value).toBe("Add a settings page");
  restore()?.click();
  expect(request().value).toBe("Keep my existing work");
  handoff("");
  expect(request().value).toBe("Keep my existing work");
  expect(restore()).toBeUndefined();
});

test.each(["<html>", '{"choices":[{}]}', '{"error":{"message":"failed"}}'])(
  "a malformed or unclassified provider reply is not reported as unreachable: %s",
  async (body) => {
    const provider = BUILTIN_PROVIDERS.find(
      (entry) => entry.id === "openrouter",
    );
    const model = BUILTIN_MODELS.find(
      (entry) => entry.id === "openrouter/free",
    );
    if (!provider || !model) throw new Error("Missing OpenRouter free model");
    const adapter = createOpenAICompatibleAdapter(provider, {
      env: { OPENROUTER_API_KEY: "fixture" },
      fetch: async () => new Response(body, { status: 200 }),
    });
    const error = await adapter
      .complete({ messages: [{ role: "user", content: "Hi" }] }, model)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    if (body === "<html>") expect(error).toHaveProperty("status", 200);
    expect(classifyProviderFailure(error).issue).toBe("unavailable");
  },
);

test("a rejected key in attach mode points to the launch environment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mars-attach-"));
  const call = (settings?: () => void) =>
    createAssistant({
      directory,
      context: () => ({ workspace: "a", key: "private-fixture", settings }),
      complete: async () => {
        throw fail(401);
      },
    }).call({
      action: "send",
      workspace: createHash("sha256").update("a").digest("hex"),
      seenMessages: 0,
      id: randomUUID(),
      text: "hi",
      consent: true,
    });
  try {
    const attached = await call();
    expect(!attached.ok && attached.error).toContain("OPENROUTER_API_KEY");
    expect(!attached.ok && attached.error).not.toContain("Settings");
    const installed = await call(() => {});
    expect(!installed.ok && installed.error).toContain(
      "Settings → Model connection",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Settings refreshes pilot progress even when Chat history cannot load", async () => {
  const doc = new MiniDocument();
  const data = await loadFixtureData();
  delete data.describe.checks;
  delete data.describe.verification_readiness;
  let setup: SetupSummary = { milestones: {}, issues: {} };
  let historyRequests = 0;
  const ctl = createController(
    fakeBridge({ ...data, tasks: [] }),
    doc,
    doc.root,
    undefined,
    {
      request: async () => {
        historyRequests++;
        return { ok: false, error: "Chat history could not be read." };
      },
      setup: async () => setup,
    },
  );
  await ctl.load();
  setup = {
    milestones: { first_verified_export: "2026-11-25T00:00:00.000Z" },
    issues: { network: 2 },
  };
  findAll(
    doc.root,
    (el) => el.getAttribute("data-page") === "settings",
  )[0]?.click();
  await ctl.settled();
  expect(historyRequests).toBe(1);
  expect(doc.root.textContent).toContain("First verified patch exported");
  expect(doc.root.textContent).toMatch(/Chat could not reach provider\D*2/);
  expect(doc.root.textContent).toContain("Workbench online");
  const verification = findAll(
    doc.root,
    (el) => el.getAttribute("data-diagnostic") === "verification",
  )[0];
  expect(verification?.textContent).toContain("No host checks configured");
});
