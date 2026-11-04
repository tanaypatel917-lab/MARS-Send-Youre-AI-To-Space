import { expect, test } from "bun:test";
import type { ChatRequest, ModelConfig, ProviderConfig } from "@mars/contracts";
import { createOpenAICompatibleAdapter } from "./openai-compatible";

/**
 * Offline trace of the live Ollama run recorded in
 * documentation/evidence/local-model-run.txt: qwen3-coder:30b answered the
 * MARS request with `finish_reason: "stop"`, `tool_calls` absent and the tool
 * call written inside `content`. These tests replay that recorded shape and
 * its structured counterpart through the same adapter the runtime uses, so
 * the question "did the adapter drop a structured call?" has an offline answer.
 */

const TEXTUAL_CONTENT =
  'I\'ll create a file named greet.txt with the content "Hello".\n\n<function=mars_write>\n<parameter=path>\ngreet.txt\n</parameter>\n<parameter=content>\nHello\n</parameter>\n<parameter=i>\nCreate greet.txt with Hello text\n</parameter>\n</function>\n</tool_call>';

const STRUCTURED_CALL = {
  id: "call_1",
  type: "function",
  function: {
    name: "mars_write",
    arguments: JSON.stringify({ path: "greet.txt", content: "Hello" }),
  },
};

const provider: ProviderConfig = {
  id: "ollama",
  kind: "openai-compatible",
  baseUrl: "http://127.0.0.1:11434/v1",
};
const model: ModelConfig = {
  id: "ollama/qwen3-coder",
  providerId: "ollama",
  model: "qwen3-coder:30b",
  capabilities: { tools: true, vision: false, contextWindow: 32768 },
  pricing: { free: true },
};
const request: ChatRequest = {
  messages: [{ role: "user", content: "Create greet.txt containing Hello." }],
  tools: [
    {
      name: "mars_write",
      description: "Write a file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
      },
    },
  ],
};

/** The non-streaming envelope Ollama returned (ids, timestamps and usage as recorded). */
function ollamaCompletion(message: Record<string, unknown>) {
  return {
    id: "chatcmpl-738",
    object: "chat.completion",
    created: 1793662620,
    model: "qwen3-coder:30b",
    system_fingerprint: "fp_ollama",
    choices: [{ index: 0, message, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 1897,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens: 4096,
      total_tokens: 5993,
    },
  };
}

function sseResponse(frames: object[], finishReason: string) {
  const body = [
    ...frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`),
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }], usage: { prompt_tokens: 1897, completion_tokens: 4096 } })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
}

async function collect(
  adapter: ReturnType<typeof createOpenAICompatibleAdapter>,
) {
  let text = "";
  const toolCalls: unknown[] = [];
  let done: unknown = null;
  for await (const event of adapter.stream(request, model)) {
    if (event.type === "text-delta") text += event.text;
    else if (event.type === "tool-call") toolCalls.push(event.toolCall);
    else if (event.type === "done") done = event.response;
  }
  return { text, toolCalls, done };
}

test("recorded Ollama shape: text-only answer yields content and zero tool calls (nothing for the adapter to lose)", async () => {
  const adapter = createOpenAICompatibleAdapter(provider, {
    fetch: async () =>
      new Response(
        JSON.stringify(
          ollamaCompletion({ role: "assistant", content: TEXTUAL_CONTENT }),
        ),
        { headers: { "content-type": "application/json" } },
      ),
  });
  const response = await adapter.complete(request, model);
  expect(response.toolCalls).toEqual([]);
  expect(response.finishReason).toBe("stop");
  expect(response.content).toBe(TEXTUAL_CONTENT);
  expect(response.content).toContain("<function=mars_write>");

  const streamed = await collect(
    createOpenAICompatibleAdapter(provider, {
      fetch: async () =>
        sseResponse(
          [
            {
              choices: [
                { delta: { role: "assistant", content: TEXTUAL_CONTENT } },
              ],
            },
          ],
          "stop",
        ),
    }),
  );
  expect(streamed.toolCalls).toEqual([]);
  expect(streamed.text).toBe(TEXTUAL_CONTENT);
  expect(streamed.done).toMatchObject({ toolCalls: [], finishReason: "stop" });
});

test("structured counterpart: content and tool_calls together are both preserved, so a structured call is never dropped because text was present", async () => {
  const adapter = createOpenAICompatibleAdapter(provider, {
    fetch: async () =>
      new Response(
        JSON.stringify(
          ollamaCompletion({
            role: "assistant",
            content: "I'll create greet.txt.",
            tool_calls: [STRUCTURED_CALL],
          }),
        ),
        { headers: { "content-type": "application/json" } },
      ),
  });
  const response = await adapter.complete(request, model);
  expect(response.content).toBe("I'll create greet.txt.");
  expect(response.toolCalls).toEqual([
    {
      id: "call_1",
      name: "mars_write",
      arguments: { path: "greet.txt", content: "Hello" },
    },
  ]);

  const streamed = await collect(
    createOpenAICompatibleAdapter(provider, {
      fetch: async () =>
        sseResponse(
          [
            {
              choices: [
                {
                  delta: {
                    role: "assistant",
                    content: "I'll create greet.txt.",
                  },
                },
              ],
            },
            {
              choices: [
                {
                  delta: {
                    content: "",
                    tool_calls: [{ index: 0, ...STRUCTURED_CALL }],
                  },
                },
              ],
            },
          ],
          "tool_calls",
        ),
    }),
  );
  expect(streamed.text).toBe("I'll create greet.txt.");
  expect(streamed.toolCalls).toEqual([
    {
      id: "call_1",
      name: "mars_write",
      arguments: { path: "greet.txt", content: "Hello" },
    },
  ]);
  expect(streamed.done).toMatchObject({ finishReason: "tool_calls" });
});

test("an explicit `tool_calls: null` envelope is rejected as an unexpected shape rather than silently dropped", async () => {
  const adapter = createOpenAICompatibleAdapter(provider, {
    fetch: async () =>
      new Response(
        JSON.stringify(
          ollamaCompletion({
            role: "assistant",
            content: `<tool_call>\n${TEXTUAL_CONTENT}`,
            tool_calls: null,
          }),
        ),
        { headers: { "content-type": "application/json" } },
      ),
  });
  await expect(adapter.complete(request, model)).rejects.toThrow();
});
