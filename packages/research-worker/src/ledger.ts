import type { Budget } from "@mars/contracts";

export interface ModelUsage {
  input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
}

export type StopReason =
  | "deadline"
  | "budget_tokens"
  | "budget_usd"
  | "cancelled";

export type UsageReporter = (delta: ModelUsage) => Promise<void>;

export interface Reservation {
  tokens: number;
  usd: number;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4) + 8;
}

/**
 * Mirrors the control plane's usage ceiling inside the worker. Reservations
 * are taken synchronously before a model call is awaited so concurrent calls
 * cannot admit against the same balance, and prior usage from earlier leases
 * seeds the totals so retries never spend the allowance twice.
 */
export class UsageLedger {
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  model_calls = 0;
  reserved_tokens = 0;
  reserved_usd = 0;

  constructor(
    private readonly budget: Budget,
    private readonly deadlineMs: number,
    private readonly marginMs: number,
    private readonly now: () => number,
    private readonly report: UsageReporter,
    private readonly signal: AbortSignal,
    prior: ModelUsage = { input_tokens: 0, output_tokens: 0, cost_usd: 0 },
  ) {
    this.input_tokens = prior.input_tokens;
    this.output_tokens = prior.output_tokens;
    this.cost_usd = prior.cost_usd ?? 0;
  }

  get total_tokens(): number {
    return this.input_tokens + this.output_tokens;
  }

  timeRemainingMs(): number {
    return this.deadlineMs - this.marginMs - this.now();
  }

  stopReason(): StopReason | undefined {
    if (this.signal.aborted) return "cancelled";
    if (this.timeRemainingMs() <= 0) return "deadline";
    if (this.total_tokens >= this.budget.max_tokens) return "budget_tokens";
    if (this.cost_usd > 0 && this.cost_usd >= this.budget.max_usd) {
      return "budget_usd";
    }
    return undefined;
  }

  reserve(
    estimatedInputTokens: number,
    maxOutputTokens: number,
    estimatedCostUsd: number | null,
  ): Reservation | undefined {
    if (this.stopReason() !== undefined) return undefined;
    const tokens = estimatedInputTokens + maxOutputTokens;
    if (
      this.total_tokens + this.reserved_tokens + tokens >
      this.budget.max_tokens
    ) {
      return undefined;
    }
    if (estimatedCostUsd === null) return undefined;
    if (
      this.cost_usd + this.reserved_usd + estimatedCostUsd >
      this.budget.max_usd
    ) {
      return undefined;
    }
    this.reserved_tokens += tokens;
    this.reserved_usd += estimatedCostUsd;
    return { tokens, usd: estimatedCostUsd };
  }

  release(reservation: Reservation): void {
    this.reserved_tokens = Math.max(
      0,
      this.reserved_tokens - reservation.tokens,
    );
    this.reserved_usd = Math.max(0, this.reserved_usd - reservation.usd);
  }

  async settle(
    reservation: Reservation,
    usage: ModelUsage,
    report = true,
  ): Promise<void> {
    this.release(reservation);
    this.model_calls += 1;
    this.input_tokens += usage.input_tokens;
    this.output_tokens += usage.output_tokens;
    this.cost_usd += usage.cost_usd ?? 0;
    if (!report) return;
    await this.report({
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cost_usd: usage.cost_usd,
    });
  }
}
