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
  /**
   * Extra request headers merged after the provider's own headers. The
   * adapter still owns `Authorization`, so a caller cannot smuggle a credential
   * or override the configured one through this hook.
   */
  headers?: Record<string, string>;
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
