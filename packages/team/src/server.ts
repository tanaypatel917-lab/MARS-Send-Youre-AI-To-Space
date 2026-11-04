import type { RepoRegistry } from "@mars/code-refs";
import {
  AgentPreviewSchema,
  AgentRequestSchema,
  MARS_AGENT_USER_ID,
  MessageViewSchema,
  ParticipantSchema,
  SharePreviewSchema,
  TaskLinkSchema,
  TaskLinkViewSchema,
} from "@mars/contracts";
import type { AgentReferencePort } from "./agent-references";
import type { Authenticator } from "./auth";
import { TeamError, unavailable } from "./errors";
import { TeamMetricsSchema } from "./metrics";
import {
  ConversationListSchema,
  ConversationViewSchema,
  EventListSchema,
  MessageListSchema,
  PathSearchResultSchema,
  ReactionStateSchema,
  ReferencePreviewResultSchema,
  ReferenceResultSchema,
  RepoListSchema,
  SearchResultSchema,
  type StreamClose,
  StreamCloseSchema,
  StreamEventSchema,
  TaskLinkDraftResultSchema,
  TeamDescribeResultSchema,
  type TeamRpcRequest,
  TeamRpcRequestSchema,
  type TeamStreamRequest,
  TeamStreamRequestSchema,
} from "./protocol";
import { createReferenceService, type ReferenceService } from "./references";
import type { StoreNotice, TeamActor, TeamStore } from "./store";

/**
 * One structured log line. Operation ids are server-minted counters; the
 * client's `request_id`, bodies, paths, tokens and user ids never appear.
 */
export interface TeamServerLogEntry {
  op: "rpc" | "stream" | "stream_closed";
  /** Server-side operation counter, not the client's `request_id`. */
  id: number;
  method: string | null;
  /** `ok` or the RPC error code answered. */
  code: RpcErrorCode | "ok";
  status: number;
  ms: number;
}

export interface TeamServerOptions {
  store: TeamStore;
  authenticator: Authenticator;
  port?: number;
  /** Receives one entry per request; omitted → silent. */
  log?: (entry: TeamServerLogEntry) => void;
  /**
   * Host port that lets `agent.preview`/`agent.request` describe references:
   * the server pre-resolves the selection through it (async `git`) before
   * the store's synchronous `TeamReferencePort.describe` runs.
   */
  agentReferences?: AgentReferencePort;
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
const streamHeaders = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};
const encoder = new TextEncoder();

function responseError(
  code: RpcErrorCode,
  extraHeaders: Record<string, string> = {},
): Response {
  const detail = errors[code];
  return Response.json(
    { error: { code, message: detail.message } },
    { status: detail.status, headers: { ...headers, ...extraHeaders } },
  );
}

/** Whole seconds for `Retry-After` when a `rate_limited` store error is answered. */
function retryAfter(error: unknown): Record<string, string> {
  return error instanceof TeamError &&
    error.code === "rate_limited" &&
    error.retryAfterSeconds !== null
    ? { "Retry-After": String(error.retryAfterSeconds) }
    : {};
}

