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
/** Reserved author id of @MARS answers; never a team member, never authenticable. */
export const MARS_AGENT_USER_ID = "mars";
export const AGENT_MAX_MESSAGES = 50;
export const AGENT_MAX_IDEMPOTENCY_KEY_CHARS = 128;

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

/** `user` text, an @MARS `agent` answer, or a `result_card` share (PR 6). */
export const MessageKindSchema = z.enum(["user", "agent", "result_card"]);
export type MessageKind = z.infer<typeof MessageKindSchema>;

export const MessageSchema = z
  .object({
    message_id: id,
    conversation_id: id,
    author_id: id,
    /** `agent` messages are @MARS answers authored by `MARS_AGENT_USER_ID`; clients render `agent` and `result_card` differently. */
    kind: MessageKindSchema,
    /** Provenance of an `agent` message: the `AgentRequest` it answers. */
    agent_request_id: id.nullable(),
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
    /** Only `result_card` messages carry the `ResultShare` the requester published. */
    payload: z.lazy(() => ResultShareSchema).optional(),
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

export const TeamDeliveryEventKindSchema = z.enum([
  "message",
  "membership",
  /** An existing message was edited or deleted; `message_seq`/`message_id` name it. */
  "edit",
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
// Code references (Team Chat PR 4, implemented in `@mars/team` + `@mars/code-refs`),
// @MARS request/preview schemas (PR 5, live in `@mars/team` agent.*) and schemas
// reserved for later Team Chat PRs (task links, result shares). Exported so field
// names are fixed now.
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

export const AgentRequestStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
  /** Finished, but the audience check at publish time failed: stored, never posted. */
  "restricted",
]);
export type AgentRequestStatus = z.infer<typeof AgentRequestStatusSchema>;

/** A context item that `scanThreat` rejected; its content was replaced by "[omitted: flagged]". */
export const AgentFlaggedItemSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("message"), message_id: id, threat: id }).strict(),
  z
    .object({ kind: z.literal("reference"), reference_id: id, threat: id })
    .strict(),
]);
export type AgentFlaggedItem = z.infer<typeof AgentFlaggedItemSchema>;

/** Citations resolve only to a frozen `{message_id, seq}` or a supplied reference id. */
export const AgentCitationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("message"),
      message_id: id,
      seq: z.number().int().positive(),
    })
    .strict(),
  z.object({ kind: z.literal("reference"), reference_id: id }).strict(),
]);
export type AgentCitation = z.infer<typeof AgentCitationSchema>;

/** One row of the context list a client shows before `agent.request`. */
export const AgentPreviewItemSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("message"),
      message_id: id,
      seq: z.number().int().positive(),
      body_sha256: sha256,
      bytes: z.number().int().nonnegative(),
      flagged: id.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("reference"),
      reference_id: id,
      bytes: z.number().int().nonnegative(),
      flagged: id.nullable(),
    })
    .strict(),
]);
export type AgentPreviewItem = z.infer<typeof AgentPreviewItemSchema>;

export const AgentModelChoiceSchema = z
  .object({ model_id: id, tier: z.literal("free") })
  .strict();

export const AgentPreviewSchema = z
  .object({
    conversation_id: id,
    audience: z.literal("conversation"),
    items: z
      .array(AgentPreviewItemSchema)
      .max(AGENT_MAX_MESSAGES + TEAM_MAX_REFERENCES),
    /** Active participants at preview time; every one of them must be able to read every reference. */
    participant_count: z.number().int().positive(),
    /** References at least one participant may not read; `agent.request` refuses while non-empty. */
    restricted_reference_ids: z.array(id).max(TEAM_MAX_REFERENCES),
    model: AgentModelChoiceSchema,
    /** sha256 of the canonical JSON of this record without `preview_sha256`; `agent.request` must echo it. */
    preview_sha256: sha256,
  })
  .strict();
export type AgentPreview = z.infer<typeof AgentPreviewSchema>;

