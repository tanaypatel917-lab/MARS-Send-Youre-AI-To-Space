import type {
  ChatRequest,
  ChatResponse,
  ModelConfig,
  ProviderConfig,
  StreamEvent,
} from "@mars/contracts";

export interface AdapterOptions {
  env?: Record<string, string | undefined>;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
}

export interface ProviderAdapter {
  complete(request: ChatRequest, model: ModelConfig): Promise<ChatResponse>;
  stream(request: ChatRequest, model: ModelConfig): AsyncIterable<StreamEvent>;
  listModels?(): Promise<unknown[]>;
}

export type AdapterFactory = (
  provider: ProviderConfig,
  options?: AdapterOptions,
) => ProviderAdapter;
