import { createHash } from "node:crypto";

function canonicalValue(value: unknown, seen = new Set<object>()): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error("invalid_json");
    seen.add(value);
    const result = value.map((item) => canonicalValue(item, seen));
    seen.delete(value);
    return result;
  }
  if (
    value !== null &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    if (seen.has(value)) throw new Error("invalid_json");
    seen.add(value);
    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (record[key] === undefined) continue;
      result[key] = canonicalValue(record[key], seen);
    }
    seen.delete(value);
    return result;
  }
  throw new Error("invalid_json");
}

/** Sorted-key JSON without undefined members; stable across host and worker. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Candidate ids are content-addressed so the same components always map to one record. */
export function candidateId(components: Record<string, string>): string {
  return `cand-${sha256(canonicalJson(components)).slice(0, 24)}`;
}

export function scopeKey(scope: {
  owner_id: string;
  project_id: string;
  workspace_id?: string | undefined;
}): string {
  return sha256(
    canonicalJson({
      owner_id: scope.owner_id,
      project_id: scope.project_id,
      workspace_id: scope.workspace_id ?? null,
    }),
  ).slice(0, 32);
}
