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

function contentText(
  content: string | { type: "text"; text: string }[],
): string {
  return typeof content === "string"
    ? content
    : content.map((part) => part.text).join("");
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

function anthropicMessages(messages: ChatMessage[]): JsonObject[] {
  const result: JsonObject[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      result.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: message.tool_call_id,
            content: contentText(message.content),
          },
        ],
      });
      continue;
    }
    if (message.role === "user") {
      result.push({
        role: "user",
        content:
          typeof message.content === "string"
            ? message.content
            : message.content.map((part) => ({
                type: "text",
                text: part.text,
              })),
      });
      continue;
    }
    const blocks: JsonObject[] = [];
    if (typeof message.content === "string" && message.content.length > 0) {
      blocks.push({ type: "text", text: message.content });
    } else if (Array.isArray(message.content)) {
      blocks.push(
        ...message.content.map((part) => ({ type: "text", text: part.text })),
      );
    }
    for (const call of message.tool_calls ?? []) {
      blocks.push({
        type: "tool_use",
        id: call.id,
        name: call.name,
        input: call.arguments,
      });
    }
    result.push({ role: "assistant", content: blocks });
  }
  return result;
}

function anthropicRequestBody(
  request: ChatRequest,
  model: ModelConfig,
  stream: boolean,
): JsonObject {
  const system = request.messages
    .filter((message) => message.role === "system")
    .map((message) => contentText(message.content))
    .join("\n");
  return {
    model: model.model,
    max_tokens: request.maxTokens ?? 1024,
    messages: anthropicMessages(request.messages),
    ...(system ? { system } : {}),
    ...(request.temperature !== undefined
      ? { temperature: request.temperature }
      : {}),
    ...(request.tools
      ? {
          tools: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.parameters,
          })),
        }
      : {}),
    ...(stream ? { stream: true } : {}),
  };
}

async function* readSseEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "";
  let dataLines: string[] = [];
  const processLine = (
    rawLine: string,
  ): { event: string; data: string } | undefined => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line) {
      const frame =
        dataLines.length > 0
          ? { event: eventName, data: dataLines.join("\n") }
          : undefined;
      eventName = "";
      dataLines = [];
      return frame;
    }
    if (line.startsWith(":")) return undefined;
    if (line.startsWith("event:")) {
      eventName = line.slice(6).replace(/^ /, "");
    } else if (line.startsWith("data:")) {
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
        const frame = processLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (frame) yield frame;
        newline = buffer.indexOf("\n");
      }
      if (done) break;
    }
    if (buffer) {
      const frame = processLine(buffer);
      if (frame) yield frame;
    }
    if (dataLines.length > 0) {
      yield { event: eventName, data: dataLines.join("\n") };
    }
  } finally {
    reader.releaseLock();
  }
}

function streamErrorStatus(error: JsonObject): number | undefined {
  const rawStatus = error.status;
  if (typeof rawStatus === "number" && Number.isInteger(rawStatus))
    return rawStatus;
  if (typeof rawStatus === "string" && /^\d{3}$/.test(rawStatus))
    return Number(rawStatus);
  const code =
    typeof error.code === "string"
      ? error.code
      : typeof error.code === "number"
        ? String(error.code)
        : typeof error.type === "string"
          ? error.type
          : "";
  if (/^\d{3}$/.test(code)) return Number(code);
  const normalized = code.toLowerCase();
  if (/rate.?limit|too.?many.?requests|quota/.test(normalized)) return 429;
  if (/timeout|timed.?out/.test(normalized)) return 408;
  if (/overload/.test(normalized)) return 529;
  if (/server|internal|unavailable/.test(normalized)) return 500;
  return undefined;
}

