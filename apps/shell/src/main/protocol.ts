import {
  EventEnvelopeSchema,
  JournalResultSchema,
  TaskSchema,
  VerificationViewSchema,
} from "@mars/contracts";
import { z } from "zod";
import {
  ArtifactDataSchema,
  DescribeResultSchema,
  DiffResultSchema,
  EvidenceResultSchema,
  InspectResultSchema,
  RpcRequestSchema,
} from "../../../../packages/workbench/src/protocol";
import type { ReadMethod } from "../shared/methods";

type RpcRequest = z.infer<typeof RpcRequestSchema>;
type ParamsByMethod = {
  [M in ReadMethod]: z.ZodType<Extract<RpcRequest, { method: M }>["params"]>;
};

const requestParams = new Map(
  RpcRequestSchema.options.map((option) => [
    option.shape.method.value,
    option.shape.params,
  ]),
);

function paramsSchema<M extends ReadMethod>(method: M): ParamsByMethod[M] {
  const schema = requestParams.get(method);
  if (!schema) throw new Error(`Missing RPC params schema for ${method}.`);
  return schema as unknown as ParamsByMethod[M];
}

export const ParamsSchema = {
  "workbench.describe": paramsSchema("workbench.describe"),
  "tasks.list": paramsSchema("tasks.list"),
  "tasks.inspect": paramsSchema("tasks.inspect"),
  "tasks.events": paramsSchema("tasks.events"),
  "tasks.artifact": paramsSchema("tasks.artifact"),
  "tasks.diff": paramsSchema("tasks.diff"),
  "tasks.verification": paramsSchema("tasks.verification"),
  "tasks.evidence": paramsSchema("tasks.evidence"),
  "tasks.journal": paramsSchema("tasks.journal"),
} satisfies ParamsByMethod;

export const ResultSchema = {
  "workbench.describe": DescribeResultSchema,
  "tasks.list": z.array(TaskSchema).max(10_000),
  "tasks.inspect": InspectResultSchema,
  "tasks.events": z.array(EventEnvelopeSchema).max(10_000),
  "tasks.artifact": ArtifactDataSchema,
  "tasks.diff": DiffResultSchema,
  "tasks.verification": VerificationViewSchema,
  "tasks.evidence": EvidenceResultSchema,
  "tasks.journal": JournalResultSchema,
} satisfies Record<ReadMethod, z.ZodTypeAny>;

export type ParsedParams<M extends ReadMethod> = z.infer<
  (typeof ParamsSchema)[M]
>;
export type ParsedResult<M extends ReadMethod> = z.infer<
  (typeof ResultSchema)[M]
>;
