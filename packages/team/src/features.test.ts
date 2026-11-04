import { afterEach, expect, test } from "bun:test";
import type { Message, Participant, TeamDeliveryEvent } from "@mars/contracts";
import { fixture, type OpenStream, TEAM, TOKENS } from "../test/fixture";
import type {
  ConversationListItem,
  ConversationViewResult,
  MessageView,
  ReactionState,
  SearchResult,
} from "./protocol";
import { DEFAULT_TEAM_LIMITS } from "./schemas";
import { EventStream } from "./server";
import { excerptAround, headExcerpt, isValidEmoji } from "./text";

type View = ConversationViewResult;
const fixtures: ReturnType<typeof fixture>[] = [];
const streams: OpenStream[] = [];
afterEach(async () => {
  for (const s of streams.splice(0)) s.abort();
  for (const f of fixtures.splice(0)) await f.close();
});
function start(limits?: Parameters<typeof fixture>[0]) {
  const f = fixture({ stream_heartbeat_ms: 60, ...limits });
  fixtures.push(f);
  return f;
}
async function open(
  f: ReturnType<typeof fixture>,
  ...args: Parameters<ReturnType<typeof fixture>["stream"]>
) {
  const s = await f.stream(...args);
  streams.push(s);
  return s;
}
const messageSeqs = (events: TeamDeliveryEvent[]) =>
  events.filter((e) => e.kind === "message").map((e) => e.message_seq);

test(
  "an idle SSE stream survives Bun's request timeout and delivers a later event",
  { timeout: 20_000 },
  async () => {
    const f = fixture();
    fixtures.push(f);
    const dm = await f.ok<View>("alice", "conversations.create_dm", {
      peer_user_id: "bob",
    });
    const id = dm.conversation.conversation_id;
    const stream = await open(f, "alice", [
      { conversation_id: id, after_event_seq: 0 },
    ]);
    expect(stream.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 11_500));

    const rpc = await f.rpc("alice", "conversations.list", {});
    expect(rpc.status).toBe(200);
    const sent = await f.ok<Message>("bob", "messages.send", {
      conversation_id: id,
      client_message_id: "after-idle",
      body: "still connected",
    });
    await stream.waitFor(() => messageSeqs(stream.events).includes(sent.seq));

    expect(messageSeqs(stream.events)).toContain(sent.seq);
    expect(stream.ended).toBe(false);
    expect(stream.closes).toEqual([]);
  },
);

test("(a) a lost acknowledgement plus a reconnecting reader yields exactly one message in the same order on both clients", async () => {
  const f = start();
  const dm = await f.ok<View>("alice", "conversations.create_dm", {
    peer_user_id: "bob",
  });
  const id = dm.conversation.conversation_id;
  const alice = await open(f, "alice", [
    { conversation_id: id, after_event_seq: 0 },
  ]);
  const bob = await open(f, "bob", [
    { conversation_id: id, after_event_seq: 0 },
  ]);
  expect(alice.status).toBe(200);
  expect(bob.status).toBe(200);
  await f.ok<Message>("alice", "messages.send", {
    conversation_id: id,
    client_message_id: "m1",
    body: "first",
  });
  // The acknowledgement of m2 is interrupted client-side; the server may or
  // may not have committed it. The retry carries the same ids.
  const interrupted = new AbortController();
  const attempt = f
    .raw(
      {
        method: "messages.send",
        context: { schema_version: 1, team_id: TEAM, request_id: "send-m2" },
        params: {
          conversation_id: id,
          client_message_id: "m2",
          body: "second",
        },
      },
      {},
      { signal: interrupted.signal },
    )
    .catch(() => null);
  interrupted.abort();
  await attempt;
  const retry = await f.ok<Message>(
    "alice",
    "messages.send",
    { conversation_id: id, client_message_id: "m2", body: "second" },
    { request_id: "send-m2" },
  );
  expect(retry.seq).toBe(2);
  await f.ok<Message>("bob", "messages.send", {
    conversation_id: id,
    client_message_id: "b1",
    body: "third",
  });
  await alice.waitFor(() => messageSeqs(alice.events).length === 3);
  // Bob's connection drops after the first frames; he resumes from his cursor.
  await bob.waitFor(() => bob.events.length >= 2);
  bob.abort();
  await bob.done;
  const resumed = await open(f, "bob", [
    {
      conversation_id: id,
      after_event_seq: bob.events[bob.events.length - 1]?.event_seq ?? 0,
    },
  ]);
  const bobAll = () => [...bob.events, ...resumed.events];
  await resumed.waitFor(() => messageSeqs(bobAll()).length === 3);
  expect(messageSeqs(alice.events)).toEqual([1, 2, 3]);
  expect(messageSeqs(bobAll())).toEqual([1, 2, 3]);
  expect(alice.events.map((e) => e.event_seq)).toEqual(
    bobAll().map((e) => e.event_seq),
  );
  const history = await f.ok<MessageView[]>("bob", "messages.history", {
    conversation_id: id,
  });
  expect(history.map((m) => m.body)).toEqual(["first", "second", "third"]);
  for (const frame of alice.frames)
    expect(frame.id).toBe(String(JSON.parse(frame.data).event_seq));
  const raw = JSON.stringify(alice.frames);
  for (const body of ["first", "second", "third"])
    expect(raw).not.toContain(body);
});

