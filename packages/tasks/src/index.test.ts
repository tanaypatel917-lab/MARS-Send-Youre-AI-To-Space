import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RequestContext, Task } from "@mars/contracts";
import { createTaskStore } from "./index";

const roots: string[] = [];
const scope = {
  owner_id: "owner-1",
  project_id: "project-1",
  workspace_id: "workspace-1",
};
const context = (
  requestId = "request-1",
  taskScope: RequestContext["scope"] = scope,
): RequestContext => ({
  schema_version: 1,
  scope: taskScope,
  request_id: requestId,
});
const makeTask = (
  taskId = "task-1",
  taskScope: RequestContext["scope"] = scope,
): Task => ({
  schema_version: 1,
  task_id: taskId,
  session_id: "session-1",
  scope: taskScope,
  revision: 0,
  request: "Do a task",
  acceptance_criteria: ["It is done"],
  budget: {
    max_tokens: 1000,
    max_usd: 1,
    max_duration_ms: 1000,
    max_depth: 1,
    max_concurrency: 1,
  },
  status: "pending",
  specialist_revision: null,
  artifacts: [],
});

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "mars-tasks-test-"));
  roots.push(root);
  return root;
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

async function openStore(rootDir: string) {
  return createTaskStore({ rootDir, workspaceRoots: [] });
}

function spawnWorker(
  operation: string,
  rootDir: string,
  input: { context: RequestContext; task?: Task; taskId?: string },
) {
  const workerPath = path.join(import.meta.dir, "test-fixtures", "worker.ts");
  return Bun.spawn(
    [process.execPath, workerPath, operation, rootDir, JSON.stringify(input)],
    { stdout: "pipe", stderr: "pipe" },
  );
}

