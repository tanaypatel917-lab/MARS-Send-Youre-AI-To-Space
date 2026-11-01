import { describe, expect, test } from "bun:test";
import { type ConnectResult, WorkbenchController } from "../src/controller";
import { RpcError } from "../src/rpc";
import {
  artifactFor,
  budget,
  checkpoint,
  FakeServer,
  flush,
  harness,
  makeEvent,
  makeTask,
} from "./fixtures";

const fastPoll = {
  minDelayMs: 50,
  maxDelayMs: 50,
  sleep: (_ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      });
    }),
};

function setup(
  options: {
    server?: FakeServer;
    connect?: () => Promise<ConnectResult>;
    modelId?: string | null;
  } = {},
) {
  const h = harness(options.server);
  let n = 0;
  const controller = new WorkbenchController({
    connect: options.connect ?? h.connect,
    ui: h.ui,
    post: (state) => h.states.push(state),
    modelId: () => (options.modelId === undefined ? null : options.modelId),
    newId: () => `id-${++n}`,
    poller: fastPoll,
  });
  return { ...h, controller };
}

async function connectedWithTask(
  status: "pending" | "running" | "paused" = "pending",
  modelId: string | null = null,
) {
  const ctx = setup({ modelId });
  ctx.server.tasks.set("task-1", makeTask({ status }));
  await ctx.controller.handleMessage({ type: "ready" });
  await ctx.controller.handleMessage({ type: "selectTask", taskId: "task-1" });
  return ctx;
}

describe("connection states", () => {
  test("connects, describes without context and lists tasks", async () => {
    const ctx = setup();
    ctx.server.tasks.set("task-1", makeTask());
    await ctx.controller.handleMessage({ type: "ready" });
    expect(ctx.server.methods()).toEqual(["workbench.describe", "tasks.list"]);
    const state = ctx.last();
    expect(state.connection).toMatchObject({
      status: "connected",
      workspaceLabel: "demo",
      workspaceId: "ws-1",
      canExecute: false,
      canCheckpoint: true,
    });
    expect(state.tasks.map((t) => t.task_id)).toEqual(["task-1"]);
    expect(state.policy.modelId).toBeNull();
    expect(state.policy.paidPolicy).toContain("cannot enable paid fallback");
    ctx.controller.dispose();
  });

  test("reports no-token, blocked, unauthorized and disconnected without claiming a connection", async () => {
    for (const [result, status] of [
      [
        {
          ok: false,
          status: "no-token",
          message: "Set a MARS server token to connect.",
        },
        "no-token",
      ],
      [
        {
          ok: false,
          status: "blocked",
          message: "Server URL must use http or https.",
        },
        "blocked",
      ],
    ] as const) {
      const ctx = setup({ connect: async () => result });
      await ctx.controller.handleMessage({ type: "ready" });
      expect(ctx.last().connection.status).toBe(status);
      expect(ctx.server.calls).toHaveLength(0);
    }
    for (const [kind, status] of [
      ["unauthorized", "unauthorized"],
      ["disconnected", "disconnected"],
      ["timeout", "disconnected"],
      ["protocol", "error"],
    ] as const) {
      const server = new FakeServer();
      server.on("workbench.describe", () => {
        throw new RpcError(kind, "failure");
      });
      const ctx = setup({ server });
      await ctx.controller.handleMessage({ type: "ready" });
      expect(ctx.last().connection.status).toBe(status);
      expect(ctx.last().tasks).toEqual([]);
    }
  });

  test("a dropped connection is shown as disconnected and recovers on the next success", async () => {
    const ctx = setup();
    await ctx.controller.handleMessage({ type: "ready" });
    ctx.server.on("tasks.list", () => {
      throw new RpcError("disconnected", "Cannot reach the MARS server.");
    });
    await ctx.controller.handleMessage({ type: "refresh" });
    expect(ctx.last().connection.status).toBe("disconnected");
    ctx.server.on("tasks.list", () => []);
    await ctx.controller.handleMessage({ type: "refresh" });
    expect(ctx.last().connection.status).toBe("connected");
  });

  test("a rejected token mid-session drops the client and stops polling", async () => {
    const ctx = await connectedWithTask("running");
    expect(ctx.controller.activePoller).toBeDefined();
    ctx.server.on("tasks.list", () => {
      throw new RpcError("unauthorized", "bad token");
    });
    await ctx.controller.handleMessage({ type: "refresh" });
    expect(ctx.last().connection.status).toBe("unauthorized");
    expect(ctx.controller.activePoller).toBeUndefined();
    ctx.controller.dispose();
  });

  test("ignores malformed webview messages", async () => {
    const ctx = setup();
    expect(
      await ctx.controller.handleMessage({
        type: "runShell",
        command: "rm -rf /",
      }),
    ).toBe(false);
    expect(await ctx.controller.handleMessage({ type: "selectTask" })).toBe(
      false,
    );
    expect(ctx.server.calls).toHaveLength(0);
  });
});

