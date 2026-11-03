import { expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "@mars/contracts";
import { loadModelRegistry, ModelRouter } from "@mars/providers";
import type { Model } from "@oh-my-pi/pi-ai";
import { AgentSession, SessionManager } from "@oh-my-pi/pi-coding-agent";
import {
  type BudgetLedger,
  createModelBridge,
  selectExecutionModel,
  toChatRequest,
} from "./model-bridge";
import {
  boundPatchSummary,
  MAX_SYSTEM_PROMPT_CHARS,
  openRuntimeSession,
  type RuntimeSession,
  type RuntimeTools,
} from "./runtime";

function sse(delta: Record<string, unknown>, reason = "stop") {
  return new Response(
    [
      `data: ${JSON.stringify({ choices: [{ delta, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }], usage: { prompt_tokens: 50, completion_tokens: 12 } })}\n\n`,
      "data: [DONE]\n\n",
    ].join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

async function fixture(contextWindow = 32000) {
  const root = await mkdtemp(join(tmpdir(), "mars-runtime-test-"));
  const cwd = join(root, "workspace");
  const home = join(root, "home");
  await mkdir(cwd);
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
          apiKeyEnv: "MARS_FIXTURE_KEY",
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
        {
          id: "fixture/paid",
          providerId: "fixture",
          model: "stub",
          capabilities: { tools: true, vision: false, contextWindow },
          pricing: { free: false, inputPerMTokUsd: 1, outputPerMTokUsd: 2 },
        },
        {
          id: "fixture/unknown",
          providerId: "fixture",
          model: "stub",
          capabilities: { tools: true, vision: false, contextWindow },
          pricing: { free: false },
        },
      ],
      routes: { default: ["fixture/paid", "fixture/free"] },
      policy: { allowPaid: true },
    }),
  );
  const env = { MARS_FIXTURE_KEY: "dummy-key-not-real" };
  const registry = await loadModelRegistry({ cwd, home, env });
  const task: Task = {
    schema_version: 1,
    task_id: randomUUID(),
    session_id: randomUUID(),
    scope: {
      owner_id: "fixture",
      project_id: "fixture",
      workspace_id: "fixture",
    },
    revision: 0,
    request: "Create a greeting file.",
    acceptance_criteria: ["File contains Hello"],
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
  const tools: RuntimeTools = {
    read: (path) => readFile(join(cwd, path)),
    write: (path, content) => writeFile(join(cwd, path), content),
    execute: async () => {
      throw new Error("No execution sandbox in this unit fixture.");
    },
    stop: async () => undefined,
  };
  const sessions: RuntimeSession[] = [];
  return {
    root,
    cwd,
    env,
    registry,
    task,
    tools,
    stateDir: join(root, "state"),
    async open(extra: Partial<Parameters<typeof openRuntimeSession>[0]> = {}) {
      const session = await openRuntimeSession({
        task,
        cwd,
        stateDir: join(root, "state"),
        registry,
        tools,
        env,
        approvals: { read: true, write: true, execute: false },
        ...extra,
      });
      sessions.push(session);
      return session;
    },
    async cleanup() {
      for (const session of sessions) await session.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("execution chooses free models automatically and rejects unpriced paid models", async () => {
  const f = await fixture();
  try {
    expect(selectExecutionModel(f.registry).id).toBe("fixture/free");
    expect(selectExecutionModel(f.registry, "fixture/paid").id).toBe(
      "fixture/paid",
    );
    expect(() => selectExecutionModel(f.registry, "fixture/unknown")).toThrow(
      "No eligible",
    );
  } finally {
    await f.cleanup();
  }
});

test("bridge preserves tool call identities and tool results without inventing another agent loop", () => {
  const request = toChatRequest({
    systemPrompt: ["System"],
    messages: [
      { role: "user", content: "Read file", timestamp: 1 },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call",
            name: "mars_read",
            arguments: { path: "a.txt" },
          },
        ],
        api: "fixture",
        provider: "fixture",
        model: "stub",
        timestamp: 2,
        stopReason: "toolUse",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
      {
        role: "toolResult",
        toolCallId: "call",
        toolName: "mars_read",
        content: [{ type: "text", text: "file contents" }],
        isError: false,
        timestamp: 3,
      },
    ],
  });
  expect(request.messages[2]).toMatchObject({
    role: "assistant",
    tool_calls: [{ id: "call", name: "mars_read" }],
  });
  expect(request.messages[3]).toEqual({
    role: "tool",
    tool_call_id: "call",
    content: "file contents",
  });
  expect(() =>
    toChatRequest({
      messages: [
        {
          role: "user",
          content: [{ type: "image", data: "fake", mimeType: "image/png" }],
          timestamp: 1,
        },
      ],
    }),
  ).toThrow("only supports text");
});

test("mars_proposals is a read-only host-bound tool rendering untrusted proposal text", async () => {
  const f = await fixture();
  const requests: Record<string, unknown>[] = [];
  let summaries = 0;
  try {
    const session = await f.open({
      proposals: {
        async summary() {
          summaries += 1;
          return "[untrusted optimization candidate c1 · proposed · promotion none_automatic]";
        },
      },
      fetch: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return requests.length === 1
          ? sse(
              {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_proposals",
                    type: "function",
                    function: { name: "mars_proposals", arguments: "{}" },
                  },
                ],
              },
              "tool_calls",
            )
          : sse({ content: "One proposed candidate; nothing promoted." });
      },
    });
    const outcome = await session.run(f.task.request);
    expect(outcome.status).toBe("completed");
    expect(summaries).toBe(1);
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[0])).toContain("mars_proposals");
    expect(JSON.stringify(requests[1])).toContain(
      "untrusted optimization candidate c1",
    );
  } finally {
    await f.cleanup();
  }
});

