import { describe, expect, test } from "bun:test";
import { RpcError } from "../src/rpc";
import { TeamClient } from "../src/teamChat/client";
import { TeamChatController } from "../src/teamChat/controller";
import type { TeamChatViewState } from "../src/teamChat/messages";
import {
  parseSseBlock,
  type StreamFetchLike,
  TeamRealtime,
} from "../src/teamChat/realtime";
import { RpcTeamService, teamErrorCode } from "../src/teamChat/service";
import {
  FAKE_TEAM_TOKEN,
  type FakeTeamOptions,
  FakeTeamServer,
} from "./teamFixtures";

const ADA = "user_ada";
const GRACE = "user_grace";
const LINUS = "user_linus";

function setup(
  options: FakeTeamOptions & {
    user?: string;
    token?: string | null;
    realtime?: boolean;
    streamUrl?: string | null;
    fetch?: StreamFetchLike;
    pageSize?: number;
  } = {},
) {
  const server = new FakeTeamServer(options);
  const dm = server.seedDm(ADA, GRACE, [
    "Hi Ada, the launch key evidence is in review.",
    "Thanks, looking this afternoon.",
    "The verdict layout lives host-side.",
  ]);
  const group = server.seedGroup(
    "Release room",
    [ADA, GRACE, LINUS],
    ["Release checklist is at #4.", "Pinning this one for the week."],
  );
  const user = options.user ?? ADA;
  const token = "token" in options ? options.token : FAKE_TEAM_TOKEN;
  const client = new TeamClient(server.transport(user, token));
  const service = new RpcTeamService(client);
  const states: TeamChatViewState[] = [];
  let controller: TeamChatController | undefined;
  const statuses: string[] = [];
  const realtime = options.realtime
    ? new TeamRealtime({
        client,
        streamUrl: options.streamUrl ?? null,
        streamSupported: () => service.streamSupported,
        getToken: () => Promise.resolve(token ?? undefined),
        onEvent: (event) =>
          controller?.notifyDelivery(
            event.conversation_id,
            event.kind,
            event.message_seq,
          ),
        onStatus: (state) => {
          statuses.push(state);
          return controller?.notifyConnection(state);
        },
        onResync: () =>
          controller?.handleMessage({ type: "ready" }).then(() => undefined),
        ...(options.fetch ? { fetch: options.fetch } : {}),
        sleep: (ms, signal) =>
          new Promise<void>((resolve) => {
            if (signal.aborted) return resolve();
            const timer = setTimeout(resolve, Math.min(ms, 5));
            signal.addEventListener("abort", () => {
              clearTimeout(timer);
              resolve();
            });
          }),
        minDelayMs: 1,
        maxDelayMs: 4,
        pollIntervalMs: 2,
      })
    : undefined;
  controller = new TeamChatController({
    post: (state) => states.push(state),
    service,
    ...(realtime ? { realtime } : {}),
    viewer: "service",
    pageSize: options.pageSize ?? 50,
  });
  const last = () => {
    const state = states[states.length - 1];
    if (!state) throw new Error("no state emitted");
    return state;
  };
  return {
    server,
    client,
    service,
    controller,
    states,
    last,
    dm,
    group,
    realtime,
    statuses,
  };
}

async function until(check: () => boolean, tries = 200): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("condition never held");
}

describe("TeamClient", () => {
  test("validates every result and rejects records for another tenant or user", async () => {
    const server = new FakeTeamServer();
    server.seedDm(ADA, GRACE, ["hello"]);
    const client = new TeamClient(server.transport(ADA));
    const me = await client.describe();
    expect(me.user_id).toBe(ADA);
    const list = await client.listConversations();
    expect(list).toHaveLength(1);
    const rogue = new TeamClient({
      send: async (request) => {
        if (request.method === "team.describe")
          return {
            team_id: "team_fixture",
            user_id: ADA,
            role: "member",
            limits: {},
            capabilities: {
              stream: false,
              reactions: false,
              search: false,
              references: false,
            },
          };
        const [view] = list;
        if (!view) throw new Error("no view");
        return [
          {
            ...view,
            participant: { ...view.participant, user_id: GRACE },
          },
        ];
      },
    });
    await rogue.describe();
    await expect(rogue.listConversations()).rejects.toMatchObject({
      kind: "protocol",
    });
    // No request before describe: the context needs the server's team_id.
    const fresh = new TeamClient(server.transport(ADA));
    await expect(fresh.listConversations()).rejects.toMatchObject({
      kind: "disconnected",
    });
  });

  test("maps transport failures onto the fixed team error vocabulary", () => {
    expect(teamErrorCode(new RpcError("no-token", "x"))).toBe("unauthorized");
    expect(teamErrorCode(new RpcError("unauthorized", "x"))).toBe(
      "unauthorized",
    );
    expect(teamErrorCode(new RpcError("forbidden", "x"))).toBe("forbidden");
    expect(teamErrorCode(new RpcError("not-found", "x"))).toBe("not_found");
    expect(teamErrorCode(new RpcError("conflict", "x"))).toBe("conflict");
    expect(teamErrorCode(new RpcError("timeout", "x"))).toBe("unavailable");
    expect(teamErrorCode(new RpcError("server", "x", "invalid_request"))).toBe(
      "invalid",
    );
    expect(teamErrorCode(new RpcError("server", "x", "internal_error"))).toBe(
      "unavailable",
    );
    expect(teamErrorCode(new Error("plain"))).toBe("unavailable");
  });
});