test("(b) backfill switches to live without a gap or a duplicate while sends race the connection", async () => {
  const f = start({ max_stream_batch_events: 4, max_poll_events: 4 });
  const group = await f.ok<View>("alice", "conversations.create_group", {
    member_ids: ["bob", "carol"],
    title: "race",
  });
  const id = group.conversation.conversation_id;
  const send = (user: "alice" | "bob", n: number) =>
    f.ok<Message>(user, "messages.send", {
      conversation_id: id,
      client_message_id: `k${n}`,
      body: `message ${n}`,
    });
  for (let n = 1; n <= 10; n++) await send("alice", n);
  // Fire the next batch while the stream connects and backfills page by page.
  const racing = Promise.all(
    Array.from({ length: 10 }, (_, i) => send("bob", 11 + i)),
  );
  const carol = await open(f, "carol", [
    { conversation_id: id, after_event_seq: 0 },
  ]);
  expect(carol.status).toBe(200);
  await racing;
  for (let n = 21; n <= 25; n++) await send("alice", n);
  await carol.waitFor(() => carol.events.length === 26);
  // Event 1 is the membership row from creation; then 25 message rows.
  expect(carol.events.map((e) => e.event_seq)).toEqual(
    Array.from({ length: 26 }, (_, i) => i + 1),
  );
  expect(carol.events[0]?.kind).toBe("membership");
  expect(messageSeqs(carol.events)).toEqual(
    Array.from({ length: 25 }, (_, i) => i + 1),
  );
  await carol.waitFor(() => carol.comments.includes("heartbeat"));
  expect(new Set(carol.events.map((e) => e.event_seq)).size).toBe(26);
});

test("(c) a nonmember gets no stream, no search hits and no reply excerpt from before joining", async () => {
  const f = start();
  const dm = await f.ok<View>("alice", "conversations.create_dm", {
    peer_user_id: "bob",
  });
  const id = dm.conversation.conversation_id;
  const secret = await f.ok<Message>("alice", "messages.send", {
    conversation_id: id,
    client_message_id: "s",
    body: "the launch code is pelican",
  });
  const denied = await open(f, "carol", [
    { conversation_id: id, after_event_seq: 0 },
  ]);
  expect(denied.status).toBe(404);
  expect(denied.error?.code).toBe("not_found");
  // A stream over one allowed and one forbidden conversation is refused whole.
  const own = await f.ok<View>("carol", "conversations.create_dm", {
    peer_user_id: "bob",
  });
  const mixed = await open(f, "carol", [
    { conversation_id: own.conversation.conversation_id, after_event_seq: 0 },
    { conversation_id: id, after_event_seq: 0 },
  ]);
  expect(mixed.status).toBe(404);
  const search = await f.ok<SearchResult>("carol", "messages.search", {
    query: "pelican",
  });
  expect(search).toEqual({ hits: [], next_cursor: null });
  expect(
    (
      await f.rpc("carol", "messages.search", {
        query: "pelican",
        conversation_id: id,
      })
    ).status,
  ).toBe(404);
  expect(
    (await f.rpc("stranger", "messages.search", { query: "pelican" })).body
      .error?.code,
  ).toBe("forbidden");
  expect(
    (
      await f.rpc("carol", "reactions.set", {
        message_id: secret.message_id,
        emoji: "👀",
        on: true,
      })
    ).status,
  ).toBe(404);
  // Late joiner: a reply to a message before the join shows no excerpt.
  const group = await f.ok<View>("alice", "conversations.create_group", {
    member_ids: ["bob"],
    title: "g",
  });
  const gid = group.conversation.conversation_id;
  const early = await f.ok<Message>("alice", "messages.send", {
    conversation_id: gid,
    client_message_id: "e",
    body: "early private text",
  });
  await f.ok<View>("alice", "conversations.add_member", {
    conversation_id: gid,
    user_id: "carol",
    expected_revision: 0,
  });
  await f.ok<Message>("bob", "messages.send", {
    conversation_id: gid,
    client_message_id: "r",
    body: "replying",
    reply_to: early.message_id,
  });
  const forCarol = await f.ok<MessageView[]>("carol", "messages.history", {
    conversation_id: gid,
  });
  expect(forCarol).toHaveLength(1);
  expect(forCarol[0]).toMatchObject({
    reply_to: early.message_id,
    reply_excerpt: null,
    reply_restricted: true,
  });
  const forBob = await f.ok<MessageView[]>("bob", "messages.history", {
    conversation_id: gid,
  });
  expect(forBob[1]).toMatchObject({
    reply_excerpt: "early private text",
    reply_restricted: false,
  });
  expect(forBob[0]).toMatchObject({
    reply_to: null,
    reply_excerpt: null,
    reply_restricted: false,
  });
  expect(
    (
      await f.rpc("carol", "reactions.set", {
        message_id: early.message_id,
        emoji: "👀",
        on: true,
      })
    ).status,
  ).toBe(404);
  expect(
    await f.ok<SearchResult>("carol", "messages.search", { query: "private" }),
  ).toEqual({ hits: [], next_cursor: null });
});

