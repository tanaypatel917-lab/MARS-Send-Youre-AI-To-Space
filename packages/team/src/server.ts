import {
  AgentPreviewSchema,
  AgentRequestSchema,
  MARS_AGENT_USER_ID,
  MessageSchema,
  ParticipantSchema,
} from "@mars/contracts";
import type { Authenticator } from "./auth";
import { TeamError } from "./errors";
import {
  ConversationListSchema,
  ConversationViewSchema,
  EventListSchema,
  MessageListSchema,
  TeamDescribeResultSchema,
  type TeamRpcRequest,
  TeamRpcRequestSchema,
} from "./protocol";
import type { TeamActor, TeamStore } from "./store";

export interface TeamServerOptions {
  store: TeamStore;
  authenticator: Authenticator;
  port?: number;
}

/** Same vocabulary and fixed messages as the workbench RPC. */
export type RpcErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "unavailable"
  | "too_large"
  | "internal_error";
const errors: Record<RpcErrorCode, { status: number; message: string }> = {
  invalid_request: { status: 400, message: "Invalid team request." },
  unauthorized: { status: 401, message: "A valid team token is required." },
  forbidden: { status: 403, message: "The team request is not permitted." },
  not_found: { status: 404, message: "Team resource not found." },
  conflict: { status: 409, message: "Team revision or idempotency conflict." },
  unavailable: { status: 503, message: "Team service is unavailable." },
  too_large: { status: 413, message: "Team payload exceeds the size limit." },
  internal_error: { status: 500, message: "Team operation failed." },
};
export class TeamServerError extends Error {
  constructor(readonly code: RpcErrorCode) {
    super(errors[code].message);
    this.name = "TeamServerError";
  }
}

const MAX_REQUEST_BYTES = 512 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_AUTHORIZATION_CHARS = 300;
const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

function responseError(code: RpcErrorCode): Response {
  const detail = errors[code];
  return Response.json(
    { error: { code, message: detail.message } },
    { status: detail.status, headers },
  );
}

function errorCode(error: unknown): RpcErrorCode {
  if (error instanceof TeamServerError) return error.code;
  if (error instanceof TeamError) {
    switch (error.code) {
      case "invalid_input":
      case "unknown_cursor":
        return "invalid_request";
      case "unauthorized":
        return "unauthorized";
      case "forbidden":
      case "unsafe_path":
        return "forbidden";
      case "not_found":
        return "not_found";
      case "conflict":
        return "conflict";
      case "too_large":
        return "too_large";
      case "unavailable":
        return "unavailable";
      case "corrupt_record":
        return "internal_error";
    }
  }
  return "internal_error";
}

function dispatch(
  store: TeamStore,
  actor: TeamActor,
  request: TeamRpcRequest,
): unknown {
  const requestId = request.context.request_id;
  switch (request.method) {
    case "team.describe":
      return TeamDescribeResultSchema.parse(store.describe(actor));
    case "conversations.create_dm":
      return ConversationViewSchema.parse(
        store.createDm(actor, requestId, request.params),
      );
    case "conversations.create_group":
      return ConversationViewSchema.parse(
        store.createGroup(actor, requestId, request.params),
      );
    case "conversations.list":
      return ConversationListSchema.parse(store.list(actor));
    case "conversations.open":
      return ConversationViewSchema.parse(
        store.open(actor, request.params.conversation_id),
      );
    case "conversations.add_member":
      return ConversationViewSchema.parse(
        store.addMember(actor, requestId, request.params),
      );
    case "conversations.remove_member":
      return ConversationViewSchema.parse(
        store.removeMember(actor, requestId, request.params),
      );
    case "conversations.mark_read":
      return ParticipantSchema.parse(store.markRead(actor, request.params));
    case "conversations.pin":
      return ParticipantSchema.parse(store.pin(actor, request.params));
    case "messages.send":
      return MessageSchema.parse(store.send(actor, requestId, request.params));
    case "messages.history":
      return MessageListSchema.parse(store.history(actor, request.params));
    case "messages.edit":
      return MessageSchema.parse(store.editMessage(actor, request.params));
    case "messages.delete":
      return MessageSchema.parse(store.deleteMessage(actor, request.params));
    case "events.poll":
      return EventListSchema.parse(store.poll(actor, request.params));
    case "agent.preview":
      return AgentPreviewSchema.parse(
        store.agentPreview(actor, request.params),
      );
    case "agent.request":
      return AgentRequestSchema.parse(
        store.agentRequest(actor, request.params),
      );
    case "agent.cancel":
      return AgentRequestSchema.parse(store.agentCancel(actor, request.params));
    case "agent.inspect":
      return AgentRequestSchema.parse(
        store.agentInspect(actor, request.params),
      );
  }
}

