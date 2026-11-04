import { isRpcError, RpcError } from "../rpc";
import type { TeamClient } from "./client";
import type { TeamRealtimeSource } from "./controller";
import type { TeamConnectionState } from "./messages";
import {
  MAX_POLL_CURSORS,
  MAX_POLL_LIMIT,
  type PollCursor,
  type StreamClose,
  StreamCloseSchema,
  type TeamEvent,
  TeamEventSchema,
} from "./protocol";

/** Minimal streaming fetch shape so tests can stub the SSE endpoint offline. */
export type StreamFetchLike = (
  input: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
    redirect: "error";
  },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
}>;

export interface TeamRealtimeOptions {
  client: TeamClient;
  /** `POST /v1/stream` URL, or null to poll only. */
  streamUrl: string | null;
  /** Whether `team.describe` advertised the stream; re-read on every connect. */
  streamSupported: () => boolean;
  getToken: () => Promise<string | undefined>;
  onEvent: (event: TeamEvent) => Promise<void> | void;
  onStatus: (state: TeamConnectionState) => Promise<void> | void;
  /** The server denied a cursor (membership revoked): the owner should re-list the inbox. */
  onResync: () => Promise<void> | void;
  /** Test hook: sees each caught failure before the backoff. */
  onError?: (error: unknown) => void;
  fetch?: StreamFetchLike;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  minDelayMs?: number;
  maxDelayMs?: number;
  pollIntervalMs?: number;
}

const FATAL = new Set(["unauthorized", "no-token"]);
const MAX_SSE_BUFFER = 64 * 1024;

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
 * Follows delivery events for the viewer's conversations. Prefers the SSE
 * stream when the server advertises it and falls back to `events.poll`
 * otherwise (or after a stream failure). Cursors are kept per conversation
 * so a reconnect resumes where it stopped; a new conversation is primed
 * through one poll from cursor 0 without notifying, so history is not
 * replayed as "new". Backoff mirrors `EventPoller`: doubling from
 * `minDelayMs` to `maxDelayMs`, fatal on an authentication failure.
 */
export class TeamRealtime implements TeamRealtimeSource {
  private readonly cursors = new Map<string, number>();
  private readonly primed = new Set<string>();
  private readonly sleepImpl: (
    ms: number,
    signal: AbortSignal,
  ) => Promise<void>;
  private readonly min: number;
  private readonly max: number;
  private readonly pollInterval: number;
  private abort = new AbortController();
  private running: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private stopped = false;
  private streamBroken = false;
  private state: TeamConnectionState = "offline";

  constructor(private readonly options: TeamRealtimeOptions) {
    this.sleepImpl = options.sleep ?? abortableSleep;
    this.min = options.minDelayMs ?? 500;
    this.max = options.maxDelayMs ?? 10_000;
    this.pollInterval = options.pollIntervalMs ?? 2_000;
  }

  get connection(): TeamConnectionState {
    return this.state;
  }

  subscribe(conversationIds: readonly string[]): void {
    if (this.stopped) return;
    const wanted = new Set(conversationIds.slice(0, MAX_POLL_CURSORS));
    for (const id of [...this.cursors.keys()])
      if (!wanted.has(id)) {
        this.cursors.delete(id);
        this.primed.delete(id);
      }
    let changed = false;
    for (const id of wanted)
      if (!this.cursors.has(id)) {
        this.cursors.set(id, 0);
        changed = true;
      }
    if (this.cursors.size === 0) {
      this.interrupt();
      return;
    }
    if (!this.running) this.running = this.loop();
    else if (changed) this.interrupt();
  }

  stop(): void {
    this.stopped = true;
    this.interrupt();
    this.cursors.clear();
    this.primed.clear();
  }

  /** Resolves when the loop has exited (tests). */
  async settled(): Promise<void> {
    await this.running;
  }

  private interrupt(): void {
    this.abort.abort();
    this.abort = new AbortController();
    this.wake?.();
  }

  private async setState(state: TeamConnectionState): Promise<void> {
    if (this.state === state) return;
    this.state = state;
    await this.options.onStatus(state);
  }

  private cursorList(): PollCursor[] {
    return [...this.cursors.entries()].map(([conversation_id, after]) => ({
      conversation_id,
      after_event_seq: after,
    }));
  }

  private async deliver(event: TeamEvent): Promise<boolean> {
    const current = this.cursors.get(event.conversation_id);
    if (current === undefined || event.event_seq <= current) return false;
    this.cursors.set(event.conversation_id, event.event_seq);
    if (this.primed.has(event.conversation_id))
      await this.options.onEvent(event);
    return true;
  }

