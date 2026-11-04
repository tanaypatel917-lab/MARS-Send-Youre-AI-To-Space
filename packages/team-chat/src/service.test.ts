import { describe, expect, test } from "bun:test";
import {
  FIXTURE_CONVERSATIONS as C,
  FIXTURE,
  PLATFORM_SHA,
  FIXTURE_REPOS as R,
  SITE_SHA,
  FIXTURE_USERS as U,
} from "./fixture";
import {
  FixtureDatasetSchema,
  isNormalizedRepoPath,
  ReferenceSchema,
  type SendMessageInput,
} from "./schemas";
import { FixtureTeamService } from "./service";

const send = (over: Partial<SendMessageInput> = {}): SendMessageInput => ({
  conversation_id: C.dmAdaGrace,
  client_message_id: "cm_test_1",
  body: "hello",
  reply_to: null,
  references: [],
  ...over,
});

function ok<T>(
  result: { ok: true; value: T } | { ok: false; code: string },
): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.code}`);
  return result.value;
}

describe("fixture dataset", () => {
  test("is valid, labelled FIXTURE and covers the PR 1 scenarios", () => {
    expect(FixtureDatasetSchema.parse(FIXTURE).label).toBe("FIXTURE");
    expect(FIXTURE.users).toHaveLength(3);
    expect(FIXTURE.repos.map((r) => r.repo_id).sort()).toEqual(
      [R.platform, R.site].sort(),
    );
    const kinds = FIXTURE.conversations.map((c) => c.kind);
    expect(kinds).toContain("dm");
    expect(kinds).toContain("group");
    expect(FIXTURE.messages.some((m) => m.reply_to !== null)).toBe(true);
    expect(FIXTURE.reactions.length).toBeGreaterThan(0);
    expect(FIXTURE.participants.some((p) => p.pinned)).toBe(true);
    const groupRepos = new Set(
      FIXTURE.shares
        .filter((s) => s.message_id === "msg_grp_2")
        .map(
          (s) =>
            FIXTURE.references.find((r) => r.reference_id === s.reference_id)
              ?.repo_id,
        ),
    );
    expect(groupRepos).toEqual(new Set([R.platform, R.site]));
    for (const reference of FIXTURE.references)
      expect(
        FIXTURE.blobs.some(
          (b) =>
            b.repo_id === reference.repo_id &&
            b.commit_sha === reference.commit_sha &&
            b.path === reference.path,
        ),
      ).toBe(true);
  });

  test("reference locators are strict", () => {
    const base = FIXTURE.references[0];
    if (!base) throw new Error("fixture reference missing");
    expect(
      ReferenceSchema.safeParse({ ...base, commit_sha: "3f2c9a1" }).success,
    ).toBe(false);
    expect(
      ReferenceSchema.safeParse({ ...base, path: "../etc/passwd" }).success,
    ).toBe(false);
    expect(
      ReferenceSchema.safeParse({ ...base, path: "/abs/path.ts" }).success,
    ).toBe(false);
    expect(
      ReferenceSchema.safeParse({ ...base, line_start: 9, line_end: 3 })
        .success,
    ).toBe(false);
    expect(
      ReferenceSchema.safeParse({ ...base, line_start: 3, line_end: null })
        .success,
    ).toBe(false);
    expect(isNormalizedRepoPath("a/./b")).toBe(false);
    expect(isNormalizedRepoPath("a//b")).toBe(false);
    expect(isNormalizedRepoPath("C:/x")).toBe(false);
    expect(isNormalizedRepoPath("a\\b")).toBe(false);
    expect(isNormalizedRepoPath("src/how.ts")).toBe(true);
  });
});

describe("membership-filtered reads", () => {
  test("inbox lists only the viewer's conversations, pinned first, with unread counts", () => {
    const service = new FixtureTeamService();
    const inbox = ok(service.listConversations(U.ada));
    expect(inbox.map((c) => c.conversation_id)).toEqual([
      C.dmAdaGrace,
      C.groupRelease,
    ]);
    expect(inbox[0]?.pinned).toBe(true);
    expect(inbox[0]?.unread_count).toBe(2);
    expect(inbox[0]?.title).toBe("Grace Oyelaran");
    expect(inbox[1]?.unread_count).toBe(0);
    expect(inbox[1]?.title).toBe("Release triage");
  });

  test("a team member outside a conversation gets nothing", () => {
    const service = new FixtureTeamService();
    expect(service.openConversation(U.ada, C.dmGraceLinus)).toEqual({
      ok: false,
      code: "not_found",
    });
    expect(service.markRead(U.ada, C.dmGraceLinus, 1).ok).toBe(false);
    expect(service.setPinned(U.ada, C.dmGraceLinus, true).ok).toBe(false);
    expect(service.setReaction(U.ada, "msg_gl_1", "👍", true).ok).toBe(false);
    expect(
      service.sendMessage(U.ada, send({ conversation_id: C.dmGraceLinus })),
    ).toEqual({ ok: false, code: "not_found" });
    expect(
      service.resolveReference(U.linus, "msg_dm_2", "ref_platform_verdict"),
    ).toEqual({ ok: false, code: "not_found" });
    const json = JSON.stringify([
      service.listConversations(U.ada),
      service.openConversation(U.ada, C.dmAdaGrace),
      service.openConversation(U.ada, C.groupRelease),
    ]);
    expect(json).not.toContain("Private to this DM");
  });

  test("a non-member of the team sees no inbox and no mention index", () => {
    const service = new FixtureTeamService();
    expect(service.listConversations("user_stranger")).toEqual({
      ok: false,
      code: "not_found",
    });
    expect(service.mentionIndex("user_stranger")).toEqual({ repos: [] });
  });

  test("a participant without repo access gets a restricted chip and no metadata", () => {
    const service = new FixtureTeamService();
    const page = ok(service.openConversation(U.linus, C.groupRelease));
    const message = page.messages.find((m) => m.message_id === "msg_grp_2");
    const states = message?.references.map((r) => r.state).sort();
    expect(states).toEqual(["ok", "restricted"]);
    const restricted = message?.references.find(
      (r) => r.state === "restricted",
    );
    expect(restricted).toEqual({
      reference_id: "ref_site_banner",
      state: "restricted",
    });
    expect(JSON.stringify(restricted)).not.toContain("style.css");
    expect(
      service.resolveReference(U.linus, "msg_grp_2", "ref_site_banner"),
    ).toEqual({
      ok: true,
      value: { state: "restricted", reference_id: "ref_site_banner" },
    });
    expect(service.mentionIndex(U.linus).repos.map((r) => r.repo_id)).toEqual([
      R.platform,
    ]);
  });

  test("history pages preserve order and the cursor is opaque", () => {
    const service = new FixtureTeamService();
    const first = ok(
      service.openConversation(U.ada, C.dmAdaGrace, { limit: 3 }),
    );
    expect(first.messages.map((m) => m.sequence)).toEqual([2, 3, 4]);
    expect(first.older_cursor).not.toBeNull();
    const older = ok(
      service.openConversation(U.ada, C.dmAdaGrace, {
        limit: 3,
        before: first.older_cursor,
      }),
    );
    expect(older.messages.map((m) => m.sequence)).toEqual([1]);
    expect(older.older_cursor).toBeNull();
    expect(
      service.openConversation(U.ada, C.dmAdaGrace, { before: "garbage" }),
    ).toEqual({ ok: false, code: "invalid" });
  });

  test("replies and reactions are rendered with the viewer's perspective", () => {
    const service = new FixtureTeamService();
    const page = ok(service.openConversation(U.ada, C.dmAdaGrace));
    const reply = page.messages.find((m) => m.message_id === "msg_dm_2");
    expect(reply?.reply_to?.message_id).toBe("msg_dm_1");
    expect(reply?.reply_to?.author_name).toBe("Grace Oyelaran");
    expect(reply?.reactions).toEqual([{ emoji: "✅", count: 1, mine: false }]);
    const liked = page.messages.find((m) => m.message_id === "msg_dm_3");
    expect(liked?.reactions).toEqual([{ emoji: "👍", count: 1, mine: true }]);
  });
});

describe("sending", () => {
  test("assigns a server sequence and commits references atomically", () => {
    const service = new FixtureTeamService();
    const result = ok(
      service.sendMessage(
        U.ada,
        send({
          reply_to: "msg_dm_4",
          references: [
            {
              kind: "range",
              repo_id: R.site,
              commit_sha: SITE_SHA,
              path: "src/how.ts",
              line_start: 4,
              line_end: 6,
              symbol: null,
            },
          ],
        }),
      ),
    );
    expect(result).toEqual({
      message_id: `msg_${C.dmAdaGrace}_5`,
      sequence: 5,
      duplicate: false,
    });
    const page = ok(service.openConversation(U.ada, C.dmAdaGrace));
    const sent = page.messages[page.messages.length - 1];
    expect(sent?.reply_to?.message_id).toBe("msg_dm_4");
    expect(sent?.references[0]).toMatchObject({
      state: "ok",
      path: "src/how.ts",
      short_sha: SITE_SHA.slice(0, 7),
      line_start: 4,
      line_end: 6,
    });
    expect(sent?.created_at).toBe("2026-11-03T14:41:00.000Z");
  });

  test("is idempotent per client message id and rejects reuse with different content", () => {
    const service = new FixtureTeamService();
    const first = ok(service.sendMessage(U.ada, send()));
    const again = ok(service.sendMessage(U.ada, send()));
    expect(again).toEqual({ ...first, duplicate: true });
    expect(
      ok(service.openConversation(U.ada, C.dmAdaGrace)).messages,
    ).toHaveLength(5);
    expect(service.sendMessage(U.ada, send({ body: "different" }))).toEqual({
      ok: false,
      code: "client_message_id_reused",
    });
    // Another author may use the same client id: uniqueness is per author and conversation.
    expect(ok(service.sendMessage(U.grace, send())).sequence).toBe(6);
  });

  test("rejects empty bodies, foreign reply targets and unattachable references", () => {
    const service = new FixtureTeamService();
    expect(service.sendMessage(U.ada, send({ body: "   " }))).toEqual({
      ok: false,
      code: "empty_message",
    });
    expect(service.sendMessage(U.ada, send({ reply_to: "msg_grp_1" }))).toEqual(
      {
        ok: false,
        code: "reply_outside_conversation",
      },
    );
    const siteRef = {
      kind: "file" as const,
      repo_id: R.site,
      commit_sha: SITE_SHA,
      path: "src/style.css",
      line_start: null,
      line_end: null,
      symbol: null,
    };
    expect(
      service.sendMessage(
        U.linus,
        send({ conversation_id: C.groupRelease, references: [siteRef] }),
      ),
    ).toEqual({ ok: false, code: "reference_not_attachable" });
    expect(
      service.sendMessage(
        U.ada,
        send({ references: [{ ...siteRef, commit_sha: PLATFORM_SHA }] }),
      ),
    ).toEqual({ ok: false, code: "reference_not_attachable" });
    expect(
      service.sendMessage(
        U.ada,
        send({ references: [{ ...siteRef, path: "../style.css" }] }),
      ),
    ).toEqual({ ok: false, code: "invalid" });
    expect(
      service.sendMessage(
        U.ada,
        send({
          references: [
            { ...siteRef, kind: "range", line_start: 1, line_end: 10_000 },
          ],
        }),
      ),
    ).toEqual({ ok: false, code: "reference_not_attachable" });
  });

  test("a sent message never carries a body in the summary beyond an excerpt", () => {
    const service = new FixtureTeamService();
    ok(service.sendMessage(U.ada, send({ body: "x".repeat(400) })));
    const inbox = ok(service.listConversations(U.ada));
    expect(inbox[0]?.last_message?.excerpt.length).toBeLessThanOrEqual(81);
  });
});

describe("read cursors, pins and reactions", () => {
  test("read cursors advance monotonically to an accessible sequence", () => {
    const service = new FixtureTeamService();
    expect(service.markRead(U.ada, C.dmAdaGrace, 4)).toEqual({
      ok: true,
      value: { read_cursor: 4 },
    });
    expect(service.markRead(U.ada, C.dmAdaGrace, 1)).toEqual({
      ok: true,
      value: { read_cursor: 4 },
    });
    expect(service.markRead(U.ada, C.dmAdaGrace, 99)).toEqual({
      ok: false,
      code: "invalid",
    });
    expect(ok(service.listConversations(U.ada))[0]?.unread_count).toBe(0);
    expect(ok(service.listConversations(U.grace))[0]?.read_cursor).toBe(3);
  });

  test("pinning changes only the requester's inbox", () => {
    const service = new FixtureTeamService();
    ok(service.setPinned(U.ada, C.groupRelease, true));
    ok(service.setPinned(U.ada, C.dmAdaGrace, false));
    expect(ok(service.listConversations(U.ada)).map((c) => c.pinned)).toEqual([
      true,
      false,
    ]);
    const linus = ok(service.listConversations(U.linus));
    expect(
      linus.find((c) => c.conversation_id === C.groupRelease)?.pinned,
    ).toBe(false);
  });

  test("reactions toggle idempotently and are unique per user and emoji", () => {
    const service = new FixtureTeamService();
    const on = ok(service.setReaction(U.ada, "msg_dm_2", "✅", true));
    expect(on.reactions).toEqual([{ emoji: "✅", count: 2, mine: true }]);
    expect(
      ok(service.setReaction(U.ada, "msg_dm_2", "✅", true)).reactions,
    ).toEqual(on.reactions);
    const off = ok(service.setReaction(U.ada, "msg_dm_2", "✅", false));
    expect(off.reactions).toEqual([{ emoji: "✅", count: 1, mine: false }]);
    expect(
      ok(service.setReaction(U.ada, "msg_dm_2", "✅", false)).reactions,
    ).toEqual(off.reactions);
    expect(service.setReaction(U.ada, "msg_dm_2", "🔥" as never, true)).toEqual(
      { ok: false, code: "invalid" },
    );
  });
});

describe("reference previews", () => {
  test("opens the blob at the pinned revision with the stored range highlighted", () => {
    const service = new FixtureTeamService();
    const preview = ok(
      service.resolveReference(U.ada, "msg_dm_2", "ref_platform_verdict"),
    );
    if (preview.state !== "ok") throw new Error(preview.state);
    expect(preview.repo_name).toBe("mars-platform (fixture)");
    expect(preview.commit_sha).toBe(PLATFORM_SHA);
    expect(preview.highlight).toEqual({ start: 12, end: 19 });
    expect(preview.lines[11]?.text).toContain("export function verdictFor");
    expect(preview.lines[0]?.number).toBe(1);
  });

  test("a reference is only readable through a message the viewer can read", () => {
    const service = new FixtureTeamService();
    // Right reference, wrong message: the share must exist.
    expect(
      service.resolveReference(U.ada, "msg_grp_1", "ref_platform_verdict"),
    ).toEqual({ ok: false, code: "not_found" });
    expect(
      service.resolveReference(U.ada, "msg_nope", "ref_platform_verdict"),
    ).toEqual({ ok: false, code: "not_found" });
  });

  test("the fixture never mutates between service instances", () => {
    const a = new FixtureTeamService();
    ok(a.sendMessage(U.ada, send()));
    ok(a.setPinned(U.ada, C.dmAdaGrace, false));
    const b = new FixtureTeamService();
    expect(ok(b.openConversation(U.ada, C.dmAdaGrace)).messages).toHaveLength(
      4,
    );
    expect(ok(b.listConversations(U.ada))[0]?.pinned).toBe(true);
    expect(FIXTURE.messages).toHaveLength(8);
  });
});
