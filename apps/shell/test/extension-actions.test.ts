import { expect, test } from "bun:test";
import { createController } from "../src/renderer/controller";
import type {
  ExtensionItem,
  ExtensionsApi,
} from "../src/renderer/extensions-view";
import { findAll, MiniDocument } from "./mini-dom";
import { fakeBridge, loadFixtureData } from "./test-utils";

const row: ExtensionItem = {
  id: "mars-json-compare",
  name: "JSON comparison",
  kind: "mcp",
  description: "Compare JSON",
  permissions: [],
  version: "1",
  installed: false,
  removable: true,
};

async function openLibrary(api: ExtensionsApi) {
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
        sessions: [],
        workspace: "test",
        canConfigure: true,
      }),
    },
    api,
  );
  await ctl.load();
  const button = (key: string) =>
    findAll(doc.root, (el) => el.getAttribute("data-focus-key") === key)[0];
  button("nav-extensions")?.click();
  await Bun.sleep(0);
  return {
    doc,
    ctl,
    remove: () => button("remove-extension-mars-json-compare"),
    primary: () => button("extension-mars-json-compare"),
  };
}

test("only the removable flag and supported API expose the native removal action", async () => {
  const api: ExtensionsApi = {
    list: async () => [row],
    install: async () => "unavailable",
  };
  expect((await openLibrary(api)).remove()).toBeUndefined();
  expect(
    (
      await openLibrary({
        ...api,
        remove: async () => "removed",
        list: async () => [{ ...row, installed: true, removable: false }],
      })
    ).remove(),
  ).toBeUndefined();
});

test("cancel, uncertain removal, and confirmed removal retain keyboard context without optimistic deletion", async () => {
  const ids: string[] = [];
  let removable = true;
  let result: "cancelled" | "unavailable" | "removed" = "cancelled";
  const ui = await openLibrary({
    list: async () => [{ ...row, removable }],
    install: async () => "unavailable",
    remove: async (id) => {
      ids.push(id);
      if (result === "removed") removable = false;
      return result;
    },
  });
  for (const response of ["cancelled", "unavailable", "removed"] as const) {
    result = response;
    const btn = ui.remove();
    if (!btn)
      throw new Error("Missing removal action for expired registration");
    btn.focus();
    btn.click();
    await Bun.sleep(0);
    expect(ui.doc.root.textContent).toContain(
      response === "cancelled"
        ? "Nothing changed."
        : response === "removed"
          ? "Removed from this project."
          : "Could not confirm removal",
    );
    expect(ui.doc.activeElement).toBe(
      (response === "removed" ? ui.primary() : ui.remove()) ?? null,
    );
  }
  expect(ids).toEqual([row.id, row.id, row.id]);
  expect(ui.remove()).toBeUndefined();
});

test("native changes during an in-flight catalog read trigger a fresh list; disposal unsubscribes", async () => {
  let notify = () => {};
  let release = () => {};
  let installed = false;
  let reads = 0;
  let unsubscribed = false;
  const ui = await openLibrary({
    list: async () => {
      const snapshot = { ...row, installed, removable: installed };
      if (++reads === 2)
        await new Promise<void>((done) => {
          release = done;
        });
      return [snapshot];
    },
    onChanged(cb) {
      notify = cb;
      return () => {
        unsubscribed = true;
      };
    },
    install: async () => "installed",
    remove: async () => "removed",
  });
  expect(ui.remove()).toBeUndefined();
  notify();
  installed = true;
  notify();
  release();
  await Bun.sleep(0);
  expect(reads).toBe(3);
  expect(ui.remove()).toBeDefined();
  installed = false;
  notify();
  await Bun.sleep(0);
  expect(ui.remove()).toBeUndefined();
  ui.ctl.dispose();
  expect(unsubscribed).toBe(true);
  notify();
  expect(reads).toBe(4);
});
