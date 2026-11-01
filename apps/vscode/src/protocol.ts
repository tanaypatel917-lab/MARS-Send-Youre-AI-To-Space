import {
  ArtifactRefSchema,
  EventEnvelopeSchema,
  type RequestContext,
  SCHEMA_VERSION,
  type Scope,
  ScopeSchema,
  TaskSchema,
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
    scope: ScopeSchema,
    workspaceLabel: z.string().min(1).max(200),
    capabilities: z
      .object({ execute: z.boolean(), checkpoint: z.boolean() })
      .strict(),
  })
  .strict();
export type DescribeResult = z.infer<typeof DescribeResultSchema>;

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

export const DiffResultSchema = z
  .object({ files: z.array(DiffFileSchema).max(5000) })
  .strict();
export type DiffResult = z.infer<typeof DiffResultSchema>;

export const RpcErrorSchema = z
  .object({ code: z.string().min(1).max(200), message: z.string() })
  .strict();

export const NullResultSchema = z.null();

export const RPC_METHODS = {
  describe: "workbench.describe",
  create: "tasks.create",
  list: "tasks.list",
  inspect: "tasks.inspect",
  start: "tasks.start",
  resume: "tasks.resume",
  steer: "tasks.steer",
  cancel: "tasks.cancel",
  events: "tasks.events",
  artifact: "tasks.artifact",
  diff: "tasks.diff",
  checkpoint: "tasks.checkpoint",
  restore: "tasks.restore",
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
