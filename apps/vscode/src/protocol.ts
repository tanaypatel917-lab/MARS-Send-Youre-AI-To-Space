import {
  ArtifactRefSchema,
  EventEnvelopeSchema,
  type RequestContext,
  SCHEMA_VERSION,
  type Scope,
  ScopeSchema,
  TaskSchema,
  WorkbenchDescribeFields,
  WorkbenchInspectFields,
} from "@mars/contracts";
import { z } from "zod";

const id = z.string().min(1);

/**
 * Wire schemas for the frozen workbench RPC protocol. `WorkspaceRef` and
 * `CheckpointRef` are interfaces in @mars/contracts without runtime schemas,
 * so they are validated here against the same shapes.
 */
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

export const ApprovalsSchema = z
  .object({ read: z.boolean(), write: z.boolean(), execute: z.boolean() })
  .strict();
export type Approvals = z.infer<typeof ApprovalsSchema>;

export const ArtifactDataSchema = z
  .object({
    data_base64: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/),
    media_type: id,
  })
  .strict();
export type ArtifactData = z.infer<typeof ArtifactDataSchema>;

export const DiffFileSchema = z
  .object({
    path: z.string().min(1).max(4096),
    status: z.enum(["added", "modified", "deleted"]),
    patch: z.string(),
  })
  .strict();
export type DiffFile = z.infer<typeof DiffFileSchema>;

const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);

/**
 * `digest` is the canonical SHA-256 of the diff (server `diffDigest`). It is
 * an additive change to the frozen protocol and stays optional so a
 * result from an older server still validates.
 */
export const DiffResultSchema = z
  .object({
    files: z.array(DiffFileSchema).max(5000),
    digest: sha256Hex.optional(),
  })
  .strict();
export type DiffResult = z.infer<typeof DiffResultSchema>;

export const LAUNCH_KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

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
    verified: z.boolean(),
    contract_id: id.optional(),
    contract_digest: z.string().min(1).max(256).optional(),
    recorded_at: z.string().datetime(),
    workspace_id: id.nullable(),
    workspace_revision: id.nullable(),
    diff_sha256: sha256Hex.nullable(),
    stale: z.boolean(),
  })
  .strict()
  .refine((record) => !record.verified || record.verdict === "pass", {
    message: "Only a passed verdict may be verified",
  });
export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;

export const EvidenceResultSchema = z
  .object({
    task_revision: z.number().int().nonnegative(),
    workspace: WorkspaceRefSchema,
    diff_sha256: sha256Hex,
    verify_records: z.array(EvidenceRecordSchema).max(1000),
  })
  .strict();
export type EvidenceResult = z.infer<typeof EvidenceResultSchema>;

export const RpcErrorSchema = z
  .object({ code: z.string().min(1).max(200), message: z.string() })
  .strict();

export const NullResultSchema = z.null();

export const RPC_METHODS = {
  describe: "workbench.describe",
  create: "tasks.create",
  list: "tasks.list",
  inspect: "tasks.inspect",
  journal: "tasks.journal",
  start: "tasks.start",
  resume: "tasks.resume",
  steer: "tasks.steer",
  cancel: "tasks.cancel",
  events: "tasks.events",
  artifact: "tasks.artifact",
  diff: "tasks.diff",
  evidence: "tasks.evidence",
  checkpoint: "tasks.checkpoint",
  restore: "tasks.restore",
  verification: "tasks.verification",
} as const;
export type RpcMethod = (typeof RPC_METHODS)[keyof typeof RPC_METHODS];

export const TaskListSchema = z.array(TaskSchema).max(10_000);
export const EventBatchSchema = z.array(EventEnvelopeSchema).max(10_000);

export function makeContext(scope: Scope, requestId: string): RequestContext {
  return { schema_version: SCHEMA_VERSION, scope, request_id: requestId };
}

export function sameScope(a: Scope, b: Scope): boolean {
  return (
    a.owner_id === b.owner_id &&
    a.project_id === b.project_id &&
    a.workspace_id === b.workspace_id
  );
}
