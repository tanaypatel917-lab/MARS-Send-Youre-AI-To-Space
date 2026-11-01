import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { Scope, Task } from "@mars/contracts";
import {
  serveWorkbench,
  WorkbenchError,
  type WorkbenchOperations,
} from "./server";

const token = "test_workbench_token_not_a_real_secret_123456";
const scope: Scope = { owner_id: "owner", project_id: "project" };
const context = { schema_version: 1, scope, request_id: "request-1" };
const artifact = {
  artifact_id: "artifact",
  sha256: createHash("sha256").update("").digest("hex"),
  media_type: "text/plain",
  byte_length: 0,
};
const workspace = {
  workspace_id: "isolated",
  provider: "test",
  revision: "r1",
};
const checkpoint = { checkpoint_id: "checkpoint", workspace, artifact };
const task: Task = {
  schema_version: 1,
  task_id: "task",
  session_id: "session",
  scope,
  revision: 0,
  request: "Update the fixture",
  acceptance_criteria: ["The tests pass"],
  budget: {
    max_tokens: 10_000,
    max_usd: 0,
    max_duration_ms: 10_000,
    max_depth: 0,
    max_concurrency: 1,
  },
  status: "pending",
  specialist_revision: null,
  artifacts: [],
};
const servers: ReturnType<typeof serveWorkbench>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
});

function fixture(overrides: Partial<WorkbenchOperations> = {}) {
  const calls: string[] = [];
  const api: WorkbenchOperations = {
    scope,
    async describe() {
      calls.push("describe");
      return {
        scope,
        workspaceLabel: "fixture",
        capabilities: { execute: false, checkpoint: true },
      };
    },
    async create(_context, input) {
      calls.push("create");
      return input;
    },
    async list() {
      calls.push("list");
      return [task];
    },
    async inspect() {
      calls.push("inspect");
      return task;
    },
    async start() {
      calls.push("start");
      return { ...task, status: "running", revision: 1 };
    },
    async resume() {
      calls.push("resume");
      return { ...task, status: "running", revision: 3 };
    },
    async steer() {
      calls.push("steer");
    },
    async cancel() {
      calls.push("cancel");
    },
    async events() {
      calls.push("events");
      return [];
    },
    async artifact() {
      calls.push("artifact");
      return { data_base64: "", media_type: "text/plain" };
    },
    async diff() {
      calls.push("diff");
      return { files: [] };
    },
    async checkpoint() {
      calls.push("checkpoint");
      return checkpoint;
    },
    async restore() {
      calls.push("restore");
      return workspace;
    },
    ...overrides,
  };
  const server = serveWorkbench({ api, token, port: 0 });
  servers.push(server);
  const url = `http://127.0.0.1:${server.port}/v1/rpc`;
  const send = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  return { server, api, calls, url, send };
}

test("loopback RPC requires authentication even for describe and never reflects tokens", async () => {
  const { send, calls, server } = fixture();
  expect(server.hostname).toBe("127.0.0.1");
  for (const authorization of [
    "",
    "Bearer wrong",
    `Basic ${token}`,
    `Bearer ${token}x`,
  ]) {
    const result = await send(
      { method: "workbench.describe", params: {} },
      { authorization },
    );
    expect(result.status).toBe(401);
    expect(await result.text()).not.toContain(token);
  }
  expect(calls).toEqual([]);
  const ok = await send({ method: "workbench.describe", params: {} });
  expect(ok.status).toBe(200);
  expect(await ok.json()).toMatchObject({
    result: { workspaceLabel: "fixture" },
  });
  expect(ok.headers.get("cache-control")).toBe("no-store");
  expect(ok.headers.has("access-control-allow-origin")).toBe(false);
});

test("RPC rejects browser origins, rebind hosts, query strings and other HTTP routes", async () => {
  const { send, url, calls } = fixture();
  const body = { method: "workbench.describe", params: {} };
  expect(
    (await send(body, { origin: "https://attacker.invalid" })).status,
  ).toBe(403);
  expect((await send(body, { origin: "null" })).status).toBe(403);
  expect(
    (await send(body, { host: `attacker.invalid:${new URL(url).port}` }))
      .status,
  ).toBe(403);
  expect((await fetch(url)).status).toBe(404);
  expect(
    (await fetch(`${url}?token=${token}`, { method: "POST" })).status,
  ).toBe(404);
  expect(calls).toEqual([]);
});

