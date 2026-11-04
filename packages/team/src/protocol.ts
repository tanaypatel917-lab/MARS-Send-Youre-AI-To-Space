import {
  AGENT_MAX_IDEMPOTENCY_KEY_CHARS,
  AGENT_MAX_MESSAGES,
  AgentPreviewSchema,
  AgentRequestSchema,
  ConversationSchema,
  GitRangeReferenceSchema,
  MessageViewSchema,
  ParticipantSchema,
  ReferencePreviewSchema,
  RepoSchema,
  ScopeSchema,
  SharedEvidenceSchema,
  ShareSelectionSchema,
  TASK_LINK_MAX_MESSAGES,
  TaskLinkSchema,
  TaskStatusSchema,
  TEAM_MAX_BODY_CHARS,
  TEAM_MAX_CLIENT_MESSAGE_ID_CHARS,
  TEAM_MAX_EMOJI_CHARS,
  TEAM_MAX_EXCERPT_CHARS,
  TEAM_MAX_REFERENCES,
  TEAM_MAX_SEARCH_QUERY_CHARS,
  TEAM_MAX_TITLE_CHARS,
  TeamContextSchema,
  TeamDeliveryEventSchema,
  TeamRoleSchema,
} from "@mars/contracts";
import { z } from "zod";
import {
  TEAM_MAX_GROUP_SIZE,
  TEAM_MAX_SEARCH_HITS,
  TeamLimitsSchema,
} from "./schemas";

/**
 * Team service RPC: the exact envelope of the workbench RPC
 * (`{method, context, params}` → `{result}` | `{error: {code, message}}`),
 * with `TeamContextSchema` in place of the scope context. `user_id` never
 * appears in a request; the server derives it from the bearer token.
 *
 * `events.stream` uses the same envelope on `POST /v1/stream` and answers
 * `text/event-stream`; it is deliberately not part of `TeamRpcRequestSchema`
 * so `/v1/rpc` rejects it as `invalid_request`.
 * Search must render references through the same per-viewer gate as
 * `messages.history` (`TeamStore.history` chips): a restricted reference's
 * path, label or SHA is never indexed or matched for that viewer.
 * Task links (`tasks.link_*`) and result shares (`shares.*`) are the Team Chat
 * PR 6 chat half; the service stores workbench ids and cards only and never
 * calls a workbench itself.
 *
 * `agent.publish` is deliberately absent: answers are stored through the
 * host-only `TeamAgentHostPort`, never by a client.
 */
const id = z.string().min(1).max(256);
const seq = z.number().int().nonnegative();
const empty = z.object({}).strict();
const conversationId = z.object({ conversation_id: id }).strict();
const commitSha = z.string().regex(/^[a-f0-9]{40}$/);
const lineNumber = z.number().int().positive();

export const MAX_GROUP_MEMBER_IDS = TEAM_MAX_GROUP_SIZE;
export const MAX_POLL_CURSORS = 50;
export const MAX_HISTORY_LIMIT = 200;
export const MAX_POLL_LIMIT = 1000;
export const MAX_SEARCH_LIMIT = 50;
export const MAX_SEARCH_CURSOR_CHARS = 512;
export const MAX_REFERENCE_PATH_CHARS = 1024;
export const MAX_SEARCH_QUERY_CHARS = 256;

function method<M extends string, P extends z.AnyZodObject>(
  name: M,
  params: P,
) {
  return z
    .object({ method: z.literal(name), context: TeamContextSchema, params })
    .strict();
}

export const MembershipChangeParamsSchema = z
  .object({
    conversation_id: id,
    user_id: id,
    expected_revision: seq,
  })
  .strict();

export const SendParamsSchema = z
  .object({
    conversation_id: id,
    client_message_id: z.string().min(1).max(TEAM_MAX_CLIENT_MESSAGE_ID_CHARS),
    body: z.string().min(1).max(TEAM_MAX_BODY_CHARS),
    reply_to: id.optional(),
    /** Ids returned by `references.create`; each must be in the team and accessible to the sender. */
    reference_ids: z.array(id).max(TEAM_MAX_REFERENCES).optional(),
  })
  .strict();