export const AgentRequestSchema = z
  .object({
    request_id: id,
    team_id: id,
    conversation_id: id,
    requester_id: id,
    idempotency_key: z.string().min(1).max(AGENT_MAX_IDEMPOTENCY_KEY_CHARS),
    audience: z.literal("conversation"),
    /** Exact message versions at request time; a later edit or delete never changes them. */
    messages: z.array(provenanceEntry).max(AGENT_MAX_MESSAGES),
    reference_ids: z.array(id).max(TEAM_MAX_REFERENCES),
    preview_sha256: sha256,
    model_id: id,
    status: AgentRequestStatusSchema,
    flagged: z.array(AgentFlaggedItemSchema),
    citations: z.array(AgentCitationSchema),
    dropped_citations: z.number().int().nonnegative(),
    /** Fixed reason code for `failed`/`restricted`; never free text. */
    reason_code: id.nullable(),
    answer: z
      .object({ message_id: id, evidence: artifactRef.nullable() })
      .strict()
      .nullable(),
    created_at: timestamp,
    updated_at: timestamp,
  })
  .strict();
export type AgentRequest = z.infer<typeof AgentRequestSchema>;

export const TASK_LINK_MAX_MESSAGES = 50;
export const TASK_LINK_LAUNCH_KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
export const TaskLinkStatusSchema = z.enum([
  "draft",
  "confirmed",
  "created",
  "shared",
  "abandoned",
]);
export type TaskLinkStatus = z.infer<typeof TaskLinkStatusSchema>;

/** What the requester chose to run against; opaque to the team service. */
export const TaskLinkTargetSchema = z
  .object({
    repo_id: id.nullable(),
    base_revision: z.string().min(1).max(256).nullable(),
  })
  .strict();
export type TaskLinkTarget = z.infer<typeof TaskLinkTargetSchema>;

/** The requester's binding to their own workbench; never shown to other members. */
export const TaskLinkWorkbenchSchema = z
  .object({ scope: scope, task_id: id, request_id: id })
  .strict();
export type TaskLinkWorkbench = z.infer<typeof TaskLinkWorkbenchSchema>;

/**
 * Chat-side record of a "Start task" handoff. The team service stores ids
 * only: the workbench owns the task, the workspace and the evidence.
 * `provenance` is frozen at draft time (message `seq` + `body_sha256`), so a
 * later edit or deletion never changes what the task was started from.
 */
export const TaskLinkSchema = z
  .object({
    link_id: id,
    team_id: id,
    conversation_id: id,
    requester_id: id,
    launch_key: z.string().regex(TASK_LINK_LAUNCH_KEY_PATTERN),
    provenance: z.array(provenanceEntry).max(TASK_LINK_MAX_MESSAGES),
    reference_ids: z.array(id).max(TEAM_MAX_REFERENCES),
    target: TaskLinkTargetSchema.nullable(),
    workbench: TaskLinkWorkbenchSchema.nullable(),
    task_revision: revision.nullable(),
    status: TaskLinkStatusSchema,
    created_at: timestamp,
    updated_at: timestamp,
  })
  .strict();
export type TaskLink = z.infer<typeof TaskLinkSchema>;

/** The link as every other conversation member sees it: no launch key, no workbench ids, no target. */
export const TaskLinkSummarySchema = TaskLinkSchema.omit({
  launch_key: true,
  target: true,
  workbench: true,
}).strict();
export type TaskLinkSummary = z.infer<typeof TaskLinkSummarySchema>;

export const TaskLinkViewSchema = z.discriminatedUnion("view", [
  z.object({ view: z.literal("requester"), link: TaskLinkSchema }).strict(),
  z.object({ view: z.literal("member"), link: TaskLinkSummarySchema }).strict(),
]);
export type TaskLinkView = z.infer<typeof TaskLinkViewSchema>;

// ---------------------------------------------------------------------------
// Result shares. The evidence below is the caller's own `tasks.evidence`
// result from `@mars/workbench` (`EvidenceResultSchema`), forwarded verbatim by
// the client; the team service never talks to a workbench and cannot verify
// it, so a card records who attested it and binds to the exact candidate.
// ---------------------------------------------------------------------------

export const SHARE_MAX_SUMMARY_CHARS = 2000;
export const SHARE_MAX_VERIFY_EVENT_IDS = 8;
export const SHARE_MAX_EVIDENCE_RECORDS = 1000;

export const EvidenceVerdictSchema = z.enum([
  "pass",
  "fail",
  "inconclusive",
  "error",
]);
export const EvidenceAssuranceSchema = z.enum([
  "none",
  "visual_advisory",
  "deterministic_local",
  "isolated_local",
  "remote_attested",
]);

