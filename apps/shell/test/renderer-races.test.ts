import { expect, test } from "bun:test";
import { createTeamChatBridge } from "../src/main/team-chat-bridge";
import { createController } from "../src/renderer/controller";
import type { ShellBridge } from "../src/shared/methods";
import {
  TEAM_CHAT_METHODS,
  type TeamChatBridgeApi,
} from "../src/shared/team-chat";
import { findAll, MiniDocument, type MiniElement } from "./mini-dom";
import { fakeBridge, loadFixtureData } from "./test-utils";

function node(doc: MiniDocument, attr: string, value: string) {
  const element = findAll(doc.root, (el) => el.getAttribute(attr) === value)[0];
  if (!element) throw new Error(`Missing ${attr}=${value}`);
  return element;
}

function type(el: MiniElement, text: string) {
  el.value = text;
  el.dispatch("input");
}

function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { release, promise };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function fixtureTeam() {
  const service = createTeamChatBridge();
  return Object.fromEntries(
    TEAM_CHAT_METHODS.map((method) => [
      method,
      (params: unknown) => service.call(method, params),
    ]),
  ) as TeamChatBridgeApi;
}

async function openTeam(doc: MiniDocument) {
  node(doc, "data-action", "toggle-team-chat").click();
  await flush();
  return {
    draft: () => node(doc, "data-focus-key", "team-composer"),
    send: () => node(doc, "class", "team-send-btn primary-btn").click(),
    query: () => node(doc, "class", "team-search-input"),
    search: (text: string) => {
      type(node(doc, "class", "team-search-input"), text);
      node(doc, "class", "team-search-btn").click();
    },
    switchConversation: async () => {
      const other = findAll(
        doc.root,
        (el) =>
          el.getAttribute("data-conversation-id") !== null &&
          el.getAttribute("aria-pressed") === "false",
      )[0];
      if (!other) throw new Error("Expected another fixture conversation");
      other.click();
      await flush();
      return other.getAttribute("data-conversation-id");
    },
  };
}

test("export failure from an earlier visit cannot overwrite the current export panel", async () => {
  const doc = new MiniDocument();
  const pending = gate();
  let started = false;
  const ctl = createController(
    {
      ...fakeBridge(await loadFixtureData()),
      "tasks.export": async () => {
        started = true;
        await pending.promise;
        throw new Error("obsolete export failure");
      },
    },
    doc,
    doc.root,
  );
  await ctl.load();
  const select = async (id: string) => {
    node(doc, "data-task-id", id).click();
    await ctl.settled();
  };
  await select("fixture-completed-verified");
  node(doc, "data-action", "export-patch").click();
  expect(started).toBe(true);
  await select("fixture-running");
  await select("fixture-completed-verified");
  pending.release();
  await flush();
  expect(doc.root.textContent).not.toContain("obsolete export failure");
});

for (const result of ["success", "failure", "switch"] as const) {
  test(`late Team Chat send: ${result} preserves the current composer`, async () => {
    const doc = new MiniDocument();
    const pending = gate();
    const team = fixtureTeam();
    let started = false;
    const ctl = createController(
      fakeBridge(await loadFixtureData()),
      doc,
      doc.root,
      {
        ...team,
        "team.send": async (params) => {
          started = true;
          await pending.promise;
          return result === "failure"
            ? { ok: false, code: "invalid" }
            : team["team.send"](params);
        },
      },
    );
    await ctl.load();
    const ui = await openTeam(doc);
    type(ui.draft(), "sent body");
    ui.send();
    expect(started).toBe(true);
    const id = result === "switch" ? await ui.switchConversation() : undefined;
    type(ui.draft(), "newer draft");
    pending.release();
    await flush();
    if (id)
      expect(
        node(doc, "data-conversation-id", id).getAttribute("aria-pressed"),
      ).toBe("true");
    expect(ui.draft().value).toBe("newer draft");
  });
}

for (const supersede of [
  "search",
  "clear",
  "switch",
  "viewer",
  "close",
] as const) {
  test(`stale Team Chat search cannot reappear after ${supersede}`, async () => {
    const doc = new MiniDocument();
    const pending = gate();
    const team = fixtureTeam();
    let started = false;
    const ctl = createController(
      fakeBridge(await loadFixtureData()),
      doc,
      doc.root,
      {
        ...team,
        "team.search": async (params) => {
          if (params.query === "badge") {
            started = true;
            await pending.promise;
          }
          return team["team.search"](params);
        },
      },
    );
    await ctl.load();
    const ui = await openTeam(doc);
    ui.search("badge");
    expect(started).toBe(true);
    if (supersede === "search") ui.search("no-matching-message");
    if (supersede === "clear") ui.search("");
    if (supersede === "switch") await ui.switchConversation();
    if (supersede === "viewer") {
      const viewer = node(doc, "data-focus-key", "team-viewer");
      const other = findAll(
        viewer,
        (el) =>
          el.tagName === "OPTION" && el.getAttribute("value") !== viewer.value,
      )[0];
      const id = other?.getAttribute("value");
      if (!id) throw new Error("Expected another fixture viewer");
      viewer.value = id;
      viewer.dispatch("change");
    }
    if (supersede === "close") {
      node(doc, "data-focus-key", "team-chat-close").click();
      await openTeam(doc);
    }
    await flush();
    pending.release();
    await flush();
    if (supersede === "search")
      expect(doc.root.textContent).toContain("Search results (0)");
    else expect(doc.root.textContent).not.toContain("Search results (");
  });
}

