import {
  type Budget,
  type ChatMessage,
  type ChatRequest,
  exceedsUsd,
  type ModelConfig,
} from "@mars/contracts";
import {
  type ModelProviderRegistry,
  ModelRouter,
  type OpenAICompatibleChatRequest,
  ProviderError,
} from "@mars/providers";
import {
  type AssistantMessage,
  type Context,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  type ToolCall,
  toolWireSchema,
} from "@oh-my-pi/pi-ai";

export interface BudgetLedger {
  deadline: number;
  reserved_tokens: number;
  reserved_usd: number;
  input_tokens: number;
  output_tokens: number;
}

export interface SharedBudget {
  /** Raise this run's hold to the given running totals, or throw if the task cannot afford it. */
  reserve(amount: { tokens: number; usd: number }): Promise<void>;
  /** Set this run's hold to its settled running totals. */
  record(amount: { tokens: number; usd: number }): Promise<void>;
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

export const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

export function maxOutputTokens(model: ModelConfig): number {
  return model.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
}

/** Model-visible stand-in for the host workspace root. */
export const WORKSPACE_PLACEHOLDER = "/__mars_workspace__";

/**
 * Swaps host workspace roots for `WORKSPACE_PLACEHOLDER` in outgoing text and
 * back in the model's tool-call arguments, so exact-text edits stay consistent.
 */
function workspaceRedactor(roots: readonly string[] | undefined) {
  const ordered = [
    ...new Set(
      (roots ?? []).flatMap((root) => [root, root.replace(/\\/g, "/")]),
    ),
  ]
    .filter((root) => root.length > 1)
    .sort((a, b) => b.length - a.length);
  const canonical = roots?.find((root) => root.length > 1);
  return {
    redact: (text: string) =>
      ordered.reduce(
        (current, root) => current.split(root).join(WORKSPACE_PLACEHOLDER),
        text,
      ),
    restore: (text: string) =>
      canonical === undefined
        ? text
        : text.split(WORKSPACE_PLACEHOLDER).join(canonical),
  };
}

function redactValue(
  value: unknown,
  redact: (text: string) => string,
): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value))
    return value.map((item) => redactValue(item, redact));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactValue(item, redact),
      ]),
    );
  return value;
}

