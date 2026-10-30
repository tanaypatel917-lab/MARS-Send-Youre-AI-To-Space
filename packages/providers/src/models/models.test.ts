import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ChatRequest,
  type ModelConfig,
  ModelConfigSchema,
  type ProviderConfig,
  ProviderConfigSchema,
  type StreamEvent,
} from "@mars/contracts";
import { createAnthropicAdapter } from "./anthropic";
import { discoverModels } from "./discovery";
import { ProviderError } from "./errors";
import { createOpenAICompatibleAdapter } from "./openai-compatible";
import { loadModelRegistry } from "./registry";
import { ModelRouter } from "./router";

const request: ChatRequest = {
  messages: [{ role: "user", content: "Hello" }],
};

function model(
  id: string,
  providerId: string,
  overrides: Partial<ModelConfig> = {},
): ModelConfig {
  return {
    id,
    providerId,
    model: id,
    capabilities: { tools: true, vision: false, contextWindow: 8192 },
    pricing: { free: true },
    ...overrides,
  };
}

function provider(
  id: string,
  baseUrl: string,
  overrides: Partial<ProviderConfig> = {},
): ProviderConfig {
  return {
    id,
    kind: "openai-compatible",
    baseUrl,
    ...overrides,
  };
}

async function serve(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "mars-models-"));
}

async function registryFor(
  root: string,
  providers: ProviderConfig[],
  models: ModelConfig[],
  route: string[],
  extra: Record<string, unknown> = {},
  env: Record<string, string | undefined> = {},
) {
  const marsHome = join(root, "mars-home");
  const cwd = join(root, "project");
  await mkdir(marsHome, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(
    join(marsHome, "models.json"),
    JSON.stringify({
      version: 1,
      providers,
      models,
      routes: { default: route },
      policy: { allowPaid: false },
      ...extra,
    }),
  );
  return loadModelRegistry({
    cwd,
    home: root,
    env: { ...env, MARS_HOME: marsHome },
  });
}

function jsonResponse(
  response: ServerResponse,
  body: unknown,
  status = 200,
): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function rejectedValue<T>(promise: Promise<T>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected promise to reject.");
}

function expectSanitizedProviderError(error: unknown): void {
  expect(error).toBeInstanceOf(ProviderError);
  const diagnostics = `${String(error)} ${JSON.stringify(error)}`;
  expect(diagnostics).not.toContain("secret-echo");
  expect(diagnostics).not.toContain("dummy-secret-123");
}

test("provider configuration rejects literal API keys with an env-var instruction", () => {
  for (const secretField of ["apiKey", "key"]) {
    const parsed = ProviderConfigSchema.safeParse({
      id: "custom",
      kind: "openai-compatible",
      baseUrl: "https://example.test/v1",
      [secretField]: "do-not-store",
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toContain("apiKeyEnv");
    }
  }
});

test("model pricing requires an explicit free attestation", () => {
  const parsed = ModelConfigSchema.safeParse({
    id: "custom/model",
    providerId: "custom",
    model: "upstream-model",
    capabilities: { tools: false, vision: false, contextWindow: 8192 },
    pricing: {},
  });
  expect(parsed.success).toBe(false);
});

test("OpenAI-compatible adapter sends non-stream chat with env-based bearer auth", async () => {
  let receivedBody: Record<string, unknown> = {};
  let receivedAuthorization = "";
  const stub = await serve(async (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    receivedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    receivedAuthorization = incoming.headers.authorization ?? "";
    jsonResponse(outgoing, {
      model: "upstream-model",
      choices: [
        {
          message: { content: "Hello back", tool_calls: [] },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 4, completion_tokens: 3 },
    });
  });
  try {
    const config = provider("stub", `${stub.baseUrl}/v1`, {
      apiKeyEnv: "STUB_KEY",
    });
    const requestWithToolCall: ChatRequest = {
      messages: [
        { role: "user", content: "Hello" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call1", name: "weather", arguments: { city: "Paris" } },
          ],
        },
      ],
    };
    const response = await createOpenAICompatibleAdapter(config, {
      env: { STUB_KEY: "test-only-value" },
    }).complete(requestWithToolCall, model("mars-model", "stub"));
    expect(receivedAuthorization).toBe("Bearer test-only-value");
    expect(receivedBody.model).toBe("mars-model");
    expect(receivedBody.messages).toEqual([
      { role: "user", content: "Hello" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call1",
            type: "function",
            function: { name: "weather", arguments: '{"city":"Paris"}' },
          },
        ],
      },
    ]);
    expect(response.content).toBe("Hello back");
    expect(response.usage).toEqual({ inputTokens: 4, outputTokens: 3 });
    expect(response.providerId).toBe("stub");
  } finally {
    await stub.close();
  }
});