test("(d) removal closes the open stream in the same call and denies reconnect; team removal does the same", async () => {
  const f = start();
  const group = await f.ok<View>("alice", "conversations.create_group", {
    member_ids: ["bob", "carol"],
    title: "g",
  });
  const id = group.conversation.conversation_id;
  const bob = await open(f, "bob", [
    { conversation_id: id, after_event_seq: 0 },
  ]);
  const carol = await open(f, "carol", [
    { conversation_id: id, after_event_seq: 0 },
  ]);
  await bob.waitFor(() => bob.events.length === 1);
  await f.ok<View>("alice", "conversations.remove_member", {
    conversation_id: id,
    user_id: "bob",
    expected_revision: 0,
  });
  // The close frame was written before remove_member answered.
  await bob.done;
  expect(bob.closes).toEqual([{ reason: "membership" }]);
  expect(bob.events.map((e) => e.kind)).toEqual(["membership"]);
  const again = await open(f, "bob", [
    { conversation_id: id, after_event_seq: 1 },
  ]);
  expect(again.status).toBe(404);
  for (const [method, params] of [
    ["events.poll", { cursors: [{ conversation_id: id, after_event_seq: 0 }] }],
    ["messages.history", { conversation_id: id }],
    ["messages.search", { query: "hello", conversation_id: id }],
  ] as const) {
    expect((await f.rpc("bob", method, params)).status).toBe(404);
  }
  await f.ok<Message>("alice", "messages.send", {
    conversation_id: id,
    client_message_id: "after",
    body: "hello after bob left",
  });
  expect(
    await f.ok<SearchResult>("bob", "messages.search", { query: "hello" }),
  ).toEqual({ hits: [], next_cursor: null });
  // Carol still receives; then the host removes her from the team.
  await carol.waitFor(() => messageSeqs(carol.events).length === 1);
  f.store.removeTeamMember({ team_id: TEAM, user_id: "carol" });
  await carol.done;
  expect(carol.closes).toEqual([{ reason: "membership" }]);
  expect(
    (
      await f.rpc("carol", "events.poll", {
        cursors: [{ conversation_id: id, after_event_seq: 0 }],
      })
    ).body.error?.code,
  ).toBe("forbidden");
  // Self-leave closes the leaver's own stream too.
  const alice = await open(f, "alice", [
    { conversation_id: id, after_event_seq: 0 },
  ]);
  await alice.waitFor(() => alice.events.length >= 1);
  const left = await f.ok<View>("alice", "conversations.leave", {
    conversation_id: id,
  });
  expect(left.participant.state).toBe("removed");
  await alice.done;
  expect(alice.closes).toEqual([{ reason: "membership" }]);
  expect(
    (await f.rpc("alice", "conversations.open", { conversation_id: id }))
      .status,
  ).toBe(404);
});