test("a rejected Team Chat search displays a sanitized action notice", async () => {
  const doc = new MiniDocument();
  const ctl = createController(
    fakeBridge(await loadFixtureData()),
    doc,
    doc.root,
    {
      ...fixtureTeam(),
      "team.search": async () => {
        throw new Error("private bridge detail");
      },
    },
  );
  await ctl.load();
  (await openTeam(doc)).search("badge");
  await flush();
  expect(node(doc, "data-team-notice", "true").textContent).toContain(
    "unavailable",
  );
  expect(doc.root.textContent).not.toContain("private bridge detail");
});

function clock() {
  let next: { tick: () => void; delay: number } | undefined;
  return {
    schedule(tick: () => void, delay: number) {
      expect(next).toBeUndefined();
      next = { tick, delay };
      return () => {
        next = undefined;
      };
    },
    get delay() {
      return next?.delay;
    },
    tick() {
      if (!next) throw new Error("No automatic refresh scheduled");
      const { tick } = next;
      next = undefined;
      tick();
    },
  };
}

test("running task refresh backs off on failure, recovers and stops on completion", async () => {
  const timer = clock();
  const data = await loadFixtureData();
  const bridge = fakeBridge(data);
  const doc = new MiniDocument();
  let fail = false;
  let inspections = 0;
  const ctl = createController(
    {
      ...bridge,
      "tasks.inspect": async (args) => {
        inspections++;
        if (fail) throw new Error("offline");
        return bridge["tasks.inspect"](args);
      },
    },
    doc,
    doc.root,
    undefined,
    undefined,
    undefined,
    timer.schedule,
  );
  await ctl.load();
  const initial = timer.delay;
  if (initial === undefined) throw new Error("Expected a running task poll");
  fail = true;
  timer.tick();
  await ctl.settled();
  expect(timer.delay ?? 0).toBeGreaterThan(initial);
  fail = false;
  timer.tick();
  await ctl.settled();
  expect(timer.delay).toBe(initial);
  const task = data.tasks[0];
  if (!task) throw new Error("Expected a running fixture task");
  task.status = "completed";
  timer.tick();
  await ctl.settled();
  expect(inspections).toBe(4);
  expect(node(doc, "data-task-id", task.task_id).textContent).toContain(
    "completed",
  );
  expect(timer.delay).toBeUndefined();
});

test("dispose during an automatic refresh prevents further renders or scheduling", async () => {
  const timer = clock();
  const data = await loadFixtureData();
  const doc = new MiniDocument();
  const pending = gate();
  const base = fakeBridge(data);
  let inspections = 0;
  const bridge: ShellBridge = {
    ...base,
    "tasks.inspect": async (params) => {
      if (++inspections === 2) await pending.promise;
      return base["tasks.inspect"](params);
    },
  };
  const ctl = createController(
    bridge,
    doc,
    doc.root,
    undefined,
    undefined,
    undefined,
    timer.schedule,
  );
  await ctl.load();
  timer.tick();
  await flush();
  expect(inspections).toBe(2);
  ctl.dispose();
  const before = doc.root.children[0];
  pending.release();
  await ctl.settled();
  expect(doc.root.children[0]).toBe(before);
  expect(timer.delay).toBeUndefined();
});

test("a refresh retains an unsubmitted Team Chat search, selection and focus", async () => {
  const doc = new MiniDocument();
  const timer = clock();
  const ctl = createController(
    fakeBridge(await loadFixtureData()),
    doc,
    doc.root,
    fixtureTeam(),
    undefined,
    undefined,
    timer.schedule,
  );
  await ctl.load();
  const ui = await openTeam(doc);
  const input = ui.query();
  type(input, "not submitted");
  input.focus();
  input.setSelectionRange(2, 6);
  timer.tick();
  await ctl.settled();
  expect(doc.activeElement).toBe(input);
  expect(ui.query().value).toBe("not submitted");
  await ctl.load();
  expect(ui.query().value).toBe("not submitted");
  expect(doc.activeElement).toBe(ui.query());
  expect(ui.query().selectionStart).toBe(2);
  expect(ui.query().selectionEnd).toBe(6);
  ctl.dispose();
  expect(timer.delay).toBeUndefined();
});

test("refresh retains sidebar, transcript and visible inspector scroll after focus restoration", async () => {
  const doc = new MiniDocument();
  const timer = clock();
  const ctl = createController(
    fakeBridge(await loadFixtureData()),
    doc,
    doc.root,
    undefined,
    undefined,
    undefined,
    timer.schedule,
  );
  await ctl.load();
  node(doc, "class", "details-toggle").click();
  node(doc, "data-focus-key", "composer-request").focus();
  for (const [i, name] of [
    "sidebar",
    "sidebar-history",
    "transcript",
    "inspector",
  ].entries()) {
    node(doc, "class", name).scrollTop = 10 + i;
    node(doc, "class", name).scrollLeft = 20 + i;
  }
  timer.tick();
  await ctl.settled();
  expect(doc.activeElement).toBe(
    node(doc, "data-focus-key", "composer-request"),
  );
  for (const [i, name] of [
    "sidebar",
    "sidebar-history",
    "transcript",
    "inspector",
  ].entries()) {
    expect(node(doc, "class", name).scrollTop).toBe(10 + i);
    expect(node(doc, "class", name).scrollLeft).toBe(20 + i);
  }
});
