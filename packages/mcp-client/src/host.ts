import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { RequestContext, Scope } from "@mars/contracts";
import {
  type ApprovalChallenge,
  createHmacApprovalAuthorizer,
  createIntegrationTrust,
  FileTrustStore,
  type IntegrationGate,
  type IntegrationTrustAdmin,
  IntegrationTrustError,
  type IntegrationTrustOptions,
  signApproval,
  type TrustState,
} from "@mars/integration-trust";
import { createTrustedMcpLoader, type TrustedMcpLoader } from "./loader";
import { McpEvidenceProbe } from "./probe";
import { FileMcpRegistry } from "./registry";
import type { McpCredentialResolver } from "./schemas";

export interface HostMcpControlPlaneOptions {
  /**
   * Directory storing host-owned trust state, MCP server registry, and
   * approval signing key. Must reside outside all workspaceRoots.
   */
  stateDir?: string;
  /** Agent-writable workspace roots that stateDir must NOT be inside. */
  workspaceRoots?: string[];
  /** Host approvers authorized to sign approval/denial/revocation proofs. */
  approvers?: ReadonlyArray<{
    approver_id: string;
    owner_id: string;
    project_ids: string[];
  }>;
  credentialResolver?: McpCredentialResolver;
  clock?: () => Date;
  policy?: IntegrationTrustOptions["policy"];
  probeTimeoutMs?: number;
}

export interface HostMcpControlPlane {
  readonly stateDir: string;
  readonly registry: FileMcpRegistry;
  readonly store: FileTrustStore;
  readonly probe: McpEvidenceProbe;
  readonly admin: IntegrationTrustAdmin;
  readonly gate: IntegrationGate;
  readonly loader: TrustedMcpLoader;
  signHostProof(params: {
    review_id: string;
    review_revision: number;
    binding_sha256: string;
    scope: Scope;
    decision: ApprovalChallenge["decision"];
    expires_at: string;
    approver_id?: string;
  }): {
    approver_id: string;
    nonce: string;
    mac: string;
  };
  readState(): Promise<{ revision: number; state: TrustState }>;
}

export function defaultHostMcpStateDir(): string {
  const xdg = process.env.XDG_STATE_HOME;
  if (xdg && xdg.trim().length > 0) {
    return resolve(xdg, "mars", "integration-trust");
  }
  return resolve(homedir(), ".local", "state", "mars", "integration-trust");
}

