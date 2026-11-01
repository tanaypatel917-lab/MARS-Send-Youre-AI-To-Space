export type ResearchErrorCode =
  | "invalid_input"
  | "not_found"
  | "conflict"
  | "stale_revision"
  | "invalid_state"
  | "backpressure"
  | "lease_lost"
  | "cancelled"
  | "deadline_exceeded"
  | "budget_exceeded"
  | "citation_rejected"
  | "finding_limit"
  | "corrupt_record"
  | "unsafe_path"
  | "closed";

export class ResearchError extends Error {
  readonly code: ResearchErrorCode;

  constructor(code: ResearchErrorCode, message: string) {
    super(message);
    this.name = "ResearchError";
    this.code = code;
  }
}

export function researchError(
  code: ResearchErrorCode,
  message: string,
): ResearchError {
  return new ResearchError(code, message);
}

export function throwResearchError(
  code: ResearchErrorCode,
  message: string,
): never {
  throw researchError(code, message);
}
