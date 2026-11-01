import {
  ArtifactRefSchema,
  BudgetSchema,
  ScopeSchema,
  type SpecialistManifest,
  VersionRefSchema,
} from "@mars/contracts";
import { z } from "zod";

export const SPECIALIST_STORE_FORMAT_VERSION = 1;
export const NO_PRODUCTION = "none";
export const ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
export const DOMAIN_PATTERN = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;

export const IdSchema = z.string().regex(ID_PATTERN);
export const RevisionSchema = IdSchema.refine(
  (revision) => revision !== NO_PRODUCTION,
);
export const DomainKeySchema = z.string().regex(DOMAIN_PATTERN);
export const RequestContextSchema = z
  .object({
    schema_version: z.literal(1),
    scope: ScopeSchema,
    request_id: z.string().min(1).max(200),
  })
  .strict();
export const RoleSchema = z.enum(["lead", "worker", "reviewer"]);
export const ComplexitySchema = z.enum(["light", "medium", "heavy"]);
export type Complexity = z.infer<typeof ComplexitySchema>;
export const AdapterFormatSchema = z.literal("peft-lora");

const uniqueArray = <T extends z.ZodTypeAny>(schema: T, min = 0) =>
  z
    .array(schema)
    .min(min)
    .refine((items) => new Set(items).size === items.length);

export const AcceptancePolicySchema = z
  .object({
    min_heldout_tasks_per_coverage: z.number().int().min(1),
    min_pass_rate_delta_vs_base: z.number().finite().min(-1).max(1),
    min_pass_rate_delta_vs_prompt_optimized: z.number().finite().min(-1).max(1),
    min_pass_rate_delta_vs_current: z.number().finite().min(-1).max(1),
    max_regressions: z.number().int().nonnegative(),
    max_cost_usd_per_task: z.number().finite().nonnegative().nullable(),
    max_runtime_ms_p95: z.number().int().positive().nullable(),
  })
  .strict();
export type AcceptancePolicy = z.infer<typeof AcceptancePolicySchema>;

export const ServingBindingSchema = z
  .object({
    model_id: z.string().min(1).max(200),
    provider_id: IdSchema,
    provider_model: IdSchema,
    adapter_format: AdapterFormatSchema.nullable(),
  })
  .strict();
export type ServingBinding = z.infer<typeof ServingBindingSchema>;

