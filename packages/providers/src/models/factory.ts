import type { ProviderConfig } from "@mars/contracts";
import type { AdapterOptions, ProviderAdapter } from "./adapter-types";
import { createAnthropicAdapter } from "./anthropic";
import { createOpenAICompatibleAdapter } from "./openai-compatible";

export function createProviderAdapter(
  provider: ProviderConfig,
  options?: AdapterOptions,
): ProviderAdapter {
  return provider.kind === "anthropic"
    ? createAnthropicAdapter(provider, options)
    : createOpenAICompatibleAdapter(provider, options);
}
