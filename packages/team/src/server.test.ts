import { afterEach, expect, test } from "bun:test";
import type { Message, Participant, TeamDeliveryEvent } from "@mars/contracts";
import { fixture, TEAM, TOKENS } from "../test/fixture";
import type { ConversationViewResult } from "./protocol";
import { serveTeam } from "./server";

type View = ConversationViewResult;
const fixtures: ReturnType<typeof fixture>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
function start(limits?: Parameters<typeof fixture>[0]) {
  const f = fixture(limits);
  fixtures.push(f);
  return f;
}

test("(a) a team member outside a conversation cannot open, read, poll or mark it and sees no outbox rows", async () => {
  const f = start();
  const dm = await f.ok<View>("alice", "conversations.create_dm", {
    peer_user_id: "bob",
  });
  const id = dm.conversation.conversation_id;
  await f.ok<Message>("alice", "messages.send", {
    conversation_id: id,
    client_message_id: "m1",
    body: "hello bob",
  });
  expect(await f.ok<View[]>("carol", "conversations.list", {})).toEqual([]);
  for (const [method, params] of [
    ["conversations.open", { conversation_id: id }],
    ["messages.history", { conversation_id: id }],
    ["events.poll", { cursors: [{ conversation_id: id, after_event_seq: 0 }] }],
    ["conversations.mark_read", { conversation_id: id, read_seq: 1 }],
    ["conversations.pin", { conversation_id: id, pinned: true }],
    [
      "messages.send",
      { conversation_id: id, client_message_id: "x", body: "intrude" },
    ],
    [
      "conversations.remove_member",
      { conversation_id: id, user_id: "bob", expected_revision: 0 },
    ],
  ] as const) {
    const response = await f.rpc("carol", method, params);
    expect(response.status).toBe(404);
    expect(response.body.error?.code).toBe("not_found");
    expect(JSON.stringify(response.body)).not.toContain("hello bob");
  }
  // Absent conversations answer identically, so existence does not leak.
  const absent = await f.rpc("carol", "conversations.open", {
    conversation_id: "no-such-conversation",
  });
  expect(absent.status).toBe(404);
  // Members still see everything.
  const bobView = await f.ok<View>("bob", "conversations.open", {
    conversation_id: id,
  });
  expect(bobView.conversation.last_seq).toBe(1);
  const events = await f.ok<TeamDeliveryEvent[]>("bob", "events.poll", {
    cursors: [{ conversation_id: id, after_event_seq: 0 }],
  });
  expect(events.map((event) => event.kind)).toEqual(["membership", "message"]);
  for (const event of events) expect(Object.keys(event)).not.toContain("body");
  // A user from another team and an authenticated user without a membership row are forbidden.
  expect((await f.rpc("dave", "conversations.list", {})).status).toBe(403);
  expect(
    (await f.rpc("dave", "conversations.list", {}, { team_id: "team-2" }))
      .status,
  ).toBe(200);
  expect((await f.rpc("stranger", "conversations.list", {})).status).toBe(403);
  expect(
    (await f.rpc("alice", "conversations.list", {}, { team_id: "team-2" }))
      .status,
  ).toBe(403);
});

test("(b) lost acknowledgement replay returns the identical message and never a second row", async () => {
  const f = start();
  const dm = await f.ok<View>("alice", "conversations.create_dm", {
    peer_user_id: "bob",
  });
  const id = dm.conversation.conversation_id;
  const params = {
    conversation_id: id,
    client_message_id: "client-1",
    body: "first",
  };
  const first = await f.ok<Message>("alice", "messages.send", params, {
    request_id: "r1",
  });
  const sameRequest = await f.ok<Message>("alice", "messages.send", params, {
    request_id: "r1",
  });
  const newRequest = await f.ok<Message>("alice", "messages.send", params, {
    request_id: "r2",
  });
  expect(sameRequest).toEqual(first);
  expect(newRequest).toEqual(first);
  expect(first.seq).toBe(1);
  const history = await f.ok<Message[]>("bob", "messages.history", {
    conversation_id: id,
  });
  expect(history).toHaveLength(1);
  expect(history[0]?.message_id).toBe(first.message_id);
  const events = await f.ok<TeamDeliveryEvent[]>("bob", "events.poll", {
    cursors: [{ conversation_id: id, after_event_seq: 0 }],
  });
  expect(events.filter((event) => event.kind === "message")).toHaveLength(1);
  // Another author may reuse the same client id: the key is per author.
  const bobs = await f.ok<Message>("bob", "messages.send", {
    ...params,
    body: "mine",
  });
  expect(bobs.seq).toBe(2);
});