export const HistoryParamsSchema = z
  .object({
    conversation_id: id,
    after_seq: seq.optional(),
    before_seq: z.number().int().positive().optional(),
    limit: z.number().int().positive().max(MAX_HISTORY_LIMIT).optional(),
  })
  .strict();

export const PollCursorSchema = z
  .object({ conversation_id: id, after_event_seq: seq })
  .strict();

export const PollParamsSchema = z
  .object({
    cursors: z.array(PollCursorSchema).max(MAX_POLL_CURSORS),
    limit: z.number().int().positive().max(MAX_POLL_LIMIT).optional(),
  })
  .strict();

export const ReactionSetParamsSchema = z
  .object({
    message_id: id,
    emoji: z.string().min(1).max(TEAM_MAX_EMOJI_CHARS),
    on: z.boolean(),
  })
  .strict();

export const SearchParamsSchema = z
  .object({
    query: z.string().min(2).max(TEAM_MAX_SEARCH_QUERY_CHARS),
    conversation_id: id.optional(),
    limit: z.number().int().positive().max(MAX_SEARCH_LIMIT).optional(),
    cursor: z.string().min(1).max(MAX_SEARCH_CURSOR_CHARS).optional(),
  })
  .strict();

export const StreamParamsSchema = z
  .object({ cursors: z.array(PollCursorSchema).min(1).max(MAX_POLL_CURSORS) })
  .strict();

/** `POST /v1/stream` body; the response is Server-Sent Events. */
export const TeamStreamRequestSchema = method(
  "events.stream",
  StreamParamsSchema,
);
export type TeamStreamRequest = z.infer<typeof TeamStreamRequestSchema>;

/** Locator of a committed object; `validateLocator` applies the full path and range rules. */
export const CreateReferenceParamsSchema = z
  .object({
    repo_id: id,
    commit_sha: commitSha,
    path: z.string().min(1).max(MAX_REFERENCE_PATH_CHARS),
    line_start: lineNumber.optional(),
    line_end: lineNumber.optional(),
  })
  .strict();
export type CreateReferenceParams = z.infer<typeof CreateReferenceParamsSchema>;

export const ResolveReferenceParamsSchema = z
  .object({ reference_id: id })
  .strict();

export const SearchPathsParamsSchema = z
  .object({
    repo_id: id,
    commit_sha: commitSha,
    query: z.string().max(MAX_SEARCH_QUERY_CHARS),
    limit: z.number().int().positive().max(TEAM_MAX_SEARCH_HITS).optional(),
  })
  .strict();
export type SearchPathsParams = z.infer<typeof SearchPathsParamsSchema>;

export const LinkDraftParamsSchema = z
  .object({
    conversation_id: id,
    message_ids: z.array(id).min(1).max(TASK_LINK_MAX_MESSAGES),
    reference_ids: z.array(id).max(TEAM_MAX_REFERENCES),
  })
  .strict();

export const LinkConfirmParamsSchema = z
  .object({
    link_id: id,
    workbench: z
      .object({ scope: ScopeSchema, task_id: id, request_id: id })
      .strict(),
    target: z
      .object({
        repo_id: id.optional(),
        base_revision: z.string().min(1).max(256).optional(),
      })
      .strict(),
  })
  .strict();

/**
 * `evidence` is the caller's own workbench `tasks.evidence` result and
 * `run_status` the caller's `tasks.inspect` status (the evidence result does
 * not carry it; see the follow-up in `documentation/TEAM_CHAT.md`).
 */
export const SharePreviewParamsSchema = z
  .object({
    link_id: id,
    evidence: SharedEvidenceSchema,
    run_status: TaskStatusSchema,
    selection: ShareSelectionSchema,
  })
  .strict();
