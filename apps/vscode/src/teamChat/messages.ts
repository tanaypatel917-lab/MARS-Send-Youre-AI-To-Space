import {
  type ConversationSummary,
  MAX_MESSAGE_CHARS,
  MAX_REFERENCES_PER_MESSAGE,
  type MentionIndex,
  type MessageView,
  ReactionEmojiSchema,
  ReferenceInputSchema,
  type ReferencePreview,
  type SearchResult,
  type TeamCapabilities,
  type TeamServiceLabel,
  type UserView,
} from "@mars/team-chat";
import { z } from "zod";

const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);
const cursor = z.string().min(1).max(64);
const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const MAX_SEARCH_QUERY_CHARS = 200;

/**
 * Messages the Team Chat webview may send. Anything else is dropped. The
 * viewer identity is never part of a request: the extension host decides who
 * the viewer is (today a fixture user; later a server-derived user id).
 */
export const TeamChatWebviewMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }).strict(),
  z
    .object({ type: z.literal("selectConversation"), conversationId: id })
    .strict(),
  z
    .object({ type: z.literal("loadOlder"), conversationId: id, cursor })
    .strict(),
  z
    .object({
      type: z.literal("send"),
      conversationId: id,
      clientMessageId: id,
      body: z.string().max(MAX_MESSAGE_CHARS),
      replyTo: id.nullable(),
      references: z.array(ReferenceInputSchema).max(MAX_REFERENCES_PER_MESSAGE),
    })
    .strict(),
  z.object({ type: z.literal("retrySend"), clientMessageId: id }).strict(),
  z.object({ type: z.literal("discardSend"), clientMessageId: id }).strict(),
  z
    .object({ type: z.literal("markRead"), conversationId: id, sequence })
    .strict(),
  z.object({ type: z.literal("togglePin"), conversationId: id }).strict(),
  z
    .object({
      type: z.literal("toggleReaction"),
      messageId: id,
      emoji: ReactionEmojiSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("openReference"),
      messageId: id,
      referenceId: id,
    })
    .strict(),
  z.object({ type: z.literal("closeReference") }).strict(),
  /**
   * Where the thread viewport is: the host advances the read cursor only
   * while the view is focused and scrolled to the bottom.
   */
  z
    .object({
      type: z.literal("viewport"),
      focused: z.boolean(),
      atBottom: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal("search"),
      query: z.string().min(1).max(MAX_SEARCH_QUERY_CHARS),
    })
    .strict(),
  z.object({ type: z.literal("clearSearch") }).strict(),
  /** FIXTURE only: switch the fixture viewer to demonstrate membership filtering; ignored by the service. */
  z
    .object({ type: z.literal("fixtureSwitchViewer"), userId: id })
    .strict(),
]);
export type TeamChatWebviewMessage = z.infer<
  typeof TeamChatWebviewMessageSchema
>;

export interface PendingSend {
  client_message_id: string;
  conversation_id: string;
  body: string;
  reference_count: number;
  reply_to: string | null;
  /** `conflict`: the same id was committed with another body; the draft must be edited and resent under a new id. */
  status: "pending" | "failed" | "conflict";
  reason: string | null;
}

export type TeamConnectionState =
  | "offline"
  | "connecting"
  | "live"
  | "polling"
  | "retrying"
  | "unauthenticated";

/** Content-free `aria-live` announcement; `seq` changes once per new announcement. */
export interface TeamChatAnnouncement {
  seq: number;
  text: string;
}

export interface SelectedConversation {
  conversation: ConversationSummary;
  messages: MessageView[];
  older_cursor: string | null;
  /** True when more history exists but the in-memory cap stops loading it; never treated as exhaustion. */
  older_blocked: boolean;
  /** First visible unread sequence when the conversation was opened; the divider stays put while reading. */
  divider_sequence: number | null;
}

export interface TeamChatNotice {
  kind: "info" | "error";
  text: string;
}

export interface TeamChatViewState {
  label: TeamServiceLabel;
  capabilities: TeamCapabilities;
  connection: TeamConnectionState;
  viewer: UserView;
  /** Fixture members selectable from the UI; always empty for the real service. */
  viewers: UserView[];
  conversations: ConversationSummary[];
  selected: SelectedConversation | null;
  pending: PendingSend[];
  panel: {
    message_id: string;
    reference_id: string;
    preview: ReferencePreview;
  } | null;
  mention_index: MentionIndex;
  notice: TeamChatNotice | null;
  search: SearchResult | null;
  announcement: TeamChatAnnouncement | null;
}

export type TeamChatHostMessage =
  | { type: "state"; state: TeamChatViewState }
  | { type: "focusComposer" };
