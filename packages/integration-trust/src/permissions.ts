import { fail } from "./errors";
import type { Permission, SourceEvidence } from "./schemas";
import { isOrigin, PermissionSchema, SlugSchema } from "./schemas";
export function normalizePermission(
  value: unknown,
  evidence?: SourceEvidence,
): Permission {
  const result = PermissionSchema.safeParse(value);
  if (!result.success) fail("ambiguous_permission");
  const p = result.data,
    r = p.resource;
  if (/[^\x21-\x7e]|[*?~\\]/.test(r)) fail("ambiguous_permission");
  if (p.capability === "network.connect") {
    if (!isOrigin(r) || (evidence?.endpoint && evidence.endpoint.origin !== r))
      fail("ambiguous_permission");
  } else if (p.capability.startsWith("fs.")) {
    if (r.split("/").some((s) => !s || s === "." || s === ".."))
      fail("ambiguous_permission");
  } else if (p.capability === "tool.invoke") {
    if (!evidence?.tools.some((t) => t.name === r))
      fail("ambiguous_permission");
  } else if (!SlugSchema.safeParse(r).success) fail("ambiguous_permission");
  return p;
}
export function normalizePermissions(
  values: Permission[],
  evidence: SourceEvidence,
): Permission[] {
  if (!Array.isArray(values) || values.length > 64)
    fail("ambiguous_permission");
  const result = values
    .map((p) => normalizePermission(p, evidence))
    .sort((a, b) =>
      `${a.capability}:${a.resource}` < `${b.capability}:${b.resource}`
        ? -1
        : 1,
    );
  if (new Set(result.map((p) => JSON.stringify(p))).size !== result.length)
    fail("ambiguous_permission");
  if (
    ["mcp", "connector"].includes(evidence.kind) &&
    result.some((p) => p.capability === "network.connect") &&
    !evidence.endpoint
  )
    fail("malformed_evidence");
  return result;
}
// Exact pairs only: filesystem paths do not grant descendants.
export function isSubset(
  requested: Permission[],
  granted: Permission[],
): boolean {
  return requested.every((p) =>
    granted.some(
      (g) => g.capability === p.capability && g.resource === p.resource,
    ),
  );
}