describe("RpcTeamService through the controller", () => {
  test("ready lists conversations with the server-derived identity and no fixture viewers", async () => {
    const { controller, last, dm, group } = setup();
    await controller.handleMessage({ type: "ready" });
    const state = last();
    expect(state.label).toBe("SERVICE");
    expect(state.viewer.user_id).toBe(ADA);
    expect(state.viewers).toEqual([]);
    expect(state.capabilities).toEqual({
      reactions: false,
      search: false,
      realtime: true,
    });
    expect(state.conversations.map((c) => c.conversation_id)).toEqual([
      group,
      dm,
    ]);
    // Newest activity first: the group was seeded last and is selected.
    expect(state.selected?.conversation.conversation_id).toBe(group);
    await controller.handleMessage({
      type: "selectConversation",
      conversationId: dm,
    });
    const selected = last().selected;
    expect(selected?.messages.map((m) => m.sequence)).toEqual([1, 2, 3]);
    // Nothing is read yet (read_seq 0) and the viewport has not reported in;
    // without a server counter the cache-based count skips the viewer's own post.
    expect(selected?.conversation.unread_count).toBe(2);
    expect(selected?.conversation.first_unread_sequence).toBe(1);
    expect(selected?.divider_sequence).toBe(1);
    expect(state.mention_index).toEqual({ repos: [] });
  });

  test("the team token never appears in any emitted view state", async () => {
    const { controller, states, server, dm } = setup();
    await controller.handleMessage({ type: "ready" });
    await controller.handleMessage({
      type: "send",
      conversationId: dm,
      clientMessageId: "cm_t_1",
      body: "token check",
      replyTo: null,
      references: [],
    });
    server.offline = true;
    await controller.handleMessage({
      type: "selectConversation",
      conversationId: dm,
    });
    const serialized = JSON.stringify(states);
    expect(serialized).not.toContain(FAKE_TEAM_TOKEN);
    expect(serialized).not.toContain("Bearer");
    expect(serialized).not.toContain("fake team");
    expect(states.length).toBeGreaterThan(2);
  });

  test("a lost acknowledgement retried with the same client id shows one message, in order", async () => {
    const { controller, last, server, dm } = setup();
    await controller.handleMessage({ type: "ready" });
    await controller.handleMessage({
      type: "selectConversation",
      conversationId: dm,
    });
    await controller.handleMessage({
      type: "viewport",
      focused: true,
      atBottom: true,
    });
    server.dropNextAck = true;
    await controller.handleMessage({
      type: "send",
      conversationId: dm,
      clientMessageId: "cm_lost_1",
      body: "first try",
      replyTo: null,
      references: [],
    });
    expect(last().pending[0]).toMatchObject({
      client_message_id: "cm_lost_1",
      status: "failed",
    });
    // The server committed it; the fixed reason says a retry keeps the id.
    expect(
      server.messages.filter((m) => m.client_message_id === "cm_lost_1"),
    ).toHaveLength(1);
    expect(last().pending[0]?.reason).toContain("same message id");
    await controller.handleMessage({
      type: "retrySend",
      clientMessageId: "cm_lost_1",
    });
    expect(last().pending).toEqual([]);
    const seqs = last().selected?.messages.map((m) => m.sequence);
    expect(seqs).toEqual([1, 2, 3, 4]);
    expect(
      last().selected?.messages.filter(
        (m) => m.client_message_id === "cm_lost_1",
      ),
    ).toHaveLength(1);
    expect(
      server.messages.filter((m) => m.client_message_id === "cm_lost_1"),
    ).toHaveLength(1);
    expect(last().selected?.conversation.read_cursor).toBe(4);
    const sends = server.calls.filter((c) => c.method === "messages.send");
    expect(sends).toHaveLength(2);
    expect(sends.every((c) => c.params.client_message_id === "cm_lost_1")).toBe(
      true,
    );
  });

  test("a conflict (same id, different body) asks for edit and resend and refuses retry", async () => {
    const { controller, last, server, dm } = setup();
    await controller.handleMessage({ type: "ready" });
    server.post(ADA, dm, "original", { client_message_id: "cm_dup" });
    await controller.handleMessage({
      type: "send",
      conversationId: dm,
      clientMessageId: "cm_dup",
      body: "edited body",
      replyTo: null,
      references: [],
    });
    expect(last().pending[0]).toMatchObject({ status: "conflict" });
    expect(last().pending[0]?.reason).toContain("Edit and resend");
    await controller.handleMessage({
      type: "retrySend",
      clientMessageId: "cm_dup",
    });
    expect(
      server.calls.filter((c) => c.method === "messages.send"),
    ).toHaveLength(1);
    await controller.handleMessage({
      type: "discardSend",
      clientMessageId: "cm_dup",
    });
    expect(last().pending).toEqual([]);
  });

  test("not_found on a known conversation drops it from the list and clears its cached messages", async () => {
    const { controller, last, server, service, group, dm } = setup();
    await controller.handleMessage({ type: "ready" });
    await controller.handleMessage({
      type: "selectConversation",
      conversationId: group,
    });
    expect(last().selected?.conversation.conversation_id).toBe(group);
    await controller.handleMessage({
      type: "send",
      conversationId: group,
      clientMessageId: "cm_pending_removed",
      body: "will be orphaned",
      replyTo: null,
      references: [],
    });
    server.remove(group, ADA);
    await controller.handleMessage({
      type: "selectConversation",
      conversationId: group,
    });
    const state = last();
    expect(state.selected).toBeNull();
    expect(state.conversations.map((c) => c.conversation_id)).toEqual([dm]);
    expect(state.pending).toEqual([]);
    expect(state.notice?.text).toContain("no longer available");
    // The cache is gone too: a local search over the adapter no longer sees the group.
    const search = await service.searchMessages("service", "checklist", null);
    expect(search.ok && search.value.hits).toEqual([]);
    const again = await service.searchMessages("service", "verdict", null);
    expect(again.ok && again.value.hits.map((h) => h.conversation_id)).toEqual([
      dm,
    ]);
  });

  test("reference ids from the service render as restricted chips with no path or sha", async () => {
    const { controller, last, server, dm } = setup();
    const message = server.post(GRACE, dm, "see the banner", {});
    message.reference_ids = ["ref_site_banner"];
    await controller.handleMessage({ type: "ready" });
    const view = last().selected?.messages.find(
      (m) => m.message_id === message.message_id,
    );
    expect(view?.references).toEqual([
      { reference_id: "ref_site_banner", state: "restricted" },
    ]);
    const serialized = JSON.stringify(view?.references);
    expect(serialized).not.toContain("path");
    expect(serialized).not.toContain("sha");
    await controller.handleMessage({
      type: "openReference",
      messageId: message.message_id,
      referenceId: "ref_site_banner",
    });
    expect(last().panel?.preview).toEqual({
      state: "restricted",
      reference_id: "ref_site_banner",
    });
  });

  test("a missing token surfaces a fixed notice and nothing else", async () => {
    const { controller, last, states } = setup({ token: null });
    await controller.handleMessage({ type: "ready" });
    expect(last().conversations).toEqual([]);
    expect(last().notice?.text).toContain("Set team token");
    expect(last().connection).toBe("unauthenticated");
    expect(JSON.stringify(states)).not.toContain("fake team");
  });

  test("reactions and search use the real methods only when the server advertises them", async () => {
    const { controller, last, server, dm } = setup({
      capabilities: { stream: false, reactions: true, search: true },
    });
    await controller.handleMessage({ type: "ready" });
    expect(last().capabilities).toMatchObject({
      reactions: true,
      search: true,
    });
    const target = last().selected?.messages[0];
    if (!target) throw new Error("no message");
    await controller.handleMessage({
      type: "toggleReaction",
      messageId: target.message_id,
      emoji: "👍",
    });
    expect(last().selected?.messages[0]?.reactions).toEqual([
      { emoji: "👍", count: 1, mine: true },
    ]);
    expect(server.calls.some((c) => c.method === "reactions.set")).toBe(true);
    await controller.handleMessage({
      type: "toggleReaction",
      messageId: target.message_id,
      emoji: "👍",
    });
    expect(last().selected?.messages[0]?.reactions).toEqual([]);
    // A reload shows the summaries the PR 3 history items carry.
    server.reactions.push({
      message_id: target.message_id,
      user_id: GRACE,
      emoji: "✅",
    });
    await controller.handleMessage({
      type: "selectConversation",
      conversationId: dm,
    });
    await controller.handleMessage({
      type: "selectConversation",
      conversationId: target.conversation_id,
    });
    expect(last().selected?.messages[0]?.reactions).toEqual([
      { emoji: "✅", count: 1, mine: false },
    ]);
    await controller.handleMessage({ type: "search", query: "checklist" });
    expect(last().search?.hits.map((h) => h.conversation_id)).not.toContain(dm);
    expect(last().search?.hits).toHaveLength(1);
    expect(server.calls.some((c) => c.method === "messages.search")).toBe(true);
  });

  test("without server search the adapter searches only the host cache", async () => {
    const { controller, last, server, dm } = setup();
    await controller.handleMessage({ type: "ready" });
    // Only the latest message of each listed conversation is cached until a
    // conversation is opened; the fallback is explicitly cache-only.
    await controller.handleMessage({ type: "search", query: "afternoon" });
    expect(last().search?.hits).toHaveLength(0);
    await controller.handleMessage({
      type: "selectConversation",
      conversationId: dm,
    });
    await controller.handleMessage({ type: "search", query: "afternoon" });
    expect(last().search?.hits).toHaveLength(1);
    expect(server.calls.some((c) => c.method === "messages.search")).toBe(
      false,
    );
  });

  test("clearing the token through reset drops every cached conversation and draft", async () => {
    const { controller, last, service, dm } = setup();
    await controller.handleMessage({ type: "ready" });
    await controller.handleMessage({
      type: "send",
      conversationId: dm,
      clientMessageId: "cm_reset",
      body: "x",
      replyTo: null,
      references: [],
    });
    service.forgetAll();
    await controller.reset();
    expect(last()).toMatchObject({
      conversations: [],
      selected: null,
      pending: [],
      search: null,
    });
    expect(service.users()).toEqual([]);
  });
});

