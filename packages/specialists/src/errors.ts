import type { RoutingDecision } from "./schemas";

export type SpecialistRegistryErrorCode =
  | "invalid_input"
  | "not_found"
  | "scope_denied"
  | "conflict"
  | "stale_revision"
  | "invalid_state"
  | "evaluation_unavailable"
  | "fallback_after_side_effects"
  | "baseline_selected"
  | "no_eligible_target"
  | "unsafe_path"
  | "unsafe_content"
  | "corrupt_record"
  | "closed";

export class SpecialistRegistryError extends Error {
  readonly code: SpecialistRegistryErrorCode;
  readonly detail?: string;
  readonly decision?: RoutingDecision;

  constructor(
    code: SpecialistRegistryErrorCode,
    detail?: string,
    decision?: RoutingDecision,
  ) {
    super(detail === undefined ? code : `${code}:${detail}`);
    this.name = "SpecialistRegistryError";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
    if (decision !== undefined) this.decision = decision;
  }
}

export function fail(
  code: SpecialistRegistryErrorCode,
  detail?: string,
): never {
  throw new SpecialistRegistryError(code, detail);
}
