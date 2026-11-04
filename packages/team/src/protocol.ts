import {
  ConversationSchema,
  MessageSchema,
  ParticipantSchema,
  ScopeSchema,
  SharedEvidenceSchema,
  ShareSelectionSchema,
  TASK_LINK_MAX_MESSAGES,
  TaskLinkSchema,
  TaskStatusSchema,
  TEAM_MAX_BODY_CHARS,
  TEAM_MAX_CLIENT_MESSAGE_ID_CHARS,
  TEAM_MAX_REFERENCES,
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
 * TODO(PR 3): `events.stream` (SSE), `reactions.set`, `messages.search`.
 * Task links (`tasks.link_*`) and result shares (`shares.*`) are the Team Chat
 * PR 6 chat half; the service stores workbench ids and cards only and never
 * calls a workbench itself.
 */
const id = z.string().min(1).max(256);
const seq = z.number().int().nonnegative();
const empty = z.object({}).strict();
const conversationId = z.object({ conversation_id: id }).strict();

export const MAX_GROUP_MEMBER_IDS = TEAM_MAX_GROUP_SIZE;
export const MAX_POLL_CURSORS = 50;
export const MAX_HISTORY_LIMIT = 200;
export const MAX_POLL_LIMIT = 1000;

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

export const ConversationListSchema = z
  .array(ConversationViewSchema)
  .max(10_000);
export const MessageListSchema = z.array(MessageSchema).max(MAX_HISTORY_LIMIT);
export const EventListSchema = z
  .array(TeamDeliveryEventSchema)
  .max(MAX_POLL_LIMIT);

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