/** Re-checks that nothing outside the actor's team or participation is returned. */
function validateResult(
  request: TeamRpcRequest,
  result: unknown,
  actor: TeamActor,
) {
  const invalid = () => {
    throw new TeamServerError("internal_error");
  };
  const checkView = (value: unknown, expectedState = "active") => {
    const view = ConversationViewSchema.parse(value);
    if (
      view.conversation.team_id !== actor.team_id ||
      view.participant.user_id !== actor.user_id ||
      view.participant.conversation_id !== view.conversation.conversation_id ||
      view.participant.state !== expectedState
    )
      invalid();
    return view;
  };
  switch (request.method) {
    case "team.describe": {
      const described = TeamDescribeResultSchema.parse(result);
      if (
        described.team_id !== actor.team_id ||
        described.user_id !== actor.user_id
      )
        invalid();
      break;
    }
    case "conversations.create_dm":
    case "conversations.create_group":
      checkView(result);
      break;
    case "conversations.open":
    case "conversations.add_member": {
      const view = checkView(result);
      if (view.conversation.conversation_id !== request.params.conversation_id)
        invalid();
      break;
    }
    case "conversations.remove_member": {
      // Leaving a group is the one call whose answer shows the caller removed.
      const view = checkView(
        result,
        request.params.user_id === actor.user_id ? "removed" : "active",
      );
      if (view.conversation.conversation_id !== request.params.conversation_id)
        invalid();
      break;
    }
    case "conversations.list": {
      const seen = new Set<string>();
      for (const value of ConversationListSchema.parse(result)) {
        const view = checkView(value);
        if (seen.has(view.conversation.conversation_id)) invalid();
        seen.add(view.conversation.conversation_id);
      }
      break;
    }
    case "conversations.mark_read":
    case "conversations.pin": {
      const participant = ParticipantSchema.parse(result);
      if (
        participant.user_id !== actor.user_id ||
        participant.conversation_id !== request.params.conversation_id
      )
        invalid();
      break;
    }
    case "messages.send": {
      const message = MessageSchema.parse(result);
      if (
        message.conversation_id !== request.params.conversation_id ||
        message.author_id !== actor.user_id ||
        message.client_message_id !== request.params.client_message_id
      )
        invalid();
      break;
    }
    case "messages.edit":
    case "messages.delete": {
      const message = MessageSchema.parse(result);
      if (
        message.message_id !== request.params.message_id ||
        message.author_id !== actor.user_id ||
        message.kind !== "user"
      )
        invalid();
      break;
    }
    case "agent.preview": {
      const preview = AgentPreviewSchema.parse(result);
      if (preview.conversation_id !== request.params.conversation_id) invalid();
      break;
    }
    case "agent.request":
    case "agent.cancel": {
      const record = AgentRequestSchema.parse(result);
      if (
        record.team_id !== actor.team_id ||
        record.requester_id !== actor.user_id
      )
        invalid();
      break;
    }
    case "agent.inspect": {
      const record = AgentRequestSchema.parse(result);
      if (
        record.team_id !== actor.team_id ||
        record.request_id !== request.params.request_id
      )
        invalid();
      break;
    }
    case "messages.history": {
      let previous = 0;
      for (const message of MessageListSchema.parse(result)) {
        if (
          message.conversation_id !== request.params.conversation_id ||
          message.seq <= previous ||
          (request.params.after_seq !== undefined &&
            message.seq <= request.params.after_seq) ||
          (request.params.before_seq !== undefined &&
            message.seq >= request.params.before_seq)
        )
          invalid();
        previous = message.seq;
      }
      break;
    }
    case "events.poll": {
      const cursors = new Map(
        request.params.cursors.map((cursor) => [
          cursor.conversation_id,
          cursor.after_event_seq,
        ]),
      );
      const previous = new Map<string, number>();
      for (const event of EventListSchema.parse(result)) {
        const cursor = cursors.get(event.conversation_id);
        const last = previous.get(event.conversation_id) ?? cursor;
        if (
          cursor === undefined ||
          last === undefined ||
          event.event_seq <= last
        )
          invalid();
        previous.set(event.conversation_id, event.event_seq);
      }
      break;
    }
  }
}

export function serveTeam(options: TeamServerOptions) {
  const port = options.port ?? 7332;
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    throw new Error("Invalid team service port.");
  const { store, authenticator } = options;
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    maxRequestBodySize: MAX_REQUEST_BYTES,
    async fetch(request, server) {
      const url = new URL(request.url);
      if (
        !["127.0.0.1", "localhost"].includes(url.hostname) ||
        Number(url.port || 80) !== server.port ||
        request.headers.has("origin")
      )
        return responseError("forbidden");
      if (request.method !== "POST" || url.pathname !== "/v1/rpc" || url.search)
        return responseError("not_found");
      const auth = request.headers.get("authorization") ?? "";
      if (auth.length > MAX_AUTHORIZATION_CHARS || !auth.startsWith("Bearer "))
        return responseError("unauthorized");
      let user: Awaited<ReturnType<Authenticator["authenticate"]>>;
      try {
        user = await authenticator.authenticate(auth.slice("Bearer ".length));
      } catch {
        return responseError("unavailable");
      }
      // The agent author id is reserved; no provider may mint it.
      if (!user || user.user_id === MARS_AGENT_USER_ID)
        return responseError("unauthorized");
      if (
        request.headers
          .get("content-type")
          ?.split(";", 1)[0]
          ?.trim()
          .toLowerCase() !== "application/json"
      )
        return responseError("invalid_request");
      try {
        const bytes = await request.arrayBuffer();
        if (bytes.byteLength > MAX_REQUEST_BYTES)
          return responseError("too_large");
        let raw: unknown;
        try {
          raw = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          );
        } catch {
          return responseError("invalid_request");
        }
        const parsed = TeamRpcRequestSchema.safeParse(raw);
        if (!parsed.success) return responseError("invalid_request");
        const teamId = parsed.data.context.team_id;
        if (!user.team_ids.includes(teamId)) return responseError("forbidden");
        const actor: TeamActor = { team_id: teamId, user_id: user.user_id };
        const result = dispatch(store, actor, parsed.data);
        validateResult(parsed.data, result, actor);
        const body = JSON.stringify({ result });
        if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES)
          return responseError("too_large");
        return new Response(body, { headers });
      } catch (error) {
        return responseError(errorCode(error));
      }
    },
    error() {
      return responseError("internal_error");
    },
  });
}