test("(e) reaction toggles are idempotent, emit one event per change and aggregate without naming users", async () => {
  const f = start({ max_reactions_per_message: 2 });
  const dm = await f.ok<View>("alice", "conversations.create_dm", {
    peer_user_id: "bob",
  });
  const id = dm.conversation.conversation_id;
  const message = await f.ok<Message>("alice", "messages.send", {
    conversation_id: id,
    client_message_id: "m",
    body: "react to me",
  });
  const react = (user: "alice" | "bob", emoji: string, on: boolean) =>
    f.ok<ReactionState>(user, "reactions.set", {
      message_id: message.message_id,
      emoji,
      on,
    });
  expect(await react("alice", "👍", true)).toEqual({
    message_id: message.message_id,
    emoji: "👍",
    count: 1,
    reacted: true,
  });
  expect(await react("alice", "👍", true)).toMatchObject({ count: 1 });
  expect(await react("bob", "👍", true)).toMatchObject({
    count: 2,
    reacted: true,
  });
  expect(await react("bob", "🎉", true)).toMatchObject({ count: 1 });
  expect(await react("alice", "👍", false)).toEqual({
    message_id: message.message_id,
    emoji: "👍",
    count: 1,
    reacted: false,
  });
  expect(await react("alice", "👍", false)).toMatchObject({ count: 1 });
  const events = await f.ok<TeamDeliveryEvent[]>("bob", "events.poll", {
    cursors: [{ conversation_id: id, after_event_seq: 0 }],
  });
  expect(events.map((e) => e.kind)).toEqual([
    "membership",
    "message",
    "reaction",
    "reaction",
    "reaction",
    "reaction",
  ]);
  for (const event of events.filter((e) => e.kind === "reaction"))
    expect(event).toMatchObject({
      message_id: message.message_id,
      message_seq: 1,
    });
  expect(JSON.stringify(events)).not.toContain("👍");
  const [forAlice] = await f.ok<MessageView[]>("alice", "messages.history", {
    conversation_id: id,
  });
  expect(forAlice?.reactions).toEqual([
    { emoji: "🎉", count: 1, reacted: false },
    { emoji: "👍", count: 1, reacted: false },
  ]);
  const [forBob] = await f.ok<MessageView[]>("bob", "messages.history", {
    conversation_id: id,
  });
  expect(forBob?.reactions).toEqual([
    { emoji: "🎉", count: 1, reacted: true },
    { emoji: "👍", count: 1, reacted: true },
  ]);
  expect(JSON.stringify(forAlice)).not.toContain('"user_id"');
  // Distinct-key limit, denylist and shape checks.
  expect(
    (
      await f.rpc("alice", "reactions.set", {
        message_id: message.message_id,
        emoji: "🚀",
        on: true,
      })
    ).body.error?.code,
  ).toBe("too_large");
  for (const emoji of ["", "a".repeat(33), "ok\u200b", "\ufe0f", "a b", "\t"])
    expect(
      (
        await f.rpc("alice", "reactions.set", {
          message_id: message.message_id,
          emoji,
          on: true,
        })
      ).status,
    ).toBe(400);
  expect(isValidEmoji("❤", 32)).toBe(true);
  expect(isValidEmoji("❤\ufe0f", 32)).toBe(false);
  expect(
    (
      await f.rpc("alice", "reactions.set", {
        message_id: "missing",
        emoji: "👍",
        on: true,
      })
    ).status,
  ).toBe(404);
});

