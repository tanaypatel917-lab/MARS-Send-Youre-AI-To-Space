import type { ClaimedAgentRequest, TeamAgentHostPort } from "@mars/team";
import type { TeamAgentRunResult } from "./run";

export interface TeamAgentWorkerOptions {
  host: TeamAgentHostPort;
  run(claimed: ClaimedAgentRequest): Promise<TeamAgentRunResult>;
  pollMs?: number;
  /** Operational notice only: never a body, a prompt or a path. */
  onError?(error: unknown): void;
}

export interface TeamAgentWorker {
  start(): void;
  /** Stops polling and waits for the in-flight request to finish. */
  stop(): Promise<void>;
  /** Runs every pending request once (tests and `mars serve` shutdown). */
  drain(): Promise<void>;
}

/**
 * The host-side driver of `TeamAgentHostPort`: claims pending requests one at
 * a time, runs them through the workbench adapter and stores the outcome. It is
 * the only caller of `complete`/`fail`; no client can reach them.
 */
export function createTeamAgentWorker(
  options: TeamAgentWorkerOptions,
): TeamAgentWorker {
  const pollMs = options.pollMs ?? 250;
  let stopped = true;
  let inFlight: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const settle = (claimed: ClaimedAgentRequest, result: TeamAgentRunResult) => {
    const id = claimed.request.request_id;
    if (result.status === "completed")
      options.host.complete(id, {
        answer_body: result.answer_body,
        citations: result.citations,
        dropped_citations: result.dropped_citations,
      });
    else options.host.fail(id, result.reason_code ?? result.status);
  };
  const runOne = async (): Promise<boolean> => {
    const claimed = options.host.claimNext();
    if (!claimed) return false;
    try {
      settle(claimed, await options.run(claimed));
    } catch (error) {
      try {
        options.host.fail(claimed.request.request_id, "worker_error");
      } catch {
        // The row may already be settled by a concurrent cancel.
      }
      options.onError?.(error);
    }
    return true;
  };
  const tick = async () => {
    if (stopped) return;
    inFlight = (async () => {
      try {
        while (!stopped && (await runOne())) {
          // keep draining while work is available
        }
      } catch (error) {
        options.onError?.(error);
      }
    })();
    await inFlight;
    if (!stopped) timer = setTimeout(() => void tick(), pollMs);
  };
  return {
    start() {
      if (!stopped) return;
      stopped = false;
      void tick();
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      await inFlight;
    },
    async drain() {
      await inFlight;
      while (await runOne()) {
        // run until the queue is empty
      }
    },
  };
}