describe("task lifecycle", () => {
  test("creates a valid pending revision-0 task with explicit budget and criteria, without starting it", async () => {
    const ctx = setup();
    await ctx.controller.handleMessage({ type: "ready" });
    await ctx.controller.handleMessage({
      type: "createTask",
      request: "  ",
      acceptanceCriteria: ["x"],
      budget,
    });
    expect(ctx.last().notice?.kind).toBe("error");
    await ctx.controller.handleMessage({
      type: "createTask",
      request: "Do it",
      acceptanceCriteria: ["", "  "],
      budget,
    });
    expect(ctx.last().notice?.kind).toBe("error");
    await ctx.controller.handleMessage({
      type: "createTask",
      request: "Do it",
      acceptanceCriteria: ["ok"],
      budget: { ...budget, max_tokens: 0 },
    });
    expect(ctx.server.methods()).not.toContain("tasks.create");

    await ctx.controller.handleMessage({
      type: "createTask",
      request: "Add a README",
      acceptanceCriteria: ["README exists", ""],
      budget,
    });
    const create = ctx.server.calls.find(
      (call) => call.method === "tasks.create",
    );
    expect(create?.params.task).toMatchObject({
      schema_version: 1,
      revision: 0,
      status: "pending",
      request: "Add a README",
      acceptance_criteria: ["README exists"],
      budget,
      scope: {
        owner_id: "owner-1",
        project_id: "project-1",
        workspace_id: "ws-1",
      },
      artifacts: [],
      specialist_revision: null,
    });
    expect(ctx.server.methods()).not.toContain("tasks.start");
    expect(ctx.last().selected?.task.status).toBe("pending");
    ctx.controller.dispose();
  });

  test("start requires explicit confirmation showing model, approvals and paid policy", async () => {
    const ctx = await connectedWithTask(
      "pending",
      "openrouter/some-free-model",
    );
    ctx.answer.value = false;
    await ctx.controller.handleMessage({
      type: "startTask",
      taskId: "task-1",
      approvals: { read: true, write: false, execute: false },
    });
    expect(ctx.server.methods()).not.toContain("tasks.start");
    const confirm = ctx.confirms.at(-1);
    expect(confirm?.detail).toContain("openrouter/some-free-model");
    expect(confirm?.detail).toContain("execute no");
    expect(confirm?.detail).toContain("paid-model policy");

    ctx.answer.value = true;
    await ctx.controller.handleMessage({
      type: "startTask",
      taskId: "task-1",
      approvals: { read: true, write: true, execute: false },
    });
    const start = ctx.server.calls.find(
      (call) => call.method === "tasks.start",
    );
    expect(start?.params).toEqual({
      task_id: "task-1",
      expected_revision: 0,
      approvals: { read: true, write: true, execute: false },
      model_id: "openrouter/some-free-model",
    });
    expect(ctx.last().selected?.task).toMatchObject({
      status: "running",
      revision: 1,
    });
    ctx.controller.dispose();
  });

  test("execute approval is refused when the server does not offer execution", async () => {
    const ctx = await connectedWithTask("pending");
    await ctx.controller.handleMessage({
      type: "startTask",
      taskId: "task-1",
      approvals: { read: true, write: true, execute: true },
    });
    expect(ctx.confirms).toHaveLength(0);
    expect(ctx.server.methods()).not.toContain("tasks.start");
    expect(ctx.last().notice?.kind).toBe("permission");
    ctx.controller.dispose();
  });

  test("revision conflicts keep server truth and reload the task", async () => {
    const ctx = await connectedWithTask("pending");
    ctx.server.tasks.set("task-1", makeTask({ revision: 3 }));
    await ctx.controller.handleMessage({
      type: "startTask",
      taskId: "task-1",
      approvals: { read: true, write: false, execute: false },
    });
    await flush();
    const state = ctx.last();
    expect(state.notice?.kind).toBe("conflict");
    expect(state.selected?.task.revision).toBe(3);
    expect(state.selected?.task.status).toBe("pending");
    ctx.controller.dispose();
  });

  test("resume, steer and cancel go through the server with confirmations", async () => {
    const ctx = await connectedWithTask("paused");
    ctx.answer.value = false;
    await ctx.controller.handleMessage({
      type: "resumeTask",
      taskId: "task-1",
    });
    expect(ctx.server.methods()).not.toContain("tasks.resume");
    ctx.answer.value = true;
    await ctx.controller.handleMessage({
      type: "resumeTask",
      taskId: "task-1",
    });
    expect(
      ctx.server.calls.find((c) => c.method === "tasks.resume")?.params,
    ).toEqual({ task_id: "task-1", expected_revision: 0 });

    await ctx.controller.handleMessage({
      type: "steerTask",
      taskId: "task-1",
      instruction: "   ",
    });
    expect(ctx.server.methods()).not.toContain("tasks.steer");
    await ctx.controller.handleMessage({
      type: "steerTask",
      taskId: "task-1",
      instruction: " focus on tests ",
    });
    expect(
      ctx.server.calls.find((c) => c.method === "tasks.steer")?.params,
    ).toEqual({ task_id: "task-1", instruction: "focus on tests" });

    ctx.answer.value = false;
    await ctx.controller.handleMessage({
      type: "cancelTask",
      taskId: "task-1",
    });
    expect(ctx.server.methods()).not.toContain("tasks.cancel");
    ctx.answer.value = true;
    await ctx.controller.handleMessage({
      type: "cancelTask",
      taskId: "task-1",
    });
    await flush();
    expect(ctx.server.methods()).toContain("tasks.cancel");
    expect(ctx.last().selected?.task.status).toBe("cancelled");
    ctx.controller.dispose();
  });

  test("only pending tasks can be started and only paused tasks resumed", async () => {
    const ctx = await connectedWithTask("running");
    await ctx.controller.handleMessage({
      type: "startTask",
      taskId: "task-1",
      approvals: { read: true, write: false, execute: false },
    });
    await ctx.controller.handleMessage({
      type: "resumeTask",
      taskId: "task-1",
    });
    expect(ctx.confirms).toHaveLength(0);
    ctx.controller.dispose();
  });
});

