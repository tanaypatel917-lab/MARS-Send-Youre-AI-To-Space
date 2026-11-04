import {
  ConversationSchema,
  MessageSchema,
  ParticipantSchema,
  ReactionSummarySchema,
  ReferenceChipSchema,
  TEAM_MAX_EMOJI_CHARS,
  TEAM_MAX_EXCERPT_CHARS,
  TEAM_MAX_REACTION_SUMMARIES,
  TEAM_MAX_REFERENCES,
  TEAM_MAX_SEARCH_QUERY_CHARS,
  TeamDeliveryEventSchema,
  TeamMemberStateSchema,
  TeamRoleSchema,
} from "@mars/contracts";
import { z } from "zod";

/**
 * Client-side mirror of the `@mars/team` RPC surface (`packages/team/src/
 * protocol.ts` on `main`, PR 2 + PR 3 service half + PR 4). The extension
 * cannot import `@mars/team` itself (it pulls in `bun:sqlite`), so the
 * request/result shapes are re-stated here over the shared `@mars/contracts`
 * records and every response is validated before it reaches the controller.
 * `team.describe().capabilities` still gates reactions/search/stream so a
 * server built without them degrades to host-side behaviour instead of
 * failing.
 */
export const TEAM_RPC_METHODS = {
  describe: "team.describe",
  list: "conversations.list",
  open: "conversations.open",
  markRead: "conversations.mark_read",
  pin: "conversations.pin",
  send: "messages.send",
  history: "messages.history",
  poll: "events.poll",
  /** `{ message_id, emoji, on }` → `{ message_id, emoji, count, reacted }`. */
  reactionsSet: "reactions.set",
  /** `{ query (2..200), conversation_id?, limit ≤ 50, cursor? }` → `{ hits, next_cursor }`. */
  search: "messages.search",
  /** Body of `POST /v1/stream` (same envelope): `{ cursors }` → `text/event-stream`. */
  stream: "events.stream",
} as const;
export type TeamRpcMethod =
  (typeof TEAM_RPC_METHODS)[keyof typeof TEAM_RPC_METHODS];

/** `POST /v1/stream`: the RPC envelope with `events.stream`, answering `text/event-stream` of `TeamDeliveryEvent`. */
export const TEAM_STREAM_PATH = "/v1/stream";

export const TEAM_SCHEMA_VERSION = 1 as const;
export const MAX_HISTORY_LIMIT = 200;
export const MAX_POLL_LIMIT = 1000;
export const MAX_POLL_CURSORS = 50;
export const MAX_SEARCH_LIMIT = 50;
export const MIN_SEARCH_QUERY_CHARS = 2;
export const MAX_SEARCH_QUERY_CHARS = TEAM_MAX_SEARCH_QUERY_CHARS;
export const MAX_EMOJI_CHARS = TEAM_MAX_EMOJI_CHARS;
export const MAX_EXCERPT_CHARS = TEAM_MAX_EXCERPT_CHARS;
const MAX_SEARCH_CURSOR_CHARS = 512;

const id = z.string().min(1);
const seq = z.number().int().nonnegative();

export const TeamContextSchema = z
  .object({
    schema_version: z.literal(TEAM_SCHEMA_VERSION),
    team_id: id,
    request_id: id,
  })
  .strict();
export type TeamContext = z.infer<typeof TeamContextSchema>;

/**
 * `team.describe().capabilities` as `main` ships it (`references` since
 * PR 4), accepting any further boolean flag so an additive capability never
 * makes the inbox unusable.
 */
export const TeamCapabilitiesSchema = z
  .object({
    stream: z.boolean(),
    reactions: z.boolean(),
    search: z.boolean(),
    references: z.boolean().optional(),
  })
  .catchall(z.boolean());

export const TeamDescribeResultSchema = z
  .object({
    team_id: id,
    user_id: id,
    role: TeamRoleSchema,
    /** PR 7 kill switch; absent on older servers means enabled. When false every other method answers `unavailable`. */
    enabled: z.boolean().optional(),
    limits: z.record(z.number().int().nonnegative()),
    capabilities: TeamCapabilitiesSchema,
  })
  .strict();
