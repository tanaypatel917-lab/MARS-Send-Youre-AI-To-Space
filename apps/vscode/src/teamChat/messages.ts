import {
  type AgentPreviewView,
  type AgentRequestView,
  type ConversationSummary,
  type EvidenceSharePreviewView,
  type EvidenceShareView,
  MAX_MESSAGE_CHARS,
  MAX_REFERENCES_PER_MESSAGE,
  type MentionIndex,
  type MessageView,
  type PathSearchMatch,
  ReactionEmojiSchema,
  ReferenceInputSchema,
  type ReferencePreview,
  type SearchResult,
  type TaskLinkDraftView,
  type TaskLinkView,
  type TeamCapabilities,
  type TeamServiceLabel,
  type UserView,
} from "@mars/team-chat";
import { z } from "zod";
import { MAX_SEARCH_QUERY_CHARS } from "./protocol";

const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);
const cursor = z.string().min(1).max(64);
const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

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
  /** Open a search hit: select its conversation, load history down to it and highlight it. */
  z
    .object({
      type: z.literal("openSearchHit"),
      conversationId: id,
      messageId: id,
      sequence,
    })
    .strict(),
  /** FIXTURE only: switch the fixture viewer to demonstrate membership filtering; ignored by the service. */
  z
    .object({ type: z.literal("fixtureSwitchViewer"), userId: id })
    .strict(),
  /** Search file paths in an accessible repo at a pinned commit for `@` code-reference autocomplete. */
  z
    .object({
      type: z.literal("searchPaths"),
      repoId: id,
      commitSha: z.string().regex(/^[0-9a-f]{40}$/),
      query: z.string().max(256),
      limit: z.number().int().min(1).max(200).optional(),
    })
    .strict(),
  /** `@MARS` composer actions: preview context, submit request, cancel, inspect, or clear. */
  z
    .object({
      type: z.literal("agentPreview"),
      conversationId: id,
      messageIds: z.array(id).max(200),
      referenceIds: z.array(id).max(MAX_REFERENCES_PER_MESSAGE),
      draft: z
        .object({
          clientMessageId: id,
          body: z.string().max(MAX_MESSAGE_CHARS),
          replyTo: id.nullable(),
          references: z
            .array(ReferenceInputSchema)
            .max(MAX_REFERENCES_PER_MESSAGE),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("agentRequest"),
      conversationId: id,
      messageIds: z.array(id).max(200),
      referenceIds: z.array(id).max(MAX_REFERENCES_PER_MESSAGE),
      idempotencyKey: id,
      previewSha256: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .strict(),
  z.object({ type: z.literal("agentCancel"), requestId: id }).strict(),
  z.object({ type: z.literal("agentInspect"), requestId: id }).strict(),
  z.object({ type: z.literal("clearAgent") }).strict(),
  /** Task-link card actions: draft, confirm, mark created, inspect, or clear. */
  z
    .object({
      type: z.literal("taskLinkDraft"),
      conversationId: id,
      messageIds: z.array(id).max(200),
      referenceIds: z.array(id).max(MAX_REFERENCES_PER_MESSAGE),
    })
    .strict(),
  z
    .object({
      type: z.literal("taskLinkConfirm"),
      linkId: id,
      workbench: z
        .object({
          scope: z.record(z.unknown()),
          task_id: id,
          request_id: id,
        })
        .strict(),
      target: z
        .object({
          repo_id: id.optional(),
          base_revision: z.string().min(1).max(128).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("taskLinkCreated"),
      linkId: id,
      taskRevision: z.number().int().positive(),
    })
    .strict(),
  z.object({ type: z.literal("taskLinkInspect"), linkId: id }).strict(),
  z.object({ type: z.literal("clearTaskLink") }).strict(),
  /** Verified-evidence share card actions: preview, create (bound to preview_sha256), or clear. */
  z
    .object({
      type: z.literal("sharePreview"),
      linkId: id,
      evidence: z.record(z.unknown()),
      runStatus: z.string().min(1).max(64),
      selection: z
        .object({
          summary: z.string().min(1).max(4000),
          include_diff_digest: z.boolean(),
          verify_event_ids: z.array(id).max(100),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("shareCreate"),
      linkId: id,
      evidence: z.record(z.unknown()),
      runStatus: z.string().min(1).max(64),
      selection: z
        .object({
          summary: z.string().min(1).max(4000),
          include_diff_digest: z.boolean(),
          verify_event_ids: z.array(id).max(100),
        })
        .strict(),
      previewSha256: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .strict(),
  z.object({ type: z.literal("clearShare") }).strict(),
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
  | "unauthenticated"
  /** The host switched `team.enabled` off: polling stops until the user reconnects; nothing is deleted. */
  | "disabled";

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
  /** Message to scroll to and highlight (a search hit); cleared on the next selection. */
  highlight_message_id: string | null;
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
  path_search?: PathSearchMatch[];
  agent_preview?: AgentPreviewView | null;
  agent_request?: AgentRequestView | null;
  task_link_draft?: TaskLinkDraftView | null;
  task_link?: TaskLinkView | null;
  share_preview?: EvidenceSharePreviewView | null;
  share_result?: EvidenceShareView | null;
  notice: TeamChatNotice | null;
  search: SearchResult | null;
  announcement: TeamChatAnnouncement | null;
}

export type TeamChatHostMessage =
  | { type: "state"; state: TeamChatViewState }
  | { type: "focusComposer" };
