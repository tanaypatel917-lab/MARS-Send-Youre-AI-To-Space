import { z } from "zod";
import { ArtifactRefSchema } from "./core";

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

const checkTimeout = z
  .number()
  .int()
  .positive()
  .max(REQUIRED_CHECK_MAX_TIMEOUT_MS)
  .optional();

/** Identifier of a host-defined check (`HostCheckDefinition.id`). */
export const HostCheckIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

/**
 * One check the host runs after the agent stops. `file_content` passes when
 * `path` exists in the candidate workspace and its bytes match `sha256` (or
 * the UTF-8 encoding of `content`, from which the digest is derived).
 */
export const FileContentCheckSchema = z
  .object({
    kind: z.literal("file_content"),
    path: relativePath,
    sha256: sha256.optional(),
    content: z
      .string()
      .max(64 * 1024)
      .optional(),
    timeout_ms: checkTimeout,
  })
  .strict()
  .refine(
    (check) => check.sha256 !== undefined || check.content !== undefined,
    {
      message: "A file_content check needs sha256 or content",
    },
  );

/**
 * A protected test the host defines and resolves outside the candidate's
 * writable tree. A client only names it by `check_id`; the command, the
 * protected files and the expected result never travel in the request.
 * Launch freezes the definition digest so a changed definition cannot
 * vouch for an earlier run.
 */
export const HostTestCheckSchema = z
  .object({
    kind: z.literal("host_test"),
    check_id: HostCheckIdSchema,
    /** Set by the host at launch; ignored (recomputed) when a client sends it. */
    definition_sha256: sha256.optional(),
    timeout_ms: checkTimeout,
  })
  .strict();

export const RequiredCheckSchema = z.union([
  FileContentCheckSchema,
  HostTestCheckSchema,
]);
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
    kind: z.enum(["file_content", "host_test"]),
    /** The checked file, or for `host_test` the check id. */
    path: relativePath,
    /** `host_test` only: the definition id, exit code and captured output digest. */
    check_id: HostCheckIdSchema.optional(),
    exit_code: z.number().int().optional(),
    output_sha256: sha256.optional(),
    output_tail: z.string().max(600).optional(),
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
    /**
     * Raw SHA-256 of the exact patch bytes (concatenated file patches) the checks ran
     * against. Optional so records written before it existed still parse;
     * such records bind to the revision only.
     */
    patch_sha256: sha256.optional(),
    /** Digest of the frozen required-check manifest the verdict answers. */
    check_manifest_sha256: sha256.optional(),
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
  /** Digest of the patch presented with the candidate; a record bound to other bytes is stale. */
  candidatePatchSha256?: string | null,
): VerificationPresentation {
  if (records.length === 0)
    return { state: "unverified", record: null, reasons: [] };
  // A record without a candidate (the host could not acquire the revision)
  // is an inconclusive verdict about whatever candidate is presented.
  const matching = records.filter(
    (record) =>
      record.candidate === null ||
      (candidateRevision !== null &&
        record.candidate.revision === candidateRevision &&
        (record.patch_sha256 === undefined ||
          candidatePatchSha256 === undefined ||
          record.patch_sha256 === candidatePatchSha256)),
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
    /** Raw SHA-256 of the candidate's current patch bytes; null when no patch could be read. */
    patch_sha256: sha256.nullable().optional(),
  })
  .strict();
export type VerificationView = z.infer<typeof VerificationViewSchema>;

/** What `workbench.describe` advertises about a host check: never its command or files. */
export const HostCheckSummarySchema = z
  .object({
    id: HostCheckIdSchema,
    label: z.string().min(1).max(200),
    description: z.string().max(1024).optional(),
  })
  .strict();
export type HostCheckSummary = z.infer<typeof HostCheckSummarySchema>;

/**
 * Result of `tasks.export`: the exact patch bytes of the current candidate,
 * stored as a content-addressed artifact, with the host verdict for exactly
 * that candidate and a host-run reconstruction proof (baseline copy +
 * `git apply --check` + `git apply` + byte comparison).
 */
export const PatchExportSchema = z
  .object({
    candidate: VerificationCandidateSchema,
    patch_sha256: sha256,
    artifact: ArtifactRefSchema,
    files: z.number().int().nonnegative(),
    /** Host verdict for exactly this candidate and these bytes. */
    verification: VerificationStateSchema,
    verified: z.boolean(),
    verdict_run_id: z.string().min(1).max(256).nullable(),
    handoff: z
      .object({
        source_baseline: z.enum(["matches", "mismatch", "unavailable"]),
        verdict: VerificationEvidenceRecordSchema,
      })
      .strict()
      .optional(),
    round_trip: z
      .object({
        status: z.enum(["passed", "failed", "unavailable"]),
        reason: z.string().max(1024).nullable(),
      })
      .strict(),
    /** Files the patch cannot carry (symlinks, special files, ignored secrets). */
    unsupported: z
      .array(
        z
          .object({
            path: z.string().min(1).max(4096),
            reason: z.string().max(64),
          })
          .strict(),
      )
      .max(1000),
  })
  .strict()
  .refine((value) => value.artifact.sha256 === value.patch_sha256, {
    message: "The export artifact is the exact patch bytes",
  })
  .refine((value) => !value.verified || value.verification === "verified", {
    message: "Only a verified candidate may be exported as verified",
  });
export type PatchExport = z.infer<typeof PatchExportSchema>;
