import { describe, expect, test } from "bun:test";
import {
  FIXTURE_CONVERSATIONS as C,
  SITE_SHA,
  FIXTURE_USERS as U,
} from "@mars/team-chat";
import { TeamChatController } from "../src/teamChat/controller";
import {
  type TeamChatViewState,
  TeamChatWebviewMessageSchema,
} from "../src/teamChat/messages";

function setup(options: { pageSize?: number; sendDelayMs?: number } = {}) {
  const states: TeamChatViewState[] = [];
  let release: (() => void) | null = null;
  const controller = new TeamChatController({
    post: (state) => states.push(state),
    pageSize: options.pageSize ?? 3,
    sendDelayMs: options.sendDelayMs ?? 0,
    sleep: () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  });
  const last = () => {
    const state = states[states.length - 1];
    if (!state) throw new Error("no state emitted");
    return state;
  };
  return { controller, states, last, release: () => release?.() };
}

describe("message schema", () => {
  test("accepts only the strict union and never a viewer identity on reads/writes", () => {
    expect(
      TeamChatWebviewMessageSchema.safeParse({ type: "ready" }).success,
    ).toBe(true);
    expect(
      TeamChatWebviewMessageSchema.safeParse({ type: "ready", extra: 1 })
        .success,
    ).toBe(false);
    expect(
      TeamChatWebviewMessageSchema.safeParse({
        type: "send",
        conversationId: C.dmAdaGrace,
        clientMessageId: "cm_1",
        body: "hi",
        replyTo: null,
        references: [],
        userId: U.grace,
      }).success,
    ).toBe(false);
    expect(
      TeamChatWebviewMessageSchema.safeParse({
        type: "send",
        conversationId: C.dmAdaGrace,
        clientMessageId: "cm_1",
        body: "hi",
        replyTo: null,
        references: [
          {
            kind: "range",
            repo_id: "repo_fixture_site",
            commit_sha: "abc",
            path: "src/how.ts",
            line_start: 1,
            line_end: 2,
            symbol: null,
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      TeamChatWebviewMessageSchema.safeParse({
        type: "toggleReaction",
        messageId: "msg_dm_1",
        emoji: "🔥",
      }).success,
    ).toBe(false);
    expect(
      TeamChatWebviewMessageSchema.safeParse({
        type: "openReference",
        messageId: "m",
      }).success,
    ).toBe(false);
  });
});

describe("TeamChatController", () => {
  test("ready opens the inbox for the fixture viewer and selects the pinned conversation", async () => {
    const { controller, last } = setup();
    expect(await controller.handleMessage({ type: "nonsense" })).toBe(false);
    expect(await controller.handleMessage({ type: "ready" })).toBe(true);
    const state = last();
    expect(state.label).toBe("FIXTURE");
    expect(state.viewer.user_id).toBe(U.ada);
    expect(state.conversations.map((c) => c.conversation_id)).toEqual([
      C.dmAdaGrace,
      C.groupRelease,
    ]);
    expect(state.selected?.conversation.conversation_id).toBe(C.dmAdaGrace);
    // Divider sits at the first unread message (#3) and stays after marking read.
    expect(state.selected?.divider_sequence).toBe(3);
    expect(state.selected?.conversation.read_cursor).toBe(4);
    expect(state.conversations[0]?.unread_count).toBe(0);
    expect(state.selected?.messages.map((m) => m.sequence)).toEqual([2, 3, 4]);
    expect(state.selected?.older_cursor).not.toBeNull();
    expect(state.mention_index.repos).toHaveLength(2);
    expect(JSON.stringify(state)).not.toContain("Private to this DM");
  });

  test("loadOlder prepends history without duplicates and keeps the divider", async () => {
    const { controller, last } = setup();
    await controller.handleMessage({ type: "ready" });
    const cursor = last().selected?.older_cursor ?? "";
    await controller.handleMessage({
      type: "loadOlder",
      conversationId: C.dmAdaGrace,
      cursor,
    });
    const state = last();
    expect(state.selected?.messages.map((m) => m.sequence)).toEqual([
      1, 2, 3, 4,
    ]);
    expect(state.selected?.older_cursor).toBeNull();
    expect(state.selected?.divider_sequence).toBe(3);
    // A stale cursor is ignored.
    await controller.handleMessage({
      type: "loadOlder",
      conversationId: C.dmAdaGrace,
      cursor,
    });
    expect(last().selected?.messages).toHaveLength(4);
  });

  test("send shows pending, then commits with a sequence and references; retry is idempotent", async () => {
    const { controller, last, release, states } = setup({ sendDelayMs: 10 });
    await controller.handleMessage({ type: "ready" });
    const sending = controller.handleMessage({
      type: "send",
      conversationId: C.dmAdaGrace,
      clientMessageId: "cm_ui_1",
      body: "Looking now",
      replyTo: "msg_dm_4",
      references: [
        {
          kind: "range",
          repo_id: "repo_fixture_site",
          commit_sha: SITE_SHA,
          path: "src/how.ts",
          line_start: 4,
          line_end: 6,
          symbol: null,
        },
      ],
    });
    await Promise.resolve();
    expect(last().pending).toEqual([
      {
        client_message_id: "cm_ui_1",
        conversation_id: C.dmAdaGrace,
        body: "Looking now",
        reference_count: 1,
        reply_to: "msg_dm_4",
        status: "pending",
        reason: null,
      },
    ]);
    release();
    await sending;
    const state = last();
    expect(state.pending).toEqual([]);
    const sent = state.selected?.messages[state.selected.messages.length - 1];
    expect(sent?.sequence).toBe(5);
    expect(sent?.reply_to?.message_id).toBe("msg_dm_4");
    expect(sent?.references[0]).toMatchObject({
      state: "ok",
      path: "src/how.ts",
    });
    expect(state.selected?.conversation.read_cursor).toBe(5);
    const before = states.length;
    const retry = controller.handleMessage({
      type: "send",
      conversationId: C.dmAdaGrace,
      clientMessageId: "cm_ui_1",
      body: "Looking now",
      replyTo: "msg_dm_4",
      references: [
        {
          kind: "range",
          repo_id: "repo_fixture_site",
          commit_sha: SITE_SHA,
          path: "src/how.ts",
          line_start: 4,
          line_end: 6,
          symbol: null,
        },
      ],
    });
    await Promise.resolve();
    release();
    await retry;
    expect(states.length).toBeGreaterThan(before);
    expect(
      last().selected?.messages.filter((m) => m.sequence === 5),
    ).toHaveLength(1);
    expect(last().selected?.messages).toHaveLength(4);
  });

  test("a rejected send becomes failed with a content-free reason; retry and discard work", async () => {
    const { controller, last } = setup();
    await controller.handleMessage({ type: "ready" });
    await controller.handleMessage({
      type: "send",
      conversationId: C.dmAdaGrace,
      clientMessageId: "cm_ada_0001",
      body: "not the original content",
      replyTo: null,
      references: [],
    });
    const failed = last().pending[0];
    expect(failed?.status).toBe("failed");
    expect(failed?.reason).toContain("already committed");
    await controller.handleMessage({
      type: "retrySend",
      clientMessageId: "cm_ada_0001",
    });
    expect(last().pending[0]?.status).toBe("failed");
    await controller.handleMessage({
      type: "discardSend",
      clientMessageId: "cm_ada_0001",
    });
    expect(last().pending).toEqual([]);
    // Sending to a conversation the viewer is not in fails closed.
    await controller.handleMessage({
      type: "send",
      conversationId: C.dmGraceLinus,
      clientMessageId: "cm_ui_2",
      body: "hello?",
      replyTo: null,
      references: [],
    });
    expect(last().pending[0]).toMatchObject({ status: "failed" });
    expect(last().pending[0]?.reason).toBe(
      "Conversation is not available to you.",
    );
  });

  test("reactions toggle, pins are per viewer, and the code panel resolves exact lines", async () => {
    const { controller, last } = setup();
    await controller.handleMessage({ type: "ready" });
    await controller.handleMessage({
      type: "toggleReaction",
      messageId: "msg_dm_2",
      emoji: "✅",
    });
    let message = last().selected?.messages.find(
      (m) => m.message_id === "msg_dm_2",
    );
    expect(message?.reactions).toEqual([{ emoji: "✅", count: 2, mine: true }]);
    await controller.handleMessage({
      type: "toggleReaction",
      messageId: "msg_dm_2",
      emoji: "✅",
    });
    message = last().selected?.messages.find(
      (m) => m.message_id === "msg_dm_2",
    );
    expect(message?.reactions).toEqual([
      { emoji: "✅", count: 1, mine: false },
    ]);

    await controller.handleMessage({
      type: "togglePin",
      conversationId: C.dmAdaGrace,
    });
    expect(last().conversations.map((c) => c.conversation_id)).toEqual([
      C.groupRelease,
      C.dmAdaGrace,
    ]);
    expect(last().selected?.conversation.pinned).toBe(false);

    await controller.handleMessage({
      type: "openReference",
      messageId: "msg_dm_2",
      referenceId: "ref_platform_verdict",
    });
    const panel = last().panel;
    expect(panel?.preview.state).toBe("ok");
    if (panel?.preview.state === "ok") {
      expect(panel.preview.highlight).toEqual({ start: 12, end: 19 });
      expect(panel.preview.lines).toHaveLength(31);
    }
    await controller.handleMessage({ type: "closeReference" });
    expect(last().panel).toBeNull();
    await controller.handleMessage({
      type: "openReference",
      messageId: "msg_dm_2",
      referenceId: "ref_site_banner",
    });
    expect(last().panel).toBeNull();
    expect(last().notice?.kind).toBe("error");
  });

  test("the group shows chips from two repos and switching viewer applies that viewer's access", async () => {
    const { controller, last } = setup();
    await controller.handleMessage({ type: "ready" });
    await controller.handleMessage({
      type: "selectConversation",
      conversationId: C.groupRelease,
    });
    let group = last().selected;
    expect(group?.divider_sequence).toBeNull();
    const chips = group?.messages.find(
      (m) => m.message_id === "msg_grp_2",
    )?.references;
    expect(
      chips?.map((c) => (c.state === "ok" ? c.repo_name : c.state)).sort(),
    ).toEqual(["mars-platform (fixture)", "mars-site (fixture)"]);

    await controller.handleMessage({
      type: "fixtureSwitchViewer",
      userId: U.linus,
    });
    const state = last();
    expect(state.viewer.user_id).toBe(U.linus);
    expect(state.conversations.map((c) => c.conversation_id)).toEqual([
      C.dmGraceLinus,
      C.groupRelease,
    ]);
    expect(state.mention_index.repos.map((r) => r.repo_id)).toEqual([
      "repo_fixture_platform",
    ]);
    await controller.handleMessage({
      type: "selectConversation",
      conversationId: C.groupRelease,
    });
    group = last().selected;
    expect(group?.divider_sequence).toBe(3);
    const linusChips = group?.messages.find(
      (m) => m.message_id === "msg_grp_2",
    )?.references;
    expect(linusChips?.map((c) => c.state).sort()).toEqual([
      "ok",
      "restricted",
    ]);
    await controller.handleMessage({
      type: "openReference",
      messageId: "msg_grp_2",
      referenceId: "ref_site_banner",
    });
    expect(last().panel?.preview).toEqual({
      state: "restricted",
      reference_id: "ref_site_banner",
    });
    // An unknown viewer id is ignored.
    await controller.handleMessage({
      type: "fixtureSwitchViewer",
      userId: "user_nobody",
    });
    expect(last().viewer.user_id).toBe(U.linus);
  });

  test("dispose stops emitting", async () => {
    const { controller, states } = setup();
    await controller.handleMessage({ type: "ready" });
    controller.dispose();
    const n = states.length;
    expect(await controller.handleMessage({ type: "ready" })).toBe(false);
    expect(states.length).toBe(n);
  });
});
