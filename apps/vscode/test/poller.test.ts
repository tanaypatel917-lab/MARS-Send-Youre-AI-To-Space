import { describe, expect, test } from "bun:test";
import type { EventEnvelope } from "@mars/contracts";
import { EventPoller, type PollerStatus } from "../src/poller";
import { RpcError } from "../src/rpc";
import { flush, makeEvent } from "./fixtures";

/** Manual sleep: records requested delays and resolves only when released or aborted. */
function manualSleep() {
  const delays: number[] = [];
  let release: (() => void) | undefined;
  const sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      delays.push(ms);
      release = resolve;
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  return { delays, sleep, tick: () => release?.() };
}

describe("EventPoller", () => {
  test("advances the cursor, deduplicates and never overlaps readers", async () => {
    const batches: EventEnvelope[][] = [
      [makeEvent("e1"), makeEvent("e2")],
      [makeEvent("e2"), makeEvent("e3")],
      [],
    ];
    const cursors: Array<string | undefined> = [];
    let active = 0;
    let maxActive = 0;
    const received: string[] = [];
    const clock = manualSleep();
    const poller = new EventPoller({
      fetchBatch: async (after) => {
        active++;
        maxActive = Math.max(maxActive, active);
        cursors.push(after);
        await flush(1);
        active--;
        return batches.shift() ?? [];
      },
      onEvents: (events) => received.push(...events.map((e) => e.event_id)),
      sleep: clock.sleep,
      minDelayMs: 100,
      maxDelayMs: 400,
    });
    const loop = poller.start();
    expect(poller.start()).toBe(loop);
    for (let i = 0; i < 3; i++) {
      await flush();
      poller.poke();
      clock.tick();
    }
    await flush();
    poller.dispose();
    await loop;
    expect(maxActive).toBe(1);
    expect(cursors.slice(0, 3)).toEqual([undefined, "e2", "e3"]);
    expect(received).toEqual(["e1", "e2", "e3"]);
    expect(poller.cursor).toBe("e3");
  });

  test("backs off exponentially while idle, bounded by maxDelayMs", async () => {
    const clock = manualSleep();
    const poller = new EventPoller({
      fetchBatch: async () => [],
      onEvents: () => {},
      sleep: clock.sleep,
      minDelayMs: 100,
      maxDelayMs: 500,
    });
    const loop = poller.start();
    for (let i = 0; i < 5; i++) {
      await flush();
      clock.tick();
    }
    await flush();
    poller.dispose();
    await loop;
    expect(clock.delays.slice(0, 5)).toEqual([200, 400, 500, 500, 500]);
  });

  test("dispose aborts the in-flight read and reports stopped", async () => {
    let signalSeen: AbortSignal | undefined;
    const statuses: PollerStatus[] = [];
    const poller = new EventPoller({
      fetchBatch: (_after, signal) => {
        signalSeen = signal;
        return new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () =>
            reject(new RpcError("cancelled", "x")),
          ),
        );
      },
      onEvents: () => {
        throw new Error("no events expected");
      },
      onStatus: (status) => statuses.push(status),
    });
    const loop = poller.start();
    await flush();
    poller.dispose();
    await loop;
    expect(signalSeen?.aborted).toBe(true);
    expect(statuses).toEqual(["stopped"]);
    expect(poller.disposed).toBe(true);
  });

  test("stops on fatal errors and when the task can no longer produce events", async () => {
    const statuses: Array<[PollerStatus, string | undefined]> = [];
    const fatal = new EventPoller({
      fetchBatch: async () => {
        throw new RpcError("unauthorized", "bad token");
      },
      onEvents: () => {},
      onStatus: (status, error) => statuses.push([status, error?.kind]),
    });
    await fatal.start();
    expect(statuses).toEqual([
      ["error", "unauthorized"],
      ["stopped", undefined],
    ]);

    let calls = 0;
    const finished = new EventPoller({
      fetchBatch: async () => {
        calls++;
        return [];
      },
      onEvents: () => {},
      shouldContinue: () => false,
    });
    await finished.start();
    expect(calls).toBe(1);
  });

  test("transient errors back off and retry", async () => {
    const clock = manualSleep();
    let calls = 0;
    const poller = new EventPoller({
      fetchBatch: async () => {
        calls++;
        if (calls === 1) throw new RpcError("disconnected", "down");
        return [makeEvent("e1")];
      },
      onEvents: () => {},
      sleep: clock.sleep,
      minDelayMs: 100,
    });
    const loop = poller.start();
    await flush();
    clock.tick();
    await flush();
    poller.dispose();
    await loop;
    expect(calls).toBe(2);
    expect(clock.delays[0]).toBe(200);
    expect(clock.delays[1]).toBe(100);
  });
});