describe("events, artifacts and polling", () => {
  test("streams incremental events, aggregates usage and inspects verified artifacts", async () => {
    const server = new FakeServer();
    const payload = artifactFor(
      "<script>alert(1)</script> model output",
      "a-e1",
    );
    server.events = [
      makeEvent("e1", {
        payload: payload.ref,
        usage: { input_tokens: 10, output_tokens: 5, cost_usd: 0 },
      }),
      makeEvent("e2", {
        usage: { input_tokens: 1, output_tokens: 1, cost_usd: null },
      }),
      makeEvent("e3"),
    ];
    server.artifacts.set("a-e1", payload.data_base64);
    server.tasks.set("task-1", makeTask({ status: "running" }));
    const ctx = setup({ server });
    await ctx.controller.handleMessage({ type: "ready" });
    await ctx.controller.handleMessage({
      type: "selectTask",
      taskId: "task-1",
    });
    for (
      let i = 0;
      i < 20 && (ctx.last().selected?.events.length ?? 0) < 3;
      i++
    )
      await new Promise((r) => setTimeout(r, 5));
    const selected = ctx.last().selected;
    expect(selected?.events.map((e) => e.event_id)).toEqual(["e1", "e2", "e3"]);
    expect(selected?.usage).toMatchObject({
      input_tokens: 11,
      output_tokens: 6,
      cost_usd: 0,
      cost_unknown: true,
    });
    const cursors = server.calls
      .filter((c) => c.method === "tasks.events")
      .map((c) => c.params.after_event_id);
    expect(cursors.slice(0, 2)).toEqual([undefined, "e2"]);

    await ctx.controller.handleMessage({
      type: "inspectArtifact",
      taskId: "task-1",
      artifactId: "a-e1",
    });
    expect(ctx.last().selected?.artifact).toMatchObject({
      artifact_id: "a-e1",
      text: "<script>alert(1)</script> model output",
    });
    await ctx.controller.handleMessage({
      type: "inspectArtifact",
      taskId: "task-1",
      artifactId: "unknown",
    });
    expect(ctx.last().notice?.text).toBe("Unknown artifact.");
    ctx.controller.dispose();
  });

  test("switching tasks and disposing cancel the poller", async () => {
    const ctx = await connectedWithTask("running");
    ctx.server.tasks.set(
      "task-2",
      makeTask({ task_id: "task-2", status: "running" }),
    );
    const first = ctx.controller.activePoller;
    expect(first?.disposed).toBe(false);
    await ctx.controller.handleMessage({
      type: "selectTask",
      taskId: "task-2",
    });
    expect(first?.disposed).toBe(true);
    const second = ctx.controller.activePoller;
    expect(second).not.toBe(first);
    ctx.controller.dispose();
    expect(second?.disposed).toBe(true);
    const callsAfterDispose = ctx.server.calls.length;
    await new Promise((r) => setTimeout(r, 20));
    expect(ctx.server.calls.length).toBe(callsAfterDispose);
  });

  test("terminal tasks are not polled forever", async () => {
    const ctx = await connectedWithTask("pending");
    ctx.server.tasks.set(
      "task-1",
      makeTask({ status: "completed", revision: 2 }),
    );
    await ctx.controller.handleMessage({ type: "refresh" });
    await new Promise((r) => setTimeout(r, 20));
    const count = ctx.server.calls.filter(
      (c) => c.method === "tasks.events",
    ).length;
    await new Promise((r) => setTimeout(r, 20));
    expect(
      ctx.server.calls.filter((c) => c.method === "tasks.events").length,
    ).toBe(count);
    ctx.controller.dispose();
  });
});

