import type { RoutingAttempt } from "@mars/contracts";

export interface ProviderErrorOptions {
  status?: number;
  retryable: boolean;
  retryAfterMs?: number;
  cause?: unknown;
}

export class ProviderError extends Error {
  readonly providerId: string;
  readonly status: number | undefined;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(
    providerId: string,
    message: string,
    options: ProviderErrorOptions,
  ) {
    super(message, { cause: options.cause });
    this.name = "ProviderError";
    this.providerId = providerId;
    this.status = options.status;
    this.retryable = options.retryable;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export interface SkippedModel {
  modelId: string;
  reason: string;
}

export class NoModelAvailableError extends Error {
  readonly skipped: SkippedModel[];
  readonly attempts: RoutingAttempt[];

  constructor(skipped: SkippedModel[], attempts: RoutingAttempt[] = []) {
    const details = skipped.length
      ? skipped.map(({ modelId, reason }) => `${modelId}: ${reason}`).join("; ")
      : "no candidates configured";
    super(`No model available (${details})`);
    this.name = "NoModelAvailableError";
    this.skipped = skipped;
    this.attempts = attempts;
  }
}
