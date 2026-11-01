import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RequestContext, Task, WorkspaceRef } from "@mars/contracts";
import type { RuntimeOutcome, RuntimeSessionOptions } from "@mars/execution";
import { loadModelRegistry } from "@mars/providers";
import { createTaskStore } from "@mars/tasks";
import { createWorkbenchHost, type WorkspaceHost } from "./host";

const scope = {
  owner_id: "owner",
  project_id: "project",
  workspace_id: "workspace",
};
const context = (): RequestContext => ({
  schema_version: 1,
  scope,
  request_id: randomUUID(),
});
const task = (taskId = "task"): Task => ({
  schema_version: 1,
  task_id: taskId,
  session_id: `session-${taskId}`,
  scope,
  revision: 0,
  request: "Write a fixture",
  acceptance_criteria: ["Source checkout remains unchanged"],
  budget: {
    max_tokens: 1000,
    max_usd: 0,
    max_duration_ms: 1000,
    max_depth: 1,
    max_concurrency: 1,
  },
  status: "pending",
  specialist_revision: null,
  artifacts: [],
});
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mars-host-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = await createTaskStore({
    rootDir: join(root, "store"),
    workspaceRoots: [],
  });
  cleanup.push(() => store.close());
  const ref: WorkspaceRef = {
    provider: "test",
    workspace_id: "workspace",
    revision: "r1",
  };
  let prepareCalls = 0;
  let restoreCalls = 0;
  const artifact = await store.artifacts.put(
    context(),
    new TextEncoder().encode("checkpoint"),
    "text/plain",
  );
  const workspace: WorkspaceHost = {
    async prepare() {
      prepareCalls++;
      return ref;
    },
    async reopen() {
      return ref;
    },
    async cwd() {
      return join(root, "isolated");
    },
    async read() {
      return artifact;
    },
    async write() {},
    async execute() {
      return {
        exit_code: 0,
        stdout: artifact,
        stderr: artifact,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
      };
    },
    async stop() {},
    async collect() {
      return [];
    },
    async checkpoint() {
      return { checkpoint_id: "checkpoint", workspace: ref, artifact };
    },
    async restore() {
      restoreCalls++;
      return ref;
    },
    async diff() {
      return { files: [] };
    },
  };
  const sessions: {
    options: RuntimeSessionOptions;
    finish(status: RuntimeOutcome["status"]): void;
    disposed: Promise<void>;
  }[] = [];
  const registry = await loadModelRegistry({ cwd: root, home: root, env: {} });
  const makeHost = () =>
    createWorkbenchHost({
      scope,
      workspaceLabel: "fixture",
      stateRoot: root,
      store,
      workspace,
      registry,
      canExecute: false,
      async runtimeFactory(options) {
        const outcome = deferred<RuntimeOutcome>();
        const disposed = deferred<void>();
        const finish = (status: RuntimeOutcome["status"]) =>
          outcome.resolve({
            status,
            content: "fixture result",
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              reserved_usd: 0,
              reserved_tokens: 0,
              deadline: Date.now() + 1000,
            },
          });
        sessions.push({ options, finish, disposed: disposed.promise });
        return {
          sessionId: "upstream",
          modelId: options.modelId ?? "fixture/free",
          journalPath:
            options.sessionFile ?? join(options.stateDir, "session.jsonl"),
          run: () => outcome.promise,
          async steer() {},
          async cancel() {
            finish("cancelled");
          },
          async dispose() {
            disposed.resolve();
          },
        };
      },
    });
  return {
    root,
    store,
    artifact,
    workspace,
    sessions,
    makeHost,
    get prepareCalls() {
      return prepareCalls;
    },
    get restoreCalls() {
      return restoreCalls;
    },
  };
}

test("host persists launch metadata, runs only through the runtime and publishes output", async () => {
  const f = await fixture();
  const api = await f.makeHost();
  await api.create(context(), task());
  expect(
    (
      await api.start(context(), {
        task_id: "task",
        expected_revision: 0,
        approvals: { read: true, write: true, execute: false },
      })
    ).status,
  ).toBe("running");
  expect(f.sessions).toHaveLength(1);
  expect(f.sessions[0]?.options.cwd).toBe(join(f.root, "isolated"));
  await expect(
    f.sessions[0]?.options.tools.execute(["anything"]),
  ).rejects.toMatchObject({ code: "forbidden" });
  required(f.sessions[0]).finish("completed");
  await required(f.sessions[0]).disposed;
  const completed = await api.inspect(context(), "task");
  expect(completed.status).toBe("completed");
  expect(completed.artifacts).toHaveLength(1);
  expect(
    (await api.artifact(context(), "task", required(completed.artifacts[0])))
      .data_base64,
  ).toBe(Buffer.from("fixture result").toString("base64"));
});

