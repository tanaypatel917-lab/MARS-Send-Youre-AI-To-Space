import type { ModelConfig } from "@mars/contracts";
import { selectExecutionModel } from "@mars/execution";
import { type ModelProviderRegistry, ModelRouter } from "@mars/providers";
import { estimateTokens, type ModelUsage } from "./ledger";
import type { FetchLike } from "./net";

export interface ModelRequest {
  system: string;
  user: string;
  maxTokens: number;
  timeoutMs: number;
  signal: AbortSignal;
}

export interface ModelReply {
  text: string;
  model: string;
  usage: ModelUsage;
  usage_estimated: boolean;
}

export interface ModelGateway {
  readonly id: string;
  complete(request: ModelRequest): Promise<ModelReply>;
  /** Worst-case USD for a call; omit for free gateways, null when unknown. */
  estimateCostUsd?(inputTokens: number, outputTokens: number): number | null;
}

export function estimateUsd(
  pricing: ModelConfig["pricing"],
  inputTokens: number,
  outputTokens: number,
): number | null {
  if (pricing.free) return 0;
  if (
    pricing.inputPerMTokUsd === undefined ||
    pricing.outputPerMTokUsd === undefined
  ) {
    return null;
  }
  return (
    (inputTokens * pricing.inputPerMTokUsd +
      outputTokens * pricing.outputPerMTokUsd) /
    1_000_000
  );
}

export interface RegistryModelGatewayOptions {
  registry: ModelProviderRegistry;
  model?: string;
  paidConsent?: boolean;
  fetch?: FetchLike;
  env?: Record<string, string | undefined>;
}

export class PaidModelConsentError extends Error {
  constructor(modelId: string) {
    super(
      `Model "${modelId}" is not free; set paid_consent to allow paid research.`,
    );
    this.name = "PaidModelConsentError";
  }
}

export function createRegistryModelGateway(
  options: RegistryModelGatewayOptions,
): ModelGateway {
  const selected = selectExecutionModel(options.registry, options.model, false);
  if (!selected.pricing.free && !options.paidConsent) {
    throw new PaidModelConsentError(selected.id);
  }
  const pricing = selected.pricing;
  return {
    id: `registry:${selected.id}`,
    estimateCostUsd: (inputTokens, outputTokens) =>
      estimateUsd(pricing, inputTokens, outputTokens),
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
      const reported = response.usage;
      const input_tokens =
        reported?.inputTokens ??
        estimateTokens(request.system) + estimateTokens(request.user);
      const output_tokens =
        reported?.outputTokens ?? estimateTokens(response.content);
      const cost_usd = estimateUsd(pricing, input_tokens, output_tokens);
      return {
        text: response.content,
        model: response.model,
        usage: { input_tokens, output_tokens, cost_usd },
        usage_estimated: reported === undefined,
      };
    },
  };
}