  private async loop(): Promise<void> {
    let delay = this.min;
    while (!this.stopped) {
      if (this.cursors.size === 0) {
        await this.setState("offline");
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
        this.wake = null;
        continue;
      }
      const signal = this.abort.signal;
      try {
        await this.setState("connecting");
        await this.prime(signal);
        if (
          this.options.streamUrl &&
          !this.streamBroken &&
          this.options.streamSupported()
        ) {
          await this.stream(this.options.streamUrl, signal);
        } else {
          await this.poll(signal);
        }
        delay = this.min;
      } catch (error) {
        if (signal.aborted || this.stopped) continue;
        this.options.onError?.(error);
        if (isRpcError(error)) {
          const rpc = error as RpcError;
          if (FATAL.has(rpc.kind)) {
            await this.setState("unauthenticated");
            await new Promise<void>((resolve) => {
              this.wake = resolve;
            });
            this.wake = null;
            delay = this.min;
            continue;
          }
          if (rpc.kind === "not-found" || rpc.kind === "forbidden") {
            // One of the cursors is no longer ours; let the owner re-list and
            // resubscribe, which drops the revoked conversation.
            await this.options.onResync();
          }
        }
        await this.setState("retrying");
        await this.sleepImpl(delay, signal);
        delay = Math.min(delay * 2, this.max);
      }
    }
    await this.setState("offline");
  }

  /** Advances new conversations from cursor 0 to the present without notifying. */
  private async prime(signal: AbortSignal): Promise<void> {
    const fresh = this.cursorList().filter(
      (c) => !this.primed.has(c.conversation_id),
    );
    if (fresh.length === 0) return;
    let pending = fresh;
    for (let round = 0; round < 50 && pending.length > 0; round++) {
      const events = await this.options.client.poll(
        pending,
        MAX_POLL_LIMIT,
        signal,
      );
      for (const event of events) await this.deliver(event);
      if (events.length < MAX_POLL_LIMIT) break;
      pending = this.cursorList().filter((c) =>
        pending.some((p) => p.conversation_id === c.conversation_id),
      );
    }
    for (const c of fresh) this.primed.add(c.conversation_id);
  }

  private async poll(signal: AbortSignal): Promise<void> {
    await this.setState("polling");
    while (!this.stopped && !signal.aborted && this.cursors.size > 0) {
      const events = await this.options.client.poll(
        this.cursorList(),
        MAX_POLL_LIMIT,
        signal,
      );
      for (const event of events) await this.deliver(event);
      if (events.length < MAX_POLL_LIMIT)
        await this.sleepImpl(this.pollInterval, signal);
    }
  }

  private async stream(url: string, signal: AbortSignal): Promise<void> {
    const token = await this.options.getToken();
    if (!token) throw fatalNoToken();
    const fetchImpl =
      this.options.fetch ?? (globalThis.fetch as unknown as StreamFetchLike);
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: this.options.client.streamRequest(this.cursorList()),
      signal,
      redirect: "error",
    });
    if (response.status === 401) throw unauthorized();
    if (response.status === 404 || response.status === 405) {
      this.streamBroken = true;
      return this.poll(signal);
    }
    const type = response.headers.get("content-type") ?? "";
    if (response.status !== 200 || !type.startsWith("text/event-stream")) {
      this.streamBroken = true;
      throw new Error("stream unavailable");
    }
    if (!response.body) throw new Error("stream unavailable");
    await this.setState("live");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let closed: StreamClose | null = null;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > MAX_SSE_BUFFER) throw new Error("stream overflow");
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1 && !closed) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const frame = parseSseBlock(block);
          if (frame?.type === "event") await this.deliver(frame.event);
          else if (frame?.type === "close") closed = frame.close;
          boundary = buffer.indexOf("\n\n");
        }
        if (closed) break;
      }
    } finally {
      reader.cancel().catch(() => undefined);
    }
    if (
      closed &&
      (closed.reason === "membership" || closed.reason === "not_found")
    ) {
      // The server revoked one of our cursors; the owner re-lists and
      // resubscribes, which drops that conversation before we reconnect.
      await this.options.onResync();
    }
    // A clean close means the server rotated the connection: reconnect after
    // the minimum delay so a server that closes immediately cannot spin us.
    await this.setState("retrying");
    await this.sleepImpl(this.min, signal);
  }
}

export type SseFrame =
  | { type: "event"; event: TeamEvent }
  | { type: "close"; close: StreamClose };

/**
 * Parses one SSE block. `event: close` carries a fixed reason; every other
 * block is an outbox event. Comments (`: heartbeat`), `id:` and anything
 * that fails validation are dropped.
 */
export function parseSseBlock(block: string): SseFrame | null {
  const data: string[] = [];
  let eventName = "";
  for (const rawLine of block.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    else if (line.startsWith("event:")) eventName = line.slice(6).trim();
  }
  if (data.length === 0) return null;
  let json: unknown;
  try {
    json = JSON.parse(data.join("\n"));
  } catch {
    return null;
  }
  if (eventName === "close") {
    const parsed = StreamCloseSchema.safeParse(json);
    return parsed.success ? { type: "close", close: parsed.data } : null;
  }
  const parsed = TeamEventSchema.safeParse(json);
  return parsed.success ? { type: "event", event: parsed.data } : null;
}

function fatalNoToken(): RpcError {
  return new RpcError("no-token", "No team token is configured.");
}
function unauthorized(): RpcError {
  return new RpcError("unauthorized", "Team token rejected.");
}
