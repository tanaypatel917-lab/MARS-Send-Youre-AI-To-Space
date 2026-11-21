import { ArtifactRefSchema, BudgetSchema } from "@mars/contracts";
import { z } from "zod";

export const EVOLUTION_STORE_FORMAT_VERSION = 1;
export const AGENT_MANIFEST_SCHEMA = "mars.agent-manifest/v1";
export const RUN_CONFIG_SCHEMA = "mars.evolution-run/v1";

export const Sha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "expected a sha256 hex");
export const IdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, "invalid id");
/** Same shape as Harbor task ids in `@mars/evaluation`. */
export const TaskIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, "invalid task id");
const label = z.string().min(1).max(256);
/** Repository-relative POSIX path pattern (Bun.Glob syntax). */
const PathPatternSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !value.split("/").includes(".."),
    "path patterns are repository-relative POSIX globs without '..'",
  );

/**
 * The frozen, reproducible description of one agent version. Everything that
 * can change agent behaviour is pinned here; the harness code is pinned as a
 * content-addressed base snapshot plus the ordered chain of patch digests
 * (ancestors first, DGM `get_model_patch_paths`) and the digest of the tree
 * that results from applying them.
 */
export const AgentManifestSchema = z
  .object({
    schema: z.literal(AGENT_MANIFEST_SCHEMA),
    model: z.object({ id: label, provider: label, revision: label }).strict(),
    prompts: z
      .record(
        z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
        z.string().max(64_000),
      )
      .refine((prompts) => Object.keys(prompts).length > 0, {
        message: "at least one prompt component is required",
      }),
    skills: z.object({ store_revision: label }).strict(),
    tools: z
      .array(
        z
          .object({ name: IdSchema, revision: z.string().min(1).max(128) })
          .strict(),
      )
      .max(256),
    retrieval: z
      .object({
        repo_map_tokens: z.number().int().min(0).max(1_000_000),
        memory_top_k: z.number().int().min(0).max(256),
        context_window_tokens: z.number().int().positive().max(10_000_000),
        research: z.boolean(),
      })
      .strict(),
    harness: z
      .object({
        base: z.object({ ref: label, tree_sha256: Sha256Schema }).strict(),
        patches: z.array(Sha256Schema).max(256),
        tree_sha256: Sha256Schema,
      })
      .strict(),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const names = manifest.tools.map((tool) => tool.name);
    const sorted = [...names].sort();
    if (new Set(names).size !== names.length)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tools"],
        message: "duplicate tool name",
      });
    if (names.some((name, index) => name !== sorted[index]))
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tools"],
        message: "tools must be sorted by name",
      });
  });
export type AgentManifest = z.infer<typeof AgentManifestSchema>;

export const SelectionMethodSchema = z.enum([
  "score_child_prop",
  "score_prop",
  "random",
  "best",
  "latest",
]);
export type SelectionMethod = z.infer<typeof SelectionMethodSchema>;

const TaskListSchema = z.array(TaskIdSchema).min(1).max(512);

export const StageSchema = z
  .object({
    tasks: TaskListSchema,
    /** Continue to the next stage only when the strict score so far reaches this. */
    min_score_to_continue: z.number().min(0).max(1).default(0),
  })
  .strict();

