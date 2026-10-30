import { z } from "zod";

const id = z.string().min(1);
const textPart = z
  .object({ type: z.literal("text"), text: z.string() })
  .strict();
const messageContent = z.union([z.string(), z.array(textPart)]);

export const ProviderConfigSchema = z
  .object({
    id,
    kind: z.enum(["openai-compatible", "anthropic"]),
    baseUrl: z.string().url(),
    apiKeyEnv: z.string().min(1).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    docsUrl: z.string().url().optional(),
    freeTier: z.string().optional(),
    enabled: z.boolean().optional(),
  })
  .strict(
    "Unknown provider field. Never store an API key value; store its environment variable name in apiKeyEnv.",
  )
  .superRefine((provider, context) => {
    for (const name of Object.keys(provider.headers ?? {})) {
      if (/^(authorization|x-api-key|api-key)$/i.test(name)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["headers", name],
          message:
            "Store credentials in an environment variable and use apiKeyEnv.",
        });
      }
    }
  });
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export const ModelConfigSchema = z
  .object({
    id,
    providerId: id,
    model: id,
    capabilities: z
      .object({
        tools: z.boolean(),
        vision: z.boolean(),
        contextWindow: z.number().int().positive(),
        reasoning: z.boolean().optional(),
      })
      .strict(),
    pricing: z
      .object({
        free: z.boolean(),
        inputPerMTokUsd: z.number().finite().nonnegative().optional(),
        outputPerMTokUsd: z.number().finite().nonnegative().optional(),
      })
      .strict(),
    tags: z.array(z.string()).optional(),
  })
  .strict();
export type ModelConfig = z.infer<typeof ModelConfigSchema>;

export const ModelsFileSchema = z
  .object({
    version: z.literal(1),
    providers: z.array(ProviderConfigSchema),
    models: z.array(ModelConfigSchema),
    routes: z.record(z.string(), z.array(id)).optional(),
    policy: z
      .object({ allowPaid: z.boolean().default(false) })
      .strict()
      .default({ allowPaid: false }),
  })
  .strict();
export type ModelsFile = z.infer<typeof ModelsFileSchema>;

const toolCall = z
  .object({
    id,
    name: id,
    arguments: z.record(z.string(), z.unknown()),
  })
  .strict();
export type ChatToolCall = z.infer<typeof toolCall>;

export const ChatMessageSchema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("system"), content: messageContent }).strict(),
  z.object({ role: z.literal("user"), content: messageContent }).strict(),
  z
    .object({
      role: z.literal("assistant"),
      content: messageContent.nullable().optional(),
      tool_calls: z.array(toolCall).optional(),
    })
    .strict(),
  z
    .object({
      role: z.literal("tool"),
      content: messageContent,
      tool_call_id: id,
    })
    .strict(),
]);
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ToolDefinitionSchema = z
  .object({
    name: id,
    description: z.string(),
    parameters: z.record(z.string(), z.unknown()),
  })
  .strict();
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;

export const ChatRequestSchema = z
  .object({
    messages: z.array(ChatMessageSchema).min(1),
    tools: z.array(ToolDefinitionSchema).optional(),
    temperature: z.number().finite().min(0).max(2).optional(),
    maxTokens: z.number().int().positive().optional(),
    stream: z.boolean().optional(),
  })
  .strict();
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export const ChatResponseSchema = z
  .object({
    content: z.string(),
    toolCalls: z.array(toolCall),
    finishReason: z.string().nullable(),
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    model: id,
    providerId: id,
  })
  .strict();
export type ChatResponse = z.infer<typeof ChatResponseSchema>;

export const RoutingAttemptSchema = z
  .object({
    modelId: id,
    error: z.string(),
  })
  .strict();
export type RoutingAttempt = z.infer<typeof RoutingAttemptSchema>;

export const RoutingInfoSchema = z
  .object({
    selected: id,
    reason: z.string(),
    attempts: z.array(RoutingAttemptSchema),
  })
  .strict();
export type RoutingInfo = z.infer<typeof RoutingInfoSchema>;

export const StreamEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text-delta"), text: z.string() }).strict(),
  z.object({ type: z.literal("tool-call"), toolCall }).strict(),
  z
    .object({
      type: z.literal("done"),
      response: ChatResponseSchema,
      routing: RoutingInfoSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("error"),
      error: z.string(),
      retryable: z.boolean(),
    })
    .strict(),
]);
export type StreamEvent = z.infer<typeof StreamEventSchema>;
