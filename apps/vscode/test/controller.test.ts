import { describe, expect, test } from "bun:test";
import { MarsClient } from "../src/client";
import { type ConnectResult, WorkbenchController } from "../src/controller";
import { RpcError } from "../src/rpc";
import {
  artifactFor,
  budget,
  checkpoint,
  describeResult,
  FakeServer,
  flush,
  harness,
  makeEvent,
  makeTask,
  workspace,
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
  const clientChanges: (MarsClient | undefined)[] = [];
  let n = 0;
  const controller = new WorkbenchController({
    connect: options.connect ?? h.connect,
    ui: h.ui,
    post: (state) => h.states.push(state),
    modelId: () => (options.modelId === undefined ? null : options.modelId),
    newId: () => `id-${++n}`,
    poller: fastPoll,
    onClientChange: (client) => clientChanges.push(client),
  });
  return { ...h, controller, clientChanges };
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

describe("selection across reconnects and task switches", () => {
  async function waitFor(check: () => boolean) {
    for (let i = 0; i < 40 && !check(); i++)
      await new Promise((r) => setTimeout(r, 5));
  }

  test("checkpoints created this session survive switching tasks", async () => {
    const ctx = await connectedWithTask("paused");
    ctx.server.tasks.set("task-2", makeTask({ task_id: "task-2" }));
    await ctx.controller.handleMessage({
      type: "createCheckpoint",
      taskId: "task-1",
    });
    await ctx.controller.handleMessage({
      type: "selectTask",
      taskId: "task-2",
    });
    expect(ctx.last().selected?.checkpoints).toEqual([]);
    await ctx.controller.handleMessage({
      type: "selectTask",
      taskId: "task-1",
    });
    expect(ctx.last().selected?.checkpoints).toEqual([checkpoint]);
    ctx.answer.value = true;
    await ctx.controller.handleMessage({
      type: "restoreCheckpoint",
      taskId: "task-1",
      checkpointId: "cp-1",
    });
    expect(ctx.server.methods()).toContain("tasks.restore");
    ctx.controller.dispose();
  });

  test("reconnecting to the same server does not double events or usage", async () => {
    const server = new FakeServer();
    server.events = [
      makeEvent("e1", {
        usage: { input_tokens: 10, output_tokens: 1, cost_usd: 0 },
      }),
    ];
    server.tasks.set("task-1", makeTask({ status: "running" }));
    const ctx = setup({ server });
    await ctx.controller.handleMessage({ type: "ready" });
    await ctx.controller.handleMessage({
      type: "selectTask",
      taskId: "task-1",
    });
    await waitFor(() => (ctx.last().selected?.events.length ?? 0) >= 1);
    await ctx.controller.handleMessage({ type: "connect" });
    await waitFor(
      () =>
        ctx.last().connection.status === "connected" &&
        (ctx.last().selected?.events.length ?? 0) >= 1,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(ctx.last().selected?.events.map((e) => e.event_id)).toEqual(["e1"]);
    expect(ctx.last().selected?.usage.input_tokens).toBe(10);
    ctx.controller.dispose();
  });

  test("a different server drops the old selection and tasks", async () => {
    const a = new FakeServer();
    a.tasks.set("task-old", makeTask({ task_id: "task-old" }));
    const b = new FakeServer();
    b.tasks.set("task-new", makeTask({ task_id: "task-new" }));
    let target = { server: a, url: "http://127.0.0.1:7331" };
    const ctx = setup({
      server: a,
      connect: async () => ({
        ok: true,
        client: new MarsClient(target.server, () => crypto.randomUUID()),
        server: target.url,
      }),
    });
    await ctx.controller.handleMessage({ type: "ready" });
    await ctx.controller.handleMessage({
      type: "selectTask",
      taskId: "task-old",
    });
    await ctx.controller.handleMessage({
      type: "createCheckpoint",
      taskId: "task-old",
    });
    expect(ctx.last().selected?.task.task_id).toBe("task-old");
    target = { server: b, url: "http://127.0.0.1:7332" };
    await ctx.controller.handleMessage({ type: "connect" });
    expect(ctx.last().selected).toBeNull();
    expect(ctx.last().tasks.map((t) => t.task_id)).toEqual(["task-new"]);
    target = { server: a, url: "http://127.0.0.1:7331" };
    await ctx.controller.handleMessage({ type: "connect" });
    await ctx.controller.handleMessage({
      type: "selectTask",
      taskId: "task-old",
    });
    expect(ctx.last().selected?.checkpoints).toEqual([]);
    ctx.controller.dispose();
  });

  test("refresh drops a selection the server no longer lists", async () => {
    const ctx = await connectedWithTask("paused");
    ctx.server.tasks.delete("task-1");
    await ctx.controller.handleMessage({ type: "refresh" });
    expect(ctx.last().selected).toBeNull();
    expect(ctx.controller.activePoller).toBeUndefined();
    ctx.controller.dispose();
  });
});

describe("verification badge", () => {
  const digest = "b".repeat(64);
  const verdict = (revision: string) => ({
    schema_version: 1,
    operation: "verification.verdict",
    run_id: "run-1",
    task_id: "task-1",
    task_revision: 1,
    candidate: { ...workspace, revision },
    verdict: "passed",
    verified: true,
    checks: [
      {
        kind: "file_content",
        path: "repair.txt",
        expected_sha256: digest,
        observed_sha256: digest,
        status: "passed",
        reason: null,
        duration_ms: 1,
      },
    ],
    reasons: [],
    diagnostics: [],
    duration_ms: 1,
    recorded_at: "2026-11-03T00:00:00Z",
  });

  test("a finished run without evidence is Unverified, never Verified", async () => {
    const ctx = setup();
    ctx.server.tasks.set("task-1", makeTask({ status: "completed" }));
    await ctx.controller.handleMessage({ type: "ready" });
    await ctx.controller.handleMessage({
      type: "selectTask",
      taskId: "task-1",
    });
    expect(ctx.server.methods()).toContain("tasks.verification");
    expect(ctx.last().selected?.verification).toMatchObject({
      state: "unverified",
      label: "Unverified",
      verdict: null,
    });
    ctx.controller.dispose();
  });

  test("failed host checks show opted-in excerpts only for the matching candidate", async () => {
    const ctx = setup();
    ctx.server.tasks.set("task-1", makeTask({ status: "completed" }));
    const reason = "Host check sum exited 1";
    const failed = {
      ...verdict(workspace.revision),
      verdict: "failed",
      verified: false,
      reasons: [reason],
      checks: [
        {
          ...verdict(workspace.revision).checks[0],
          kind: "host_test",
          check_id: "sum",
          status: "failed",
          reason,
          exit_code: 1,
        },
      ],
    };
    let logPatch = digest;
    let rejectOptIn = false;
    ctx.server.on("tasks.verification", (params) => {
      if (params.include_check_logs && rejectOptIn)
        throw new RpcError("protocol", "unknown parameter", "invalid_params");
      return {
        candidate: workspace,
        state: "failed",
        record: failed,
        records: [failed],
        reasons: [reason],
        patch_sha256: params.include_check_logs ? logPatch : digest,
        ...(params.include_check_logs
          ? {
              check_logs: [
                {
                  run_id: failed.run_id,
                  checks: [
                    {
                      check_index: 0,
                      output_tail: "1 fail",
                      capture_truncated: true,
                    },
                  ],
                },
              ],
            }
          : {}),
      };
    });
    await ctx.controller.handleMessage({ type: "ready" });
    await ctx.controller.handleMessage({
      type: "selectTask",
      taskId: "task-1",
    });
    const refresh = async () => {
      await ctx.controller.handleMessage({ type: "refresh" });
      await flush();
    };
    expect(ctx.last().selected?.verification).toMatchObject({
      state: "failed",
      checkLogs: [{ label: "sum", output: "1 fail", captureTruncated: true }],
    });
    logPatch = "c".repeat(64);
    await refresh();
    expect(ctx.last().selected?.verification).toMatchObject({
      state: "failed",
    });
    expect(ctx.last().selected?.verification?.checkLogs).toBeUndefined();
    logPatch = digest;
    rejectOptIn = true;
    await refresh();
    expect(ctx.last().selected?.verification).toMatchObject({
      state: "failed",
    });
    expect(ctx.last().selected?.verification?.checkLogs).toBeUndefined();
    ctx.controller.dispose();
  });

  test("Verified only for the exact candidate; a moved candidate shows stale with the bound revision", async () => {
    const ctx = setup();
    ctx.server.tasks.set("task-1", makeTask({ status: "completed" }));
    let candidate = "rev-2";
    ctx.server.on("tasks.verification", () => ({
      candidate: { ...workspace, revision: candidate },
      state: "verified",
      record: verdict("rev-2"),
      reasons: [],
      records: [verdict("rev-2")],
    }));
    await ctx.controller.handleMessage({ type: "ready" });
    await ctx.controller.handleMessage({
      type: "selectTask",
      taskId: "task-1",
    });
    expect(ctx.last().selected?.verification).toMatchObject({
      state: "verified",
      label: "Verified",
      candidate: "rev-2",
      bound: "rev-2",
    });
    candidate = "rev-3";
    await ctx.controller.handleMessage({
      type: "selectTask",
      taskId: "task-2",
    });
    ctx.server.tasks.set("task-2", makeTask({ task_id: "task-2" }));
    await ctx.controller.handleMessage({
      type: "selectTask",
      taskId: "task-1",
    });
    // The client recomputes the state from the records; a server that still
    // says "verified" for a different candidate is not believed.
    expect(ctx.last().selected?.verification).toMatchObject({
      state: "stale",
      label: "Verification stale",
      candidate: "rev-3",
      bound: "rev-2",
    });
    ctx.controller.dispose();
  });

  test("restoring a checkpoint drops the Verified badge and re-asks the host, which reports stale", async () => {
    const ctx = setup();
    ctx.server.tasks.set("task-1", makeTask({ status: "completed" }));
    let candidate = "rev-2";
    ctx.server.on("tasks.verification", () => ({
      candidate: { ...workspace, revision: candidate },
      state: candidate === "rev-2" ? "verified" : "stale",
      record: verdict("rev-2"),
      reasons: [],
      records: [verdict("rev-2")],
    }));
    ctx.server.on("tasks.restore", () => {
      candidate = "rev-1";
      return { ...workspace, revision: "rev-1" };
    });
    await ctx.controller.handleMessage({ type: "ready" });
    await ctx.controller.handleMessage({
      type: "selectTask",
      taskId: "task-1",
    });
    await ctx.controller.handleMessage({
      type: "createCheckpoint",
      taskId: "task-1",
    });
    expect(ctx.last().selected?.verification?.state).toBe("verified");
    await ctx.controller.handleMessage({
      type: "restoreCheckpoint",
      taskId: "task-1",
      checkpointId: "cp-1",
    });
    expect(
      ctx.server.methods().filter((m) => m === "tasks.verification"),
    ).toHaveLength(2);
    expect(ctx.last().selected?.verification).toMatchObject({
      state: "stale",
      candidate: "rev-1",
      bound: "rev-2",
    });
    ctx.controller.dispose();
  });

  test("a running task shows no badge and asks for the verdict once it completes", async () => {
    const ctx = await connectedWithTask("running");
    expect(ctx.last().selected?.verification).toBeNull();
    expect(ctx.server.methods()).not.toContain("tasks.verification");
    const failed = {
      ...verdict("rev-2"),
      verdict: "failed",
      verified: false,
      checks: [
        {
          kind: "file_content",
          path: "repair.txt",
          expected_sha256: digest,
          observed_sha256: null,
          status: "failed",
          reason: "Required file missing: repair.txt",
          duration_ms: 1,
        },
      ],
      reasons: ["Required file missing: repair.txt"],
    };
    ctx.server.on("tasks.verification", () => ({
      candidate: workspace,
      state: "failed",
      record: failed,
      reasons: ["Required file missing: repair.txt"],
      records: [failed],
    }));
    ctx.server.tasks.set(
      "task-1",
      makeTask({ status: "completed", revision: 2 }),
    );
    ctx.server.events.push(makeEvent("e-1", { event_type: "task.updated" }));
    ctx.controller.activePoller?.poke();
    await new Promise((r) => setTimeout(r, 60));
    await flush();
    const badge = ctx.last().selected?.verification;
    expect(badge).toMatchObject({
      state: "failed",
      label: "Verification failed",
    });
    expect(badge?.reasons).toEqual(["Required file missing: repair.txt"]);
    ctx.controller.dispose();
  });
});

describe("verified patch flow", () => {
  const checks = [{ id: "sum-test", label: "Sum unit test" }];
  const patch =
    "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-x\n+\uFEFFx\n";
  const patchArtifact = artifactFor(patch, "patch-1", "text/x-diff");
  const sha = patchArtifact.ref.sha256;
  const verdict = (revision: string, patchSha = sha) => ({
    schema_version: 1,
    operation: "verification.verdict",
    run_id: "run-1",
    task_id: "task-1",
    task_revision: 1,
    candidate: { ...workspace, revision },
    verdict: "passed",
    verified: true,
    checks: [
      {
        kind: "host_test",
        path: "sum-test",
        check_id: "sum-test",
        expected_sha256: "c".repeat(64),
        observed_sha256: "d".repeat(64),
        status: "passed",
        reason: null,
        duration_ms: 1,
        exit_code: 0,
      },
    ],
    reasons: [],
    diagnostics: [],
    duration_ms: 1,
    recorded_at: "2026-11-03T00:00:00Z",
    patch_sha256: patchSha,
  });
  const hostServer = () => {
    const server = new FakeServer();
    server.on("workbench.describe", () => ({
      ...describeResult,
      capabilities: { execute: true, checkpoint: true },
      checks,
    }));
    return server;
  };

  test("Start sends only host-advertised check ids as host_test checks, and refuses them without execute approval", async () => {
    const ctx = setup({ server: hostServer() });
    ctx.server.tasks.set("task-1", makeTask());
    await ctx.controller.handleMessage({ type: "ready" });
    await ctx.controller.handleMessage({
      type: "selectTask",
      taskId: "task-1",
    });
    expect(ctx.last().connection.checks).toEqual(checks);
    const start = (execute: boolean, checkIds: string[]) =>
      ctx.controller.handleMessage({
        type: "startTask",
        taskId: "task-1",
        approvals: { read: true, write: true, execute },
        checkIds,
      });
    await start(false, ["sum-test"]);
    expect(ctx.last().notice?.kind).toBe("permission");
    await start(true, ["not-offered"]);
    expect(ctx.last().notice?.kind).toBe("error");
    expect(ctx.server.methods()).not.toContain("tasks.start");
    await start(true, ["sum-test"]);
    const call = ctx.server.calls.find((item) => item.method === "tasks.start");
    expect(
      (call?.params as { required_checks?: unknown }).required_checks,
    ).toEqual([{ kind: "host_test", check_id: "sum-test" }]);
    expect(ctx.confirms.at(-1)?.detail).toContain(
      "Required checks: Sum unit test",
    );
    ctx.controller.dispose();
  });

  test("a refresh re-asks the verdict, so another window's candidate change turns Verified stale", async () => {
    const ctx = setup({ server: hostServer() });
    ctx.server.tasks.set("task-1", makeTask({ status: "completed" }));
    let candidate = "rev-2";
    ctx.server.on("tasks.verification", () => ({
      candidate: { ...workspace, revision: candidate },
      state: "verified",
      record: verdict("rev-2"),
      reasons: [],
      records: [verdict("rev-2")],
      patch_sha256: sha,
    }));
    await ctx.controller.handleMessage({ type: "ready" });
    await ctx.controller.handleMessage({
      type: "selectTask",
      taskId: "task-1",
    });
    expect(ctx.last().selected?.verification?.state).toBe("verified");
    candidate = "rev-3";
    await ctx.controller.handleMessage({ type: "refresh" });
    await flush();
    expect(ctx.last().selected?.verification).toMatchObject({
      state: "stale",
      candidate: "rev-3",
      bound: "rev-2",
    });
    ctx.controller.dispose();
  });

  test("the same revision with different patch bytes is stale, not Verified", async () => {
    const ctx = setup({ server: hostServer() });
    ctx.server.tasks.set("task-1", makeTask({ status: "completed" }));
    ctx.server.on("tasks.verification", () => ({
      candidate: { ...workspace, revision: "rev-2" },
      state: "verified",
      record: verdict("rev-2"),
      reasons: [],
      records: [verdict("rev-2")],
      patch_sha256: "e".repeat(64),
    }));
    await ctx.controller.handleMessage({ type: "ready" });
    await ctx.controller.handleMessage({
      type: "selectTask",
      taskId: "task-1",
    });
    expect(ctx.last().selected?.verification?.state).toBe("stale");
    await ctx.controller.handleMessage({
      type: "exportPatch",
      taskId: "task-1",
    });
    expect(ctx.server.methods()).not.toContain("tasks.export");
    expect(ctx.saved).toHaveLength(0);
    ctx.controller.dispose();
  });

  test("export saves the exact verified bytes; a moved candidate is refused and the verdict re-asked", async () => {
    const ctx = setup({ server: hostServer() });
    ctx.server.tasks.set("task-1", makeTask({ status: "completed" }));
    ctx.server.artifacts.set("patch-1", patchArtifact.data_base64);
    ctx.server.on("tasks.verification", () => ({
      candidate: { ...workspace, revision: "rev-2" },
      state: "verified",
      record: verdict("rev-2"),
      reasons: [],
      records: [verdict("rev-2")],
      patch_sha256: sha,
    }));
    ctx.server.on("tasks.export", (p) => {
      if (p.expected_revision !== "rev-2" || p.expected_patch_sha256 !== sha)
        throw new RpcError("conflict", "moved", "revision_conflict", 409);
      return {
        candidate: { ...workspace, revision: "rev-2" },
        patch_sha256: sha,
        artifact: patchArtifact.ref,
        files: 1,
        verification: "verified",
        verified: true,
        verdict_run_id: "run-1",
        round_trip: { status: "passed", reason: null },
        unsupported: [],
      };
    });
    await ctx.controller.handleMessage({ type: "ready" });
    await ctx.controller.handleMessage({
      type: "selectTask",
      taskId: "task-1",
    });
    await ctx.controller.handleMessage({
      type: "exportPatch",
      taskId: "task-1",
    });
    expect(ctx.saved).toHaveLength(1);
    expect(Buffer.from(ctx.saved[0]?.bytes ?? []).toString("utf8")).toBe(patch);
    expect(ctx.last().notice?.text).toContain("round trip passed");

    ctx.server.on("tasks.export", () => {
      throw new RpcError("conflict", "moved", "revision_conflict", 409);
    });
    const asked = ctx.server
      .methods()
      .filter((m) => m === "tasks.verification").length;
    await ctx.controller.handleMessage({
      type: "exportPatch",
      taskId: "task-1",
    });
    expect(ctx.saved).toHaveLength(1);
    expect(
      ctx.server.methods().filter((m) => m === "tasks.verification").length,
    ).toBe(asked + 1);
    ctx.controller.dispose();
  });
});

describe("Watch evidence beside the host verdict", () => {
  const record = (revision: string, stale: boolean) => ({
    event_id: `event-${revision}`,
    verdict: "pass",
    assurance: "visual_advisory",
    verified: false,
    recorded_at: "2026-11-03T00:00:00Z",
    workspace_id: workspace.workspace_id,
    workspace_revision: revision,
    diff_sha256: "c".repeat(64),
    stale,
  });

  test("one evidence read paints the badge and the Watch records without tasks.verification", async () => {
    const ctx = setup();
    ctx.server.tasks.set("task-1", makeTask({ status: "completed" }));
    ctx.server.on("tasks.evidence", (params) => {
      expect(params.include_host_verification).toBe(true);
      return {
        task_revision: 1,
        workspace: { ...workspace, revision: "rev-2" },
        diff_sha256: "c".repeat(64),
        verify_records: [record("rev-1", true), record("rev-2", false)],
        host_verification: {
          candidate: { ...workspace, revision: "rev-2" },
          state: "unverified",
          record: null,
          reasons: [],
          records: [],
        },
      };
    });
    await ctx.controller.handleMessage({ type: "ready" });
    await ctx.controller.handleMessage({
      type: "selectTask",
      taskId: "task-1",
    });
    const selected = ctx.last().selected;
    expect(selected?.verification).toMatchObject({
      state: "unverified",
      candidate: "rev-2",
    });
    expect(selected?.watch).toEqual([
      expect.objectContaining({ revision: "rev-2", stale: false }),
      expect.objectContaining({ revision: "rev-1", stale: true }),
    ]);
    expect(ctx.server.methods()).not.toContain("tasks.verification");
    ctx.controller.dispose();
  });

  test("a host that rejects the parameter still gets a badge from tasks.verification", async () => {
    const ctx = setup();
    ctx.server.tasks.set("task-1", makeTask({ status: "completed" }));
    ctx.server.on("tasks.evidence", (params) => {
      if (params.include_host_verification !== undefined)
        throw new RpcError("protocol", "unknown parameter", "invalid_params");
      return {
        task_revision: 1,
        workspace: { ...workspace, revision: "rev-2" },
        diff_sha256: "c".repeat(64),
        verify_records: [record("rev-2", false)],
      };
    });
    await ctx.controller.handleMessage({ type: "ready" });
    await ctx.controller.handleMessage({
      type: "selectTask",
      taskId: "task-1",
    });
    expect(ctx.server.methods()).toContain("tasks.verification");
    expect(ctx.last().selected?.verification?.state).toBe("unverified");
    expect(ctx.last().selected?.watch).toEqual([
      expect.objectContaining({ revision: "rev-2", stale: false }),
    ]);
    expect(ctx.last().notice).toBeNull();
    ctx.controller.dispose();
  });
});

test("a task created from Team Chat is listed at once and never replaces an open task", async () => {
  const ctx = await connectedWithTask("running");
  const fromChat = makeTask({ task_id: "task-chat", status: "pending" });
  ctx.server.tasks.set("task-chat", fromChat);
  const before = ctx.server.methods().length;
  await ctx.controller.adoptTask(fromChat);
  expect(ctx.last().tasks.map((task) => task.task_id)).toContain("task-chat");
  expect(ctx.last().selected?.task.task_id).toBe("task-1");
  expect(ctx.server.methods()).toHaveLength(before);

  const empty = setup();
  await empty.controller.adoptTask(fromChat);
  expect(empty.states).toHaveLength(0);
  empty.server.tasks.set("task-chat", fromChat);
  await empty.controller.handleMessage({ type: "ready" });
  await empty.controller.adoptTask(fromChat);
  expect(empty.last().selected?.task.task_id).toBe("task-chat");
});

test("onClientChange reports the shared client on connect and its loss on reconnect", async () => {
  const ctx = setup();
  await ctx.controller.connect();
  expect(ctx.clientChanges).toHaveLength(1);
  expect(ctx.clientChanges[0]).toBe(ctx.controller.currentClient);
  expect(ctx.controller.currentClient).toBeDefined();
  await ctx.controller.connect();
  expect(ctx.clientChanges.map((c) => c === undefined)).toEqual([
    false,
    true,
    false,
  ]);
});
