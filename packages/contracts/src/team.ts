import { z } from "zod";
import {
  ArtifactRefSchema,
  SCHEMA_VERSION,
  ScopeSchema,
  TaskStatusSchema,
} from "./index";

/**
 * Team Chat records (`@mars/team`). The tenant is a `team`, never a
 * "workspace": `Scope.workspace_id` and `WorkspaceRef` already name a workbench
 * private copy. `user_id` is derived server-side from the authenticated
 * session and is never accepted from a client; `TeamContextSchema` therefore
 * carries only the tenant and the request id.
 */
// `index.ts` re-exports this file, so the shared schemas are referenced lazily
// to stay independent of module evaluation order.
const schemaVersion = z.lazy(() => z.literal(SCHEMA_VERSION));
const artifactRef = z.lazy(() => ArtifactRefSchema);
const scope = z.lazy(() => ScopeSchema);
const taskStatus = z.lazy(() => TaskStatusSchema);
const id = z.string().min(1).max(256);
const seq = z.number().int().nonnegative();
const revision = z.number().int().nonnegative();
const timestamp = z.string().datetime({ offset: true });
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const TEAM_MAX_TITLE_CHARS = 200;
export const TEAM_MAX_CLIENT_MESSAGE_ID_CHARS = 128;
export const TEAM_MAX_BODY_CHARS = 16_384;
export const TEAM_MAX_REFERENCES = 16;
export const TEAM_MAX_EMOJI_CHARS = 32;
export const TEAM_MAX_SEARCH_QUERY_CHARS = 200;
export const TEAM_MAX_EXCERPT_CHARS = 200;

export const TeamContextSchema = z
  .object({
    schema_version: schemaVersion,
    team_id: id,
    request_id: id,
  })
  .strict();
export type TeamContext = z.infer<typeof TeamContextSchema>;

export const TeamRoleSchema = z.enum(["admin", "member"]);
export type TeamRole = z.infer<typeof TeamRoleSchema>;
export const TeamMemberStateSchema = z.enum(["active", "removed"]);

export const TeamMembershipSchema = z
  .object({
    team_id: id,
    user_id: id,
    role: TeamRoleSchema,
    state: TeamMemberStateSchema,
    revision,
  })
  .strict();
export type TeamMembership = z.infer<typeof TeamMembershipSchema>;

export const ConversationKindSchema = z.enum(["dm", "group"]);
export type ConversationKind = z.infer<typeof ConversationKindSchema>;

export const ConversationSchema = z
  .object({
    conversation_id: id,
    team_id: id,
    kind: ConversationKindSchema,
    title: z.string().max(TEAM_MAX_TITLE_CHARS).nullable(),
    /** sha256 of the canonical sorted member pair; UNIQUE(team_id, dm_key) WHERE kind='dm'. */
    dm_key: sha256.nullable(),
    revision,
    last_seq: seq,
  })
  .strict();
export type Conversation = z.infer<typeof ConversationSchema>;

export const ParticipantSchema = z
  .object({
    conversation_id: id,
    user_id: id,
    /** `last_seq` at join time; the participant sees only messages with `seq > joined_seq`. */
    joined_seq: seq,
    state: TeamMemberStateSchema,
    pinned: z.boolean(),
    read_seq: seq,
  })
  .strict();
export type Participant = z.infer<typeof ParticipantSchema>;

export const MessageSchema = z
  .object({
    message_id: id,
    conversation_id: id,
    author_id: id,
    seq: z.number().int().positive(),
    client_message_id: z.string().min(1).max(TEAM_MAX_CLIENT_MESSAGE_ID_CHARS),
    body: z.string().max(TEAM_MAX_BODY_CHARS),
    body_sha256: sha256,
    reply_to: id.nullable(),
    /** Opaque reference ids; resolution is a later PR. */
    reference_ids: z.array(id).max(TEAM_MAX_REFERENCES),
    created_at: timestamp,
    edited_at: timestamp.nullable(),
    deleted: z.boolean(),
  })
  .strict();
export type Message = z.infer<typeof MessageSchema>;

export const ReactionSchema = z
  .object({
    message_id: id,
    user_id: id,
    emoji: z.string().min(1).max(TEAM_MAX_EMOJI_CHARS),
  })
  .strict();
export type Reaction = z.infer<typeof ReactionSchema>;

export const TeamDeliveryEventKindSchema = z.enum([
  "message",
  "membership",
  "reaction",
]);
/** Outbox row: generic metadata only, never a body. */
export const TeamDeliveryEventSchema = z
  .object({
    conversation_id: id,
    event_seq: z.number().int().positive(),
    kind: TeamDeliveryEventKindSchema,
    message_seq: seq,
    message_id: id.nullable(),
    revision,
  })
  .strict();
export type TeamDeliveryEvent = z.infer<typeof TeamDeliveryEventSchema>;

// ---------------------------------------------------------------------------
// Reserved for later Team Chat PRs (references, @MARS requests, task links,
// result shares). Exported so field names are fixed now; nothing uses them yet.
// ---------------------------------------------------------------------------

export const WorkspaceRefSchema = z
  .object({ workspace_id: id, provider: id, revision: id })
  .strict();

export const ReferenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("git_range"),
      reference_id: id,
      team_id: id,
      repo_id: id,
      commit_sha: z.string().regex(/^[a-f0-9]{40}$/),
      path: z.string().min(1).max(1024),
      line_start: z.number().int().positive().nullable(),
      line_end: z.number().int().positive().nullable(),
      blob_sha256: sha256.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("artifact"),
      reference_id: id,
      team_id: id,
      publisher_user_id: id,
      task_id: id,
      artifact: artifactRef,
    })
    .strict(),
]);
export type Reference = z.infer<typeof ReferenceSchema>;

const provenanceEntry = z
  .object({
    message_id: id,
    seq: z.number().int().positive(),
    body_sha256: sha256,
  })
  .strict();

export const AgentRequestSchema = z
  .object({
    request_id: id,
    team_id: id,
    conversation_id: id,
    requester_id: id,
    idempotency_key: z.string().min(1).max(128),
    messages: z.array(provenanceEntry).max(50),
    reference_ids: z.array(id).max(TEAM_MAX_REFERENCES),
    model_id: id,
    status: z.enum(["pending", "running", "completed", "failed", "cancelled"]),
    answer: z
      .object({ message_id: id, evidence: artifactRef.nullable() })
      .strict()
      .nullable(),
  })
  .strict();
export type AgentRequest = z.infer<typeof AgentRequestSchema>;

export const TaskLinkSchema = z
  .object({
    link_id: id,
    team_id: id,
    conversation_id: id,
    requester_id: id,
    launch_key: z.string().min(1).max(128),
    provenance: z.array(provenanceEntry),
    reference_ids: z.array(id),
    workbench: z
      .object({ scope: scope, task_id: id, request_id: id })
      .strict()
      .nullable(),
    status: z.enum(["draft", "confirmed", "created", "shared", "abandoned"]),
  })
  .strict();
export type TaskLink = z.infer<typeof TaskLinkSchema>;

export const ResultShareSchema = z
  .object({
    share_id: id,
    link_id: id,
    message_id: id,
    task_revision: revision,
    workspace: WorkspaceRefSchema,
    diff_sha256: sha256,
    evidence_event_id: id.nullable(),
    verified: z.boolean(),
    run_status: taskStatus,
    git_status: z.enum(["unknown", "clean", "dirty"]),
  })
  .strict();
export type ResultShare = z.infer<typeof ResultShareSchema>;
