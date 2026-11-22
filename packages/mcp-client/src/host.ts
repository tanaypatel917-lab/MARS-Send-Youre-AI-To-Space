import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, unlink } from "node:fs/promises";
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
  scopeKey,
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
  scope?: Scope;
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
  /** Isolates connections so closing one task doesn't stop another task's tools. */
  createLoader(): TrustedMcpLoader;
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

async function readHostSigningKey(keyPath: string): Promise<Uint8Array> {
  if (!(await lstat(keyPath)).isFile()) {
    throw new IntegrationTrustError("store_location_unsafe");
  }
  const file = await open(
    keyPath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const hex = (await file.readFile("utf8")).trim();
    if (!/^(?:[a-f\d]{2}){32,}$/i.test(hex)) {
      throw new IntegrationTrustError("store_corrupt");
    }
    return Buffer.from(hex, "hex");
  } finally {
    await file.close();
  }
}

async function loadOrCreateHostSigningKey(dir: string): Promise<Uint8Array> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if ((await lstat(dir)).isSymbolicLink()) {
    throw new IntegrationTrustError("store_location_unsafe");
  }
  await chmod(dir, 0o700);
  const keyPath = resolve(dir, "host-approval.key");
  try {
    return await readHostSigningKey(keyPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  // A hard link publishes a complete key without replacing another host's key.
  const temporary = resolve(dir, `.host-approval.${randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try {
    try {
      await file.writeFile(`${randomBytes(32).toString("hex")}\n`);
      await file.chmod(0o600);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await link(temporary, keyPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    await unlink(temporary);
  }
  return readHostSigningKey(keyPath);
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
  const firstApprover = options.approvers?.[0];
  const scope =
    options.scope ??
    defaultRequestContext(
      firstApprover?.owner_id,
      firstApprover?.project_ids[0],
    ).scope;
  const registryScope = scopeKey(scope);
  const trustDir = resolve(stateDir, "trust");
  const registryDir = resolve(
    stateDir,
    "registry",
    createHash("sha256").update(registryScope).digest("hex"),
  );
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
    scope,
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.credentialResolver
      ? { credentialResolver: options.credentialResolver }
      : {}),
    probeTimeoutMs,
    getTrustedBaseline: async (ctx, identity) => {
      const requestScope = scopeKey(ctx.scope);
      const { state } = await store.load();
      const baselines: Array<{
        evidence: (typeof state.grants)[number]["evidence"];
      }> = [];
      const grant = state.grants.findLast(
        (g) =>
          g.state === "approved" &&
          g.kind === identity.kind &&
          g.integration_id === identity.integration_id &&
          scopeKey(g.scope) === requestScope,
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
            scopeKey(r.scope) === requestScope,
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

  const createLoader = () =>
    createTrustedMcpLoader({
      gate,
      registry,
      ...(options.credentialResolver
        ? { credentialResolver: options.credentialResolver }
        : {}),
      isGrantActive: async (grantId) => {
        const { state } = await store.load();
        const grant = state.grants.find((g) => g.grant_id === grantId);
        return (
          grant?.state === "approved" &&
          (options.clock?.().getTime() ?? Date.now()) <
            Date.parse(grant.expires_at)
        );
      },
    });

  return {
    stateDir,
    registry,
    store,
    probe,
    admin,
    gate,
    loader: createLoader(),
    createLoader,
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