describe("TeamRealtime", () => {
  test("polls events.poll, primes without replaying history, and announces a new message", async () => {
    const { controller, last, server, dm, realtime, statuses } = setup({
      realtime: true,
    });
    await controller.handleMessage({ type: "ready" });
    await controller.handleMessage({
      type: "selectConversation",
      conversationId: dm,
    });
    await until(() => statuses.includes("polling"));
    expect(last().announcement).toBeNull();
    const before = last().selected?.messages.length ?? 0;
    server.post(GRACE, dm, "Delivered by poll.");
    await until(() => (last().selected?.messages.length ?? 0) > before);
    expect(last().selected?.messages.at(-1)?.body).toBe("Delivered by poll.");
    expect(last().announcement?.text).toBe(`New message in ${GRACE}`);
    expect(last().connection).toBe("polling");
    realtime?.stop();
    controller.dispose();
    await realtime?.settled();
  });

  test("a membership revocation delivered by poll removes the conversation", async () => {
    const { controller, last, server, group, realtime, statuses } = setup({
      realtime: true,
    });
    await controller.handleMessage({ type: "ready" });
    await until(() => statuses.includes("polling"));
    server.remove(group, ADA);
    await until(() =>
      last().conversations.every((c) => c.conversation_id !== group),
    );
    expect(last().conversations).toHaveLength(1);
    realtime?.stop();
    controller.dispose();
    await realtime?.settled();
  });

  test("streams over SSE with per-conversation resume cursors and reconnects with backoff", async () => {
    const streamRequests: {
      cursors: { conversation_id: string; after_event_seq: number }[];
    }[] = [];
    let closeOnce: "membership" | undefined;
    let server: FakeTeamServer | undefined;
    const encoder = new TextEncoder();
    const fetch: StreamFetchLike = async (_url, init) => {
      expect(init.headers.authorization).toBe(`Bearer ${FAKE_TEAM_TOKEN}`);
      const envelope = JSON.parse(init.body) as {
        method: string;
        context: { team_id: string };
        params: (typeof streamRequests)[number];
      };
      expect(envelope.method).toBe("events.stream");
      expect(envelope.context.team_id).toBe("team_fixture");
      const body = envelope.params;
      streamRequests.push(body);
      const close = closeOnce;
      closeOnce = undefined;
      const payload =
        streamRequests.length === 1
          ? ": keep-alive\n\n"
          : (server?.sseBody(body.cursors, close) ?? "");
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(payload));
          controller.close();
        },
      });
      return {
        status: 200,
        headers: {
          get: (name) => (name === "content-type" ? "text/event-stream" : null),
        },
        body: stream,
      };
    };
    const fixture = setup({
      realtime: true,
      streamUrl: "http://127.0.0.1:7332/v1/stream",
      fetch,
      capabilities: { stream: true, reactions: false, search: false },
    });
    server = fixture.server;
    const { controller, last, dm, realtime, statuses } = fixture;
    await controller.handleMessage({ type: "ready" });
    await controller.handleMessage({
      type: "selectConversation",
      conversationId: dm,
    });
    await until(() => streamRequests.length >= 1);
    // Resume cursors are primed to the present before the first stream request.
    const first = streamRequests[0];
    const primed = first?.cursors.find((c) => c.conversation_id === dm);
    expect(primed?.after_event_seq).toBe(
      fixture.server.conversations.get(dm)?.last_event_seq,
    );
    fixture.server.post(GRACE, dm, "Delivered by stream.");
    await until(
      () => last().selected?.messages.at(-1)?.body === "Delivered by stream.",
    );
    expect(statuses).toContain("live");
    expect(statuses).toContain("retrying");
    // A purposeful close for membership makes the client re-list; the
    // revoked conversation disappears without a poll error.
    const { group } = fixture;
    fixture.server.remove(group, ADA);
    closeOnce = "membership";
    await until(() =>
      last().conversations.every((c) => c.conversation_id !== group),
    );
    expect(last().conversations.map((c) => c.conversation_id)).toEqual([dm]);
    realtime?.stop();
    controller.dispose();
    await realtime?.settled();
  });

  test("a reconnect refreshes the selected conversation through history without duplicates", async () => {
    let disconnect: (() => void) | undefined;
    let releaseReconnect: (() => void) | undefined;
    const reconnectGate = new Promise<void>((resolve) => {
      releaseReconnect = resolve;
    });
    let fetchCount = 0;
    const fetch: StreamFetchLike = async (_url, init) => {
      fetchCount += 1;
      if (fetchCount === 2) await reconnectGate;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          if (fetchCount === 1)
            disconnect = () =>
              controller.error(new Error("simulated disconnect"));
          init.signal.addEventListener(
            "abort",
            () => {
              try {
                controller.close();
              } catch {
                // The first stream may already have errored.
              }
            },
            { once: true },
          );
          if (fetchCount > 2) controller.close();
        },
      });
      return {
        status: 200,
        headers: {
          get: (name) => (name === "content-type" ? "text/event-stream" : null),
        },
        body: stream,
      };
    };
    const { controller, last, server, dm, realtime, statuses } = setup({
      realtime: true,
      streamUrl: "http://127.0.0.1:7332/v1/stream",
      fetch,
      capabilities: { stream: true, reactions: false, search: false },
    });
    await controller.handleMessage({ type: "ready" });
    await controller.handleMessage({
      type: "selectConversation",
      conversationId: dm,
    });
    await until(() => fetchCount === 1 && statuses.includes("live"));
    const opensBeforeReconnect = server.calls.filter(
      (call) =>
        call.method === "conversations.open" &&
        call.params.conversation_id === dm,
    ).length;
    disconnect?.();
    await until(() => statuses.includes("retrying") && fetchCount >= 2);
    const committed = server.post(GRACE, dm, "Committed during disconnect.");
    releaseReconnect?.();
    await until(
      () =>
        last().selected?.messages.some(
          (message) => message.message_id === committed.message_id,
        ) === true,
    );

    const selected = last().selected;
    expect(selected?.conversation.conversation_id).toBe(dm);
    expect(selected?.messages.map((message) => message.sequence)).toEqual([
      1, 2, 3, 4,
    ]);
    expect(
      selected?.messages.filter(
        (message) => message.message_id === committed.message_id,
      ),
    ).toHaveLength(1);
    expect(
      server.calls.filter(
        (call) =>
          call.method === "messages.history" &&
          call.params.conversation_id === dm &&
          call.params.after_seq === 3,
      ),
    ).not.toHaveLength(0);
    expect(
      server.calls.filter(
        (call) =>
          call.method === "conversations.open" &&
          call.params.conversation_id === dm,
      ),
    ).toHaveLength(opensBeforeReconnect);
    realtime?.stop();
    controller.dispose();
    await realtime?.settled();
  });

  test("parses only data lines and drops malformed events", () => {
    expect(parseSseBlock(": comment")).toBeNull();
    expect(parseSseBlock('data: {"nope": 1}')).toBeNull();
    expect(parseSseBlock("data: not json")).toBeNull();
    expect(
      parseSseBlock(
        'id: 7\nevent: message\ndata: {"conversation_id":"c","event_seq":7,"kind":"message","message_seq":3,"message_id":"m","revision":1}',
      ),
    ).toMatchObject({
      type: "event",
      event: { event_seq: 7, kind: "message" },
    });
    expect(
      parseSseBlock('event: close\ndata: {"reason":"membership"}'),
    ).toEqual({ type: "close", close: { reason: "membership" } });
    expect(parseSseBlock('event: close\ndata: {"reason":"bogus"}')).toBeNull();
  });
});