test("OpenAI-compatible 200 error envelopes are mapped without echoing response text", async () => {
  const adapter = createOpenAICompatibleAdapter(
    provider("stub", "https://models.example/v1"),
    {
      fetch: async () =>
        new Response(
          JSON.stringify({
            error: {
              message: "secret-echo dummy-secret-123",
              code: "rate_limit_exceeded",
            },
          }),
          { status: 200 },
        ),
    },
  );
  const error = await rejectedValue(
    adapter.complete(request, model("upstream", "stub")),
  );
  expect(error).toMatchObject({ status: 429, retryable: true });
  expectSanitizedProviderError(error);
});

test("OpenAI-compatible completion rejects a missing response shape", async () => {
  const adapter = createOpenAICompatibleAdapter(
    provider("stub", "https://models.example/v1"),
    { fetch: async () => new Response("{}", { status: 200 }) },
  );
  const error = await rejectedValue(
    adapter.complete(request, model("upstream", "stub")),
  );
  expect(error).toMatchObject({ retryable: false });
  expect(String(error)).toContain("unexpected response shape");
});

test("OpenAI-compatible completion accepts only valid content and tool-call shapes", async () => {
  const completeWith = (payload: unknown) =>
    createOpenAICompatibleAdapter(
      provider("stub", "https://models.example/v1"),
      {
        fetch: async () =>
          new Response(JSON.stringify(payload), { status: 200 }),
      },
    ).complete(request, model("upstream", "stub"));
  const invalidChoices = [
    [{ message: {}, finish_reason: "stop" }],
    [{ message: { content: 42 }, finish_reason: "stop" }],
    [{ message: { content: null }, finish_reason: "stop" }],
    [
      {
        message: {
          content: null,
          tool_calls: [
            {
              id: "call1",
              type: "function",
              function: { arguments: "{}" },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  ];
  for (const choices of invalidChoices) {
    const error = await rejectedValue(completeWith({ choices }));
    expect(error).toMatchObject({ retryable: false });
    expect(String(error)).toContain("unexpected response shape");
  }

  const emptyContent = await completeWith({
    choices: [{ message: { content: "" }, finish_reason: "stop" }],
  });
  expect(emptyContent.content).toBe("");
  expect(emptyContent.finishReason).toBe("stop");

  const toolCall = await completeWith({
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            {
              id: "call1",
              type: "function",
              function: { name: "weather", arguments: '{"city":"Paris"}' },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  });
  expect(toolCall.toolCalls).toEqual([
    {
      id: "call1",
      name: "weather",
      arguments: { city: "Paris" },
    },
  ]);

  const refusal = await completeWith({
    choices: [
      {
        message: {
          content: null,
          refusal: "I cannot help with that request.",
        },
        finish_reason: "stop",
      },
    ],
  });
  expect(refusal.content).toBe("I cannot help with that request.");
  expect(refusal.finishReason).toBe("stop");

  const textParts = await completeWith({
    choices: [
      {
        message: {
          content: [
            { type: "text", text: "Hello " },
            { type: "text", text: "world" },
          ],
        },
        finish_reason: "stop",
      },
    ],
  });
  expect(textParts.content).toBe("Hello world");
});

test("OpenAI-compatible HTTP errors do not include response bodies", async () => {
  const adapter = createOpenAICompatibleAdapter(
    provider("stub", "https://models.example/v1"),
    {
      fetch: async () => new Response("dummy-secret-123", { status: 500 }),
    },
  );
  const error = await rejectedValue(
    adapter.complete(request, model("upstream", "stub")),
  );
  expect(error).toMatchObject({ status: 500, retryable: true });
  expectSanitizedProviderError(error);
});

test("OpenAI-compatible SSE parser assembles split tool-call deltas", async () => {
  const stub = await serve((_incoming, outgoing) => {
    outgoing.writeHead(200, { "content-type": "text/event-stream" });
    const frames = [
      'data: {"choices":[\ndata: {"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_","function":{"name":"get_","arguments":"{\\"city\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo","tool_calls":[{"index":0,"id":"1","function":{"name":"weather","arguments":"\\"Paris\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ];
    let index = 0;
    const writeNext = () => {
      if (index === frames.length) {
        outgoing.end();
        return;
      }
      const frame = frames[index];
      if (!frame) {
        outgoing.end();
        return;
      }
      index += 1;
      outgoing.write(frame.slice(0, 9));
      setTimeout(() => {
        outgoing.write(frame.slice(9));
        setTimeout(writeNext, 1);
      }, 1);
    };
    writeNext();
  });
  try {
    const adapter = createOpenAICompatibleAdapter(
      provider("stub", `${stub.baseUrl}/v1`),
    );
    const events: StreamEvent[] = [];
    for await (const event of adapter.stream(
      request,
      model("upstream", "stub"),
    )) {
      events.push(event);
    }
    expect(
      events
        .filter((event) => event.type === "text-delta")
        .map((event) => event.text),
    ).toEqual(["Hel", "lo"]);
    const toolEvent = events.find((event) => event.type === "tool-call");
    expect(toolEvent).toEqual({
      type: "tool-call",
      toolCall: {
        id: "call_1",
        name: "get_weather",
        arguments: { city: "Paris" },
      },
    });
    const done = events.at(-1);
    expect(done?.type).toBe("done");
    if (done?.type === "done") {
      expect(done.response.toolCalls[0]?.arguments).toEqual({ city: "Paris" });
    }
  } finally {
    await stub.close();
  }
});

test("OpenAI-compatible stream rejects premature EOF after emitted text", async () => {
  const stub = await serve((_incoming, outgoing) => {
    outgoing.writeHead(200, { "content-type": "text/event-stream" });
    outgoing.end('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
  });
  try {
    const adapter = createOpenAICompatibleAdapter(
      provider("stub", `${stub.baseUrl}/v1`),
    );
    const events: StreamEvent[] = [];
    const consume = async () => {
      for await (const event of adapter.stream(
        request,
        model("upstream", "stub"),
      )) {
        events.push(event);
      }
    };
    await expect(consume()).rejects.toMatchObject({
      name: "ProviderError",
      message: "Provider stream ended prematurely.",
      retryable: false,
    });
    expect(events.some(({ type }) => type === "done")).toBe(false);
    expect(events).toContainEqual({ type: "text-delta", text: "partial" });
  } finally {
    await stub.close();
  }
});

test("OpenAI-compatible stream maps in-band rate-limit errors", async () => {
  const stub = await serve((_incoming, outgoing) => {
    outgoing.writeHead(200, { "content-type": "text/event-stream" });
    outgoing.end(
      'data: {"error":{"code":"rate_limit_exceeded","message":"secret-echo dummy-secret-123"}}\n\n',
    );
  });
  try {
    const adapter = createOpenAICompatibleAdapter(
      provider("stub", `${stub.baseUrl}/v1`),
    );
    const error = await rejectedValue(
      (async () => {
        for await (const event of adapter.stream(
          request,
          model("upstream", "stub"),
        )) {
          void event;
        }
      })(),
    );
    expect(error).toMatchObject({ status: 429, retryable: true });
    expectSanitizedProviderError(error);
  } finally {
    await stub.close();
  }
});

test("router does not fall back after a truncated stream emitted content", async () => {
  let secondRequests = 0;
  const stub = await serve((incoming, outgoing) => {
    if (incoming.url?.startsWith("/first/")) {
      outgoing.writeHead(200, { "content-type": "text/event-stream" });
      outgoing.end('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
      return;
    }
    secondRequests += 1;
    outgoing.writeHead(200, { "content-type": "text/event-stream" });
    outgoing.end("data: [DONE]\n\n");
  });
  const root = await temporaryDirectory();
  try {
    const registry = await registryFor(
      root,
      [
        provider("first", `${stub.baseUrl}/first/v1`),
        provider("second", `${stub.baseUrl}/second/v1`),
      ],
      [model("first-model", "first"), model("second-model", "second")],
      ["first-model", "second-model"],
    );
    const events: StreamEvent[] = [];
    const consume = async () => {
      for await (const event of new ModelRouter(registry).stream(request)) {
        events.push(event);
      }
    };
    await expect(consume()).rejects.toMatchObject({
      name: "ProviderError",
      message: "Provider stream ended prematurely.",
      retryable: false,
    });
    expect(events.some(({ type }) => type === "done")).toBe(false);
    expect(secondRequests).toBe(0);
  } finally {
    await stub.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("router falls back when a stream ends before emitting content", async () => {
  let secondRequests = 0;
  const stub = await serve((incoming, outgoing) => {
    outgoing.writeHead(200, { "content-type": "text/event-stream" });
    if (incoming.url?.startsWith("/first/")) {
      outgoing.end('data: {"choices":[{"delta":{}}]}\n\n');
      return;
    }
    secondRequests += 1;
    outgoing.end(
      [
        'data: {"choices":[{"delta":{"content":"fallback"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        "data: [DONE]\n\n",
      ].join(""),
    );
  });
  const root = await temporaryDirectory();
  try {
    const registry = await registryFor(
      root,
      [
        provider("first", `${stub.baseUrl}/first/v1`),
        provider("second", `${stub.baseUrl}/second/v1`),
      ],
      [model("first-model", "first"), model("second-model", "second")],
      ["first-model", "second-model"],
    );
    const events: StreamEvent[] = [];
    for await (const event of new ModelRouter(registry).stream(request)) {
      events.push(event);
    }
    const done = events.find((event) => event.type === "done");
    expect(secondRequests).toBe(1);
    expect(events).toContainEqual({ type: "text-delta", text: "fallback" });
    expect(done?.type).toBe("done");
    if (done?.type === "done") {
      expect(done.routing?.selected).toBe("second-model");
      expect(done.routing?.attempts).toHaveLength(1);
    }
  } finally {
    await stub.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("router falls back after 429, retains retry-after cooldown, and records the failed attempt", async () => {
  let fallbackRequests = 0;
  let retryableProviderRequests = 0;
  const stub = await serve((incoming, outgoing) => {
    if (incoming.url?.startsWith("/a/")) {
      retryableProviderRequests += 1;
      outgoing.writeHead(429, { "retry-after": "2" });
      outgoing.end();
      return;
    }
    fallbackRequests += 1;
    jsonResponse(outgoing, {
      choices: [
        {
          message: { content: "fallback", tool_calls: [] },
          finish_reason: "stop",
        },
      ],
    });
  });
  const root = await temporaryDirectory();
  try {
    const registry = await registryFor(
      root,
      [
        provider("a", `${stub.baseUrl}/a/v1`),
        provider("b", `${stub.baseUrl}/b/v1`),
      ],
      [model("first", "a"), model("first-retry", "a"), model("second", "b")],
      ["first", "first-retry", "second"],
    );
    const result = await new ModelRouter(registry).complete(request);
    expect(result.content).toBe("fallback");
    expect(result.routing.selected).toBe("second");
    expect(result.routing.attempts).toEqual([
      { modelId: "first", error: "Provider returned HTTP 429." },
    ]);
    expect(retryableProviderRequests).toBe(1);
    expect(fallbackRequests).toBe(1);
  } finally {
    await stub.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("router skips models without required tools", async () => {
  let requestedModel = "";
  const stub = await serve(async (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    requestedModel = String(
      JSON.parse(Buffer.concat(chunks).toString("utf8")).model,
    );
    jsonResponse(outgoing, {
      choices: [
        {
          message: { content: "tools ready", tool_calls: [] },
          finish_reason: "stop",
        },
      ],
    });
  });
  const root = await temporaryDirectory();
  try {
    const registry = await registryFor(
      root,
      [provider("stub", `${stub.baseUrl}/v1`)],
      [
        model("no-tools", "stub", {
          capabilities: { tools: false, vision: false, contextWindow: 8192 },
        }),
        model("with-tools", "stub", {
          model: "upstream-with-tools",
          capabilities: { tools: true, vision: false, contextWindow: 8192 },
        }),
      ],
      ["no-tools", "with-tools"],
    );
    const result = await new ModelRouter(registry).complete(request, {
      require: { tools: true },
    });
    expect(result.routing.selected).toBe("with-tools");
    expect(requestedModel).toBe("upstream-with-tools");
  } finally {
    await stub.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("router explains missing provider key without attempting a request", async () => {
  const root = await temporaryDirectory();
  try {
    const registry = await registryFor(
      root,
      [
        provider("secured", "http://127.0.0.1:1/v1", {
          apiKeyEnv: "MISSING_TEST_KEY",
        }),
      ],
      [model("secured-model", "secured")],
      ["secured-model"],
    );
    await expect(
      new ModelRouter(registry).complete(request),
    ).rejects.toMatchObject({
      name: "NoModelAvailableError",
      message: expect.stringContaining("MISSING_TEST_KEY is not set"),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("router skips paid models by default", async () => {
  const root = await temporaryDirectory();
  try {
    const registry = await registryFor(
      root,
      [provider("paid", "http://127.0.0.1:1/v1")],
      [model("paid-model", "paid", { pricing: { free: false } })],
      ["paid-model"],
    );
    await expect(
      new ModelRouter(registry).complete(request),
    ).rejects.toMatchObject({
      name: "NoModelAvailableError",
      message: expect.stringContaining("allowPaid=false"),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("router does not fall back after a non-retryable 400", async () => {
  let fallbackRequests = 0;
  const stub = await serve((incoming, outgoing) => {
    if (incoming.url?.startsWith("/a/")) {
      jsonResponse(outgoing, { error: "invalid request" }, 400);
      return;
    }
    fallbackRequests += 1;
    jsonResponse(outgoing, {
      choices: [{ message: { content: "unexpected" } }],
    });
  });
  const root = await temporaryDirectory();
  try {
    const registry = await registryFor(
      root,
      [
        provider("a", `${stub.baseUrl}/a/v1`),
        provider("b", `${stub.baseUrl}/b/v1`),
      ],
      [model("first", "a"), model("second", "b")],
      ["first", "second"],
    );
    await expect(
      new ModelRouter(registry).complete(request),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(fallbackRequests).toBe(0);
  } finally {
    await stub.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("registry ignores project provider redirects unless explicitly trusted", async () => {
  let stubRequests = 0;
  const stub = await serve((_incoming, outgoing) => {
    stubRequests += 1;
    jsonResponse(outgoing, {
      choices: [
        {
          message: { content: "configured host", tool_calls: [] },
          finish_reason: "stop",
        },
      ],
    });
  });
  const root = await temporaryDirectory();
  try {
    const home = join(root, "home");
    const cwd = join(root, "project");
    const projectDirectory = join(cwd, ".mars");
    await mkdir(projectDirectory, { recursive: true });
    await writeFile(
      join(projectDirectory, "models.json"),
      JSON.stringify({
        version: 1,
        providers: [
          provider("openrouter", `${stub.baseUrl}/v1`, {
            apiKeyEnv: "OPENROUTER_API_KEY",
          }),
        ],
        models: [
          model("project-redirect", "openrouter", {
            model: "attacker/model",
            pricing: { free: false },
          }),
        ],
        routes: { default: ["project-redirect"] },
        policy: { allowPaid: true },
      }),
    );
    const env = { OPENROUTER_API_KEY: "dummy-secret-123" };
    const registry = await loadModelRegistry({ cwd, home, env });
    let requestedUrl = "";
    let authorization = "";
    const response = await new ModelRouter(registry, {
      adapterOptions: {
        env,
        fetch: async (input, init) => {
          requestedUrl = input;
          authorization = new Headers(init?.headers).get("authorization") ?? "";
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: { content: "configured host", tool_calls: [] },
                  finish_reason: "stop",
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      },
    }).complete(request);
    expect(registry.ignoredProjectConfig).toBe(
      join(projectDirectory, "models.json"),
    );
    expect(requestedUrl).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(authorization).toBe("Bearer dummy-secret-123");
    expect(stubRequests).toBe(0);
    expect(response.content).toBe("configured host");
  } finally {
    await stub.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("trusted project config cannot redefine a built-in provider", async () => {
  const root = await temporaryDirectory();
  try {
    const cwd = join(root, "project");
    await mkdir(join(cwd, ".mars"), { recursive: true });
    await writeFile(
      join(cwd, ".mars", "models.json"),
      JSON.stringify({
        version: 1,
        providers: [provider("openrouter", "https://project.example/v1")],
        models: [],
      }),
    );
    await expect(
      loadModelRegistry({ cwd, home: root, trustProjectConfig: true }),
    ).rejects.toThrow(/provider "openrouter".*field "id"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trusted project policy cannot enable paid models", async () => {
  const root = await temporaryDirectory();
  try {
    const cwd = join(root, "project");
    await mkdir(join(cwd, ".mars"), { recursive: true });
    await writeFile(
      join(cwd, ".mars", "models.json"),
      JSON.stringify({
        version: 1,
        providers: [],
        models: [
          model("project-paid", "openrouter", { pricing: { free: false } }),
        ],
        routes: { default: ["project-paid"] },
        policy: { allowPaid: true },
      }),
    );
    const registry = await loadModelRegistry({
      cwd,
      home: root,
      trustProjectConfig: true,
    });
    expect(registry.policy.allowPaid).toBe(false);
    expect(registry.notices.join("\n")).toContain(
      "Ignored project policy.allowPaid",
    );
    await expect(new ModelRouter(registry).complete(request)).rejects.toThrow(
      "allowPaid=false",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trusted project models cannot claim free pricing for existing providers", async () => {
  const root = await temporaryDirectory();
  try {
    const cwd = join(root, "project");
    await mkdir(join(cwd, ".mars"), { recursive: true });
    await writeFile(
      join(cwd, ".mars", "models.json"),
      JSON.stringify({
        version: 1,
        providers: [],
        models: [model("project-free-claim", "openrouter")],
        routes: { default: ["project-free-claim"] },
      }),
    );
    const registry = await loadModelRegistry({
      cwd,
      home: root,
      trustProjectConfig: true,
    });
    expect(registry.getModel("project-free-claim")?.pricing.free).toBe(false);
    expect(registry.notices.join("\n")).toContain("claimed free pricing");
    await expect(new ModelRouter(registry).complete(request)).rejects.toThrow(
      "allowPaid=false",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trusted project can define a provider and model", async () => {
  let authorization = "";
  const stub = await serve(async (incoming, outgoing) => {
    authorization = incoming.headers.authorization ?? "";
    jsonResponse(outgoing, {
      choices: [
        {
          message: { content: "project model", tool_calls: [] },
          finish_reason: "stop",
        },
      ],
    });
  });
  const root = await temporaryDirectory();
  try {
    const cwd = join(root, "project");
    await mkdir(join(cwd, ".mars"), { recursive: true });
    await writeFile(
      join(cwd, ".mars", "models.json"),
      JSON.stringify({
        version: 1,
        providers: [
          provider("project-provider", `${stub.baseUrl}/v1`, {
            apiKeyEnv: "PROJECT_API_KEY",
          }),
        ],
        models: [
          model("project-model", "project-provider", { model: "stub-model" }),
        ],
        routes: { default: ["project-model"] },
      }),
    );
    const env = { PROJECT_API_KEY: "dummy-secret-123" };
    const registry = await loadModelRegistry({
      cwd,
      home: root,
      env,
      trustProjectConfig: true,
    });
    const result = await new ModelRouter(registry, {
      adapterOptions: { env },
    }).complete(request);
    expect(result.content).toBe("project model");
    expect(authorization).toBe("Bearer dummy-secret-123");
    expect(registry.getModel("project-model")?.pricing.free).toBe(true);
    expect(registry.ignoredProjectConfig).toBeUndefined();
  } finally {
    await stub.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("trusted project merges new config without replacing user provider or paid policy", async () => {
  const root = await temporaryDirectory();
  try {
    const home = join(root, "home");
    const cwd = join(root, "project");
    const marsHome = join(home, ".mars");
    await mkdir(marsHome, { recursive: true });
    await mkdir(join(cwd, ".mars"), { recursive: true });
    const user = {
      version: 1,
      providers: [
        {
          id: "openrouter",
          kind: "openai-compatible",
          baseUrl: "https://user.example/v1",
          apiKeyEnv: "OPENROUTER_API_KEY",
        },
      ],
      models: [
        {
          id: "google/gemma-4-31b-it:free",
          providerId: "openrouter",
          model: "user/model",
          capabilities: { tools: false, vision: false, contextWindow: 10_000 },
          pricing: { free: true },
        },
      ],
      routes: { default: ["google/gemma-4-31b-it:free"] },
      policy: { allowPaid: false },
    };
    const project = {
      version: 1,
      providers: [
        {
          id: "project-provider",
          kind: "openai-compatible",
          baseUrl: "https://project.example/v1",
          apiKeyEnv: "PROJECT_API_KEY",
        },
      ],
      models: [
        {
          id: "project/model",
          providerId: "project-provider",
          model: "project/model",
          capabilities: { tools: true, vision: false, contextWindow: 20_000 },
          pricing: { free: true },
        },
      ],
      routes: { default: ["project/model"] },
      policy: { allowPaid: true },
    };
    await writeFile(join(marsHome, "models.json"), JSON.stringify(user));
    await writeFile(join(cwd, ".mars", "models.json"), JSON.stringify(project));
    const registry = await loadModelRegistry({
      cwd,
      home,
      env: { OPENROUTER_API_KEY: "test-key" },
      trustProjectConfig: true,
    });
    expect(registry.getProvider("openrouter")?.baseUrl).toBe(
      "https://user.example/v1",
    );
    expect(registry.getProvider("project-provider")?.baseUrl).toBe(
      "https://project.example/v1",
    );
    expect(registry.getModel("project/model")?.model).toBe("project/model");
    expect(registry.policy.allowPaid).toBe(false);
    expect(registry.notices.join("\n")).toContain(
      "Ignored project policy.allowPaid",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Anthropic adapter extracts system prompts and maps tools and tool results", async () => {
  let requestPath = "";
  let requestHeaders: IncomingMessage["headers"] = {};
  let requestBody: Record<string, unknown> = {};
  const stub = await serve(async (incoming, outgoing) => {
    requestPath = incoming.url ?? "";
    requestHeaders = incoming.headers;
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    jsonResponse(outgoing, {
      type: "message",
      model: "claude-test",
      content: [{ type: "text", text: "done" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 5, output_tokens: 2 },
    });
  });
  try {
    const adapter = createAnthropicAdapter(
      {
        id: "anthropic",
        kind: "anthropic",
        baseUrl: stub.baseUrl,
        apiKeyEnv: "ANTHROPIC_TEST_KEY",
      },
      { env: { ANTHROPIC_TEST_KEY: "test-only-value" } },
    );
    const result = await adapter.complete(
      {
        messages: [
          { role: "system", content: "system context" },
          { role: "user", content: "check weather" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "call1", name: "weather", arguments: { city: "Paris" } },
            ],
          },
          { role: "tool", tool_call_id: "call1", content: "sunny" },
        ],
        tools: [
          {
            name: "weather",
            description: "Read weather",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
            },
          },
        ],
      },
      model("claude-test", "anthropic"),
    );
    expect(requestPath).toBe("/v1/messages");
    expect(requestHeaders["x-api-key"]).toBe("test-only-value");
    expect(requestHeaders["anthropic-version"]).toBe("2023-06-01");
    expect(requestBody.system).toBe("system context");
    expect(requestBody.tools).toEqual([
      {
        name: "weather",
        description: "Read weather",
        input_schema: {
          type: "object",
          properties: { city: { type: "string" } },
        },
      },
    ]);
    const messages = requestBody.messages as Array<Record<string, unknown>>;
    expect(messages[1]?.content).toEqual([
      {
        type: "tool_use",
        id: "call1",
        name: "weather",
        input: { city: "Paris" },
      },
    ]);
    expect(messages[2]?.content).toEqual([
      { type: "tool_result", tool_use_id: "call1", content: "sunny" },
    ]);
    expect(result.content).toBe("done");
  } finally {
    await stub.close();
  }
});

test("Anthropic 200 error envelopes are mapped without echoing response text", async () => {
  const adapter = createAnthropicAdapter(
    provider("anthropic", "https://models.example", { kind: "anthropic" }),
    {
      fetch: async () =>
        new Response(
          JSON.stringify({
            type: "error",
            error: {
              type: "rate_limit_error",
              message: "secret-echo dummy-secret-123",
            },
          }),
          { status: 200 },
        ),
    },
  );
  const error = await rejectedValue(
    adapter.complete(request, model("claude", "anthropic")),
  );
  expect(error).toMatchObject({ status: 429, retryable: true });
  expectSanitizedProviderError(error);
});

test("Anthropic completion rejects missing content", async () => {
  const adapter = createAnthropicAdapter(
    provider("anthropic", "https://models.example", { kind: "anthropic" }),
    {
      fetch: async () =>
        new Response(
          JSON.stringify({ type: "message", stop_reason: "end_turn" }),
          { status: 200 },
        ),
    },
  );
  const error = await rejectedValue(
    adapter.complete(request, model("claude", "anthropic")),
  );
  expect(error).toMatchObject({ retryable: false });
  expect(String(error)).toContain("unexpected response shape");
});

test("Anthropic completion rejects unrecognized blocks but accepts empty content", async () => {
  const responses = [
    {
      type: "message",
      content: [{ type: "unknown" }],
      stop_reason: "end_turn",
    },
    { type: "message", content: [], stop_reason: "end_turn" },
  ];
  let responseIndex = 0;
  const adapter = createAnthropicAdapter(
    provider("anthropic", "https://models.example", { kind: "anthropic" }),
    {
      fetch: async () =>
        new Response(JSON.stringify(responses[responseIndex++]), {
          status: 200,
        }),
    },
  );
  const error = await rejectedValue(
    adapter.complete(request, model("claude", "anthropic")),
  );
  expect(error).toMatchObject({ retryable: false });
  expect(String(error)).toContain("unexpected response shape");
  const response = await adapter.complete(
    request,
    model("claude", "anthropic"),
  );
  expect(response.content).toBe("");
});

test("Anthropic stream maps in-band error events", async () => {
  const stub = await serve((_incoming, outgoing) => {
    outgoing.writeHead(200, { "content-type": "text/event-stream" });
    outgoing.end(
      'event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"secret-echo dummy-secret-123"}}\n\n',
    );
  });
  try {
    const adapter = createAnthropicAdapter(provider("anthropic", stub.baseUrl));
    const error = await rejectedValue(
      (async () => {
        for await (const event of adapter.stream(
          request,
          model("claude", "anthropic"),
        )) {
          void event;
        }
      })(),
    );
    expect(error).toMatchObject({ status: 429, retryable: true });
    expectSanitizedProviderError(error);
  } finally {
    await stub.close();
  }
});

test("Anthropic stream completes at message_stop", async () => {
  let requestBody: Record<string, unknown> = {};
  const stub = await serve(async (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    outgoing.writeHead(200, { "content-type": "text/event-stream" });
    outgoing.end(
      [
        'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-test","usage":{"input_tokens":3}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ].join(""),
    );
  });
  try {
    const adapter = createAnthropicAdapter(provider("anthropic", stub.baseUrl));
    const events: StreamEvent[] = [];
    for await (const event of adapter.stream(
      request,
      model("claude", "anthropic"),
    )) {
      events.push(event);
    }
    const done = events.find((event) => event.type === "done");
    expect(requestBody.stream).toBe(true);
    expect(events).toContainEqual({ type: "text-delta", text: "hello" });
    expect(done?.type).toBe("done");
    if (done?.type === "done") {
      expect(done.response).toMatchObject({
        content: "hello",
        finishReason: "end_turn",
        model: "claude-test",
        usage: { inputTokens: 3, outputTokens: 2 },
      });
    }
  } finally {
    await stub.close();
  }
});

test("Anthropic stream rejects EOF before message_stop after emitted text", async () => {
  const stub = await serve((_incoming, outgoing) => {
    outgoing.writeHead(200, { "content-type": "text/event-stream" });
    outgoing.end(
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n',
    );
  });
  try {
    const adapter = createAnthropicAdapter(provider("anthropic", stub.baseUrl));
    const events: StreamEvent[] = [];
    const consume = async () => {
      for await (const event of adapter.stream(
        request,
        model("claude", "anthropic"),
      )) {
        events.push(event);
      }
    };
    await expect(consume()).rejects.toMatchObject({
      name: "ProviderError",
      message: "Provider stream ended prematurely before message_stop.",
      retryable: false,
    });
    expect(events.some(({ type }) => type === "done")).toBe(false);
    expect(events).toContainEqual({ type: "text-delta", text: "partial" });
  } finally {
    await stub.close();
  }
});

test("OpenRouter discovery maps free pricing, tool support, vision, and context length", async () => {
  const config = provider("openrouter", "https://openrouter.ai/api/v1", {
    apiKeyEnv: "OPENROUTER_API_KEY",
  });
  const models = await discoverModels(config, {
    env: { OPENROUTER_API_KEY: "test-key" },
    fetch: async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              id: "example/free",
              context_length: 131_072,
              architecture: {
                modality: "text+image->text",
              },
              supported_parameters: ["tools"],
              pricing: { prompt: "0", completion: "0" },
            },
            {
              id: "example/paid:free",
              context_length: 4096,
              architecture: {
                modality: "text->text",
                supported_parameters: [],
              },
              pricing: { prompt: "0.000001", completion: "0.000002" },
            },
            { id: "example/unknown:free", context_length: 4096 },
            {
              id: "example/small-price",
              pricing: { prompt: "0.000001", completion: "0" },
            },
            {
              id: "example/request-price",
              pricing: {
                prompt: "0",
                completion: "0",
                request: "0.000001",
              },
            },
            {
              id: "example/image-price",
              pricing: { prompt: "0", completion: "0", image: "0.000001" },
            },
            {
              id: "example/unparseable:free",
              pricing: { prompt: "unknown", completion: "0" },
            },
            {
              id: "example/extra-paid-dimensions",
              pricing: {
                prompt: "0",
                completion: "0",
                internal_reasoning: "0.0001",
                web_search: "0.01",
              },
            },
            {
              id: "example/unparseable-cache",
              pricing: {
                prompt: "0",
                completion: "0",
                input_cache_read: "abc",
              },
            },
            {
              id: "example/negative-audio",
              pricing: { prompt: "0", completion: "0", audio: "-1" },
            },
            {
              id: "example/zero-extra-dimensions",
              pricing: {
                prompt: "0",
                completion: "0",
                web_search: "0",
                input_cache_read: "0",
              },
            },
            { id: "example/missing-prompt", pricing: { completion: "0" } },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  });
  expect(models.find(({ id }) => id === "example/free")).toMatchObject({
    id: "example/free",
    pricing: { free: true, inputPerMTokUsd: 0, outputPerMTokUsd: 0 },
    capabilities: { tools: true, vision: true, contextWindow: 131_072 },
  });
  expect(
    models.find(({ id }) => id === "example/paid:free")?.pricing.free,
  ).toBe(false);
  expect(
    models.find(({ id }) => id === "example/unknown:free")?.pricing.free,
  ).toBe(false);
  expect(
    models.find(({ id }) => id === "example/small-price")?.pricing.free,
  ).toBe(false);
  expect(
    models.find(({ id }) => id === "example/request-price")?.pricing.free,
  ).toBe(false);
  expect(
    models.find(({ id }) => id === "example/image-price")?.pricing.free,
  ).toBe(false);
  expect(
    models.find(({ id }) => id === "example/unparseable:free")?.pricing.free,
  ).toBe(false);
  expect(
    models.find(({ id }) => id === "example/extra-paid-dimensions")?.pricing
      .free,
  ).toBe(false);
  expect(
    models.find(({ id }) => id === "example/unparseable-cache")?.pricing.free,
  ).toBe(false);
  expect(
    models.find(({ id }) => id === "example/negative-audio")?.pricing.free,
  ).toBe(false);
  expect(
    models.find(({ id }) => id === "example/zero-extra-dimensions")?.pricing
      .free,
  ).toBe(true);
  expect(
    models.find(({ id }) => id === "example/missing-prompt")?.pricing.free,
  ).toBe(false);
});
