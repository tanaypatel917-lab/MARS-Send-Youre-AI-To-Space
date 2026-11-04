import type { RepoRegistry } from "@mars/code-refs";
import {
  AgentPreviewSchema,
  AgentRequestSchema,
  MARS_AGENT_USER_ID,
  MessageSchema,
  MessageViewSchema,
  ParticipantSchema,
  SharePreviewSchema,
  TaskLinkSchema,
  TaskLinkViewSchema,
} from "@mars/contracts";
import type { Authenticator } from "./auth";
import { TeamError, unavailable } from "./errors";
import {
  ConversationListSchema,
  ConversationViewSchema,
  EventListSchema,
  MessageListSchema,
  PathSearchResultSchema,
  ReferencePreviewResultSchema,
  ReferenceResultSchema,
  RepoListSchema,
  TaskLinkDraftResultSchema,
  TeamDescribeResultSchema,
  type TeamRpcRequest,
  TeamRpcRequestSchema,
} from "./protocol";
import { createReferenceService, type ReferenceService } from "./references";
import type { TeamActor, TeamStore } from "./store";

export interface TeamServerOptions {
  store: TeamStore;
  authenticator: Authenticator;
  port?: number;
  /**
   * Host-trusted `@mars/code-refs` registry. Without it `references.*`
   * answer `unavailable`; `repos.list` and message chips still work from the
   * store's `repos`/`repo_access` tables.
   */
  repos?: RepoRegistry;
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
      case "rate_limited":
        return "unavailable";
      case "corrupt_record":
        return "internal_error";
    }
  }
  return "internal_error";
}

