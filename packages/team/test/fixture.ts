import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepoRegistry } from "@mars/code-refs";
import type { TeamDeliveryEvent } from "@mars/contracts";
import type { TeamAgentOptions } from "../src/agent";
import type { AgentReferencePort } from "../src/agent-references";
import { createDevAuthenticator } from "../src/auth";
import type { StreamClose } from "../src/protocol";
import type { TeamLimits } from "../src/schemas";
import { serveTeam, type TeamServerLogEntry } from "../src/server";
import { createTeamStore, type TeamStore } from "../src/store";

export const TEAM = "team-1";
export const OTHER_TEAM = "team-2";
export const TOKENS = {
  alice: "alice_dev_token_not_a_secret_000000000001",
  bob: "bob_dev_token_not_a_secret_00000000000002",
  carol: "carol_dev_token_not_a_secret_000000000003",
  dave: "dave_dev_token_not_a_secret_0000000000004",
  stranger: "stranger_dev_token_not_a_secret_00000005",
} as const;
export type User = keyof typeof TOKENS;

export interface RpcResult {
  status: number;
  headers: Headers;
  body: { result?: unknown; error?: { code: string; message: string } };
}

export interface StreamFrame {
  id: string | null;
  event: string | null;
  data: string;
}

/** One open `events.stream` connection, parsed frame by frame as it arrives. */
export interface OpenStream {
  status: number;
  error: { code: string } | null;
  frames: StreamFrame[];
  events: TeamDeliveryEvent[];
  comments: string[];
  closes: StreamClose[];
  /** Resolves when the server ends the response (or the client aborts). */
  done: Promise<void>;
  ended: boolean;
  abort(): void;
  waitFor(predicate: () => boolean, timeoutMs?: number): Promise<void>;
}

export interface FixtureOptions {
  limits?: Partial<TeamLimits>;
  /** Host registry; when given, `references.*` are served. */
  repos?: RepoRegistry;
  /** Host agent options; when given, `agent.*` are served. */
  agent?: TeamAgentOptions;
  /** Host reference port the server pre-resolves agent selections through. */
  agentReferences?: AgentReferencePort;
  /** Kill switch state at start (default on; the store default is off). */
  enabled?: boolean;
}

