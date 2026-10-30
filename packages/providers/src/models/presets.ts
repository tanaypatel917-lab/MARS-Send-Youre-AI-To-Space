import type { ModelConfig, ProviderConfig } from "@mars/contracts";

export const BUILTIN_PROVIDERS: ProviderConfig[] = [
  {
    id: "openrouter",
    kind: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    docsUrl: "https://openrouter.ai/docs/api-reference/limits",
    freeTier: "Free models are rate-limited and may be unavailable or change.",
  },
  {
    id: "gemini",
    kind: "openai-compatible",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKeyEnv: "GEMINI_API_KEY",
    docsUrl: "https://ai.google.dev/gemini-api/docs/openai",
    freeTier: "Gemini API free tier; limits and availability may change.",
  },
  {
    id: "groq",
    kind: "openai-compatible",
    baseUrl: "https://api.groq.com/openai/v1",
    apiKeyEnv: "GROQ_API_KEY",
    docsUrl: "https://console.groq.com/docs/rate-limits",
    freeTier: "Groq free plan; rate limits and availability may change.",
  },
  {
    id: "github-models",
    kind: "openai-compatible",
    baseUrl: "https://models.github.ai/inference",
    apiKeyEnv: "GITHUB_TOKEN",
    docsUrl: "https://docs.github.com/en/github-models",
    freeTier: "Free prototyping tier; check GitHub terms and current limits.",
  },
  {
    id: "nvidia",
    kind: "openai-compatible",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    apiKeyEnv: "NVIDIA_API_KEY",
    docsUrl: "https://build.nvidia.com",
    freeTier: "Developer access; check NVIDIA terms and current availability.",
  },
  {
    id: "cerebras",
    kind: "openai-compatible",
    baseUrl: "https://api.cerebras.ai/v1",
    apiKeyEnv: "CEREBRAS_API_KEY",
    docsUrl: "https://inference-docs.cerebras.ai/support/rate-limits",
    freeTier: "Trial credits require a payment method; not free by default.",
    enabled: false,
  },
  {
    id: "ollama",
    kind: "openai-compatible",
    baseUrl: "http://localhost:11434/v1",
    docsUrl: "https://ollama.com",
    freeTier: "Local inference; no provider API key required.",
  },
];

export const BUILTIN_MODELS: ModelConfig[] = [
  {
    id: "openrouter/free",
    providerId: "openrouter",
    model: "openrouter/free",
    capabilities: { tools: true, vision: false, contextWindow: 200_000 },
    pricing: { free: true },
    tags: ["free", "router"],
  },
  {
    id: "google/gemma-4-31b-it:free",
    providerId: "openrouter",
    model: "google/gemma-4-31b-it:free",
    capabilities: { tools: true, vision: false, contextWindow: 262_144 },
    pricing: { free: true },
    tags: ["free"],
  },
  {
    id: "nvidia/nemotron-3.5-super-vl:free",
    providerId: "openrouter",
    model: "nvidia/nemotron-3.5-super-vl:free",
    capabilities: { tools: true, vision: true, contextWindow: 1_000_000 },
    pricing: { free: true },
    tags: ["free", "vision"],
  },
  {
    id: "poolside/laguna-s-2.1:free",
    providerId: "openrouter",
    model: "poolside/laguna-s-2.1:free",
    capabilities: { tools: true, vision: false, contextWindow: 262_144 },
    pricing: { free: true },
    tags: ["free"],
  },
];

export const BUILTIN_ROUTES: Record<string, string[]> = {
  default: BUILTIN_MODELS.map(({ id }) => id),
};
