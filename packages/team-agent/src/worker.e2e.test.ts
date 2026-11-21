import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentPreview, AgentRequest, MessageView } from "@mars/contracts";
import {
  createTeamStore,
  createVerifiedTokenAuthenticator,
  issueVerifiedToken,
  serveTeam,
} from "@mars/team";
import { createTeamAgentWorker } from "./worker";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mars-team-agent-e2e-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("@MARS team agent worker end-to-end", () => {
  test("processes queued @MARS request over live Team server and posts answer message", async () => {
    const root = tempDir();
    const store = createTeamStore({
      rootDir: join(root, "store"),
      agent: {
        model: () => ({ model_id: "fixture/free", tier: "free" }),
        scan: () => undefined,
      },
    });
    store.setEnabled(true);
    store.setTeamMember({
      team_id: "team_agent",
      user_id: "alice",
      role: "admin",
    });
    store.setTeamMember({
      team_id: "team_agent",
      user_id: "bob",
      role: "member",
    });

    const secret = "agent-e2e-hmac-secret-at-least-32-bytes!!";
    const aliceToken = issueVerifiedToken(
      { sub: "alice", exp: Math.floor(Date.now() / 1000) + 3600 },
      secret,
    );
    const server = serveTeam({
      store,
      authenticator: createVerifiedTokenAuthenticator({
        secret,
        resolveTeams: (u) => store.activeTeamIds(u),
      }),
      port: 0,
    });

    const worker = createTeamAgentWorker({
      host: store.agentHost,
      pollMs: 25,
      run: async (claimed) => {
        expect(claimed.input.messages.length).toBeGreaterThanOrEqual(1);
        return {
          status: "completed",
          answer_body: `Reviewed ${claimed.input.messages.length} message(s): add() looks correct.`,
          citations: [],
          dropped_citations: 0,
          reason_code: null,
          flagged: [],
          model_id: "free-test-model",
          tool_names: ["mars_team_context"],
          model_requests: 1,
        };
      },
    });
    worker.start();

    let seq = 0;
    const rpc = async <T>(method: string, params: Record<string, unknown>) => {
      const res = await fetch(`${server.url}/v1/rpc`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${aliceToken}`,
        },
        body: JSON.stringify({
          method,
          context: {
            schema_version: 1,
            team_id: "team_agent",
            request_id: `req_${++seq}`,
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
      const dm = await rpc<{ conversation: { conversation_id: string } }>(
        "conversations.create_dm",
        { peer_user_id: "bob" },
      );
      expect(dm.status).toBe(200);
      const conversationId = dm.body.result?.conversation.conversation_id;
      if (!conversationId) throw new Error("missing conversation_id");

      const msg = await rpc<MessageView>("messages.send", {
        conversation_id: conversationId,
        client_message_id: "m1",
        body: "@MARS summarize the add() function",
      });
      expect(msg.status).toBe(200);
      const messageId = msg.body.result?.message_id;
      if (!messageId) throw new Error("missing message_id");

      const selection = {
        conversation_id: conversationId,
        message_ids: [messageId],
        reference_ids: [],
      };
      const preview = await rpc<AgentPreview>("agent.preview", selection);
      expect(preview.status).toBe(200);
      const previewSha = preview.body.result?.preview_sha256;
      if (!previewSha) throw new Error("missing preview_sha256");

      const req = await rpc<AgentRequest>("agent.request", {
        ...selection,
        idempotency_key: "idem_agent_e2e_1",
        audience: "conversation",
        preview_sha256: previewSha,
      });
      expect(req.status).toBe(200);
      const requestId = req.body.result?.request_id;
      if (!requestId) throw new Error("missing request_id");

      await worker.drain();

      const inspected = await rpc<AgentRequest>("agent.inspect", {
        request_id: requestId,
      });
      expect(inspected.status).toBe(200);
      expect(inspected.body.result?.status).toBe("completed");
      expect(inspected.body.result?.answer?.message_id).toBeTruthy();
    } finally {
      await worker.stop();
      await server.stop();
      store.close();
    }
  });
});