test("(c) the same client_message_id with a different body or a reused request id with other input is a conflict", async () => {
  const f = start();
  const dm = await f.ok<View>("alice", "conversations.create_dm", {
    peer_user_id: "bob",
  });
  const id = dm.conversation.conversation_id;
  await f.ok<Message>(
    "alice",
    "messages.send",
    { conversation_id: id, client_message_id: "c", body: "one" },
    { request_id: "r1" },
  );
  const changed = await f.rpc("alice", "messages.send", {
    conversation_id: id,
    client_message_id: "c",
    body: "two",
  });
  expect(changed.status).toBe(409);
  expect(changed.body.error?.code).toBe("conflict");
  expect(JSON.stringify(changed.body)).not.toContain("two");
  const reused = await f.rpc(
    "alice",
    "messages.send",
    { conversation_id: id, client_message_id: "d", body: "three" },
    { request_id: "r1" },
  );
  expect(reused.status).toBe(409);
  expect(
    await f.ok<Message[]>("alice", "messages.history", { conversation_id: id }),
  ).toHaveLength(1);
});

test("(d) two users creating the same DM concurrently get one conversation", async () => {
  const f = start();
  const [a, b] = await Promise.all([
    f.ok<View>("alice", "conversations.create_dm", { peer_user_id: "bob" }),
    f.ok<View>("bob", "conversations.create_dm", { peer_user_id: "alice" }),
  ]);
  expect(a.conversation.conversation_id).toBe(b.conversation.conversation_id);
  expect(a.conversation.kind).toBe("dm");
  expect(a.participant.user_id).toBe("alice");
  expect(b.participant.user_id).toBe("bob");
  const again = await f.ok<View>("alice", "conversations.create_dm", {
    peer_user_id: "bob",
  });
  expect(again.conversation.conversation_id).toBe(
    a.conversation.conversation_id,
  );
  expect(await f.ok<View[]>("alice", "conversations.list", {})).toHaveLength(1);
  expect(
    (await f.rpc("alice", "conversations.create_dm", { peer_user_id: "alice" }))
      .status,
  ).toBe(400);
  expect(
    (await f.rpc("alice", "conversations.create_dm", { peer_user_id: "dave" }))
      .status,
  ).toBe(404);
  expect(
    (
      await f.rpc("alice", "conversations.create_dm", {
        peer_user_id: "nobody",
      })
    ).status,
  ).toBe(404);
});

