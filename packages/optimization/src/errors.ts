export type OptimizationErrorCode =
  | "invalid_input"
  | "artifact_missing"
  | "artifact_digest_mismatch"
  | "artifact_malformed"
  | "record_malformed"
  | "target_not_found"
  | "target_exists"
  | "candidate_not_found"
  | "job_not_found"
  | "job_not_finished"
  | "invalid_transition"
  | "worker_unavailable"
  | "scope_mismatch";

export class OptimizationError extends Error {
  constructor(
    readonly code: OptimizationErrorCode,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "OptimizationError";
  }
}
