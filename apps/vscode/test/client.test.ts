import { describe, expect, test } from "bun:test";
import { MarsClient } from "../src/client";
import { RpcError } from "../src/rpc";
import {
  artifactFor,
  checkpoint,
  FakeServer,
  makeEvent,
  makeTask,
  scope,
} from "./fixtures";

async function connected(server = new FakeServer()) {
  let n = 0;
  const client = new MarsClient(server, () => `req-${++n}`);
  await client.describe();
  return { client, server };
}

async function kind(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RpcError) return error.kind;
    throw error;
  }
  return "resolved";
}

describe("MarsClient", () => {
  test("describe has no context; later calls carry schema_version, server scope and fresh request ids", async () => {
    const { client, server } = await connected();
    server.tasks.set("task-1", makeTask());
    await client.list();
    await client.inspect("task-1");
    expect(server.calls[0]?.context).toBeUndefined();
    expect(server.calls[1]?.context).toEqual({
      schema_version: 1,
      scope,
      request_id: "req-1",
    });
    expect(server.calls[2]?.context?.request_id).toBe("req-2");
  });

  test("refuses task calls before describe", async () => {
    const client = new MarsClient(new FakeServer());
    expect(await kind(client.list())).toBe("disconnected");
  });

  test("rejects malformed describe results", async () => {
    const server = new FakeServer();
    server.on("workbench.describe", () => ({
      scope,
      workspaceLabel: "x",
      capabilities: { execute: true },
    }));
    expect(await kind(new MarsClient(server).describe())).toBe("protocol");
  });

  test("validates tasks: schema, scope and identity", async () => {
    const { client, server } = await connected();
    server.on("tasks.inspect", () => ({ ...makeTask(), status: "exploded" }));
    expect(await kind(client.inspect("task-1"))).toBe("protocol");
    server.on("tasks.inspect", () =>
      makeTask({ scope: { ...scope, project_id: "other" } }),
    );
    expect(await kind(client.inspect("task-1"))).toBe("protocol");
    server.on("tasks.inspect", () => makeTask({ task_id: "task-2" }));
    expect(await kind(client.inspect("task-1"))).toBe("protocol");
    server.on("tasks.list", () => [makeTask(), makeTask()]);
    expect(await kind(client.list())).toBe("protocol");
  });

  test("start sends expected revision, approvals and optional model", async () => {
    const { client, server } = await connected();
    server.tasks.set("task-1", makeTask());
    const started = await client.start("task-1", {
      expectedRevision: 0,
      approvals: { read: true, write: false, execute: false },
      modelId: "openrouter/free-model",
    });
    expect(started.status).toBe("running");
    expect(server.calls.at(-1)?.params).toEqual({
      task_id: "task-1",
      expected_revision: 0,
      approvals: { read: true, write: false, execute: false },
      model_id: "openrouter/free-model",
    });
    expect(
      await kind(
        client.start("task-1", {
          expectedRevision: 0,
          approvals: { read: true, write: false, execute: false },
        }),
      ),
    ).toBe("conflict");
  });

  test("steer/cancel require a null result", async () => {
    const { client, server } = await connected();
    server.on("tasks.steer", () => ({ ok: true }));
    expect(await kind(client.steer("task-1", "focus"))).toBe("protocol");
  });

  test("validates event batches: foreign task, scope, duplicate ids and cursor echo", async () => {
    const { client, server } = await connected();
    server.on("tasks.events", () => [makeEvent("e1"), makeEvent("e2")]);
    expect(
      (await client.events("task-1", undefined)).map((e) => e.event_id),
    ).toEqual(["e1", "e2"]);
    expect(server.calls.at(-1)?.params).toEqual({ task_id: "task-1" });
    await client.events("task-1", "e0");
    expect(server.calls.at(-1)?.params).toEqual({
      task_id: "task-1",
      after_event_id: "e0",
    });
    for (const bad of [
      [makeEvent("e1", { task_id: "task-2" })],
      [makeEvent("e1", { scope: { ...scope, owner_id: "x" } })],
      [makeEvent("e1"), makeEvent("e1")],
      [{ ...makeEvent("e1"), payload: { inline: "not an artifact ref" } }],
    ]) {
      server.on("tasks.events", () => bad);
      expect(await kind(client.events("task-1", undefined))).toBe("protocol");
    }
    server.on("tasks.events", () => [makeEvent("e5")]);
    expect(await kind(client.events("task-1", "e5"))).toBe("protocol");
  });

  test("verifies artifact hash, size and media type", async () => {
    const { client, server } = await connected();
    const good = artifactFor("hello");
    server.artifacts.set(good.ref.artifact_id, good.data_base64);
    const artifact = await client.artifact("task-1", good.ref);
    expect(Buffer.from(artifact.bytes).toString()).toBe("hello");
    server.artifacts.set(
      good.ref.artifact_id,
      Buffer.from("tampered").toString("base64"),
    );
    expect(await kind(client.artifact("task-1", good.ref))).toBe("protocol");
    server.on("tasks.artifact", () => ({
      data_base64: good.data_base64,
      media_type: "text/html",
    }));
    expect(await kind(client.artifact("task-1", good.ref))).toBe("protocol");
  });

  test("diff rejects duplicate paths and bad statuses", async () => {
    const { client, server } = await connected();
    server.on("tasks.diff", () => ({
      files: [
        { path: "a.ts", status: "modified", patch: "" },
        { path: "a.ts", status: "added", patch: "" },
      ],
    }));
    expect(await kind(client.diff("task-1"))).toBe("protocol");
    server.on("tasks.diff", () => ({
      files: [{ path: "a.ts", status: "renamed", patch: "" }],
    }));
    expect(await kind(client.diff("task-1"))).toBe("protocol");
  });

  test("checkpoint/restore validate workspace identity and send exact params", async () => {
    const { client, server } = await connected();
    expect(await client.checkpoint("task-1")).toEqual(checkpoint);
    const restored = await client.restore("task-1", checkpoint, "rev-2");
    expect(restored.workspace_id).toBe("ws-1");
    expect(server.calls.at(-1)?.params).toEqual({
      task_id: "task-1",
      checkpoint_id: "cp-1",
      expected_revision: "rev-2",
    });
    server.on("tasks.restore", () => ({
      workspace_id: "ws-other",
      provider: "git",
      revision: "r",
    }));
    expect(await kind(client.restore("task-1", checkpoint, "rev-2"))).toBe(
      "protocol",
    );
    server.on("tasks.checkpoint", () => ({
      ...checkpoint,
      workspace: { ...checkpoint.workspace, workspace_id: "ws-other" },
    }));
    expect(await kind(client.checkpoint("task-1"))).toBe("protocol");
  });
});
