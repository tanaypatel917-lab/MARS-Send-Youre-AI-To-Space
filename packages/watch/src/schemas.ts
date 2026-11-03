import { z } from "zod";

export const WATCH_PACKAGE_VERSION = "0.0.1";
/** The only upstream release this wrapper has been written against. */
export const WATCH_SKILL_VERSION = "1.4.3";
export const WATCH_EVIDENCE_PRODUCER = "@mars/watch";
export const WATCH_EVIDENCE_OPERATION = "watch.evidence";

export const WatchVerdictSchema = z.enum([
  "pass",
  "fail",
  "inconclusive",
  "error",
]);
export type WatchVerdict = z.infer<typeof WatchVerdictSchema>;

/** `remote_attested` is declared for completeness; upstream does not implement it. */
export const WatchAssuranceSchema = z.enum([
  "none",
  "visual_advisory",
  "deterministic_local",
  "isolated_local",
  "remote_attested",
]);
export type WatchAssurance = z.infer<typeof WatchAssuranceSchema>;

/** Assurance levels that can carry a verified verdict. */
export const VERIFIABLE_ASSURANCE: ReadonlySet<WatchAssurance> = new Set([
  "deterministic_local",
  "isolated_local",
]);

export const WatchPolicySchema = z
  .object({
    allow_screen_capture: z.boolean(),
    allow_network_sources: z.boolean(),
    allow_cloud_models: z.boolean(),
  })
  .strict();
export type WatchPolicy = z.infer<typeof WatchPolicySchema>;
export const DEFAULT_WATCH_POLICY: WatchPolicy = {
  allow_screen_capture: false,
  allow_network_sources: false,
  allow_cloud_models: false,
};

const id = z.string().min(1).max(256);

/**
 * One evidence record per loop or verify operation (and a marker per
 * perception run), appended to the task's events as `tool.completed`.
 * `verified` is true only for a deterministic required check that passed.
 */
export const WatchEvidenceRecordSchema = z
  .object({
    schema_version: z.literal(1),
    operation: z.literal(WATCH_EVIDENCE_OPERATION),
    kind: z.enum(["loop", "verify", "perception", "doctor"]),
    tool: id,
    verdict: WatchVerdictSchema,
    assurance: WatchAssuranceSchema,
    verified: z.boolean(),
    advisory: z.boolean(),
    loop_id: id.optional(),
    iteration: z.number().int().nonnegative().optional(),
    run_id: id.optional(),
    contract_id: id.optional(),
    contract_digest: z.string().min(1).max(256).optional(),
    signature_status: z.string().min(1).max(128).optional(),
    required_checks: z
      .object({
        passed: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        inconclusive: z.number().int().nonnegative(),
      })
      .strict(),
    limitations: z.array(z.string().max(1024)).max(32),
    summary: z.string().max(2048),
    cli_version: z.string().max(64).nullable(),
    recorded_at: z.string().datetime(),
  })
  .strict()
  .refine(
    (record) =>
      !record.verified ||
      (record.kind === "verify" &&
        record.verdict === "pass" &&
        VERIFIABLE_ASSURANCE.has(record.assurance) &&
        record.required_checks.passed >= 1 &&
        record.required_checks.failed === 0 &&
        record.required_checks.inconclusive === 0),
    { message: "Only a passed deterministic required check may be verified" },
  );
export type WatchEvidenceRecord = z.infer<typeof WatchEvidenceRecordSchema>;

export const WatchDoctorSchema = z
  .object({
    available: z.boolean(),
    version: z.string().nullable(),
    reason: z.string().nullable(),
    checks: z.array(
      z
        .object({
          name: z.string(),
          status: z.enum(["ok", "warn", "fail"]),
          message: z.string(),
        })
        .strict(),
    ),
    checked_at: z.string().datetime(),
  })
  .strict();
export type WatchDoctor = z.infer<typeof WatchDoctorSchema>;

const checkResultSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    required: z.boolean(),
    summary: z.string().optional(),
  })
  .passthrough();

/**
 * `verify run` prints a summary (`checks[]`, top-level `signature_status`);
 * `verify show` prints the stored bundle (`check_results[]` keyed by
 * `check_id`, `attestation.signature_status`). Both normalise to one shape.
 */
function normaliseVerifyResult(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const checks = Array.isArray(record.checks)
    ? record.checks
    : Array.isArray(record.check_results)
      ? record.check_results.map((item) =>
          item && typeof item === "object" && !("id" in item)
            ? {
                ...(item as Record<string, unknown>),
                id: (item as Record<string, unknown>).check_id,
              }
            : item,
        )
      : undefined;
  const attestation = record.attestation;
  const signature =
    record.signature_status ??
    (attestation && typeof attestation === "object"
      ? (attestation as Record<string, unknown>).signature_status
      : undefined);
  return {
    ...record,
    ...(checks ? { checks } : {}),
    ...(typeof signature === "string" ? { signature_status: signature } : {}),
  };
}

/** The upstream `watch-skill verify run` / `verify show` JSON, normalised. */
export const VerifyRunResultSchema = z.preprocess(
  normaliseVerifyResult,
  z
    .object({
      run_id: z.string().min(1),
      verdict: WatchVerdictSchema,
      assurance: WatchAssuranceSchema,
      limitations: z.array(z.string()).default([]),
      signature_status: z.string().optional(),
      checks: z.array(checkResultSchema).default([]),
    })
    .passthrough(),
);
export type VerifyRunResult = z.infer<typeof VerifyRunResultSchema>;

/** The upstream `{error, message, fix, details}` failure envelope. */
export const CliErrorSchema = z
  .object({
    error: z.string(),
    message: z.string(),
    fix: z.string().optional(),
  })
  .passthrough();

/** A verification contract as accepted by `watch-skill verify run`. */
export const VerificationContractInputSchema = z
  .object({
    contract_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
    title: z.string().min(1).max(512),
    checks: z
      .array(
        z
          .object({
            id: z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/),
            type: z.string().min(1).max(64),
            required: z.boolean().optional(),
            description: z.string().max(1024).optional(),
            params: z.record(z.unknown()).optional(),
            timeout_seconds: z.number().positive().max(600).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(64),
    required_assurance: WatchAssuranceSchema.exclude(["none"]).optional(),
    allowed_origins: z.array(z.string().max(512)).max(16).optional(),
  })
  .passthrough();
export type VerificationContractInput = z.infer<
  typeof VerificationContractInputSchema
>;

/** Persisted loop state (`<data>/loops/<loop_id>/state.json`). */
export const LoopStateSchema = z
  .object({
    loop_id: z.string().min(1),
    status: z.string(),
    max_iterations: z.number().int().positive().optional(),
    iterations: z
      .array(
        z
          .object({
            n: z.number().int().nonnegative(),
            critique: z
              .object({
                verdict: z.string().optional(),
                score: z.number().optional(),
                summary: z.string().optional(),
              })
              .passthrough(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();