test("RPC validates strict method, params, context and initial task state before dispatch", async () => {
  const { send, calls, url } = fixture();
  const invalid = [
    null,
    [],
    {},
    { method: "shell.execute", params: {} },
    { method: "tasks.list", params: {} },
    { method: "tasks.list", context, params: { arbitrary: true } },
    {
      method: "tasks.list",
      context: { ...context, schema_version: 2 },
      params: {},
    },
    {
      method: "tasks.start",
      context,
      params: {
        task_id: "task",
        expected_revision: 0,
        approvals: { read: true, write: true, execute: "yes" },
      },
    },
    {
      method: "tasks.create",
      context,
      params: { task: { ...task, status: "completed" } },
    },
    {
      method: "tasks.create",
      context,
      params: { task: { ...task, revision: 1 } },
    },
    {
      method: "tasks.create",
      context,
      params: { task: { ...task, artifacts: [artifact] } },
    },
    {
      method: "tasks.create",
      context,
      params: { task: { ...task, specialist_revision: "pretend-trained" } },
    },
  ];
  for (const value of invalid) expect((await send(value)).status).toBe(400);
  const raw = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: "{",
  });
  expect(raw.status).toBe(400);
  expect(calls).toEqual([]);
});

test("RPC fixes scope to its host binding, including omitted workspace scope", async () => {
  const { send, calls } = fixture();
  const other = { ...scope, owner_id: "other" };
  expect(
    (
      await send({
        method: "tasks.list",
        context: { ...context, scope: other },
        params: {},
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await send({
        method: "tasks.list",
        context: { ...context, scope: { ...scope, workspace_id: "another" } },
        params: {},
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await send({
        method: "tasks.create",
        context,
        params: { task: { ...task, scope: other } },
      })
    ).status,
  ).toBe(403);
  expect(calls).toEqual([]);
});

test("all frozen client methods dispatch and return contract-shaped result envelopes", async () => {
  const { send, calls } = fixture();
  const methods: [string, unknown][] = [
    ["tasks.create", { task }],
    ["tasks.list", {}],
    ["tasks.inspect", { task_id: "task" }],
    [
      "tasks.start",
      {
        task_id: "task",
        expected_revision: 0,
        approvals: { read: true, write: true, execute: false },
        model_id: "free",
      },
    ],
    ["tasks.resume", { task_id: "task", expected_revision: 2 }],
    ["tasks.steer", { task_id: "task", instruction: "Run tests" }],
    ["tasks.cancel", { task_id: "task" }],
    ["tasks.events", { task_id: "task", after_event_id: "cursor" }],
    ["tasks.artifact", { task_id: "task", artifact }],
    ["tasks.diff", { task_id: "task" }],
    ["tasks.checkpoint", { task_id: "task" }],
    [
      "tasks.restore",
      { task_id: "task", checkpoint_id: "checkpoint", expected_revision: "r1" },
    ],
  ];
  for (const [method, params] of methods) {
    const response = await send({ method, context, params });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty("result");
    expect(body).not.toHaveProperty("error");
    if (method === "tasks.steer" || method === "tasks.cancel")
      expect(body).toEqual({ result: null });
  }
  expect(calls).toEqual(methods.map(([name]) => name.split(".")[1] as string));
});

test("RPC maps conflicts but sanitizes arbitrary provider and filesystem failures", async () => {
  const { send } = fixture({
    async inspect() {
      throw Object.assign(new Error(`/host/private ${token}`), {
        code: "stale_revision",
      });
    },
  });
  const conflict = await send({
    method: "tasks.inspect",
    context,
    params: { task_id: "task" },
  });
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toMatchObject({ error: { code: "conflict" } });
  const failed = fixture({
    async list() {
      throw new Error(`/host/private ${token}`);
    },
  });
  const response = await failed.send({
    method: "tasks.list",
    context,
    params: {},
  });
  expect(response.status).toBe(500);
  const body = await response.text();
  expect(body).not.toContain(token);
  expect(body).not.toContain("/host/private");
  const denied = fixture({
    async list() {
      throw new WorkbenchError("forbidden");
    },
  });
  expect(
    (await denied.send({ method: "tasks.list", context, params: {} })).status,
  ).toBe(403);
});

test("RPC rejects malformed service results and bounds responses", async () => {
  const bad = fixture({
    async list() {
      return [{ ...task, status: "invented" }] as unknown as Task[];
    },
  });
  expect(
    (await bad.send({ method: "tasks.list", context, params: {} })).status,
  ).toBe(500);
  const huge = fixture({
    async diff() {
      return {
        files: [
          {
            path: "file.txt",
            status: "added",
            patch: "+".repeat(4 * 1024 * 1024),
          },
        ],
      };
    },
  });
  expect(
    (
      await huge.send({
        method: "tasks.diff",
        context,
        params: { task_id: "task" },
      })
    ).status,
  ).toBe(413);
});

test("RPC bounds request bodies without dispatch", async () => {
  const { send, calls } = fixture();
  const response = await send({
    method: "tasks.steer",
    context,
    params: { task_id: "task", instruction: "x".repeat(600 * 1024) },
  });
  expect(response.status).toBe(413);
  expect(calls).toEqual([]);
});

test("RPC refuses weak tokens and invalid ports", () => {
  const { api } = fixture();
  expect(() => serveWorkbench({ api, token: "short" })).toThrow();
  expect(() => serveWorkbench({ api, token, port: -1 })).toThrow();
  expect(() => serveWorkbench({ api, token, port: 65_536 })).toThrow();
});