test("(f) search is membership-filtered before excerpting: nothing from before a join or after a leave, excerpts are bounded and cursors are bound to the query", async () => {
  const f = start();
  const group = await f.ok<View>("alice", "conversations.create_group", {
    member_ids: ["bob"],
    title: "g",
  });
  const id = group.conversation.conversation_id;
  const send = (user: "alice" | "bob", key: string, body: string) =>
    f.ok<Message>(user, "messages.send", {
      conversation_id: id,
      client_message_id: key,
      body,
    });
  await send("alice", "a1", "Needle before carol joined");
  await f.ok<View>("alice", "conversations.add_member", {
    conversation_id: id,
    user_id: "carol",
    expected_revision: 0,
  });
  const long = `${"x".repeat(300)} NEEDLE in the middle ${"y".repeat(300)}`;
  await send("bob", "b1", long);
  await send("alice", "a2", "needle %_\\ literal chars");
  await send("alice", "a3", "no match here");
  const carolHits = await f.ok<SearchResult>("carol", "messages.search", {
    query: "needle",
  });
  expect(carolHits.hits.map((h) => h.seq)).toEqual([3, 2]);
  expect(carolHits.hits[1]).toMatchObject({
    conversation_id: id,
    author_id: "bob",
    cut_before: true,
    cut_after: true,
  });
  expect(carolHits.hits[1]?.excerpt.length).toBe(200);
  expect(carolHits.hits[1]?.excerpt).toContain("NEEDLE in the middle");
  expect(carolHits.hits[0]).toMatchObject({
    excerpt: "needle %_\\ literal chars",
    cut_before: false,
    cut_after: false,
  });
  expect(JSON.stringify(carolHits)).not.toContain("before carol");
  // Wildcards are literal: "%_" only matches the message that contains it.
  expect(
    (
      await f.ok<SearchResult>("carol", "messages.search", { query: "%_" })
    ).hits.map((h) => h.seq),
  ).toEqual([3]);
  expect(
    (
      await f.ok<SearchResult>("alice", "messages.search", { query: "needle" })
    ).hits.map((h) => h.seq),
  ).toEqual([3, 2, 1]);
  // Paging with an opaque cursor; tampering or reusing it for another query fails.
  const first = await f.ok<SearchResult>("alice", "messages.search", {
    query: "needle",
    limit: 2,
  });
  expect(first.hits.map((h) => h.seq)).toEqual([3, 2]);
  expect(first.next_cursor).not.toBeNull();
  const second = await f.ok<SearchResult>("alice", "messages.search", {
    query: "needle",
    limit: 2,
    cursor: first.next_cursor ?? "",
  });
  expect(second).toMatchObject({ next_cursor: null });
  expect(second.hits.map((h) => h.seq)).toEqual([1]);
  for (const cursor of [
    `${first.next_cursor}x`,
    Buffer.from("{}").toString("base64url"),
    "not-a-cursor",
  ])
    expect(
      (
        await f.rpc("alice", "messages.search", {
          query: "needle",
          cursor,
        })
      ).body.error?.code,
    ).toBe("invalid_request");
  expect(
    (
      await f.rpc("alice", "messages.search", {
        query: "NEEDLE",
        cursor: first.next_cursor,
      })
    ).body.error?.code,
  ).toBe("invalid_request");
  expect(
    (
      await f.rpc("bob", "messages.search", {
        query: "needle",
        cursor: first.next_cursor,
      })
    ).body.error?.code,
  ).toBe("invalid_request");
  // After leaving, the leaver's own authored rows stay but nothing is searchable.
  await f.ok<View>("alice", "conversations.leave", { conversation_id: id });
  expect(
    await f.ok<SearchResult>("alice", "messages.search", { query: "needle" }),
  ).toEqual({ hits: [], next_cursor: null });
  expect(
    (
      await f.ok<MessageView[]>("bob", "messages.history", {
        conversation_id: id,
      })
    ).map((m) => m.author_id),
  ).toEqual(["alice", "bob", "alice", "alice"]);
  for (const query of ["x", " a", "a".repeat(201), "ab\u200b", 7])
    expect((await f.rpc("bob", "messages.search", { query })).status).toBe(400);
  expect(excerptAround("short", "sh", 200)).toEqual({
    text: "short",
    cut_before: false,
    cut_after: false,
  });
  const emoji = `${"😀".repeat(150)}HIT${"😀".repeat(150)}`;
  const cut = excerptAround(emoji, "hit", 200);
  expect(cut.text.length).toBeLessThanOrEqual(200);
  expect(cut.text.length).toBeGreaterThanOrEqual(198);
  expect(cut.text).toContain("HIT");
  expect(cut.text).not.toMatch(/[\ud800-\udfff](?![\udc00-\udfff])/u);
});

