import { selectExecutionModel } from "@mars/execution";
import {
  type ModelProviderRegistry,
  ModelRouter,
  NoModelAvailableError,
  ProviderError,
} from "@mars/providers";

export interface ReviewModelRequest {
  system: string;
  user: string;
  maxTokens: number;
  timeoutMs: number;
  signal: AbortSignal;
}
export interface ReviewModelReply {
  text: string;
  model: string;
  finishReason: string | null;
  toolCalls: number;
}
/**
 * The only model surface the review runner sees. Offline tests inject a fake;
 * production uses `createRegistryReviewGateway`, which routes through the
 * shared provider registry (free-first, never paid without explicit consent).
 */
export interface ReviewModelGateway {
  readonly id: string;
  complete(request: ReviewModelRequest): Promise<ReviewModelReply>;
}
const RATE_LIMIT_TEXT = /HTTP 429|rate.?limit|too.?many.?requests|quota/i;
/**
 * `ModelRouter` retries retryable failures itself and surfaces an exhausted
 * route as `NoModelAvailableError` with the attempts; a 429 on the selected
 * model therefore arrives either directly or inside those attempts.
 */
export function isRateLimit(error: unknown): boolean {
  if (error instanceof ProviderError)
    return error.status === 429 || RATE_LIMIT_TEXT.test(error.message);
  if (error instanceof NoModelAvailableError)
    return (
      error.attempts.length > 0 &&
      error.attempts.every((attempt) => RATE_LIMIT_TEXT.test(attempt.error))
    );
  return false;
}
export class ReviewRateLimit extends Error {
  constructor() {
    super("Review model rate limited");
    this.name = "ReviewRateLimit";
  }
}
export interface RegistryReviewGatewayOptions {
  registry: ModelProviderRegistry;
  model?: string;
  env?: Record<string, string | undefined>;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}
export function createRegistryReviewGateway(
  options: RegistryReviewGatewayOptions,
): ReviewModelGateway {
  const selected = selectExecutionModel(options.registry, options.model, false);
  if (!selected.pricing.free)
    throw new Error(
      `Background review only uses free models; "${selected.id}" is paid.`,
    );
  return {
    id: `registry:${selected.id}`,
    async complete(request) {
      const router = new ModelRouter(options.registry, {
        adapterOptions: {
          ...(options.env ? { env: options.env } : {}),
          timeoutMs: Math.max(1, request.timeoutMs),
          fetch: (input, init) =>
            (options.fetch ?? fetch)(input, {
              ...init,
              signal: AbortSignal.any([
                request.signal,
                ...(init?.signal ? [init.signal] : []),
              ]),
            }),
        },
      });
      try {
        const response = await router.complete(
          {
            messages: [
              { role: "system", content: request.system },
              { role: "user", content: request.user },
            ],
            maxTokens: request.maxTokens,
            temperature: 0,
          },
          { model: selected.id },
        );
        return {
          text: response.content,
          model: response.model,
          finishReason: response.finishReason,
          toolCalls: response.toolCalls.length,
        };
      } catch (error) {
        if (isRateLimit(error)) throw new ReviewRateLimit();
        throw error;
      }
    },
  };
}
