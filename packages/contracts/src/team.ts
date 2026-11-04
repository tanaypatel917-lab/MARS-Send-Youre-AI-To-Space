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
    /** Opaque reference ids (`Reference.reference_id`), author-supplied order. */
    reference_ids: z.array(id).max(TEAM_MAX_REFERENCES),
    created_at: timestamp,
    edited_at: timestamp.nullable(),
    deleted: z.boolean(),
  })
  .strict();
export type Message = z.infer<typeof MessageSchema>;

/**
 * Per-viewer rendering of one attached reference. `restricted` is the whole
 * chip for a conversation member without access to the referenced repo: no
 * path, label, SHA, range or size leaks. The chip is derived at read time and
 * is never part of the stored message record.
 */
export const ReferenceChipSchema = z.discriminatedUnion("restricted", [
  z.object({ reference_id: id, restricted: z.literal(true) }).strict(),
  z
    .object({
      reference_id: id,
      restricted: z.literal(false),
      repo_id: id,
      commit_sha: z.string().regex(/^[a-f0-9]{40}$/),
      path: z.string().min(1).max(1024),
      line_start: z.number().int().positive().nullable(),
      line_end: z.number().int().positive().nullable(),
    })
    .strict(),
]);
export type ReferenceChip = z.infer<typeof ReferenceChipSchema>;

/** A stored message as returned to one authenticated viewer. */
export const MessageViewSchema = MessageSchema.extend({
  references: z.array(ReferenceChipSchema).max(TEAM_MAX_REFERENCES),
}).strict();
export type MessageView = z.infer<typeof MessageViewSchema>;

export const ReactionSchema = z
  .object({ message_id: id, user_id: id, emoji: z.string().min(1).max(32) })
  .strict();
export type Reaction = z.infer<typeof ReactionSchema>;

export const TeamDeliveryEventKindSchema = z.enum(["message", "membership"]);
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
// Code references (Team Chat PR 4, implemented in `@mars/team` + `@mars/code-refs`)
// and schemas reserved for later Team Chat PRs (@MARS requests, task links,
// result shares). Exported so field names are fixed now.
// ---------------------------------------------------------------------------

export const WorkspaceRefSchema = z
  .object({ workspace_id: id, provider: id, revision: id })
  .strict();

/** Access state of one user on one registered repo; `removed` revokes. */
export const RepoAccessStateSchema = z.enum(["active", "removed"]);
export type RepoAccessState = z.infer<typeof RepoAccessStateSchema>;

/**
 * A repo the host registered for a team. `repo_id` is the opaque id the host
 * also registered in the `@mars/code-refs` registry; the team service never
 * stores or returns a filesystem path.
 */
export const RepoSchema = z
  .object({
    team_id: id,
    repo_id: id,
    label: z.string().min(1).max(TEAM_MAX_TITLE_CHARS),
    revision,
  })
  .strict();
export type Repo = z.infer<typeof RepoSchema>;

export const RepoAccessSchema = z
  .object({
    team_id: id,
    repo_id: id,
    user_id: id,
    state: RepoAccessStateSchema,
    revision,
  })
  .strict();
export type RepoAccess = z.infer<typeof RepoAccessSchema>;

/**
 * Immutable committed code reference (TEAM_CHAT_DISCOVERY.md section 4.1).
 * `reference_id` is `referenceDigest(...)` from `@mars/code-refs` over the
 * locator fields, so identical references dedupe per team. `blob_sha256` is
 * the SHA-256 of the resolved excerpt at creation time (`text_sha256` of the
 * `ok` resolution), null when the object resolved to a non-text state.
 * `@mars/code-refs` imports this schema; there is no second copy.
 */
export const GitRangeReferenceSchema = z
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
  .strict();
export type GitRangeReference = z.infer<typeof GitRangeReferenceSchema>;

/** Resolver states a stored reference can be in; `restricted` is viewer-side only. */
export const ReferencePreviewStateSchema = z.enum([
  "ok",
  "unavailable",
  "binary",
  "oversized",
  "is_directory",
  "unsupported_symlink",
  "unsupported_submodule",
  "range_out_of_bounds",
  "error",
]);
export type ReferencePreviewState = z.infer<typeof ReferencePreviewStateSchema>;

const previewLocator = {
  reference_id: id,
  repo_id: id,
  commit_sha: z.string().regex(/^[a-f0-9]{40}$/),
  path: z.string().min(1).max(1024),
  line_start: z.number().int().positive().nullable(),
  line_end: z.number().int().positive().nullable(),
};

/**
 * `references.resolve` result. A viewer without repo access receives exactly
 * `{ state: "restricted" }`; a nonmember receives `not_found` instead.
 */
export const ReferencePreviewSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("restricted") }).strict(),
  z
    .object({
      state: z.literal("ok"),
      ...previewLocator,
      text: z.string(),
      total_lines: z.number().int().nonnegative(),
      truncated: z.boolean(),
    })
    .strict(),
  ...ReferencePreviewStateSchema.options
    .filter((state) => state !== "ok")
    .map((state) =>
      z.object({ state: z.literal(state), ...previewLocator }).strict(),
    ),
]);
export type ReferencePreview = z.infer<typeof ReferencePreviewSchema>;

export const ReferenceSchema = z.discriminatedUnion("kind", [
  GitRangeReferenceSchema,
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