export type TeamDescribeResult = z.infer<typeof TeamDescribeResultSchema>;

export const ConversationMemberSchema = z
  .object({ user_id: id, state: TeamMemberStateSchema, joined_seq: seq })
  .strict();
export type ConversationMember = z.infer<typeof ConversationMemberSchema>;

/** `conversations.open` view. */
export const ConversationViewSchema = z
  .object({
    conversation: ConversationSchema,
    participant: ParticipantSchema,
    members: z.array(ConversationMemberSchema).max(256),
  })
  .strict();
export type ConversationView = z.infer<typeof ConversationViewSchema>;

/**
 * `conversations.list` item: the view plus per-participant counters. The
 * counters are optional so a service built before #64 still lists; the
 * adapter then falls back to its cache-based count.
 */
export const ConversationListItemSchema = ConversationViewSchema.extend({
  /** Messages after the caller's `read_seq` not authored by the caller. */
  unread_count: seq.optional(),
  last_message_at: z.string().datetime({ offset: true }).nullable().optional(),
}).strict();
export type ConversationListItem = z.infer<typeof ConversationListItemSchema>;
export const ConversationListSchema = z
  .array(ConversationListItemSchema)
  .max(10_000);

export type ReactionSummary = z.infer<typeof ReactionSummarySchema>;

/**
 * `messages.history` / `messages.send` item: the stored record plus the
 * viewer's chips, reaction summaries and a bounded reply excerpt (`null`
 * with `reply_restricted: true` when the target predates the join point).
 * The additions are optional so a pre-#64/#66 service still works: without
 * chips every `reference_id` renders restricted, without summaries there
 * are no reactions, without an excerpt the cached same-conversation target
 * is used.
 */
export const MessageViewSchema = MessageSchema.extend({
  references: z.array(ReferenceChipSchema).max(TEAM_MAX_REFERENCES).optional(),
  reactions: z
    .array(ReactionSummarySchema)
    .max(TEAM_MAX_REACTION_SUMMARIES)
    .optional(),
  reply_excerpt: z.string().max(TEAM_MAX_EXCERPT_CHARS).nullable().optional(),
  reply_restricted: z.boolean().optional(),
}).strict();
export type MessageView = z.infer<typeof MessageViewSchema>;
export const MessageListSchema = z
  .array(MessageViewSchema)
  .max(MAX_HISTORY_LIMIT);

/** `reactions.set` result: the state of that key after the call. */
export const ReactionStateSchema = z
  .object({
    message_id: id,
    emoji: z.string().min(1).max(MAX_EMOJI_CHARS),
    count: seq,
    reacted: z.boolean(),
  })
  .strict();
export type ReactionState = z.infer<typeof ReactionStateSchema>;

/** `messages.search` hit: a bounded excerpt, never the full body. */
export const SearchHitSchema = z
  .object({
    conversation_id: id,
    message_id: id,
    seq: z.number().int().positive(),
    author_id: id,
    created_at: z.string().datetime({ offset: true }),
    excerpt: z.string().max(MAX_EXCERPT_CHARS),
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
export type SearchResponse = z.infer<typeof SearchResultSchema>;

/** Outbox metadata (never a body): `message`, `membership` or `reaction`. */
export const TeamEventSchema = TeamDeliveryEventSchema;
export type TeamEvent = z.infer<typeof TeamEventSchema>;
export const EventListSchema = z.array(TeamEventSchema).max(MAX_POLL_LIMIT);

/** `event: close` frame payload before the server ends a stream on purpose. */
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

export const PollCursorSchema = z
  .object({ conversation_id: id, after_event_seq: seq })
  .strict();
export type PollCursor = z.infer<typeof PollCursorSchema>;

export const ParticipantResultSchema = ParticipantSchema;
