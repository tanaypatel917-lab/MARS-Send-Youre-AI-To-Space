import { randomUUID } from "node:crypto";
import type { RequestContext } from "@mars/contracts";
import { ScopeSchema } from "@mars/contracts";
import { z } from "zod";
import type { ApprovalChallenge, HostApprovalAuthorizer } from "./authorizer";
import { canonicalJSON, frozenClone } from "./canonical";
import { fail, IntegrationTrustError } from "./errors";
import { isSubset, normalizePermissions } from "./permissions";
import type {
  AuditEventInput,
  CredentialBinding,
  Grant,
  Identity,
  Permission,
  Review,
  ScanRecord,
  SourceEvidence,
  TrustState,
} from "./schemas";
import {
  binding,
  CodeSchema,
  CredentialBindingSchema,
  IdentitySchema,
  parseEvidence,
  ScanRecordSchema,
  scopeKey,
} from "./schemas";
import type { TrustStore } from "./store";
export interface EvidenceProbe {
  observe(ctx: RequestContext, identity: Identity): Promise<SourceEvidence>;
}
export interface CallerCapabilities {
  permissions: Permission[];
  delegation_depth: number;
}
export interface AuthorizedArtifact {
  grant_id: string;
  binding_sha256: string;
  evidence: SourceEvidence;
  permissions: Permission[];
}
export interface AuthorizedInvocation extends AuthorizedArtifact {
  tool: string;
  input: unknown;
  target_origin?: string;
  credential_ref?: string;
}
interface Candidate {
  evidence: SourceEvidence;
  permissions: Permission[];
  credential_bindings: CredentialBinding[];
}
interface ApprovalRequest {
  review_id: string;
  expected_revision: number;
  proof: unknown;
  ttl_ms?: number;
}
interface InvokeRequest extends Identity {
  tool: string;
  permissions: Permission[];
  target_origin?: string;
  credential_ref?: string;
  input: unknown;
  caller: CallerCapabilities;
}
export interface IntegrationTrustAdmin {
  submitCandidate(ctx: RequestContext, input: Candidate): Promise<Review>;
  attachScan(
    ctx: RequestContext,
    review_id: string,
    scan: ScanRecord,
  ): Promise<void>;
  approve(ctx: RequestContext, input: ApprovalRequest): Promise<Grant>;
  deny(
    ctx: RequestContext,
    input: Omit<ApprovalRequest, "ttl_ms">,
  ): Promise<void>;
  revoke(
    ctx: RequestContext,
    input: { grant_id: string; expected_revision: number; proof: unknown },
  ): Promise<void>;
  inspect(
    ctx: RequestContext,
    identity: Identity,
  ): Promise<{ reviews: Review[]; grants: Grant[] }>;
  history(
    ctx: RequestContext,
    filter?: Partial<Identity>,
  ): Promise<TrustState["events"]>;
}
export interface IntegrationGate {
  admit<T>(
    ctx: RequestContext,
    req: Identity & { action: "load" | "install" | "enable" },
    loader: (artifact: AuthorizedArtifact) => Promise<T>,
  ): Promise<T>;
  invoke<T>(
    ctx: RequestContext,
    req: InvokeRequest,
    callback: (action: AuthorizedInvocation) => Promise<T>,
  ): Promise<T>;
}
export interface IntegrationTrustOptions {
  store: TrustStore;
  authorizer: HostApprovalAuthorizer;
  probe: EvidenceProbe;
  clock?: () => Date;
  policy?: {
    maxEvidenceAgeMs?: number;
    maxGrantTtlMs?: number;
    remoteEndpointMaxGrantTtlMs?: number;
    requiredScanners?: string[];
    maxDelegationDepth?: number;
  };
}
const ContextSchema = z
  .object({
    schema_version: z.literal(1),
    scope: ScopeSchema,
    request_id: z.string().min(1),
  })
  .strict();
