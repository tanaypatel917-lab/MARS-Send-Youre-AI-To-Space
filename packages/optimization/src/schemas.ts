import {
  ArtifactRefSchema,
  BudgetSchema,
  InstanceScoreSchema,
  PromptCandidateSchema,
  ScopeSchema,
  ScoringResultSchema,
  ScoringSplitSchema,
} from "@mars/contracts";
import { z } from "zod";

export const ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
export const IdSchema = z.string().regex(ID_PATTERN);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.string().datetime({ offset: true });

export const RequestContextSchema = z
  .object({
    schema_version: z.literal(1),
    scope: ScopeSchema,
    request_id: z.string().min(1).max(200),
  })
  .strict();

export const TARGET_SCHEMA = "mars.optimization-target/v1" as const;
export const PROPOSAL_REQUEST_SCHEMA =
  "mars.optimization-proposal-request/v1" as const;
export const EVALUATE_REQUEST_SCHEMA =
  "mars.optimization-evaluate-request/v1" as const;
export const CANDIDATE_SCHEMA = "mars.optimization-candidate/v1" as const;
export const PROPOSAL_REPORT_SCHEMA = "mars.optimization-proposal/v1" as const;

/** One scoreable instance. `summary` is the only text the reflection model sees about it. */
export const TargetInstanceSchema = z
  .object({
    instance_id: IdSchema,
    summary: z.string().max(2000).default(""),
  })
  .strict();
export type TargetInstance = z.infer<typeof TargetInstanceSchema>;

export const SplitPolicySchema = z
  .object({
    seed: z.string().min(1).max(200),
    train_fraction: z.number().gt(0).lt(1),
    validation_fraction: z.number().gt(0).lt(1),
    min_final_holdout: z.number().int().min(1).default(1),
  })
  .strict()
  .refine((p) => p.train_fraction + p.validation_fraction < 1, {
    message: "train_fraction + validation_fraction must leave a final holdout",
  });
export type SplitPolicy = z.infer<typeof SplitPolicySchema>;

/** Registration artifact consumed by `registerTarget`. */
export const PromptTargetRegistrationSchema = z
  .object({
    schema: z.literal(TARGET_SCHEMA),
    target_id: IdSchema,
    description: z.string().max(2000).default(""),
    components: z.record(z.string().min(1).max(64), z.string().max(64_000)),
    instances: z.array(TargetInstanceSchema).min(3),
    split: SplitPolicySchema,
  })
  .strict()
  .refine((t) => Object.keys(t.components).length > 0, {
    message: "components must not be empty",
  })
  .refine(
    (t) =>
      new Set(t.instances.map((i) => i.instance_id)).size ===
      t.instances.length,
    { message: "instance ids must be unique" },
  );
export type PromptTargetRegistration = z.infer<
  typeof PromptTargetRegistrationSchema
>;

export const SplitSchema = z
  .object({
    train: z.array(IdSchema).min(1),
    validation: z.array(IdSchema).min(1),
  })
  .strict();

/** Stored target. Never contains the final holdout ids (kept in a separate record). */
export const StoredTargetSchema = z
  .object({
    schema: z.literal(TARGET_SCHEMA),
    target_id: IdSchema,
    description: z.string(),
    components: z.record(z.string(), z.string()),
    instances: z.array(
      z.object({ instance_id: IdSchema, summary: z.string() }).strict(),
    ),
    split_policy: SplitPolicySchema,
    split: SplitSchema,
    split_sha256: sha,
    seed_candidate_id: z.string().min(1),
    registration_sha256: sha,
    registered_at: timestamp,
  })
  .strict();
export type StoredTarget = z.infer<typeof StoredTargetSchema>;

export const HoldoutRecordSchema = z
  .object({
    schema: z.literal("mars.optimization-final-holdout/v1"),
    target_id: IdSchema,
    final_holdout: z.array(IdSchema).min(1),
    split_sha256: sha,
    note: z.string(),
  })
  .strict();
export type HoldoutRecord = z.infer<typeof HoldoutRecordSchema>;

/** Manifest artifact passed to `propose`. */
export const ProposalRequestSchema = z
  .object({
    schema: z.literal(PROPOSAL_REQUEST_SCHEMA),
    max_metric_calls: z.number().int().min(1).max(100_000),
    reflection_minibatch_size: z.number().int().min(1).max(64).default(2),
    repeats: z.number().int().min(1).max(16).default(1),
    seed: z.number().int().min(0).default(0),
    reflection_model: z.string().min(1).optional(),
    paid_consent: z.boolean().default(false),
    estimated_usd_per_metric_call: z.number().min(0).nullable().default(null),
    estimated_ms_per_metric_call: z
      .number()
      .int()
      .min(1)
      .nullable()
      .default(null),
    max_reflection_tokens: z.number().int().min(64).max(32_000).default(2048),
  })
  .strict();
export type ProposalRequest = z.infer<typeof ProposalRequestSchema>;

