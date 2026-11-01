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
  })
  .strict();
export type DiffResult = z.infer<typeof DiffResultSchema>;
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
  method("tasks.create", z.object({ task: TaskSchema }).strict()),
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
