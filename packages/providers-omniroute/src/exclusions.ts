import type { CatalogEntry, FreeTierCatalog, TermsVerdict } from "./catalog";

/**
 * Default-off exclusions. Everything here is excluded unless the operator
 * opts in explicitly; the reasons are documented in the package README.
 */
export interface ExclusionOverrides {
  /** Route through pasted consumer logins (ChatGPT Web, Claude Web, ...). */
  allowWebSession?: boolean;
  /** Route through anonymous / reverse-engineered browser transports. */
  allowBrowserSession?: boolean;
  /**
   * Terms verdicts other than `ok` to route through. `avoid` can be listed
   * but is still refused: OmniRoute itself keeps it out of automatic routing.
   */
  allowTermsRisk?: Exclude<TermsVerdict, "ok">[];
}

export type ExclusionReason =
  | "discontinued"
  | "web-session"
  | "browser-session"
  | "terms-risk-avoid"
  | "terms-risk";

export function exclusionReasons(
  entry: CatalogEntry,
  overrides: ExclusionOverrides = {},
): ExclusionReason[] {
  const reasons: ExclusionReason[] = [];
  if (!entry.grants_free_access) reasons.push("discontinued");
  if (entry.access === "web-session" && !overrides.allowWebSession)
    reasons.push("web-session");
  if (entry.access === "browser-session" && !overrides.allowBrowserSession)
    reasons.push("browser-session");
  const verdict = entry.terms_risk.verdict;
  if (verdict === "avoid") reasons.push("terms-risk-avoid");
  else if (verdict !== "ok" && !overrides.allowTermsRisk?.includes(verdict))
    reasons.push("terms-risk");
  return reasons;
}

export function isRoutable(
  entry: CatalogEntry,
  overrides: ExclusionOverrides = {},
): boolean {
  return exclusionReasons(entry, overrides).length === 0;
}

export interface ExclusionSummary {
  total: number;
  routable: number;
  excluded: number;
  by_reason: Record<ExclusionReason, number>;
}

export function summarizeExclusions(
  catalog: FreeTierCatalog,
  overrides: ExclusionOverrides = {},
): ExclusionSummary {
  const by_reason: Record<ExclusionReason, number> = {
    discontinued: 0,
    "web-session": 0,
    "browser-session": 0,
    "terms-risk-avoid": 0,
    "terms-risk": 0,
  };
  let routable = 0;
  for (const entry of catalog.entries) {
    const reasons = exclusionReasons(entry, overrides);
    if (reasons.length === 0) routable += 1;
    for (const reason of reasons) by_reason[reason] += 1;
  }
  return {
    total: catalog.entries.length,
    routable,
    excluded: catalog.entries.length - routable,
    by_reason,
  };
}
