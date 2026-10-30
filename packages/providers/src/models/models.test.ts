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
  type ProviderConfig,
  ProviderConfigSchema,
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
    const events = [];
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

test("registry merges presets, user configuration, and project configuration by id", async () => {
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
          id: "openrouter",
          kind: "openai-compatible",
          baseUrl: "https://project.example/v1",
          apiKeyEnv: "OPENROUTER_API_KEY",
        },
      ],
      models: [
        {
          id: "google/gemma-4-31b-it:free",
          providerId: "openrouter",
          model: "project/model",
          capabilities: { tools: true, vision: false, contextWindow: 20_000 },
          pricing: { free: true },
        },
      ],
      routes: { default: ["google/gemma-4-31b-it:free"] },
      policy: { allowPaid: true },
    };
    await writeFile(join(marsHome, "models.json"), JSON.stringify(user));
    await writeFile(join(cwd, ".mars", "models.json"), JSON.stringify(project));
    const registry = await loadModelRegistry({
      cwd,
      home,
      env: { OPENROUTER_API_KEY: "test-key" },
    });
    expect(registry.getProvider("openrouter")?.baseUrl).toBe(
      "https://project.example/v1",
    );
    expect(registry.getModel("google/gemma-4-31b-it:free")?.model).toBe(
      "project/model",
    );
    expect(registry.policy.allowPaid).toBe(true);
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
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  });
  expect(models[0]).toMatchObject({
    id: "example/free",
    pricing: { free: true, inputPerMTokUsd: 0, outputPerMTokUsd: 0 },
    capabilities: { tools: true, vision: true, contextWindow: 131_072 },
  });
  expect(models[1]?.pricing.free).toBe(true);
});
