import type { ModelConfig, ProviderConfig } from "@mars/contracts";
import type { AdapterOptions } from "./adapter-types";
import { createOpenAICompatibleAdapter } from "./openai-compatible";

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function parsePrice(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  if (typeof value === "string" && value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function numericPrice(value: unknown): number | undefined {
  const parsed = parsePrice(value);
  return parsed === undefined ? undefined : parsed * 1_000_000;
}

export async function discoverModels(
  provider: ProviderConfig,
  options: AdapterOptions = {},
): Promise<ModelConfig[]> {
  if (provider.kind !== "openai-compatible") {
    throw new Error(
      `Model discovery is not supported for provider "${provider.id}".`,
    );
  }
  const rawModels = await createOpenAICompatibleAdapter(
    provider,
    options,
  ).listModels?.();
  if (!rawModels) return [];

  return rawModels.flatMap((rawModel) => {
    const item = asObject(rawModel);
    if (typeof item.id !== "string" || !item.id) return [];
    const contextLength = Number(item.context_length);
    const architecture = asObject(item.architecture);
    const supportedParameters = Array.isArray(item.supported_parameters)
      ? item.supported_parameters
      : Array.isArray(architecture.supported_parameters)
        ? architecture.supported_parameters
        : [];
    const modality =
      typeof architecture.modality === "string" ? architecture.modality : "";
    const inputModalities = Array.isArray(architecture.input_modalities)
      ? architecture.input_modalities
      : [];
    const pricing = asObject(item.pricing);
    const promptPrice = parsePrice(pricing.prompt);
    const completionPrice = parsePrice(pricing.completion);
    const optionalPriceFields = ["request", "image"].filter((field) =>
      Object.hasOwn(pricing, field),
    );
    const free =
      promptPrice === 0 &&
      completionPrice === 0 &&
      optionalPriceFields.every((field) => parsePrice(pricing[field]) === 0);
    const inputPerMTokUsd = numericPrice(pricing.prompt);
    const outputPerMTokUsd = numericPrice(pricing.completion);
    return [
      {
        id: item.id,
        providerId: provider.id,
        model: item.id,
        capabilities: {
          tools: supportedParameters.includes("tools"),
          vision:
            modality.includes("image") || inputModalities.includes("image"),
          contextWindow:
            Number.isSafeInteger(contextLength) && contextLength > 0
              ? contextLength
              : 8192,
        },
        pricing: {
          free,
          ...(inputPerMTokUsd !== undefined ? { inputPerMTokUsd } : {}),
          ...(outputPerMTokUsd !== undefined ? { outputPerMTokUsd } : {}),
        },
        tags: free ? ["free"] : [],
      },
    ];
  });
}
