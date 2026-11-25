import {
  ArtifactRefSchema,
  JournalEntryIdsSchema,
  RequiredCheckSchema,
  SCHEMA_VERSION,
  ScopeSchema,
  TaskSchema,
  VerificationViewSchema,
  WorkbenchDescribeFields,
  WorkbenchInspectFields,
  WorkspaceRefSchema,
} from "@mars/contracts";
import { z } from "zod";

export { WorkspaceRefSchema };

const id = z.string().min(1).max(256);
const revision = z.number().int().nonnegative();
const empty = z.object({}).strict();
const taskId = z.object({ task_id: id }).strict();
const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);
/**
 * Caller-chosen stable launch key for `tasks.create`: `(scope, launch_key)`
 * identifies one stored task, so a retry after a lost acknowledgement replays
 * it instead of creating a second task.
 */
export const LAUNCH_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;
export const LaunchKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(LAUNCH_KEY_PATTERN);
export interface CreateOptions {
  launch_key?: string;
}
export const ContextSchema = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    scope: ScopeSchema,
    request_id: id,
  })
  .strict();
export const ApprovalsSchema = z
  .object({ read: z.boolean(), write: z.boolean(), execute: z.boolean() })
  .strict();
export type Approvals = z.infer<typeof ApprovalsSchema>;
export const CheckpointRefSchema = z
  .object({
    checkpoint_id: id,
    workspace: WorkspaceRefSchema,
    artifact: ArtifactRefSchema,
  })
  .strict();
export const DescribeResultSchema = z
  .object({
    ...WorkbenchDescribeFields,
    scope: ScopeSchema,
    workspaceLabel: z.string().min(1).max(200),
    capabilities: z
      .object({ execute: z.boolean(), checkpoint: z.boolean() })
      .strict(),
  })
  .strict();
export type DescribeResult = z.infer<typeof DescribeResultSchema>;
export const InspectResultSchema = TaskSchema.extend(
  WorkbenchInspectFields,
).strict();
export type InspectResult = z.infer<typeof InspectResultSchema>;
export const DiffResultSchema = z
  .object({
    files: z
      .array(
        z
          .object({
            path: z.string().min(1).max(4096),
            status: z.enum(["added", "modified", "deleted"]),
            patch: z.string(),
          })
          .strict(),
      )
      .max(5000),
    /**
     * Canonical SHA-256 of the diff (see `diffDigest`). Optional on the wire
     * so older servers' results still validate; the host always sets it.
     * Additive change to the frozen protocol (Team Chat PR 6).
     */
    digest: sha256Hex.optional(),
  })
  .strict();
export type DiffResult = z.infer<typeof DiffResultSchema>;
export const EvidenceRecordSchema = z
  .object({
    event_id: id,
    verdict: z.enum(["pass", "fail", "inconclusive", "error"]),
    assurance: z.enum([
      "none",
      "visual_advisory",
      "deterministic_local",
      "isolated_local",
      "remote_attested",
    ]),
    /** Copied from the stored evidence record, never computed by the host. */
    verified: z.boolean(),
    contract_id: id.optional(),
    contract_digest: z.string().min(1).max(256).optional(),
    recorded_at: z.string().datetime(),
    /** Workspace the verifier inspected (a child's private copy differs from the task's); null if unknown. */
    workspace_id: id.nullable(),
    /** Provider revision stamped when the evidence was recorded; null if unknown. */
    workspace_revision: id.nullable(),
    /** Diff digest stamped when the evidence was recorded; null if unknown. */
    diff_sha256: sha256Hex.nullable(),
    /** True unless both stamps equal the current workspace revision and digest. */
    stale: z.boolean(),
    /** Error class that kept the host from binding the record; present only when binding failed. */
    binding_error: z
      .string()
      .regex(/^[A-Za-z0-9_.-]{1,64}$/)
      .optional(),
  })
  .strict()
  .refine((record) => !record.verified || record.verdict === "pass", {
    message: "Only a passed verdict may be verified",
  });
export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;
export const EvidenceResultSchema = z
  .object({
    task_revision: revision,
    workspace: WorkspaceRefSchema,
    diff_sha256: sha256Hex,
    verify_records: z.array(EvidenceRecordSchema).max(1000),
    /** Host required-check verdict, kept apart from Watch records; only when requested. */
    host_verification: VerificationViewSchema.optional(),
  })
  .strict();
export type EvidenceResult = z.infer<typeof EvidenceResultSchema>;
export const ArtifactDataSchema = z
  .object({
    data_base64: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/),
    media_type: z.string().min(1),
  })
  .strict();
export type ArtifactData = z.infer<typeof ArtifactDataSchema>;
export const StartParamsSchema = z
  .object({
    task_id: id,
    expected_revision: revision,
    approvals: ApprovalsSchema,
    model_id: id.optional(),
    /** Host-run checks fixed at launch, outside the model's control; absent means the run is never verified. */
    required_checks: z.array(RequiredCheckSchema).max(32).optional(),
  })
  .strict();
export type StartParams = z.infer<typeof StartParamsSchema>;

