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
import {
  asObject,
  assertOk,
  hasErrorEnvelope,
  type JsonObject,
  parseSseJson,
  parseToolArguments,
  providerEnvelopeError,
  readJson,
  readSseFrames,
  requireToolCall,
  sendProviderRequest,
  streamBody,
  streamFailure,
  unexpectedResponseShape,
  usageFrom,
} from "./http";

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
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

/** A chat request with the OpenAI-compatible sampling `seed` (non-negative safe integer). */
export interface OpenAICompatibleChatRequest extends ChatRequest {
  seed?: number;
}

export interface OpenAICompatibleAdapter extends ProviderAdapter {
  complete(
    request: OpenAICompatibleChatRequest,
    model: ModelConfig,
  ): Promise<ChatResponse>;
  stream(
    request: OpenAICompatibleChatRequest,
    model: ModelConfig,
  ): AsyncIterable<StreamEvent>;
}

export function createOpenAICompatibleAdapter(
  provider: ProviderConfig,
  options: AdapterOptions = {},
): OpenAICompatibleAdapter {
  const fetcher = options.fetch ?? fetch;
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const baseUrl = provider.baseUrl.replace(/\/+$/, "");

  function request(path: string, body?: JsonObject) {
    const headers = new Headers(provider.headers);
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      if (name.toLowerCase() === "authorization") continue;
      headers.set(name, value);
    }
    headers.set("Accept", "application/json");
    if (body) headers.set("Content-Type", "application/json");
    const apiKey = provider.apiKeyEnv ? env[provider.apiKeyEnv] : undefined;
    if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`);
    return sendProviderRequest({
      providerId: provider.id,
      fetch: fetcher,
      url: `${baseUrl}${path}`,
      headers,
      ...(body ? { body } : {}),
      timeoutMs,
    });
  }

  function requestBody(
    requestData: OpenAICompatibleChatRequest,
    model: ModelConfig,
    stream: boolean,
  ): Record<string, unknown> {
    const { seed } = requestData;
    if (seed !== undefined && (!Number.isSafeInteger(seed) || seed < 0)) {
      throw new ProviderError(
        provider.id,
        "Request seed must be a non-negative safe integer.",
        { retryable: false },
      );
    }
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
      ...(seed !== undefined ? { seed } : {}),
      ...(stream ? { stream: true } : {}),
    };
  }

  async function complete(
    requestData: OpenAICompatibleChatRequest,
    model: ModelConfig,
  ): Promise<ChatResponse> {
    const { response, cleanup, signal } = await request(
      "/chat/completions",
      requestBody(requestData, model, false),
    );
    try {
      assertOk(provider.id, response);
      const payload = await readJson(provider.id, response, signal);
      if (hasErrorEnvelope(payload)) {
        throw providerEnvelopeError(provider.id, asObject(payload.error));
      }
      const choices: unknown[] = Array.isArray(payload.choices)
        ? payload.choices
        : [];
      const choice = choices[0];
      const message = isObject(choice) ? choice.message : undefined;
      if (choices.length === 0 || !isObject(choice) || !isObject(message)) {
        throw unexpectedResponseShape(provider.id);
      }
      const rawContent = message.content;
      const hasContent = Object.hasOwn(message, "content");
      const rawTools = message.tool_calls;
      if (Object.hasOwn(message, "tool_calls") && !Array.isArray(rawTools)) {
        throw unexpectedResponseShape(provider.id);
      }
      const toolCalls: ChatToolCall[] = (
        Array.isArray(rawTools) ? rawTools : []
      ).map((rawTool) => {
        if (
          !isObject(rawTool) ||
          rawTool.type !== "function" ||
          !isObject(rawTool.function) ||
          typeof rawTool.function.arguments !== "string"
        ) {
          throw unexpectedResponseShape(provider.id);
        }
        return requireToolCall(
          {
            id: rawTool.id,
            name: rawTool.function.name,
            arguments: parseToolArguments(
              rawTool.function.arguments,
              provider.id,
            ),
          },
          provider.id,
        );
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
      if (!validContent) throw unexpectedResponseShape(provider.id);
      const usage = usageFrom(
        payload.usage,
        "prompt_tokens",
        "completion_tokens",
      );
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

  async function* stream(
    requestData: OpenAICompatibleChatRequest,
    model: ModelConfig,
  ): AsyncGenerator<StreamEvent> {
    const { response, cleanup, signal } = await request(
      "/chat/completions",
      requestBody(requestData, model, true),
    );
    try {
      assertOk(provider.id, response);
      const body = streamBody(provider.id, response);

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
        for await (const { data } of readSseFrames(body)) {
          if (data === "[DONE]") {
            receivedDone = true;
            break;
          }
          const payload = parseSseJson(provider.id, data);
          if (hasErrorEnvelope(payload)) {
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
          usage =
            usageFrom(payload.usage, "prompt_tokens", "completion_tokens") ??
            usage;

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
        throw streamFailure(provider.id, cause, emittedContent, signal.aborted);
      }

      const capped = finishReason === "length" || finishReason === "max_tokens";
      const toolCalls: ChatToolCall[] = [];
      for (const [, partial] of [...partialTools.entries()].sort(
        ([left], [right]) => left - right,
      )) {
        if (capped && !partial.args) continue;
        try {
          toolCalls.push(
            requireToolCall(
              {
                id: partial.id,
                name: partial.name,
                arguments: parseToolArguments(partial.args, provider.id),
              },
              provider.id,
            ),
          );
        } catch (cause) {
          if (!capped || !(cause instanceof ProviderError)) throw cause;
        }
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
      assertOk(provider.id, response);
      const payload = await readJson(provider.id, response, signal);
      return Array.isArray(payload.data) ? payload.data : [];
    } finally {
      cleanup();
    }
  }

  return { complete, stream, listModels };
}
