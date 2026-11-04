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
          controller?.notifyDelivery(event.conversation_id, event.kind),
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
    pageSize: 50,
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
            capabilities: { stream: false, reactions: false, search: false },
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
    // Nothing is read yet (read_seq 0) and the viewport has not reported in.
    expect(selected?.conversation.unread_count).toBe(3);
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
