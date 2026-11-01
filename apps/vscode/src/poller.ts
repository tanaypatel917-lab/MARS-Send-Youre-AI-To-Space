import type { EventEnvelope } from "@mars/contracts";
import { RpcError } from "./rpc";

export type PollerStatus = "active" | "idle" | "error" | "stopped";

export interface PollerOptions {
  fetchBatch(
    afterEventId: string | undefined,
    signal: AbortSignal,
  ): Promise<EventEnvelope[]>;
  onEvents(events: EventEnvelope[]): void;
  onStatus?(status: PollerStatus, error?: RpcError): void;
  /** Return false to stop once the task can no longer produce events. */
  shouldContinue?(): boolean;
  minDelayMs?: number;
  maxDelayMs?: number;
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
}

const FATAL = new Set(["unauthorized", "forbidden", "not-found", "no-token"]);

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Polls one task's finite incremental event batches with a single reader,
 * exponential backoff while idle or failing, and cancellation on dispose.
 */
export class EventPoller {
  private readonly controller = new AbortController();
  private wake: AbortController | undefined;
  private loop: Promise<void> | undefined;
  private lastId: string | undefined;
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];
  private readonly min: number;
  private readonly max: number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;

  constructor(
    private readonly options: PollerOptions,
    afterEventId?: string,
  ) {
    this.lastId = afterEventId;
    this.min = Math.max(50, options.minDelayMs ?? 500);
    this.max = Math.max(this.min, options.maxDelayMs ?? 10_000);
    this.sleep = options.sleep ?? abortableSleep;
  }

  get cursor(): string | undefined {
    return this.lastId;
  }

  get disposed(): boolean {
    return this.controller.signal.aborted;
  }

  /** Starts the single reader loop; repeated calls return the same loop. */
  start(): Promise<void> {
    this.loop ??= this.run();
    return this.loop;
  }

  /** Ends the current backoff early, e.g. after the user steers the task. */
  poke(): void {
    this.wake?.abort();
  }

  dispose(): void {
    if (this.disposed) return;
    this.controller.abort();
    this.wake?.abort();
  }

  private remember(id: string): boolean {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    this.seenOrder.push(id);
    if (this.seenOrder.length > 5000) {
      const old = this.seenOrder.shift();
      if (old !== undefined) this.seen.delete(old);
    }
    return true;
  }

  private async run(): Promise<void> {
    const signal = this.controller.signal;
    let delay = this.min;
    while (!signal.aborted) {
      try {
        const batch = await this.options.fetchBatch(this.lastId, signal);
        if (signal.aborted) break;
        const fresh = batch.filter((event) => this.remember(event.event_id));
        const last = batch.at(-1);
        if (last) this.lastId = last.event_id;
        if (fresh.length > 0) {
          this.options.onEvents(fresh);
          delay = this.min;
          this.options.onStatus?.("active");
        } else {
          if (this.options.shouldContinue && !this.options.shouldContinue())
            break;
          delay = Math.min(delay * 2, this.max);
          this.options.onStatus?.("idle");
        }
      } catch (error) {
        if (signal.aborted) break;
        const rpc =
          error instanceof RpcError
            ? error
            : new RpcError("protocol", "Event polling failed.");
        this.options.onStatus?.("error", rpc);
        if (FATAL.has(rpc.kind)) break;
        delay = Math.min(delay * 2, this.max);
      }
      this.wake = new AbortController();
      const both = AbortSignal.any([signal, this.wake.signal]);
      await this.sleep(delay, both);
      this.wake = undefined;
    }
    this.options.onStatus?.("stopped");
  }
}
