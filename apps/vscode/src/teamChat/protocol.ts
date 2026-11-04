import {
  ConversationSchema,
  MessageSchema,
  ParticipantSchema,
  ReactionSchema,
  TeamDeliveryEventSchema,
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
 * Methods marked "expected" are the PR 3 service half that is not on `main`
 * yet; `team.describe().capabilities` says whether the server has them and
 * the adapters fall back to the fixture behaviour when it does not.
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
  /** Expected: `{ message_id, emoji, on }` → `Reaction[]` for that message. */
  reactionsSet: "reactions.set",
  /** Expected: `{ query, conversation_id?, limit? }` → `Message[]` (membership-filtered). */
  search: "messages.search",
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

export const TeamCapabilitiesSchema = z
  .object({ stream: z.boolean(), reactions: z.boolean(), search: z.boolean() })
  .strict();

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

export const ConversationViewSchema = z
  .object({
    conversation: ConversationSchema,
    participant: ParticipantSchema,
    members: z.array(ConversationMemberSchema).max(256),
  })
  .strict();
export type ConversationView = z.infer<typeof ConversationViewSchema>;

export const ConversationListSchema = z
  .array(ConversationViewSchema)
  .max(10_000);
export const MessageListSchema = z.array(MessageSchema).max(MAX_HISTORY_LIMIT);
export const EventListSchema = z
  .array(TeamDeliveryEventSchema)
  .max(MAX_POLL_LIMIT);
export const ReactionListSchema = z.array(ReactionSchema).max(10_000);
export const SearchListSchema = z.array(MessageSchema).max(MAX_SEARCH_LIMIT);

export const PollCursorSchema = z
  .object({ conversation_id: id, after_event_seq: seq })
  .strict();
export type PollCursor = z.infer<typeof PollCursorSchema>;

export const ParticipantResultSchema = ParticipantSchema;