export const SpecialistProfileSchema = z
  .object({
    schema_version: z.literal(1),
    display_name: z.string().min(1).max(120),
    roles: uniqueArray(RoleSchema, 1),
    complexity: uniqueArray(ComplexitySchema, 1),
    serving: z.array(ServingBindingSchema).min(1),
    adapter_spec: z
      .object({
        format: AdapterFormatSchema,
        base_model: VersionRefSchema,
        tokenizer: VersionRefSchema,
        chat_template_sha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .nullable(),
    acceptance: AcceptancePolicySchema,
    limitations: z.array(z.string().max(500)),
  })
  .strict();
export type SpecialistProfile = z.infer<typeof SpecialistProfileSchema>;

const SpecialistManifestSchema = z
  .object({
    specialist_id: IdSchema,
    revision: RevisionSchema,
    scope: ScopeSchema,
    tested_task_coverage: uniqueArray(DomainKeySchema, 1),
    base_model: VersionRefSchema,
    tokenizer: VersionRefSchema,
    chat_template: ArtifactRefSchema,
    adapter: ArtifactRefSchema.nullable(),
    tools: z.array(VersionRefSchema),
    skills: z.array(VersionRefSchema),
    knowledge: z.array(VersionRefSchema),
    evaluation: ArtifactRefSchema,
    dataset_lineage: ArtifactRefSchema.nullable(),
    fallback_specialist_revision: z.string().min(1),
  })
  .strict();

export const SpecialistRegistrationSchema = SpecialistManifestSchema.extend({
  profile: SpecialistProfileSchema,
}).strict();
export type SpecialistRegistration = z.infer<
  typeof SpecialistRegistrationSchema
> &
  SpecialistManifest;

export const BaselineProfileSchema = z
  .object({
    schema_version: z.literal(1),
    baseline_id: IdSchema,
    revision: RevisionSchema,
    scope: ScopeSchema,
    display_name: z.string().min(1).max(120),
    model_id: z.string().min(1).max(200),
    provider_id: IdSchema,
    provider_model: IdSchema,
    roles: uniqueArray(RoleSchema, 1),
    complexity: uniqueArray(ComplexitySchema, 1),
    priority: z.number().int().nonnegative(),
  })
  .strict();
export type BaselineProfile = z.infer<typeof BaselineProfileSchema>;

export const AttestationSchema = z
  .object({
    alg: z.literal("hmac-sha256"),
    key_id: IdSchema,
    mac_hex: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const armNames = [
  "base",
  "prompt_optimized_baseline",
  "current_specialist",
  "candidate",
] as const;
export const EvaluationArmSchema = z.enum(armNames);

export const EvaluationReportSchema = z
  .object({
    schema: z.literal("mars.specialist-evaluation-report/v1"),
    report_id: IdSchema,
    subject: z
      .object({
        specialist_id: IdSchema,
        revision: RevisionSchema,
        candidate_sha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    authorization: z
      .object({ owner_id: z.string().min(1), project_id: z.string().min(1) })
      .strict(),
    suite: z
      .object({
        suite_id: IdSchema,
        revision: RevisionSchema,
        harness: VersionRefSchema,
      })
      .strict(),
    heldout: z
      .object({
        split_id: IdSchema,
        split_sha256: z.string().regex(/^[a-f0-9]{64}$/),
        task_ids: uniqueArray(IdSchema, 1),
      })
      .strict(),
    arms: z
      .array(
        z
          .object({
            arm: EvaluationArmSchema,
            agent_manifest_sha256: z.string().regex(/^[a-f0-9]{64}$/),
            model: VersionRefSchema,
            specialist_revision: RevisionSchema.nullable(),
          })
          .strict(),
      )
      .min(4),
    results: z.array(
      z
        .object({
          arm: EvaluationArmSchema,
          domain: DomainKeySchema,
          role: RoleSchema,
          complexity: ComplexitySchema,
          task_ids: uniqueArray(IdSchema, 1),
          passed: z.number().int().nonnegative(),
          attempted: z.number().int().positive(),
          repeats: z.number().int().min(1),
          cost_usd_total: z.number().finite().nonnegative().nullable(),
          runtime_ms_p95: z.number().int().positive().nullable(),
          input_tokens: z.number().int().nonnegative().nullable(),
          output_tokens: z.number().int().nonnegative().nullable(),
        })
        .strict(),
    ),
    regressions: z.array(
      z
        .object({
          task_id: IdSchema,
          domain: DomainKeySchema,
          compared_to: z.enum([
            "base",
            "prompt_optimized_baseline",
            "current_specialist",
          ]),
        })
        .strict(),
    ),
    uncertainty: z.array(z.string()),
    limitations: z.array(z.string()),
    provenance: z
      .object({
        evaluator_id: IdSchema,
        evaluator_revision: RevisionSchema,
        job_id: IdSchema,
        produced_at: z.string().datetime({ offset: true }),
        synthetic_fixture: z.boolean(),
        evidence_artifacts: z.array(ArtifactRefSchema),
      })
      .strict(),
    attestation: AttestationSchema,
  })
  .strict()
  .superRefine((report, context) => {
    const arms = report.arms.map(({ arm }) => arm);
    if (
      arms.length !== armNames.length ||
      new Set(arms).size !== armNames.length ||
      armNames.some((arm) => !arms.includes(arm))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["arms"],
        message: "exactly_one_of_each_arm",
      });
    }
  });
export type EvaluationReport = z.infer<typeof EvaluationReportSchema>;

export const DatasetLineageSchema = z
  .object({
    schema: z.literal("mars.specialist-dataset-lineage/v1"),
    lineage_id: IdSchema,
    subject: z
      .object({ specialist_id: IdSchema, base_model: VersionRefSchema })
      .strict(),
    datasets: z
      .array(
        z
          .object({
            dataset_id: IdSchema,
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
            split: z.enum(["train", "validation"]),
          })
          .strict(),
      )
      .min(1),
    training: z
      .object({
        job_id: IdSchema,
        producer_id: IdSchema,
        config_sha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    source_scopes: z
      .array(
        z
          .object({
            owner_id: z.string().min(1),
            project_id: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
    train_task_ids: uniqueArray(IdSchema),
    validation_task_ids: uniqueArray(IdSchema),
    provenance: z.object({ synthetic_fixture: z.boolean() }).strict(),
    attestation: AttestationSchema,
  })
  .strict();
export type DatasetLineage = z.infer<typeof DatasetLineageSchema>;

export const RoutingRequestSchema = z
  .object({
    schema_version: z.literal(1),
    task_id: IdSchema,
    role: RoleSchema,
    domain: DomainKeySchema,
    complexity: ComplexitySchema,
    requires: z
      .object({
        tools: z.boolean(),
        vision: z.boolean(),
        reasoning: z.boolean(),
        min_context_tokens: z.number().int().nonnegative(),
      })
      .strict(),
    budget: BudgetSchema,
    paid_consent: z.boolean().default(false),
    override: z
      .object({ ref: z.string().min(1) })
      .strict()
      .optional(),
    independence: z
      .object({
        policy: z.enum(["none", "distinct_model", "distinct_lineage"]),
        from_decision_ids: uniqueArray(IdSchema),
      })
      .strict()
      .optional(),
    exclude_refs: uniqueArray(z.string().min(1)).optional(),
  })
  .strict();
export type RoutingRequest = z.infer<typeof RoutingRequestSchema>;

export const SelectedTargetSchema = z
  .object({
    kind: z.enum(["specialist", "baseline"]),
    ref: z.string().min(1),
    specialist_id: IdSchema.nullable(),
    baseline_id: IdSchema.nullable(),
    revision: RevisionSchema,
    model_id: z.string().min(1).max(200),
    provider_id: IdSchema,
    provider_model: IdSchema,
    base_model: VersionRefSchema.nullable(),
    adapter_sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    manifest_sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    evidence: z
      .object({
        report_id: IdSchema,
        report_sha256: z.string().regex(/^[a-f0-9]{64}$/),
        pass_rate: z.number().finite().min(0).max(1),
        base_pass_rate: z.number().finite().min(0).max(1),
        prompt_optimized_pass_rate: z.number().finite().min(0).max(1),
        current_pass_rate: z.number().finite().min(0).max(1).nullable(),
        cost_usd_per_task: z.number().finite().nonnegative().nullable(),
        runtime_ms_p95: z.number().int().positive().nullable(),
        synthetic_fixture: z.boolean(),
      })
      .strict()
      .nullable(),
    cost_basis: z.enum(["measured", "free", "configured_price_upper_bound"]),
    serving_attestation: z.enum(["verified", "absent"]),
  })
  .strict();
export type SelectedTarget = z.infer<typeof SelectedTargetSchema>;

export const REASON_CODES = [
  "evidence_missing",
  "evidence_digest_mismatch",
  "evidence_malformed",
  "evidence_subject_mismatch",
  "evidence_unauthorized",
  "evidence_unverified",
  "evidence_synthetic_fixture",
  "evidence_not_independent",
  "evidence_stale_current_baseline",
  "lineage_missing",
  "lineage_digest_mismatch",
  "lineage_malformed",
  "lineage_unverified",
  "lineage_subject_mismatch",
  "lineage_leakage",
  "lineage_out_of_scope",
  "cost_unmeasured",
  "runtime_unmeasured",
  "regressions_exceeded",
  "evaluation_gate_failed",
  "status_not_evaluated",
  "invalidated",
  "archived",
  "domain_not_covered",
  "role_not_covered",
  "complexity_not_covered",
  "model_not_configured",
  "model_binding_mismatch",
  "serving_unattested",
  "serving_base_mismatch",
  "serving_tokenizer_mismatch",
  "serving_chat_template_mismatch",
  "serving_adapter_unsupported",
  "serving_adapter_not_loaded",
  "capability_tools",
  "capability_vision",
  "capability_reasoning",
  "capability_context",
  "provider_unavailable",
  "paid_not_allowed",
  "paid_consent_missing",
  "pricing_unknown",
  "budget_cost_exceeded",
  "budget_runtime_exceeded",
  "independence_same_model",
  "independence_same_lineage",
  "fallback_cycle",
  "fallback_depth_exceeded",
  "fallback_target_missing",
  "override_not_found",
  "excluded",
  "intended_specialist_ineligible",
  "no_covering_specialist",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];
export const ReasonCodeSchema = z.enum(REASON_CODES);

export const RoutingDecisionSchema = z
  .object({
    schema_version: z.literal(1),
    decision_id: z.string().uuid(),
    task_id: IdSchema,
    role: RoleSchema,
    domain: DomainKeySchema,
    complexity: ComplexitySchema,
    outcome: z.enum([
      "specialist",
      "baseline",
      "unavailable",
      "override_rejected",
    ]),
    override: z.boolean(),
    selected: SelectedTargetSchema.nullable(),
    fallback: z
      .object({
        reason_code: z.enum([
          "intended_specialist_ineligible",
          "no_covering_specialist",
        ]),
        from: z.string().nullable(),
        chain: z.array(
          z
            .object({
              ref: z.string(),
              reasons: uniqueArray(ReasonCodeSchema),
            })
            .strict(),
        ),
      })
      .strict()
      .nullable(),
    rejected: z.array(
      z
        .object({ ref: z.string(), reasons: uniqueArray(ReasonCodeSchema) })
        .strict(),
    ),
    ranking: z.array(
      z
        .object({
          ref: z.string(),
          pass_rate: z.number().finite().min(0).max(1),
          cost_usd_per_task: z.number().finite().nonnegative().nullable(),
          runtime_ms_p95: z.number().int().positive().nullable(),
        })
        .strict(),
    ),
    explanation: z.array(z.string()),
    decision_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    retry_of: z.string().nullable(),
    attempt: z.number().int().nonnegative(),
    created_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type RoutingDecision = z.infer<typeof RoutingDecisionSchema>;

export const AuditActionSchema = z.enum([
  "specialist.registered",
  "specialist.verified",
  "baseline.registered",
  "baseline.retired",
  "evaluation.delegated",
  "production.deployed",
  "production.rolled_back",
  "production.retired",
  "revision.archived",
  "dependency.invalidated",
  "routing.decided",
]);

export interface ResolveFallbackResult {
  chain: string[];
  error:
    | "fallback_cycle"
    | "fallback_depth_exceeded"
    | "fallback_target_missing"
    | null;
}