describe("host kill switch (PR 7)", () => {
  test("a disabled server shows the disabled state, stops polling, keeps nothing stale, and resumes when enabled again", async () => {
    const { controller, last, server, realtime, statuses, dm } = setup({
      realtime: true,
    });
    await controller.handleMessage({ type: "ready" });
    await until(() => statuses.includes("polling"));
    expect(last().conversations.length).toBeGreaterThan(0);
    server.disabled = true;
    // The next poll fails with 503 unavailable; describe says the host switched the team off.
    await until(() => statuses.includes("disabled"));
    expect(last().connection).toBe("disabled");
    // No further calls while disabled: the source waits like the fatal kinds.
    const callsAtPause = server.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(server.calls.length).toBe(callsAtPause);
    // A user action meets the same answer and a fixed notice; data on the server is untouched.
    await controller.handleMessage({ type: "ready" });
    expect(last().connection).toBe("disabled");
    expect(last().notice?.text).toContain("disabled by the host");
    expect(last().notice?.text).not.toContain("not reachable");
    expect(JSON.stringify(last())).not.toContain("fake team");
    expect(server.messages.length).toBeGreaterThan(0);
    // Enabled again: the inbox reloads and the realtime source resumes.
    server.disabled = false;
    await controller.handleMessage({ type: "ready" });
    expect(last().conversations.map((c) => c.conversation_id)).toContain(dm);
    expect(last().notice).toBeNull();
    await until(() => last().connection === "polling");
    realtime?.stop();
    await realtime?.settled();
  });

  test("an outage is still reported as unreachable, not disabled", async () => {
    const { controller, last, server } = setup();
    server.offline = true;
    await controller.handleMessage({ type: "ready" });
    expect(last().connection).not.toBe("disabled");
    expect(last().notice?.text).toContain("not reachable");
  });
});

