import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
  cp,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostMcpControlPlane } from "@mars/mcp-client";
import { SkillStore } from "@mars/skills";
import type { BrowserWindow, Dialog, IpcMain } from "electron";
import {
  desktopExtensionsMenu,
  extensionController,
} from "../src/main/extensions";
import { startLocalWorkbench } from "../src/main/local-workbench";
import { CATALOG } from "../src/runtime/extension-catalog";
import type { OperatorAction } from "../src/runtime/extension-wire";
import { projectExtensions } from "../src/runtime/extensions";

let root: string;
let source: string;
let state: string;
let dir: string;
const scope = { owner_id: "local", project_id: "desktop-test" };
const ctx = { schema_version: 1 as const, scope, request_id: "test" };
const mcp = "mars-utc-clock",
  skill = "mars-change-summary",
  plugin = "mars-release-kit";
const open = () => projectExtensions(source, state, scope, dir);
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "mars-extensions-")));
  source = join(root, "project");
  state = join(root, "state");
  dir = join(root, "catalog");
  await mkdir(source);
  await mkdir(join(state, "workspaces"), { recursive: true, mode: 0o700 });
  await cp(join(import.meta.dir, "../src/runtime/catalog"), dir, {
    recursive: true,
  });
});
afterEach(() => rm(root, { recursive: true, force: true }));

test("skills and declarative plugins install atomically into the project skill store and survive restart", async () => {
  const extensions = open();
  expect(await extensions.list()).toEqual([]);
  await extensions.install(skill);
  expect(await open().list()).toEqual([skill]);
  await extensions.install(plugin);
  const store = new SkillStore(join(state, "skills"));
  const revision = await store.getRevision();
  await open().install(plugin);
  expect(await store.getRevision()).toBe(revision);
  expect(await open().list()).toEqual([skill, "mars-test-handoff", plugin]);
  expect((await store.list()).map((s) => s.name).sort()).toEqual([
    skill,
    "mars-test-handoff",
  ]);
  await mkdir(join(root, "other-state", "workspaces"), {
    recursive: true,
    mode: 0o700,
  });
  expect(
    await projectExtensions(
      source,
      join(root, "other-state"),
      { ...scope, project_id: "other" },
      dir,
    ).list(),
  ).toEqual([]);
});

test("the investigation and review kits install all and only their declared skills", async () => {
  const ext = open();
  await ext.install("mars-debug-kit");
  expect(await ext.list()).toEqual([
    "mars-bug-triage",
    "mars-test-plan",
    "mars-debug-kit",
  ]);
  await ext.install("mars-pr-kit");
  expect(await open().list()).toEqual([
    "mars-bug-triage",
    "mars-code-review",
    "mars-test-plan",
    "mars-test-handoff",
    "mars-debug-kit",
    "mars-pr-kit",
  ]);
});

test("archive then reinstall restores bundled instructions without losing the customized version", async () => {
  const ext = open();
  await ext.install(skill);
  const store = new SkillStore(join(state, "skills"));
  const custom =
    "---\nname: mars-change-summary\ndescription: My instructions\n---\nKeep this version.";
  const options = { actor: "operator", source: "manual" };
  await store.update(skill, custom, options);
  expect((await ext.status()).conflicts).toContain(plugin);
  await expect(ext.install(plugin)).rejects.toThrow("Confirm");
  await store.archive(skill, options);
  await ext.install(plugin);
  expect(await ext.list()).toContain(plugin);
  expect(
    (await store.listVersions(skill)).some(
      (v) => v.skill.content === custom && v.skill.status === "archived",
    ),
  ).toBe(true);
});