/** Mirror of `@mars/workbench` `EvidenceRecordSchema` (additive change, Team Chat PR 6). */
export const SharedEvidenceRecordSchema = z
  .object({
    event_id: id,
    verdict: EvidenceVerdictSchema,
    assurance: EvidenceAssuranceSchema,
    verified: z.boolean(),
    contract_id: id.optional(),
    contract_digest: z.string().min(1).max(256).optional(),
    recorded_at: z.string().datetime(),
    workspace_id: id.nullable(),
    workspace_revision: id.nullable(),
    diff_sha256: sha256.nullable(),
    stale: z.boolean(),
  })
  .strict()
  .refine((record) => !record.verified || record.verdict === "pass", {
    message: "Only a passed verdict may be verified",
  });
export type SharedEvidenceRecord = z.infer<typeof SharedEvidenceRecordSchema>;

/** Mirror of `@mars/workbench` `EvidenceResultSchema` (`tasks.evidence`). */
export const SharedEvidenceSchema = z
  .object({
    task_revision: revision,
    workspace: WorkspaceRefSchema,
    diff_sha256: sha256,
    verify_records: z
      .array(SharedEvidenceRecordSchema)
      .max(SHARE_MAX_EVIDENCE_RECORDS),
  })
  .strict();
export type SharedEvidence = z.infer<typeof SharedEvidenceSchema>;

export const ShareSelectionSchema = z
  .object({
    summary: z.string().max(SHARE_MAX_SUMMARY_CHARS),
    include_diff_digest: z.boolean(),
    verify_event_ids: z.array(id).max(SHARE_MAX_VERIFY_EVENT_IDS),
    /** Artifact shares are gated on a later PR; any entry answers `unavailable`. */
    artifacts: z.array(artifactRef).max(16).optional(),
  })
  .strict();
export type ShareSelection = z.infer<typeof ShareSelectionSchema>;

/** Why a card is not verified; `null` only when `verified` is true. */
export const ShareUnverifiedReasonSchema = z.enum([
  "failed",
  "skipped",
  "inconclusive",
  "stale",
  "missing",
]);
export type ShareUnverifiedReason = z.infer<typeof ShareUnverifiedReasonSchema>;

/** Bounded copy of a selected verify record as the requester attested it. */
export const ShareVerifyRecordSchema = z
  .object({
    event_id: id,
    verdict: EvidenceVerdictSchema,
    assurance: EvidenceAssuranceSchema,
    verified: z.boolean(),
    stale: z.boolean(),
    recorded_at: z.string().datetime(),
  })
  .strict();

/**
 * Deterministic card content: everything `shares.preview` shows and
 * `shares.create` publishes. `preview_sha256` is the SHA-256 of its canonical
 * JSON, so a card can only be posted exactly as previewed. Run status,
 * verification verdict, export status and Git status stay separate fields.
 */
export const ResultCardSchema = z
  .object({
    link_id: id,
    requester_id: id,
    /** The team service cannot observe a workbench; the requester vouches. */
    attested_by: id,
    summary: z.string().max(SHARE_MAX_SUMMARY_CHARS),
    run_status: taskStatus,
    verified: z.boolean(),
    verified_reason: ShareUnverifiedReasonSchema.nullable(),
    task_revision: revision,
    workspace: WorkspaceRefSchema,
    /** Null when the requester chose not to publish the digest; the service still binds to it. */
    diff_sha256: sha256.nullable(),
    evidence_event_id: id.nullable(),
    /** SHA-256 of the canonical `tasks.evidence` result the card was built from. */
    evidence_sha256: sha256,
    verify_records: z
      .array(ShareVerifyRecordSchema)
      .max(SHARE_MAX_VERIFY_EVENT_IDS),
    /** Patch/check artifacts are not exportable to chat until the artifact access gate lands. */
    export_status: z.enum(["not_exported"]),
    /** The service cannot observe git. */
    git_status: z.enum(["unknown", "clean", "dirty"]),
  })
  .strict();
export type ResultCard = z.infer<typeof ResultCardSchema>;

export const SharePreviewSchema = z
  .object({ preview_sha256: sha256, card: ResultCardSchema })
  .strict();
export type SharePreview = z.infer<typeof SharePreviewSchema>;

/**
 * A posted card. `stale` / `superseded_by` are overlaid from the share
 * binding at read time: a later share for the same link with a different
 * `diff_sha256` marks earlier cards stale ("candidate changed") and points at
 * the newer card; the posted content itself never changes.
 */
export const ResultShareSchema = ResultCardSchema.extend({
  share_id: id,
  message_id: id,
  preview_sha256: sha256,
  stale: z.boolean(),
  superseded_by: id.nullable(),
  created_at: timestamp,
}).strict();
export type ResultShare = z.infer<typeof ResultShareSchema>;