async function runWorker(
  operation: string,
  rootDir: string,
  input: { context: RequestContext; task?: Task; taskId?: string },
): Promise<void> {
  const child = spawnWorker(operation, rootDir, input);
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0)
    throw new Error(`worker failed (${exitCode}): ${stdout}\n${stderr}`);
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("@mars/tasks durable store", () => {
  test("persists lifecycle, events, and child-process writes", async () => {
    const rootDir = makeRoot();
    const first = await openStore(rootDir);
    const task = makeTask();
    await first.create(context(), task);
    const initialRunning = await first.update(
      context("update-running"),
      task.task_id,
      0,
      { status: "running" },
    );
    const paused = await first.update(
      context("update-paused"),
      task.task_id,
      initialRunning.revision,
      {
        status: "paused",
      },
    );
    const resumed = await first.resume(
      context("resume"),
      task.task_id,
      paused.revision,
    );
    const updated = await first.update(
      context("update-specialist"),
      task.task_id,
      resumed.revision,
      {
        specialist_revision: "durable-v1",
      },
    );
    await first.appendEvent(context("append"), task.task_id, {
      event_type: "tool.completed",
      run_id: "run-1",
      producer: "test",
      versions: [{ component: "test", revision: "1" }],
      payload: { result: "ok" },
    });
    await first.close();

    const second = await openStore(rootDir);
    expect(await second.inspect(context(), task.task_id)).toEqual(updated);
    expect(await second.list(context())).toEqual([updated]);
    const persistedEvents = await collect(
      second.events(context(), task.task_id),
    );
    expect(persistedEvents).toHaveLength(6);
    expect(persistedEvents.at(-1)?.event_type).toBe("tool.completed");
    const childTask = makeTask("child-task");
    await runWorker("create", rootDir, {
      context: context("child-create"),
      task: childTask,
    });
    expect(await second.inspect(context(), childTask.task_id)).toEqual(
      childTask,
    );
    await second.close();
    await second.close();
  }, 30_000);

  test("verifies ordered cursors, parent links, and task-local cursor errors", async () => {
    const rootDir = makeRoot();
    const store = await openStore(rootDir);
    const first = makeTask();
    const second = makeTask("task-2");
    await store.create(context(), first);
    await store.create(context("create-2"), second);
    const otherTaskEvents = await collect(
      store.events(context(), second.task_id),
    );
    const otherTaskEvent = otherTaskEvents[0];
    if (!otherTaskEvent)
      throw new Error("Expected the second task's creation event");
    await store.appendEvent(context("event-1"), first.task_id, {
      event_type: "tool.completed",
      run_id: "r1",
      producer: "test",
      versions: [{ component: "test", revision: "1" }],
      payload: { n: 1 },
    });
    const events = await collect(store.events(context(), first.task_id));
    const [firstEvent, secondEvent] = events;
    if (!firstEvent || !secondEvent)
      throw new Error("Expected two task events");
    expect(events.map((event) => event.parent_event_id)).toEqual([
      null,
      firstEvent.event_id,
    ]);
    expect(
      (
        await collect(
          store.events(context(), first.task_id, firstEvent.event_id),
        )
      ).map((event) => event.event_id),
    ).toEqual([secondEvent.event_id]);
    expect(
      await collect(
        store.events(context(), first.task_id, secondEvent.event_id),
      ),
    ).toEqual([]);
    await expect(
      collect(store.events(context(), first.task_id, "unknown")),
    ).rejects.toMatchObject({
      code: "unknown_cursor",
    });
    await expect(
      collect(store.events(context(), first.task_id, otherTaskEvent.event_id)),
    ).rejects.toMatchObject({
      code: "unknown_cursor",
    });
    await expect(
      store.appendEvent(context("foreign-source"), first.task_id, {
        event_type: "tool.completed",
        run_id: "source-check",
        producer: "test",
        versions: [{ component: "test", revision: "1" }],
        payload: { source: true },
        source_event_ids: [otherTaskEvent.event_id],
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await store.close();
  });

  test("serializes concurrent expected-revision updates across store instances", async () => {
    const rootDir = makeRoot();
    const left = await openStore(rootDir);
    const right = await openStore(rootDir);
    const task = makeTask();
    await left.create(context(), task);
    const results = await Promise.allSettled([
      left.update(context("left"), task.task_id, 0, {
        specialist_revision: "a",
      }),
      right.update(context("right"), task.task_id, 0, {
        specialist_revision: "b",
      }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toMatchObject({
      code: "stale_revision",
    });
    await left.close();
    await right.close();
  });

  test("does not lose concurrent child-process appends", async () => {
    const rootDir = makeRoot();
    const store = await openStore(rootDir);
    const task = makeTask();
    await store.create(context(), task);
    await Promise.all([
      runWorker("append50", rootDir, {
        context: context("worker-a"),
        taskId: task.task_id,
      }),
      runWorker("append50", rootDir, {
        context: context("worker-b"),
        taskId: task.task_id,
      }),
    ]);
    const events = await collect(store.events(context(), task.task_id));
    expect(events).toHaveLength(101);
    expect(events[0]?.event_type).toBe("task.created");
    await store.close();
  }, 30_000);

  test("appends 2000 events in order without quadratic write-path cost", async () => {
    const rootDir = makeRoot();
    const store = await openStore(rootDir);
    const task = makeTask();
    await store.create(context(), task);
    const startedAt = performance.now();
    for (let index = 0; index < 2000; index += 1) {
      await store.appendEvent(context(`perf-${index}`), task.task_id, {
        event_type: "tool.completed",
        run_id: `run-${index}`,
        producer: "perf-test",
        versions: [{ component: "test", revision: "1" }],
        payload: { index },
      });
    }
    expect(performance.now() - startedAt).toBeLessThan(15_000);
    const events = await collect(store.events(context(), task.task_id));
    expect(events).toHaveLength(2001);
    expect(events[0]?.event_type).toBe("task.created");
    expect(events.slice(1).map((event) => event.run_id)).toEqual(
      Array.from({ length: 2000 }, (_, index) => `run-${index}`),
    );
    await store.close();
  }, 30_000);

  test("enforces creation, transition, cancellation, steering, and patch rules", async () => {
    const rootDir = makeRoot();
    const store = await openStore(rootDir);
    await expect(
      store.create(context(), { ...makeTask(), status: "running" }),
    ).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(
      store.create(context(), { ...makeTask(), revision: 1 }),
    ).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(
      store.create(context(), { task_id: "missing" } as never),
    ).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(
      store.create(
        context(),
        makeTask("wrong-scope", { owner_id: "other", project_id: "p" }),
      ),
    ).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(
      store.create(context(), { ...makeTask(), unknown: true } as never),
    ).rejects.toMatchObject({
      code: "invalid_input",
    });
    const task = makeTask();
    await store.create(context(), task);
    await expect(
      store.create(context("duplicate"), task),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      store.resume(context(), task.task_id, 0),
    ).rejects.toMatchObject({ code: "invalid_transition" });
    await expect(
      store.update(context(), task.task_id, 1, { status: "running" }),
    ).rejects.toMatchObject({
      code: "stale_revision",
    });
    await expect(
      store.update(context(), task.task_id, 0, {}),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      store.update(context(), task.task_id, 0, { status: "completed" }),
    ).rejects.toMatchObject({
      code: "invalid_transition",
    });
    const foreignScope = { owner_id: "other", project_id: "other" };
    const foreignArtifact = await store.artifacts.put(
      context("foreign-artifact", foreignScope),
      new TextEncoder().encode("foreign"),
      "text/plain",
    );
    await expect(
      store.update(context("foreign-ref"), task.task_id, 0, {
        artifacts: [foreignArtifact],
      }),
    ).rejects.toMatchObject({
      code: "invalid_input",
    });
    await store.steer(
      context("valid-steer"),
      task.task_id,
      "Continue with the accepted plan.",
    );
    const steerEvents = await collect(store.events(context(), task.task_id));
    const steerEvent = steerEvents.at(-1);
    if (!steerEvent) throw new Error("Expected the steering event");
    const steerPayload = JSON.parse(
      new TextDecoder().decode(
        await store.artifacts.get(context(), steerEvent.payload),
      ),
    );
    expect(steerPayload).toEqual({
      change: "steered",
      instruction: "Continue with the accepted plan.",
      task_revision: 0,
    });
    const running = await store.update(context("running"), task.task_id, 0, {
      status: "running",
    });
    const paused = await store.update(
      context("paused"),
      task.task_id,
      running.revision,
      { status: "paused" },
    );
    const resumed = await store.resume(
      context("resume"),
      task.task_id,
      paused.revision,
    );
    expect(resumed.status).toBe("running");
    const revisionEvents = await collect(store.events(context(), task.task_id));
    const revisionPayloads = await Promise.all(
      revisionEvents
        .slice(2)
        .map(async (event) =>
          JSON.parse(
            new TextDecoder().decode(
              await store.artifacts.get(context(), event.payload),
            ),
          ),
        ),
    );
    expect(
      revisionPayloads.map(({ from_revision, to_revision }) => [
        from_revision,
        to_revision,
      ]),
    ).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
    await store.cancel(context("cancel"), task.task_id);
    const cancelledEvent = (
      await collect(store.events(context(), task.task_id))
    ).at(-1);
    if (!cancelledEvent) throw new Error("Expected the cancellation event");
    const cancelledPayload = JSON.parse(
      new TextDecoder().decode(
        await store.artifacts.get(context(), cancelledEvent.payload),
      ),
    );
    expect(cancelledPayload).toMatchObject({
      from_revision: 3,
      to_revision: 4,
    });
    const countBefore = (await collect(store.events(context(), task.task_id)))
      .length;
    await store.cancel(context("cancel-again"), task.task_id);
    expect((await collect(store.events(context(), task.task_id))).length).toBe(
      countBefore,
    );
    await expect(
      store.steer(context("steer"), task.task_id, "   "),
    ).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(
      store.steer(context("steer-terminal"), task.task_id, "continue"),
    ).rejects.toMatchObject({
      code: "invalid_transition",
    });
    const completedTask = makeTask("completed-task");
    await store.create(context("create-completed"), completedTask);
    const completedRunning = await store.update(
      context("completed-running"),
      completedTask.task_id,
      0,
      { status: "running" },
    );
    await store.update(
      context("complete"),
      completedTask.task_id,
      completedRunning.revision,
      {
        status: "completed",
      },
    );
    await expect(
      store.cancel(context("cancel-completed"), completedTask.task_id),
    ).rejects.toMatchObject({
      code: "invalid_transition",
    });
    await store.close();
  });

  test("isolates scopes for task ids, listings, events, and artifacts", async () => {
    const rootDir = makeRoot();
    const store = await openStore(rootDir);
    const otherScope = { owner_id: "owner-2", project_id: "project-2" };
    const firstContext = context("first");
    const otherContext = context("other", otherScope);
    await store.create(firstContext, makeTask());
    await store.create(otherContext, makeTask("task-1", otherScope));
    await store.create(firstContext, makeTask("only-first"));
    expect(
      (await store.list(firstContext)).map((task) => task.task_id),
    ).toEqual(["task-1", "only-first"]);
    const ref = await store.artifacts.put(
      firstContext,
      new TextEncoder().encode("private"),
      "text/plain",
    );
    const missing = await Promise.all([
      store.inspect(otherContext, "only-first").catch((error) => error),
      store.inspect(otherContext, "missing").catch((error) => error),
      store.artifacts.get(otherContext, ref).catch((error) => error),
    ]);
    expect(missing.map((error) => error.message)).toEqual([
      "Task or artifact not found",
      "Task or artifact not found",
      "Task or artifact not found",
    ]);
    const nonexistentTaskError = await store
      .inspect(otherContext, "nonexistent")
      .catch((error) => error);
    const otherScopeEventError = await collect(
      store.events(otherContext, "only-first"),
    ).catch((error) => error);
    expect(nonexistentTaskError.message).toBe("Task or artifact not found");
    expect(otherScopeEventError.message).toBe("Task or artifact not found");
    await expect(
      collect(store.events(otherContext, "task-1")),
    ).resolves.toHaveLength(1);
    await store.close();
  });

  test("validates artifact references, hashes, symlinks, and file modes", async () => {
    const rootDir = makeRoot();
    const store = await openStore(rootDir);
    const ctx = context();
    const bytes = new TextEncoder().encode("artifact bytes");
    const ref = await store.artifacts.put(ctx, bytes, "text/plain");
    expect(await store.artifacts.get(ctx, ref)).toEqual(bytes);
    await expect(
      store.artifacts.get(ctx, { ...ref, sha256: "0".repeat(64) }),
    ).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(
      store.artifacts.get(ctx, { ...ref, byte_length: ref.byte_length + 1 }),
    ).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(
      store.artifacts.get(ctx, { ...ref, media_type: "application/json" }),
    ).rejects.toMatchObject({
      code: "invalid_input",
    });
    const filePath = path.join(
      rootDir,
      "artifacts",
      createHashScope(ctx.scope),
      ref.sha256.slice(0, 2),
      ref.sha256,
    );
    expect(lstatSync(rootDir).mode & 0o777).toBe(0o700);
    expect(lstatSync(filePath).mode & 0o777).toBe(0o600);
    expect(lstatSync(path.join(rootDir, "tasks.sqlite")).mode & 0o777).toBe(
      0o600,
    );
    const outside = path.join(makeRoot(), "outside");
    writeFileSync(outside, "outside");
    rmSync(filePath);
    symlinkSync(outside, filePath);
    await expect(store.artifacts.get(ctx, ref)).rejects.toMatchObject({
      code: "unsafe_path",
    });
    const scopeSymlinkContext = context("scope-symlink", {
      owner_id: "scope-symlink",
      project_id: "p",
    });
    const scopeSymlinkRef = await store.artifacts.put(
      scopeSymlinkContext,
      new TextEncoder().encode("scope symlink"),
      "text/plain",
    );
    const scopeDir = path.join(
      rootDir,
      "artifacts",
      createHashScope(scopeSymlinkContext.scope),
    );
    const externalDir = makeRoot();
    rmSync(scopeDir, { recursive: true });
    symlinkSync(externalDir, scopeDir, "dir");
    await expect(
      store.artifacts.get(scopeSymlinkContext, scopeSymlinkRef),
    ).rejects.toMatchObject({
      code: "unsafe_path",
    });
    await store.close();
  });

  test("detects record tampering, missing events, and truncated artifacts", async () => {
    const rootDir = makeRoot();
    const store = await openStore(rootDir);
    const task = makeTask();
    await store.create(context(), task);
    await store.artifacts.put(
      context(),
      new TextEncoder().encode("payload"),
      "text/plain",
    );
    await store.close();
    const db = new Database(path.join(rootDir, "tasks.sqlite"));
    db.query("UPDATE tasks SET record_json = '{}' WHERE task_id = ?").run(
      task.task_id,
    );
    db.close();
    const tampered = await openStore(rootDir);
    await expect(
      tampered.inspect(context(), task.task_id),
    ).rejects.toMatchObject({ code: "corrupt_record" });
    await tampered.close();

    const freshRoot = makeRoot();
    const fresh = await openStore(freshRoot);
    await fresh.create(context(), task);
    await fresh.appendEvent(context("append"), task.task_id, {
      event_type: "tool.completed",
      run_id: "run",
      producer: "test",
      versions: [{ component: "test", revision: "1" }],
      payload: { ok: true },
    });
    await fresh.close();
    const freshDb = new Database(path.join(freshRoot, "tasks.sqlite"));
    freshDb.query("DELETE FROM events WHERE task_seq = 1").run();
    freshDb.close();
    const brokenChain = await openStore(freshRoot);
    await expect(
      collect(brokenChain.events(context(), task.task_id)),
    ).rejects.toMatchObject({
      code: "corrupt_record",
    });
    await brokenChain.close();

    const truncatedRoot = makeRoot();
    const truncatedStore = await openStore(truncatedRoot);
    await truncatedStore.create(context(), task);
    await truncatedStore.close();
    const dbPath = path.join(truncatedRoot, "tasks.sqlite");
    for (const suffix of ["-wal", "-shm"]) {
      const sidecarPath = `${dbPath}${suffix}`;
      if (existsSync(sidecarPath)) unlinkSync(sidecarPath);
    }
    const size = lstatSync(dbPath).size;
    truncateSync(dbPath, Math.floor(size / 2));
    let truncationRejected = false;
    try {
      const truncated = await openStore(truncatedRoot);
      await truncated.inspect(context(), task.task_id);
      await truncated.close();
    } catch {
      truncationRejected = true;
    }
    expect(truncationRejected).toBe(true);

    const artifactRoot = makeRoot();
    const artifactStore = await openStore(artifactRoot);
    const ref = await artifactStore.artifacts.put(
      context(),
      new TextEncoder().encode("truncate me"),
      "text/plain",
    );
    await artifactStore.close();
    const pathToArtifact = path.join(
      artifactRoot,
      "artifacts",
      createHashScope(scope),
      ref.sha256.slice(0, 2),
      ref.sha256,
    );
    writeFileSync(pathToArtifact, "bad");
    const opened = await openStore(artifactRoot);
    await expect(opened.artifacts.get(context(), ref)).rejects.toMatchObject({
      code: "corrupt_record",
    });
    await opened.close();
  });

  test("rejects unsafe roots and non-JSON payloads", async () => {
    const parent = makeRoot();
    const foreign = path.join(parent, "foreign");
    const symlinkRoot = path.join(parent, "symlink");
    mkdirSync(foreign);
    writeFileSync(path.join(foreign, "file"), "file");
    await expect(
      createTaskStore({ rootDir: "relative", workspaceRoots: [] }),
    ).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(
      createTaskStore({
        rootDir: process.cwd(),
        workspaceRoots: [process.cwd()],
      }),
    ).rejects.toMatchObject({
      code: "unsafe_path",
    });
    await expect(
      createTaskStore({
        rootDir: path.join(parent, "inside"),
        workspaceRoots: [parent],
      }),
    ).rejects.toMatchObject({ code: "unsafe_path" });
    await expect(
      createTaskStore({
        rootDir: parent,
        workspaceRoots: [path.join(parent, "nested")],
      }),
    ).rejects.toMatchObject({
      code: "unsafe_path",
    });
    await expect(
      createTaskStore({ rootDir: foreign, workspaceRoots: [] }),
    ).rejects.toMatchObject({
      code: "unsafe_path",
    });
    symlinkSync(parent, symlinkRoot, "dir");
    await expect(
      createTaskStore({ rootDir: symlinkRoot, workspaceRoots: [] }),
    ).rejects.toMatchObject({
      code: "unsafe_path",
    });
    const rootDir = makeRoot();
    const store = await openStore(rootDir);
    const task = makeTask();
    await store.create(context(), task);
    await expect(
      store.appendEvent(context(), task.task_id, {
        event_type: "tool.completed",
        run_id: "run",
        producer: "test",
        versions: [{ component: "test", revision: "1" }],
        payload: { unsupported: undefined },
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      store.appendEvent(context("oversize-event"), task.task_id, {
        event_type: "tool.completed",
        run_id: "run",
        producer: "test",
        versions: [{ component: "test", revision: "1" }],
        payload: "x".repeat(1024 * 1024 + 1),
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await store.close();
    const limited = await createTaskStore({
      rootDir: makeRoot(),
      workspaceRoots: [],
      maxArtifactBytes: 1,
    });
    await expect(
      limited.artifacts.put(
        context(),
        new Uint8Array(2),
        "application/octet-stream",
      ),
    ).rejects.toMatchObject({
      code: "invalid_input",
    });
    await limited.close();
  });

  test("binds the upstream journal and validates execution.observed references", async () => {
    const rootDir = makeRoot();
    const store = await openStore(rootDir);
    const task = makeTask();
    await store.create(context(), task);
    const observed = {
      upstream: {
        runtime: "oh-my-pi" as const,
        package_version: "18.14.0",
        session_id: "session-1",
        entry_ids: ["entry-1"],
      },
      kind: "turn",
    };
    const eventInput = {
      event_type: "execution.observed" as const,
      run_id: "run",
      producer: "test",
      versions: [{ component: "test", revision: "1" }],
      payload: observed,
    };
    await expect(
      store.appendEvent(
        context("observed-before-bind"),
        task.task_id,
        eventInput,
      ),
    ).rejects.toMatchObject({
      code: "invalid_input",
    });
    const binding = {
      runtime: "oh-my-pi" as const,
      package_version: "18.14.0",
      session_id: "session-1",
      session_file: path.join(tmpdir(), "session.jsonl"),
    };
    await store.bindUpstreamSession(context("bind"), task.task_id, binding);
    expect(await store.upstreamSession(context(), task.task_id)).toEqual(
      binding,
    );
    await expect(
      store.appendEvent(context("wrong-session"), task.task_id, {
        ...eventInput,
        payload: {
          ...observed,
          upstream: { ...observed.upstream, session_id: "other" },
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      store.appendEvent(context("extra-payload"), task.task_id, {
        ...eventInput,
        payload: { ...observed, messages: ["no journal copies"] },
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await store.appendEvent(context("observed-ok"), task.task_id, eventInput);
    await expect(
      store.appendEvent(context("reserved"), task.task_id, {
        ...eventInput,
        event_type: "task.updated",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await store.close();
  });

  test("recovers dead runners but leaves live runners untouched", async () => {
    const rootDir = makeRoot();
    const store = await openStore(rootDir);
    const deadTask = makeTask("dead");
    const crashedTask = makeTask("crashed");
    const liveTask = makeTask("live");
    await store.create(context("create-dead"), deadTask);
    await store.create(context("create-crashed"), crashedTask);
    await store.create(context("create-live"), liveTask);
    await runWorker("leave-running", rootDir, {
      context: context("child-running"),
      taskId: deadTask.task_id,
    });
    const crashedWorker = spawnWorker("run-and-hang", rootDir, {
      context: context("child-crashed"),
      taskId: crashedTask.task_id,
    });
    const reader = crashedWorker.stdout.getReader();
    const decoder = new TextDecoder();
    let stdout = "";
    let timedOut = false;
    const readyTimeout = setTimeout(() => {
      timedOut = true;
      crashedWorker.kill("SIGKILL");
    }, 10_000);
    try {
      while (!stdout.includes("ready")) {
        const { value, done } = await reader.read();
        if (done) break;
        stdout += decoder.decode(value);
      }
    } finally {
      clearTimeout(readyTimeout);
    }
    if (!timedOut && stdout.includes("ready")) {
      crashedWorker.kill("SIGKILL");
    }
    await crashedWorker.exited;
    expect(stdout).toContain("ready");
    await store.update(context("live-running"), liveTask.task_id, 0, {
      status: "running",
    });
    expect((await store.inspect(context(), deadTask.task_id)).status).toBe(
      "running",
    );
    expect((await store.inspect(context(), crashedTask.task_id)).status).toBe(
      "running",
    );
    const recovered = await store.recoverInterrupted(context("recover"), {
      reason: "worker exited",
    });
    expect(recovered.map((task) => [task.task_id, task.status])).toEqual([
      ["dead", "paused"],
      ["crashed", "paused"],
    ]);
    expect(
      await store.recoverInterrupted(context("recover-again"), {
        reason: "again",
      }),
    ).toEqual([]);
    const events = await collect(store.events(context(), deadTask.task_id));
    const lastEvent = events.at(-1);
    if (!lastEvent) throw new Error("Expected the recovery event");
    const recovery = JSON.parse(
      new TextDecoder().decode(
        await store.artifacts.get(context(), lastEvent.payload),
      ),
    );
    expect(recovery).toMatchObject({
      change: "recovered",
      reason: "worker exited",
      from_revision: 1,
      to_revision: 2,
    });
    expect((await store.inspect(context(), liveTask.task_id)).status).toBe(
      "running",
    );
    await store.close();
  }, 30_000);

  test("replays idempotent operations without duplicate events", async () => {
    const rootDir = makeRoot();
    const store = await openStore(rootDir);
    const task = makeTask();
    const ctx = context("idempotent-create");
    await store.create(ctx, task);
    expect(await store.create(ctx, task)).toEqual(task);
    const updateContext = context("idempotent-update");
    const first = await store.update(updateContext, task.task_id, 0, {
      specialist_revision: "r1",
    });
    expect(
      await store.update(updateContext, task.task_id, 0, {
        specialist_revision: "r1",
      }),
    ).toEqual(first);
    const appendContext = context("idempotent-append");
    const appendInput = {
      event_type: "tool.completed" as const,
      run_id: "run",
      producer: "test",
      versions: [{ component: "test", revision: "1" }],
      payload: { result: "ok" },
    };
    const event = await store.appendEvent(
      appendContext,
      task.task_id,
      appendInput,
    );
    expect(
      await store.appendEvent(appendContext, task.task_id, appendInput),
    ).toEqual(event);
    expect(await collect(store.events(context(), task.task_id))).toHaveLength(
      3,
    );
    const running = await store.update(context("to-running"), task.task_id, 1, {
      status: "running",
    });
    const paused = await store.update(
      context("to-paused"),
      task.task_id,
      running.revision,
      { status: "paused" },
    );
    const resumeContext = context("idempotent-resume");
    const resumed = await store.resume(
      resumeContext,
      task.task_id,
      paused.revision,
    );
    expect(
      await store.resume(resumeContext, task.task_id, paused.revision),
    ).toEqual(resumed);
    await store.close();
  });

  test("keeps lifecycle state unchanged when artifact persistence fails", async () => {
    const rootDir = makeRoot();
    const store = await openStore(rootDir);
    const task = makeTask();
    await store.create(context(), task);
    const beforeEvents = await collect(store.events(context(), task.task_id));
    const tempDir = path.join(rootDir, "tmp");
    chmodSync(tempDir, 0o500);
    try {
      await expect(
        store.update(context("will-fail"), task.task_id, 0, {
          status: "running",
        }),
      ).rejects.toBeDefined();
      await expect(
        store.steer(context("steer-will-fail"), task.task_id, "instruction"),
      ).rejects.toBeDefined();
      await expect(
        store.appendEvent(context("append-will-fail"), task.task_id, {
          event_type: "tool.completed",
          run_id: "run",
          producer: "test",
          versions: [{ component: "test", revision: "1" }],
          payload: { persisted: false },
        }),
      ).rejects.toBeDefined();
    } finally {
      chmodSync(tempDir, 0o700);
    }
    expect(await store.inspect(context(), task.task_id)).toEqual(task);
    expect(await collect(store.events(context(), task.task_id))).toHaveLength(
      beforeEvents.length,
    );
    await store.close();
  });

  test("validates contexts and rejects every operation after close", async () => {
    const rootDir = makeRoot();
    const store = await openStore(rootDir);
    await expect(
      store.list({
        schema_version: 1,
        scope,
        request_id: "",
        extra: true,
      } as never),
    ).rejects.toMatchObject({
      code: "invalid_input",
    });
    await store.close();
    await expect(store.list(context())).rejects.toMatchObject({
      code: "closed",
    });
    await expect(
      store.artifacts.put(context(), new Uint8Array(), "text/plain"),
    ).rejects.toMatchObject({
      code: "closed",
    });
    await expect(
      collect(store.events(context(), "missing")),
    ).rejects.toMatchObject({ code: "closed" });
  });
});

function createHashScope(value: RequestContext["scope"]): string {
  const keys = Object.keys(value).sort();
  const canonical = JSON.stringify(
    Object.fromEntries(
      keys.map((key) => [key, value[key as keyof typeof value]]),
    ),
  );
  return createHash("sha256").update(canonical).digest("hex");
}