test("(e) removal is immediate, expected_revision protects membership, and a late joiner sees nothing before joining", async () => {
  const f = start();
  const group = await f.ok<View>("alice", "conversations.create_group", {
    member_ids: ["bob", "carol"],
    title: "Launch",
  });
  const id = group.conversation.conversation_id;
  expect(group.members.map((member) => member.user_id)).toEqual([
    "alice",
    "bob",
    "carol",
  ]);
  await f.ok<Message>("carol", "messages.send", {
    conversation_id: id,
    client_message_id: "c1",
    body: "carol was here",
  });
  await f.ok<Message>("alice", "messages.send", {
    conversation_id: id,
    client_message_id: "a1",
    body: "before removal",
  });
  const stale = await f.rpc("alice", "conversations.remove_member", {
    conversation_id: id,
    user_id: "carol",
    expected_revision: 7,
  });
  expect(stale.status).toBe(409);
  const removed = await f.ok<View>("alice", "conversations.remove_member", {
    conversation_id: id,
    user_id: "carol",
    expected_revision: 0,
  });
  expect(removed.conversation.revision).toBe(1);
  expect(
    removed.members.find((member) => member.user_id === "carol")?.state,
  ).toBe("removed");
  for (const [method, params] of [
    ["conversations.open", { conversation_id: id }],
    ["messages.history", { conversation_id: id }],
    ["events.poll", { cursors: [{ conversation_id: id, after_event_seq: 0 }] }],
    [
      "messages.send",
      { conversation_id: id, client_message_id: "c2", body: "still here?" },
    ],
  ] as const) {
    const response = await f.rpc("carol", method, params);
    expect(response.status).toBe(404);
  }
  expect(await f.ok<View[]>("carol", "conversations.list", {})).toEqual([]);
  await f.ok<Message>("bob", "messages.send", {
    conversation_id: id,
    client_message_id: "b1",
    body: "while carol is out",
  });
  // Re-adding with the old revision fails; with the current one it succeeds.
  expect(
    (
      await f.rpc("bob", "conversations.add_member", {
        conversation_id: id,
        user_id: "carol",
        expected_revision: 0,
      })
    ).status,
  ).toBe(409);
  const readded = await f.ok<View>("bob", "conversations.add_member", {
    conversation_id: id,
    user_id: "carol",
    expected_revision: 1,
  });
  expect(readded.conversation.revision).toBe(2);
  await f.ok<Message>("alice", "messages.send", {
    conversation_id: id,
    client_message_id: "a2",
    body: "after rejoin",
  });
  const carolHistory = await f.ok<Message[]>("carol", "messages.history", {
    conversation_id: id,
  });
  expect(carolHistory.map((message) => message.body)).toEqual(["after rejoin"]);
  const carolView = await f.ok<View>("carol", "conversations.open", {
    conversation_id: id,
  });
  expect(carolView.participant.joined_seq).toBe(3);
  const carolEvents = await f.ok<TeamDeliveryEvent[]>("carol", "events.poll", {
    cursors: [{ conversation_id: id, after_event_seq: 0 }],
  });
  expect(carolEvents.map((event) => event.kind)).toEqual([
    "membership",
    "message",
  ]);
  expect(carolEvents[1]?.message_seq).toBe(4);
  // Replying to a message from before the join is refused; read cursor is bounded and monotonic.
  expect(
    (
      await f.rpc("carol", "messages.send", {
        conversation_id: id,
        client_message_id: "c3",
        body: "reply",
        reply_to: carolHistory[0]?.message_id,
      })
    ).status,
  ).toBe(200);
  const hidden = (
    await f.ok<Message[]>("alice", "messages.history", { conversation_id: id })
  )[0];
  expect(
    (
      await f.rpc("carol", "messages.send", {
        conversation_id: id,
        client_message_id: "c4",
        body: "reply",
        reply_to: hidden?.message_id,
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await f.rpc("carol", "conversations.mark_read", {
        conversation_id: id,
        read_seq: 99,
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await f.ok<Participant>("carol", "conversations.mark_read", {
        conversation_id: id,
        read_seq: 5,
      })
    ).read_seq,
  ).toBe(5);
  expect(
    (
      await f.ok<Participant>("carol", "conversations.mark_read", {
        conversation_id: id,
        read_seq: 4,
      })
    ).read_seq,
  ).toBe(5);
  expect(
    (
      await f.ok<Participant>("carol", "conversations.pin", {
        conversation_id: id,
        pinned: true,
      })
    ).pinned,
  ).toBe(true);
  expect(
    (await f.ok<View[]>("carol", "conversations.list", {}))[0]?.participant
      .pinned,
  ).toBe(true);
  // DMs have fixed membership; already-active members and non-members are refused.
  const dm = await f.ok<View>("alice", "conversations.create_dm", {
    peer_user_id: "bob",
  });
  expect(
    (
      await f.rpc("alice", "conversations.add_member", {
        conversation_id: dm.conversation.conversation_id,
        user_id: "carol",
        expected_revision: 0,
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await f.rpc("alice", "conversations.add_member", {
        conversation_id: id,
        user_id: "bob",
        expected_revision: 2,
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await f.rpc("alice", "conversations.add_member", {
        conversation_id: id,
        user_id: "dave",
        expected_revision: 2,
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await f.rpc("alice", "conversations.create_group", {
        member_ids: ["dave"],
        title: "x",
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await f.rpc("alice", "conversations.create_group", {
        member_ids: [],
        title: "solo",
      })
    ).status,
  ).toBe(400);
});

test("(f) history pages by count and bytes in both directions without dropping or duplicating a message", async () => {
  const f = start({ max_page_bytes: 2_000 });
  const dm = await f.ok<View>("alice", "conversations.create_dm", {
    peer_user_id: "bob",
  });
  const id = dm.conversation.conversation_id;
  const total = 23;
  for (let index = 1; index <= total; index++)
    await f.ok<Message>(index % 2 ? "alice" : "bob", "messages.send", {
      conversation_id: id,
      client_message_id: `m${index}`,
      body: `message ${index} ${"x".repeat(200)}`,
    });
  const forward: number[] = [];
  let after = 0;
  for (let guard = 0; guard < 50; guard++) {
    const page = await f.ok<Message[]>("bob", "messages.history", {
      conversation_id: id,
      after_seq: after,
      limit: 7,
    });
    if (page.length === 0) break;
    expect(page.length).toBeLessThanOrEqual(7);
    expect(
      Buffer.byteLength(JSON.stringify({ result: page })),
    ).toBeLessThanOrEqual(2_000);
    forward.push(...page.map((message) => message.seq));
    after = page.at(-1)?.seq ?? after;
  }
  expect(forward).toEqual(
    Array.from({ length: total }, (_, index) => index + 1),
  );
  // Byte cut happened: 7 messages of ~330 bytes exceed 2000 bytes.
  const firstPage = await f.ok<Message[]>("bob", "messages.history", {
    conversation_id: id,
    after_seq: 0,
    limit: 7,
  });
  expect(firstPage.length).toBeLessThan(7);
  const backward: number[] = [];
  let before: number | undefined;
  for (let guard = 0; guard < 50; guard++) {
    const page = await f.ok<Message[]>(
      "alice",
      "messages.history",
      before === undefined
        ? { conversation_id: id, limit: 5 }
        : { conversation_id: id, before_seq: before, limit: 5 },
    );
    if (page.length === 0) break;
    for (let index = 1; index < page.length; index++)
      expect(page[index]?.seq).toBeGreaterThan(page[index - 1]?.seq ?? 0);
    backward.unshift(...page.map((message) => message.seq));
    before = page[0]?.seq;
  }
  expect(backward).toEqual(forward);
  // A single message larger than the page fails closed instead of being skipped.
  const tiny = start({ max_page_bytes: 300 });
  const small = await tiny.ok<View>("alice", "conversations.create_dm", {
    peer_user_id: "bob",
  });
  await tiny.ok<Message>("alice", "messages.send", {
    conversation_id: small.conversation.conversation_id,
    client_message_id: "big",
    body: "y".repeat(400),
  });
  const oversized = await tiny.rpc("bob", "messages.history", {
    conversation_id: small.conversation.conversation_id,
  });
  expect(oversized.status).toBe(413);
  expect(oversized.body.error?.code).toBe("too_large");
});

test("(g) unknown cursors and conflicting cursors are invalid requests", async () => {
  const f = start();
  const dm = await f.ok<View>("alice", "conversations.create_dm", {
    peer_user_id: "bob",
  });
  const id = dm.conversation.conversation_id;
  await f.ok<Message>("alice", "messages.send", {
    conversation_id: id,
    client_message_id: "m1",
    body: "one",
  });
  for (const params of [
    { conversation_id: id, after_seq: 2 },
    { conversation_id: id, before_seq: 3 },
    { conversation_id: id, after_seq: 0, before_seq: 1 },
    { conversation_id: id, limit: 0 },
    { conversation_id: id, limit: 201 },
  ]) {
    const response = await f.rpc("bob", "messages.history", params);
    expect(response.status).toBe(400);
    expect(response.body.error?.code).toBe("invalid_request");
  }
  expect(
    await f.ok<Message[]>("bob", "messages.history", {
      conversation_id: id,
      after_seq: 1,
    }),
  ).toEqual([]);
  expect(
    await f.ok<Message[]>("bob", "messages.history", {
      conversation_id: id,
      before_seq: 1,
    }),
  ).toEqual([]);
  const events = await f.ok<TeamDeliveryEvent[]>("bob", "events.poll", {
    cursors: [{ conversation_id: id, after_event_seq: 0 }],
  });
  expect(events).toHaveLength(2);
  expect(
    (
      await f.rpc("bob", "events.poll", {
        cursors: [{ conversation_id: id, after_event_seq: 3 }],
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await f.rpc("bob", "events.poll", {
        cursors: [
          { conversation_id: id, after_event_seq: 0 },
          { conversation_id: id, after_event_seq: 1 },
        ],
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await f.rpc("bob", "events.poll", {
        cursors: Array.from({ length: 51 }, (_, index) => ({
          conversation_id: `c${index}`,
          after_event_seq: 0,
        })),
      })
    ).status,
  ).toBe(400);
  expect(
    await f.ok<TeamDeliveryEvent[]>("bob", "events.poll", {
      cursors: [{ conversation_id: id, after_event_seq: 2 }],
    }),
  ).toEqual([]);
  // Poll limit cuts per cursor order; cursors advance per conversation.
  const group = await f.ok<View>("alice", "conversations.create_group", {
    member_ids: ["bob"],
    title: "g",
  });
  await f.ok<Message>("alice", "messages.send", {
    conversation_id: group.conversation.conversation_id,
    client_message_id: "g1",
    body: "two",
  });
  const limited = await f.ok<TeamDeliveryEvent[]>("bob", "events.poll", {
    cursors: [
      { conversation_id: id, after_event_seq: 0 },
      {
        conversation_id: group.conversation.conversation_id,
        after_event_seq: 0,
      },
    ],
    limit: 3,
  });
  expect(
    limited.map((event) => [event.conversation_id, event.event_seq]),
  ).toEqual([
    [id, 1],
    [id, 2],
    [group.conversation.conversation_id, 1],
  ]);
});

test("(h) authentication, origin, route, size and shape checks match the workbench server", async () => {
  const f = start();
  const describe = {
    method: "team.describe",
    context: { schema_version: 1, team_id: TEAM, request_id: "r" },
    params: {},
  };
  for (const authorization of [
    "",
    "Bearer wrong",
    `Basic ${TOKENS.alice}`,
    `Bearer ${TOKENS.alice}x`,
    `Bearer ${"a".repeat(400)}`,
  ]) {
    const response = await f.raw(describe, { authorization });
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain(TOKENS.alice);
  }
  const ok = await f.raw(describe);
  expect(ok.status).toBe(200);
  expect(await ok.json()).toMatchObject({
    result: {
      team_id: TEAM,
      user_id: "alice",
      role: "member",
      capabilities: { stream: false, reactions: false, search: false },
    },
  });
  expect(ok.headers.get("cache-control")).toBe("no-store");
  expect(ok.headers.has("access-control-allow-origin")).toBe(false);
  expect(
    (await f.raw(describe, { origin: "https://attacker.invalid" })).status,
  ).toBe(403);
  expect((await f.raw(describe, { origin: "null" })).status).toBe(403);
  expect(
    (await f.raw(describe, { host: `attacker.invalid:${new URL(f.url).port}` }))
      .status,
  ).toBe(403);
  expect((await fetch(f.url)).status).toBe(404);
  expect(
    (await fetch(`${f.url}?token=${TOKENS.alice}`, { method: "POST" })).status,
  ).toBe(404);
  expect((await f.raw(describe, { "content-type": "text/plain" })).status).toBe(
    400,
  );
  expect((await f.raw("{")).status).toBe(400);
  const context = describe.context;
  for (const body of [
    null,
    [],
    {},
    { method: "shell.execute", context, params: {} },
    { method: "team.describe", params: {} },
    {
      method: "team.describe",
      context: { ...context, schema_version: 2 },
      params: {},
    },
    {
      method: "team.describe",
      context: { ...context, user_id: "bob" },
      params: {},
    },
    { method: "conversations.list", context, params: { extra: true } },
    { method: "events.stream", context, params: {} },
    { method: "reactions.set", context, params: {} },
    { method: "messages.search", context, params: { query: "x" } },
    {
      method: "messages.send",
      context,
      params: { conversation_id: "c", client_message_id: "", body: "x" },
    },
    {
      method: "messages.send",
      context,
      params: { conversation_id: "c", client_message_id: "k", body: "" },
    },
    {
      method: "messages.send",
      context,
      params: {
        conversation_id: "c",
        client_message_id: "k",
        body: "x".repeat(16_385),
      },
    },
    {
      method: "conversations.create_group",
      context,
      params: {
        member_ids: Array.from({ length: 33 }, (_, index) => `u${index}`),
        title: "big",
      },
    },
    {
      method: "conversations.create_group",
      context,
      params: { member_ids: ["bob"], title: "t".repeat(201) },
    },
  ])
    expect((await f.raw(body)).status).toBe(400);
  const huge = await f.raw({
    method: "messages.send",
    context,
    params: {
      conversation_id: "c",
      client_message_id: "k",
      body: "x".repeat(600 * 1024),
    },
  });
  expect(huge.status).toBe(413);
  const failed = await f.raw({
    method: "conversations.open",
    context,
    params: { conversation_id: `/host/private ${TOKENS.alice}` },
  });
  expect(failed.status).toBe(404);
  expect(await failed.text()).not.toContain("/host/private");
  expect(() =>
    serveTeam({
      store: f.store,
      authenticator: { authenticate: async () => null },
      port: -1,
    }),
  ).toThrow();
  expect(() =>
    serveTeam({
      store: f.store,
      authenticator: { authenticate: async () => null },
      port: 65_536,
    }),
  ).toThrow();
  const broken = serveTeam({
    store: f.store,
    authenticator: {
      async authenticate() {
        throw new Error(`provider down ${TOKENS.alice}`);
      },
    },
    port: 0,
  });
  try {
    const response = await fetch(`http://127.0.0.1:${broken.port}/v1/rpc`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKENS.alice}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(describe),
    });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(TOKENS.alice);
  } finally {
    await broken.stop(true);
  }
});

test("messages carry bodies to members only; outbox events carry metadata only; bodies are bounded in bytes", async () => {
  const f = start({ max_body_bytes: 64 });
  const dm = await f.ok<View>("alice", "conversations.create_dm", {
    peer_user_id: "bob",
  });
  const id = dm.conversation.conversation_id;
  const sent = await f.ok<Message>("alice", "messages.send", {
    conversation_id: id,
    client_message_id: "m",
    body: "héllo",
  });
  expect(sent.body_sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(sent.reference_ids).toEqual([]);
  const tooLong = await f.rpc("alice", "messages.send", {
    conversation_id: id,
    client_message_id: "m2",
    body: "界".repeat(30),
  });
  expect(tooLong.status).toBe(413);
  const events = await f.ok<TeamDeliveryEvent[]>("bob", "events.poll", {
    cursors: [{ conversation_id: id, after_event_seq: 1 }],
  });
  expect(events).toEqual([
    {
      conversation_id: id,
      event_seq: 2,
      kind: "message",
      message_seq: 1,
      message_id: sent.message_id,
      revision: 0,
    },
  ]);
  const reply = await f.ok<Message>("bob", "messages.send", {
    conversation_id: id,
    client_message_id: "r",
    body: "hi",
    reply_to: sent.message_id,
  });
  expect(reply.reply_to).toBe(sent.message_id);
  const other = await f.ok<View>("alice", "conversations.create_group", {
    member_ids: ["bob"],
    title: "g",
  });
  expect(
    (
      await f.rpc("bob", "messages.send", {
        conversation_id: other.conversation.conversation_id,
        client_message_id: "r2",
        body: "cross",
        reply_to: sent.message_id,
      })
    ).status,
  ).toBe(400);
});
