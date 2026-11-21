import { randomUUID } from "node:crypto";
import type { Participant } from "@mars/contracts";
import { TEAM_MAX_CLIENT_MESSAGE_ID_CHARS } from "@mars/contracts";
import type { z } from "zod";
import { RpcError, type RpcTransport } from "../rpc";
import {
  type AgentPreviewResult,
  AgentPreviewSchema,
  type AgentRequestResult,
  AgentRequestSchema,
  type ConversationListItem,
  ConversationListSchema,
  type ConversationView,
  ConversationViewSchema,
  EventListSchema,
  MAX_HISTORY_LIMIT,
  MAX_POLL_CURSORS,
  MAX_POLL_LIMIT,
  MAX_SEARCH_LIMIT,
  MessageListSchema,
  type MessageView,
  MIN_SEARCH_QUERY_CHARS,
  ParticipantResultSchema,
  type PathSearchResult,
  PathSearchResultSchema,
  type PollCursor,
  type ReactionState,
  ReactionStateSchema,
  type ReferencePreviewResult,
  ReferencePreviewResultSchema,
  type ReferenceResult,
  ReferenceResultSchema,
  type RepoListItem,
  RepoListSchema,
  type ResultShareResult,
  ResultShareSchema,
  type SearchResponse,
  SearchResultSchema,
  type SharePreviewResult,
  SharePreviewSchema,
  type TaskLinkDraftResult,
  TaskLinkDraftResultSchema,
  type TaskLinkRecordResult,
  TaskLinkSchema,
  type TaskLinkViewResult,
  TaskLinkViewSchema,
  TEAM_RPC_METHODS,
  TEAM_SCHEMA_VERSION,
  type TeamContext,
  type TeamDescribeResult,
  TeamDescribeResultSchema,
  type TeamEvent,
  type TeamRpcMethod,
} from "./protocol";

export type TeamTransport = RpcTransport<TeamRpcMethod, TeamContext>;

function invalid(what: string): RpcError {
  return new RpcError("protocol", `Team server returned an invalid ${what}.`);
}

function validate<T extends z.ZodTypeAny>(
  schema: T,
  value: unknown,
  what: string,
): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw invalid(what);
  return parsed.data;
}

/**
 * Typed client for the `@mars/team` RPC. Lives in the extension host only;
 * the token is read by the transport and never returned from here. Every
 * result is validated against the contracts schemas and cross-checked
 * against the authenticated `team_id`/`user_id` so a confused server cannot
 * smuggle another tenant's records into the view.
 */
export class TeamClient {
  private described: TeamDescribeResult | undefined;

  constructor(
    private readonly transport: TeamTransport,
    private readonly newId: () => string = randomUUID,
  ) {}

  get identity(): TeamDescribeResult | undefined {
    return this.described;
  }

  async describe(signal?: AbortSignal): Promise<TeamDescribeResult> {
    const result = await this.transport.send(
      { method: TEAM_RPC_METHODS.describe, params: {} },
      signal,
    );
    this.described = validate(
      TeamDescribeResultSchema,
      result,
      "team description",
    );
    return this.described;
  }

  forget(): void {
    this.described = undefined;
  }

  /** Largest history page this server accepts (`limits.page_limit`), never above the client bound. */
  pageLimit(): number {
    const advertised = this.described?.limits.page_limit;
    return Math.min(
      MAX_HISTORY_LIMIT,
      advertised && advertised > 0 ? advertised : MAX_HISTORY_LIMIT,
    );
  }

  private context(): TeamContext {
    if (!this.described)
      throw new RpcError("disconnected", "Not connected to a team server.");
    return {
      schema_version: TEAM_SCHEMA_VERSION,
      team_id: this.described.team_id,
      request_id: this.newId(),
    };
  }

  private teamId(): string {
    if (!this.described)
      throw new RpcError("disconnected", "Not connected to a team server.");
    return this.described.team_id;
  }

  private async call(
    method: TeamRpcMethod,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.transport.send(
      { method, context: this.context(), params },
      signal,
    );
  }

  private checkView(view: ConversationView, conversationId?: string) {
    const me = this.described;
    if (!me) throw invalid("conversation");
    if (view.conversation.team_id !== me.team_id)
      throw invalid("conversation tenant");
    if (view.participant.user_id !== me.user_id)
      throw invalid("conversation participant");
    if (view.participant.conversation_id !== view.conversation.conversation_id)
      throw invalid("conversation identity");
    if (
      conversationId !== undefined &&
      view.conversation.conversation_id !== conversationId
    )
      throw invalid("conversation identity");
    return view;
  }