export function createIntegrationTrust(options: IntegrationTrustOptions): {
  admin: IntegrationTrustAdmin;
  gate: IntegrationGate;
} {
  if (
    !options?.store?.load ||
    !options.store.commit ||
    !options.authorizer?.verify ||
    !options.probe?.observe
  )
    fail("config_invalid");
  const { store, authorizer, probe } = options,
    clock = options.clock ?? (() => new Date());
  const policy = {
    maxEvidenceAgeMs: 900000,
    maxGrantTtlMs: 30 * 86400000,
    remoteEndpointMaxGrantTtlMs: 86400000,
    requiredScanners: [] as string[],
    maxDelegationDepth: 2,
    ...options.policy,
  };
  for (const n of [
    policy.maxEvidenceAgeMs,
    policy.maxGrantTtlMs,
    policy.remoteEndpointMaxGrantTtlMs,
    policy.maxDelegationDepth,
  ])
    if (!Number.isSafeInteger(n) || n < 0) fail("config_invalid");
  if (
    policy.maxGrantTtlMs > 90 * 86400000 ||
    policy.remoteEndpointMaxGrantTtlMs > 7 * 86400000 ||
    !policy.requiredScanners.every((s) => CodeSchema.safeParse(s).success)
  )
    fail("config_invalid");
  function context(value: RequestContext) {
    const parsed = ContextSchema.safeParse(value);
    if (!parsed.success) fail("scope_mismatch");
    return frozenClone(parsed.data);
  }
  function matches(ctx: RequestContext, id: Identity, r: Review | Grant) {
    return (
      scopeKey(ctx.scope) === scopeKey(r.scope) &&
      r.kind === id.kind &&
      r.integration_id === id.integration_id
    );
  }
  function fresh(e: SourceEvidence) {
    const age = clock().getTime() - Date.parse(e.observed_at);
    if (age > policy.maxEvidenceAgeMs || age < -60000) fail("stale_evidence");
  }
  async function observe(ctx: RequestContext, id: Identity) {
    let e: SourceEvidence;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      e = parseEvidence(
        await Promise.race([
          Promise.resolve().then(() => probe.observe(ctx, frozenClone(id))),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("evidence_unavailable")),
              2000,
            );
          }),
        ]),
      );
    } catch {
      fail("evidence_unavailable");
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (e.kind !== id.kind || e.integration_id !== id.integration_id)
      fail("evidence_unavailable");
    fresh(e);
    return e;
  }
  function event(
    ctx: RequestContext,
    r: Review | Grant,
    type: string,
    actor = "host",
    reason_code = "ok",
  ): AuditEventInput {
    return {
      at: clock().toISOString(),
      type,
      scope: ctx.scope,
      kind: r.kind,
      integration_id: r.integration_id,
      review_id: r.review_id,
      actor,
      reason_code,
      binding_sha256: r.binding_sha256,
    };
  }
  function candidate(ctx: RequestContext, input: Candidate): Review {
    const envelope = z
      .object({
        evidence: z.unknown(),
        permissions: z.array(z.unknown()),
        credential_bindings: z.array(CredentialBindingSchema).max(64),
      })
      .strict()
      .safeParse(input);
    if (!envelope.success) fail("malformed_evidence");
    const evidence = parseEvidence(input.evidence),
      permissions = normalizePermissions(input.permissions, evidence);
    const credentials = envelope.data.credential_bindings.sort((a, b) =>
      a.ref_id < b.ref_id ? -1 : 1,
    );
    if (new Set(credentials.map((c) => c.ref_id)).size !== credentials.length)
      fail("credential_denied");
    for (const c of credentials)
      if (
        !permissions.some(
          (p) => p.capability === "credential.use" && p.resource === c.ref_id,
        ) ||
        !permissions.some(
          (p) =>
            p.capability === "network.connect" &&
            p.resource === c.allowed_origin,
        )
      )
        fail("credential_denied");
    return {
      review_id: randomUUID(),
      revision: 1,
      scope: ctx.scope,
      kind: evidence.kind,
      integration_id: evidence.integration_id,
      evidence,
      permissions,
      credential_bindings: credentials,
      binding_sha256: binding(ctx.scope, evidence, permissions, credentials),
      state: "pending",
      expires_at: new Date(
        clock().getTime() + policy.maxEvidenceAgeMs,
      ).toISOString(),
      scans: [],
    };
  }
  function insert(
    ctx: RequestContext,
    state: TrustState,
    r: Review,
    deduplicate = false,
  ) {
    const events: AuditEventInput[] = [];
    for (const g of state.grants)
      if (
        matches(ctx, r, g) &&
        g.state === "approved" &&
        g.binding_sha256 !== r.binding_sha256
      ) {
        g.state = "superseded";
        g.revision++;
        events.push(event(ctx, g, "drift.detected"));
      }
    if (
      !deduplicate ||
      !state.reviews.some(
        (existing) =>
          matches(ctx, r, existing) &&
          existing.state === "pending" &&
          existing.binding_sha256 === r.binding_sha256,
      )
    ) {
      state.reviews.push(r);
      events.push(event(ctx, r, "review.submitted"));
    }
    return events;
  }
  function driftReview(
    ctx: RequestContext,
    previous: Review | Grant,
    evidence: SourceEvidence,
  ): Review {
    return {
      review_id: randomUUID(),
      revision: 1,
      scope: ctx.scope,
      kind: evidence.kind,
      integration_id: evidence.integration_id,
      evidence,
      permissions: structuredClone(previous.permissions),
      credential_bindings: structuredClone(previous.credential_bindings),
      binding_sha256: binding(
        ctx.scope,
        evidence,
        previous.permissions,
        previous.credential_bindings,
      ),
      state: "pending",
      expires_at: new Date(
        clock().getTime() + policy.maxEvidenceAgeMs,
      ).toISOString(),
      scans: [],
    };
  }
  function owned<T extends Review | Grant>(
    ctx: RequestContext,
    r: T | undefined,
  ): T {
    if (!r) fail("unknown_integration");
    if (scopeKey(ctx.scope) !== scopeKey(r.scope)) fail("scope_mismatch");
    return r;
  }
  async function verify(
    ctx: RequestContext,
    r: Review | Grant,
    decision: ApprovalChallenge["decision"],
    proof: unknown,
    state: TrustState,
  ) {
    const challenge: ApprovalChallenge = {
      review_id: r.review_id,
      review_revision: r.revision,
      binding_sha256: r.binding_sha256,
      scope: r.scope,
      decision,
      expires_at: r.expires_at,
    };
    let result: unknown;
    try {
      result = await authorizer.verify(ctx, frozenClone(challenge), proof);
    } catch {
      fail("approval_invalid");
    }
    const parsed = z
      .object({
        approver_id: CodeSchema,
        nonce: CodeSchema,
        verified_at: z.string().datetime({ offset: true }),
      })
      .strict()
      .safeParse(result);
    if (
      !parsed.success ||
      clock().getTime() >= Date.parse(challenge.expires_at)
    )
      fail("approval_invalid");
    const token = parsed.data.nonce;
    if (state.consumed_nonces.includes(token)) fail("replayed_approval");
    state.consumed_nonces.push(token);
    return parsed.data.approver_id;
  }
  const admin: IntegrationTrustAdmin = {
    async submitCandidate(raw, input) {
      const ctx = context(raw),
        r = candidate(ctx, structuredClone(input)),
        loaded = await store.load();
      await store.commit(
        loaded.revision,
        loaded.state,
        insert(ctx, loaded.state, r),
      );
      return frozenClone(r);
    },
    async attachScan(raw, id, input) {
      const ctx = context(raw),
        l = await store.load(),
        r = owned(
          ctx,
          l.state.reviews.find((r) => r.review_id === id),
        ),
        scan = ScanRecordSchema.safeParse(input);
      if (!scan.success || scan.data.binding_sha256 !== r.binding_sha256)
        fail("scanner_unavailable");
      r.scans = r.scans.filter((s) => s.scanner_id !== scan.data.scanner_id);
      r.scans.push(scan.data);
      await store.commit(l.revision, l.state, [event(ctx, r, "scan.attached")]);
    },
    async approve(raw, input) {
      const ctx = context(raw),
        request = structuredClone(input),
        l = await store.load(),
        r = owned(
          ctx,
          l.state.reviews.find((r) => r.review_id === request.review_id),
        );
      if (r.revision !== request.expected_revision) fail("revision_conflict");
      if (r.state !== "pending") fail("not_pending");
      const actor = await verify(ctx, r, "approve", request.proof, l.state);
      fresh(r.evidence);
      normalizePermissions(r.permissions, r.evidence);
      if (
        policy.requiredScanners.some(
          (id) =>
            !r.scans.some(
              (s) =>
                s.scanner_id === id &&
                s.status === "ok" &&
                s.binding_sha256 === r.binding_sha256,
            ),
        )
      )
        fail("scanner_unavailable");
      const current = await observe(ctx, r);
      if (
        binding(ctx.scope, current, r.permissions, r.credential_bindings) !==
        r.binding_sha256
      ) {
        r.state = "superseded";
        r.revision++;
        const pending = driftReview(ctx, r, current);
        l.state.consumed_nonces.pop();
        await store.commit(
          l.revision,
          l.state,
          insert(ctx, l.state, pending, true),
        );
        fail("drift");
      }
      const cap =
          r.evidence.source.type === "remote-endpoint"
            ? Math.min(policy.maxGrantTtlMs, policy.remoteEndpointMaxGrantTtlMs)
            : policy.maxGrantTtlMs,
        ttl = request.ttl_ms ?? cap;
      if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > cap)
        fail("config_invalid");
      r.state = "approved";
      r.revision++;
      const { scans: _, ...base } = r;
      const grant: Grant = {
        ...base,
        grant_id: randomUUID(),
        approved_by: actor,
        approved_at: clock().toISOString(),
        expires_at: new Date(clock().getTime() + ttl).toISOString(),
        revision: 1,
      };
      l.state.grants.push(grant);
      await store.commit(l.revision, l.state, [
        event(ctx, r, "review.approved", actor),
      ]);
      return frozenClone(grant);
    },
    async deny(raw, input) {
      const ctx = context(raw),
        l = await store.load(),
        r = owned(
          ctx,
          l.state.reviews.find((r) => r.review_id === input.review_id),
        );
      if (r.revision !== input.expected_revision) fail("revision_conflict");
      if (r.state !== "pending") fail("not_pending");
      const actor = await verify(ctx, r, "deny", input.proof, l.state);
      r.state = "denied";
      r.revision++;
      await store.commit(l.revision, l.state, [
        event(ctx, r, "review.denied", actor),
      ]);
    },
    async revoke(raw, input) {
      const ctx = context(raw),
        l = await store.load(),
        g = owned(
          ctx,
          l.state.grants.find((g) => g.grant_id === input.grant_id),
        );
      if (g.revision !== input.expected_revision) fail("revision_conflict");
      const actor = await verify(ctx, g, "revoke", input.proof, l.state);
      g.state = "revoked";
      g.revision++;
      await store.commit(l.revision, l.state, [
        event(ctx, g, "grant.revoked", actor),
      ]);
    },
    async inspect(raw, id) {
      const ctx = context(raw),
        l = await store.load();
      return frozenClone({
        reviews: l.state.reviews.filter((r) => matches(ctx, id, r)),
        grants: l.state.grants.filter((r) => matches(ctx, id, r)),
      });
    },
    async history(raw, filter = {}) {
      const ctx = context(raw),
        l = await store.load();
      return frozenClone(
        l.state.events.filter(
          (e) =>
            scopeKey(e.scope) === scopeKey(ctx.scope) &&
            (!filter.kind || filter.kind === e.kind) &&
            (!filter.integration_id ||
              filter.integration_id === e.integration_id),
        ),
      );
    },
  };
  async function dispatch<T>(
    raw: RequestContext,
    request: Identity & { action?: string },
    invoke: InvokeRequest | undefined,
    callback: (a: AuthorizedInvocation | AuthorizedArtifact) => Promise<T>,
  ): Promise<T> {
    let ctx: RequestContext | undefined,
      r: Grant | undefined,
      dispatched = false;
    try {
      ctx = context(raw);
      const id = IdentitySchema.safeParse({
        kind: request.kind,
        integration_id: request.integration_id,
      });
      if (!id.success) fail("malformed_evidence");
      const l = await store.load();
      const grants = l.state.grants.filter((g) =>
        matches(ctx as RequestContext, id.data, g),
      );
      r = grants.findLast((g) => g.state === "approved");
      if (!r) {
        if (grants.some((g) => g.state === "revoked")) fail("revoked");
        if (
          !l.state.reviews.some((v) =>
            matches(ctx as RequestContext, id.data, v),
          )
        )
          fail("unknown_integration");
        fail("no_grant");
      }
      if (clock().getTime() >= Date.parse(r.expires_at)) fail("expired");
      const evidence = await observe(ctx, id.data);
      if (
        binding(ctx.scope, evidence, r.permissions, r.credential_bindings) !==
        r.binding_sha256
      ) {
        const pending = driftReview(ctx, r, evidence);
        await store.commit(
          l.revision,
          l.state,
          insert(ctx, l.state, pending, true),
        );
        fail("drift");
      }
      let artifact: AuthorizedArtifact | AuthorizedInvocation = {
        grant_id: r.grant_id,
        binding_sha256: r.binding_sha256,
        evidence,
        permissions: r.permissions,
      };
      if (invoke) {
        const req = invoke;
        if (
          !Number.isSafeInteger(req.caller.delegation_depth) ||
          req.caller.delegation_depth < 0 ||
          req.caller.delegation_depth > policy.maxDelegationDepth
        )
          fail("delegation_depth_exceeded");
        const permissions = normalizePermissions(req.permissions, evidence),
          caller = normalizePermissions(req.caller.permissions, evidence);
        if (
          !evidence.tools.some((t) => t.name === req.tool) ||
          !isSubset(
            [{ capability: "tool.invoke", resource: req.tool }, ...permissions],
            r.permissions,
          ) ||
          !isSubset(
            [{ capability: "tool.invoke", resource: req.tool }, ...permissions],
            caller,
          )
        )
          fail("permission_denied");
        if (
          req.target_origin !== undefined &&
          (req.target_origin !== evidence.endpoint?.origin ||
            !isSubset(
              [{ capability: "network.connect", resource: req.target_origin }],
              r.permissions,
            ) ||
            !isSubset(
              [{ capability: "network.connect", resource: req.target_origin }],
              caller,
            ))
        )
          fail("endpoint_mismatch");
        if (
          req.credential_ref !== undefined &&
          (!r.credential_bindings.some(
            (c) =>
              c.ref_id === req.credential_ref &&
              c.allowed_origin === req.target_origin,
          ) ||
            !isSubset(
              [{ capability: "credential.use", resource: req.credential_ref }],
              caller,
            ))
        )
          fail("credential_denied");
        canonicalJSON(req.input);
        artifact = {
          ...artifact,
          permissions,
          tool: req.tool,
          input: req.input,
          ...(req.target_origin === undefined
            ? {}
            : { target_origin: req.target_origin }),
          ...(req.credential_ref === undefined
            ? {}
            : { credential_ref: req.credential_ref }),
        };
      } else if (!["load", "install", "enable"].includes(request.action ?? ""))
        fail("permission_denied");
      if ((await store.load()).revision !== l.revision)
        fail("revision_conflict");
      const authorized = frozenClone(artifact);
      if (clock().getTime() >= Date.parse(r.expires_at)) fail("expired");
      fresh(evidence);
      const committed = await store.commit(l.revision, l.state, [
        event(ctx, r, "dispatch.allowed", "gate"),
      ]);
      if ((await store.load()).revision !== committed)
        fail("revision_conflict");
      if (clock().getTime() >= Date.parse(r.expires_at)) fail("expired");
      fresh(evidence);
      dispatched = true;
      return await callback(authorized);
    } catch (error) {
      const code =
        error instanceof IntegrationTrustError
          ? error.code
          : "permission_denied";
      if (ctx) {
        try {
          const l = await store.load();
          const identity = IdentitySchema.safeParse({
            kind: request.kind,
            integration_id: request.integration_id,
          });
          if (identity.success) {
            const record =
              r ??
              ({
                ...identity.data,
                review_id: randomUUID(),
                binding_sha256: "0".repeat(64),
              } as Review);
            await store.commit(l.revision, l.state, [
              event(
                ctx,
                record,
                dispatched ? "dispatch.failed" : "dispatch.denied",
                "gate",
                code,
              ),
            ]);
          }
        } catch {}
      }
      if (dispatched) throw error;
      throw new IntegrationTrustError(code);
    }
  }
  const gate: IntegrationGate = {
    admit(ctx, req, loader) {
      return dispatch(
        structuredClone(ctx),
        structuredClone(req),
        undefined,
        loader,
      );
    },
    invoke(ctx, req, callback) {
      const snapshot = structuredClone(req);
      return dispatch(structuredClone(ctx), snapshot, snapshot, (a) =>
        callback(a as AuthorizedInvocation),
      );
    },
  };
  return { admin, gate };
}