test("(g) stream and search limits answer with fixed errors; routes and shapes are checked like /v1/rpc", async () => {
  const f = start({ max_open_streams_per_user: 2, max_search_per_minute: 2 });
  const dm = await f.ok<View>("alice", "conversations.create_dm", {
    peer_user_id: "bob",
  });
  const id = dm.conversation.conversation_id;
  const cursors = [{ conversation_id: id, after_event_seq: 0 }];
  const s1 = await open(f, "alice", cursors);
  const s2 = await open(f, "alice", cursors);
  expect([s1.status, s2.status]).toEqual([200, 200]);
  const s3 = await open(f, "alice", cursors);
  expect(s3.status).toBe(413);
  expect(s3.error).toMatchObject({ code: "too_large" });
  // Bob's quota is separate; closing one of Alice's frees a slot.
  expect((await open(f, "bob", cursors)).status).toBe(200);
  s1.abort();
  await s1.done;
  await Bun.sleep(20);
  expect((await open(f, "alice", cursors)).status).toBe(200);
  for (const [status, body] of [
    [400, { cursors: [] }],
    [
      400,
      {
        cursors: Array.from({ length: 51 }, (_, i) => ({
          conversation_id: `c${i}`,
          after_event_seq: 0,
        })),
      },
    ],
    [400, { cursors: [cursors[0], cursors[0]] }],
    [400, { cursors: [{ conversation_id: id, after_event_seq: 99 }] }],
    [400, { cursors: [{ conversation_id: id, after_event_seq: -1 }] }],
    [404, { cursors: [{ conversation_id: "nope", after_event_seq: 0 }] }],
  ] as const) {
    const s = await open(f, "bob", body.cursors);
    expect(s.status).toBe(status);
  }
  const envelope = (method: string) => ({
    method,
    context: { schema_version: 1, team_id: TEAM, request_id: "r" },
    params: { cursors },
  });
  expect((await f.raw(envelope("events.stream"))).status).toBe(400);
  const streamRaw = (
    body: unknown,
    headers: Record<string, string> = {},
    method = "POST",
  ) =>
    fetch(f.streamUrl, {
      method,
      headers: {
        authorization: `Bearer ${TOKENS.alice}`,
        "content-type": "application/json",
        ...headers,
      },
      body: method === "GET" ? null : JSON.stringify(body),
    });
  expect((await streamRaw(envelope("events.stream"), {}, "GET")).status).toBe(
    404,
  );
  expect((await streamRaw(envelope("events.poll"))).status).toBe(400);
  expect(
    (await streamRaw(envelope("events.stream"), { authorization: "Bearer x" }))
      .status,
  ).toBe(401);
  expect(
    (
      await streamRaw(envelope("events.stream"), {
        origin: "https://attacker.invalid",
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await streamRaw(envelope("events.stream"), {
        "content-type": "text/plain",
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await streamRaw({
        ...envelope("events.stream"),
        context: { schema_version: 1, team_id: "team-2", request_id: "r" },
      })
    ).status,
  ).toBe(403);
  const dave = await fetch(f.streamUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKENS.dave}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(envelope("events.stream")),
  });
  expect(dave.status).toBe(403);
  const ok = await open(f, "bob", cursors);
  expect(ok.status).toBe(200);
  await ok.waitFor(() => ok.comments.includes("heartbeat"));
  // Search rate: the third call inside the minute is `unavailable`.
  expect(
    (await f.rpc("alice", "messages.search", { query: "hello" })).status,
  ).toBe(200);
  expect(
    (await f.rpc("alice", "messages.search", { query: "hello" })).status,
  ).toBe(200);
  const limited = await f.rpc("alice", "messages.search", { query: "hello" });
  expect(limited.status).toBe(503);
  expect(limited.body.error).toEqual({
    code: "unavailable",
    message: "Team service is unavailable.",
  });
  expect(
    (await f.rpc("bob", "messages.search", { query: "hello" })).status,
  ).toBe(200);
  expect(
    (await f.rpc("alice", "messages.search", { query: "hello", limit: 51 }))
      .status,
  ).toBe(400);
  expect(DEFAULT_TEAM_LIMITS).toMatchObject({
    max_open_streams_per_user: 4,
    max_search_per_minute: 60,
    max_reactions_per_message: 64,
  });
});

test("conversations.list reports unread_count and last_message_at per participant; mark_read stays monotonic and bounded", async () => {
  const f = start();
  const dm = await f.ok<View>("alice", "conversations.create_dm", {
    peer_user_id: "bob",
  });
  const id = dm.conversation.conversation_id;
  const listed = async (user: "alice" | "bob") =>
    (await f.ok<ConversationListItem[]>(user, "conversations.list", {})).find(
      (c) => c.conversation.conversation_id === id,
    );
  expect(await listed("alice")).toMatchObject({
    unread_count: 0,
    last_message_at: null,
  });
  const sent: Message[] = [];
  for (let n = 1; n <= 3; n++)
    sent.push(
      await f.ok<Message>("alice", "messages.send", {
        conversation_id: id,
        client_message_id: `a${n}`,
        body: `from alice ${n}`,
      }),
    );
  expect(await listed("alice")).toMatchObject({
    unread_count: 0,
    last_message_at: sent[2]?.created_at,
  });
  expect(await listed("bob")).toMatchObject({
    unread_count: 3,
    last_message_at: sent[2]?.created_at,
  });
  const reply = await f.ok<Message>("bob", "messages.send", {
    conversation_id: id,
    client_message_id: "b1",
    body: "from bob",
  });
  expect(await listed("alice")).toMatchObject({
    unread_count: 1,
    last_message_at: reply.created_at,
  });
  expect(await listed("bob")).toMatchObject({ unread_count: 3 });
  expect(
    await f.ok<Participant>("bob", "conversations.mark_read", {
      conversation_id: id,
      read_seq: 2,
    }),
  ).toMatchObject({ read_seq: 2 });
  expect(await listed("bob")).toMatchObject({ unread_count: 1 });
  // Monotonic: a lower cursor is kept; above last_seq is rejected.
  expect(
    await f.ok<Participant>("bob", "conversations.mark_read", {
      conversation_id: id,
      read_seq: 1,
    }),
  ).toMatchObject({ read_seq: 2 });
  expect(
    (
      await f.rpc("bob", "conversations.mark_read", {
        conversation_id: id,
        read_seq: 5,
      })
    ).status,
  ).toBe(400);
  await f.ok<Participant>("bob", "conversations.mark_read", {
    conversation_id: id,
    read_seq: 4,
  });
  expect(await listed("bob")).toMatchObject({ unread_count: 0 });
  // A late joiner's counters start at the join point.
  const group = await f.ok<View>("alice", "conversations.create_group", {
    member_ids: ["bob"],
    title: "g",
  });
  const gid = group.conversation.conversation_id;
  await f.ok<Message>("alice", "messages.send", {
    conversation_id: gid,
    client_message_id: "g1",
    body: "before carol",
  });
  await f.ok<View>("alice", "conversations.add_member", {
    conversation_id: gid,
    user_id: "carol",
    expected_revision: 0,
  });
  const carolList = await f.ok<ConversationListItem[]>(
    "carol",
    "conversations.list",
    {},
  );
  expect(carolList[0]).toMatchObject({
    unread_count: 0,
    last_message_at: null,
  });
  const pinned = await f.ok<Participant>("carol", "conversations.pin", {
    conversation_id: gid,
    pinned: true,
  });
  expect(pinned.pinned).toBe(true);
});

test("every cursor is validated before a full first page can hide it (review fix)", async () => {
  const f = start({ max_stream_batch_events: 2, max_poll_events: 2 });
  const dm = await f.ok<View>("alice", "conversations.create_dm", {
    peer_user_id: "bob",
  });
  const id = dm.conversation.conversation_id;
  for (let n = 1; n <= 5; n++)
    await f.ok<Message>("alice", "messages.send", {
      conversation_id: id,
      client_message_id: `m${n}`,
      body: `fill ${n}`,
    });
  const other = await f.ok<View>("bob", "conversations.create_dm", {
    peer_user_id: "carol",
  });
  const foreign = other.conversation.conversation_id;
  // Alice is not in bob↔carol; the first cursor alone fills the 2-row page.
  const denied = await open(f, "alice", [
    { conversation_id: id, after_event_seq: 0 },
    { conversation_id: foreign, after_event_seq: 0 },
  ]);
  expect(denied.status).toBe(404);
  const stale = await open(f, "alice", [
    { conversation_id: id, after_event_seq: 0 },
    { conversation_id: id.replace(/./, "x"), after_event_seq: 0 },
  ]);
  expect(stale.status).toBe(404);
  expect(
    (
      await f.rpc("alice", "events.poll", {
        cursors: [
          { conversation_id: id, after_event_seq: 0 },
          { conversation_id: id, after_event_seq: 0 },
        ],
        limit: 1,
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await f.rpc("bob", "events.poll", {
        cursors: [
          { conversation_id: id, after_event_seq: 0 },
          { conversation_id: foreign, after_event_seq: 99 },
        ],
        limit: 1,
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await f.rpc("bob", "events.poll", {
        cursors: [
          { conversation_id: id, after_event_seq: 0 },
          { conversation_id: foreign, after_event_seq: 0 },
        ],
        limit: 1,
      })
    ).status,
  ).toBe(200);
});

test("excerpts are bounded in UTF-16 units and never split a surrogate pair (review fix)", async () => {
  const f = start();
  const dm = await f.ok<View>("alice", "conversations.create_dm", {
    peer_user_id: "bob",
  });
  const id = dm.conversation.conversation_id;
  const rockets = "🚀".repeat(150);
  const target = await f.ok<Message>("alice", "messages.send", {
    conversation_id: id,
    client_message_id: "t",
    body: rockets,
  });
  await f.ok<Message>("bob", "messages.send", {
    conversation_id: id,
    client_message_id: "r",
    body: "reply",
    reply_to: target.message_id,
  });
  const lone =
    /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u;
  const history = await f.ok<MessageView[]>("bob", "messages.history", {
    conversation_id: id,
  });
  expect(history).toHaveLength(2);
  const excerpt = history[1]?.reply_excerpt ?? "";
  expect(excerpt.length).toBe(200);
  expect(excerpt).toBe("🚀".repeat(100));
  expect(lone.test(excerpt)).toBe(false);
  const hits = await f.ok<SearchResult>("bob", "messages.search", {
    query: "🚀🚀",
  });
  expect(hits.hits).toHaveLength(1);
  expect(hits.hits[0]?.excerpt.length).toBeLessThanOrEqual(200);
  expect(lone.test(hits.hits[0]?.excerpt ?? "")).toBe(false);
  expect(hits.hits[0]).toMatchObject({ cut_before: false, cut_after: true });
  // Odd cut positions move inwards instead of splitting a pair.
  expect(headExcerpt(`a${"😀".repeat(100)}`, 200).text).toBe(
    `a${"😀".repeat(99)}`,
  );
  const around = excerptAround(`${"😀".repeat(200)}HIT`, "hit", 200);
  expect(around.text.length).toBeLessThanOrEqual(200);
  expect(around.text.endsWith("HIT")).toBe(true);
  expect(lone.test(around.text)).toBe(false);
});

test("a consumer that stops reading is disconnected at max_stream_buffer_bytes instead of growing the queue (review fix)", async () => {
  const f = start({ max_stream_buffer_bytes: 1024 });
  const dm = await f.ok<View>("alice", "conversations.create_dm", {
    peer_user_id: "bob",
  });
  const id = dm.conversation.conversation_id;
  let closed = 0;
  const stream = new EventStream(
    f.store,
    { team_id: TEAM, user_id: "bob" },
    new Map([[id, 0]]),
    () => {
      closed += 1;
    },
  );
  const unsubscribe = f.store.subscribe((notice) => stream.notice(notice));
  const response = stream.response(stream.initialPage());
  // A detached ReadableStream pulls only when read; this reader never reads
  // past the first chunk, so frames pile up in the stream's own queue.
  const reader = response.body?.getReader();
  if (!reader) throw new Error("no body");
  await Bun.sleep(10);
  let sent = 0;
  while (!stream.closed && sent < 100) {
    await f.ok<Message>("alice", "messages.send", {
      conversation_id: id,
      client_message_id: `m${sent}`,
      body: "x",
    });
    sent += 1;
  }
  unsubscribe();
  expect(stream.closed).toBe(true);
  expect(closed).toBe(1);
  expect(sent).toBeGreaterThan(3);
  expect(sent).toBeLessThan(20);
  const chunks: string[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(new TextDecoder().decode(value));
  }
  const text = chunks.join("");
  expect(text.startsWith(": connected")).toBe(true);
  expect(
    text.trimEnd().endsWith('event: close\ndata: {"reason":"unavailable"}'),
  ).toBe(true);
  // A live reader with the same bound keeps up without being disconnected.
  const live = await open(f, "bob", [
    { conversation_id: id, after_event_seq: 0 },
  ]);
  await live.waitFor(() => live.events.length === sent + 1);
  expect(live.closes).toEqual([]);
});

test("a rejoined member cannot replay a send from a previous membership window (review fix)", async () => {
  const f = start();
  const group = await f.ok<View>("alice", "conversations.create_group", {
    member_ids: ["bob"],
    title: "g",
  });
  const id = group.conversation.conversation_id;
  const params = {
    conversation_id: id,
    client_message_id: "old",
    body: "secret from the first window",
  };
  await f.ok<Message>("bob", "messages.send", params, {
    request_id: "send-old",
  });
  await f.ok<View>("bob", "conversations.leave", { conversation_id: id });
  await f.ok<View>("alice", "conversations.add_member", {
    conversation_id: id,
    user_id: "bob",
    expected_revision: 1,
  });
  for (const options of [{ request_id: "send-old" }, {}]) {
    const replay = await f.rpc("bob", "messages.send", params, options);
    expect(replay.status).toBe(409);
    expect(JSON.stringify(replay.body)).not.toContain("secret");
  }
  const history = await f.ok<MessageView[]>("bob", "messages.history", {
    conversation_id: id,
  });
  expect(history).toEqual([]);
  const fresh = await f.ok<MessageView>("bob", "messages.send", {
    conversation_id: id,
    client_message_id: "new",
    body: "after rejoining",
  });
  expect(fresh.seq).toBe(2);
});
