import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderError } from "../../../packages/providers/src/models/errors";
import {
  classifyProviderFailure,
  createAssistant,
} from "../src/main/assistant";
import { createSetupJournal, observeBridge } from "../src/main/setup-journal";
import { renderAssistant } from "../src/renderer/assistant-view";
import { renderSettings } from "../src/renderer/settings-view";
import { findAll, MiniDocument, type MiniElement } from "./mini-dom";

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
  expect(classifyProviderFailure(fail(undefined)).issue).toBe("network");
  expect(classifyProviderFailure(fail(504, { timedOut: true })).issue).toBe(
    "network",
  );
  expect(classifyProviderFailure(fail(503)).issue).toBe("unavailable");
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
    expect(JSON.stringify(limited)).not.toContain("private-fixture");
    error = fail(401);
    const rejected = await chat.call(request);
    expect(!rejected.ok && rejected.error).toContain("Settings");
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