test("native recovery requires consent to restore the reviewed revision, preserving customized history", async () => {
  const ext = open();
  await ext.install(skill);
  const store = new SkillStore(join(state, "skills"));
  const custom =
    "---\nname: mars-change-summary\ndescription: My learned update\n---\nKeep this.";
  const options = { actor: "operator", source: "proposal" };
  await store.update(skill, custom, options);
  const host = {
    async extensionAction(a: OperatorAction) {
      if (a.action !== "list")
        await ext.install(
          a.id,
          a.action === "restore" ? a.revision : undefined,
        );
      return ext.status();
    },
  };
  const confirm = (fn: () => Promise<boolean>) =>
    extensionController(
      () => host,
      async (_entry, restore) => {
        expect(restore).toEqual([skill]);
        return fn();
      },
    );
  expect(await confirm(async () => false).install(plugin)).toBe("cancelled");
  expect((await store.get(skill))?.content).toBe(custom);
  expect(
    await confirm(async () => {
      await store.update(skill, `${custom} Edited.`, options);
      return true;
    }).install(plugin),
  ).toBe("unavailable");
  expect((await store.get(skill))?.content).toBe(`${custom} Edited.`);
  expect(await confirm(async () => true).install(plugin)).toBe("installed");
  expect(await ext.list()).toContain(plugin);
  expect(
    (await store.listVersions(skill)).some(
      (v) => v.skill.content === `${custom} Edited.`,
    ),
  ).toBe(true);
});

test("a stalled catalog releases callers without killing the task service or sending duplicate mutations", async () => {
  const runtime = join(root, "apps", "shell", "src", "runtime");
  await mkdir(runtime, { recursive: true });
  await symlink(process.execPath, join(root, "bun"));
  await writeFile(
    join(runtime, "workbench.ts"),
    `
    import {createInterface} from "node:readline";
    let count = 0;
    for await (const line of createInterface({input:process.stdin})) {
      const command = JSON.parse(line);
      if (!command.token) { console.log("MARS_WORKBENCH_READY"); continue; }
      count++;
      if (count === 1) {
        while (!await Bun.file("finish-task").exists()) await Bun.sleep(5);
        await Bun.write("task-completed", "yes");
      }
      console.log("MARS_EXTENSIONS " + JSON.stringify({token:command.token,status:{installed:["mars-change-summary"],conflicts:[],expired:[]}}));
      await Bun.write("command-count", String(count));
    }
  `,
  );
  const host = startLocalWorkbench({
    resources: root,
    state,
    source,
    extensionTimeoutMs: 200,
  });
  try {
    const results = await Promise.allSettled([
      host.extensionAction({ action: "install", id: skill }),
      host.extensionAction({ action: "install", id: plugin }),
      host.extensionAction({ action: "list" }),
    ]);
    expect(results.map((r) => r.status)).toEqual([
      "rejected",
      "rejected",
      "rejected",
    ]);
    await Bun.write(join(root, "finish-task"), "finish");
    for (
      let i = 0;
      i < 100 && !(await Bun.file(join(root, "command-count")).exists());
      i++
    )
      await Bun.sleep(10);
    expect(await Bun.file(join(root, "task-completed")).text()).toBe("yes");
    expect(await Bun.file(join(root, "command-count")).text()).toBe("1");
    expect((await host.extensionAction({ action: "list" })).installed).toEqual([
      skill,
    ]);
  } finally {
    await host.stop();
  }
});

test("an expired tool notifies the operator once and can be re-approved and invoked", async () => {
  let time = Date.now();
  const notices: string[] = [];
  const ext = projectExtensions(source, state, scope, dir, {
    clock: () => new Date(time),
    onExpired: (id) => notices.push(id),
  });
  const runtime = await ext.runtime(source, scope);
  try {
    await ext.install(mcp);
    const call = () =>
      runtime.loader.invokeTool(ctx, {
        server_id: mcp,
        tool: "utc_now",
        input: {},
      });
    await call();
    time += 31 * 86400000;
    await expect(call()).rejects.toThrow("expired");
    expect(notices).toEqual([mcp]);
    expect((await ext.status()).expired).toEqual([mcp]);
    expect(await runtime.listServerIds()).toEqual([]);
    expect(notices).toEqual([mcp]);
    await ext.install(mcp);
    expect(await runtime.listServerIds()).toEqual([mcp]);
    expect((await call()).is_error).toBe(false);
  } finally {
    await runtime.loader.closeAll();
  }
}, 30000);

