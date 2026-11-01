export type ErrorCode =
  | "config_invalid"
  | "malformed_evidence"
  | "ambiguous_permission"
  | "unknown_integration"
  | "no_grant"
  | "not_pending"
  | "revision_conflict"
  | "approval_invalid"
  | "replayed_approval"
  | "scope_mismatch"
  | "expired"
  | "revoked"
  | "drift"
  | "stale_evidence"
  | "evidence_unavailable"
  | "scanner_unavailable"
  | "permission_denied"
  | "credential_denied"
  | "endpoint_mismatch"
  | "delegation_depth_exceeded"
  | "store_corrupt"
  | "store_location_unsafe";
export class IntegrationTrustError extends Error {
  constructor(public readonly code: ErrorCode) {
    super(code);
    this.name = "IntegrationTrustError";
  }
}
export function fail(code: ErrorCode): never {
  throw new IntegrationTrustError(code);
}
