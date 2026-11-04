import { expect, mock, test } from "bun:test";
import { RpcRequestSchema } from "@mars/workbench";
import { createBridge } from "../src/main/bridge";
import { registerBridge } from "../src/main/ipc";
import {
  BRIDGE_CHANNEL,
  BRIDGE_GLOBAL,
  READ_METHODS,
} from "../src/shared/methods";

test("the preload exposes exactly the frozen read-only bridge", async () => {
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
  expect(exposed).toHaveLength(1);
  expect(exposed[0]?.[0]).toBe(BRIDGE_GLOBAL);
  const api = exposed[0]?.[1] as Record<
    string,
    (params: unknown) => Promise<unknown>
  >;
  expect(Object.isFrozen(api)).toBe(true);
  expect(Object.keys(api).sort()).toEqual([...READ_METHODS].sort());
  await api["tasks.list"]?.({});
  expect(calls).toEqual([
    [BRIDGE_CHANNEL, { method: "tasks.list", params: {} }],
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
    "tasks.start",
    "tasks.steer",
    "tasks.cancel",
    "tasks.create",
    "tasks.resume",
    "tasks.checkpoint",
    "tasks.restore",
    "tasks.journal",
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

  let listener:
    | ((event: { senderFrame?: { url?: string } }, payload: unknown) => unknown)
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
    { trustedOrigin: "mars-shell://app" },
  );
  const refused = await listener?.(
    { senderFrame: { url: "https://evil.example/index.html" } },
    { method: "tasks.list", params: {} },
  );
  expect(refused).toMatchObject({ ok: false, error: { kind: "refused" } });
  const malformed = await listener?.(
    { senderFrame: { url: "file:///tmp/index.html" } },
    { method: "tasks.list", params: {}, extra: true },
  );
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
  ]);
});
