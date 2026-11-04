import {
  ArtifactRefSchema,
  EventEnvelopeSchema,
  ScopeSchema,
  TaskSchema,
  VerificationViewSchema,
} from "@mars/contracts";
import { z } from "zod";
import type { ReadMethod } from "../shared/methods";

const id = z.string().min(1).max(256);
const revision = z.number().int().nonnegative();
const taskId = z.object({ task_id: id }).strict();
const empty = z.object({}).strict();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const ParamsSchema = {
  "workbench.describe": empty,
  "tasks.list": empty,
  "tasks.inspect": taskId,
  "tasks.events": z
    .object({ task_id: id, after_event_id: id.optional() })
    .strict(),
  "tasks.artifact": z
    .object({ task_id: id, artifact: ArtifactRefSchema })
    .strict(),
  "tasks.diff": taskId,
  "tasks.verification": taskId,
  "tasks.evidence": taskId,
} satisfies Record<ReadMethod, z.ZodTypeAny>;

export const DescribeResultSchema = z
  .object({
    scope: ScopeSchema,
    workspaceLabel: z.string().min(1).max(200),
    capabilities: z
      .object({ execute: z.boolean(), checkpoint: z.boolean() })
      .strict(),
  })
  .strict();

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
    digest: sha256.optional(),
  })
  .strict();

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
    diff_sha256: sha256.nullable(),
    stale: z.boolean(),
  })
  .strict()
  .refine((record) => !record.verified || record.verdict === "pass", {
    message: "Only a passed verdict may be verified",
  });

export const EvidenceResultSchema = z
  .object({
    task_revision: revision,
    workspace: z
      .object({ workspace_id: id, provider: id, revision: id })
      .strict(),
    diff_sha256: sha256,
    verify_records: z.array(EvidenceRecordSchema).max(1000),
  })
  .strict();

export const ArtifactDataSchema = z
  .object({
    data_base64: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/),
    media_type: z.string().min(1),
  })
  .strict();

export const ResultSchema = {
  "workbench.describe": DescribeResultSchema,
  "tasks.list": z.array(TaskSchema).max(10_000),
  "tasks.inspect": TaskSchema,
  "tasks.events": z.array(EventEnvelopeSchema).max(1000),
  "tasks.artifact": ArtifactDataSchema,
  "tasks.diff": DiffResultSchema,
  "tasks.verification": VerificationViewSchema,
  "tasks.evidence": EvidenceResultSchema,
} satisfies Record<ReadMethod, z.ZodTypeAny>;

export type ParsedParams<M extends ReadMethod> = z.infer<
  (typeof ParamsSchema)[M]
>;

export type ParsedResult<M extends ReadMethod> = z.infer<
  (typeof ResultSchema)[M]
>;