  private checkParticipant(value: unknown, conversationId: string) {
    const participant = validate(ParticipantResultSchema, value, "participant");
    if (
      participant.conversation_id !== conversationId ||
      participant.user_id !== this.described?.user_id
    )
      throw invalid("participant identity");
    return participant;
  }

  private checkMessages(
    value: unknown,
    conversationId?: string,
  ): MessageView[] {
    const messages = validate(MessageListSchema, value, "message list");
    for (const message of messages)
      if (
        conversationId !== undefined &&
        message.conversation_id !== conversationId
      )
        throw invalid("message conversation");
    return messages;
  }

  async listConversations(
    signal?: AbortSignal,
  ): Promise<ConversationListItem[]> {
    const result = await this.call(TEAM_RPC_METHODS.list, {}, signal);
    const items = validate(ConversationListSchema, result, "conversation list");
    for (const item of items) this.checkView(item);
    return items;
  }

  async openConversation(
    conversationId: string,
    signal?: AbortSignal,
  ): Promise<ConversationView> {
    const result = await this.call(
      TEAM_RPC_METHODS.open,
      { conversation_id: conversationId },
      signal,
    );
    return this.checkView(
      validate(ConversationViewSchema, result, "conversation"),
      conversationId,
    );
  }

  async history(
    conversationId: string,
    window: { after_seq?: number; before_seq?: number; limit?: number },
    signal?: AbortSignal,
  ): Promise<MessageView[]> {
    const params: Record<string, unknown> = { conversation_id: conversationId };
    if (window.after_seq !== undefined) params.after_seq = window.after_seq;
    if (window.before_seq !== undefined) params.before_seq = window.before_seq;
    params.limit = Math.min(
      this.pageLimit(),
      Math.max(1, Math.floor(window.limit ?? 50)),
    );
    const result = await this.call(TEAM_RPC_METHODS.history, params, signal);
    return this.checkMessages(result, conversationId);
  }

  async send(
    input: {
      conversation_id: string;
      client_message_id: string;
      body: string;
      reply_to?: string;
      reference_ids?: string[];
    },
    signal?: AbortSignal,
  ): Promise<MessageView> {
    if (
      input.client_message_id.length === 0 ||
      input.client_message_id.length > TEAM_MAX_CLIENT_MESSAGE_ID_CHARS
    )
      throw new RpcError("protocol", "Invalid client message id.");
    const params: Record<string, unknown> = {
      conversation_id: input.conversation_id,
      client_message_id: input.client_message_id,
      body: input.body,
    };
    if (input.reply_to) params.reply_to = input.reply_to;
    if (input.reference_ids && input.reference_ids.length > 0)
      params.reference_ids = input.reference_ids;
    const result = await this.call(TEAM_RPC_METHODS.send, params, signal);
    const [message] = this.checkMessages([result], input.conversation_id);
    if (!message || message.client_message_id !== input.client_message_id)
      throw invalid("sent message");
    return message;
  }

  async markRead(
    conversationId: string,
    readSeq: number,
    signal?: AbortSignal,
  ): Promise<Participant> {
    const result = await this.call(
      TEAM_RPC_METHODS.markRead,
      { conversation_id: conversationId, read_seq: readSeq },
      signal,
    );
    return this.checkParticipant(result, conversationId);
  }

  async pin(
    conversationId: string,
    pinned: boolean,
    signal?: AbortSignal,
  ): Promise<Participant> {
    const result = await this.call(
      TEAM_RPC_METHODS.pin,
      { conversation_id: conversationId, pinned },
      signal,
    );
    return this.checkParticipant(result, conversationId);
  }

  async poll(
    cursors: PollCursor[],
    limit = MAX_POLL_LIMIT,
    signal?: AbortSignal,
  ): Promise<TeamEvent[]> {
    if (cursors.length > MAX_POLL_CURSORS)
      throw new RpcError("protocol", "Too many poll cursors.");
    const result = await this.call(
      TEAM_RPC_METHODS.poll,
      { cursors, limit: Math.min(MAX_POLL_LIMIT, Math.max(1, limit)) },
      signal,
    );
    const events = validate(EventListSchema, result, "event list");
    const known = new Set(cursors.map((c) => c.conversation_id));
    for (const event of events)
      if (!known.has(event.conversation_id))
        throw invalid("event conversation");
    return events;
  }