/** Artifact passed to `evaluate`: an existing or new candidate for a target. */
export const EvaluateRequestSchema = z
  .object({
    schema: z.literal(EVALUATE_REQUEST_SCHEMA),
    target_id: IdSchema,
    candidate: PromptCandidateSchema,
    repeats: z.number().int().min(1).max(16).default(1),
    budget: BudgetSchema,
    estimated_usd_per_metric_call: z.number().min(0).nullable().default(null),
  })
  .strict();
export type EvaluateRequest = z.infer<typeof EvaluateRequestSchema>;

export const CANDIDATE_STATUSES = [
  "draft",
  "proposed",
  "accepted",
  "rejected",
  "archived",
] as const;
export const CandidateStatusSchema = z.enum(CANDIDATE_STATUSES);
export type CandidateStatus = z.infer<typeof CandidateStatusSchema>;

const CANDIDATE_TRANSITIONS: Record<
  CandidateStatus,
  readonly CandidateStatus[]
> = {
  draft: ["proposed", "archived"],
  proposed: ["accepted", "rejected", "archived"],
  accepted: ["archived"],
  rejected: ["archived"],
  archived: [],
};

export function canTransitionCandidate(
  from: CandidateStatus,
  to: CandidateStatus,
): boolean {
  return CANDIDATE_TRANSITIONS[from].includes(to);
}

/** Provenance of one stored ScoringResult. */
export const ScoreProvenanceSchema = z
  .object({
    job_id: IdSchema,
    split: ScoringSplitSchema,
    backend_id: z.string().min(1),
    request_sha256: sha,
    host_request_sha256: sha,
    result: ArtifactRefSchema,
    mean_score: z.number().min(0).max(1),
    cost_usd: z.number().min(0).nullable(),
    runtime_ms: z.number().int().min(0),
    simulated: z.boolean(),
    instance_count: z.number().int().min(1),
    recorded_at: timestamp,
  })
  .strict();
export type ScoreProvenance = z.infer<typeof ScoreProvenanceSchema>;

export const CandidateRecordSchema = z
  .object({
    schema: z.literal(CANDIDATE_SCHEMA),
    target_id: IdSchema,
    candidate: PromptCandidateSchema,
    origin: z.enum(["seed", "proposed", "submitted"]),
    status: CandidateStatusSchema,
    job_id: IdSchema.nullable(),
    /** Every job that created or scored this candidate; readers find reports through it. */
    job_ids: z.array(IdSchema).default([]),
    scores: z.array(ScoreProvenanceSchema),
    history: z.array(
      z
        .object({
          from: CandidateStatusSchema.nullable(),
          to: CandidateStatusSchema,
          at: timestamp,
          reason: z.string().max(500),
        })
        .strict(),
    ),
    updated_at: timestamp,
  })
  .strict();
export type CandidateRecord = z.infer<typeof CandidateRecordSchema>;

export const JobStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const STOP_REASONS = [
  "finished",
  "deadline",
  "budget_usd",
  "budget_tokens",
  "metric_calls",
  "cancelled",
  "worker_error",
  "backend_error",
  "pin_mismatch",
  "protocol_error",
] as const;
export const StopReasonSchema = z.enum(STOP_REASONS);
export type StopReason = z.infer<typeof StopReasonSchema>;

export const JobRecordSchema = z
  .object({
    schema: z.literal("mars.optimization-job/v1"),
    job_id: IdSchema,
    kind: z.enum(["propose", "evaluate"]),
    target_id: IdSchema,
    input_manifest: ArtifactRefSchema,
    budget: BudgetSchema,
    status: JobStatusSchema,
    stop_reason: StopReasonSchema.nullable(),
    error: z.string().nullable(),
    seed_candidate_id: z.string().min(1),
    candidate_ids: z.array(z.string().min(1)),
    best_candidate_id: z.string().min(1).nullable(),
    metric_calls: z.number().int().min(0),
    reflection_calls: z.number().int().min(0),
    cost_usd: z.number().min(0),
    cost_unmeasured_scores: z.number().int().min(0),
    tokens: z.number().int().min(0),
    simulated: z.boolean(),
    scoring_backend_id: z.string().min(1),
    reflection_responder_id: z.string().min(1).nullable(),
    worker: z
      .object({
        gepa_version: z.string().nullable(),
        python_version: z.string().nullable(),
        exit_code: z.number().int().nullable(),
        log_tail: z.array(z.string().max(2000)).max(200),
      })
      .strict(),
    started_at: timestamp.nullable(),
    finished_at: timestamp.nullable(),
    created_at: timestamp,
    report: ArtifactRefSchema.nullable(),
  })
  .strict();
export type JobRecord = z.infer<typeof JobRecordSchema>;

export const RecommendationSchema = z.enum([
  "no_improvement",
  "candidate_improved_validation",
]);
export type Recommendation = z.infer<typeof RecommendationSchema>;

const ReportCandidateSchema = z
  .object({
    candidate: PromptCandidateSchema,
    status: CandidateStatusSchema,
    validation_mean_score: z.number().min(0).max(1).nullable(),
    validation: ScoreProvenanceSchema.nullable(),
  })
  .strict();