test("mars_proposals is absent without read approval or a proposals source", async () => {
  const f = await fixture();
  const requests: Record<string, unknown>[] = [];
  try {
    const reply = async (_url: string, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      return sse({ content: "Done." });
    };
    const plain = await f.open({ fetch: reply });
    await plain.run(f.task.request);
    const noRead = await f.open({
      approvals: { read: false, write: true, execute: false },
      proposals: { summary: async () => "unused" },
      fetch: reply,
    });
    await noRead.run(f.task.request);
    expect(requests).toHaveLength(2);
    for (const request of requests)
      expect(JSON.stringify(request)).not.toContain("mars_proposals");
  } finally {
    await f.cleanup();
  }
});

test("actual Oh My Pi owns a two-turn write-tool session through the existing provider adapter", async () => {
  const f = await fixture();
  const requests: Record<string, unknown>[] = [];
  const observations: string[] = [];
  try {
    const session = await f.open({
      onEvent: async (event) => {
        observations.push(event.type);
      },
      fetch: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return requests.length === 1
          ? sse(
              {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_write",
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
            )
          : sse({ content: "Created greet.txt. No tests were run." });
      },
    });
    const outcome = await session.run(f.task.request);
    expect(outcome.status).toBe("completed");
    expect(outcome.content).toBe("Created greet.txt. No tests were run.");
    expect(await readFile(join(f.cwd, "greet.txt"), "utf8")).toBe("Hello");
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1])).toContain("call_write");
    expect(JSON.stringify(requests[0])).not.toContain("mars_execute");
    expect(observations).toContain("tool_execution_end");
    expect(outcome.usage.reserved_tokens).toBeGreaterThan(0);
    expect(outcome.usage.input_tokens).toBe(100);
    const journal = await readFile(session.journalPath, "utf8");
    const frozenJournal = session.journalSnapshot();
    expect(frozenJournal.session_id).toBe(session.sessionId);
    const identities = (records: unknown[]) =>
      records.map((record) => {
        const entry = record as { type: string; id?: string };
        return { type: entry.type, id: entry.id };
      });
    expect(identities(frozenJournal.entries)).toEqual(
      identities(
        journal
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
          .filter((entry) => entry.type !== "title"),
      ),
    );
    frozenJournal.entries.length = 0;
    expect(session.journalSnapshot().entries.length).toBeGreaterThan(0);
    expect(journal).toContain("mars.binding");
    expect(journal).toContain("mars.budget");
    expect(journal).toContain("call_write");
    expect(journal).not.toContain("dummy-key-not-real");
  } finally {
    await f.cleanup();
  }
}, 30000);

