import { createHash } from "node:crypto";
import { BudgetSchema, PromptCandidateSchema } from "@mars/contracts";
import { z } from "zod";
import {
  BASELINE_AGENT_NAME,
  HARBOR_VERSION,
  MARS_AGENT_NAME,
  MINI_SWE_AGENT_VERSION,
} from "./pins";

export const COMPARISON_MANIFEST_SCHEMA = "mars.evaluation-comparison/v1";
export const COMPARISON_MANIFEST_MEDIA_TYPE =
  "application/vnd.mars.evaluation-comparison+json";

const id = z.string().min(1).max(256);
const commit = z.string().regex(/^[a-f0-9]{40}$/, "expected a 40-hex commit");
const sha256 = z.string().regex(/^[a-f0-9]{64}$/, "expected a sha256 hex");
const envName = z
  .string()
  .regex(/^[A-Z_][A-Z0-9_]*$/, "expected an environment variable NAME")
  .refine((name) => !name.startsWith("MARS_AGENT_"), {
    message: "MARS_AGENT_* names are reserved for the Harbor agent adapter",
  });
/** Mirrors `packages/workspaces/src/sandbox.ts`: images must be digest pinned. */
export const DOCKER_DIGEST_PATTERN =
  /^[a-z0-9][a-z0-9._/:-]*@sha256:[a-f0-9]{64}$/;
const dockerImage = z
  .string()
  .regex(
    DOCKER_DIGEST_PATTERN,
    "Docker image must be pinned to a sha256 digest",
  );
/** Harbor task names: directory names inside the dataset repository. */
const taskId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);

export const DatasetPinSchema = z
  .object({
    name: id,
    version: id,
    registry: z
      .object({
        url: z.string().url(),
        revision: commit,
        /** sha256 of the complete upstream registry.json at `revision`. */
        upstream_sha256: sha256,
        /** Local registry file passed as `--registry-path`; may be a subset of upstream. */
        path: z.string().min(1),
        /** sha256 of the file at `path`; the runner refuses to start on mismatch. */
        sha256,
      })
      .strict(),
    tasks_source: z
      .object({ git_url: z.string().url(), git_commit_id: commit })
      .strict(),
  })
  .strict();
export type DatasetPin = z.infer<typeof DatasetPinSchema>;

export const ModelPinSchema = z
  .object({
    id: id,
    base_url: z.string().url(),
    api_key_env: envName,
    api_format: z.literal("openai_chat_completions"),
    context_window: z.number().int().positive().default(32_000),
    pricing: z
      .object({
        input_per_mtok_usd: z.number().finite().nonnegative(),
        output_per_mtok_usd: z.number().finite().nonnegative(),
      })
      .strict()
      .nullable()
      .default(null),
  })
  .strict();
export type ModelPin = z.infer<typeof ModelPinSchema>;

export const BaselineArmSchema = z
  .object({
    agent: z.literal(BASELINE_AGENT_NAME),
    version: z.literal(MINI_SWE_AGENT_VERSION),
  })
  .strict();
export const CandidateArmSchema = z
  .object({
    agent: z.literal(MARS_AGENT_NAME),
    candidate: PromptCandidateSchema,
    /** Prebuilt agent bundle directory (binary + native addon) uploaded into each task container. */
    bundle: z.object({ path: z.string().min(1), sha256 }).strict(),
    workdir: z
      .string()
      .regex(/^\/[A-Za-z0-9._/-]*$/)
      .default("/app"),
  })
  .strict();

export const ComparisonManifestSchema = z
  .object({
    schema: z.literal(COMPARISON_MANIFEST_SCHEMA),
    comparison_id: id,
    created_at: z.string().datetime({ offset: true }),
    dataset: DatasetPinSchema,
    /** Ordered task subset run for both arms. */
    tasks: z.array(taskId).min(1).max(512),
    /**
     * Final-holdout task ids. They may appear in `tasks` for the final report,
     * but the scoring backend used for prompt optimisation refuses them.
     */
    final_holdout_tasks: z.array(taskId).max(512).default([]),
    repeats: z.number().int().min(1).max(32),
    arms: z
      .object({ baseline: BaselineArmSchema, candidate: CandidateArmSchema })
      .strict(),
    model: ModelPinSchema,
    environment: z
      .object({
        type: z.literal("docker"),
        /** Digest-pinned task images (`task_id: null` = applies to every task). */
        images: z
          .array(
            z
              .object({ task_id: taskId.nullable(), reference: dockerImage })
              .strict(),
          )
          .min(1)
          .max(1024),
      })
      .strict(),
    python: z
      .object({
        harbor_version: z.literal(HARBOR_VERSION),
        mini_swe_agent_version: z.literal(MINI_SWE_AGENT_VERSION),
      })
      .strict(),
    timeouts: z
      .object({
        /** Hard per-trial limit for the MARS agent process inside the container. */
        trial_timeout_ms: z
          .number()
          .int()
          .positive()
          .max(24 * 60 * 60 * 1000),
        /** Passed to Harbor as `--timeout-multiplier` for both arms. */
        timeout_multiplier: z.number().positive().max(10).default(1),
      })
      .strict(),
    budget: BudgetSchema,
    per_trial: z
      .object({
        max_tokens: z.number().int().positive(),
        max_usd: z.number().finite().nonnegative(),
      })
      .strict(),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const seen = new Set<string>();
    for (const task of manifest.tasks) {
      if (seen.has(task))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tasks"],
          message: `Duplicate task ${task}`,
        });
      seen.add(task);
    }
    for (const task of manifest.final_holdout_tasks) {
      if (!taskId.safeParse(task).success)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["final_holdout_tasks"],
          message: "Invalid task id",
        });
    }
    const covered = new Set(
      manifest.environment.images.map((image) => image.task_id ?? "*"),
    );
    if (!covered.has("*")) {
      for (const task of manifest.tasks) {
        if (!covered.has(task))
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["environment", "images"],
            message: `No digest-pinned image for task ${task}`,
          });
      }
    }
    if (manifest.per_trial.max_usd > manifest.budget.max_usd)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["per_trial", "max_usd"],
        message: "Per-trial USD exceeds the comparison budget",
      });
    if (manifest.timeouts.trial_timeout_ms > manifest.budget.max_duration_ms)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["timeouts", "trial_timeout_ms"],
        message: "Trial timeout exceeds the comparison duration budget",
      });
  });
export type ComparisonManifest = z.infer<typeof ComparisonManifestSchema>;
export type ComparisonManifestInput = z.input<typeof ComparisonManifestSchema>;

export function parseComparisonManifest(input: unknown): ComparisonManifest {
  return ComparisonManifestSchema.parse(input);
}

export function parseComparisonManifestBytes(
  bytes: Uint8Array,
): ComparisonManifest {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("Comparison manifest is not valid UTF-8 JSON.");
  }
  return parseComparisonManifest(json);
}

/** Stable JSON used for request/manifest digests (sorted keys, no whitespace). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort())
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}
export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Image reference for a task, resolving the `task_id: null` wildcard. */
export function imageForTask(
  manifest: ComparisonManifest,
  task: string,
): string | null {
  const exact = manifest.environment.images.find(
    (image) => image.task_id === task,
  );
  if (exact) return exact.reference;
  return (
    manifest.environment.images.find((image) => image.task_id === null)
      ?.reference ?? null
  );
}
