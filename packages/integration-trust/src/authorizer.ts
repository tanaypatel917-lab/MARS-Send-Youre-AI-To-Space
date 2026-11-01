import { createHmac, timingSafeEqual } from "node:crypto";
import type { RequestContext, Scope } from "@mars/contracts";
import { z } from "zod";
import { canonicalJSON } from "./canonical";
import { fail } from "./errors";
import { CodeSchema } from "./schemas";
export interface ApprovalChallenge {
  review_id: string;
  review_revision: number;
  binding_sha256: string;
  scope: Scope;
  decision: "approve" | "deny" | "revoke";
  expires_at: string;
}
export interface VerifiedApproval {
  approver_id: string;
  verified_at: string;
  nonce: string;
}
export interface HostApprovalAuthorizer {
  verify(
    ctx: RequestContext,
    challenge: ApprovalChallenge,
    proof: unknown,
  ): Promise<VerifiedApproval | null>;
}
const ProofSchema = z
  .object({
    approver_id: CodeSchema,
    nonce: CodeSchema,
    mac: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export function signApproval(
  key: Uint8Array,
  challenge: ApprovalChallenge,
  approver_id: string,
  nonce: string,
) {
  if (key.length < 32) fail("config_invalid");
  return {
    approver_id,
    nonce,
    mac: createHmac("sha256", key)
      .update(canonicalJSON({ challenge, approver_id, nonce }))
      .digest("hex"),
  };
}
export function createHmacApprovalAuthorizer(options: {
  key: Uint8Array;
  approvers: ReadonlyArray<{
    approver_id: string;
    owner_id: string;
    project_ids: string[];
  }>;
}): HostApprovalAuthorizer {
  if (options.key.length < 32) fail("config_invalid");
  const key = Uint8Array.from(options.key),
    approvers = structuredClone(options.approvers);
  return {
    async verify(ctx, challenge, proof) {
      const parsed = ProofSchema.safeParse(proof);
      if (!parsed.success || Date.now() >= Date.parse(challenge.expires_at))
        return null;
      const p = parsed.data;
      if (
        !approvers.some(
          (a) =>
            a.approver_id === p.approver_id &&
            a.owner_id === ctx.scope.owner_id &&
            a.project_ids.includes(ctx.scope.project_id),
        ) ||
        canonicalJSON(ctx.scope) !== canonicalJSON(challenge.scope)
      )
        return null;
      const expected = signApproval(key, challenge, p.approver_id, p.nonce).mac;
      if (
        !timingSafeEqual(
          Buffer.from(expected, "hex"),
          Buffer.from(p.mac, "hex"),
        )
      )
        return null;
      return {
        approver_id: p.approver_id,
        nonce: p.nonce,
        verified_at: new Date().toISOString(),
      };
    },
  };
}