describe("review fixes", () => {
  test("accepts the PR 4 server description (extra boolean capabilities) and chip-bearing history items", async () => {
    const server = new FakeTeamServer();
    server.seedDm(ADA, GRACE, ["hello"]);
    const client = new TeamClient({
      send: async (request, signal) => {
        const result = (await server
          .transport(ADA)
          .send(request, signal)) as Record<string, unknown>;
        if (request.method === "team.describe")
          return {
            ...result,
            capabilities: {
              ...(result.capabilities as object),
              references: true,
              future_flag: false,
            },
          };
        return result;
      },
    });
    const me = await client.describe();
    expect(me.capabilities.references).toBe(true);
    const [view] = await client.listConversations();
    if (!view) throw new Error("no view");
    const history = await client.history(view.conversation.conversation_id, {
      limit: 10,
    });
    expect(history[0]?.references).toEqual([]);
  });

  test("server chips drive the reference view: restricted stays restricted, an allowed chip shows its locator", async () => {
    const { controller, last, server, dm } = setup();
    const message = server.post(GRACE, dm, "two refs");
    message.reference_ids = ["ref_locked", "ref_open"];
    server.chips.set("ref_open", {
      reference_id: "ref_open",
      restricted: false,
      repo_id: "repo_site",
      commit_sha: "a".repeat(40),
      path: "site/banner.css",
      line_start: 3,
      line_end: 9,
    });
    await controller.handleMessage({ type: "ready" });
    await controller.handleMessage({
      type: "selectConversation",
      conversationId: dm,
    });
    const view = last().selected?.messages.find(
      (m) => m.message_id === message.message_id,
    );
    expect(view?.references[0]).toEqual({
      reference_id: "ref_locked",
      state: "restricted",
    });
    expect(view?.references[1]).toMatchObject({
      reference_id: "ref_open",
      state: "ok",
      kind: "range",
      path: "site/banner.css",
      short_sha: "aaaaaaa",
      line_start: 3,
      line_end: 9,
    });
  });

  test("a reply target from another conversation is never shown as the excerpt", async () => {
    const { controller, last, server, dm, group } = setup();
    await controller.handleMessage({ type: "ready" });
    await controller.handleMessage({
      type: "selectConversation",
      conversationId: group,
    });
    const foreign = server.messages.find((m) => m.conversation_id === group);
    if (!foreign) throw new Error("no group message");
    server.post(GRACE, dm, "replying across threads", {
      reply_to: foreign.message_id,
    });
    await controller.handleMessage({
      type: "selectConversation",
      conversationId: dm,
    });
    const reply = last().selected?.messages.at(-1)?.reply_to;
    expect(reply).toEqual({
      message_id: foreign.message_id,
      author_name: "Unknown member",
      excerpt: "",
    });
    expect(JSON.stringify(last().selected)).not.toContain(foreign.body);
  });

  test("the server's unread_count wins over the sequence distance (own posts are not unread)", async () => {
    const { controller, last, server, dm } = setup({
      capabilities: { stream: true, reactions: false, search: false },
    });
    await controller.handleMessage({ type: "ready" });
    await controller.handleMessage({
      type: "selectConversation",
      conversationId: dm,
    });
    await controller.handleMessage({
      type: "viewport",
      focused: true,
      atBottom: true,
    });
    expect(last().selected?.conversation.unread_count).toBe(0);
    await controller.handleMessage({
      type: "viewport",
      focused: false,
      atBottom: true,
    });
    await controller.handleMessage({
      type: "send",
      conversationId: dm,
      clientMessageId: "cm_own",
      body: "my own post while unfocused",
      replyTo: null,
      references: [],
    });
    const summary = last().conversations.find((c) => c.conversation_id === dm);
    expect(summary?.unread_count).toBe(0);
    expect(summary?.first_unread_sequence).toBeNull();
    server.post(GRACE, dm, "a real unread");
    await controller.handleMessage({
      type: "selectConversation",
      conversationId: dm,
    });
    expect(last().selected?.conversation.unread_count).toBe(1);
    expect(last().selected?.conversation.first_unread_sequence).toBe(5);
  });

  test("a full poll page rotates the cursor order so a quiet conversation still advances", async () => {
    const { controller, last, server, dm, group, realtime, statuses } = setup({
      realtime: true,
    });
    await controller.handleMessage({ type: "ready" });
    await until(() => statuses.includes("polling"));
    for (let i = 0; i < 1000; i++) server.post(GRACE, dm, `burst ${i}`);
    server.post(LINUS, group, "quiet thread message");
    await until(() => {
      const summary = last().conversations.find(
        (c) => c.conversation_id === group,
      );
      return summary?.last_message?.excerpt === "quiet thread message";
    }, 2000);
    const polls = server.calls.filter((c) => c.method === "events.poll");
    const firstIds = polls.map(
      (c) =>
        (c.params.cursors as { conversation_id: string }[])[0]?.conversation_id,
    );
    expect(new Set(firstIds).size).toBe(2);
    realtime?.stop();
    controller.dispose();
    await realtime?.settled();
  });

  test("one SSE chunk holding many small frames is parsed, not rejected as overflow", async () => {
    const server = new FakeTeamServer();
    const dm = server.seedDm(ADA, GRACE, ["seed"]);
    const client = new TeamClient(server.transport(ADA));
    await client.describe();
    let delivered = 0;
    const errors: unknown[] = [];
    const encoder = new TextEncoder();
    let requests = 0;
    const fetch: StreamFetchLike = async () => {
      requests += 1;
      let body = "";
      if (requests === 1)
        for (let i = 1; i <= 3000; i++)
          body += `id: ${i}\nevent: message\ndata: ${JSON.stringify({
            conversation_id: dm,
            event_seq: i + 1,
            kind: "message",
            message_seq: 1,
            message_id: "msg_0002",
            revision: 1,
          })}\n\n`;
      expect(body.length === 0 || body.length > 64 * 1024).toBe(true);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(body));
          if (requests > 1) return; // hold the second connection open
          controller.close();
        },
      });
      return {
        status: 200,
        headers: {
          get: (n) => (n === "content-type" ? "text/event-stream" : null),
        },
        body: stream,
      };
    };
    const realtime = new TeamRealtime({
      client,
      streamUrl: "http://127.0.0.1:7332/v1/stream",
      streamSupported: () => true,
      getToken: () => Promise.resolve(FAKE_TEAM_TOKEN),
      onEvent: () => {
        delivered += 1;
      },
      onStatus: () => undefined,
      onResync: () => undefined,
      onError: (e) => errors.push(e),
      fetch,
      sleep: (ms, signal) =>
        new Promise<void>((resolve) => {
          const t = setTimeout(resolve, Math.min(ms, 2));
          signal.addEventListener("abort", () => {
            clearTimeout(t);
            resolve();
          });
        }),
      minDelayMs: 1,
      maxDelayMs: 2,
    });
    realtime.subscribe([dm]);
    await until(() => delivered === 3000, 1000);
    expect(errors).toEqual([]);
    realtime.stop();
    await realtime.settled();
  });

  test("opening a search hit pages back to the message and highlights it", async () => {
    const { controller, last, server, dm } = setup({
      capabilities: { stream: false, reactions: false, search: true },
      pageSize: 2,
    });
    for (let i = 0; i < 6; i++) server.post(GRACE, dm, `filler ${i}`);
    await controller.handleMessage({ type: "ready" });
    await controller.handleMessage({ type: "search", query: "launch key" });
    const hit = last().search?.hits[0];
    if (!hit) throw new Error("no hit");
    expect(hit.sequence).toBe(1);
    await controller.handleMessage({
      type: "openSearchHit",
      conversationId: hit.conversation_id,
      messageId: hit.message_id,
      sequence: hit.sequence,
    });
    const selected = last().selected;
    expect(selected?.conversation.conversation_id).toBe(dm);
    expect(selected?.messages[0]?.sequence).toBe(1);
    expect(selected?.highlight_message_id).toBe(hit.message_id);
    await controller.handleMessage({
      type: "selectConversation",
      conversationId: dm,
    });
    expect(last().selected?.highlight_message_id).toBeNull();
  });
});