export const ShareCreateParamsSchema = SharePreviewParamsSchema.extend({
  preview_sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const AgentSelectionParamsSchema = z
  .object({
    conversation_id: id,
    message_ids: z.array(id).max(AGENT_MAX_MESSAGES),
    reference_ids: z.array(id).max(TEAM_MAX_REFERENCES),
  })
  .strict();
export const AgentRequestParamsSchema = AgentSelectionParamsSchema.extend({
  idempotency_key: z.string().min(1).max(AGENT_MAX_IDEMPOTENCY_KEY_CHARS),
  audience: z.literal("conversation"),
  preview_sha256: sha256,
}).strict();
const requestId = z.object({ request_id: id }).strict();

export const TeamRpcRequestSchema = z.discriminatedUnion("method", [
  method("team.describe", empty),
  /** Redacted counters; team admins only. */
  method("team.metrics", empty),
  method("conversations.create_dm", z.object({ peer_user_id: id }).strict()),
  method(
    "conversations.create_group",
    z
      .object({
        member_ids: z.array(id).max(MAX_GROUP_MEMBER_IDS),
        title: z.string().min(1).max(TEAM_MAX_TITLE_CHARS),
      })
      .strict(),
  ),
  method("conversations.list", empty),
  method("conversations.open", conversationId),
  method("conversations.add_member", MembershipChangeParamsSchema),
  method("conversations.remove_member", MembershipChangeParamsSchema),
  method("conversations.leave", conversationId),
  method(
    "conversations.mark_read",
    z.object({ conversation_id: id, read_seq: seq }).strict(),
  ),
  method(
    "conversations.pin",
    z.object({ conversation_id: id, pinned: z.boolean() }).strict(),
  ),
  method("messages.send", SendParamsSchema),
  method("messages.history", HistoryParamsSchema),
  method(
    "messages.edit",
    z
      .object({
        message_id: id,
        body: z.string().min(1).max(TEAM_MAX_BODY_CHARS),
      })
      .strict(),
  ),
  method("messages.delete", z.object({ message_id: id }).strict()),
  method("events.poll", PollParamsSchema),
  method("reactions.set", ReactionSetParamsSchema),
  method("messages.search", SearchParamsSchema),
  method("repos.list", empty),
  method("references.create", CreateReferenceParamsSchema),
  method("references.resolve", ResolveReferenceParamsSchema),
  method("references.search_paths", SearchPathsParamsSchema),
  method("tasks.link_draft", LinkDraftParamsSchema),
  method("tasks.link_confirm", LinkConfirmParamsSchema),
  method(
    "tasks.link_created",
    z
      .object({ link_id: id, task_revision: z.number().int().nonnegative() })
      .strict(),
  ),
  method("tasks.link_inspect", z.object({ link_id: id }).strict()),
  method("shares.preview", SharePreviewParamsSchema),
  method("shares.create", ShareCreateParamsSchema),
  method("agent.preview", AgentSelectionParamsSchema),
  method("agent.request", AgentRequestParamsSchema),
  method("agent.cancel", requestId),
  method("agent.inspect", requestId),
]);
export { AgentPreviewSchema, AgentRequestSchema };
export type TeamRpcRequest = z.infer<typeof TeamRpcRequestSchema>;
export type TeamRpcMethod = TeamRpcRequest["method"];

export const ConversationMemberSchema = z
  .object({
    user_id: id,
    state: z.enum(["active", "removed"]),
    joined_seq: seq,
  })
  .strict();

export const ConversationViewSchema = z
  .object({
    conversation: ConversationSchema,
    participant: ParticipantSchema,
    members: z.array(ConversationMemberSchema).max(256),
  })
  .strict();
export type ConversationViewResult = z.infer<typeof ConversationViewSchema>;

export const TeamDescribeResultSchema = z
  .object({
    team_id: id,
    user_id: id,
    role: TeamRoleSchema,
    /** Host kill switch (`mars team enable|disable`); when false every other method answers `unavailable`. */
    enabled: z.boolean(),
    limits: TeamLimitsSchema,
    capabilities: z
      .object({
        stream: z.boolean(),
        reactions: z.boolean(),
        search: z.boolean(),
        /** True when the host wired a `@mars/code-refs` registry into the server. */
        references: z.boolean(),
        agent: z.boolean(),
      })
      .strict(),
  })
  .strict();

/** `conversations.list` item: the view plus per-participant counters. */
export const ConversationListItemSchema = ConversationViewSchema.extend({
  /** Messages after the caller's `read_seq` not authored by the caller. */
  unread_count: seq,
  last_message_at: z.string().datetime({ offset: true }).nullable(),
}).strict();
export type ConversationListItem = z.infer<typeof ConversationListItemSchema>;
export const ConversationListSchema = z
  .array(ConversationListItemSchema)
  .max(10_000);

export {
  type MessageView,
  MessageViewSchema,
  type ReactionSummary,
  ReactionSummarySchema,
} from "@mars/contracts";

/** `reactions.set` result: the state of that key after the call. */
export const ReactionStateSchema = z
  .object({
    message_id: id,
    emoji: z.string().min(1).max(TEAM_MAX_EMOJI_CHARS),
    count: seq,
    reacted: z.boolean(),
  })
  .strict();
export type ReactionState = z.infer<typeof ReactionStateSchema>;

export const MessageListSchema = z
  .array(MessageViewSchema)
  .max(MAX_HISTORY_LIMIT);

export const SearchHitSchema = z
  .object({
    conversation_id: id,
    message_id: id,
    seq: z.number().int().positive(),
    author_id: id,
    created_at: z.string().datetime({ offset: true }),
    excerpt: z.string().max(TEAM_MAX_EXCERPT_CHARS),
    cut_before: z.boolean(),
    cut_after: z.boolean(),
  })
  .strict();
export type SearchHit = z.infer<typeof SearchHitSchema>;

export const SearchResultSchema = z
  .object({
    hits: z.array(SearchHitSchema).max(MAX_SEARCH_LIMIT),
    next_cursor: z.string().max(MAX_SEARCH_CURSOR_CHARS).nullable(),
  })
  .strict();
export type SearchResult = z.infer<typeof SearchResultSchema>;

/** One SSE frame's `data:`; `id:` is the `event_seq`. Metadata only. */
export const StreamEventSchema = TeamDeliveryEventSchema;
/** Sent once before the server closes a stream on purpose. */
export const StreamCloseSchema = z
  .object({
    reason: z.enum([
      "membership",
      "not_found",
      "unavailable",
      "internal_error",
    ]),
  })
  .strict();
export type StreamClose = z.infer<typeof StreamCloseSchema>;
export const EventListSchema = z
  .array(TeamDeliveryEventSchema)
  .max(MAX_POLL_LIMIT);
export const RepoListSchema = z.array(RepoSchema).max(10_000);
export const ReferenceResultSchema = GitRangeReferenceSchema;
export const ReferencePreviewResultSchema = ReferencePreviewSchema;

/** `references.search_paths` result: repo-relative paths only, never a label or absolute path. */
export const PathSearchResultSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("ok"),
      matches: z
        .array(
          z
            .object({
              path: z.string().min(1).max(MAX_REFERENCE_PATH_CHARS),
              rank: z.number().int().min(0).max(4),
            })
            .strict(),
        )
        .max(TEAM_MAX_SEARCH_HITS),
      truncated: z.boolean(),
    })
    .strict(),
  /** The commit is not in the repo (or not yet fetched); nothing else is said. */
  z
    .object({ state: z.literal("unavailable") })
    .strict(),
]);
export type PathSearchResult = z.infer<typeof PathSearchResultSchema>;

export const TASK_LINK_EXCERPT_CHARS = 280;
/** Shown to the requester in the confirmation step only; never stored. */
export const TaskLinkExcerptSchema = z
  .object({
    message_id: id,
    seq: z.number().int().positive(),
    author_id: id,
    excerpt: z.string().max(TASK_LINK_EXCERPT_CHARS),
    truncated: z.boolean(),
  })
  .strict();
export const TaskLinkDraftResultSchema = z
  .object({
    link: TaskLinkSchema,
    excerpts: z.array(TaskLinkExcerptSchema).max(TASK_LINK_MAX_MESSAGES),
  })
  .strict();
export type TaskLinkDraftResult = z.infer<typeof TaskLinkDraftResultSchema>;