test("a stopped SDK session reopens its original journal and retains budget and conversation", async () => {
  const f = await fixture();
  let requests = 0;
  try {
    const first = await f.open({
      fetch: async () => {
        requests++;
        return sse({ content: "First turn" });
      },
    });
    const result = await first.run("First instruction");
    expect(result.status).toBe("completed");
    const file = first.journalPath;
    await first.dispose();
    const second = await f.open({
      sessionFile: file,
      fetch: async (_url, init) => {
        requests++;
        const body = String(init?.body);
        expect(body).toContain("First instruction");
        expect(body).toContain("First turn");
        return sse({ content: "Resumed turn" });
      },
    });
    expect(second.sessionId).toBe(first.sessionId);
    const resumed = await second.run(
      "Continue from the persisted conversation",
    );
    expect(resumed.status).toBe("completed");
    expect(resumed.usage.reserved_tokens).toBeGreaterThan(
      result.usage.reserved_tokens,
    );
    expect(resumed.usage.deadline).toBe(result.usage.deadline);
    expect(requests).toBe(2);
    await second.dispose();
    await expect(
      f.open({
        task: { ...f.task, task_id: "another-task" },
        sessionFile: file,
      }),
    ).rejects.toThrow("binding");
  } finally {
    await f.cleanup();
  }
}, 30000);

test("truncated streams cannot complete successfully or execute partial tool calls", async () => {
  const f = await fixture();
  let writes = 0;
  try {
    const session = await f.open({
      tools: {
        ...f.tools,
        write: async () => {
          writes++;
        },
      },
      fetch: async () =>
        new Response(
          `data: ${JSON.stringify({ choices: [{ delta: { content: "Partial" } }] })}\n\n`,
        ),
    });
    const outcome = await session.run("Fail safely");
    expect(outcome.status).toBe("failed");
    expect(writes).toBe(0);
  } finally {
    await f.cleanup();
  }
}, 30000);

test("cancellation aborts the provider request, stops workspace execution and forbids further dispatch", async () => {
  const f = await fixture();
  let stops = 0;
  let entered: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  try {
    const session = await f.open({
      tools: {
        ...f.tools,
        stop: async () => {
          stops++;
        },
      },
      fetch: async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          entered?.();
          const abort = () =>
            reject(new DOMException("Cancelled", "AbortError"));
          if (init?.signal?.aborted) abort();
          else init?.signal?.addEventListener("abort", abort, { once: true });
        }),
    });
    const running = session.run("Wait until cancelled");
    await started;
    await session.cancel();
    expect((await running).status).toBe("cancelled");
    expect(stops).toBeGreaterThan(0);
    await expect(session.run("Do not dispatch")).rejects.toThrow("stopped");
  } finally {
    await f.cleanup();
  }
}, 30000);

test("pre-dispatch reservation and persistence failure fail closed without provider calls", async () => {
  const f = await fixture();
  let calls = 0;
  const selected = selectExecutionModel(f.registry);
  const ledger: BudgetLedger = {
    deadline: Date.now() + 60000,
    reserved_tokens: 0,
    reserved_usd: 0,
    input_tokens: 0,
    output_tokens: 0,
  };
  const model = { api: "fixture", provider: "fixture", id: "stub" } as Model;
  try {
    const exhausted = createModelBridge({
      registry: f.registry,
      selected,
      budget: { ...f.task.budget, max_tokens: 1 },
      ledger,
      signal: new AbortController().signal,
      persistLedger: async () => undefined,
      fetch: async () => {
        calls++;
        return sse({ content: "Should not run" });
      },
      env: f.env,
    });
    expect(
      (
        await exhausted(model, {
          messages: [{ role: "user", content: "Hello", timestamp: 1 }],
        }).result()
      ).stopReason,
    ).toBe("error");
    const failedPersistence = createModelBridge({
      registry: f.registry,
      selected,
      budget: f.task.budget,
      ledger,
      signal: new AbortController().signal,
      persistLedger: async () => {
        throw new Error("Disk full");
      },
      fetch: async () => {
        calls++;
        return sse({ content: "Should not run" });
      },
      env: f.env,
    });
    expect(
      (
        await failedPersistence(model, {
          messages: [{ role: "user", content: "Hello", timestamp: 1 }],
        }).result()
      ).stopReason,
    ).toBe("error");
    expect(calls).toBe(0);
  } finally {
    await f.cleanup();
  }
});

