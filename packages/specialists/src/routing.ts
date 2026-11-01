import { decisionDigest } from "./canonical";
import { SpecialistRegistryError } from "./errors";
import type {
  ReasonCode,
  ResolveFallbackResult,
  RoutingDecision,
  SelectedTarget,
} from "./schemas";
import { RoutingDecisionSchema } from "./schemas";

export interface RankedCandidate {
  ref: string;
  specialist_id: string;
  revision: string;
  pass_rate: number;
  cost_usd_per_task: number | null;
  runtime_ms_p95: number | null;
}

function compareNullableAscending(
  left: number | null,
  right: number | null,
): number {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left - right;
}

export function rankCandidates<T extends RankedCandidate>(items: T[]): T[] {
  return [...items].sort(
    (left, right) =>
      right.pass_rate - left.pass_rate ||
      compareNullableAscending(
        left.cost_usd_per_task,
        right.cost_usd_per_task,
      ) ||
      compareNullableAscending(left.runtime_ms_p95, right.runtime_ms_p95) ||
      left.specialist_id.localeCompare(right.specialist_id) ||
      left.revision.localeCompare(right.revision),
  );
}

export function resolveFallbackChain(
  start: string,
  lookup: (ref: string) => string | null | undefined,
  maxDepth = 8,
): ResolveFallbackResult {
  const chain: string[] = [];
  const visited = new Set<string>();
  let current: string | null | undefined = start;
  while (current !== null) {
    if (current === undefined) {
      return { chain, error: "fallback_target_missing" };
    }
    if (visited.has(current)) return { chain, error: "fallback_cycle" };
    if (chain.length >= maxDepth) {
      return { chain, error: "fallback_depth_exceeded" };
    }
    visited.add(current);
    chain.push(current);
    current = lookup(current);
  }
  return { chain, error: null };
}

export function normalizeReasons(reasons: Iterable<ReasonCode>): ReasonCode[] {
  return [...new Set(reasons)].sort();
}

export function makeRoutingDecision(
  input: Omit<RoutingDecision, "decision_sha256">,
): RoutingDecision {
  const provisional = {
    ...input,
    decision_sha256: "0".repeat(64),
  };
  const decision_sha256 = decisionDigest(
    provisional as unknown as Record<string, unknown>,
  );
  const parsed = RoutingDecisionSchema.safeParse({
    ...provisional,
    decision_sha256,
  });
  if (!parsed.success) {
    throw new SpecialistRegistryError("invalid_input", "decision_schema");
  }
  return parsed.data;
}

export function selectedRef(target: SelectedTarget): string {
  return target.ref;
}
