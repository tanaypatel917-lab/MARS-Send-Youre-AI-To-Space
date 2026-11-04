import {
  ConversationSchema,
  MessageSchema,
  ParticipantSchema,
  ReferenceChipSchema,
  TEAM_MAX_REFERENCES,
  TeamMemberStateSchema,
  TeamRoleSchema,
} from "@mars/contracts";
import { z } from "zod";

/**
 * Client-side mirror of the `@mars/team` RPC surface. The extension cannot
 * import `@mars/team` itself (it pulls in `bun:sqlite`), so the result shapes
 * are re-stated here over the shared `@mars/contracts` records and every
 * response is validated before it reaches the controller.
 *
 * Methods marked "expected" are the PR 3 service half (PR #64) that is not
 * on `main` yet; `team.describe().capabilities` says whether the server has
 * them and the adapters fall back to host-side behaviour when it does not.
 * The result shapes below accept both today's records and the PR 3 additive
 * fields (`unread_count`, reaction summaries, `reply_excerpt`), so the same
 * client talks to either server.
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
  /** Expected: `{ message_id, emoji, on }` → `{ message_id, emoji, count, reacted }`. */
  reactionsSet: "reactions.set",
  /** Expected: `{ query (2..200), conversation_id?, limit ≤ 50, cursor? }` → `{ hits, next_cursor }`. */
  search: "messages.search",
  /** Expected: body of `POST /v1/stream` (same envelope), `{ cursors }` → `text/event-stream`. */
  stream: "events.stream",
} as const;
export type TeamRpcMethod =
  (typeof TEAM_RPC_METHODS)[keyof typeof TEAM_RPC_METHODS];

/** Expected: `POST /v1/stream` with `{ cursors }`, answering `text/event-stream` of `TeamDeliveryEvent`. */
export const TEAM_STREAM_PATH = "/v1/stream";

export const TEAM_SCHEMA_VERSION = 1 as const;
export const MAX_HISTORY_LIMIT = 200;
export const MAX_POLL_LIMIT = 1000;
export const MAX_POLL_CURSORS = 50;
export const MAX_SEARCH_LIMIT = 50;
export const MIN_SEARCH_QUERY_CHARS = 2;
export const MAX_SEARCH_QUERY_CHARS = 200;
export const MAX_EMOJI_CHARS = 32;
export const MAX_EXCERPT_CHARS = 200;
const MAX_REACTION_SUMMARIES = 256;
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
 * Known capabilities plus any further boolean flag a newer server adds
 * (`references` since PR 4): an additive capability must never make the
 * inbox unusable.
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
    limits: z.record(z.number().int().nonnegative()),
    capabilities: TeamCapabilitiesSchema,
  })
  .strict();
export type TeamDescribeResult = z.infer<typeof TeamDescribeResultSchema>;

export const ConversationMemberSchema = z
  .object({ user_id: id, state: TeamMemberStateSchema, joined_seq: seq })
  .strict();
export type ConversationMember = z.infer<typeof ConversationMemberSchema>;

/** `conversations.open` view; `conversations.list` items add the PR 3 counters. */
export const ConversationViewSchema = z
  .object({
    conversation: ConversationSchema,
    participant: ParticipantSchema,
    members: z.array(ConversationMemberSchema).max(256),
    unread_count: seq.optional(),
    last_message_at: z
      .string()
      .datetime({ offset: true })
      .nullable()
      .optional(),
  })
  .strict();
export type ConversationView = z.infer<typeof ConversationViewSchema>;

export const ConversationListSchema = z
  .array(ConversationViewSchema)
  .max(10_000);

/** Per-message aggregate: counts only, never who reacted. */
export const ReactionSummarySchema = z
  .object({
    emoji: z.string().min(1).max(MAX_EMOJI_CHARS),
    count: z.number().int().positive(),
    reacted: z.boolean(),
  })
  .strict();
export type ReactionSummary = z.infer<typeof ReactionSummarySchema>;

/** `messages.history` item: the record on `main`, plus the PR 3 additive fields when present. */
export const MessageViewSchema = MessageSchema.extend({
  /** Per-viewer chips from the PR 4 server; absent on the PR 2 record. */
  references: z.array(ReferenceChipSchema).max(TEAM_MAX_REFERENCES).optional(),
  reactions: z
    .array(ReactionSummarySchema)
    .max(MAX_REACTION_SUMMARIES)
    .optional(),
  reply_excerpt: z.string().max(MAX_EXCERPT_CHARS).nullable().optional(),
  reply_restricted: z.boolean().optional(),
}).strict();
export type MessageView = z.infer<typeof MessageViewSchema>;
export const MessageListSchema = z
  .array(MessageViewSchema)
  .max(MAX_HISTORY_LIMIT);

/** Expected `reactions.set` result: the state of that key after the call. */
export const ReactionStateSchema = z
  .object({
    message_id: id,
    emoji: z.string().min(1).max(MAX_EMOJI_CHARS),
    count: seq,
    reacted: z.boolean(),
  })
  .strict();
export type ReactionState = z.infer<typeof ReactionStateSchema>;

/** Expected `messages.search` hit: a bounded excerpt, never the full body. */
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

/** Outbox metadata (never a body); `reaction` events arrive once PR 3 lands. */
export const TeamEventSchema = z
  .object({
    conversation_id: id,
    event_seq: z.number().int().positive(),
    kind: z.enum(["message", "membership", "reaction"]),
    message_seq: seq,
    message_id: id.nullable(),
    revision: z.number().int().nonnegative(),
  })
  .strict();
export type TeamEvent = z.infer<typeof TeamEventSchema>;
export const EventListSchema = z.array(TeamEventSchema).max(MAX_POLL_LIMIT);

/** Expected `event: close` frame payload before the server ends a stream on purpose. */
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
