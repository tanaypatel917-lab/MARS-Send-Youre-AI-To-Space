import {
  ArtifactRefSchema,
  BudgetSchema,
  type ResearchFinding,
  type ResearchRequest,
} from "@mars/contracts";
import { RequestContextSchema } from "@mars/tasks";
import { z } from "zod";

const nonempty = z.string().min(1);
const timestamp = z.string().datetime({ offset: true });
export const ResearchTimestampSchema = timestamp;

export const ResearchRequestSchema = z
  .object({
    question: z
      .string()
      .min(1)
      .max(8192)
      .refine((value) => value.trim().length > 0),
    task_id: nonempty.max(256),
    task_revision: z.number().int().nonnegative(),
    known_context: z.array(ArtifactRefSchema).max(64),
    source_requirements: z.array(z.string().min(1).max(1024)).max(32),
    deadline: timestamp,
    budget: BudgetSchema,
  })
  .strict()
  .superRefine((request, context) => {
    const artifactIds = new Set<string>();
    for (const ref of request.known_context) {
      if (artifactIds.has(ref.artifact_id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["known_context"],
          message: "Duplicate artifact",
        });
        return;
      }
      artifactIds.add(ref.artifact_id);
    }
  });

export const FindingSourceSchema = z
  .object({
    url: z.string(),
    retrieved_at: timestamp,
    evidence: ArtifactRefSchema,
  })
  .strict();

export const FindingProposalSchema = z
  .object({
    finding_key: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
    claim: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => value.trim().length > 0),
    recommendation: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => value.trim().length > 0),
    confidence: z.enum(["low", "medium", "high"]),
    remaining_uncertainty: z.array(z.string().min(1).max(1024)).max(32),
    sources: z.array(FindingSourceSchema).min(1).max(32),
  })
  .strict();

export const ResearchFindingSchema = z
  .object({
    finding_id: nonempty,
    request_id: nonempty,
    task_revision: z.number().int().nonnegative(),
    claim: nonempty,
    sources: z.array(
      z
        .object({
          url: nonempty,
          retrieved_at: timestamp,
          evidence: ArtifactRefSchema,
        })
        .strict(),
    ),
    recommendation: nonempty,
    confidence: z.enum(["low", "medium", "high"]),
    remaining_uncertainty: z.array(nonempty),
    status: z.enum(["proposed", "used", "stale"]),
  })
  .strict() satisfies z.ZodType<ResearchFinding>;
export { RequestContextSchema };
export type ParsedResearchRequest = ResearchRequest;