/** Immutable proposal report returned by `publish`. Nothing in it promotes anything. */
export const ProposalReportSchema = z
  .object({
    schema: z.literal(PROPOSAL_REPORT_SCHEMA),
    report_id: IdSchema,
    job_id: IdSchema,
    job_kind: z.enum(["propose", "evaluate"]),
    target_id: IdSchema,
    scope: z
      .object({ owner_id: z.string().min(1), project_id: z.string().min(1) })
      .strict(),
    recommendation: RecommendationSchema,
    promotion: z.literal("none_automatic"),
    seed: ReportCandidateSchema,
    best: ReportCandidateSchema,
    per_instance_deltas: z.array(
      z
        .object({
          instance_id: IdSchema,
          seed_score: z.number().min(0).max(1).nullable(),
          best_score: z.number().min(0).max(1).nullable(),
          delta: z.number().min(-1).max(1).nullable(),
        })
        .strict(),
    ),
    validation_instance_ids: z.array(IdSchema),
    candidates_total: z.number().int().min(0),
    candidates: z.array(ReportCandidateSchema),
    metric_calls: z.number().int().min(0),
    reflection_calls: z.number().int().min(0),
    cost_usd: z.number().min(0),
    cost_unmeasured_scores: z.number().int().min(0),
    runtime_ms: z.number().int().min(0),
    stop_reason: StopReasonSchema.nullable(),
    simulated: z.boolean(),
    score_provenance: z.array(ScoreProvenanceSchema),
    limitations: z.array(z.string().max(1000)),
    pins: z
      .object({
        gepa_version: z.string(),
        gepa_source_revision: z.string().regex(/^[a-f0-9]{40}$/),
        python_version_prefix: z.string(),
        worker_gepa_version: z.string().nullable(),
        worker_python_version: z.string().nullable(),
      })
      .strict(),
    produced_at: timestamp,
  })
  .strict();
export type ProposalReport = z.infer<typeof ProposalReportSchema>;

/* ---------- Worker protocol (newline-delimited JSON) ---------- */

export const WorkerInstanceSchema = z
  .object({
    instance_id: IdSchema,
    split: ScoringSplitSchema,
    summary: z.string(),
  })
  .strict();

export const WorkerStartSchema = z
  .object({
    type: z.literal("start"),
    expected: z
      .object({
        gepa_version: z.string().min(1),
        python_version_prefix: z.string().min(1),
      })
      .strict(),
    seed_candidate: z.record(z.string(), z.string()),
    train: z.array(WorkerInstanceSchema).min(1),
    validation: z.array(WorkerInstanceSchema).min(1),
    max_metric_calls: z.number().int().min(1),
    reflection_minibatch_size: z.number().int().min(1),
    seed: z.number().int().min(0),
    repeats: z.number().int().min(1),
    budget: BudgetSchema,
    max_feedback_chars: z.number().int().min(64),
    max_records_per_component: z.number().int().min(1),
  })
  .strict();
export type WorkerStart = z.infer<typeof WorkerStartSchema>;

/** Messages the worker may emit. Anything else is a protocol error. */
export const WorkerMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("ready"),
      gepa_version: z.string(),
      python_version: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("score"),
      id: z.number().int().min(0),
      request: z
        .object({
          candidate: PromptCandidateSchema,
          split: ScoringSplitSchema,
          instance_ids: z.array(IdSchema).min(1),
          repeats: z.number().int().min(1),
          budget: BudgetSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("reflect"),
      id: z.number().int().min(0),
      prompt: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("candidate"),
      candidate_idx: z.number().int().min(0),
      parent_idx: z.number().int().min(0).nullable(),
      components: z.record(z.string(), z.string()),
      validation_mean_score: z.number().nullable(),
    })
    .strict(),
  z.object({ type: z.literal("log"), message: z.string() }).strict(),
  z
    .object({
      type: z.literal("done"),
      result: z
        .object({
          candidates: z.array(z.record(z.string(), z.string())),
          parents: z.array(z.array(z.number().int().nullable())),
          val_aggregate_scores: z.array(z.number()),
          best_idx: z.number().int().min(0),
          total_metric_calls: z.number().int().min(0).nullable(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("error"),
      code: z.enum(["pin_mismatch", "protocol_error", "gepa_error"]),
      message: z.string(),
    })
    .strict(),
]);
export type WorkerMessage = z.infer<typeof WorkerMessageSchema>;

export const HostMessageSchema = z.discriminatedUnion("type", [
  WorkerStartSchema,
  z
    .object({
      type: z.literal("score_result"),
      id: z.number().int().min(0),
      result: ScoringResultSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("reflect_result"),
      id: z.number().int().min(0),
      text: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("abort"),
      id: z.number().int().min(0),
      message: z.string(),
    })
    .strict(),
]);
export type HostMessage = z.infer<typeof HostMessageSchema>;

export { InstanceScoreSchema };
