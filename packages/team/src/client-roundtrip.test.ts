import { afterEach, expect, test } from "bun:test";
import { HttpRpcTransport } from "../../../apps/vscode/src/rpc";
import { TeamClient } from "../../../apps/vscode/src/teamChat/client";
import type {
  TeamContext,
  TeamRpcMethod,
} from "../../../apps/vscode/src/teamChat/protocol";
import { fixture, TEAM, TOKENS } from "../test/fixture";

const fixtures: ReturnType<typeof fixture>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});

test("the VS Code TeamClient round-trips through the real team HTTP server", async () => {
  const f = fixture();
  fixtures.push(f);
  const token = TOKENS.alice;
  const client = new TeamClient(
    new HttpRpcTransport<TeamRpcMethod, TeamContext>({
      rpcUrl: f.url,
      getToken: async () => token,
    }),
    () => "client-request",
  );

  try {
    const described = await client.describe();
    expect(described).toMatchObject({ team_id: TEAM, user_id: "alice" });

    const createResponse = await fetch(f.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        method: "conversations.create_dm",
        context: {
          schema_version: 1,
          team_id: described.team_id,
          request_id: "create-dm",
        },
        params: { peer_user_id: "bob" },
      }),
    });
    expect(createResponse.status).toBe(200);
    const created = (await createResponse.json()) as {
      result: { conversation: { conversation_id: string } };
    };
    const conversationId = created.result.conversation.conversation_id;

    const conversations = await client.listConversations();
    expect(
      conversations.map((item) => item.conversation.conversation_id),
    ).toContain(conversationId);

    const sent = await client.send({
      conversation_id: conversationId,
      client_message_id: "client-message",
      body: "round-trip message",
    });
    expect(sent.body).toBe("round-trip message");

    const history = await client.history(conversationId, {});
    expect(history.map((message) => message.message_id)).toContain(
      sent.message_id,
    );

    const events = await client.poll([
      { conversation_id: conversationId, after_event_seq: 0 },
    ]);
    expect(events.some((event) => event.kind === "message")).toBe(true);

    const streamController = new AbortController();
    const streamResponse = await fetch(`${new URL(f.url).origin}/v1/stream`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: client.streamRequest([
        { conversation_id: conversationId, after_event_seq: 0 },
      ]),
      signal: streamController.signal,
    });
    expect(streamResponse.status).toBe(200);
    expect(streamResponse.headers.get("content-type")).toContain(
      "text/event-stream",
    );
    try {
      const reader = streamResponse.body?.getReader();
      expect(reader).toBeDefined();
      const first = await reader?.read();
      expect(first?.done).toBe(false);
      expect(new TextDecoder().decode(first?.value)).toContain(": connected");
      await reader?.cancel();
    } finally {
      streamController.abort();
    }

    let failure: unknown;
    try {
      await client.openConversation("missing-conversation");
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain(token);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    expect(message).not.toContain(token);
    throw error;
  }
});
