import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ChatToolCall,
  ModelConfig,
  ProviderConfig,
  StreamEvent,
} from "@mars/contracts";
import type { AdapterOptions, ProviderAdapter } from "./adapter-types";
import { ProviderError } from "./errors";

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function usageFrom(value: unknown): ChatResponse["usage"] {
  const usage = asObject(value);
  const inputTokens = usage.prompt_tokens;
  const outputTokens = usage.completion_tokens;
  if (
    typeof inputTokens !== "number" ||
    typeof outputTokens !== "number" ||
    !Number.isInteger(inputTokens) ||
    !Number.isInteger(outputTokens)
  ) {
    return undefined;
  }
  return { inputTokens, outputTokens };
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const timestamp = Date.parse(header);
  return Number.isNaN(timestamp)
    ? undefined
    : Math.max(0, timestamp - Date.now());
}

function errorStatus(error: JsonObject): number | undefined {
  const status = error.status;
  if (typeof status === "number" && Number.isInteger(status)) return status;
  if (typeof status === "string" && /^\d{3}$/.test(status))
    return Number(status);
  const code = error.code;
  if (typeof code === "number" && Number.isInteger(code)) return code;
  if (typeof code === "string") {
    if (/^\d{3}$/.test(code)) return Number(code);
    const normalized = code.toLowerCase();
    if (/rate.?limit|too.?many.?requests|quota/.test(normalized)) return 429;
    if (/timeout|timed.?out/.test(normalized)) return 408;
    if (/overload/.test(normalized)) return 529;
    if (/server|internal|unavailable/.test(normalized)) return 500;
  }
  const type = error.type;
  if (typeof type === "string") {
    const normalizedType = type.toLowerCase();
    if (/rate.?limit|too.?many.?requests|quota/.test(normalizedType))
      return 429;
    if (/timeout|timed.?out/.test(normalizedType)) return 408;
    if (/overload/.test(normalizedType)) return 529;
    if (/server|internal|unavailable/.test(normalizedType)) return 500;
  }
  return undefined;
}

function providerEnvelopeError(
  providerId: string,
  error: JsonObject,
): ProviderError {
  const status = errorStatus(error);
  const retryable =
    status === 408 || status === 429 || (status !== undefined && status >= 500);
  return new ProviderError(
    providerId,
    `Provider returned an error envelope${status ? ` (HTTP ${status})` : ""}.`,
    {
      ...(status !== undefined ? { status } : {}),
      retryable,
    },
  );
}

function parseToolArguments(
  value: unknown,
  providerId: string,
): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(value || "{}");
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    throw new ProviderError(
      providerId,
      "Provider returned invalid tool arguments.",
      {
        retryable: false,
      },
    );
  }
  throw new ProviderError(
    providerId,
    "Provider returned invalid tool arguments.",
    {
      retryable: false,
    },
  );
}

function openaiMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((message) => {
    if (message.role !== "assistant" || !message.tool_calls) return message;
    return {
      ...message,
      tool_calls: message.tool_calls.map((toolCall) => ({
        id: toolCall.id,
        type: "function",
        function: {
          name: toolCall.name,
          arguments: JSON.stringify(toolCall.arguments),
        },
      })),
    };
  });
}

