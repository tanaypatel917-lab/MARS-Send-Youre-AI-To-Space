export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

export const defaultSleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

export class HostRateLimiter {
  private readonly nextAllowedAt = new Map<string, number>();

  constructor(
    private readonly minIntervalMs: number,
    private readonly now: () => number,
    private readonly sleep: Sleep,
  ) {}

  async acquire(
    host: string,
    extraDelayMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    const interval = Math.max(this.minIntervalMs, extraDelayMs);
    const earliest = this.nextAllowedAt.get(host) ?? 0;
    const current = this.now();
    const start = Math.max(current, earliest);
    this.nextAllowedAt.set(host, start + interval);
    if (start > current) await this.sleep(start - current, signal);
  }
}