/** Methods whose denial is a "denied read" for the metrics (`denied_reads.<code>`). */
const READ_METHODS: ReadonlySet<string> = new Set([
  "conversations.list",
  "conversations.open",
  "messages.history",
  "events.poll",
  "events.stream",
  "messages.search",
  "repos.list",
  "references.resolve",
  "references.search_paths",
  "tasks.link_inspect",
  "agent.inspect",
  "team.metrics",
]);
const DENIAL_CODES: ReadonlySet<string> = new Set([
  "unauthorized",
  "forbidden",
  "not_found",
]);

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
  agentReferences: AgentReferencePort | null,
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
    case "team.metrics":
      return TeamMetricsSchema.parse(store.metricsSnapshot(actor));
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
    case "conversations.leave":
      return ConversationViewSchema.parse(
        store.leave(actor, requestId, request.params),
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
    case "reactions.set":
      return ReactionStateSchema.parse(
        store.setReaction(actor, request.params),
      );
    case "messages.search":
      return SearchResultSchema.parse(store.search(actor, request.params));
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
      await agentReferences?.prepare(
        actor.team_id,
        request.params.reference_ids,
      );
      return AgentPreviewSchema.parse(
        store.agentPreview(actor, request.params),
      );
    case "agent.request":
      await agentReferences?.prepare(
        actor.team_id,
        request.params.reference_ids,
      );
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
    case "conversations.leave": {
      const view = checkView(result, "removed");
      if (view.conversation.conversation_id !== request.params.conversation_id)
        invalid();
      break;
    }
    case "conversations.list": {
      const seen = new Set<string>();
      for (const item of ConversationListSchema.parse(result)) {
        const {
          unread_count: _unread,
          last_message_at: _last,
          ...value
        } = item;
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
            message.seq >= request.params.before_seq) ||
          (message.reply_to === null &&
            (message.reply_excerpt !== null || message.reply_restricted)) ||
          (message.reply_restricted && message.reply_excerpt !== null)
        )
          invalid();
        previous = message.seq;
      }
      break;
    }
    case "events.poll": {
      checkEventOrder(
        EventListSchema.parse(result),
        new Map(
          request.params.cursors.map((cursor) => [
            cursor.conversation_id,
            cursor.after_event_seq,
          ]),
        ),
      );
      break;
    }
    case "reactions.set": {
      const state = ReactionStateSchema.parse(result);
      if (
        state.message_id !== request.params.message_id ||
        state.emoji !== request.params.emoji ||
        state.reacted !== request.params.on ||
        (state.reacted && state.count < 1)
      )
        invalid();
      break;
    }
    case "messages.search": {
      const page = SearchResultSchema.parse(result);
      const limit = request.params.limit ?? 20;
      if (page.hits.length > limit) invalid();
      let previous: { created_at: string; message_id: string } | null = null;
      for (const hit of page.hits) {
        if (
          (request.params.conversation_id !== undefined &&
            hit.conversation_id !== request.params.conversation_id) ||
          (previous !== null &&
            (hit.created_at > previous.created_at ||
              (hit.created_at === previous.created_at &&
                hit.message_id >= previous.message_id)))
        )
          invalid();
        previous = hit;
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

/** Events per conversation strictly ascend from the cursor; the map advances. */
function checkEventOrder(
  events: ReadonlyArray<{ conversation_id: string; event_seq: number }>,
  cursors: Map<string, number>,
) {
  for (const event of events) {
    const last = cursors.get(event.conversation_id);
    if (last === undefined || event.event_seq <= last)
      throw new TeamServerError("internal_error");
    cursors.set(event.conversation_id, event.event_seq);
  }
}

/**
 * One SSE connection. Live delivery is "wake and re-poll": a store notice
 * only marks the conversation dirty and the stream re-runs the same
 * membership-filtered `poll` from its own cursors, so backfill and live
 * frames come from one query and can neither skip nor repeat an event. The
 * fan-out state per connection is therefore bounded by the cursor count, and
 * the output is pull-driven: frames wait in a byte-bounded queue until the
 * consumer asks for them, and a consumer that falls more than
 * `max_stream_buffer_bytes` behind is disconnected (`reason: "unavailable"`)
 * and resumes from its cursors.
 *
 * Exported for the backpressure test only; `serveTeam` is the API.
 */
export class EventStream {
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private readonly pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private pullWaiting: (() => void) | null = null;
  private pullServed = false;
  private readonly dirty = new Set<string>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private scheduled = false;
  private readonly batchLimit: number;
  closed = false;
  /** Set once the first page was served; only accepted streams count as connects. */
  accepted = false;

  constructor(
    private readonly store: TeamStore,
    readonly actor: TeamActor,
    readonly cursors: Map<string, number>,
    private readonly onClose: () => void,
  ) {
    this.batchLimit = Math.min(
      store.limits.max_stream_batch_events,
      store.limits.max_poll_events,
    );
  }

  /** Validates the cursors and returns the first backfill page, or throws. */
  initialPage() {
    const events = this.store.poll(this.actor, {
      cursors: [...this.cursors].map(([conversation_id, after_event_seq]) => ({
        conversation_id,
        after_event_seq,
      })),
      limit: this.batchLimit,
    });
    checkEventOrder(events, this.cursors);
    return events;
  }

  response(firstPage: ReturnType<EventStream["initialPage"]>): Response {
    const body = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        if (this.closed) return;
        if (this.pending.length > 0) {
          this.drain(controller);
          return;
        }
        return new Promise<void>((resolve) => {
          this.pullWaiting = () => {
            this.pullWaiting = null;
            this.drain(controller);
            resolve();
          };
        });
      },
      start: (controller) => {
        this.controller = controller;
        this.write(": connected\n\n");
        for (const event of firstPage) this.writeEvent(event);
        // The first page may have been full, or a notice may have arrived
        // while the response was being built.
        if (firstPage.length >= this.batchLimit || this.dirty.size > 0)
          this.markAll();
        this.pump();
        this.heartbeat = setInterval(() => {
          this.write(": heartbeat\n\n");
          this.markAll();
          this.pump();
        }, this.store.limits.stream_heartbeat_ms);
      },
      cancel: () => this.close(null),
    });
    return new Response(body, { headers: streamHeaders });
  }

  notice(notice: StoreNotice) {
    if (this.closed) return;
    if (notice.type === "disabled") {
      this.close("unavailable");
      return;
    }
    if (!this.cursors.has(notice.conversation_id)) return;
    if (notice.type === "removed") {
      if (notice.user_id === this.actor.user_id) this.close("membership");
      return;
    }
    this.dirty.add(notice.conversation_id);
    if (this.controller && !this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => {
        this.scheduled = false;
        this.pump();
      });
    }
  }

  private markAll() {
    for (const id of this.cursors.keys()) this.dirty.add(id);
  }

  private pump() {
    while (!this.closed && this.controller && this.dirty.size > 0) {
      // Another process may have flipped the kill switch; the heartbeat
      // re-poll sees it here and ends the stream.
      if (!this.store.isEnabled()) {
        this.close("unavailable");
        return;
      }
      const ids = [...this.dirty];
      this.dirty.clear();
      let events: ReturnType<EventStream["initialPage"]>;
      try {
        events = this.store.poll(this.actor, {
          cursors: ids.map((conversation_id) => ({
            conversation_id,
            after_event_seq: this.cursors.get(conversation_id) ?? 0,
          })),
          limit: this.batchLimit,
        });
        checkEventOrder(events, this.cursors);
      } catch (error) {
        const code = errorCode(error);
        this.close(
          code === "not_found" || code === "forbidden"
            ? "not_found"
            : code === "unavailable"
              ? "unavailable"
              : "internal_error",
        );
        return;
      }
      for (const event of events) this.writeEvent(event);
      if (events.length > 0) this.store.metrics.increment("backfill_pages");
      // A full page means more may be waiting behind it.
      if (events.length >= this.batchLimit)
        for (const id of ids) this.dirty.add(id);
    }
  }

  private writeEvent(event: ReturnType<EventStream["initialPage"]>[number]) {
    const data = StreamEventSchema.parse(event);
    this.write(
      `id: ${data.event_seq}\nevent: ${data.kind}\ndata: ${JSON.stringify(data)}\n\n`,
    );
  }

  private drain(controller: ReadableStreamDefaultController<Uint8Array>) {
    this.pullServed = true;
    const chunks = this.pending.splice(0);
    this.pendingBytes = 0;
    try {
      for (const chunk of chunks) controller.enqueue(chunk);
    } catch {
      this.close(null);
    }
  }

  private write(frame: string) {
    if (this.closed || !this.controller) return;
    const chunk = encoder.encode(frame);
    this.pending.push(chunk);
    this.pendingBytes += chunk.byteLength;
    if (this.pullWaiting) {
      this.pullWaiting();
      return;
    }
    // Before the first pull nothing is known about the consumer; after it,
    // unclaimed frames beyond the bound mean it stopped reading.
    if (
      this.pullServed &&
      this.pendingBytes > this.store.limits.max_stream_buffer_bytes
    )
      this.close("unavailable");
  }

  close(reason: StreamClose["reason"] | null) {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    const controller = this.controller;
    this.controller = null;
    if (controller) {
      try {
        // A purposeful close drops what the consumer never took and delivers
        // only the close frame; the client resumes from its cursors.
        if (reason !== null) {
          this.pending.length = 0;
          controller.enqueue(
            encoder.encode(
              `event: close\ndata: ${JSON.stringify(StreamCloseSchema.parse({ reason }))}\n\n`,
            ),
          );
        } else {
          for (const chunk of this.pending.splice(0)) controller.enqueue(chunk);
        }
        controller.close();
      } catch {
        // Already closed by the peer.
      }
    }
    this.pending.length = 0;
    this.pendingBytes = 0;
    const waiting = this.pullWaiting;
    this.pullWaiting = null;
    waiting?.();
    this.onClose();
  }
}