export function createOpenAICompatibleAdapter(
  provider: ProviderConfig,
  options: AdapterOptions = {},
): ProviderAdapter {
  const fetcher = options.fetch ?? fetch;
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const baseUrl = provider.baseUrl.replace(/\/+$/, "");

  async function request(
    path: string,
    body?: Record<string, unknown>,
  ): Promise<{ response: Response; cleanup: () => void; signal: AbortSignal }> {
    const headers = new Headers(provider.headers);
    headers.set("Accept", "application/json");
    if (body) headers.set("Content-Type", "application/json");
    const apiKey = provider.apiKeyEnv ? env[provider.apiKeyEnv] : undefined;
    if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(`${baseUrl}${path}`, {
        method: body ? "POST" : "GET",
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      return {
        response,
        cleanup: () => clearTimeout(timer),
        signal: controller.signal,
      };
    } catch {
      clearTimeout(timer);
      throw new ProviderError(
        provider.id,
        "Provider network request failed or timed out.",
        {
          retryable: true,
        },
      );
    }
  }

  async function assertOk(response: Response): Promise<void> {
    if (response.ok) return;
    const retryable =
      response.status === 408 ||
      response.status === 429 ||
      response.status >= 500;
    const retryAfterMs = retryable
      ? parseRetryAfter(response.headers.get("retry-after"))
      : undefined;
    throw new ProviderError(
      provider.id,
      `Provider returned HTTP ${response.status}.`,
      {
        status: response.status,
        retryable,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      },
    );
  }

  async function responseJson(
    response: Response,
    signal: AbortSignal,
  ): Promise<JsonObject> {
    try {
      return asObject(await response.json());
    } catch {
      if (signal.aborted) {
        throw new ProviderError(provider.id, "Provider request timed out.", {
          retryable: true,
        });
      }
      throw new ProviderError(provider.id, "Provider returned invalid JSON.", {
        retryable: false,
      });
    }
  }

  function requestBody(
    requestData: ChatRequest,
    model: ModelConfig,
    stream: boolean,
  ): Record<string, unknown> {
    return {
      model: model.model,
      messages: openaiMessages(requestData.messages),
      ...(requestData.tools
        ? {
            tools: requestData.tools.map((tool) => ({
              type: "function",
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              },
            })),
          }
        : {}),
      ...(requestData.temperature !== undefined
        ? { temperature: requestData.temperature }
        : {}),
      ...(requestData.maxTokens !== undefined
        ? { max_tokens: requestData.maxTokens }
        : {}),
      ...(stream ? { stream: true } : {}),
    };
  }

  async function complete(
    requestData: ChatRequest,
    model: ModelConfig,
  ): Promise<ChatResponse> {
    const { response, cleanup, signal } = await request(
      "/chat/completions",
      requestBody(requestData, model, false),
    );
    try {
      await assertOk(response);
      const payload = await responseJson(response, signal);
      if (
        Object.hasOwn(payload, "error") &&
        payload.error !== null &&
        typeof payload.error === "object"
      ) {
        throw providerEnvelopeError(provider.id, asObject(payload.error));
      }
      const choices: unknown[] = Array.isArray(payload.choices)
        ? payload.choices
        : [];
      const choice = choices[0];
      const message = isObject(choice) ? choice.message : undefined;
      if (choices.length === 0 || !isObject(choice) || !isObject(message)) {
        throw new ProviderError(
          provider.id,
          "Provider returned an unexpected response shape.",
          { retryable: false },
        );
      }
      const throwUnexpectedShape = (): never => {
        throw new ProviderError(
          provider.id,
          "Provider returned an unexpected response shape.",
          { retryable: false },
        );
      };
      const rawContent = message.content;
      const hasContent = Object.hasOwn(message, "content");
      const rawTools = message.tool_calls;
      if (Object.hasOwn(message, "tool_calls") && !Array.isArray(rawTools)) {
        throwUnexpectedShape();
      }
      const toolCalls: ChatToolCall[] = (
        Array.isArray(rawTools) ? rawTools : []
      ).map((rawTool) => {
        if (
          !isObject(rawTool) ||
          rawTool.type !== "function" ||
          typeof rawTool.id !== "string" ||
          rawTool.id.length === 0 ||
          !isObject(rawTool.function) ||
          typeof rawTool.function.name !== "string" ||
          rawTool.function.name.length === 0 ||
          typeof rawTool.function.arguments !== "string"
        ) {
          throwUnexpectedShape();
        }
        const args = (() => {
          try {
            return parseToolArguments(rawTool.function.arguments, provider.id);
          } catch {
            return throwUnexpectedShape();
          }
        })();
        return {
          id: rawTool.id,
          name: rawTool.function.name,
          arguments: args,
        };
      });
      let content = "";
      let validContent = false;
      if (typeof message.refusal === "string" && message.refusal.length > 0) {
        content = message.refusal;
        validContent = true;
      } else if (typeof rawContent === "string") {
        content = rawContent;
        validContent = true;
      } else if (
        Array.isArray(rawContent) &&
        rawContent.length > 0 &&
        rawContent.every(
          (part) =>
            isObject(part) &&
            part.type === "text" &&
            typeof part.text === "string",
        )
      ) {
        content = rawContent
          .map((part) => (part as JsonObject).text as string)
          .join("");
        validContent = true;
      } else if ((rawContent === null || !hasContent) && toolCalls.length > 0) {
        validContent = true;
      }
      if (!validContent) throwUnexpectedShape();
      const usage = usageFrom(payload.usage);
      return {
        content,
        toolCalls,
        finishReason: stringValue(choice.finish_reason) ?? null,
        ...(usage ? { usage } : {}),
        model: stringValue(payload.model) ?? model.model,
        providerId: provider.id,
      };
    } finally {
      cleanup();
    }
  }

  async function* readSseMessages(
    body: ReadableStream<Uint8Array>,
  ): AsyncGenerator<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let dataLines: string[] = [];
    const processLine = (rawLine: string): string | undefined => {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line === "") {
        const message = dataLines.length ? dataLines.join("\n") : undefined;
        dataLines = [];
        return message;
      }
      if (!line.startsWith(":") && line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
      return undefined;
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        buffer += done
          ? decoder.decode()
          : decoder.decode(value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const message = processLine(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          if (message !== undefined) yield message;
          newline = buffer.indexOf("\n");
        }
        if (done) break;
      }
      if (buffer) {
        const message = processLine(buffer);
        if (message !== undefined) yield message;
      }
      if (dataLines.length) yield dataLines.join("\n");
    } finally {
      reader.releaseLock();
    }
  }

  async function* stream(
    requestData: ChatRequest,
    model: ModelConfig,
  ): AsyncGenerator<StreamEvent> {
    const { response, cleanup } = await request(
      "/chat/completions",
      requestBody(requestData, model, true),
    );
    try {
      await assertOk(response);
      if (!response.body) {
        throw new ProviderError(
          provider.id,
          "Provider response had no stream body.",
          {
            retryable: false,
          },
        );
      }

      let content = "";
      let finishReason: string | null = null;
      let usage: ChatResponse["usage"];
      let receivedDone = false;
      let emittedContent = false;
      const partialTools = new Map<
        number,
        { id: string; name: string; args: string }
      >();
      try {
        for await (const data of readSseMessages(response.body)) {
          if (data === "[DONE]") {
            receivedDone = true;
            break;
          }
          let payload: JsonObject;
          try {
            payload = asObject(JSON.parse(data));
          } catch {
            throw new ProviderError(
              provider.id,
              "Provider returned invalid SSE JSON.",
              {
                retryable: false,
              },
            );
          }
          if (
            Object.hasOwn(payload, "error") &&
            payload.error !== null &&
            typeof payload.error === "object"
          ) {
            throw providerEnvelopeError(provider.id, asObject(payload.error));
          }
          const choice = asObject(
            Array.isArray(payload.choices) ? payload.choices[0] : undefined,
          );
          const delta = asObject(choice.delta);
          if (typeof delta.content === "string") {
            content += delta.content;
            emittedContent = true;
            yield { type: "text-delta", text: delta.content };
          }
          if (typeof choice.finish_reason === "string")
            finishReason = choice.finish_reason;
          usage = usageFrom(payload.usage) ?? usage;

          if (Array.isArray(delta.tool_calls)) {
            for (const rawTool of delta.tool_calls) {
              const tool = asObject(rawTool);
              const index = typeof tool.index === "number" ? tool.index : 0;
              const partial = partialTools.get(index) ?? {
                id: "",
                name: "",
                args: "",
              };
              partial.id += stringValue(tool.id) ?? "";
              const fn = asObject(tool.function);
              partial.name += stringValue(fn.name) ?? "";
              partial.args += stringValue(fn.arguments) ?? "";
              partialTools.set(index, partial);
            }
          }
        }
        if (!receivedDone && finishReason === null) {
          throw new ProviderError(
            provider.id,
            "Provider stream ended prematurely.",
            { retryable: !emittedContent },
          );
        }
      } catch (cause) {
        if (cause instanceof ProviderError) throw cause;
        throw new ProviderError(
          provider.id,
          "Provider stream failed or timed out.",
          {
            retryable: true,
          },
        );
      }

      const toolCalls = [...partialTools.entries()]
        .sort(([left], [right]) => left - right)
        .map(([index, partial]) => ({
          id: partial.id || `tool-${index}`,
          name: partial.name,
          arguments: parseToolArguments(partial.args, provider.id),
        }));
      if (toolCalls.some(({ name }) => !name)) {
        throw new ProviderError(
          provider.id,
          "Provider returned a tool call without a name.",
          {
            retryable: false,
          },
        );
      }
      for (const toolCall of toolCalls) yield { type: "tool-call", toolCall };
      yield {
        type: "done",
        response: {
          content,
          toolCalls,
          finishReason,
          ...(usage ? { usage } : {}),
          model: model.model,
          providerId: provider.id,
        },
      };
    } finally {
      cleanup();
    }
  }

  async function listModels(): Promise<unknown[]> {
    const { response, cleanup, signal } = await request("/models");
    try {
      await assertOk(response);
      const payload = await responseJson(response, signal);
      return Array.isArray(payload.data) ? payload.data : [];
    } finally {
      cleanup();
    }
  }

  return { complete, stream, listModels };
}