export const RunConfigSchema = z
  .object({
    schema: z.literal(RUN_CONFIG_SCHEMA),
    run_id: IdSchema,
    seed: z.string().min(1).max(256),
    generations: z.number().int().min(1).max(1000),
    /** Children proposed per generation (DGM `selfimprove_size`). */
    children_per_generation: z.number().int().min(1).max(64),
    selection: z
      .object({
        method: SelectionMethodSchema.default("score_child_prop"),
        /** DGM sigmoid steepness λ and midpoint α0. */
        sigmoid_lambda: z.number().positive().max(1000).default(10),
        sigmoid_midpoint: z.number().min(0).max(1).default(0.5),
        archive_update: z.enum(["keep_all", "keep_better"]).default("keep_all"),
        noise_leeway: z.number().min(0).max(1).default(0.1),
        /** Staged evaluation (DGM small → medium subsets); every stage is selection data. */
        stages: z.array(StageSchema).min(1).max(8),
        repeats: z.number().int().min(1).max(32),
      })
      .strict(),
    /** Held-out final test set; never evaluated during search, never shown to proposers. */
    final_test: z
      .object({
        tasks: TaskListSchema,
        // ≤ 32: the @mars/evaluation comparison manifest caps repeats at 32.
        repeats: z.number().int().min(2).max(32),
        /** Quality gate: the lower bound of the paired CI must exceed this. */
        min_improvement: z.number().min(0).max(1).default(0),
        confidence: z.number().min(0.5).max(0.999).default(0.95),
        bootstrap_samples: z.number().int().min(200).max(100_000).default(4000),
        /** Hard cap on how often the held-out set may be read in one run. */
        max_uses: z.number().int().min(1).max(100).default(5),
      })
      .strict(),
    /** Other task families; promotion requires no regression beyond tolerance. */
    regression_families: z
      .array(
        z
          .object({
            family: IdSchema,
            tasks: TaskListSchema,
            tolerance: z.number().min(0).max(1).default(0.05),
          })
          .strict(),
      )
      .max(32)
      .default([]),
    cost_gate: z
      .object({
        max_relative_increase: z.number().min(0).max(100).default(0.25),
        allow_unknown_cost: z.boolean().default(false),
      })
      .strict()
      .default({}),
    /** Matched per-evaluation budget for every candidate and the champion. */
    evaluation_budget: BudgetSchema,
    /** Whole-run budget: tokens/USD/time across every evaluation; max_depth caps lineage depth. */
    budget: BudgetSchema,
    harness: z
      .object({
        /** Only these paths may be changed by a candidate patch. */
        mutable_paths: z.array(PathPatternSchema).min(1).max(64),
        /** Never changeable, even when inside mutable_paths (evaluator, permissions, accounting). */
        protected_paths: z.array(PathPatternSchema).max(256).default([]),
        build: z
          .object({
            argv: z.array(z.string().min(1).max(4096)).min(1).max(64),
            timeout_ms: z
              .number()
              .int()
              .positive()
              .max(60 * 60 * 1000),
            /** Tree-relative directory the build must produce; copied out and digested by the host. */
            bundle_dir: PathPatternSchema,
            require_reproducible_bundle: z.boolean().default(true),
          })
          .strict(),
        max_patch_bytes: z
          .number()
          .int()
          .positive()
          .max(4 * 1024 * 1024)
          .default(1024 * 1024),
      })
      .strict(),
  })
  .strict()
  .superRefine((config, ctx) => {
    const selection = new Set(
      config.selection.stages.flatMap((stage) => stage.tasks),
    );
    const add = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
    const final = new Set(config.final_test.tasks);
    for (const task of final)
      if (selection.has(task))
        add(
          ["final_test", "tasks"],
          `final test task ${task} is also a selection task`,
        );
    const seen = new Set<string>();
    for (const [index, family] of config.regression_families.entries()) {
      if (seen.has(family.family))
        add(["regression_families", index], "duplicate family");
      seen.add(family.family);
      for (const task of family.tasks)
        if (selection.has(task) || final.has(task))
          add(
            ["regression_families", index, "tasks"],
            `regression task ${task} overlaps the selection or final test set`,
          );
    }
    const stageTasks = config.selection.stages.flatMap((stage) => stage.tasks);
    if (new Set(stageTasks).size !== stageTasks.length)
      add(["selection", "stages"], "a task appears in more than one stage");
    if (exceedsBudget(config.evaluation_budget, config.budget))
      add(
        ["evaluation_budget"],
        "per-evaluation budget exceeds the run budget",
      );
  });
export type RunConfig = z.infer<typeof RunConfigSchema>;
export type RunConfigInput = z.input<typeof RunConfigSchema>;

function exceedsBudget(
  inner: z.infer<typeof BudgetSchema>,
  outer: z.infer<typeof BudgetSchema>,
): boolean {
  return (
    inner.max_tokens > outer.max_tokens ||
    inner.max_usd > outer.max_usd ||
    inner.max_duration_ms > outer.max_duration_ms
  );
}

/**
 * What a proposer may change. The model is frozen for the whole run so every
 * comparison is matched; a proposal that touches it is refused.
 */