describe("diffs and checkpoints", () => {
  test("diff entries with unsafe paths are marked unsafe and never opened", async () => {
    const ctx = await connectedWithTask("running");
    ctx.server.on("tasks.diff", () => ({
      files: [
        {
          path: "src/a.ts",
          status: "modified",
          patch: "@@ -1 +1 @@\n-a\n+b\n",
        },
        { path: "../../etc/passwd", status: "modified", patch: "" },
      ],
    }));
    await ctx.controller.handleMessage({ type: "loadDiff", taskId: "task-1" });
    const diff = ctx.last().selected?.diff;
    expect(
      diff?.map((f) => [f.path, f.safe, f.additions, f.deletions]),
    ).toEqual([
      ["src/a.ts", true, 1, 1],
      ["../../etc/passwd", false, 0, 0],
    ]);
    await ctx.controller.handleMessage({
      type: "openDiff",
      taskId: "task-1",
      index: 0,
    });
    await ctx.controller.handleMessage({
      type: "openDiff",
      taskId: "task-1",
      index: 9,
    });
    expect(ctx.opened).toEqual(["src/a.ts"]);
    ctx.controller.dispose();
  });

  test("restore needs explicit confirmation naming the exact workspace and checkpoint", async () => {
    const ctx = await connectedWithTask("paused");
    await ctx.controller.handleMessage({
      type: "restoreCheckpoint",
      taskId: "task-1",
      checkpointId: "cp-1",
    });
    expect(ctx.last().notice?.text).toBe("Unknown checkpoint.");
    await ctx.controller.handleMessage({
      type: "createCheckpoint",
      taskId: "task-1",
    });
    expect(ctx.last().selected?.checkpoints).toEqual([checkpoint]);

    ctx.answer.value = false;
    await ctx.controller.handleMessage({
      type: "restoreCheckpoint",
      taskId: "task-1",
      checkpointId: "cp-1",
    });
    expect(ctx.server.methods()).not.toContain("tasks.restore");
    const confirm = ctx.confirms.at(-1);
    expect(confirm?.action).toBe("Restore workspace");
    expect(confirm?.detail).toContain("Workspace: ws-1");
    expect(confirm?.detail).toContain("Checkpoint: cp-1");
    expect(confirm?.detail).toContain("Current workspace revision: rev-1");

    ctx.answer.value = true;
    await ctx.controller.handleMessage({
      type: "restoreCheckpoint",
      taskId: "task-1",
      checkpointId: "cp-1",
    });
    expect(
      ctx.server.calls.find((c) => c.method === "tasks.restore")?.params,
    ).toEqual({
      task_id: "task-1",
      checkpoint_id: "cp-1",
      expected_revision: "rev-1",
    });
    expect(ctx.last().selected?.workspace?.workspace_id).toBe("ws-1");
    ctx.controller.dispose();
  });

  test("checkpoint is refused when the server lacks the capability", async () => {
    const server = new FakeServer();
    server.on("workbench.describe", () => ({
      scope: {
        owner_id: "owner-1",
        project_id: "project-1",
        workspace_id: "ws-1",
      },
      workspaceLabel: "demo",
      capabilities: { execute: false, checkpoint: false },
    }));
    server.tasks.set("task-1", makeTask());
    const ctx = setup({ server });
    await ctx.controller.handleMessage({ type: "ready" });
    await ctx.controller.handleMessage({
      type: "selectTask",
      taskId: "task-1",
    });
    await ctx.controller.handleMessage({
      type: "createCheckpoint",
      taskId: "task-1",
    });
    expect(ctx.last().notice?.kind).toBe("permission");
    expect(server.methods()).not.toContain("tasks.checkpoint");
    ctx.controller.dispose();
  });

  test("posted view state never contains the server token", async () => {
    const ctx = await connectedWithTask("running");
    expect(JSON.stringify(ctx.states)).not.toMatch(/dummy-token|Bearer/);
    ctx.controller.dispose();
  });
});
