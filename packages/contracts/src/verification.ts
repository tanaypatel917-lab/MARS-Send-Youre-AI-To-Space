import { z } from "zod";

/**
 * Host-owned verification verdicts. A task's execution status (`completed`)
 * only says the agent stopped normally; whether the requested output exists
 * is decided by the workbench host against required checks fixed at launch,
 * outside the model's control, and bound to one immutable candidate revision.
 */

const relativePath = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.startsWith("\\") &&
      !/^[A-Za-z]:/.test(path) &&
      path
        .split(/[\\/]/)
        .every(
          (segment) => segment !== "" && segment !== "." && segment !== "..",
        ),
    {
      message: "Required check paths are relative, normalised workspace paths",
    },
  );

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const REQUIRED_CHECK_DEFAULT_TIMEOUT_MS = 10_000;
export const REQUIRED_CHECK_MAX_TIMEOUT_MS = 60_000;

/**
 * One check the host runs after the agent stops. `file_content` passes when
 * `path` exists in the candidate workspace and its bytes match `sha256` (or
 * the UTF-8 encoding of `content`, from which the digest is derived).
 */
export const RequiredCheckSchema = z
  .object({
    kind: z.literal("file_content"),
    path: relativePath,
    sha256: sha256.optional(),
    content: z
      .string()
      .max(64 * 1024)
      .optional(),
    timeout_ms: z
      .number()
      .int()
      .positive()
      .max(REQUIRED_CHECK_MAX_TIMEOUT_MS)
      .optional(),
  })
  .strict()
  .refine(
    (check) => check.sha256 !== undefined || check.content !== undefined,
    {
      message: "A file_content check needs sha256 or content",
    },
  );
export type RequiredCheck = z.infer<typeof RequiredCheckSchema>;

export const VerificationVerdictSchema = z.enum([
  "passed",
  "failed",
  "inconclusive",
]);
export type VerificationVerdict = z.infer<typeof VerificationVerdictSchema>;

export const VerificationCandidateSchema = z
  .object({
    workspace_id: z.string().min(1).max(256),
    provider: z.string().min(1).max(256),
    revision: z.string().min(1).max(256),
  })
  .strict();
export type VerificationCandidate = z.infer<typeof VerificationCandidateSchema>;

export const VerificationCheckResultSchema = z
  .object({
    kind: z.literal("file_content"),
    path: relativePath,
    expected_sha256: sha256,
    observed_sha256: sha256.nullable(),
    status: VerificationVerdictSchema,
    reason: z.string().max(1024).nullable(),
    duration_ms: z.number().int().nonnegative(),
  })
  .strict();
export type VerificationCheckResult = z.infer<
  typeof VerificationCheckResultSchema
>;

export const VERIFICATION_EVIDENCE_OPERATION = "verification.verdict";

/**
 * The persisted verdict for one run against one candidate revision, appended
 * to the task's events as `tool.completed` by `@mars/workbench`. `verified`
 * is true only when every required check passed for exactly `candidate`.
 * `candidate` is null only when the host could not acquire the candidate
 * revision at all; such a record is always `inconclusive` and carries no
 * check results.
 */