test("supplied JSON and unified patches are processed offline by independently approved tools", async () => {
  const ext = open();
  const runtime = await ext.runtime(source, scope);
  const call = (
    server_id: string,
    tool: string,
    input: Record<string, string>,
  ) => runtime.loader.invokeTool(ctx, { server_id, tool, input });
  try {
    await ext.install("mars-json-compare");
    const result = await call("mars-json-compare", "compare_json", {
      before: '{"a/b":false,"unused":0}',
      after: '{"a/b":true,"new":"value stays private"}',
    });
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
      count: 3,
      paths: [
        { change: "changed", path: "/a~1b" },
        { change: "removed", path: "/unused" },
        { change: "added", path: "/new" },
      ],
      omitted: 0,
    });
    await expect(
      call("mars-diff-summary", "summarize_diff", { diff: "" }),
    ).rejects.toThrow();
    await ext.install("mars-diff-summary");
    const diff =
      "--- a/doc\n+++ b/doc\n@@ -1 +1,2 @@\n-a\n+b\n++++ header-like content\n";
    const stats = await call("mars-diff-summary", "summarize_diff", { diff });
    expect(JSON.parse(stats.content[0]?.text ?? "")).toEqual({
      textFiles: 1,
      added: 2,
      removed: 1,
      files: [{ path: "b/doc", added: 2, removed: 1, hunks: 1 }],
      omitted: 0,
    });
    await expect(
      call("mars-json-compare", "summarize_diff", { diff }),
    ).rejects.toThrow();
    const invalid = await call("mars-json-compare", "compare_json", {
      before: "not JSON",
      after: "{}",
    });
    expect(invalid.is_error).toBe(true);
    const exact = await call("mars-json-compare", "compare_json", {
      before: '{"id":9007199254740992,"ratio":123e-2,"mixed":"10"}',
      after: '{"id":9007199254740993,"ratio":1.2300,"mixed":10}',
    });
    expect(JSON.parse(exact.content[0]?.text ?? "").paths).toEqual([
      { change: "changed", path: "/id" },
      { change: "changed", path: "/mixed" },
    ]);
  } finally {
    await runtime.loader.closeAll();
  }
}, 30_000);

test("bad IDs, conflicting skill contents and modified bundle bytes cannot install", async () => {
  const extensions = open();
  const store = new SkillStore(join(state, "skills"));
  await expect(extensions.install("../project")).rejects.toThrow("catalog");
  await writeFile(join(dir, "mars-test-handoff.md"), "modified");
  await expect(extensions.install(plugin)).rejects.toThrow("verification");
  expect(await store.list()).toEqual([]);
  await cp(join(import.meta.dir, "../src/runtime/catalog"), dir, {
    recursive: true,
  });
  await store.create(
    "mars-test-handoff",
    "---\nname: mars-test-handoff\ndescription: Existing\n---\nKeep my notes.",
    { actor: "operator", source: "manual" },
  );
  await expect(extensions.install(plugin)).rejects.toThrow("already uses");
  expect(await store.get(skill)).toBeNull();
  expect((await store.get("mars-test-handoff"))?.content).toContain(
    "Keep my notes",
  );
  await writeFile(join(dir, "utc-clock.ts"), "changed");
  await expect(extensions.install(mcp)).rejects.toThrow("verification");
  expect(await extensions.list()).toEqual([]);
});

test("the runtime receives only its own project’s verified, unexpired, unrevoked tool grant", async () => {
  const ext = open();
  await expect(
    ext.runtime(source, { ...scope, project_id: "other" }),
  ).rejects.toThrow("scope");
  const runtime = await ext.runtime(source, scope);
  const call = () =>
    runtime.loader.invokeTool(ctx, {
      server_id: mcp,
      tool: "utc_now",
      input: {},
    });
  try {
    expect(await runtime.listServerIds()).toEqual([]);
    await expect(call()).rejects.toThrow();
    await ext.install(mcp);
    await open().install(mcp);
    expect(await open().list()).toEqual([mcp]);
    expect(await runtime.listServerIds()).toEqual([mcp]);
    const result = await call();
    expect(result.content[0]?.text).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(result.untrusted).toBe(true);
    const ctl = await createHostMcpControlPlane({
      stateDir: join(state, "extension-trust"),
      workspaceRoots: [source],
      scope,
      approvers: [
        {
          approver_id: "desktop-operator",
          owner_id: scope.owner_id,
          project_ids: [scope.project_id],
        },
      ],
    });
    const { grants } = await ctl.admin.inspect(ctx, {
      kind: "mcp",
      integration_id: mcp,
    });
    expect(grants).toHaveLength(1);
    const grant = grants[0];
    if (!grant) throw new Error("Missing grant");
    expect(
      Date.parse(grant.expires_at) - Date.parse(grant.approved_at),
    ).toBeCloseTo(30 * 86_400_000, -2);
    const future = spyOn(Date, "now").mockReturnValue(
      Date.parse(grant.expires_at) + 1,
    );
    try {
      expect((await ext.status()).expired).toEqual([mcp]);
      expect(await runtime.listServerIds()).toEqual([]);
    } finally {
      future.mockRestore();
    }
    expect(grant.permissions).toEqual([
      { capability: "tool.invoke", resource: "utc_now" },
    ]);
    await ctl.admin.revoke(ctx, {
      grant_id: grant.grant_id,
      expected_revision: grant.revision,
      proof: ctl.signHostProof({
        scope,
        review_id: grant.review_id,
        review_revision: grant.revision,
        binding_sha256: grant.binding_sha256,
        decision: "revoke",
        expires_at: grant.expires_at,
      }),
    });
    expect(await runtime.listServerIds()).toEqual([]);
    await expect(call()).rejects.toThrow("revoked");
    await ext.install(mcp);
    await writeFile(join(dir, "utc-clock.ts"), "changed");
    expect(await open().list()).toEqual([]);
    expect(await runtime.listServerIds()).toEqual([]);
    await expect(call()).rejects.toThrow();
  } finally {
    await runtime.loader.closeAll();
  }
}, 30_000);