describe("review fixes, round 2", () => {
  test("a partially cached unread span keeps the conservative first-unread boundary", async () => {
    const { controller, last, server, dm } = setup({ pageSize: 3 });
    for (let i = 0; i < 20; i++) server.post(GRACE, dm, `unread ${i}`);
    await controller.handleMessage({ type: "ready" });
    await controller.handleMessage({
      type: "selectConversation",
      conversationId: dm,
    });
    // Only the last 3 of 23 messages are loaded: the boundary must stay at 1,
    // so a focused viewer at the bottom does not mark 1..20 read unseen.
    expect(last().selected?.messages.map((m) => m.sequence)).toEqual([
      21, 22, 23,
    ]);
    expect(last().selected?.conversation.first_unread_sequence).toBe(1);
    await controller.handleMessage({
      type: "viewport",
      focused: true,
      atBottom: true,
    });
    expect(last().selected?.conversation.read_cursor).toBe(0);
    expect(
      server.calls.some((c) => c.method === "conversations.mark_read"),
    ).toBe(false);
  });

  test("a contiguous cache lets the boundary skip the viewer's own leading posts", async () => {
    const { controller, last, server, dm } = setup({ pageSize: 50 });
    server.post(ADA, dm, "mine first");
    server.post(GRACE, dm, "then theirs");
    await controller.handleMessage({ type: "ready" });
    await controller.handleMessage({
      type: "selectConversation",
      conversationId: dm,
    });
    // Seeded: 1 grace, 2 ada, 3 grace, 4 ada, 5 grace → first by someone else is 1.
    expect(last().selected?.conversation.first_unread_sequence).toBe(1);
    await controller.handleMessage({
      type: "viewport",
      focused: true,
      atBottom: true,
    });
    expect(last().selected?.conversation.read_cursor).toBe(5);
    await controller.handleMessage({
      type: "viewport",
      focused: false,
      atBottom: true,
    });
    server.post(ADA, dm, "own again");
    server.post(GRACE, dm, "theirs again");
    await controller.handleMessage({
      type: "selectConversation",
      conversationId: dm,
    });
    expect(last().selected?.conversation.first_unread_sequence).toBe(7);
    expect(last().selected?.conversation.unread_count).toBe(1);
  });

  test("opening a hit walks every page down to the message, not a fixed number of pages", async () => {
    const { controller, last, server, dm } = setup({
      capabilities: { stream: false, reactions: false, search: true },
      pageSize: 1,
    });
    for (let i = 0; i < 90; i++) server.post(GRACE, dm, `filler ${i}`);
    await controller.handleMessage({ type: "ready" });
    await controller.handleMessage({ type: "search", query: "launch key" });
    const hit = last().search?.hits[0];
    if (!hit) throw new Error("no hit");
    await controller.handleMessage({
      type: "openSearchHit",
      conversationId: hit.conversation_id,
      messageId: hit.message_id,
      sequence: hit.sequence,
    });
    expect(last().selected?.messages[0]?.sequence).toBe(1);
    expect(last().selected?.highlight_message_id).toBe(hit.message_id);
    expect(last().notice).toBeNull();
  });
});

