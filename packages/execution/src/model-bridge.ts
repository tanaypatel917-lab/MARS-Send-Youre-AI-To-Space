import type {
  Budget,
  ChatMessage,
  ChatRequest,
  ModelConfig,
} from "@mars/contracts";
import {
  type ModelProviderRegistry,
  ModelRouter,
  ProviderError,
} from "@mars/providers";
import {
  type AssistantMessage,
  type Context,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  toolWireSchema,
} from "@oh-my-pi/pi-ai";

export interface BudgetLedger {
  deadline: number;
  reserved_tokens: number;
  reserved_usd: number;
  input_tokens: number;
  output_tokens: number;
}

export class ExecutionLimitError extends Error {
  constructor() {
    super("Task execution budget exhausted or unverifiable.");
    this.name = "ExecutionLimitError";
  }
}

export function selectExecutionModel(
  registry: ModelProviderRegistry,
  requested?: string,
  needsTools = true,
): ModelConfig {
  const ids = requested ? [requested] : (registry.routes.default ?? []);
  for (const id of ids) {
    const model = registry.getModel(id);
    if (
      !model ||
      (needsTools && !model.capabilities.tools) ||
      registry.unavailableReason(model.providerId) !== undefined
    )
      continue;
    // Automatic selection never opts into paid routing.
    if (!model.pricing.free && (!requested || !registry.policy.allowPaid))
      continue;
    if (
      !model.pricing.free &&
      (model.pricing.inputPerMTokUsd === undefined ||
        model.pricing.outputPerMTokUsd === undefined)
    )
      continue;
    return model;
  }
  throw new Error(
    "No eligible configured model; configure a tool-capable free model or explicitly select a priced, user-authorized paid model.",
  );
}

function textContent(content: Context["messages"][number]["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "toolCall") return "";
      throw new Error(
        "This execution bridge only supports text and function tools.",
      );
    })
    .join("");
}

export function toChatRequest(context: Context): ChatRequest {
  const messages: ChatMessage[] = [];
  if (context.systemPrompt?.length)
    messages.push({
      role: "system",
      content: context.systemPrompt.join("\n\n"),
    });
  for (const message of context.messages) {
    if (message.role === "toolResult") {
      messages.push({
        role: "tool",
        tool_call_id: message.toolCallId,
        content: textContent(message.content),
      });
    } else if (message.role === "assistant") {
      messages.push({
        role: "assistant",
        content: textContent(message.content),
        tool_calls: message.content.flatMap((part) =>
          part.type === "toolCall"
            ? [{ id: part.id, name: part.name, arguments: part.arguments }]
            : [],
        ),
      });
    } else {
      messages.push({
        role: message.role === "developer" ? "system" : "user",
        content: textContent(message.content),
      });
    }
  }
  return {
    messages,
    ...(context.tools?.length
      ? {
          tools: context.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: toolWireSchema(tool),
          })),
        }
      : {}),
  };
}

export interface ModelBridgeOptions {
  registry: ModelProviderRegistry;
  selected: ModelConfig;
  budget: Budget;
  ledger: BudgetLedger;
  persistLedger(ledger: BudgetLedger): Promise<void>;
  env?: Record<string, string | undefined>;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  signal: AbortSignal;
}

