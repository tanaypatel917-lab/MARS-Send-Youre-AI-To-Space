import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRemoteRepoMirror, createRepoRegistry } from "@mars/code-refs";
import type {
  GitRangeReference,
  MessageView,
  ReferencePreview,
  SharePreview,
  TaskLink,
} from "@mars/contracts";
import {
  createCompositeAuthenticator,
  createGitHubAuthenticator,
  createVerifiedTokenAuthenticator,
  issueVerifiedToken,
} from "./auth";
import type { ConversationViewResult, TaskLinkDraftResult } from "./protocol";
import { serveTeam } from "./server";
import { createTeamStore } from "./store";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mars-team-e2e-"));
  dirs.push(dir);
  return dir;
}

function runGit(cwd: string, args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test Author",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test Author",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${new TextDecoder().decode(proc.stderr)}`,
    );
  }
  return new TextDecoder().decode(proc.stdout).trim();
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("Team Chat end-to-end integration", () => {
  test("multi-user auth (HS256 + GitHub), remote Git code-range quoting & revocation, @mentions, task-link, and verified evidence share", async () => {
    const root = tempDir();
    const upstreamBare = join(root, "upstream.git");
    const upstreamWork = join(root, "work");
    const mirrorCache = join(root, "mirror-cache");

    runGit(root, ["init", "--bare", upstreamBare]);
    runGit(root, ["clone", upstreamBare, upstreamWork]);
    writeFileSync(
      join(upstreamWork, "src.ts"),
      [
        "export function add(a: number, b: number): number {",
        "  return a + b;",
        "}",
        "export function mul(a: number, b: number): number {",
        "  return a * b;",
        "}",
        "",
      ].join("\n"),
    );
    runGit(upstreamWork, ["add", "."]);
    runGit(upstreamWork, ["commit", "-m", "initial"]);
    const commit1 = runGit(upstreamWork, ["rev-parse", "HEAD"]);
    runGit(upstreamWork, ["push", "origin", "HEAD"]);

    // 1. Store + remote Git mirror registry
    const store = createTeamStore({ rootDir: join(root, "store") });
    store.setEnabled(true);
    store.setTeamMember({
      team_id: "team_space",
      user_id: "alice",
      role: "admin",
    });
    store.setTeamMember({
      team_id: "team_space",
      user_id: "bob",
      role: "member",
    });

    const registry = createRepoRegistry();
    const mirror = createRemoteRepoMirror({
      cacheDir: mirrorCache,
      registry,
      allowLocalFileUrl: true,
    });
    await mirror.registerRemote({
      repo_id: "repo_core",
      label: "Core",
      url: `file://${upstreamBare}`,
    });

    store.setRepo({
      team_id: "team_space",
      repo_id: "repo_core",
      label: "Core",
    });
    store.setRepoAccess({
      team_id: "team_space",
      repo_id: "repo_core",
      user_id: "alice",
    });
    store.setRepoAccess({
      team_id: "team_space",
      repo_id: "repo_core",
      user_id: "bob",
    });

    // 2. Multi-provider auth: verified HS256 token for Alice, GitHub OAuth for Bob
    const jwtSecret = "e2e-verified-token-secret-32-bytes-minimum!!";
    const nowSec = Math.floor(Date.now() / 1000);
    const aliceToken = issueVerifiedToken(
      {
        sub: "alice",
        exp: nowSec + 3600,
        iss: "mars-e2e",
      },
      jwtSecret,
    );
    const bobGhToken = "gho_e2e_bob_token";

    const verifiedAuth = createVerifiedTokenAuthenticator({
      secret: jwtSecret,
      issuer: "mars-e2e",
      resolveTeams: (userId) => store.activeTeamIds(userId),
    });
    const githubAuth = createGitHubAuthenticator({
      fetch: (async (_input, init) => {
        const headers = new Headers(init?.headers);
        if (headers.get("authorization") === `Bearer ${bobGhToken}`) {
          return new Response(
            JSON.stringify({ id: 202, login: "bob", name: "Bob" }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("Unauthorized", { status: 401 });
      }) as typeof fetch,
      resolveTeams: (profile) => store.activeTeamIds(profile.login),
    });

    const server = serveTeam({
      store,
      authenticator: createCompositeAuthenticator([verifiedAuth, githubAuth]),
      repos: registry,
      port: 0,
    });

    let reqSeq = 0;
    const rpc = async <T>(
      token: string,
      method: string,
      params: Record<string, unknown>,
    ): Promise<{
      status: number;
      body: { result?: T; error?: { code: string } };
    }> => {
      const res = await fetch(`${server.url}/v1/rpc`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          method,
          context: {
            schema_version: 1,
            team_id: "team_space",
            request_id: `req_${++reqSeq}`,
          },
          params,
        }),
      });
      return {
        status: res.status,
        body: (await res.json()) as { result?: T; error?: { code: string } },
      };
    };

    try {
      // Unauthenticated request is rejected
      const unauth = await rpc("invalid_token", "team.describe", {});
      expect(unauth.status).toBe(401);

      // Alice (HS256) and Bob (GitHub OAuth) both describe team_space
      const aliceDesc = await rpc<{
        user_id: string;
        capabilities: { references: boolean };
      }>(aliceToken, "team.describe", {});
      expect(aliceDesc.status).toBe(200);
      expect(aliceDesc.body.result?.user_id).toBe("alice");
      expect(aliceDesc.body.result?.capabilities.references).toBe(true);

      const bobDesc = await rpc<{ user_id: string }>(
        bobGhToken,
        "team.describe",
        {},
      );
      expect(bobDesc.status).toBe(200);
      expect(bobDesc.body.result?.user_id).toBe("bob");

      // Create DM between Alice and Bob
      const dm = await rpc<ConversationViewResult>(
        aliceToken,
        "conversations.create_dm",
        { peer_user_id: "bob" },
      );
      expect(dm.status).toBe(200);
      const conversationId = dm.body.result?.conversation.conversation_id;
      if (!conversationId) throw new Error("missing conversation_id");

      // Alice creates a pinned-commit code-range reference
      const createdRef = await rpc<GitRangeReference>(
        aliceToken,
        "references.create",
        {
          repo_id: "repo_core",
          commit_sha: commit1,
          path: "src.ts",
          line_start: 1,
          line_end: 3,
        },
      );
      expect(createdRef.status).toBe(200);
      const refId = createdRef.body.result?.reference_id;
      if (!refId) throw new Error("missing reference_id");

      // Alice sends message with @bob mention and reference_id
      const sent = await rpc<MessageView>(aliceToken, "messages.send", {
        conversation_id: conversationId,
        client_message_id: "msg_code_quote_1",
        body: "@bob please review add() here",
        reference_ids: [refId],
      });
      expect(sent.status).toBe(200);
      expect(sent.body.result?.reference_ids).toEqual([refId]);
      const sentMessageId = sent.body.result?.message_id;
      if (!sentMessageId) throw new Error("missing message_id");

      // Bob resolves the reference and gets exact pinned lines
      const bobResolved = await rpc<ReferencePreview>(
        bobGhToken,
        "references.resolve",
        { reference_id: refId },
      );
      expect(bobResolved.status).toBe(200);
      expect(bobResolved.body.result?.state).toBe("ok");
      if (bobResolved.body.result?.state === "ok") {
        expect(bobResolved.body.result.text).toContain("export function add");
        expect(bobResolved.body.result.line_start).toBe(1);
        expect(bobResolved.body.result.line_end).toBe(3);
      }

      // Revoke Bob's repo access -> immediate restricted state with no metadata leakage
      store.revokeRepoAccess({
        team_id: "team_space",
        repo_id: "repo_core",
        user_id: "bob",
      });
      const bobRevoked = await rpc<ReferencePreview>(
        bobGhToken,
        "references.resolve",
        { reference_id: refId },
      );
      expect(bobRevoked.status).toBe(200);
      expect(bobRevoked.body.result).toEqual({
        state: "restricted",
      });

      // Push a second commit to upstream -> Alice quotes commit2 and remote mirror fetches on demand
      writeFileSync(join(upstreamWork, "next.ts"), "export const v = 2;\n");
      runGit(upstreamWork, ["add", "."]);
      runGit(upstreamWork, ["commit", "-m", "second"]);
      const commit2 = runGit(upstreamWork, ["rev-parse", "HEAD"]);
      runGit(upstreamWork, ["push", "origin", "HEAD"]);

      const ref2 = await rpc<GitRangeReference>(
        aliceToken,
        "references.create",
        {
          repo_id: "repo_core",
          commit_sha: commit2,
          path: "next.ts",
        },
      );
      expect(ref2.status).toBe(200);
      const ref2Id = ref2.body.result?.reference_id;
      if (!ref2Id) throw new Error("missing ref2Id");
      const sent2 = await rpc<MessageView>(aliceToken, "messages.send", {
        conversation_id: conversationId,
        client_message_id: "msg_code_quote_2",
        body: "Second commit quote",
        reference_ids: [ref2Id],
      });
      expect(sent2.status).toBe(200);
      const resolved2 = await rpc<ReferencePreview>(
        aliceToken,
        "references.resolve",
        { reference_id: ref2Id },
      );
      expect(resolved2.status).toBe(200);
      expect(resolved2.body.result?.state).toBe("ok");
      if (resolved2.body.result?.state === "ok") {
        expect(resolved2.body.result.text).toBe("export const v = 2;");
      }

      // Task-link draft -> confirm -> created -> verified evidence share preview & create
      const draft = await rpc<TaskLinkDraftResult>(
        aliceToken,
        "tasks.link_draft",
        {
          conversation_id: conversationId,
          message_ids: [sentMessageId],
          reference_ids: [refId],
        },
      );
      expect(draft.status).toBe(200);
      const linkId = draft.body.result?.link.link_id;
      if (!linkId) throw new Error("missing link_id");

      const confirmed = await rpc<TaskLink>(aliceToken, "tasks.link_confirm", {
        link_id: linkId,
        workbench: {
          scope: {
            owner_id: "alice-owner",
            project_id: "alice-project",
            workspace_id: "alice-workspace",
          },
          task_id: "wb-task-1",
          request_id: "wb-req-1",
        },
        target: { repo_id: "repo_core" },
      });
      expect(confirmed.status).toBe(200);

      const createdLink = await rpc<TaskLink>(
        aliceToken,
        "tasks.link_created",
        { link_id: linkId, task_revision: 12 },
      );
      expect(createdLink.status).toBe(200);
      expect(createdLink.body.result?.status).toBe("created");

      const diffSha = "a".repeat(64);
      const shareParams = {
        link_id: linkId,
        run_status: "completed" as const,
        evidence: {
          task_revision: 12,
          workspace: {
            workspace_id: "ws-1",
            provider: "git-worktree",
            revision: "r7",
          },
          diff_sha256: diffSha,
          verify_records: [
            {
              event_id: "evt_verify_1",
              verdict: "pass" as const,
              assurance: "deterministic_local" as const,
              verified: true,
              recorded_at: "2026-01-01T00:00:00.000Z",
              workspace_id: "ws-1",
              workspace_revision: "r7",
              diff_sha256: diffSha,
              stale: false,
            },
          ],
        },
        selection: {
          summary: "All tests pass for add() change",
          include_diff_digest: true,
          verify_event_ids: ["evt_verify_1"],
        },
      };

      const preview = await rpc<SharePreview>(
        aliceToken,
        "shares.preview",
        shareParams,
      );
      expect(preview.status).toBe(200);
      expect(preview.body.result?.card.verified).toBe(true);

      // Mismatched preview_sha256 is rejected
      const badShare = await rpc<MessageView>(aliceToken, "shares.create", {
        ...shareParams,
        preview_sha256: "0".repeat(64),
      });
      expect(badShare.status).toBe(409);

      // Exact preview_sha256 publishes the verified evidence share card
      const previewSha = preview.body.result?.preview_sha256;
      if (!previewSha) throw new Error("missing preview_sha256");
      const goodShare = await rpc<MessageView>(aliceToken, "shares.create", {
        ...shareParams,
        preview_sha256: previewSha,
      });
      expect(goodShare.status).toBe(200);
      expect(goodShare.body.result?.kind).toBe("result_card");
      expect(goodShare.body.result?.payload?.verified).toBe(true);
    } finally {
      await server.stop();
      store.close();
    }
  });
});