  /** Callers check `identity.capabilities.reactions` first. */
  async setReaction(
    messageId: string,
    emoji: string,
    on: boolean,
    signal?: AbortSignal,
  ): Promise<ReactionState> {
    const result = await this.call(
      TEAM_RPC_METHODS.reactionsSet,
      { message_id: messageId, emoji, on },
      signal,
    );
    const state = validate(ReactionStateSchema, result, "reaction state");
    if (state.message_id !== messageId || state.emoji !== emoji)
      throw invalid("reaction identity");
    return state;
  }

  /** Callers check `identity.capabilities.search` first. */
  async search(
    query: string,
    conversationId?: string | null,
    limit = MAX_SEARCH_LIMIT,
    signal?: AbortSignal,
  ): Promise<SearchResponse> {
    if (query.length < MIN_SEARCH_QUERY_CHARS)
      throw new RpcError("protocol", "Search query too short.");
    const params: Record<string, unknown> = {
      query,
      limit: Math.min(MAX_SEARCH_LIMIT, Math.max(1, limit)),
    };
    if (conversationId) params.conversation_id = conversationId;
    const result = await this.call(TEAM_RPC_METHODS.search, params, signal);
    const response = validate(SearchResultSchema, result, "search results");
    if (conversationId)
      for (const hit of response.hits)
        if (hit.conversation_id !== conversationId)
          throw invalid("search conversation");
    return response;
  }

  /** Body of `POST /v1/stream`: the RPC envelope with `events.stream`; the transport is the SSE reader. */
  streamRequest(cursors: PollCursor[]): string {
    if (cursors.length === 0 || cursors.length > MAX_POLL_CURSORS)
      throw new RpcError("protocol", "Invalid stream cursors.");
    return JSON.stringify({
      method: TEAM_RPC_METHODS.stream,
      context: this.context(),
      params: { cursors },
    });
  }

  async listRepos(signal?: AbortSignal): Promise<RepoListItem[]> {
    const result = await this.call(TEAM_RPC_METHODS.reposList, {}, signal);
    const repos = validate(RepoListSchema, result, "repo list");
    const teamId = this.teamId();
    for (const repo of repos)
      if (repo.team_id !== teamId) throw invalid("repo tenant");
    return repos;
  }

  async createReference(
    input: {
      repo_id: string;
      commit_sha: string;
      path: string;
      line_start?: number;
      line_end?: number;
    },
    signal?: AbortSignal,
  ): Promise<ReferenceResult> {
    const params: Record<string, unknown> = {
      repo_id: input.repo_id,
      commit_sha: input.commit_sha,
      path: input.path,
    };
    if (input.line_start !== undefined) params.line_start = input.line_start;
    if (input.line_end !== undefined) params.line_end = input.line_end;
    const result = await this.call(
      TEAM_RPC_METHODS.referencesCreate,
      params,
      signal,
    );
    const ref = validate(ReferenceResultSchema, result, "reference");
    if (ref.team_id !== this.teamId()) throw invalid("reference tenant");
    return ref;
  }

  async resolveReference(
    referenceId: string,
    signal?: AbortSignal,
  ): Promise<ReferencePreviewResult> {
    const result = await this.call(
      TEAM_RPC_METHODS.referencesResolve,
      { reference_id: referenceId },
      signal,
    );
    return validate(ReferencePreviewResultSchema, result, "reference preview");
  }

  async searchPaths(
    input: {
      repo_id: string;
      commit_sha: string;
      query: string;
      limit?: number;
    },
    signal?: AbortSignal,
  ): Promise<PathSearchResult> {
    const params: Record<string, unknown> = {
      repo_id: input.repo_id,
      commit_sha: input.commit_sha,
      query: input.query,
    };
    if (input.limit !== undefined) params.limit = input.limit;
    const result = await this.call(
      TEAM_RPC_METHODS.referencesSearchPaths,
      params,
      signal,
    );
    return validate(PathSearchResultSchema, result, "path search");
  }

  async agentPreview(
    input: {
      conversation_id: string;
      message_ids: string[];
      reference_ids: string[];
    },
    signal?: AbortSignal,
  ): Promise<AgentPreviewResult> {
    const result = await this.call(
      TEAM_RPC_METHODS.agentPreview,
      input,
      signal,
    );
    const preview = validate(AgentPreviewSchema, result, "agent preview");
    if (preview.conversation_id !== input.conversation_id)
      throw invalid("agent preview conversation");
    return preview;
  }

