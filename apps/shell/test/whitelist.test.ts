import { expect, mock, test } from "bun:test";
import { RpcRequestSchema } from "../../../packages/workbench/src/protocol";
import { createBridge } from "../src/main/bridge";
import { type IpcEventLike, registerBridge } from "../src/main/ipc";
import {
  BRIDGE_CHANNEL,
  BRIDGE_GLOBAL,
  BRIDGE_METHODS,
  isBridgeMethod,
  isReadMethod,
  READ_METHODS,
} from "../src/shared/methods";
import {
  PATCH_HANDOFF_CHANNEL,
  type PatchHandoffApi,
} from "../src/shared/patch-handoff";
import {
  isTeamChatMethod,
  TEAM_CHAT_CHANNEL,
  TEAM_CHAT_GLOBAL,
  TEAM_CHAT_METHODS,
} from "../src/shared/team-chat";
import { ipcFixture } from "./ipc-fixture";

test("isReadMethod and isBridgeMethod accept exactly the whitelisted method names", () => {
  for (const method of READ_METHODS) expect(isReadMethod(method)).toBe(true);
  for (const method of BRIDGE_METHODS)
    expect(isBridgeMethod(method)).toBe(true);
  for (const method of TEAM_CHAT_METHODS)
    expect(isTeamChatMethod(method)).toBe(true);
  for (const value of [
    "tasks.checkpoint",
    "tasks.restore",
    "workbench.describe ",
    "toString",
    "constructor",
    "__proto__",
    "hasOwnProperty",
    "",
    undefined,
    null,
    1,
    {},
    ["tasks.list"],
    new String("tasks.list"),
  ]) {
    expect(isReadMethod(value)).toBe(false);
    expect(isBridgeMethod(value)).toBe(false);
    expect(isTeamChatMethod(value)).toBe(false);
  }
  expect(isReadMethod("tasks.start")).toBe(false);
  expect(isBridgeMethod("tasks.start")).toBe(true);
});

test("the preload exposes only the frozen workbench, assistant, team chat and patch handoff bridges", async () => {
  const exposed: unknown[][] = [];
  const calls: unknown[][] = [];
  mock.module("electron", () => ({
    contextBridge: {
      exposeInMainWorld: (...args: unknown[]) => exposed.push(args),
    },
    ipcRenderer: {
      invoke: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve({ ok: true, result: null });
      },
    },
  }));
  await import("../src/preload/preload");
  expect(exposed).toHaveLength(4);
  expect(exposed[0]?.[0]).toBe(BRIDGE_GLOBAL);
  expect(exposed[1]?.[0]).toBe("marsAssistant");
  expect(exposed[2]?.[0]).toBe(TEAM_CHAT_GLOBAL);
  expect(exposed[3]?.[0]).toBe("marsPatchHandoff");
  const api = exposed[0]?.[1] as Record<
    string,
    (params: unknown) => Promise<unknown>
  >;
  const teamApi = exposed[2]?.[1] as Record<
    string,
    (params: unknown) => Promise<unknown>
  >;
  expect(Object.isFrozen(api)).toBe(true);
  expect(Object.isFrozen(teamApi)).toBe(true);
  const handoff = exposed[3]?.[1] as PatchHandoffApi;
  expect(Object.isFrozen(handoff)).toBe(true);
  expect(Object.keys(handoff)).toEqual(["save"]);
  expect(Object.keys(api).sort()).toEqual([...BRIDGE_METHODS].sort());
  expect(Object.keys(teamApi).sort()).toEqual([...TEAM_CHAT_METHODS].sort());
  await api["tasks.list"]?.({});
  await api["tasks.journal"]?.({ task_id: "fixture", entry_ids: [] });
  await teamApi["team.state"]?.({});
  const saveParams = {
    task_id: "fixture",
    expected_revision: "r1",
    expected_patch_sha256: "0".repeat(64),
  };
  await handoff.save(saveParams);
  expect(calls).toEqual([
    [BRIDGE_CHANNEL, { method: "tasks.list", params: {} }],
    [
      BRIDGE_CHANNEL,
      {
        method: "tasks.journal",
        params: { task_id: "fixture", entry_ids: [] },
      },
    ],
    [TEAM_CHAT_CHANNEL, { method: "team.state", params: {} }],
    [PATCH_HANDOFF_CHANNEL, saveParams],
  ]);
  mock.restore();
});

test("only whitelisted methods reach transport and IPC refuses untrusted senders", async () => {
  let transportCalls = 0;
  const bridge = createBridge({
    connectionScope: { owner_id: "owner", project_id: "project" },
    transport: {
      async send() {
        transportCalls++;
        return {
          scope: { owner_id: "owner", project_id: "project" },
          workspaceLabel: "x",
          capabilities: { execute: false, checkpoint: false },
        };
      },
    },
  });
  for (const method of [
    "tasks.checkpoint",
    "tasks.restore",
    "tasks.delete",
    "__proto__",
    "constructor",
    12,
  ]) {
    const result = await bridge.call(method, {});
    expect(result).toMatchObject({
      ok: false,
      error: { kind: "refused" },
    });
  }
  expect(transportCalls).toBe(0);

  const { options, owner, otherWindow, childFrame } = ipcFixture();
  let listener:
    | ((event: IpcEventLike, payload: unknown) => unknown)
    | undefined;
  const ipcBridge = {
    call: async (method: unknown, params: unknown) =>
      bridge.call(method, params),
  };
  registerBridge(
    {
      handle(channel, callback) {
        expect(channel).toBe(BRIDGE_CHANNEL);
        listener = callback;
      },
    },
    ipcBridge,
    options,
  );
  for (const event of [otherWindow, childFrame]) {
    expect(
      await listener?.(event, { method: "tasks.list", params: {} }),
    ).toMatchObject({
      ok: false,
      error: { kind: "refused" },
    });
  }
  owner.senderFrame.url = "https://evil.example/index.html";
  const refused = await listener?.(owner, { method: "tasks.list", params: {} });
  expect(refused).toMatchObject({ ok: false, error: { kind: "refused" } });
  owner.senderFrame.url = "mars-shell://app/index.html";
  const malformed = await listener?.(owner, {
    method: "tasks.list",
    params: {},
    extra: true,
  });
  expect(malformed).toMatchObject({ ok: false, error: { kind: "refused" } });
  expect(transportCalls).toBe(0);
});

test("read method names are server RPC discriminators", () => {
  const serverMethods = RpcRequestSchema.options.map(
    (option) => option.shape.method.value,
  );
  for (const method of READ_METHODS) expect(serverMethods).toContain(method);
  expect(READ_METHODS).toEqual([
    "workbench.describe",
    "tasks.list",
    "tasks.inspect",
    "tasks.events",
    "tasks.artifact",
    "tasks.diff",
    "tasks.verification",
    "tasks.evidence",
    "tasks.journal",
  ]);
});
