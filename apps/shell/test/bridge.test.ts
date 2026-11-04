import { expect, test } from "bun:test";
import { serveWorkbench } from "@mars/workbench";
import {
  createFixtureOperations,
  type FixtureData,
} from "../scripts/fixture-workbench";
import { createBridge } from "../src/main/bridge";
import { createLoopbackTransport } from "../src/main/transport";
import { loadFixtureData } from "./test-utils";

const TOKEN = "fixture-token-0123456789abcdefghijklmnopqrstuvwxyz";

async function runningServer(data: FixtureData, token = TOKEN) {
  const server = serveWorkbench({
    api: createFixtureOperations(data),
    token,
    port: 0,
  });
  return {
    server,
    url: `http://127.0.0.1:${server.port}`,
  };
}

test("real loopback workbench serves all eight read methods through the bridge", async () => {
  const data = (await loadFixtureData()) as FixtureData;
  const { server, url } = await runningServer(data);
  try {
    const bridge = createBridge({
      transport: createLoopbackTransport({ url, token: TOKEN }),
      connectionScope: {
        owner_id: data.describe.scope.owner_id,
        project_id: data.describe.scope.project_id,
      },
      requestId: () => "fixture-test",
    });
    const taskId = "fixture-completed-verified";
    const task = data.tasks.find((candidate) => candidate.task_id === taskId);
    const calls: [string, unknown][] = [
      ["workbench.describe", {}],
      ["tasks.list", {}],
      ["tasks.inspect", { task_id: taskId }],
      ["tasks.events", { task_id: taskId }],
      ["tasks.artifact", { task_id: taskId, artifact: task?.artifacts[0] }],
      ["tasks.diff", { task_id: taskId }],
      ["tasks.verification", { task_id: taskId }],
      ["tasks.evidence", { task_id: taskId }],
    ];
    for (const [method, params] of calls) {
      const result = await bridge.call(method, params);
      expect(result.ok).toBe(true);
    }
    const tamperedRef = task?.artifacts[1];
    const tampered = await bridge.call("tasks.artifact", {
      task_id: taskId,
      artifact: tamperedRef,
    });
    expect(tampered).toMatchObject({
      ok: false,
      error: { kind: "hash_mismatch" },
    });
  } finally {
    await server.stop(true);
  }
});

test("authentication, scope, and endpoint failures are sanitized and fail closed", async () => {
  const data = (await loadFixtureData()) as FixtureData;
  const { server, url } = await runningServer(data);
  try {
    const secret = "incorrect-token-0123456789abcdefghijklmnopqrstuvwxyz";
    const unauthorized = createBridge({
      transport: createLoopbackTransport({ url, token: secret }),
      connectionScope: {
        owner_id: data.describe.scope.owner_id,
        project_id: data.describe.scope.project_id,
      },
    });
    const authResult = await unauthorized.call("workbench.describe", {});
    expect(authResult).toMatchObject({
      ok: false,
      error: { kind: "unauthorized" },
    });
    expect(JSON.stringify(authResult)).not.toContain(secret);

    const wrongScope = createBridge({
      transport: createLoopbackTransport({ url, token: TOKEN }),
      connectionScope: { owner_id: "other-owner", project_id: "other-project" },
    });
    expect(await wrongScope.call("tasks.list", {})).toMatchObject({
      ok: false,
      error: { kind: "refused" },
    });
  } finally {
    await server.stop(true);
  }
  expect(() =>
    createLoopbackTransport({
      url: "http://example.com",
      token: TOKEN,
    }),
  ).toThrow();
});
