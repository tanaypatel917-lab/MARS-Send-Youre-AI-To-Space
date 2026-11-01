export const COLLABORATION_ERROR_CODES = [
  "invalid_input",
  "forbidden",
  "not_found",
  "conflict",
  "stale_revision",
  "stale_base",
  "backpressure",
  "budget_exceeded",
  "limit_exceeded",
  "loop_limit",
  "expired",
  "cancelled",
  "lease_lost",
  "usage_unaccounted",
  "single_agent",
  "write_conflict",
  "unsafe_content",
  "recursive_delegation",
  "unknown_cursor",
  "closed",
  "corrupt_record",
] as const;

export type CollaborationErrorCode = (typeof COLLABORATION_ERROR_CODES)[number];

export class CollaborationError extends Error {
  readonly code: CollaborationErrorCode;

  constructor(code: CollaborationErrorCode, message: string) {
    super(message);
    this.name = "CollaborationError";
    this.code = code;
  }
}

export function collaborationError(
  code: CollaborationErrorCode,
  message: string,
): CollaborationError {
  return new CollaborationError(code, message);
}