/**
 * Export names the candidate the client is looking at; the host refuses
 * with `conflict` when the workspace revision or the exact patch bytes moved.
 */
export const ExportParamsSchema = z
  .object({
    task_id: id,
    expected_revision: id,
    expected_patch_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    review_handoff: z.literal(true).optional(),
    review_destination: z.string().min(1).max(4096).optional(),
  })
  .strict();
export type ExportParams = z.infer<typeof ExportParamsSchema>;

// Views mirror what the memory store accepts; the transport's response cap bounds their size.
const timestamp = z.string().min(1);
const actor = z.string().min(1).max(128);
const reason = z.string().min(1).max(1024);
const opaque = z.string().min(1);
const MemoryEntryViewSchema = z
  .object({
    entry_id: opaque,
    scope: ScopeSchema,
    target: z.enum(["profile", "project"]),
    fact: z.string(),
    revision,
    source_event_ids: z.array(opaque),
    observed_at: timestamp,
    verified_at: timestamp.nullable(),
    supersedes: opaque.nullable(),
    deleted: z.boolean(),
  })
  .strict();
const MemoryOperationViewSchema = z.discriminatedUnion("operation", [
  z
    .object({ operation: z.literal("add"), entry: MemoryEntryViewSchema })
    .strict(),
  z
    .object({
      operation: z.literal("patch"),
      entry_id: opaque,
      fact: z.string(),
      source_event_ids: z.array(opaque),
    })
    .strict(),
  z.object({ operation: z.literal("remove"), entry_id: opaque }).strict(),
]);
export const MemoryProposalStatusSchema = z.enum([
  "pending",
  "accepted",
  "rejected",
  "reverted",
]);
/** A durable memory proposal as stored by the memory owner, including its audit trail. */
export const MemoryProposalViewSchema = z
  .object({
    proposal_id: opaque,
    scope: ScopeSchema,
    source: opaque,
    operations: z.array(MemoryOperationViewSchema).min(1),
    rationale: z.string(),
    expected_revision: revision,
    status: MemoryProposalStatusSchema,
    task_id: opaque.optional(),
    reason: z.string().optional(),
    submitted_at: timestamp,
    resolved_at: timestamp.optional(),
    resolved_by: opaque.optional(),
    applied_revision: revision.optional(),
    reverted_at: timestamp.optional(),
    reverted_by: opaque.optional(),
    reverted_revision: revision.optional(),
    revert_reason: z.string().optional(),
  })
  .strict();
export type MemoryProposalView = z.infer<typeof MemoryProposalViewSchema>;
export const MemoryProposalListParamsSchema = z
  .object({
    status: MemoryProposalStatusSchema.optional(),
    task_id: z.string().min(1).max(1024).optional(),
  })
  .strict();
export type MemoryProposalListParams = z.infer<
  typeof MemoryProposalListParamsSchema
>;
export const MemoryProposalAcceptParamsSchema = z
  .object({ proposal_id: id, resolved_by: actor.optional() })
  .strict();
export type MemoryProposalAcceptParams = z.infer<
  typeof MemoryProposalAcceptParamsSchema
>;
export const MemoryProposalRejectParamsSchema = z
  .object({ proposal_id: id, reason, resolved_by: actor.optional() })
  .strict();
export type MemoryProposalRejectParams = z.infer<
  typeof MemoryProposalRejectParamsSchema
>;
export const MemoryProposalRevertParamsSchema = z
  .object({
    proposal_id: id,
    expected_revision: revision,
    reason: reason.optional(),
    resolved_by: actor.optional(),
  })
  .strict();
export type MemoryProposalRevertParams = z.infer<
  typeof MemoryProposalRevertParamsSchema
>;

const skillName = z.string().min(1).max(128);
const ratio = z.number().min(0).max(1);
const SkillOutcomeSummarySchema = z
  .object({
    loads: z.number().int().nonnegative(),
    verified: z.number().int().nonnegative(),
    baseline_rate: ratio,
    baseline_loads: z.number().int().nonnegative(),
    /** Lower-bound pass-rate lift over the baseline, in [-1, 1]; 0 until the evidence clears chance. */
    helpfulness: z.number().min(-1).max(1),
    quarantined: z.boolean(),
  })
  .strict();
/** A learned skill as the operator sees it, with its verified-outcome evidence. */
export const SkillViewSchema = z
  .object({
    name: skillName,
    status: z.enum(["active", "stale", "archived"]),
    pinned: z.boolean(),
    content: z.string(),
    use_count: z.number().int().nonnegative(),
    last_activity: z.number().int().nonnegative(),
    outcomes: SkillOutcomeSummarySchema.nullable(),
  })
  .strict();