export function toChatRequest(
  context: Context,
  options: { workspaceRoots?: readonly string[] } = {},
): ChatRequest {
  const { redact } = workspaceRedactor(options.workspaceRoots);
  const messages: ChatMessage[] = [];
  if (context.systemPrompt?.length)
    messages.push({
      role: "system",
      content: redact(context.systemPrompt.join("\n\n")),
    });
  // Strict OpenAI-compatible servers reject system messages after the first
  // conversation entry, so later developer turns (omp's date/cwd reminder) go as user turns.
  let conversationStarted = false;
  for (const message of context.messages) {
    if (message.role === "toolResult") {
      messages.push({
        role: "tool",
        tool_call_id: message.toolCallId,
        content: redact(textContent(message.content)),
      });
    } else if (message.role === "assistant") {
      messages.push({
        role: "assistant",
        content: redact(textContent(message.content)),
        tool_calls: message.content.flatMap((part) =>
          part.type === "toolCall"
            ? [
                {
                  id: part.id,
                  name: part.name,
                  arguments: redactValue(
                    part.arguments,
                    redact,
                  ) as typeof part.arguments,
                },
              ]
            : [],
        ),
      });
    } else {
      messages.push({
        role:
          message.role === "developer" && !conversationStarted
            ? "system"
            : "user",
        content: redact(textContent(message.content)),
      });
    }
    if (messages[messages.length - 1]?.role !== "system")
      conversationStarted = true;
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

export const DEFAULT_MODEL_REQUEST_TIMEOUT_MS = 60_000;

/** Why a model request failed, so a timeout is never reported as a generic error. */
export type ModelFailureCode =
  | "budget_exhausted"
  | "deadline_exceeded"
  | "provider_timeout"
  | "provider_error";

export interface ModelBridgeOptions {
  registry: ModelProviderRegistry;
  selected: ModelConfig;
  budget: Budget;
  ledger: BudgetLedger;
  persistLedger(ledger: BudgetLedger): Promise<void>;
  /** The task's shared ledger; refusing a reservation ends the run as budget exhausted. */
  sharedBudget?: SharedBudget;
  env?: Record<string, string | undefined>;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  signal: AbortSignal;
  onFailure?(code: ModelFailureCode): void;
  /** OpenAI-compatible sampling seed forwarded on every request (non-negative safe integer). */
  seed?: number;
  /** Host paths of the agent workspace (canonical first); the model only sees `WORKSPACE_PLACEHOLDER`. */
  workspaceRoots?: readonly string[];
}

export function createModelBridge(options: ModelBridgeOptions) {
  const workspace = workspaceRedactor(options.workspaceRoots);
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
      // The bridge is the SDK provider; keep its reply ID across history rebuilds.
      responseId: crypto.randomUUID(),
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
        const request = toChatRequest(
          context,
          options.workspaceRoots
            ? { workspaceRoots: options.workspaceRoots }
            : {},
        );
        // Reserve conservatively before dispatch; retain reservations after ambiguous failures.
        const inputAllowance =
          Buffer.byteLength(JSON.stringify(request), "utf8") + 512;
        const remaining = budget.max_tokens - ledger.reserved_tokens;
        const outputCap = maxOutputTokens(selected);
        const maxTokens = Math.min(
          outputCap,
          streamOptions?.maxTokens ?? outputCap,
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
        if (exceedsUsd(ledger.reserved_usd + reservedCost, budget.max_usd))
          throw new ExecutionLimitError();
        if (options.sharedBudget) {
          try {
            await options.sharedBudget.reserve({
              tokens: ledger.reserved_tokens + inputAllowance + maxTokens,
              usd: ledger.reserved_usd + reservedCost,
            });
          } catch {
            throw new ExecutionLimitError();
          }
        }
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
        const requestTimeoutMs = Math.min(
          selected.requestTimeoutMs ?? DEFAULT_MODEL_REQUEST_TIMEOUT_MS,
          Math.max(1, ledger.deadline - Date.now()),
        );
        const router = new ModelRouter(options.registry, {
          adapterOptions: {
            ...(options.env ? { env: options.env } : {}),
            timeoutMs: requestTimeoutMs,
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
        const toolCalls: ToolCall[] = [];
        let done = false;
        stream.push({ type: "start", partial: output });
        const routed: OpenAICompatibleChatRequest = {
          ...request,
          maxTokens,
          ...(options.seed !== undefined ? { seed: options.seed } : {}),
        };
        for await (const event of router.stream(routed, {
          model: selected.id,
          require: { tools: !!context.tools?.length },
        })) {
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
            toolCalls.push({
              type: "toolCall",
              ...event.toolCall,
              arguments: redactValue(
                event.toolCall.arguments,
                workspace.restore,
              ) as typeof event.toolCall.arguments,
            });
          } else if (event.type === "error") {
            throw new Error("Provider stream failed.");
          } else if (event.type === "done") {
            if (done || event.response.content !== emittedText)
              throw new Error("Provider stream response mismatch.");
            const calls = toolCalls.map(({ id, name, arguments: args }) => ({
              id,
              name,
              arguments: args,
            }));
            if (
              JSON.stringify(calls) !==
              JSON.stringify(
                event.response.toolCalls.map((call) => ({
                  ...call,
                  arguments: redactValue(call.arguments, workspace.restore),
                })),
              )
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
            await options.sharedBudget
              ?.record({
                tokens: ledger.reserved_tokens,
                usd: ledger.reserved_usd,
              })
              .catch(() => undefined);
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
            output.stopReason =
              event.response.finishReason === "length" ||
              event.response.finishReason === "max_tokens"
                ? "length"
                : calls.length
                  ? "toolUse"
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
        // Even non-runnable tool blocks on a length stop make the SDK retry.
        if (output.stopReason === "toolUse") {
          for (const toolCall of toolCalls) {
            const index = output.content.length;
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
          }
        }
        stream.push({
          type: "done",
          reason: output.stopReason as "stop" | "length" | "toolUse",
          message: output,
        });
      } catch (error) {
        output.stopReason =
          options.signal.aborted || streamOptions?.signal?.aborted
            ? "aborted"
            : "error";
        if (output.stopReason === "error")
          options.onFailure?.(
            Date.now() >= ledger.deadline
              ? "deadline_exceeded"
              : error instanceof ExecutionLimitError
                ? "budget_exhausted"
                : (error as { timedOut?: unknown } | null)?.timedOut === true
                  ? "provider_timeout"
                  : "provider_error",
          );
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
      } finally {
        if (ownsReservation) busy = false;
        stream.end(output);
      }
    })();
    return stream;
  };
}