function providerEnvelopeError(
  providerId: string,
  error: JsonObject,
): ProviderError {
  const status = streamErrorStatus(error);
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

export function createAnthropicAdapter(
  provider: ProviderConfig,
  options: AdapterOptions = {},
): ProviderAdapter {
  const fetcher = options.fetch ?? fetch;
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const baseUrl = provider.baseUrl.replace(/\/+$/, "");

  async function complete(
    request: ChatRequest,
    model: ModelConfig,
  ): Promise<ChatResponse> {
    const headers = new Headers(provider.headers);
    headers.set("Content-Type", "application/json");
    headers.set("Accept", "application/json");
    headers.set("anthropic-version", "2023-06-01");
    const apiKey = provider.apiKeyEnv ? env[provider.apiKeyEnv] : undefined;
    if (apiKey) headers.set("x-api-key", apiKey);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetcher(`${baseUrl}/v1/messages`, {
          method: "POST",
          headers,
          body: JSON.stringify(anthropicRequestBody(request, model, false)),
          signal: controller.signal,
        });
      } catch {
        throw new ProviderError(
          provider.id,
          "Provider network request failed or timed out.",
          { retryable: true },
        );
      }
      if (!response.ok) {
        const retryable =
          response.status === 408 ||
          response.status === 429 ||
          response.status >= 500;
        const retryAfterMs = parseRetryAfter(
          response.headers.get("retry-after"),
        );
        throw new ProviderError(
          provider.id,
          `Provider returned HTTP ${response.status}.`,
          {
            status: response.status,
            retryable,
            ...(retryable && retryAfterMs !== undefined
              ? { retryAfterMs }
              : {}),
          },
        );
      }

      let payload: JsonObject;
      try {
        payload = asObject(await response.json());
      } catch {
        if (controller.signal.aborted) {
          throw new ProviderError(provider.id, "Provider request timed out.", {
            retryable: true,
          });
        }
        throw new ProviderError(
          provider.id,
          "Provider returned invalid JSON.",
          { retryable: false },
        );
      }
      if (
        Object.hasOwn(payload, "error") &&
        payload.error !== null &&
        typeof payload.error === "object"
      ) {
        throw providerEnvelopeError(provider.id, asObject(payload.error));
      }
      const contentBlocks = payload.content;
      const stopReason = payload.stop_reason;
      if (
        payload.type !== "message" ||
        !Array.isArray(contentBlocks) ||
        !Object.hasOwn(payload, "stop_reason") ||
        (typeof stopReason !== "string" && stopReason !== null)
      ) {
        throw new ProviderError(
          provider.id,
          "Provider returned an unexpected response shape.",
          { retryable: false },
        );
      }
      const content: string[] = [];
      const toolCalls: ChatToolCall[] = [];
      for (const rawBlock of contentBlocks) {
        const block = asObject(rawBlock);
        if (block.type === "text" && typeof block.text === "string") {
          content.push(block.text);
        } else if (
          block.type === "tool_use" &&
          typeof block.name === "string" &&
          typeof block.id === "string"
        ) {
          const input = asObject(block.input);
          toolCalls.push({ id: block.id, name: block.name, arguments: input });
        }
      }
      const usageObject = asObject(payload.usage);
      const inputTokens = usageObject.input_tokens;
      const outputTokens = usageObject.output_tokens;
      const usage =
        typeof inputTokens === "number" &&
        Number.isInteger(inputTokens) &&
        typeof outputTokens === "number" &&
        Number.isInteger(outputTokens)
          ? { inputTokens, outputTokens }
          : undefined;
      return {
        content: content.join(""),
        toolCalls,
        finishReason: typeof stopReason === "string" ? stopReason : null,
        ...(usage ? { usage } : {}),
        model: typeof payload.model === "string" ? payload.model : model.model,
        providerId: provider.id,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async function* stream(
    request: ChatRequest,
    model: ModelConfig,
  ): AsyncGenerator<StreamEvent> {
    const headers = new Headers(provider.headers);
    headers.set("Content-Type", "application/json");
    headers.set("Accept", "text/event-stream");
    headers.set("anthropic-version", "2023-06-01");
    const apiKey = provider.apiKeyEnv ? env[provider.apiKeyEnv] : undefined;
    if (apiKey) headers.set("x-api-key", apiKey);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetcher(`${baseUrl}/v1/messages`, {
          method: "POST",
          headers,
          body: JSON.stringify(anthropicRequestBody(request, model, true)),
          signal: controller.signal,
        });
      } catch {
        throw new ProviderError(
          provider.id,
          "Provider network request failed or timed out.",
          { retryable: true },
        );
      }
      if (!response.ok) {
        const retryable =
          response.status === 408 ||
          response.status === 429 ||
          response.status >= 500;
        const retryAfterMs = parseRetryAfter(
          response.headers.get("retry-after"),
        );
        throw new ProviderError(
          provider.id,
          `Provider returned HTTP ${response.status}.`,
          {
            status: response.status,
            retryable,
            ...(retryable && retryAfterMs !== undefined
              ? { retryAfterMs }
              : {}),
          },
        );
      }
      if (!response.body) {
        throw new ProviderError(
          provider.id,
          "Provider response had no stream body.",
          { retryable: false },
        );
      }

      let content = "";
      let finishReason: string | null = null;
      let responseModel = model.model;
      let inputTokens: number | undefined;
      let outputTokens: number | undefined;
      let emittedContent = false;
      let messageStopped = false;
      const partialTools = new Map<
        number,
        { id: string; name: string; input: JsonObject; partialJson: string }
      >();

      try {
        for await (const frame of readSseEvents(response.body)) {
          let payload: JsonObject;
          try {
            payload = asObject(JSON.parse(frame.data));
          } catch {
            throw new ProviderError(
              provider.id,
              "Provider returned invalid SSE JSON.",
              { retryable: false },
            );
          }
          const eventType =
            frame.event ||
            (typeof payload.type === "string" ? payload.type : "");
          if (
            eventType === "error" ||
            (Object.hasOwn(payload, "error") &&
              payload.error !== null &&
              typeof payload.error === "object")
          ) {
            throw providerEnvelopeError(
              provider.id,
              asObject(payload.error ?? payload),
            );
          }

          if (eventType === "message_start") {
            const message = asObject(payload.message);
            if (typeof message.model === "string")
              responseModel = message.model;
            const usage = asObject(message.usage);
            if (typeof usage.input_tokens === "number")
              inputTokens = usage.input_tokens;
          } else if (eventType === "content_block_start") {
            const index = typeof payload.index === "number" ? payload.index : 0;
            const block = asObject(payload.content_block);
            if (block.type === "text" && typeof block.text === "string") {
              content += block.text;
              emittedContent = true;
              yield { type: "text-delta", text: block.text };
            } else if (block.type === "tool_use") {
              partialTools.set(index, {
                id: typeof block.id === "string" ? block.id : "",
                name: typeof block.name === "string" ? block.name : "",
                input: asObject(block.input),
                partialJson: "",
              });
            }
          } else if (eventType === "content_block_delta") {
            const index = typeof payload.index === "number" ? payload.index : 0;
            const delta = asObject(payload.delta);
            if (delta.type === "text_delta" && typeof delta.text === "string") {
              content += delta.text;
              emittedContent = true;
              yield { type: "text-delta", text: delta.text };
            } else if (
              delta.type === "input_json_delta" &&
              typeof delta.partial_json === "string"
            ) {
              const tool = partialTools.get(index);
              if (tool) tool.partialJson += delta.partial_json;
            }
          } else if (eventType === "message_delta") {
            const delta = asObject(payload.delta);
            if (typeof delta.stop_reason === "string")
              finishReason = delta.stop_reason;
            const usage = asObject(payload.usage);
            if (typeof usage.output_tokens === "number")
              outputTokens = usage.output_tokens;
          } else if (eventType === "message_stop") {
            messageStopped = true;
            break;
          }
        }
      } catch (cause) {
        if (cause instanceof ProviderError) throw cause;
        throw new ProviderError(
          provider.id,
          "Provider stream failed or timed out.",
          { retryable: !emittedContent },
        );
      }

      if (!messageStopped) {
        throw new ProviderError(
          provider.id,
          "Provider stream ended prematurely before message_stop.",
          { retryable: !emittedContent },
        );
      }

      const toolCalls: ChatToolCall[] = [];
      for (const [, tool] of [...partialTools.entries()].sort(
        ([left], [right]) => left - right,
      )) {
        let input = tool.input;
        if (tool.partialJson) {
          try {
            const parsed: unknown = JSON.parse(tool.partialJson);
            input =
              parsed !== null &&
              typeof parsed === "object" &&
              !Array.isArray(parsed)
                ? (parsed as JsonObject)
                : {};
          } catch {
            throw new ProviderError(
              provider.id,
              "Provider returned invalid tool arguments.",
              { retryable: false },
            );
          }
        }
        if (!tool.id || !tool.name) {
          throw new ProviderError(
            provider.id,
            "Provider returned a tool call without an id or name.",
            { retryable: false },
          );
        }
        const toolCall: ChatToolCall = {
          id: tool.id,
          name: tool.name,
          arguments: input,
        };
        toolCalls.push(toolCall);
        yield { type: "tool-call", toolCall };
      }
      yield {
        type: "done",
        response: {
          content,
          toolCalls,
          finishReason,
          ...(inputTokens !== undefined && outputTokens !== undefined
            ? { usage: { inputTokens, outputTokens } }
            : {}),
          model: responseModel,
          providerId: provider.id,
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return { complete, stream };
}
