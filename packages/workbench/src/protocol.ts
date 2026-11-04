import {
  ArtifactRefSchema,
  SCHEMA_VERSION,
  ScopeSchema,
  TaskSchema,
} from "@mars/contracts";
import { z } from "zod";

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
export const WorkspaceRefSchema = z
  .object({ workspace_id: id, provider: id, revision: id })
  .strict();
export const CheckpointRefSchema = z
  .object({
    checkpoint_id: id,
    workspace: WorkspaceRefSchema,
    artifact: ArtifactRefSchema,
  })
  .strict();
export const DescribeResultSchema = z
  .object({
    scope: ScopeSchema,
    workspaceLabel: z.string().min(1).max(200),
    capabilities: z
      .object({ execute: z.boolean(), checkpoint: z.boolean() })
      .strict(),
  })
  .strict();
export type DescribeResult = z.infer<typeof DescribeResultSchema>;
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
     * This is the first additive change to the frozen protocol.
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
  })
  .strict();
export type StartParams = z.infer<typeof StartParamsSchema>;

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
  method("tasks.evidence", taskId),
  method("tasks.checkpoint", taskId),
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
]);
export type RpcRequest = z.infer<typeof RpcRequestSchema>;
