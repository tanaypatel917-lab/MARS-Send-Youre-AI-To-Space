import type {
  ChatRequest,
  ChatResponse,
  ModelConfig,
  RoutingAttempt,
  RoutingInfo,
  StreamEvent,
} from "@mars/contracts";
import type { AdapterFactory, AdapterOptions } from "./adapter-types";
import {
  NoModelAvailableError,
  ProviderError,
  type SkippedModel,
} from "./errors";
import { createProviderAdapter } from "./factory";
import type { ModelProviderRegistry } from "./registry";

export interface ModelRequirements {
  tools?: boolean;
  vision?: boolean;
  minContext?: number;
}

export interface ModelSelection {
  model?: string;
  route?: string;
  require?: ModelRequirements;
}

export interface ModelRouterOptions {
  adapterFactory?: AdapterFactory;
  adapterOptions?: AdapterOptions;
  now?: () => number;
}

interface CandidateSet {
  models: ModelConfig[];
  skipped: SkippedModel[];
}

export type RoutedChatResponse = ChatResponse & { routing: RoutingInfo };

export class ModelRouter {
  private readonly cooldowns = new Map<string, number>();
  private readonly adapterFactory: AdapterFactory;
  private readonly adapterOptions: AdapterOptions;
  private readonly now: () => number;

  constructor(
    private readonly registry: ModelProviderRegistry,
    options: ModelRouterOptions = {},
  ) {
    this.adapterFactory = options.adapterFactory ?? createProviderAdapter;
    this.adapterOptions = options.adapterOptions ?? {};
    this.now = options.now ?? Date.now;
  }

  private candidates(selection: ModelSelection = {}): CandidateSet {
    const skipped: SkippedModel[] = [];
    const routeName = selection.route ?? "default";
    const ids = selection.model
      ? [selection.model]
      : this.registry.routes[routeName];
    if (!ids) {
      return {
        models: [],
        skipped: [{ modelId: routeName, reason: "Route is not configured." }],
      };
    }

    const models: ModelConfig[] = [];
    for (const id of ids) {
      const model = this.registry.getModel(id);
      if (!model) {
        skipped.push({ modelId: id, reason: "Model is not configured." });
        continue;
      }
      if (selection.require?.tools && !model.capabilities.tools) {
        skipped.push({ modelId: id, reason: "Model does not support tools." });
        continue;
      }
      if (selection.require?.vision && !model.capabilities.vision) {
        skipped.push({ modelId: id, reason: "Model does not support vision." });
        continue;
      }
      if (
        selection.require?.minContext !== undefined &&
        model.capabilities.contextWindow < selection.require.minContext
      ) {
        skipped.push({
          modelId: id,
          reason: `Context window is below ${selection.require.minContext}.`,
        });
        continue;
      }
      if (!this.registry.policy.allowPaid && !model.pricing.free) {
        skipped.push({
          modelId: id,
          reason: "Paid model skipped by allowPaid=false policy.",
        });
        continue;
      }
      const provider = this.registry.getProvider(model.providerId);
      const unavailable = this.registry.unavailableReason(model.providerId);
      if (!provider || unavailable) {
        skipped.push({
          modelId: id,
          reason: unavailable ?? "Provider is not configured.",
        });
        continue;
      }
      const cooldownUntil = this.cooldowns.get(provider.id);
      if (cooldownUntil !== undefined && cooldownUntil > this.now()) {
        skipped.push({
          modelId: id,
          reason: `Provider is cooling down for ${cooldownUntil - this.now()}ms.`,
        });
        continue;
      }
      models.push(model);
    }
    return { models, skipped };
  }

  private adapterFor(model: ModelConfig) {
    const provider = this.registry.getProvider(model.providerId);
    if (!provider)
      throw new Error(`Provider "${model.providerId}" is not configured.`);
    return this.adapterFactory(provider, {
      env: this.registry.getProviderEnvironment(provider.id),
      ...this.adapterOptions,
    });
  }

  private handleProviderError(
    model: ModelConfig,
    error: unknown,
    attempts: RoutingAttempt[],
  ): ProviderError {
    const providerError =
      error instanceof ProviderError
        ? error
        : new ProviderError(model.providerId, "Provider request failed.", {
            retryable: false,
          });
    attempts.push({
      modelId: model.id,
      error: providerError.message,
    });
    if (providerError.retryable) {
      this.cooldowns.set(
        model.providerId,
        this.now() + (providerError.retryAfterMs ?? 30_000),
      );
    }
    return providerError;
  }

  private noModelAvailable(
    skipped: SkippedModel[],
    attempts: RoutingAttempt[],
  ): NoModelAvailableError {
    return new NoModelAvailableError(
      [
        ...skipped,
        ...attempts.map(({ modelId, error }) => ({
          modelId,
          reason: `Provider attempt failed: ${error}`,
        })),
      ],
      attempts,
    );
  }

  async complete(
    request: ChatRequest,
    selection: ModelSelection = {},
  ): Promise<RoutedChatResponse> {
    const { models, skipped } = this.candidates(selection);
    if (!models.length) throw this.noModelAvailable(skipped, []);

    const attempts: RoutingAttempt[] = [];
    for (const model of models) {
      const cooldownUntil = this.cooldowns.get(model.providerId);
      if (cooldownUntil !== undefined && cooldownUntil > this.now()) {
        skipped.push({
          modelId: model.id,
          reason: `Provider is cooling down for ${cooldownUntil - this.now()}ms.`,
        });
        continue;
      }
      try {
        const response = await this.adapterFor(model).complete(request, model);
        return {
          ...response,
          routing: {
            selected: model.id,
            reason:
              attempts.length > 0
                ? `Fallback after ${attempts.length} retryable provider failure(s).`
                : `Selected from ${selection.model ? "explicit model" : `route "${selection.route ?? "default"}"`}.`,
            attempts,
          },
        };
      } catch (error) {
        const providerError = this.handleProviderError(model, error, attempts);
        if (!providerError.retryable) throw providerError;
      }
    }
    throw this.noModelAvailable(skipped, attempts);
  }

  async *stream(
    request: ChatRequest,
    selection: ModelSelection = {},
  ): AsyncGenerator<StreamEvent> {
    const { models, skipped } = this.candidates(selection);
    if (!models.length) throw this.noModelAvailable(skipped, []);

    const attempts: RoutingAttempt[] = [];
    for (const model of models) {
      const cooldownUntil = this.cooldowns.get(model.providerId);
      if (cooldownUntil !== undefined && cooldownUntil > this.now()) {
        skipped.push({
          modelId: model.id,
          reason: `Provider is cooling down for ${cooldownUntil - this.now()}ms.`,
        });
        continue;
      }
      let emitted = false;
      try {
        for await (const event of this.adapterFor(model).stream(
          request,
          model,
        )) {
          emitted = true;
          if (event.type === "done") {
            const routing: RoutingInfo = {
              selected: model.id,
              reason:
                attempts.length > 0
                  ? `Fallback after ${attempts.length} retryable provider failure(s).`
                  : `Selected from ${selection.model ? "explicit model" : `route "${selection.route ?? "default"}"`}.`,
              attempts,
            };
            yield { ...event, routing };
          } else {
            yield event;
          }
        }
        return;
      } catch (error) {
        const providerError = this.handleProviderError(model, error, attempts);
        if (!providerError.retryable || emitted) throw providerError;
      }
    }
    throw this.noModelAvailable(skipped, attempts);
  }
}
