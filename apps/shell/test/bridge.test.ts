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

test("real loopback workbench serves all nine read methods through the bridge", async () => {
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
      [
        "tasks.journal",
        { task_id: taskId, entry_ids: ["fixture-journal-entry"] },
      ],
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

test("journal params are bounded and returned entry ids match the request", async () => {
  const scope = {
    owner_id: "fixture-owner",
    project_id: "fixture-project",
  };
  const describeResult = {
    scope,
    workspaceLabel: "fixture",
    capabilities: { execute: false, checkpoint: false },
  };
  let transportCalls = 0;
  const createJournalBridge = (journalResult: unknown) =>
    createBridge({
      connectionScope: scope,
      transport: {
        async send(request) {
          transportCalls++;
          if (request.method === "workbench.describe") return describeResult;
          if (request.method === "tasks.journal") return journalResult;
          throw new Error("Unexpected test request.");
        },
      },
    });

  const matching = [
    { entry_id: "requested", kind: "user", text: "fixture entry" },
  ];
  const bridge = createJournalBridge(matching);
  const oversized = await bridge.call("tasks.journal", {
    task_id: "fixture-task",
    entry_ids: Array.from({ length: 101 }, (_, index) => `entry-${index}`),
  });
  expect(oversized).toMatchObject({
    ok: false,
    error: { kind: "protocol" },
  });
  expect(transportCalls).toBe(0);

  expect(
    await bridge.call("tasks.journal", {
      task_id: "fixture-task",
      entry_ids: ["requested"],
    }),
  ).toEqual({ ok: true, result: matching });

  const mismatched = createJournalBridge([
    { entry_id: "unexpected", kind: "user", text: "fixture entry" },
  ]);
  expect(
    await mismatched.call("tasks.journal", {
      task_id: "fixture-task",
      entry_ids: ["requested"],
    }),
  ).toMatchObject({
    ok: false,
    error: { kind: "invalid_response" },
  });
});

test("describe and inspect accept additive fields while rejecting unknown fields", async () => {
  const data = (await loadFixtureData()) as FixtureData;
  const task = data.tasks[0];
  if (!task) throw new Error("Fixture task missing.");
  const bareDescribe = {
    scope: data.describe.scope,
    workspaceLabel: data.describe.workspaceLabel,
    capabilities: data.describe.capabilities,
  };
  const describedWithFields = data.describe;
  const inspectWithFields = { ...task, model_tier: "free" as const };

  const testBridge = (describeResult: unknown, inspectResult: unknown) =>
    createBridge({
      connectionScope: {
        owner_id: data.describe.scope.owner_id,
        project_id: data.describe.scope.project_id,
      },
      transport: {
        async send(request) {
          if (request.method === "workbench.describe") return describeResult;
          if (request.method === "tasks.inspect") return inspectResult;
          throw new Error("Unexpected test request.");
        },
      },
    });

  const withFields = testBridge(describedWithFields, inspectWithFields);
  expect(await withFields.call("workbench.describe", {})).toMatchObject({
    ok: true,
  });
  expect(
    await withFields.call("tasks.inspect", { task_id: task.task_id }),
  ).toMatchObject({ ok: true, result: { model_tier: "free" } });

  const withoutFields = testBridge(bareDescribe, task);
  expect(await withoutFields.call("workbench.describe", {})).toMatchObject({
    ok: true,
  });
  expect(
    await withoutFields.call("tasks.inspect", { task_id: task.task_id }),
  ).toMatchObject({ ok: true, result: { task_id: task.task_id } });

  const unknownDescribe = testBridge(
    { ...bareDescribe, unknown_host_field: true },
    task,
  );
  expect(await unknownDescribe.call("workbench.describe", {})).toMatchObject({
    ok: false,
    error: { kind: "protocol" },
  });

  const unknownInspect = testBridge(bareDescribe, {
    ...task,
    unknown_host_field: true,
  });
  await unknownInspect.call("workbench.describe", {});
  expect(
    await unknownInspect.call("tasks.inspect", { task_id: task.task_id }),
  ).toMatchObject({ ok: false, error: { kind: "protocol" } });
});
