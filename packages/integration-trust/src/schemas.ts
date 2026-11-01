import type { Scope } from "@mars/contracts";
import { ScopeSchema } from "@mars/contracts";
import { z } from "zod";
import { canonicalJSON, sha256 } from "./canonical";
import { fail } from "./errors";
export const SlugSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
export const CodeSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
export const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export function isOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      value === url.origin &&
      !url.hostname.endsWith(".") &&
      !url.username &&
      !url.password &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    );
  } catch {
    return false;
  }
}
export const OriginSchema = z.string().refine(isOrigin);
export const KindSchema = z.enum(["mcp", "connector", "plugin", "skill"]);
export type Kind = z.infer<typeof KindSchema>;
export const IdentitySchema = z
  .object({
    kind: KindSchema,
    integration_id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
  })
  .strict();
export type Identity = z.infer<typeof IdentitySchema>;
const source = z
  .object({
    type: z.enum(["git", "package", "local-artifact", "remote-endpoint"]),
    locator: z.string().min(1),
    revision: z.string().nullable(),
    content_sha256: DigestSchema.nullable(),
  })
  .strict()
  .superRefine((s, c) => {
    if (
      s.type !== "remote-endpoint" &&
      (s.content_sha256 === null || s.revision === null)
    )
      c.addIssue({ code: "custom", message: "missing_digest" });
    if (
      s.revision !== null &&
      !(
        s.type === "package"
          ? /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
          : /^[a-f0-9]{40}$/
      ).test(s.revision)
    )
      c.addIssue({ code: "custom", message: "revision" });
  });
export const SourceEvidenceSchema = IdentitySchema.extend({
  schema_version: z.literal(1),
  source,
  dependency_sha256: DigestSchema,
  config_sha256: DigestSchema,
  endpoint: z
    .object({ origin: OriginSchema, descriptor_sha256: DigestSchema })
    .strict()
    .nullable(),
  tools: z.array(
    z
      .object({
        name: CodeSchema,
        input_schema_sha256: DigestSchema,
        output_schema_sha256: DigestSchema.nullable(),
      })
      .strict(),
  ),
  observed_at: z.string().datetime({ offset: true }),
})
  .strict()
  .superRefine((e, c) => {
    if (e.source.type === "remote-endpoint" && !e.endpoint)
      c.addIssue({ code: "custom", message: "endpoint" });
    if (e.tools.some((t, i) => i > 0 && (e.tools[i - 1]?.name ?? "") >= t.name))
      c.addIssue({ code: "custom", message: "tools_order" });
  });
export type SourceEvidence = z.infer<typeof SourceEvidenceSchema>;
export function parseEvidence(value: unknown): SourceEvidence {
  const r = SourceEvidenceSchema.safeParse(value);
  if (!r.success) fail("malformed_evidence");
  return r.data;
}
export const PermissionSchema = z
  .object({
    capability: z.enum([
      "fs.read",
      "fs.write",
      "process.spawn",
      "network.connect",
      "credential.use",
      "tool.invoke",
      "model.invoke",
    ]),
    resource: z.string().min(1),
  })
  .strict();
export type Permission = z.infer<typeof PermissionSchema>;
export const PermissionManifestSchema = z
  .object({ permissions: z.array(PermissionSchema).max(64) })
  .strict();
export type PermissionManifest = z.infer<typeof PermissionManifestSchema>;
export const CredentialBindingSchema = z
  .object({ ref_id: SlugSchema, allowed_origin: OriginSchema })
  .strict();
export type CredentialBinding = z.infer<typeof CredentialBindingSchema>;
export const ScanRecordSchema = z
  .object({
    scanner_id: SlugSchema,
    status: z.enum(["ok", "error", "unavailable"]),
    score: z.number().finite().optional(),
    findings: z.array(CodeSchema).max(128),
    observed_at: z.string().datetime({ offset: true }),
    binding_sha256: DigestSchema,
  })
  .strict();
export type ScanRecord = z.infer<typeof ScanRecordSchema>;
export type Decision =
  | "pending"
  | "approved"
  | "denied"
  | "revoked"
  | "superseded"
  | "expired";
export interface Review {
  review_id: string;
  revision: number;
  scope: Scope;
  kind: Kind;
  integration_id: string;
  evidence: SourceEvidence;
  permissions: Permission[];
  credential_bindings: CredentialBinding[];
  binding_sha256: string;
  state: Decision;
  expires_at: string;
  scans: ScanRecord[];
}
export interface Grant extends Omit<Review, "scans"> {
  grant_id: string;
  approved_by: string;
  approved_at: string;
}
export interface AuditEventInput {
  at: string;
  type: string;
  scope: Scope;
  kind: Kind;
  integration_id: string;
  review_id?: string | undefined;
  grant_id?: string | undefined;
  actor: string;
  reason_code: string;
  binding_sha256: string;
}
export interface AuditEvent extends AuditEventInput {
  seq: number;
  event_id: string;
  prev_sha256: string;
  sha256: string;
}
export interface TrustState {
  reviews: Review[];
  grants: Grant[];
  consumed_nonces: string[];
  events: AuditEvent[];
}
export function scopeKey(scope: Scope): string {
  return canonicalJSON({
    ...ScopeSchema.parse(scope),
    workspace_id: scope.workspace_id ?? null,
  });
}
export function binding(
  scope: Scope,
  e: SourceEvidence,
  permissions: Permission[],
  credential_bindings: CredentialBinding[],
): string {
  return sha256(
    canonicalJSON({
      scope: JSON.parse(scopeKey(scope)),
      kind: e.kind,
      integration_id: e.integration_id,
      source: e.source,
      dependency_sha256: e.dependency_sha256,
      config_sha256: e.config_sha256,
      endpoint: e.endpoint,
      tools: e.tools,
      permissions,
      credential_bindings,
    }),
  );
}