describe("older servers", () => {
  test("a service built before #64/#66 (no counters, chips, summaries or references capability) still loads", async () => {
    const server = new FakeTeamServer();
    const dm = server.seedDm(ADA, GRACE, ["old", "server", "shape"]);
    const strip = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(strip);
      if (value && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          // Pre-#64 shapes: no list counters, no chips/summaries/excerpts on
          // messages, no `references` capability (the boolean `reactions`
          // capability itself stays).
          const dropped =
            [
              "unread_count",
              "last_message_at",
              "reply_excerpt",
              "reply_restricted",
            ].includes(k) ||
            (k === "references" &&
              (Array.isArray(v) || typeof v === "boolean")) ||
            (k === "reactions" && Array.isArray(v));
          if (!dropped) out[k] = k === "capabilities" ? strip(v) : v;
        }
        return out;
      }
      return value;
    };
    const inner = server.transport(ADA);
    const client = new TeamClient({
      send: async (request, signal) => strip(await inner.send(request, signal)),
    });
    const service = new RpcTeamService(client);
    const states: TeamChatViewState[] = [];
    const controller = new TeamChatController({
      post: (state) => states.push(state),
      service,
      viewer: "service",
      pageSize: 50,
    });
    await controller.handleMessage({ type: "ready" });
    await controller.handleMessage({
      type: "selectConversation",
      conversationId: dm,
    });
    const last = states[states.length - 1];
    expect(last?.conversations.map((c) => c.conversation_id)).toEqual([dm]);
    expect(last?.selected?.messages).toHaveLength(3);
    // Cache covers the span: the count skips the viewer's own post.
    expect(last?.selected?.conversation.unread_count).toBe(2);
    expect(last?.selected?.messages[0]?.reactions).toEqual([]);
    expect(last?.capabilities).toEqual({
      reactions: false,
      search: false,
      realtime: true,
    });
  });
});

describe("older servers: unread counts", () => {
  test("without a server counter the inbox fetches the unread span so own posts are not counted", async () => {
    const server = new FakeTeamServer();
    const dm = server.seedDm(ADA, GRACE, ["a", "b", "c", "d", "e", "f"]);
    // Seeded authors alternate grace/ada: 3 of 6 are the viewer's own.
    const inner = server.transport(ADA);
    const client = new TeamClient({
      send: async (request, signal) => {
        const result = (await inner.send(request, signal)) as unknown;
        if (request.method !== "conversations.list") return result;
        return (result as Record<string, unknown>[]).map(
          ({ unread_count: _u, last_message_at: _l, ...rest }) => rest,
        );
      },
    });
    const service = new RpcTeamService(client);
    const states: TeamChatViewState[] = [];
    const controller = new TeamChatController({
      post: (state) => states.push(state),
      service,
      viewer: "service",
      pageSize: 2,
    });
    await controller.handleMessage({ type: "ready" });
    const summary = states[states.length - 1]?.conversations.find(
      (c) => c.conversation_id === dm,
    );
    expect(summary?.unread_count).toBe(3);
    expect(summary?.first_unread_sequence).toBe(1);
    const spans = server.calls.filter(
      (c) => c.method === "messages.history" && c.params.after_seq === 0,
    );
    expect(spans).toHaveLength(1);
  });
});

