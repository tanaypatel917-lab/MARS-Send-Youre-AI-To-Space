import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRepoRegistry,
  type RepoRegistry,
  referenceDigest,
} from "@mars/code-refs";
import type {
  GitRangeReference,
  MessageView,
  ReferencePreview,
  Repo,
} from "@mars/contracts";
import { fixture, type RpcResult, TEAM, type User } from "../test/fixture";
import type { ConversationViewResult, PathSearchResult } from "./protocol";
import { TEAM_MIGRATIONS } from "./store";

const GIT = Bun.which("git");
if (!GIT)
  console.warn(
    "WARNING: git not found on PATH; @mars/team reference tests are skipped.",
  );

function git(cwd: string, home: string, ...args: string[]): string {
  const result = Bun.spawnSync(
    [
      GIT ?? "git",
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "init.defaultBranch=main",
      ...args,
    ],
    {
      cwd,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        LC_ALL: "C",
      },
      stdin: "ignore",
    },
  );
  if (result.exitCode !== 0)
    throw new Error(`fixture git ${args.join(" ")} failed`);
  return result.stdout.toString().trim();
}

const LABEL_A = "Alpha Service Repo";
const LABEL_B = "Bravo Secret Repo";
const A_PATH = "src/alpha.ts";
const B_PATH = "secret/bravo.ts";
const A_TEXT = [
  "export const a1 = 1;",
  "export const a2 = 2;",
  "export const a3 = 3;",
  "export const a4 = 4;",
  "export const a5 = 5;",
];
const B_TEXT = [
  "// bravo secret",
  "export const token = 'fixture-not-a-secret';",
  "export const b3 = 3;",
];
const ZERO_SHA = "0".repeat(40);