export const VerificationEvidenceRecordSchema = z
  .object({
    schema_version: z.literal(1),
    operation: z.literal(VERIFICATION_EVIDENCE_OPERATION),
    run_id: z.string().min(1).max(256),
    task_id: z.string().min(1).max(256),
    task_revision: z.number().int().nonnegative(),
    candidate: VerificationCandidateSchema.nullable(),
    verdict: VerificationVerdictSchema,
    verified: z.boolean(),
    checks: z.array(VerificationCheckResultSchema).max(64),
    reasons: z.array(z.string().max(1024)).max(64),
    /** Observations about the run that never change the verdict (e.g. a tool call emitted as text). */
    diagnostics: z.array(z.string().max(1024)).max(16),
    duration_ms: z.number().int().nonnegative(),
    recorded_at: z.string().datetime({ offset: true }),
  })
  .strict()
  .refine(
    (record) =>
      record.verified ===
      (record.candidate !== null &&
        record.verdict === "passed" &&
        record.checks.length >= 1 &&
        record.checks.every((check) => check.status === "passed")),
    {
      message:
        "verified is exactly: a candidate, verdict passed and every required check passed",
    },
  )
  .refine(
    (record) =>
      record.candidate !== null ||
      (record.verdict === "inconclusive" && record.checks.length === 0),
    {
      message:
        "A record without a candidate is an inconclusive verdict with no check results",
    },
  )
  .refine((record) => record.candidate === null || record.checks.length >= 1, {
    message: "A verdict on a candidate needs at least one check result",
  });
export type VerificationEvidenceRecord = z.infer<
  typeof VerificationEvidenceRecordSchema
>;

/**
 * What a client may show for a candidate: `verified` only for a passed
 * verdict on the exact candidate revision; `failed`/`inconclusive` for the
 * latest verdict on that revision; `stale` when evidence exists only for a
 * different revision (or no candidate can be presented); `unverified` when
 * no verdict was ever recorded.
 */
export const VerificationStateSchema = z.enum([
  "verified",
  "failed",
  "inconclusive",
  "unverified",
  "stale",
]);
export type VerificationState = z.infer<typeof VerificationStateSchema>;

export const VERIFICATION_STATE_LABEL: Record<VerificationState, string> = {
  verified: "Verified",
  failed: "Verification failed",
  inconclusive: "Verification inconclusive",
  unverified: "Unverified",
  stale: "Verification stale",
};

export interface VerificationPresentation {
  state: VerificationState;
  /** The record the state was derived from; null for `unverified`. */
  record: VerificationEvidenceRecord | null;
  reasons: string[];
}

function latest(
  records: readonly VerificationEvidenceRecord[],
): VerificationEvidenceRecord | null {
  let chosen: VerificationEvidenceRecord | null = null;
  for (const record of records)
    if (!chosen || record.recorded_at >= chosen.recorded_at) chosen = record;
  return chosen;
}

/**
 * The single presentation rule every MARS surface applies before it claims
 * verification. Pure: it never reads the workspace or the store.
 */
export function verificationStateFor(
  candidateRevision: string | null,
  records: readonly VerificationEvidenceRecord[],
): VerificationPresentation {
  if (records.length === 0)
    return { state: "unverified", record: null, reasons: [] };
  // A record without a candidate (the host could not acquire the revision)
  // is an inconclusive verdict about whatever candidate is presented.
  const matching = records.filter(
    (record) =>
      record.candidate === null ||
      (candidateRevision !== null &&
        record.candidate.revision === candidateRevision),
  );
  const current = latest(matching);
  if (!current) {
    const previous = latest(records);
    return {
      state: "stale",
      record: previous,
      reasons: [
        candidateRevision === null
          ? "No candidate revision is available to compare with the recorded verdict"
          : `Recorded verdict is bound to revision ${previous?.candidate?.revision ?? "unknown"}, not the presented candidate`,
      ],
    };
  }
  if (current.verified)
    return { state: "verified", record: current, reasons: [] };
  return {
    state: current.verdict === "failed" ? "failed" : "inconclusive",
    record: current,
    reasons: [...current.reasons],
  };
}

/** Result of `tasks.verification`: the current candidate and every persisted verdict. */
export const VerificationViewSchema = z
  .object({
    candidate: VerificationCandidateSchema.nullable(),
    state: VerificationStateSchema,
    record: VerificationEvidenceRecordSchema.nullable(),
    reasons: z.array(z.string().max(1024)).max(64),
    records: z.array(VerificationEvidenceRecordSchema).max(50),
  })
  .strict();
export type VerificationView = z.infer<typeof VerificationViewSchema>;