test("install only dispatches after explicit confirmation on the same project", async () => {
  const actions: OperatorAction[] = [];
  const a = {
    extensionAction: async (request: OperatorAction) => {
      actions.push(request);
      return { installed: [], expired: [], conflicts: [] };
    },
  };
  let project = a;
  let choice = Promise.withResolvers<boolean>();
  let confirms = 0;
  const api = extensionController(
    () => project,
    async () => {
      confirms++;
      return choice.promise;
    },
  );
  expect(await api.install("../unknown")).toBe("unavailable");
  expect(confirms).toBe(0);
  const cancelled = api.install(skill);
  expect(await api.install(plugin)).toBe("unavailable");
  choice.resolve(false);
  expect(await cancelled).toBe("cancelled");
  choice = Promise.withResolvers<boolean>();
  const switched = api.install(plugin);
  project = { ...a };
  choice.resolve(true);
  expect(await switched).toBe("unavailable");
  expect(actions.every((a) => a.action === "list")).toBe(true);
  expect(await api.install(plugin)).toBe("installed");
  expect(actions.filter((a) => a.action !== "list")).toEqual([
    { action: "install", id: plugin },
  ]);
});

test("the catalog IPC rejects other windows, non-main frames and renderer-supplied configuration", async () => {
  let listener: Parameters<IpcMain["handle"]>[1] | undefined;
  const ipcMain = {
    handle: (_: string, fn: Parameters<IpcMain["handle"]>[1]) => {
      listener = fn;
    },
  } as IpcMain;
  const frame = { url: "mars-shell://app/index.html" };
  const contents = { mainFrame: frame };
  const window = {
    isDestroyed: () => false,
    webContents: contents,
  } as unknown as BrowserWindow;
  desktopExtensionsMenu(
    { ipcMain, dialog: {} as Dialog },
    window,
    () => ({
      extensionAction: async () => ({
        installed: [],
        expired: [mcp],
        conflicts: [skill],
      }),
    }),
    () => source,
  );
  if (!listener) throw new Error("Missing handler");
  const event = { sender: contents, senderFrame: frame };
  for (const invalid of [
    { ...event, sender: {} },
    { ...event, senderFrame: { ...frame } },
    { ...event, senderFrame: null },
  ])
    expect(() => listener?.(invalid as never, { action: "list" })).toThrow();
  expect(() =>
    listener?.(event as never, {
      action: "install",
      id: skill,
      command: "unexpected",
    }),
  ).toThrow();
  const catalog = await listener(event as never, { action: "list" });
  expect(
    catalog.find((entry: { id: string }) => entry.id === mcp).description,
  ).toContain("renew");
  expect(
    catalog.find((entry: { id: string }) => entry.id === skill).description,
  ).toContain("restoring customized");
  expect(() =>
    listener?.(event as never, {
      action: "restore",
      id: skill,
      revision: "0".repeat(64),
    }),
  ).toThrow();
  expect(catalog.map((entry: { kind: string }) => entry.kind)).toEqual(
    CATALOG.map((entry) => entry.kind),
  );
});