describe.skipIf(!GIT)("@mars/team committed code references", () => {
  let root: string;
  let home: string;
  let repoA: string;
  let repoB: string;
  let shaA: string;
  let shaB: string;
  let registry: RepoRegistry;
  let f: ReturnType<typeof fixture>;
  let conversationId: string;
  let refA: GitRangeReference;
  let refB: GitRangeReference;
  let firstMessage: MessageView;
  /** Every response body bob, carol or the stranger ever saw (leak check in (g)). */
  const observed: string[] = [];
  const SEND_PARAMS = () => ({
    conversation_id: conversationId,
    client_message_id: "cm-refs-1",
    body: "look at these",
    reference_ids: [refA.reference_id, refB.reference_id],
  });

  const rpc = async (
    user: User,
    method: string,
    params: unknown,
    options?: { request_id?: string },
  ): Promise<RpcResult> => {
    const result = await f.rpc(user, method, params, options);
    if (user !== "alice") observed.push(JSON.stringify(result.body));
    return result;
  };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "mars-team-refs-"));
    home = join(root, "home");
    mkdirSync(home);
    repoA = join(root, "repo-a");
    repoB = join(root, "repo-b");
    for (const [dir, path, lines] of [
      [repoA, A_PATH, A_TEXT],
      [repoB, B_PATH, B_TEXT],
    ] as const) {
      mkdirSync(join(dir, path.split("/")[0] ?? ""), { recursive: true });
      writeFileSync(join(dir, path), `${lines.join("\n")}\n`);
      writeFileSync(join(dir, "README.md"), "# fixture\n");
      git(dir, home, "init", "-q");
      git(dir, home, "add", "-A");
      git(dir, home, "commit", "-q", "-m", "c1");
    }
    shaA = git(repoA, home, "rev-parse", "HEAD");
    shaB = git(repoB, home, "rev-parse", "HEAD");
    registry = createRepoRegistry();
    await registry.register({ repo_id: "repo-a", dir: repoA, label: LABEL_A });
    await registry.register({ repo_id: "repo-b", dir: repoB, label: LABEL_B });
    f = fixture({ repos: registry });
    f.store.setRepo({ team_id: TEAM, repo_id: "repo-a", label: LABEL_A });
    f.store.setRepo({ team_id: TEAM, repo_id: "repo-b", label: LABEL_B });
    f.store.setRepoAccess({
      team_id: TEAM,
      repo_id: "repo-a",
      user_id: "alice",
    });
    f.store.setRepoAccess({
      team_id: TEAM,
      repo_id: "repo-b",
      user_id: "alice",
    });
    f.store.setRepoAccess({ team_id: TEAM, repo_id: "repo-a", user_id: "bob" });
    const view = await f.ok<ConversationViewResult>(
      "alice",
      "conversations.create_group",
      { member_ids: ["alice", "bob"], title: "refs" },
    );
    conversationId = view.conversation.conversation_id;
  });

  afterAll(async () => {
    await f.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("the migration ledger gained the references migration", () => {
    expect(TEAM_MIGRATIONS.map((m) => m.id)).toEqual([
      "0001_initial",
      "0002_task_links",
      "0003_references",
    ]);
  });

  test("repos.list returns only repos the caller has access to; describe advertises references", async () => {
    const alice = await f.ok<Repo[]>("alice", "repos.list", {});
    expect(alice.map((r) => [r.repo_id, r.label])).toEqual([
      ["repo-a", LABEL_A],
      ["repo-b", LABEL_B],
    ]);
    const bob = (await rpc("bob", "repos.list", {})).body.result as Repo[];
    expect(bob.map((r) => r.repo_id)).toEqual(["repo-a"]);
    expect((await rpc("carol", "repos.list", {})).body.result).toEqual([]);
    expect((await rpc("stranger", "repos.list", {})).status).toBe(403);
    const described = await f.ok<{ capabilities: { references: boolean } }>(
      "alice",
      "team.describe",
      {},
    );
    expect(described.capabilities.references).toBe(true);
  });

  test("(a) u1 creates references in A and B, ids are the locator digest and dedupe, and attaches both to one message", async () => {
    refA = await f.ok<GitRangeReference>("alice", "references.create", {
      repo_id: "repo-a",
      commit_sha: shaA,
      path: A_PATH,
      line_start: 2,
      line_end: 3,
    });
    expect(refA).toEqual({
      kind: "git_range",
      reference_id: referenceDigest({
        repo_id: "repo-a",
        commit_sha: shaA,
        path: A_PATH,
        line_start: 2,
        line_end: 3,
      }),
      team_id: TEAM,
      repo_id: "repo-a",
      commit_sha: shaA,
      path: A_PATH,
      line_start: 2,
      line_end: 3,
      blob_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    refB = await f.ok<GitRangeReference>("alice", "references.create", {
      repo_id: "repo-b",
      commit_sha: shaB,
      path: B_PATH,
    });
    expect(refB.line_start).toBeNull();
    expect(refB.blob_sha256).toMatch(/^[a-f0-9]{64}$/);
    const again = await f.ok<GitRangeReference>("alice", "references.create", {
      repo_id: "repo-b",
      commit_sha: shaB,
      path: B_PATH,
    });
    expect(again).toEqual(refB);

    firstMessage = await f.ok<MessageView>(
      "alice",
      "messages.send",
      SEND_PARAMS(),
      { request_id: "send-refs-1" },
    );
    expect(firstMessage.reference_ids).toEqual([
      refA.reference_id,
      refB.reference_id,
    ]);
    expect(firstMessage.references).toEqual([
      {
        reference_id: refA.reference_id,
        restricted: false,
        repo_id: "repo-a",
        commit_sha: shaA,
        path: A_PATH,
        line_start: 2,
        line_end: 3,
      },
      {
        reference_id: refB.reference_id,
        restricted: false,
        repo_id: "repo-b",
        commit_sha: shaB,
        path: B_PATH,
        line_start: null,
        line_end: null,
      },
    ]);
  });

  test("(b) u2 sees A resolved and B as a bare restricted chip; resolve and search on B give nothing", async () => {
    const history = (
      await rpc("bob", "messages.history", { conversation_id: conversationId })
    ).body.result as MessageView[];
    expect(history).toHaveLength(1);
    expect(history[0]?.references).toEqual([
      {
        reference_id: refA.reference_id,
        restricted: false,
        repo_id: "repo-a",
        commit_sha: shaA,
        path: A_PATH,
        line_start: 2,
        line_end: 3,
      },
      { reference_id: refB.reference_id, restricted: true },
    ]);
    const previewA = (
      await rpc("bob", "references.resolve", {
        reference_id: refA.reference_id,
      })
    ).body.result as ReferencePreview;
    expect(previewA).toEqual({
      state: "ok",
      reference_id: refA.reference_id,
      repo_id: "repo-a",
      commit_sha: shaA,
      path: A_PATH,
      line_start: 2,
      line_end: 3,
      text: `${A_TEXT[1]}\n${A_TEXT[2]}`,
      total_lines: 5,
      truncated: false,
    });
    const previewB = await rpc("bob", "references.resolve", {
      reference_id: refB.reference_id,
    });
    expect(previewB.status).toBe(200);
    expect(previewB.body.result).toEqual({ state: "restricted" });
    expect(Object.keys(previewB.body.result as object)).toEqual(["state"]);

    const searchB = await rpc("bob", "references.search_paths", {
      repo_id: "repo-b",
      commit_sha: shaB,
      query: "bravo",
    });
    expect(searchB.status).toBe(404);
    expect(searchB.body.error?.code).toBe("not_found");
    const searchA = (
      await rpc("bob", "references.search_paths", {
        repo_id: "repo-a",
        commit_sha: shaA,
        query: "alpha",
        limit: 5,
      })
    ).body.result as PathSearchResult;
    expect(searchA).toEqual({
      state: "ok",
      matches: [{ path: A_PATH, rank: 1 }],
      truncated: false,
    });
    const missing = (
      await rpc("bob", "references.search_paths", {
        repo_id: "repo-a",
        commit_sha: ZERO_SHA,
        query: "alpha",
      })
    ).body.result;
    expect(missing).toEqual({ state: "unavailable" });
    const tooMany = await rpc("bob", "references.search_paths", {
      repo_id: "repo-a",
      commit_sha: shaA,
      query: "a",
      limit: 51,
    });
    expect(tooMany.status).toBe(400);
  });

  test("(c) a team member outside the conversation and a stranger get not_found / forbidden for everything", async () => {
    for (const [method, params] of [
      ["references.resolve", { reference_id: refA.reference_id }],
      ["references.resolve", { reference_id: refB.reference_id }],
      ["messages.history", { conversation_id: conversationId }],
      [
        "references.search_paths",
        { repo_id: "repo-a", commit_sha: shaA, query: "a" },
      ],
      [
        "references.create",
        { repo_id: "repo-a", commit_sha: shaA, path: A_PATH },
      ],
      [
        "messages.send",
        {
          conversation_id: conversationId,
          client_message_id: "c",
          body: "x",
          reference_ids: [refA.reference_id],
        },
      ],
    ] as const) {
      const carol = await rpc("carol", method, params);
      expect([method, carol.status, carol.body.error?.code]).toEqual([
        method,
        404,
        "not_found",
      ]);
      const stranger = await rpc("stranger", method, params);
      expect([method, stranger.status]).toEqual([method, 403]);
    }
    // Even with repo access, a reference is only readable through a visible message.
    f.store.setRepoAccess({
      team_id: TEAM,
      repo_id: "repo-a",
      user_id: "carol",
    });
    const carol = await rpc("carol", "references.resolve", {
      reference_id: refA.reference_id,
    });
    expect(carol.status).toBe(404);
    f.store.revokeRepoAccess({
      team_id: TEAM,
      repo_id: "repo-a",
      user_id: "carol",
    });
  });

  test("(d) after the branch moves and the file is renamed, the reference still resolves to the pinned SHA content", async () => {
    writeFileSync(
      join(repoA, A_PATH),
      `${["changed"].concat(A_TEXT).join("\n")}\n`,
    );
    git(repoA, home, "add", "-A");
    git(repoA, home, "commit", "-q", "-m", "c2");
    renameSync(join(repoA, A_PATH), join(repoA, "src/renamed.ts"));
    git(repoA, home, "add", "-A");
    git(repoA, home, "commit", "-q", "-m", "c3");
    const head = git(repoA, home, "rev-parse", "HEAD");
    expect(head).not.toBe(shaA);
    const preview = await f.ok<ReferencePreview>(
      "alice",
      "references.resolve",
      {
        reference_id: refA.reference_id,
      },
    );
    expect(preview).toMatchObject({
      state: "ok",
      commit_sha: shaA,
      path: A_PATH,
      text: `${A_TEXT[1]}\n${A_TEXT[2]}`,
    });
    // The old path at the new commit does not exist: it cannot be attached.
    const gone = await f.rpc("alice", "references.create", {
      repo_id: "repo-a",
      commit_sha: head,
      path: A_PATH,
    });
    expect([gone.status, gone.body.error?.code]).toEqual([404, "not_found"]);
  });

  test("(e) revoking u1's access to B restricts their own earlier chip immediately and denies search, create and send", async () => {
    f.store.revokeRepoAccess({
      team_id: TEAM,
      repo_id: "repo-b",
      user_id: "alice",
    });
    const history = await f.ok<MessageView[]>("alice", "messages.history", {
      conversation_id: conversationId,
    });
    expect(history[0]?.references[1]).toEqual({
      reference_id: refB.reference_id,
      restricted: true,
    });
    expect(
      await f.ok("alice", "references.resolve", {
        reference_id: refB.reference_id,
      }),
    ).toEqual({ state: "restricted" });
    const search = await f.rpc("alice", "references.search_paths", {
      repo_id: "repo-b",
      commit_sha: shaB,
      query: "bravo",
    });
    expect(search.status).toBe(404);
    const create = await f.rpc("alice", "references.create", {
      repo_id: "repo-b",
      commit_sha: shaB,
      path: B_PATH,
    });
    expect(create.status).toBe(404);
    const send = await f.rpc("alice", "messages.send", {
      conversation_id: conversationId,
      client_message_id: "cm-after-revoke",
      body: "again",
      reference_ids: [refB.reference_id],
    });
    expect([send.status, send.body.error?.code]).toEqual([404, "not_found"]);
    expect(
      (await f.ok<Repo[]>("alice", "repos.list", {})).map((r) => r.repo_id),
    ).toEqual(["repo-a"]);
    // An idempotent replay of the original send re-derives chips: nothing was cached.
    const replay = await f.ok<MessageView>(
      "alice",
      "messages.send",
      SEND_PARAMS(),
      {
        request_id: "send-refs-1",
      },
    );
    expect(replay.message_id).toBe(firstMessage.message_id);
    expect(replay.references[1]).toEqual({
      reference_id: refB.reference_id,
      restricted: true,
    });
    // Re-granting is just as immediate.
    f.store.setRepoAccess({
      team_id: TEAM,
      repo_id: "repo-b",
      user_id: "alice",
    });
    const restored = await f.ok<MessageView[]>("alice", "messages.history", {
      conversation_id: conversationId,
    });
    expect(restored[0]?.references[1]).toMatchObject({
      restricted: false,
      path: B_PATH,
    });
  });

  test("(f) referencing a repo without access is not_found; malformed locators and over-limit sends are invalid_request", async () => {
    const noAccess = await rpc("bob", "references.create", {
      repo_id: "repo-b",
      commit_sha: shaB,
      path: B_PATH,
    });
    expect([noAccess.status, noAccess.body.error?.code]).toEqual([
      404,
      "not_found",
    ]);
    const unknownRepo = await rpc("bob", "references.create", {
      repo_id: "repo-z",
      commit_sha: shaB,
      path: B_PATH,
    });
    expect(unknownRepo.status).toBe(404);
    const before = (
      (
        await rpc("bob", "messages.history", {
          conversation_id: conversationId,
        })
      ).body.result as MessageView[]
    ).length;
    const sendB = await rpc("bob", "messages.send", {
      conversation_id: conversationId,
      client_message_id: "bob-b",
      body: "sneaky",
      reference_ids: [refB.reference_id],
    });
    expect([sendB.status, sendB.body.error?.code]).toEqual([404, "not_found"]);
    const unknownRef = await rpc("bob", "messages.send", {
      conversation_id: conversationId,
      client_message_id: "bob-unknown",
      body: "sneaky",
      reference_ids: ["no-such-reference"],
    });
    expect(unknownRef.status).toBe(404);
    const after = (
      (
        await rpc("bob", "messages.history", {
          conversation_id: conversationId,
        })
      ).body.result as MessageView[]
    ).length;
    expect(after).toBe(before);

    for (const params of [
      { repo_id: "repo-a", commit_sha: shaA, path: "../etc/passwd" },
      { repo_id: "repo-a", commit_sha: shaA, path: `/${A_PATH}` },
      { repo_id: "repo-a", commit_sha: shaA, path: A_PATH, line_start: 3 },
      {
        repo_id: "repo-a",
        commit_sha: shaA,
        path: A_PATH,
        line_start: 3,
        line_end: 2,
      },
      { repo_id: "repo-a", commit_sha: shaA, path: "src" },
      {
        repo_id: "repo-a",
        commit_sha: shaA,
        path: A_PATH,
        line_start: 1,
        line_end: 999,
      },
      { repo_id: "repo-a", commit_sha: "abc", path: A_PATH },
    ]) {
      const bad = await rpc("bob", "references.create", params);
      expect([params, bad.status, bad.body.error?.code]).toEqual([
        params,
        400,
        "invalid_request",
      ]);
    }
    const missingObject = await rpc("bob", "references.create", {
      repo_id: "repo-a",
      commit_sha: ZERO_SHA,
      path: A_PATH,
    });
    expect(missingObject.status).toBe(404);
    const tooMany = await rpc("bob", "messages.send", {
      conversation_id: conversationId,
      client_message_id: "bob-many",
      body: "many",
      reference_ids: Array.from({ length: 17 }, (_, i) => `r${i}`),
    });
    expect(tooMany.status).toBe(400);
    const duplicate = await rpc("bob", "messages.send", {
      conversation_id: conversationId,
      client_message_id: "bob-dup",
      body: "dup",
      reference_ids: [refA.reference_id, refA.reference_id],
    });
    expect(duplicate.status).toBe(400);
  });

  test("events never carry reference fields", async () => {
    const events = (
      await rpc("bob", "events.poll", {
        cursors: [{ conversation_id: conversationId, after_event_seq: 0 }],
      })
    ).body.result as Record<string, unknown>[];
    expect(events.length).toBeGreaterThan(0);
    for (const event of events)
      expect(Object.keys(event).sort()).toEqual([
        "conversation_id",
        "event_seq",
        "kind",
        "message_id",
        "message_seq",
        "revision",
      ]);
  });

  test("(g) no absolute path, repo label, restricted path or restricted SHA appears in any response to u2, u3 or the stranger", () => {
    expect(observed.length).toBeGreaterThan(20);
    const joined = observed.join("\n");
    for (const secret of [
      root,
      repoA,
      repoB,
      LABEL_B,
      B_PATH,
      shaB,
      "bravo",
      B_TEXT[1],
    ])
      expect(joined.includes(secret as string)).toBe(false);
    expect(joined.includes(A_PATH)).toBe(true);
    const messages = new Set(
      observed.flatMap((body) => {
        const error = (JSON.parse(body) as RpcResult["body"]).error;
        return error ? [error.message] : [];
      }),
    );
    expect([...messages].sort()).toEqual([
      "Invalid team request.",
      "Team resource not found.",
      "The team request is not permitted.",
    ]);
  });

  test("references.resolve is rate limited per user and the limit answers 503", async () => {
    const g = fixture({
      repos: registry,
      limits: { max_resolves_per_minute: 2 },
    });
    try {
      g.store.setRepo({ team_id: TEAM, repo_id: "repo-a", label: LABEL_A });
      g.store.setRepoAccess({
        team_id: TEAM,
        repo_id: "repo-a",
        user_id: "alice",
      });
      g.store.setRepoAccess({
        team_id: TEAM,
        repo_id: "repo-a",
        user_id: "bob",
      });
      const view = await g.ok<ConversationViewResult>(
        "alice",
        "conversations.create_dm",
        { peer_user_id: "bob" },
      );
      const reference = await g.ok<GitRangeReference>(
        "alice",
        "references.create",
        {
          repo_id: "repo-a",
          commit_sha: shaA,
          path: A_PATH,
        },
      );
      await g.ok("alice", "messages.send", {
        conversation_id: view.conversation.conversation_id,
        client_message_id: "rl",
        body: "rl",
        reference_ids: [reference.reference_id],
      });
      const params = { reference_id: reference.reference_id };
      expect((await g.rpc("alice", "references.resolve", params)).status).toBe(
        200,
      );
      expect((await g.rpc("alice", "references.resolve", params)).status).toBe(
        200,
      );
      const third = await g.rpc("alice", "references.resolve", params);
      expect([third.status, third.body.error?.code]).toEqual([
        503,
        "unavailable",
      ]);
      // Another user has their own budget.
      expect((await g.rpc("bob", "references.resolve", params)).status).toBe(
        200,
      );
    } finally {
      await g.close();
    }
  });

  test("a participant removed from the conversation cannot replay their earlier send to read the message or its chips back", async () => {
    const g = fixture({ repos: registry });
    try {
      g.store.setRepo({ team_id: TEAM, repo_id: "repo-a", label: LABEL_A });
      g.store.setRepoAccess({
        team_id: TEAM,
        repo_id: "repo-a",
        user_id: "alice",
      });
      g.store.setRepoAccess({
        team_id: TEAM,
        repo_id: "repo-a",
        user_id: "bob",
      });
      const view = await g.ok<ConversationViewResult>(
        "alice",
        "conversations.create_group",
        {
          member_ids: ["alice", "bob"],
          title: "replay",
        },
      );
      const reference = await g.ok<GitRangeReference>(
        "bob",
        "references.create",
        {
          repo_id: "repo-a",
          commit_sha: shaA,
          path: A_PATH,
        },
      );
      const params = {
        conversation_id: view.conversation.conversation_id,
        client_message_id: "bob-1",
        body: "from bob",
        reference_ids: [reference.reference_id],
      };
      const sent = await g.ok<MessageView>("bob", "messages.send", params, {
        request_id: "bob-send",
      });
      expect(sent.references[0]).toMatchObject({
        restricted: false,
        path: A_PATH,
      });
      await g.ok("alice", "conversations.remove_member", {
        conversation_id: view.conversation.conversation_id,
        user_id: "bob",
        expected_revision: view.conversation.revision,
      });
      const replay = await g.rpc("bob", "messages.send", params, {
        request_id: "bob-send",
      });
      expect([replay.status, replay.body.error?.code]).toEqual([
        404,
        "not_found",
      ]);
      expect(JSON.stringify(replay.body)).not.toContain("from bob");
      expect(JSON.stringify(replay.body)).not.toContain(A_PATH);
      // Still readable by a member who stayed.
      const history = await g.ok<MessageView[]>("alice", "messages.history", {
        conversation_id: view.conversation.conversation_id,
      });
      expect(history.map((m) => m.message_id)).toEqual([sent.message_id]);
    } finally {
      await g.close();
    }
  });

  test("without a host registry, references.* answer unavailable and describe says so", async () => {
    const g = fixture();
    try {
      const described = await g.ok<{ capabilities: { references: boolean } }>(
        "alice",
        "team.describe",
        {},
      );
      expect(described.capabilities.references).toBe(false);
      g.store.setRepo({ team_id: TEAM, repo_id: "repo-a", label: LABEL_A });
      g.store.setRepoAccess({
        team_id: TEAM,
        repo_id: "repo-a",
        user_id: "alice",
      });
      expect(
        (await g.ok<Repo[]>("alice", "repos.list", {})).map((r) => r.repo_id),
      ).toEqual(["repo-a"]);
      const create = await g.rpc("alice", "references.create", {
        repo_id: "repo-a",
        commit_sha: shaA,
        path: A_PATH,
      });
      expect([create.status, create.body.error?.code]).toEqual([
        503,
        "unavailable",
      ]);
    } finally {
      await g.close();
    }
  });
});