describe("older servers: page limits", () => {
  test("history requests never exceed the server's advertised page_limit", async () => {
    const server = new FakeTeamServer({ pageLimit: 3 });
    const dm = server.seedDm(ADA, GRACE, ["a", "b", "c", "d", "e", "f"]);
    const inner = server.transport(ADA);
    const client = new TeamClient({
      send: async (request, signal) => {
        const result = (await inner.send(request, signal)) as unknown;
        if (request.method !== "conversations.list") return result;
        return (result as Record<string, unknown>[]).map(
          ({ unread_count: _u, last_message_at: _l, ...rest }) => rest,
        );
      },
    });
    const service = new RpcTeamService(client);
    const states: TeamChatViewState[] = [];
    const controller = new TeamChatController({
      post: (state) => states.push(state),
      service,
      viewer: "service",
      pageSize: 50,
    });
    await controller.handleMessage({ type: "ready" });
    await controller.handleMessage({
      type: "selectConversation",
      conversationId: dm,
    });
    const last = states[states.length - 1];
    expect(last?.conversations.map((c) => c.conversation_id)).toEqual([dm]);
    // The adapter pages backwards until the requested 50 are collected.
    expect(last?.selected?.messages.map((m) => m.sequence)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
    expect(last?.selected?.older_cursor).toBeNull();
    for (const call of server.calls)
      if (call.method === "messages.history")
        expect(Number(call.params.limit)).toBeLessThanOrEqual(3);
    // Partial span: the count stays conservative-but-bounded and the
    // boundary at the read cursor.
    expect(last?.selected?.conversation.first_unread_sequence).toBe(1);
  });
});

describe("review fixes, round 5", () => {
  test("an edit event refreshes the inbox preview of an unselected conversation", async () => {
    const { controller, last, server, dm, group } = setup();
    await controller.handleMessage({ type: "ready" });
    await controller.handleMessage({
      type: "selectConversation",
      conversationId: group,
    });
    const latest = server.messages
      .filter((m) => m.conversation_id === dm)
      .at(-1);
    if (!latest) throw new Error("no dm message");
    latest.body = "edited body";
    latest.edited_at = "2026-01-02T00:00:00.000Z";
    await controller.notifyDelivery(dm, "edit", latest.seq);
    const preview = last().conversations.find((c) => c.conversation_id === dm)
      ?.last_message?.excerpt;
    expect(preview).toBe("edited body");
  });

  test("a reload keeps history already paged in on a small-page server", async () => {
    const server = new FakeTeamServer({ pageLimit: 2 });
    const dm = server.seedDm(ADA, GRACE, ["a", "b", "c", "d", "e"]);
    const client = new TeamClient(server.transport(ADA));
    const service = new RpcTeamService(client);
    const states: TeamChatViewState[] = [];
    const controller = new TeamChatController({
      post: (state) => states.push(state),
      service,
      viewer: "service",
      pageSize: 2,
    });
    const last = () => states[states.length - 1];
    await controller.handleMessage({ type: "ready" });
    await controller.handleMessage({
      type: "selectConversation",
      conversationId: dm,
    });
    expect(last()?.selected?.messages.map((m) => m.sequence)).toEqual([4, 5]);
    await controller.handleMessage({
      type: "loadOlder",
      conversationId: dm,
      cursor: "seq:4",
    });
    expect(last()?.selected?.messages.map((m) => m.sequence)).toEqual([
      2, 3, 4, 5,
    ]);
    server.post(GRACE, dm, "f");
    await controller.notifyDelivery(dm, "message", 6);
    expect(last()?.selected?.messages.map((m) => m.sequence)).toEqual([
      2, 3, 4, 5, 6,
    ]);
  });

  test("without a server counter a long unread span still yields the latest preview", async () => {
    const server = new FakeTeamServer({ pageLimit: 3 });
    const dm = server.seedDm(ADA, GRACE, ["a", "b", "c", "d", "e", "f", "g"]);
    const inner = server.transport(ADA);
    const client = new TeamClient({
      send: async (request, signal) => {
        const result = (await inner.send(request, signal)) as unknown;
        if (request.method !== "conversations.list") return result;
        return (result as Record<string, unknown>[]).map(
          ({ unread_count: _u, last_message_at: _l, ...rest }) => rest,
        );
      },
    });
    const service = new RpcTeamService(client);
    const states: TeamChatViewState[] = [];
    const controller = new TeamChatController({
      post: (state) => states.push(state),
      service,
      viewer: "service",
      pageSize: 3,
    });
    await controller.handleMessage({ type: "ready" });
    const summary = states[states.length - 1]?.conversations.find(
      (c) => c.conversation_id === dm,
    );
    expect(summary?.last_message?.excerpt).toBe("g");
    expect(summary?.last_sequence).toBe(7);
  });
});

describe("review fixes, round 6", () => {
  test("a byte-cut (short) history page is not treated as exhaustion", async () => {
    const server = new FakeTeamServer();
    const dm = server.seedDm(ADA, GRACE, ["a", "b", "c", "d", "e"]);
    const client = new TeamClient(server.transport(ADA));
    const service = new RpcTeamService(client);
    const states: TeamChatViewState[] = [];
    const controller = new TeamChatController({
      post: (state) => states.push(state),
      service,
      viewer: "service",
      pageSize: 3,
    });
    const last = () => states[states.length - 1];
    await controller.handleMessage({ type: "ready" });
    server.shortPageOnce = true;
    await controller.handleMessage({
      type: "selectConversation",
      conversationId: dm,
    });
    // The adapter kept paging after the one-row page until 3 were collected.
    expect(last()?.selected?.messages.map((m) => m.sequence)).toEqual([
      3, 4, 5,
    ]);
    expect(last()?.selected?.older_cursor).toBe("seq:3");
    await controller.handleMessage({
      type: "loadOlder",
      conversationId: dm,
      cursor: "seq:3",
    });
    expect(last()?.selected?.messages.map((m) => m.sequence)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    expect(last()?.selected?.older_cursor).toBeNull();
  });
});