async function dispatch(
  store: TeamStore,
  references: ReferenceService | null,
  actor: TeamActor,
  request: TeamRpcRequest,
): Promise<unknown> {
  const requestId = request.context.request_id;
  const refs = () => {
    if (!references) throw unavailable("Repository is unavailable");
    return references;
  };
  switch (request.method) {
    case "team.describe": {
      const described = store.describe(actor);
      return TeamDescribeResultSchema.parse({
        ...described,
        capabilities: {
          ...described.capabilities,
          references: references !== null,
        },
      });
    }
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
      return MessageViewSchema.parse(
        store.send(actor, requestId, request.params),
      );
    case "messages.history":
      return MessageListSchema.parse(store.history(actor, request.params));
    case "messages.edit":
      return MessageViewSchema.parse(store.editMessage(actor, request.params));
    case "messages.delete":
      return MessageViewSchema.parse(
        store.deleteMessage(actor, request.params),
      );
    case "events.poll":
      return EventListSchema.parse(store.poll(actor, request.params));
    case "repos.list":
      return RepoListSchema.parse(store.listRepos(actor));
    case "references.create":
      return ReferenceResultSchema.parse(
        await refs().create(actor, request.params),
      );
    case "references.resolve":
      return ReferencePreviewResultSchema.parse(
        await refs().resolve(actor, request.params.reference_id),
      );
    case "references.search_paths":
      return PathSearchResultSchema.parse(
        await refs().searchPaths(actor, request.params),
      );
    case "tasks.link_draft":
      return TaskLinkDraftResultSchema.parse(
        store.linkDraft(actor, requestId, request.params),
      );
    case "tasks.link_confirm":
      return TaskLinkSchema.parse(
        store.linkConfirm(actor, requestId, request.params),
      );
    case "tasks.link_created":
      return TaskLinkSchema.parse(
        store.linkCreated(actor, requestId, request.params),
      );
    case "tasks.link_inspect":
      return TaskLinkViewSchema.parse(
        store.linkInspect(actor, request.params.link_id),
      );
    case "shares.preview":
      return SharePreviewSchema.parse(
        store.sharePreview(actor, request.params),
      );
    case "shares.create":
      return MessageViewSchema.parse(
        store.shareCreate(actor, requestId, request.params),
      );
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

const RESTRICTED_KEYS = ["reference_id", "restricted"];
/** Repo-relative only: no absolute, drive or parent-relative path leaves the host. */
const isRelativePath = (path: string) =>
  !path.startsWith("/") &&
  !path.startsWith("\\") &&
  !/^[A-Za-z]:/.test(path) &&
  !path.split("/").some((segment) => segment === "" || segment === "..");

/**
 * Re-checks that nothing outside the actor's team, participation or repo
 * access is returned. Reference chips and previews are re-authorized against
 * the store here, after the handler ran, so a bug upstream still fails closed.
 */
function validateResult(
  store: TeamStore,
  request: TeamRpcRequest,
  result: unknown,
  actor: TeamActor,
) {
  const invalid = () => {
    throw new TeamServerError("internal_error");
  };
  const checkMessage = (value: unknown) => {
    const message = MessageViewSchema.parse(value);
    if (message.references.length !== message.reference_ids.length) invalid();
    message.references.forEach((chip, index) => {
      if (chip.reference_id !== message.reference_ids[index]) invalid();
      if (chip.restricted) {
        const keys = Object.keys(chip).sort();
        if (keys.join(",") !== RESTRICTED_KEYS.join(",")) invalid();
        return;
      }
      if (
        !isRelativePath(chip.path) ||
        !store.hasRepoAccess(actor, chip.repo_id)
      )
        invalid();
    });
    return message;
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
      const message = checkMessage(result);
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
      const message = MessageViewSchema.parse(result);
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
      for (const value of MessageListSchema.parse(result)) {
        const message = checkMessage(value);
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
    case "repos.list": {
      const seen = new Set<string>();
      for (const repo of RepoListSchema.parse(result)) {
        if (
          repo.team_id !== actor.team_id ||
          seen.has(repo.repo_id) ||
          !store.hasRepoAccess(actor, repo.repo_id)
        )
          invalid();
        seen.add(repo.repo_id);
      }
      break;
    }
    case "references.create": {
      const reference = ReferenceResultSchema.parse(result);
      if (
        reference.team_id !== actor.team_id ||
        reference.repo_id !== request.params.repo_id ||
        reference.commit_sha !== request.params.commit_sha ||
        !isRelativePath(reference.path) ||
        !store.hasRepoAccess(actor, reference.repo_id)
      )
        invalid();
      break;
    }
    case "references.resolve": {
      const preview = ReferencePreviewResultSchema.parse(result);
      if (preview.state === "restricted") {
        if (Object.keys(preview).join(",") !== "state") invalid();
        break;
      }
      if (
        preview.reference_id !== request.params.reference_id ||
        !isRelativePath(preview.path) ||
        !store.hasRepoAccess(actor, preview.repo_id)
      )
        invalid();
      break;
    }
    case "references.search_paths": {
      const search = PathSearchResultSchema.parse(result);
      if (!store.hasRepoAccess(actor, request.params.repo_id)) invalid();
      if (search.state === "ok") {
        const limit = request.params.limit ?? store.limits.max_search_hits;
        if (search.matches.length > limit) invalid();
        for (const match of search.matches)
          if (!isRelativePath(match.path)) invalid();
      }
      break;
    }
    case "tasks.link_draft": {
      const draft = TaskLinkDraftResultSchema.parse(result);
      if (
        draft.link.team_id !== actor.team_id ||
        draft.link.requester_id !== actor.user_id ||
        draft.link.conversation_id !== request.params.conversation_id ||
        draft.link.status !== "draft"
      )
        invalid();
      break;
    }
    case "tasks.link_confirm":
    case "tasks.link_created": {
      const link = TaskLinkSchema.parse(result);
      if (
        link.team_id !== actor.team_id ||
        link.requester_id !== actor.user_id ||
        link.link_id !== request.params.link_id
      )
        invalid();
      break;
    }
    case "tasks.link_inspect": {
      const view = TaskLinkViewSchema.parse(result);
      if (
        view.link.team_id !== actor.team_id ||
        view.link.link_id !== request.params.link_id ||
        (view.view === "requester") !==
          (view.link.requester_id === actor.user_id)
      )
        invalid();
      // Another member's view must omit the requester's workbench binding, not blank it.
      if (
        view.view === "member" &&
        ("launch_key" in view.link ||
          "workbench" in view.link ||
          "target" in view.link)
      )
        invalid();
      break;
    }
    case "shares.preview": {
      const preview = SharePreviewSchema.parse(result);
      if (
        preview.card.link_id !== request.params.link_id ||
        preview.card.requester_id !== actor.user_id ||
        preview.card.attested_by !== actor.user_id ||
        (preview.card.verified && preview.card.verified_reason !== null) ||
        (!preview.card.verified && preview.card.verified_reason === null)
      )
        invalid();
      break;
    }
    case "shares.create": {
      const message = checkMessage(result);
      if (
        message.author_id !== actor.user_id ||
        message.kind !== "result_card" ||
        message.payload === undefined ||
        message.payload.link_id !== request.params.link_id ||
        message.payload.message_id !== message.message_id ||
        message.payload.preview_sha256 !== request.params.preview_sha256 ||
        message.payload.requester_id !== actor.user_id
      )
        invalid();
      break;
    }
  }
}

export function serveTeam(options: TeamServerOptions) {
  const port = options.port ?? 7332;
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    throw new Error("Invalid team service port.");
  const { store, authenticator } = options;
  const references = options.repos
    ? createReferenceService({ store, repos: options.repos })
    : null;
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
        const result = await dispatch(store, references, actor, parsed.data);
        validateResult(store, parsed.data, result, actor);
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