test("host resumes the same journal/model/approvals and never prepares a replacement workspace", async () => {
  const f = await fixture();
  const api = await f.makeHost();
  await api.create(context(), task());
  await api.start(context(), {
    task_id: "task",
    expected_revision: 0,
    model_id: "fixture/free",
    approvals: { read: true, write: false, execute: false },
  });
  required(f.sessions[0]).finish("paused");
  await required(f.sessions[0]).disposed;
  const paused = await api.inspect(context(), "task");
  const replacement = await f.makeHost();
  await replacement.resume(context(), "task", paused.revision);
  expect(f.prepareCalls).toBe(1);
  expect(f.sessions[1]?.options.sessionFile).toBe(
    f.sessions[0]?.options.sessionFile ??
      join(required(f.sessions[0]).options.stateDir, "session.jsonl"),
  );
  expect(f.sessions[1]?.options.approvals).toEqual({
    read: true,
    write: false,
    execute: false,
  });
  await expect(
    f.sessions[1]?.options.tools.write("file", new Uint8Array()),
  ).rejects.toMatchObject({ code: "forbidden" });
  await replacement.cancel(context(), "task");
  await required(f.sessions[1]).disposed;
  expect((await replacement.inspect(context(), "task")).status).toBe(
    "cancelled",
  );
});

test("host requires task-specific artifact/checkpoint ownership and exact scope", async () => {
  const f = await fixture();
  const api = await f.makeHost();
  await api.create(context(), task());
  await api.create(context(), task("other"));
  await expect(
    api.artifact(context(), "task", f.artifact),
  ).rejects.toMatchObject({ code: "not_found" });
  const checkpoint = await api.checkpoint(context(), "task");
  expect(checkpoint.checkpoint_id).toBe("checkpoint");
  await expect(
    api.restore(context(), "other", "checkpoint", "r1"),
  ).rejects.toMatchObject({ code: "not_found" });
  expect(f.restoreCalls).toBe(0);
  await api.restore(context(), "task", "checkpoint", "r1");
  expect(f.restoreCalls).toBe(1);
  await expect(
    api.list({ ...context(), scope: { ...scope, owner_id: "other" } }),
  ).rejects.toMatchObject({ code: "forbidden" });
});

test("host rejects private paths in public artifacts and diffs without reflecting them", async () => {
  const f = await fixture();
  const api = await f.makeHost();
  await api.create(context(), task());
  const privateArtifact = await f.store.artifacts.put(
    context(),
    new TextEncoder().encode(`Private: ${f.root}/journal.jsonl`),
    "text/plain",
  );
  await f.store.update(context(), "task", 0, { artifacts: [privateArtifact] });
  await expect(
    api.artifact(context(), "task", privateArtifact),
  ).rejects.toMatchObject({ code: "forbidden" });
  f.workspace.diff = async () => ({
    files: [
      { path: "file.txt", status: "added", patch: `+${f.root}/journal.jsonl` },
    ],
  });
  await expect(api.diff(context(), "task")).rejects.toMatchObject({
    code: "forbidden",
  });
});

test("host fails closed on lost workspace state rather than preparing another tree", async () => {
  const f = await fixture();
  const api = await f.makeHost();
  await api.create(context(), task());
  await api.start(context(), {
    task_id: "task",
    expected_revision: 0,
    approvals: { read: true, write: false, execute: false },
  });
  required(f.sessions[0]).finish("paused");
  await required(f.sessions[0]).disposed;
  const paused = await api.inspect(context(), "task");
  f.workspace.reopen = async () => {
    throw new Error("workspace state lost");
  };
  const replacement = await f.makeHost();
  await expect(
    replacement.resume(context(), "task", paused.revision),
  ).rejects.toThrow("workspace state lost");
  expect(f.prepareCalls).toBe(1);
  expect(f.sessions).toHaveLength(1);
  expect((await replacement.inspect(context(), "task")).status).toBe("paused");
});

test("host reserves lifecycle transitions before opening a concurrent runtime", async () => {
  const f = await fixture();
  const api = await f.makeHost();
  await api.create(context(), task());
  const starts = await Promise.allSettled(
    [0, 1].map(() =>
      api.start(context(), {
        task_id: "task",
        expected_revision: 0,
        approvals: { read: true, write: false, execute: false },
      }),
    ),
  );
  expect(starts.filter((result) => result.status === "fulfilled")).toHaveLength(
    1,
  );
  expect(f.sessions).toHaveLength(1);
  required(f.sessions[0]).finish("paused");
  await required(f.sessions[0]).disposed;
  const paused = await api.inspect(context(), "task");
  const resumes = await Promise.allSettled(
    [0, 1].map(() => api.resume(context(), "task", paused.revision)),
  );
  expect(
    resumes.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(f.sessions).toHaveLength(2);
  await api.cancel(context(), "task");
  await api.close();
});

test("host shutdown pauses work, drains the runtime and permits journal-backed reopening", async () => {
  const f = await fixture();
  const api = await f.makeHost();
  await api.create(context(), task());
  await api.start(context(), {
    task_id: "task",
    expected_revision: 0,
    approvals: { read: true, write: true, execute: false },
  });
  await api.close();
  await required(f.sessions[0]).disposed;
  const paused = await f.store.inspect(context(), "task");
  expect(paused.status).toBe("paused");
  await expect(api.list(context())).rejects.toMatchObject({
    code: "unavailable",
  });
  await expect(
    required(f.sessions[0]).options.tools.write("late.txt", new Uint8Array()),
  ).rejects.toMatchObject({ code: "conflict" });
  const replacement = await f.makeHost();
  await replacement.resume(context(), "task", paused.revision);
  expect(required(f.sessions[1]).options.sessionFile).toBe(
    join(required(f.sessions[0]).options.stateDir, "session.jsonl"),
  );
  expect(f.prepareCalls).toBe(1);
  await replacement.cancel(context(), "task");
  await replacement.close();
});
