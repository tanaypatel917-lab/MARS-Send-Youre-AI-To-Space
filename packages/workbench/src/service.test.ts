import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "@mars/contracts";
import {
  openRuntimeSession,
  type RuntimeSessionOptions,
} from "@mars/execution";
import { loadModelRegistry } from "@mars/providers";
import { MarsClient } from "../../../apps/vscode/src/client";
import { HttpRpcTransport } from "../../../apps/vscode/src/rpc";
import { createWorkbenchService } from "./service";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const scope = { owner_id: "test-owner", project_id: "test-project" };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function sse(delta: object, reason = "stop") {
  return new Response(
    `data: ${JSON.stringify({ choices: [{ delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }], usage: { prompt_tokens: 50, completion_tokens: 12 } })}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}
async function waitGate(gate: Promise<void>, signal?: AbortSignal | null) {
  let abort = () => {};
  try {
    await Promise.race([
      gate,
      new Promise<void>((_resolve, reject) => {
        abort = () => reject(new DOMException("Cancelled", "AbortError"));
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
async function eventually<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
): Promise<T> {
  const until = Date.now() + 10_000;
  while (true) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() > until)
      throw new Error("Expected service state was not reached");
    await new Promise((yes) => setTimeout(yes, 10));
  }
}
function task(): Task {
  const id = randomUUID();
  return {
    schema_version: 1,
    task_id: id,
    session_id: randomUUID(),
    scope,
    revision: 0,
    request: "Create greet.txt containing Hello.",
    acceptance_criteria: ["Original checkout remains untouched"],
    budget: {
      max_tokens: 24000,
      max_usd: 0,
      max_duration_ms: 60000,
      max_depth: 0,
      max_concurrency: 1,
    },
    status: "pending",
    specialist_revision: null,
    artifacts: [],
  };
}
async function fixture(contextWindow = 32000) {
  const base = await mkdtemp(join(tmpdir(), "mars-service-"));
  cleanup.push(() => rm(base, { recursive: true, force: true }));
  const source = join(base, "source");
  const root = join(base, "state");
  const home = join(base, "home");
  await mkdir(source);
  await writeFile(join(source, "baseline.txt"), "untouched\n");
  await mkdir(join(home, ".mars"), { recursive: true });
  await writeFile(
    join(home, ".mars", "models.json"),
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
          model: "stub",
          capabilities: { tools: true, vision: false, contextWindow },
          pricing: { free: true },
        },
      ],
      routes: { default: ["fixture/free"] },
    }),
  );
  const registry = await loadModelRegistry({
    cwd: source,
    home,
    env: { FIXTURE_KEY: "dummy-not-real" },
  });
  const launches: {
    cwd: string;
    journal: string;
    resumed: string | undefined;
  }[] = [];
  async function start(
    fetch: NonNullable<RuntimeSessionOptions["fetch"]>,
    image?: string,
  ) {
    const service = await createWorkbenchService({
      sourceRoot: source,
      stateRoot: root,
      scope,
      registry,
      port: 0,
      ...(image ? { image } : {}),
      runtimeFactory: async (options) => {
        const session = await openRuntimeSession({ ...options, fetch });
        launches.push({
          cwd: options.cwd,
          journal: session.journalPath,
          resumed: options.sessionFile,
        });
        return session;
      },
    });
    cleanup.push(() => service.close());
    const connection = JSON.parse(
      await readFile(service.connectionFile, "utf8"),
    ) as { token: string; url: string };
    const client = new MarsClient(
      new HttpRpcTransport({
        rpcUrl: `${service.url}/v1/rpc`,
        getToken: async () => connection.token,
      }),
    );
    await client.describe();
    return { service, client, connection };
  }
  return { base, source, root, registry, launches, start };
}

test("HTTP + actual Oh My Pi + real private workspace writes, progress, artifacts, checkpoint and restore (injected model)", async () => {
  const f = await fixture();
  const entered = deferred();
  const proceed = deferred();
  let requests = 0;
  const { client, service } = await f.start(async (_url, init) => {
    requests++;
    if (requests === 1) {
      entered.resolve();
      await waitGate(proceed.promise, init?.signal);
      return sse(
        {
          tool_calls: [
            {
              index: 0,
              id: "write_greeting",
              type: "function",
              function: {
                name: "mars_write",
                arguments: JSON.stringify({
                  path: "greet.txt",
                  content: "Hello",
                }),
              },
            },
          ],
        },
        "tool_calls",
      );
    }
    return sse({
      content: "Created greet.txt; no command execution requested.",
    });
  });
  const created = await client.create(task());
  await expect(
    client.create({ ...task(), request: `Read ${f.root}/sessions/secret` }),
  ).rejects.toThrow();
  expect(
    (
      await client.start(created.task_id, {
        expectedRevision: 0,
        approvals: { read: true, write: true, execute: false },
      })
    ).status,
  ).toBe("running");
  await entered.promise;
  expect((await client.inspect(created.task_id)).status).toBe("running");
  const baseline = await client.checkpoint(created.task_id);
  proceed.resolve();
  const completed = await eventually(
    () => client.inspect(created.task_id),
    (value) => value.status !== "running",
  );
  expect(completed.status).toBe("completed");
  expect(requests).toBe(2);
  const launch = f.launches[0];
  if (!launch) throw new Error("Missing launch");
  expect(launch.cwd.startsWith(f.root)).toBe(true);
  expect(await readFile(join(launch.cwd, "greet.txt"), "utf8")).toBe("Hello");
  expect(await readFile(join(f.source, "baseline.txt"), "utf8")).toBe(
    "untouched\n",
  );
  await expect(stat(join(f.source, "greet.txt"))).rejects.toThrow();
  expect((await stat(service.connectionFile)).mode & 0o077).toBe(0);
  expect((await stat(f.root)).mode & 0o077).toBe(0);
  const diff = await client.diff(created.task_id);
  expect(diff.files).toContainEqual(
    expect.objectContaining({ path: "greet.txt", status: "added" }),
  );
  const events = await client.events(created.task_id, undefined);
  const usageEvents = events.filter((event) => event.usage);
  expect(usageEvents).toHaveLength(1);
  expect(usageEvents[0]?.usage?.input_tokens).toBeGreaterThan(0);
  expect(usageEvents[0]?.usage?.output_tokens).toBeGreaterThan(0);
  expect(usageEvents[0]?.usage?.cost_usd).toBe(0);
  expect(
    events.some((event) => event.event_type === "execution.observed"),
  ).toBe(true);
  for (const ref of [
    ...completed.artifacts,
    ...events.map((event) => event.payload),
  ]) {
    const artifact = await client.artifact(created.task_id, ref);
    const text = new TextDecoder().decode(artifact.bytes);
    expect(text).not.toContain(f.root);
    expect(text).not.toContain(launch.cwd);
    expect(text).not.toContain(launch.journal);
    expect(text).not.toContain("dummy-not-real");
  }
  const latest = await client.checkpoint(created.task_id);
  const restored = await eventually(
    async () => {
      try {
        return await client.restore(
          created.task_id,
          baseline,
          latest.workspace.revision,
        );
      } catch (error) {
        if ((error as { code?: string }).code === "conflict") return null;
        throw error;
      }
    },
    (value) => value !== null,
  );
  expect(restored?.workspace_id).toBe(baseline.workspace.workspace_id);
  expect((await client.diff(created.task_id)).files).toEqual([]);
  await expect(stat(join(launch.cwd, "greet.txt"))).rejects.toThrow();
}, 30_000);

test("HTTP shutdown/restart resumes the actual SDK journal and exact workspace; cancel aborts without another model request", async () => {
  const f = await fixture();
  const entered = deferred();
  const never = deferred();
  const first = await f.start(async (_url, init) => {
    entered.resolve();
    await waitGate(never.promise, init?.signal);
    return sse({ content: "unreachable" });
  });
  const created = await first.client.create(task());
  await first.client.start(created.task_id, {
    expectedRevision: 0,
    approvals: { read: true, write: true, execute: false },
  });
  await entered.promise;
  await first.service.close();
  let requests = 0;
  let stall = false;
  const cancelEntered = deferred();
  const second = await f.start(async (_url, init) => {
    requests++;
    if (stall) {
      cancelEntered.resolve();
      await waitGate(never.promise, init?.signal);
    }
    return sse({ content: "Resumed the existing task." });
  });
  expect(second.connection.token === first.connection.token).toBe(false);
  const paused = await second.client.inspect(created.task_id);
  expect(paused.status).toBe("paused");
  await second.client.resume(created.task_id, paused.revision);
  expect(
    (
      await eventually(
        () => second.client.inspect(created.task_id),
        (value) => value.status !== "running",
      )
    ).status,
  ).toBe("completed");
  expect(f.launches[1]?.resumed).toBe(f.launches[0]?.journal);
  expect(f.launches[1]?.cwd).toBe(f.launches[0]?.cwd);
  const oldToken = await fetch(`${second.service.url}/v1/rpc`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${first.connection.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ method: "workbench.describe", params: {} }),
  });
  expect(oldToken.status).toBe(401);
  stall = true;
  const cancelled = await second.client.create(task());
  await second.client.start(cancelled.task_id, {
    expectedRevision: 0,
    approvals: { read: false, write: false, execute: false },
  });
  await cancelEntered.promise;
  await second.client.steer(cancelled.task_id, "Stop after the current action");
  await second.client.cancel(cancelled.task_id);
  expect((await second.client.inspect(cancelled.task_id)).status).toBe(
    "cancelled",
  );
  expect(requests).toBe(2);
}, 30_000);

test("HTTP + actual SDK resumes an overflowing steering queue in bounded batches across restart", async () => {
  const f = await fixture(512 * 1024);
  const entered = deferred();
  const never = deferred();
  const first = await f.start(async (_url, init) => {
    entered.resolve();
    await waitGate(never.promise, init?.signal);
    return sse({ content: "unreachable" });
  });
  const request = task();
  request.budget.max_tokens = 512 * 1024;
  const created = await first.client.create(request);
  await first.client.start(created.task_id, {
    expectedRevision: created.revision,
    approvals: { read: true, write: false, execute: false },
  });
  await entered.promise;
  await first.service.close();
  const batches: string[] = [];
  const respond: NonNullable<RuntimeSessionOptions["fetch"]> = async (
    _url,
    init,
  ) => {
    const body = JSON.parse(String(init?.body));
    const users = body.messages.filter(
      (message: { role: string }) => message.role === "user",
    );
    expect(JSON.stringify(users).includes(request.request)).toBe(true);
    batches.push(JSON.stringify(users.at(-1).content));
    return sse({ content: "Processed the supplied steering batch." });
  };
  const second = await f.start(respond);
  const instructions = Array.from({ length: 8 }, (_, index) =>
    `instruction-${index}:`.padEnd(16 * 1024, "x"),
  );
  for (const instruction of instructions)
    await second.client.steer(created.task_id, instruction);
  await second.client.resume(
    created.task_id,
    (await second.client.inspect(created.task_id)).revision,
  );
  const paused = await eventually(
    () => second.client.inspect(created.task_id),
    (value) => value.status !== "running",
  );
  expect(paused.status).toBe("paused");
  expect(batches).toHaveLength(1);
  for (const instruction of instructions.slice(0, 7))
    expect(batches[0]?.includes(instruction)).toBe(true);
  expect(batches[0]?.includes(instructions[7] ?? "")).toBe(false);
  await second.service.close();
  const third = await f.start(respond);
  await third.client.resume(
    created.task_id,
    (await third.client.inspect(created.task_id)).revision,
  );
  const completed = await eventually(
    () => third.client.inspect(created.task_id),
    (value) => value.status !== "running",
  );
  expect(completed.status).toBe("completed");
  expect(batches).toHaveLength(2);
  expect(batches[1]?.includes(instructions[7] ?? "")).toBe(true);
  for (const instruction of instructions.slice(0, 7))
    expect(batches[1]?.includes(instruction)).toBe(false);
  expect(f.launches.map((launch) => launch.journal)).toEqual(
    Array(3).fill(f.launches[0]?.journal),
  );
  expect(f.launches.map((launch) => launch.cwd)).toEqual(
    Array(3).fill(f.launches[0]?.cwd),
  );
  expect(await readFile(join(f.source, "baseline.txt"), "utf8")).toBe(
    "untouched\n",
  );
}, 30_000);

test("service refuses overlapping state/source roots and never advertises unsandboxed execution", async () => {
  const f = await fixture();
  await expect(
    createWorkbenchService({
      sourceRoot: f.source,
      stateRoot: join(f.source, "private"),
      scope,
      registry: f.registry,
      port: 0,
    }),
  ).rejects.toThrow();
  await expect(stat(join(f.source, "private"))).rejects.toThrow();
  const { client } = await f.start(async () => {
    throw new Error("No model call allowed");
  });
  expect(client.server?.capabilities.execute).toBe(false);
  const created = await client.create(task());
  await expect(
    client.start(created.task_id, {
      expectedRevision: 0,
      approvals: { read: true, write: true, execute: true },
    }),
  ).rejects.toMatchObject({ code: "forbidden" });
  expect((await client.inspect(created.task_id)).status).toBe("pending");
});

test.skipIf(process.env.MARS_WORKSPACES_DOCKER_TEST !== "1")(
  "HTTP + actual Oh My Pi runs an approved verification command in real Docker (injected model)",
  async () => {
    const f = await fixture();
    let requests = 0;
    let verified = false;
    const image =
      process.env.MARS_WORKSPACES_TEST_IMAGE ??
      "mirror.gcr.io/library/busybox@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec";
    const { client } = await f.start(async (_url, init) => {
      requests++;
      if (requests < 3)
        return sse(
          {
            tool_calls: [
              {
                index: 0,
                id: `call-${requests}`,
                type: "function",
                function:
                  requests === 1
                    ? {
                        name: "mars_write",
                        arguments: JSON.stringify({
                          path: "greet.txt",
                          content: "Hello",
                        }),
                      }
                    : {
                        name: "mars_execute",
                        arguments: JSON.stringify({
                          argv: [
                            "sh",
                            "-c",
                            'test "$(cat greet.txt)" = Hello && test "$(id -u)" != 0 && printf \'verified-within-container\\n\'',
                          ],
                        }),
                      },
              },
            ],
          },
          "tool_calls",
        );
      const request = JSON.parse(String(init?.body)) as {
        messages: { role: string; content: string }[];
      };
      const result = JSON.parse(
        request.messages.findLast((message) => message.role === "tool")
          ?.content ?? "{}",
      );
      expect(result.exit_code).toBe(0);
      expect(result.stdout).toBe("verified-within-container\n");
      expect(result.stderr).toBe("");
      verified = true;
      return sse({
        content: "Created and verified greet.txt within the approved sandbox.",
      });
    }, image);
    expect((await client.describe()).capabilities.execute).toBe(true);
    const created = await client.create(task());
    await client.start(created.task_id, {
      expectedRevision: created.revision,
      approvals: { read: true, write: true, execute: true },
    });
    await eventually(
      () => client.inspect(created.task_id),
      (current) => current.status === "completed",
    );
    expect(verified).toBe(true);
    expect(requests).toBe(3);
    expect(
      await readFile(join(f.launches[0]?.cwd ?? "", "greet.txt"), "utf8"),
    ).toBe("Hello");
    expect(await readFile(join(f.source, "baseline.txt"), "utf8")).toBe(
      "untouched\n",
    );
    expect(await Bun.file(join(f.source, "greet.txt")).exists()).toBe(false);
  },
  30000,
);