test("runtime dispatch inherits registry credentials when env is omitted, for both stream and complete", async () => {
  const f = await fixture();
  let session: RuntimeSession | undefined;
  let calls = 0;
  const fetchFixture = async (_url: string, init?: RequestInit) => {
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer dummy-key-not-real",
    );
    calls++;
    const body = JSON.parse(String(init?.body)) as { stream?: boolean };
    return body.stream
      ? sse({ content: "Configured credentials reached the adapter" })
      : Response.json({
          choices: [{ message: { role: "assistant", content: "Complete" } }],
        });
  };
  try {
    session = await openRuntimeSession({
      task: f.task,
      cwd: f.cwd,
      stateDir: f.stateDir,
      registry: f.registry,
      tools: f.tools,
      approvals: { read: false, write: false, execute: false },
      fetch: fetchFixture,
    });
    expect(
      (await session.run("Use configured provider credentials")).status,
    ).toBe("completed");
    const router = new ModelRouter(f.registry, {
      adapterOptions: { fetch: fetchFixture },
    });
    expect(
      (
        await router.complete(
          { messages: [{ role: "user", content: "Hello" }] },
          { model: "fixture/free" },
        )
      ).content,
    ).toBe("Complete");
    expect(calls).toBe(2);
    expect(Object.keys(f.registry.getProviderEnvironment("fixture"))).toEqual([
      "MARS_FIXTURE_KEY",
    ]);
    expect(f.registry.getProviderEnvironment("unknown")).toEqual({});
  } finally {
    await session?.dispose();
    await f.cleanup();
  }
}, 30000);

test("cancellation flushes its journal even when workspace stop rejects", async () => {
  const f = await fixture();
  let entered: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let flush: ReturnType<typeof spyOn> | undefined;
  try {
    const session = await f.open({
      tools: {
        ...f.tools,
        stop: async () => {
          throw new Error("Untrusted stop detail");
        },
      },
      fetch: async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          entered?.();
          const abort = () =>
            reject(new DOMException("Cancelled", "AbortError"));
          if (init?.signal?.aborted) abort();
          else init?.signal?.addEventListener("abort", abort, { once: true });
        }),
    });
    const running = session.run("Cancel despite workspace failure");
    await started;
    flush = spyOn(AgentSession.prototype, "flushToDisk");
    await expect(session.cancel()).rejects.toThrow(
      "Runtime cancellation encountered a cleanup failure.",
    );
    expect(flush).toHaveBeenCalled();
    expect((await running).status).toBe("cancelled");
    expect(await readFile(session.journalPath, "utf8")).toContain(
      '"stopReason":"aborted"',
    );
    await expect(session.dispose()).rejects.toThrow(
      "Runtime disposal encountered a cleanup failure.",
    );
  } finally {
    flush?.mockRestore();
    await f.cleanup();
  }
}, 30000);

test("disposal closes the SDK journal even when workspace stop rejects", async () => {
  const f = await fixture();
  let dispose: ReturnType<typeof spyOn> | undefined;
  let close: ReturnType<typeof spyOn> | undefined;
  try {
    dispose = spyOn(AgentSession.prototype, "dispose");
    const session = await f.open({
      tools: {
        ...f.tools,
        stop: async () => {
          throw new Error("Stop failed");
        },
      },
      fetch: async () => sse({ content: "Durable final response" }),
    });
    await session.run("Complete before disposal");
    close = spyOn(SessionManager.prototype, "close");
    await expect(session.dispose()).rejects.toThrow(
      "Runtime disposal encountered a cleanup failure.",
    );
    expect(dispose).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
    expect(await readFile(session.journalPath, "utf8")).toContain(
      "Durable final response",
    );
    await session.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  } finally {
    dispose?.mockRestore();
    close?.mockRestore();
    await f.cleanup();
  }
}, 30000);

