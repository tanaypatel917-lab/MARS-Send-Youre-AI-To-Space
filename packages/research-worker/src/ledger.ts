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

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4) + 8;
}

export class UsageLedger {
  input_tokens = 0;
  output_tokens = 0;
  cost_usd = 0;
  model_calls = 0;

  constructor(
    private readonly budget: Budget,
    private readonly deadlineMs: number,
    private readonly marginMs: number,
    private readonly now: () => number,
    private readonly report: UsageReporter,
    private readonly signal: AbortSignal,
  ) {}

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
    if (this.budget.max_usd > 0 && this.cost_usd >= this.budget.max_usd) {
      return "budget_usd";
    }
    return undefined;
  }

  canAfford(estimatedInputTokens: number, maxOutputTokens: number): boolean {
    return (
      this.stopReason() === undefined &&
      this.total_tokens + estimatedInputTokens + maxOutputTokens <=
        this.budget.max_tokens
    );
  }

  async record(usage: ModelUsage, report = true): Promise<void> {
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