export function createModelBridge(options: ModelBridgeOptions) {
  const { selected, budget, ledger } = options;
  let busy = false;
  return (
    model: Model,
    context: Context,
    streamOptions?: SimpleStreamOptions,
  ) => {
    const stream = createAssistantMessageEventStream();
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      model: model.id,
      provider: model.provider,
      timestamp: Date.now(),
      stopReason: "stop",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    void (async () => {
      let ownsReservation = false;
      try {
        if (busy || Date.now() >= ledger.deadline)
          throw new ExecutionLimitError();
        busy = true;
        ownsReservation = true;
        const request = toChatRequest(context);
        // Reserve conservatively before dispatch; retain reservations after ambiguous failures.
        const inputAllowance =
          Buffer.byteLength(JSON.stringify(request), "utf8") + 512;
        const remaining = budget.max_tokens - ledger.reserved_tokens;
        const maxTokens = Math.min(
          4096,
          streamOptions?.maxTokens ?? 4096,
          remaining - inputAllowance,
          selected.capabilities.contextWindow - inputAllowance,
        );
        if (maxTokens <= 0) throw new ExecutionLimitError();
        const inputRate = selected.pricing.free
          ? 0
          : selected.pricing.inputPerMTokUsd;
        const outputRate = selected.pricing.free
          ? 0
          : selected.pricing.outputPerMTokUsd;
        if (inputRate === undefined || outputRate === undefined)
          throw new ExecutionLimitError();
        const reservedCost =
          (inputAllowance * inputRate + maxTokens * outputRate) / 1_000_000;
        if (ledger.reserved_usd + reservedCost > budget.max_usd)
          throw new ExecutionLimitError();
        const before = { ...ledger };
        ledger.reserved_tokens += inputAllowance + maxTokens;
        ledger.reserved_usd += reservedCost;
        await options.persistLedger({ ...ledger });
        const signals = [
          options.signal,
          AbortSignal.timeout(Math.max(1, ledger.deadline - Date.now())),
        ];
        if (streamOptions?.signal) signals.push(streamOptions.signal);
        const signal = AbortSignal.any(signals);
        signal.throwIfAborted();
        const router = new ModelRouter(options.registry, {
          adapterOptions: {
            ...(options.env ? { env: options.env } : {}),
            timeoutMs: Math.min(
              60_000,
              Math.max(1, ledger.deadline - Date.now()),
            ),
            fetch: (input, init) =>
              (options.fetch ?? fetch)(input, {
                ...init,
                signal: AbortSignal.any([
                  signal,
                  ...(init?.signal ? [init.signal] : []),
                ]),
              }),
          },
        });
        let textIndex = -1;
        let emittedText = "";
        let done = false;
        stream.push({ type: "start", partial: output });
        for await (const event of router.stream(
          { ...request, maxTokens },
          { model: selected.id, require: { tools: !!context.tools?.length } },
        )) {
          signal.throwIfAborted();
          if (event.type === "text-delta") {
            if (textIndex < 0) {
              textIndex = output.content.length;
              output.content.push({ type: "text", text: "" });
              stream.push({
                type: "text_start",
                contentIndex: textIndex,
                partial: output,
              });
            }
            emittedText += event.text;
            if (Buffer.byteLength(emittedText, "utf8") > maxTokens * 16)
              throw new ExecutionLimitError();
            const block = output.content[textIndex];
            if (block?.type === "text") block.text = emittedText;
            stream.push({
              type: "text_delta",
              contentIndex: textIndex,
              delta: event.text,
              partial: output,
            });
          } else if (event.type === "tool-call") {
            const index = output.content.length;
            const toolCall = { type: "toolCall" as const, ...event.toolCall };
            output.content.push(toolCall);
            stream.push({
              type: "toolcall_start",
              contentIndex: index,
              partial: output,
            });
            stream.push({
              type: "toolcall_end",
              contentIndex: index,
              toolCall,
              partial: output,
            });
          } else if (event.type === "error") {
            throw new Error("Provider stream failed.");
          } else if (event.type === "done") {
            if (done || event.response.content !== emittedText)
              throw new Error("Provider stream response mismatch.");
            const calls = output.content
              .filter((part) => part.type === "toolCall")
              .map(({ id, name, arguments: args }) => ({
                id,
                name,
                arguments: args,
              }));
            if (
              JSON.stringify(calls) !== JSON.stringify(event.response.toolCalls)
            )
              throw new Error("Provider tool response mismatch.");
            const inputTokens =
              event.response.usage?.inputTokens ?? inputAllowance;
            const outputTokens =
              event.response.usage?.outputTokens ?? maxTokens;
            if (inputTokens > inputAllowance || outputTokens > maxTokens)
              throw new ExecutionLimitError();
            ledger.reserved_tokens =
              before.reserved_tokens + inputAllowance + outputTokens;
            ledger.reserved_usd =
              before.reserved_usd +
              (inputAllowance * inputRate + outputTokens * outputRate) /
                1_000_000;
            ledger.input_tokens += inputTokens;
            ledger.output_tokens += outputTokens;
            await options.persistLedger({ ...ledger });
            output.usage = {
              input: inputTokens,
              output: outputTokens,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: inputTokens + outputTokens,
              cost: {
                input: (inputTokens * inputRate) / 1_000_000,
                output: (outputTokens * outputRate) / 1_000_000,
                cacheRead: 0,
                cacheWrite: 0,
                total:
                  (inputTokens * inputRate + outputTokens * outputRate) /
                  1_000_000,
              },
            };
            output.stopReason = calls.length
              ? "toolUse"
              : event.response.finishReason === "length" ||
                  event.response.finishReason === "max_tokens"
                ? "length"
                : "stop";
            if (textIndex >= 0)
              stream.push({
                type: "text_end",
                contentIndex: textIndex,
                content: emittedText,
                partial: output,
              });
            done = true;
          }
        }
        if (!done) throw new Error("Provider stream ended without completion.");
        stream.push({
          type: "done",
          reason: output.stopReason as "stop" | "length" | "toolUse",
          message: output,
        });
        stream.end(output);
      } catch (error) {
        output.stopReason =
          options.signal.aborted || streamOptions?.signal?.aborted
            ? "aborted"
            : "error";
        output.errorMessage =
          error instanceof ExecutionLimitError || error instanceof ProviderError
            ? error.message
            : output.stopReason === "aborted"
              ? "Task execution cancelled."
              : "Model execution failed.";
        stream.push({
          type: "error",
          reason: output.stopReason,
          error: output,
        });
        stream.end(output);
      } finally {
        if (ownsReservation) busy = false;
      }
    })();
    return stream;
  };
}