for (const damage of ["missing", "invalid"] as const) {
  test(`resuming a journal with ${damage} budget fails closed and closes the reopened manager`, async () => {
    const f = await fixture();
    let close: ReturnType<typeof spyOn> | undefined;
    let calls = 0;
    try {
      const first = await f.open({
        fetch: async () => sse({ content: "Original budget" }),
      });
      await first.run("Persist original budget");
      await first.dispose();
      const entries = (await readFile(first.journalPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const damaged =
        damage === "missing"
          ? entries.filter((entry) => entry.customType !== "mars.budget")
          : entries.map((entry) =>
              entry.customType === "mars.budget"
                ? { ...entry, data: { deadline: "invalid" } }
                : entry,
            );
      await writeFile(
        first.journalPath,
        `${damaged.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      );
      close = spyOn(SessionManager.prototype, "close");
      await expect(
        f.open({
          sessionFile: first.journalPath,
          fetch: async () => {
            calls++;
            return sse({ content: "Never dispatch" });
          },
        }),
      ).rejects.toThrow();
      expect(close).toHaveBeenCalledTimes(1);
      expect(calls).toBe(0);
    } finally {
      close?.mockRestore();
      await f.cleanup();
    }
  }, 30000);
}

test("systemPromptOverride replaces the fixed prompt only when supplied", async () => {
  const f = await fixture();
  const requests: Record<string, unknown>[] = [];
  const systemMessage = (request: Record<string, unknown> | undefined) => {
    const messages = request?.messages as
      | { role: string; content: unknown }[]
      | undefined;
    return messages?.find((message) => message.role === "system")?.content;
  };
  try {
    const fetch = async (_url: string, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      return sse({ content: "Done. No tests were run." });
    };
    const defaultSession = await f.open({ fetch });
    await defaultSession.run(f.task.request);
    expect(String(systemMessage(requests[0]))).toContain(
      "You are MARS, a coding assistant.",
    );

    const overridden = await f.open({
      fetch,
      systemPromptOverride:
        "  You are candidate prompt 7. Verify before claiming. ",
    });
    await overridden.run(f.task.request);
    expect(String(systemMessage(requests[1]))).toContain(
      "You are candidate prompt 7.",
    );
    expect(String(systemMessage(requests[1]))).not.toContain(
      "You are MARS, a coding assistant.",
    );

    await expect(
      f.open({ fetch, systemPromptOverride: "   " }),
    ).rejects.toThrow("System prompt override is empty.");
    await expect(
      f.open({
        fetch,
        systemPromptOverride: "x".repeat(MAX_SYSTEM_PROMPT_CHARS + 1),
      }),
    ).rejects.toThrow("exceeds the size limit");
  } finally {
    await f.cleanup();
  }
}, 30000);

test("mars_apply_patch is a host-bound tool: Oh My Pi passes the patch text to the host applier and relays its summary", async () => {
  const f = await fixture();
  const requests: Record<string, unknown>[] = [];
  const patches: string[] = [];
  const patchText =
    "*** Begin Patch\n*** Add File: greet.txt\n+Hello\n*** End Patch";
  try {
    const session = await f.open({
      patch: {
        async apply(patch) {
          patches.push(patch);
          await writeFile(join(f.cwd, "greet.txt"), "Hello\n");
          return "Success. Updated the following files:\nA greet.txt";
        },
      },
      fetch: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return requests.length === 1
          ? sse(
              {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_patch",
                    type: "function",
                    function: {
                      name: "mars_apply_patch",
                      arguments: JSON.stringify({ patch: patchText }),
                    },
                  },
                ],
              },
              "tool_calls",
            )
          : sse({ content: "Applied the patch." });
      },
    });
    const outcome = await session.run(f.task.request);
    expect(outcome.status).toBe("completed");
    expect(patches).toEqual([patchText]);
    expect(await readFile(join(f.cwd, "greet.txt"), "utf8")).toBe("Hello\n");
    expect(JSON.stringify(requests[0])).toContain("mars_apply_patch");
    expect(JSON.stringify(requests[1])).toContain(
      "Success. Updated the following files:",
    );
  } finally {
    await f.cleanup();
  }
}, 30000);

test("boundPatchSummary keeps the whole result within the byte limit at a character boundary", () => {
  const bytesOf = (text: string) => new TextEncoder().encode(text).byteLength;
  expect(boundPatchSummary("short", 64)).toBe("short");
  const ascii = "A path/to/file.txt\n".repeat(10_000);
  const boundedAscii = boundPatchSummary(ascii, 1_000);
  expect(bytesOf(boundedAscii)).toBeLessThanOrEqual(1_000);
  expect(boundedAscii).toMatch(
    /\n\[summary truncated: \d+ more bytes omitted\]$/,
  );
  expect(
    ascii.startsWith(boundedAscii.split("\n[summary truncated")[0] ?? ""),
  ).toBe(true);
  const multibyte = "A ééé/日本語/🙂.txt\n".repeat(2_000);
  for (const limit of [1_000, 1_001, 1_002, 1_003, 4_096]) {
    const bounded = boundPatchSummary(multibyte, limit);
    expect(bytesOf(bounded)).toBeLessThanOrEqual(limit);
    expect(bounded).not.toContain("\uFFFD");
    expect(
      multibyte.startsWith(bounded.split("\n[summary truncated")[0] ?? ""),
    ).toBe(true);
  }
  expect(bytesOf(boundPatchSummary(multibyte))).toBeLessThanOrEqual(128 * 1024);
  for (const limit of [0, 1, 2, 3, 4, 10, 40]) {
    const bounded = boundPatchSummary(multibyte, limit);
    expect(bytesOf(bounded)).toBeLessThanOrEqual(limit);
    expect(bounded).not.toContain("\uFFFD");
    expect(multibyte.startsWith(bounded)).toBe(true);
  }
});

test("mars_apply_patch keeps a persisted patch successful when its summary exceeds the output limit", async () => {
  const f = await fixture(1_000_000);
  const requests: Record<string, unknown>[] = [];
  const summary = `Success. Updated the following files:\n${"A a/very/long/path/to/a/generated/file.txt\n".repeat(4_000)}`;
  expect(summary.length).toBeGreaterThan(128 * 1024);
  try {
    const session = await f.open({
      task: { ...f.task, budget: { ...f.task.budget, max_tokens: 400_000 } },
      patch: { apply: async () => summary },
      fetch: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return requests.length === 1
          ? sse(
              {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_patch",
                    type: "function",
                    function: {
                      name: "mars_apply_patch",
                      arguments: JSON.stringify({
                        patch:
                          "*** Begin Patch\n*** Add File: a.txt\n+a\n*** End Patch",
                      }),
                    },
                  },
                ],
              },
              "tool_calls",
            )
          : sse({ content: "Applied." });
      },
    });
    const outcome = await session.run(f.task.request);
    expect(outcome.status).toBe("completed");
    const relayed = JSON.stringify(requests[1]);
    expect(relayed).toContain("Success. Updated the following files:");
    expect(relayed).toContain("[summary truncated:");
    expect(relayed).not.toContain("exceeds tool output limit");
    const relayedTool = (
      requests[1]?.messages as Array<{ role: string; content: string }>
    ).find((m) => m.role === "tool");
    expect(
      new TextEncoder().encode(relayedTool?.content ?? "").byteLength,
    ).toBeLessThanOrEqual(128 * 1024);
  } finally {
    await f.cleanup();
  }
}, 30000);

test("mars_apply_patch is not declared without write approval or without a host applier", async () => {
  const f = await fixture();
  const requests: Record<string, unknown>[] = [];
  try {
    const respond = async (_url: string, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      return sse({ content: "Nothing to do." });
    };
    const readOnly = await f.open({
      approvals: { read: true, write: false, execute: false },
      patch: { apply: async () => "unreachable" },
      fetch: respond,
    });
    await readOnly.run(f.task.request);
    const noApplier = await f.open({ fetch: respond });
    await noApplier.run(f.task.request);
    expect(requests).toHaveLength(2);
    for (const request of requests)
      expect(JSON.stringify(request)).not.toContain("mars_apply_patch");
  } finally {
    await f.cleanup();
  }
}, 30000);