export type SkillView = z.infer<typeof SkillViewSchema>;
export const SkillProposalStatusSchema = z.enum([
  "pending",
  "accepted",
  "rejected",
]);
const SkillGateVerdictViewSchema = z
  .object({
    passed: z.boolean(),
    /** Passed and computed with thresholds no looser than the host policy. */
    meets_policy: z.boolean(),
    reasons: z.array(z.string().max(256)).max(64),
    trials: z.number().int().nonnegative(),
    wins: z.number().int().nonnegative(),
    losses: z.number().int().nonnegative(),
    ties: z.number().int().nonnegative(),
    p_value: z.number().min(0).max(1).nullable(),
    /** Null when the no-skill runs cost nothing (an infinite ratio). */
    cost_ratio: z.number().nonnegative().nullable(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const SkillProposalViewSchema = z
  .object({
    proposal_id: id,
    source: opaque,
    /** Background review that produced it; `skills.reviews.undo` takes this id. */
    review_id: id.nullable(),
    rationale: z.string(),
    status: SkillProposalStatusSchema,
    reason: z.string().optional(),
    operations: z
      .array(
        z
          .object({
            op: z.enum([
              "create",
              "update",
              "archive",
              "restore",
              "recordUse",
              "stale",
              "pin",
              "restoreVersion",
            ]),
            name: skillName,
            content: z.string().optional(),
            pinned: z.boolean().optional(),
            version_id: id.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(1024),
    gate: z
      .object({
        required: z.boolean(),
        /** Accept needs no override: no gate required, or a stored verdict passed under the host policy. */
        cleared: z.boolean(),
        /** One line: "not required", "passed (…)", "failed: …", "none yet", … */
        summary: z.string().max(2048),
        latest: SkillGateVerdictViewSchema.nullable(),
      })
      .strict(),
  })
  .strict();
export type SkillProposalView = z.infer<typeof SkillProposalViewSchema>;
export const SkillProposalListParamsSchema = z
  .object({ status: SkillProposalStatusSchema.optional() })
  .strict();
export type SkillProposalListParams = z.infer<
  typeof SkillProposalListParamsSchema
>;
/** `without_gate_reason` accepts without a passing gate verdict; the host records who and why. */
export const SkillProposalAcceptParamsSchema = z
  .object({
    proposal_id: id,
    without_gate_reason: reason.optional(),
    resolved_by: actor.optional(),
  })
  .strict();
export type SkillProposalAcceptParams = z.infer<
  typeof SkillProposalAcceptParamsSchema
>;
export const SkillProposalRejectParamsSchema = z
  .object({ proposal_id: id, reason, resolved_by: actor.optional() })
  .strict();
export type SkillProposalRejectParams = z.infer<
  typeof SkillProposalRejectParamsSchema
>;
export const SkillReviewUndoParamsSchema = z
  .object({ review_id: id, resolved_by: actor.optional() })
  .strict();
export type SkillReviewUndoParams = z.infer<typeof SkillReviewUndoParamsSchema>;
export const SkillReviewUndoResultSchema = z
  .object({ undone: z.number().int().nonnegative() })
  .strict();
export type SkillReviewUndoResult = z.infer<typeof SkillReviewUndoResultSchema>;

function method<M extends string, P extends z.AnyZodObject>(
  name: M,
  params: P,
) {
  return z
    .object({ method: z.literal(name), context: ContextSchema, params })
    .strict();
}

export const RpcRequestSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("workbench.describe"), params: empty }).strict(),
  method(
    "tasks.create",
    z
      .object({ task: TaskSchema, launch_key: LaunchKeySchema.optional() })
      .strict(),
  ),
  method("tasks.list", empty),
  method("tasks.inspect", taskId),
  method(
    "tasks.journal",
    z.object({ task_id: id, entry_ids: JournalEntryIdsSchema }).strict(),
  ),
  method("tasks.start", StartParamsSchema),
  method(
    "tasks.resume",
    z.object({ task_id: id, expected_revision: revision }).strict(),
  ),
  method(
    "tasks.steer",
    z
      .object({ task_id: id, instruction: z.string().min(1).max(16_384) })
      .strict(),
  ),
  method("tasks.cancel", taskId),
  method(
    "tasks.events",
    z.object({ task_id: id, after_event_id: id.optional() }).strict(),
  ),
  method(
    "tasks.artifact",
    z.object({ task_id: id, artifact: ArtifactRefSchema }).strict(),
  ),
  method("tasks.diff", taskId),
  method(
    "tasks.evidence",
    z
      .object({
        task_id: id,
        include_host_verification: z.literal(true).optional(),
      })
      .strict(),
  ),
  method("tasks.checkpoint", taskId),
  method("tasks.verification", taskId),
  method("tasks.export", ExportParamsSchema),
  method(
    "tasks.restore",
    z
      .object({
        task_id: id,
        checkpoint_id: id,
        expected_revision: id,
      })
      .strict(),
  ),
  method("memory.proposals.list", MemoryProposalListParamsSchema),
  method("memory.proposals.accept", MemoryProposalAcceptParamsSchema),
  method("memory.proposals.reject", MemoryProposalRejectParamsSchema),
  method("memory.proposals.revert", MemoryProposalRevertParamsSchema),
  method("skills.list", empty),
  method("skills.proposals.list", SkillProposalListParamsSchema),
  method("skills.proposals.accept", SkillProposalAcceptParamsSchema),
  method("skills.proposals.reject", SkillProposalRejectParamsSchema),
  method("skills.reviews.undo", SkillReviewUndoParamsSchema),
]);
export type RpcRequest = z.infer<typeof RpcRequestSchema>;
