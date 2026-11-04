import {
  ConversationSchema,
  MessageSchema,
  ParticipantSchema,
  TEAM_MAX_BODY_CHARS,
  TEAM_MAX_CLIENT_MESSAGE_ID_CHARS,
  TEAM_MAX_EMOJI_CHARS,
  TEAM_MAX_EXCERPT_CHARS,
  TEAM_MAX_SEARCH_QUERY_CHARS,
  TEAM_MAX_TITLE_CHARS,
  TeamContextSchema,
  TeamDeliveryEventSchema,
  TeamRoleSchema,
} from "@mars/contracts";
import { z } from "zod";
import { TEAM_MAX_GROUP_SIZE, TeamLimitsSchema } from "./schemas";

/**
 * Team service RPC: the exact envelope of the workbench RPC
 * (`{method, context, params}` → `{result}` | `{error: {code, message}}`),
 * with `TeamContextSchema` in place of the scope context. `user_id` never
 * appears in a request; the server derives it from the bearer token.
 *
 * `events.stream` uses the same envelope on `POST /v1/stream` and answers
 * `text/event-stream`; it is deliberately not part of `TeamRpcRequestSchema`
 * so `/v1/rpc` rejects it as `invalid_request`.
 */
const id = z.string().min(1).max(256);
const seq = z.number().int().nonnegative();
const empty = z.object({}).strict();
const conversationId = z.object({ conversation_id: id }).strict();

export const MAX_GROUP_MEMBER_IDS = TEAM_MAX_GROUP_SIZE;
export const MAX_POLL_CURSORS = 50;
export const MAX_HISTORY_LIMIT = 200;
export const MAX_POLL_LIMIT = 1000;
export const MAX_SEARCH_LIMIT = 50;
export const MAX_SEARCH_CURSOR_CHARS = 512;
export const MAX_REACTION_SUMMARIES = 256;

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

export const TeamRpcRequestSchema = z.discriminatedUnion("method", [
  method("team.describe", empty),
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
  method("events.poll", PollParamsSchema),
  method("reactions.set", ReactionSetParamsSchema),
  method("messages.search", SearchParamsSchema),
]);
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
    limits: TeamLimitsSchema,
    capabilities: z
      .object({
        stream: z.boolean(),
        reactions: z.boolean(),
        search: z.boolean(),
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

/** Per-message aggregate; the pilot exposes counts, never who reacted. */
export const ReactionSummarySchema = z
  .object({
    emoji: z.string().min(1).max(TEAM_MAX_EMOJI_CHARS),
    count: z.number().int().positive(),
    reacted: z.boolean(),
  })
  .strict();
export type ReactionSummary = z.infer<typeof ReactionSummarySchema>;

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

/**
 * `messages.history` item: the stored record plus reaction summaries and a
 * bounded excerpt of the reply target (`null` with `reply_restricted: true`
 * when the target is before the caller's `joined_seq`).
 */
export const MessageViewSchema = MessageSchema.extend({
  reactions: z.array(ReactionSummarySchema).max(MAX_REACTION_SUMMARIES),
  reply_excerpt: z.string().max(TEAM_MAX_EXCERPT_CHARS).nullable(),
  reply_restricted: z.boolean(),
}).strict();
export type MessageView = z.infer<typeof MessageViewSchema>;
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