export function fixture(options: Partial<TeamLimits> | FixtureOptions = {}) {
  const resolved: FixtureOptions =
    "limits" in options ||
    "repos" in options ||
    "agent" in options ||
    "agentReferences" in options ||
    "enabled" in options
      ? (options as FixtureOptions)
      : { limits: options as Partial<TeamLimits> };
  const limits = resolved.limits ?? {};
  const agent = resolved.agent;
  const rootDir = mkdtempSync(join(tmpdir(), "mars-team-"));
  const store = createTeamStore({
    rootDir,
    limits,
    ...(agent ? { agent } : {}),
  });
  // The kill switch defaults to off; tests exercise the enabled service
  // unless they flip it themselves.
  store.setEnabled(resolved.enabled ?? true);
  const logs: TeamServerLogEntry[] = [];
  for (const user of ["alice", "bob", "carol"])
    store.setTeamMember({ team_id: TEAM, user_id: user, role: "member" });
  store.setTeamMember({ team_id: OTHER_TEAM, user_id: "dave", role: "admin" });
  const authenticator = createDevAuthenticator([
    { token: TOKENS.alice, user_id: "alice", team_ids: [TEAM] },
    { token: TOKENS.bob, user_id: "bob", team_ids: [TEAM] },
    { token: TOKENS.carol, user_id: "carol", team_ids: [TEAM] },
    { token: TOKENS.dave, user_id: "dave", team_ids: [OTHER_TEAM] },
    // Authenticated but never added to the team store.
    { token: TOKENS.stranger, user_id: "stranger", team_ids: [TEAM] },
  ]);
  const server = serveTeam({
    store,
    authenticator,
    port: 0,
    log: (entry) => logs.push(entry),
    ...(resolved.repos ? { repos: resolved.repos } : {}),
    ...(resolved.agentReferences
      ? { agentReferences: resolved.agentReferences }
      : {}),
  });
  const url = `http://127.0.0.1:${server.port}/v1/rpc`;
  let counter = 0;
  const raw = (
    body: unknown,
    headers: Record<string, string> = {},
    init: RequestInit = {},
  ) =>
    fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKENS.alice}`,
        "content-type": "application/json",
        ...headers,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
      ...init,
    });
  const rpc = async (
    user: User,
    method: string,
    params: unknown,
    options: { request_id?: string; team_id?: string } = {},
  ): Promise<RpcResult> => {
    const response = await raw(
      {
        method,
        context: {
          schema_version: 1,
          team_id: options.team_id ?? TEAM,
          request_id: options.request_id ?? `req-${++counter}`,
        },
        params,
      },
      { authorization: `Bearer ${TOKENS[user]}` },
    );
    return {
      status: response.status,
      headers: response.headers,
      body: (await response.json()) as RpcResult["body"],
    };
  };
  const ok = async <T>(
    user: User,
    method: string,
    params: unknown,
    options?: { request_id?: string; team_id?: string },
  ): Promise<T> => {
    const response = await rpc(user, method, params, options);
    if (response.status !== 200)
      throw new Error(
        `${method} failed: ${response.status} ${JSON.stringify(response.body)}`,
      );
    return response.body.result as T;
  };
  const streamUrl = url.replace(/\/v1\/rpc$/, "/v1/stream");
  const stream = async (
    user: User,
    cursors: unknown,
    options: { request_id?: string; team_id?: string } = {},
  ): Promise<OpenStream> => {
    const controller = new AbortController();
    const response = await fetch(streamUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKENS[user]}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        method: "events.stream",
        context: {
          schema_version: 1,
          team_id: options.team_id ?? TEAM,
          request_id: options.request_id ?? `stream-${++counter}`,
        },
        params: { cursors },
      }),
      signal: controller.signal,
    });
    const waiters = new Set<() => void>();
    const open: OpenStream = {
      status: response.status,
      error: null,
      frames: [],
      events: [],
      comments: [],
      closes: [],
      done: Promise.resolve(),
      ended: false,
      abort: () => controller.abort(),
      waitFor: (predicate, timeoutMs = 5_000) =>
        new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            waiters.delete(check);
            reject(new Error("stream condition not met in time"));
          }, timeoutMs);
          const check = () => {
            if (!predicate() && !open.ended) return;
            clearTimeout(timer);
            waiters.delete(check);
            if (predicate()) resolve();
            else reject(new Error("stream ended before the condition held"));
          };
          waiters.add(check);
          check();
        }),
    };
    if (response.status !== 200) {
      open.error = (
        (await response.json()) as { error: { code: string } }
      ).error;
      open.ended = true;
      return open;
    }
    const handle = (block: string) => {
      if (block.startsWith(":")) {
        open.comments.push(block.slice(1).trim());
        return;
      }
      const frame: StreamFrame = { id: null, event: null, data: "" };
      for (const line of block.split("\n")) {
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "id") frame.id = value;
        else if (field === "event") frame.event = value;
        else if (field === "data") frame.data += value;
      }
      open.frames.push(frame);
      if (frame.event === "close")
        open.closes.push(JSON.parse(frame.data) as StreamClose);
      else open.events.push(JSON.parse(frame.data) as TeamDeliveryEvent);
    };
    open.done = (async () => {
      const reader = response.body?.getReader();
      if (!reader) return;
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let cut = buffer.indexOf("\n\n");
          while (cut >= 0) {
            handle(buffer.slice(0, cut));
            buffer = buffer.slice(cut + 2);
            cut = buffer.indexOf("\n\n");
          }
          for (const waiter of [...waiters]) waiter();
        }
      } catch {
        // Aborted by the client or reset by server shutdown.
      } finally {
        open.ended = true;
        for (const waiter of [...waiters]) waiter();
      }
    })();
    return open;
  };
  const close = async () => {
    await server.stop(true);
    store.close();
    rmSync(rootDir, { recursive: true, force: true });
  };
  return {
    rootDir,
    store: store as TeamStore,
    server,
    logs,
    url,
    streamUrl,
    raw,
    rpc,
    ok,
    stream,
    close,
  };
}
