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

    const system = request.messages
      .filter((message) => message.role === "system")
      .map((message) => contentText(message.content))
      .join("\n");
    const body = {
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
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetcher(`${baseUrl}/v1/messages`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (cause) {
        throw new ProviderError(
          provider.id,
          "Provider network request failed or timed out.",
          {
            retryable: true,
            cause,
          },
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
      } catch (cause) {
        if (controller.signal.aborted) {
          throw new ProviderError(provider.id, "Provider request timed out.", {
            retryable: true,
            cause,
          });
        }
        throw new ProviderError(
          provider.id,
          "Provider returned invalid JSON.",
          {
            retryable: false,
            cause,
          },
        );
      }
      const content: string[] = [];
      const toolCalls: ChatToolCall[] = [];
      for (const rawBlock of Array.isArray(payload.content)
        ? payload.content
        : []) {
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
        finishReason:
          typeof payload.stop_reason === "string" ? payload.stop_reason : null,
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
    const response = await complete(request, model);
    if (response.content) yield { type: "text-delta", text: response.content };
    for (const toolCall of response.toolCalls)
      yield { type: "tool-call", toolCall };
    yield { type: "done", response };
  }

  return { complete, stream };
}