  async agentRequest(
    input: {
      conversation_id: string;
      message_ids: string[];
      reference_ids: string[];
      idempotency_key: string;
      preview_sha256: string;
    },
    signal?: AbortSignal,
  ): Promise<AgentRequestResult> {
    const result = await this.call(
      TEAM_RPC_METHODS.agentRequest,
      { ...input, audience: "conversation" },
      signal,
    );
    const req = validate(AgentRequestSchema, result, "agent request");
    if (req.team_id !== this.teamId()) throw invalid("agent request tenant");
    return req;
  }

  async agentCancel(
    requestId: string,
    signal?: AbortSignal,
  ): Promise<AgentRequestResult> {
    const result = await this.call(
      TEAM_RPC_METHODS.agentCancel,
      { request_id: requestId },
      signal,
    );
    const req = validate(AgentRequestSchema, result, "agent cancel");
    if (req.team_id !== this.teamId()) throw invalid("agent cancel tenant");
    return req;
  }

  async agentInspect(
    requestId: string,
    signal?: AbortSignal,
  ): Promise<AgentRequestResult> {
    const result = await this.call(
      TEAM_RPC_METHODS.agentInspect,
      { request_id: requestId },
      signal,
    );
    const req = validate(AgentRequestSchema, result, "agent inspect");
    if (req.team_id !== this.teamId()) throw invalid("agent inspect tenant");
    return req;
  }

  async taskLinkDraft(
    input: {
      conversation_id: string;
      message_ids: string[];
      reference_ids: string[];
    },
    signal?: AbortSignal,
  ): Promise<TaskLinkDraftResult> {
    const result = await this.call(
      TEAM_RPC_METHODS.tasksLinkDraft,
      input,
      signal,
    );
    const draft = validate(
      TaskLinkDraftResultSchema,
      result,
      "task link draft",
    );
    if (draft.link.team_id !== this.teamId())
      throw invalid("task link draft tenant");
    return draft;
  }

  async taskLinkConfirm(
    input: {
      link_id: string;
      workbench: {
        scope: Record<string, unknown>;
        task_id: string;
        request_id: string;
      };
      target: { repo_id?: string; base_revision?: string };
    },
    signal?: AbortSignal,
  ): Promise<TaskLinkRecordResult> {
    const result = await this.call(
      TEAM_RPC_METHODS.tasksLinkConfirm,
      input,
      signal,
    );
    const link = validate(TaskLinkSchema, result, "task link confirm");
    if (link.team_id !== this.teamId()) throw invalid("task link tenant");
    return link;
  }

  async taskLinkCreated(
    input: { link_id: string; task_revision: number },
    signal?: AbortSignal,
  ): Promise<TaskLinkRecordResult> {
    const result = await this.call(
      TEAM_RPC_METHODS.tasksLinkCreated,
      input,
      signal,
    );
    const link = validate(TaskLinkSchema, result, "task link created");
    if (link.team_id !== this.teamId()) throw invalid("task link tenant");
    return link;
  }

  async taskLinkInspect(
    linkId: string,
    signal?: AbortSignal,
  ): Promise<TaskLinkViewResult> {
    const result = await this.call(
      TEAM_RPC_METHODS.tasksLinkInspect,
      { link_id: linkId },
      signal,
    );
    const view = validate(TaskLinkViewSchema, result, "task link view");
    if (view.link.team_id !== this.teamId()) throw invalid("task link tenant");
    return view;
  }

  async sharePreview(
    input: {
      link_id: string;
      evidence: Record<string, unknown>;
      run_status: string;
      selection: {
        summary: string;
        include_diff_digest: boolean;
        verify_event_ids: string[];
      };
    },
    signal?: AbortSignal,
  ): Promise<SharePreviewResult> {
    const result = await this.call(
      TEAM_RPC_METHODS.sharesPreview,
      input,
      signal,
    );
    return validate(SharePreviewSchema, result, "share preview");
  }

  async shareCreate(
    input: {
      link_id: string;
      evidence: Record<string, unknown>;
      run_status: string;
      selection: {
        summary: string;
        include_diff_digest: boolean;
        verify_event_ids: string[];
      };
      preview_sha256: string;
    },
    signal?: AbortSignal,
  ): Promise<ResultShareResult> {
    const result = await this.call(
      TEAM_RPC_METHODS.sharesCreate,
      input,
      signal,
    );
    return validate(ResultShareSchema, result, "result share");
  }
}