async function loadOrCreateHostSigningKey(dir: string): Promise<Uint8Array> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const keyPath = resolve(dir, "host-approval.key");
  try {
    const st = await lstat(keyPath);
    if (st.isSymbolicLink()) {
      throw new IntegrationTrustError("store_location_unsafe");
    }
    const hex = (await readFile(keyPath, "utf8")).trim();
    const bytes = Buffer.from(hex, "hex");
    if (bytes.length < 32) {
      throw new IntegrationTrustError("store_corrupt");
    }
    return new Uint8Array(bytes);
  } catch (error) {
    if (error instanceof IntegrationTrustError) throw error;
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code !== "ENOENT"
    ) {
      throw error;
    }
    const fresh = randomBytes(32);
    await writeFile(keyPath, `${fresh.toString("hex")}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(keyPath, 0o600);
    return new Uint8Array(fresh);
  }
}

export function defaultRequestContext(
  ownerId = process.env.USER ?? "local-operator",
  projectId = "default",
): RequestContext {
  return {
    schema_version: 1,
    scope: {
      owner_id: ownerId,
      project_id: projectId,
    },
    request_id: `cli-${Date.now().toString(36)}`,
  };
}

/**
 * Host-owned MCP control plane wiring `FileTrustStore`, `FileMcpRegistry`,
 * host HMAC approval signing, `McpEvidenceProbe`, `createIntegrationTrust`,
 * and `createTrustedMcpLoader`.
 *
 * Only host processes (like `mars mcp ...` CLI) should call this. Model/agent
 * execution paths should receive only `loader` (which holds `gate`, never `admin`).
 */
export async function createHostMcpControlPlane(
  options: HostMcpControlPlaneOptions = {},
): Promise<HostMcpControlPlane> {
  const stateDir = resolve(options.stateDir ?? defaultHostMcpStateDir());
  const workspaceRoots = options.workspaceRoots ?? [process.cwd()];
  const trustDir = resolve(stateDir, "trust");
  const registryDir = resolve(stateDir, "registry");
  const keyDir = resolve(stateDir, "keys");

  const registry = new FileMcpRegistry({ dir: registryDir, workspaceRoots });
  const store = new FileTrustStore({ directory: trustDir, workspaceRoots });
  // Validate store location before creating key directory.
  await store.load();
  const signingKey = await loadOrCreateHostSigningKey(keyDir);

  const defaultOwner = process.env.USER ?? "local-operator";
  const approvers = options.approvers ?? [
    {
      approver_id: defaultOwner,
      owner_id: defaultOwner,
      project_ids: ["default"],
    },
  ];

  const probeTimeoutMs = options.probeTimeoutMs ?? 5_000;
  // Pending reviews are NEVER trusted baselines for runtime admission/dispatch
  // (otherwise an automatically recorded drift review would let the next admit
  // spawn an unapproved drifted stdio binary). Only an active host `admin.approve`
  // call — after verifying the signed host proof — may probe its target review.
  const approvalProbeContext = new AsyncLocalStorage<string>();
  const probe = new McpEvidenceProbe({
    registry,
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.credentialResolver
      ? { credentialResolver: options.credentialResolver }
      : {}),
    probeTimeoutMs,
    getTrustedBaseline: async (ctx, identity) => {
      const { state } = await store.load();
      const baselines: Array<{
        evidence: (typeof state.grants)[number]["evidence"];
      }> = [];
      const grant = state.grants.findLast(
        (g) =>
          g.state === "approved" &&
          g.kind === identity.kind &&
          g.integration_id === identity.integration_id &&
          g.scope.owner_id === ctx.scope.owner_id &&
          g.scope.project_id === ctx.scope.project_id,
      );
      if (grant) baselines.push({ evidence: grant.evidence });
      const approvingReviewId = approvalProbeContext.getStore();
      if (approvingReviewId !== undefined) {
        const pending = state.reviews.find(
          (r) =>
            r.review_id === approvingReviewId &&
            r.state === "pending" &&
            r.kind === identity.kind &&
            r.integration_id === identity.integration_id &&
            r.scope.owner_id === ctx.scope.owner_id &&
            r.scope.project_id === ctx.scope.project_id,
        );
        if (pending) baselines.push({ evidence: pending.evidence });
      }
      return baselines.length > 0 ? baselines : undefined;
    },
  });

  const authorizer = createHmacApprovalAuthorizer({
    key: signingKey,
    approvers,
  });

  const { admin: rawAdmin, gate } = createIntegrationTrust({
    store,
    authorizer,
    probe,
    ...(options.clock ? { clock: options.clock } : {}),
    policy: {
      probeTimeoutMs: Math.min(15_000, Math.max(2_000, probeTimeoutMs + 1_000)),
      ...options.policy,
    },
  });

  const admin: IntegrationTrustAdmin = {
    ...rawAdmin,
    approve(ctx, request) {
      return approvalProbeContext.run(request.review_id, () =>
        rawAdmin.approve(ctx, request),
      );
    },
  };

  const loader = createTrustedMcpLoader({
    gate,
    registry,
    ...(options.credentialResolver
      ? { credentialResolver: options.credentialResolver }
      : {}),
    isGrantActive: async (grantId) => {
      const { state } = await store.load();
      const grant = state.grants.find((g) => g.grant_id === grantId);
      return grant?.state === "approved";
    },
  });

  return {
    stateDir,
    registry,
    store,
    probe,
    admin,
    gate,
    loader,
    signHostProof(params) {
      const challenge: ApprovalChallenge = {
        review_id: params.review_id,
        review_revision: params.review_revision,
        binding_sha256: params.binding_sha256,
        scope: params.scope,
        decision: params.decision,
        expires_at: params.expires_at,
      };
      const matchingApprover = approvers.find(
        (a) =>
          a.owner_id === params.scope.owner_id &&
          a.project_ids.includes(params.scope.project_id),
      );
      const approverId =
        params.approver_id ??
        matchingApprover?.approver_id ??
        approvers[0]?.approver_id ??
        defaultOwner;
      return signApproval(signingKey, challenge, approverId, randomUUID());
    },
    readState() {
      return store.load();
    },
  };
}