export const MutationProposalSchema = z
  .object({
    hypothesis: z.string().min(1).max(4000),
    prompts: z
      .record(
        z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
        z.string().max(64_000),
      )
      .optional(),
    tools: AgentManifestSchema.innerType().shape.tools.optional(),
    retrieval: AgentManifestSchema.innerType()
      .shape.retrieval.partial()
      .optional(),
    skill_store_revision: label.optional(),
    /** Unified git diff against the parent's materialised harness tree. */
    patch: z
      .string()
      .max(4 * 1024 * 1024)
      .optional(),
    /** Measured search-model usage attached by model-driven proposers for run accounting. */
    usage: z
      .object({
        tokens: z.number().int().min(0),
        usd: z.number().min(0),
        ms: z.number().int().min(0),
      })
      .strict()
      .optional(),
  })
  .strict();
export type MutationProposal = z.infer<typeof MutationProposalSchema>;

export const CandidateStateSchema = z.enum([
  "proposed",
  "building",
  "evaluating",
  "evaluated",
  "rejected",
  "accepted",
  "deployed",
  "rolled_back",
  "archived",
]);
export type CandidateState = z.infer<typeof CandidateStateSchema>;

export const SplitSchema = z.enum(["selection", "final", "regression"]);
export type Split = z.infer<typeof SplitSchema>;

const rewards = z.array(z.number().min(0).max(1).nullable());

export const EvaluationOutcomeSchema = z
  .object({
    evaluator_digest: Sha256Schema,
    simulated: z.boolean(),
    per_task: z.array(
      z
        .object({
          task_id: TaskIdSchema,
          /** One entry per repeat; null = invalid/errored trial (counts as 0 in strict means). */
          rewards,
          /** mini-swe-agent baseline arm under the same manifest, when the evaluator ran it. */
          baseline_rewards: rewards.nullable(),
        })
        .strict(),
    ),
    cost_usd: z.number().min(0).nullable(),
    tokens: z.number().int().min(0).nullable(),
    /** Spend of a baseline arm run inside the same job; charged to the ledger, excluded from the cost gate. */
    baseline_cost_usd: z.number().min(0).nullable().optional(),
    baseline_tokens: z.number().int().min(0).nullable().optional(),
    runtime_ms: z.number().int().min(0),
    report: ArtifactRefSchema.nullable(),
    notes: z.array(z.string().max(2000)).max(64),
  })
  .strict();
export type EvaluationOutcome = z.infer<typeof EvaluationOutcomeSchema>;

export const IntervalSchema = z
  .object({
    n: z.number().int().min(0),
    mean: z.number(),
    std_error: z.number().min(0),
    low: z.number(),
    high: z.number(),
    confidence: z.number(),
    method: z.literal("paired-bootstrap-percentile"),
  })
  .strict();
export type Interval = z.infer<typeof IntervalSchema>;

export const GateSchema = z
  .object({
    name: z.enum([
      "quality",
      "regression",
      "cost",
      "reproducibility",
      "integrity",
    ]),
    passed: z.boolean(),
    detail: z.string().max(4000),
  })
  .strict();
export type Gate = z.infer<typeof GateSchema>;

export const PromotionDecisionSchema = z
  .object({
    schema: z.literal("mars.evolution-promotion/v1"),
    decision_id: IdSchema,
    run_id: IdSchema,
    candidate_id: IdSchema,
    candidate_manifest_sha256: Sha256Schema,
    champion: z
      .object({
        entry_seq: z.number().int().min(1),
        manifest_sha256: Sha256Schema,
      })
      .strict(),
    verdict: z.enum(["accepted", "no_improvement", "rejected"]),
    gates: z.array(GateSchema),
    quality: IntervalSchema,
    regressions: z.array(
      z
        .object({
          family: IdSchema,
          interval: IntervalSchema,
          tolerance: z.number(),
        })
        .strict(),
    ),
    cost: z
      .object({
        candidate_usd_per_trial: z.number().nullable(),
        champion_usd_per_trial: z.number().nullable(),
      })
      .strict(),
    final_test_uses: z.number().int().min(0),
    evaluator_digest: Sha256Schema,
    simulated: z.boolean(),
    decided_at: z.string().datetime({ offset: true }),
    notes: z.array(z.string().max(2000)),
  })
  .strict();
export type PromotionDecision = z.infer<typeof PromotionDecisionSchema>;