export function serveTeam(options: TeamServerOptions) {
  const port = options.port ?? 7332;
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    throw new Error("Invalid team service port.");
  const { store, authenticator } = options;
  const log = options.log ?? (() => {});
  let operationCounter = 0;
  const streams = new Set<EventStream>();
  const openStreams = new Map<string, number>();
  const streamKey = (actor: TeamActor) =>
    `${actor.team_id}\u0000${actor.user_id}`;
  store.subscribe((notice) => {
    for (const stream of [...streams]) stream.notice(notice);
  });
  const count = (name: Parameters<TeamStore["metrics"]["increment"]>[0]) => {
    try {
      store.metrics.increment(name);
    } catch {
      // Counting never fails a request (e.g. the store is already closed).
    }
  };

  const openStream = (actor: TeamActor, request: TeamStreamRequest) => {
    const key = streamKey(actor);
    const open = openStreams.get(key) ?? 0;
    if (open >= store.limits.max_open_streams_per_user)
      throw new TeamServerError("too_large");
    const cursors = new Map<string, number>();
    for (const cursor of request.params.cursors) {
      if (cursors.has(cursor.conversation_id))
        throw new TeamServerError("invalid_request");
      cursors.set(cursor.conversation_id, cursor.after_event_seq);
    }
    const streamId = ++operationCounter;
    const openedAt = Date.now();
    const stream: EventStream = new EventStream(store, actor, cursors, () => {
      if (!streams.delete(stream)) return;
      const remaining = (openStreams.get(key) ?? 1) - 1;
      if (remaining <= 0) openStreams.delete(key);
      else openStreams.set(key, remaining);
      if (stream.accepted) {
        count("stream_disconnects");
        log({
          op: "stream_closed",
          id: streamId,
          method: "events.stream",
          code: "ok",
          status: 200,
          ms: Date.now() - openedAt,
        });
      }
    });
    // Registered before the first poll so no commit falls between them.
    streams.add(stream);
    openStreams.set(key, open + 1);
    let firstPage: ReturnType<EventStream["initialPage"]>;
    try {
      firstPage = stream.initialPage();
    } catch (error) {
      stream.close(null);
      throw error;
    }
    stream.accepted = true;
    count("stream_connects");
    if (firstPage.length > 0) count("backfill_pages");
    return stream.response(firstPage);
  };

  const references = options.repos
    ? createReferenceService({ store, repos: options.repos })
    : null;
  const agentReferences = options.agentReferences ?? null;
  const finish = (
    id: number,
    method: string | null,
    startedAt: number,
    response: Response,
    op: TeamServerLogEntry["op"] = "rpc",
  ): Response => {
    let code: TeamServerLogEntry["code"] = "ok";
    if (response.status !== 200) {
      const status = response.status;
      code =
        (Object.keys(errors) as RpcErrorCode[]).find(
          (key) => errors[key].status === status,
        ) ?? "internal_error";
      count(`rpc_errors.${code}`);
      if (method !== null && READ_METHODS.has(method) && DENIAL_CODES.has(code))
        count(`denied_reads.${code}` as "denied_reads.not_found");
      if (code === "conflict") count("conflicts");
    }
    log({
      op,
      id,
      method,
      code,
      status: response.status,
      ms: Date.now() - startedAt,
    });
    return response;
  };
  const refuse = (error: unknown): Response => {
    if (error instanceof TeamError && error.code === "rate_limited")
      count("rate_limit_hits");
    return responseError(errorCode(error), retryAfter(error));
  };
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    maxRequestBodySize: MAX_REQUEST_BYTES,
    async fetch(request, server) {
      const id = ++operationCounter;
      const startedAt = Date.now();
      let method: string | null = null;
      let op: TeamServerLogEntry["op"] = "rpc";
      const done = (response: Response) =>
        finish(id, method, startedAt, response, op);
      const url = new URL(request.url);
      if (
        !["127.0.0.1", "localhost"].includes(url.hostname) ||
        Number(url.port || 80) !== server.port ||
        request.headers.has("origin")
      )
        return done(responseError("forbidden"));
      const route =
        url.pathname === "/v1/rpc"
          ? "rpc"
          : url.pathname === "/v1/stream"
            ? "stream"
            : null;
      if (request.method !== "POST" || route === null || url.search)
        return done(responseError("not_found"));
      if (route === "stream") {
        op = "stream";
        method = "events.stream";
      }
      const auth = request.headers.get("authorization") ?? "";
      if (auth.length > MAX_AUTHORIZATION_CHARS || !auth.startsWith("Bearer "))
        return done(responseError("unauthorized"));
      let user: Awaited<ReturnType<Authenticator["authenticate"]>>;
      try {
        user = await authenticator.authenticate(auth.slice("Bearer ".length));
      } catch {
        return done(responseError("unavailable"));
      }
      // The agent author id is reserved; no provider may mint it.
      if (!user || user.user_id === MARS_AGENT_USER_ID)
        return done(responseError("unauthorized"));
      if (
        request.headers
          .get("content-type")
          ?.split(";", 1)[0]
          ?.trim()
          .toLowerCase() !== "application/json"
      )
        return done(responseError("invalid_request"));
      try {
        const bytes = await request.arrayBuffer();
        if (bytes.byteLength > MAX_REQUEST_BYTES)
          return done(responseError("too_large"));
        let raw: unknown;
        try {
          raw = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          );
        } catch {
          return done(responseError("invalid_request"));
        }
        if (route === "stream") {
          const parsed = TeamStreamRequestSchema.safeParse(raw);
          if (!parsed.success) return done(responseError("invalid_request"));
          const teamId = parsed.data.context.team_id;
          if (!user.team_ids.includes(teamId))
            return done(responseError("forbidden"));
          if (!store.isEnabled()) {
            count("disabled_refusals");
            return done(responseError("unavailable"));
          }
          const actor: TeamActor = { team_id: teamId, user_id: user.user_id };
          // A client abort reaches the stream through `cancel`.
          return done(openStream(actor, parsed.data));
        }
        const parsed = TeamRpcRequestSchema.safeParse(raw);
        if (!parsed.success) return done(responseError("invalid_request"));
        method = parsed.data.method;
        const teamId = parsed.data.context.team_id;
        if (!user.team_ids.includes(teamId))
          return done(responseError("forbidden"));
        // Kill switch: only `team.describe` (which reports `enabled: false`)
        // answers while the host has Team Chat off. Durable data is untouched.
        if (parsed.data.method !== "team.describe" && !store.isEnabled()) {
          count("disabled_refusals");
          return done(responseError("unavailable"));
        }
        const actor: TeamActor = { team_id: teamId, user_id: user.user_id };
        const result = await dispatch(
          store,
          references,
          agentReferences,
          actor,
          parsed.data,
        );
        validateResult(store, parsed.data, result, actor);
        const body = JSON.stringify({ result });
        if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES)
          return done(responseError("too_large"));
        return done(new Response(body, { headers }));
      } catch (error) {
        return done(refuse(error));
      }
    },
    error() {
      return responseError("internal_error");
    },
  });
}
