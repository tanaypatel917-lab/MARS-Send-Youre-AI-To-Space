import { expect, test } from "bun:test";
import type { LocalConnection } from "../src/main/connection";
import { createReconnectingBridge } from "../src/main/session";
import { TransportError, type TransportRequest } from "../src/main/transport";
import { loadFixtureData } from "./test-utils";

const connection: LocalConnection = {
  url: "http://127.0.0.1:7331",
  token: "fixture-token-0123456789abcdefghijklmnopqrstuvwxyz",
  scope: { owner_id: "fixture-owner", project_id: "fixture-project" },
};

test("connection resolution retries after not_connected and reaches the workbench", async () => {
  const data = await loadFixtureData();
  let resolveCalls = 0;
  let transportCreations = 0;
  const requests: TransportRequest[] = [];
  const bridge = createReconnectingBridge({
    async resolve() {
      resolveCalls++;
      if (resolveCalls === 1)
        return {
          ok: false,
          reason:
            "No workbench connection file found. Start `mars serve` or pass --connection=PATH.",
        };
      return { ok: true, connection };
    },
    makeTransport() {
      transportCreations++;
      return {
        async send(request) {
          requests.push(request);
          if (request.method === "workbench.describe") return data.describe;
          if (request.method === "tasks.list") return data.tasks;
          throw new Error("Unexpected test request.");
        },
      };
    },
  });

  expect(await bridge.call("tasks.list", {})).toMatchObject({
    ok: false,
    error: { kind: "not_connected" },
  });
  expect(resolveCalls).toBe(1);
  expect(transportCreations).toBe(0);
  expect(await bridge.call("tasks.list", {})).toMatchObject({ ok: true });
  expect(resolveCalls).toBe(2);
  expect(transportCreations).toBe(1);
  expect(requests.map((request) => request.method)).toEqual([
    "workbench.describe",
    "tasks.list",
  ]);
});

test("unavailable and unauthorized failures trigger connection resolution again", async () => {
  const data = await loadFixtureData();
  for (const kind of ["unavailable", "unauthorized"] as const) {
    let resolveCalls = 0;
    let transportCreations = 0;
    const bridge = createReconnectingBridge({
      async resolve() {
        resolveCalls++;
        return { ok: true, connection };
      },
      makeTransport() {
        transportCreations++;
        const instance = transportCreations;
        return {
          async send(request) {
            if (request.method === "workbench.describe") return data.describe;
            if (request.method === "tasks.list" && instance === 1)
              throw new TransportError(kind, "sanitized failure");
            if (request.method === "tasks.list") return data.tasks;
            throw new Error("Unexpected test request.");
          },
        };
      },
    });

    expect(await bridge.call("tasks.list", {})).toMatchObject({
      ok: false,
      error: { kind },
    });
    expect(await bridge.call("tasks.list", {})).toMatchObject({ ok: true });
    expect(resolveCalls).toBe(2);
    expect(transportCreations).toBe(2);
  }
});

test("a refused method does not resolve a connection", async () => {
  let resolveCalls = 0;
  const bridge = createReconnectingBridge({
    async resolve() {
      resolveCalls++;
      return { ok: false, reason: "No connection." };
    },
    makeTransport() {
      throw new Error("Unexpected transport creation.");
    },
  });

  expect(await bridge.call("tasks.start", {})).toMatchObject({
    ok: false,
    error: { kind: "refused" },
  });
  expect(resolveCalls).toBe(0);
});
