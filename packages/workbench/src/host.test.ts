import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RequestContext, Task, WorkspaceRef } from "@mars/contracts";
import {
  MAX_RUNTIME_INSTRUCTION_LENGTH,
  type RuntimeOutcome,
  type RuntimeSessionOptions,
} from "@mars/execution";
import type { ModelProviderRegistry } from "@mars/providers";
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
    finish(
      status: RuntimeOutcome["status"],
      usage?: Partial<RuntimeOutcome["usage"]>,
    ): void;
    instructions: string[];
    steering: string[];
    disposed: Promise<void>;
  }[] = [];
  await mkdir(join(root, ".mars"));
  await writeFile(
    join(root, ".mars", "models.json"),
    JSON.stringify({
      version: 1,
      providers: [
        {
          id: "fixture",
          kind: "openai-compatible",
          baseUrl: "https://fixture.invalid/v1",
          apiKeyEnv: "FIXTURE_KEY",
        },
      ],
      models: [
        {
          id: "fixture/free",
          providerId: "fixture",
          model: "fixture",
          capabilities: { tools: true, vision: false, contextWindow: 32768 },
          pricing: { free: true },
        },
      ],
      routes: { default: ["fixture/free"] },
    }),
  );
  const registry = await loadModelRegistry({
    cwd: root,
    home: root,
    env: { FIXTURE_KEY: "dummy-not-live" },
  });
  const makeHost = (modelRegistry: ModelProviderRegistry = registry) =>
    createWorkbenchHost({
      scope,
      workspaceLabel: "fixture",
      stateRoot: root,
      store,
      workspace,
      registry: modelRegistry,
      canExecute: false,
      async runtimeFactory(options) {
        const outcome = deferred<RuntimeOutcome>();
        const disposed = deferred<void>();
        const instructions: string[] = [];
        const steering: string[] = [];
        const finish = (
          status: RuntimeOutcome["status"],
          usage: Partial<RuntimeOutcome["usage"]> = {},
        ) =>
          outcome.resolve({
            status,
            content: "fixture result",
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              reserved_usd: 0,
              reserved_tokens: 0,
              deadline: Date.now() + 1000,
              ...usage,
            },
          });
        sessions.push({
          options,
          finish,
          disposed: disposed.promise,
          instructions,
          steering,
        });
        return {
          sessionId: "upstream",
          modelId: options.modelId ?? "fixture/free",
          journalPath:
            options.sessionFile ?? join(options.stateDir, "session.jsonl"),
          run: (instruction: string) => {
            if (
              !instruction.trim() ||
              instruction.length > MAX_RUNTIME_INSTRUCTION_LENGTH
            )
              throw new Error("Invalid task instruction.");
            instructions.push(instruction);
            return outcome.promise;
          },
          async steer(instruction: string) {
            steering.push(instruction);
          },
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

test("missing-model setup fails before reserving a task, so it can start after configuration is fixed", async () => {
  const f = await fixture();
  const unavailable = await loadModelRegistry({
    cwd: f.root,
    home: f.root,
    env: {},
  });
  const api = await f.makeHost(unavailable);
  await api.create(context(), task());
  await expect(
    api.start(context(), {
      task_id: "task",
      expected_revision: 0,
      approvals: { read: true, write: true, execute: false },
    }),
  ).rejects.toThrow("No eligible configured model");
  expect((await api.inspect(context(), "task")).status).toBe("pending");
  expect((await api.inspect(context(), "task")).revision).toBe(0);
  expect(f.prepareCalls).toBe(0);
  expect(f.sessions).toHaveLength(0);
  const configured = await f.makeHost();
  await configured.start(context(), {
    task_id: "task",
    expected_revision: 0,
    approvals: { read: true, write: true, execute: false },
  });
  expect(f.sessions).toHaveLength(1);
  await configured.cancel(context(), "task");
  await configured.close();
});

test.each(["request", "criteria"])(
  "oversized initial %s is rejected before reserving a task or preparing execution",
  async (field) => {
    const f = await fixture();
    const api = await f.makeHost();
    const oversized = task();
    if (field === "request")
      oversized.request = "x".repeat(MAX_RUNTIME_INSTRUCTION_LENGTH);
    else
      oversized.acceptance_criteria = [
        "x".repeat(MAX_RUNTIME_INSTRUCTION_LENGTH),
      ];
    await api.create(context(), oversized);
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(
        api.start(context(), {
          task_id: "task",
          expected_revision: 0,
          approvals: { read: true, write: true, execute: false },
        }),
      ).rejects.toMatchObject({ code: "too_large" });
      expect(await api.inspect(context(), "task")).toEqual(oversized);
      expect(f.prepareCalls).toBe(0);
      expect(f.sessions).toHaveLength(0);
      expect(await f.store.upstreamSession(context(), "task")).toBeNull();
    }
    await api.close();
  },
);

test("the exact runtime character limit is accepted without truncating request or criteria", async () => {
  const f = await fixture();
  const api = await f.makeHost();
  const bounded = task();
  const suffix = `\n\nAcceptance criteria:\n${bounded.acceptance_criteria.map((criterion) => `- ${criterion}`).join("\n")}`;
  const remaining = MAX_RUNTIME_INSTRUCTION_LENGTH - suffix.length;
  bounded.request =
    "😀".repeat(Math.floor(remaining / 2)) + "x".repeat(remaining % 2);
  await api.create(context(), bounded);
  const running = await api.start(context(), {
    task_id: "task",
    expected_revision: 0,
    approvals: { read: true, write: true, execute: false },
  });
  expect(running.status).toBe("running");
  const session = required(f.sessions[0]);
  const instruction = required(session.instructions[0]);
  expect(instruction.length).toBe(MAX_RUNTIME_INSTRUCTION_LENGTH);
  expect(instruction === bounded.request + suffix).toBe(true);
  session.finish("completed");
  await session.disposed;
  expect((await api.inspect(context(), "task")).status).toBe("completed");
  await api.close();
});

test("paused steering survives host restart, is consumed on resume, and usage counts only new tokens", async () => {
  const f = await fixture();
  const api = await f.makeHost();
  await api.create(context(), task());
  await api.start(context(), {
    task_id: "task",
    expected_revision: 0,
    approvals: { read: true, write: true, execute: false },
  });
  await api.steer(context(), "task", "Live instruction");
  expect(required(f.sessions[0]).steering).toEqual(["Live instruction"]);
  required(f.sessions[0]).finish("paused", {
    input_tokens: 50,
    output_tokens: 10,
  });
  await required(f.sessions[0]).disposed;
  await api.steer(context(), "task", "Use the requested checkpoint");
  await api.close();
  const replacement = await f.makeHost();
  const paused = await replacement.inspect(context(), "task");
  await Promise.all([
    replacement.steer(context(), "task", "Then run verification"),
    replacement.resume(context(), "task", paused.revision),
  ]);
  const resumed = required(f.sessions[1]);
  expect(resumed.instructions[0]).toContain("Use the requested checkpoint");
  expect(resumed.instructions[0]).toContain("Then run verification");
  expect(resumed.instructions[0]).not.toContain("Live instruction");
  resumed.finish("paused", { input_tokens: 80, output_tokens: 15 });
  await resumed.disposed;
  const again = await replacement.inspect(context(), "task");
  await replacement.resume(context(), "task", again.revision);
  const last = required(f.sessions[2]);
  expect(last.instructions[0]).not.toContain("Use the requested checkpoint");
  expect(last.instructions[0]).not.toContain("Then run verification");
  last.finish("completed", { input_tokens: 80, output_tokens: 15 });
  await last.disposed;
  const usages = [];
  for await (const event of f.store.events(context(), "task"))
    if (event.usage) usages.push(event.usage);
  expect(usages).toEqual([
    { input_tokens: 50, output_tokens: 10, cost_usd: 0 },
    { input_tokens: 30, output_tokens: 5, cost_usd: 0 },
    { input_tokens: 0, output_tokens: 0, cost_usd: 0 },
  ]);
});

test("oversized paused steering is delivered in ordered bounded batches across restart without losing acknowledgments", async () => {
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
  const instructions = Array.from({ length: 8 }, (_, index) =>
    `instruction-${index}:`.padEnd(16 * 1024, "x"),
  );
  for (const instruction of instructions)
    await api.steer(context(), "task", instruction);
  await api.close();
  const replacement = await f.makeHost();
  await replacement.resume(
    context(),
    "task",
    (await replacement.inspect(context(), "task")).revision,
  );
  const first = required(f.sessions[1]);
  const prompt = required(first.instructions[0]);
  expect(prompt.length).toBeLessThanOrEqual(128 * 1024);
  expect(prompt).toContain(instructions.slice(0, 7).join("\n\n"));
  expect(prompt).not.toContain(required(instructions[7]));
  first.finish("completed");
  await first.disposed;
  expect((await replacement.inspect(context(), "task")).status).toBe("paused");
  await replacement.close();
  const lastHost = await f.makeHost();
  await lastHost.resume(
    context(),
    "task",
    (await lastHost.inspect(context(), "task")).revision,
  );
  const last = required(f.sessions[2]);
  const remaining = required(last.instructions[0]);
  expect(remaining.length).toBeLessThanOrEqual(128 * 1024);
  expect(remaining).toContain(required(instructions[7]));
  for (const instruction of instructions.slice(0, 7))
    expect(remaining).not.toContain(instruction);
  last.finish("completed");
  await last.disposed;
  expect((await lastHost.inspect(context(), "task")).status).toBe("completed");
  const steeringIds: string[] = [];
  const acknowledgments: string[][] = [];
  for await (const event of f.store.events(context(), "task")) {
    const payload = JSON.parse(
      new TextDecoder().decode(
        await f.store.artifacts.get(context(), event.payload),
      ),
    );
    if (payload.change === "steered") steeringIds.push(event.event_id);
    if (payload.operation === "runtime.result")
      acknowledgments.push(payload.steering_event_ids);
  }
  expect(acknowledgments).toEqual([
    [],
    steeringIds.slice(0, 7),
    steeringIds.slice(7),
  ]);
  await lastHost.close();
});

test("a near-limit original request does not inflate the resumed prompt", async () => {
  const f = await fixture();
  const api = await f.makeHost();
  const large = task();
  large.request = "x".repeat(MAX_RUNTIME_INSTRUCTION_LENGTH - 1024);
  await api.create(context(), large);
  await api.start(context(), {
    task_id: "task",
    expected_revision: 0,
    approvals: { read: true, write: false, execute: false },
  });
  expect(
    required(required(f.sessions[0]).instructions[0]).startsWith(large.request),
  ).toBe(true);
  required(f.sessions[0]).finish("paused");
  await required(f.sessions[0]).disposed;
  const steering = "Keep the saved task requirements".padEnd(16 * 1024, "y");
  await api.steer(context(), "task", steering);
  await api.resume(
    context(),
    "task",
    (await api.inspect(context(), "task")).revision,
  );
  const resumed = required(f.sessions[1]);
  expect(required(resumed.instructions[0]).length).toBeLessThanOrEqual(
    128 * 1024,
  );
  expect(required(resumed.instructions[0]).includes(steering)).toBe(true);
  resumed.finish("completed");
  await resumed.disposed;
  expect((await api.inspect(context(), "task")).status).toBe("completed");
  await api.close();
});

test("unbatchable stored steering is rejected while paused without reserving a revision or opening a runtime", async () => {
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
  const instruction = "x".repeat(MAX_RUNTIME_INSTRUCTION_LENGTH + 1);
  const event = await f.store.appendEvent(context(), "task", {
    event_type: "tool.completed",
    producer: "@mars/workbench",
    run_id: "legacy-steering",
    versions: [{ component: "fixture", revision: "1" }],
    payload: { change: "steered", task_status: "paused", instruction },
  });
  const paused = await api.inspect(context(), "task");
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(
      api.resume(context(), "task", paused.revision),
    ).rejects.toMatchObject({ code: "too_large" });
    expect(await api.inspect(context(), "task")).toEqual(paused);
    expect(f.sessions).toHaveLength(1);
  }
  const payload = JSON.parse(
    new TextDecoder().decode(
      await f.store.artifacts.get(context(), event.payload),
    ),
  );
  expect(payload.instruction === instruction).toBe(true);
  await api.close();
});

test("shutdown during queued steering delivery leaves the instruction available for the next resume", async () => {
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
  await api.steer(context(), "task", "Keep this after interruption");
  await api.resume(
    context(),
    "task",
    (await api.inspect(context(), "task")).revision,
  );
  expect(required(f.sessions[1]).instructions[0]).toContain(
    "Keep this after interruption",
  );
  await api.close();
  const replacement = await f.makeHost();
  await replacement.resume(
    context(),
    "task",
    (await replacement.inspect(context(), "task")).revision,
  );
  expect(required(f.sessions[2]).instructions[0]).toContain(
    "Keep this after interruption",
  );
  required(f.sessions[2]).finish("completed");
  await required(f.sessions[2]).disposed;
  await replacement.close();
});

test("usage never misrepresents a paid budget reservation as measured billing", async () => {
  const f = await fixture();
  const file = join(f.root, ".mars", "models.json");
  const config = JSON.parse(await Bun.file(file).text());
  config.models[0].pricing = {
    free: false,
    inputPerMTokUsd: 1,
    outputPerMTokUsd: 2,
  };
  config.policy = { allowPaid: true };
  await writeFile(file, JSON.stringify(config));
  const registry = await loadModelRegistry({
    cwd: f.root,
    home: f.root,
    env: { FIXTURE_KEY: "dummy-not-live" },
  });
  const api = await f.makeHost(registry);
  const paid = task();
  paid.budget.max_usd = 1;
  await api.create(context(), paid);
  await api.start(context(), {
    task_id: "task",
    expected_revision: 0,
    model_id: "fixture/free",
    approvals: { read: true, write: false, execute: false },
  });
  required(f.sessions[0]).finish("completed", {
    input_tokens: 50,
    output_tokens: 10,
    reserved_usd: 0.001,
  });
  await required(f.sessions[0]).disposed;
  const usage = [];
  for await (const event of f.store.events(context(), "task"))
    if (event.usage) usage.push(event.usage);
  expect(usage).toEqual([
    { input_tokens: 50, output_tokens: 10, cost_usd: null },
  ]);
  await api.close();
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
