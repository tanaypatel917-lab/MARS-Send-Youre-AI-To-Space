import { createHmac, randomBytes } from "node:crypto";
import type { RequestContext } from "@mars/contracts";
import {
  type AuthorizedArtifact,
  type AuthorizedInvocation,
  frozenClone,
  type IntegrationGate,
  IntegrationTrustError,
  type Permission,
} from "@mars/integration-trust";
import { type McpAuthentication, selectMcpAuthentication } from "./credentials";
import {
  buildDescriptorHash,
  createVerifiedMcpTransport,
  matchesMcpToolEvidence,
  verifyMcpConfig,
} from "./probe";
import type { McpServerRegistry } from "./registry";
import { sanitizeToolOutput } from "./sanitize";
import {
  type McpCredentialResolver,
  type McpServerConfig,
  type McpServerDescriptor,
  normalizeOrigin,
  type UntrustedToolOutput,
} from "./schemas";
import {
  McpConnectionLostError,
  type McpTransportConnection,
  StdioMcpTransport,
} from "./transports";

export interface AdmittedMcpServer {
  readonly server_id: string;
  readonly grant_id: string;
  readonly binding_sha256: string;
  readonly transport: "stdio" | "streamable-http";
  readonly origin: string | null;
  readonly descriptor: McpServerDescriptor;
  readonly permissions: readonly Permission[];
  readonly credential_ref?: string;
}

export interface InvokeMcpToolRequest {
  server_id: string;
  tool: string;
  input: Record<string, unknown>;
  requested_permissions?: Permission[];
  caller_capabilities?: Permission[];
  target_origin?: string;
  credential_ref?: string;
  delegation_depth?: number;
  timeout_ms?: number;
  signal?: AbortSignal;
}

export interface TrustedMcpLoaderOptions {
  /** Runtime gate from `@mars/integration-trust`. Loader never holds `admin`. */
  gate: IntegrationGate;
  /** Host-owned server registry. Default-deny: no ambient discovery. */
  registry: McpServerRegistry;
  /** Optional host-owned origin-bound credential resolver. */
  credentialResolver?: McpCredentialResolver;
  /**
   * Optional grant status check used for mid-flight revocation detection
   * during active tool execution.
   */
  isGrantActive?: (grantId: string) => Promise<boolean>;
  /** Poll interval for mid-flight revocation check during long tool calls. */
  revocationPollMs?: number;
  /** Default tool call timeout in milliseconds. */
  defaultTimeoutMs?: number;
}

interface ActiveConnection {
  transport: McpTransportConnection;
  descriptor: McpServerDescriptor;
  inFlight: Set<AbortController>;
  evict(): Promise<void>;
}

export interface TrustedMcpLoader {
  admitServer(
    ctx: RequestContext,
    serverId: string,
    action?: "load" | "install" | "enable",
    signal?: AbortSignal,
  ): Promise<AdmittedMcpServer>;
  invokeTool(
    ctx: RequestContext,
    request: InvokeMcpToolRequest,
  ): Promise<UntrustedToolOutput>;
  closeServer(serverId: string): Promise<void>;
  closeAll(): Promise<void>;
}

/**
 * Creates a default-deny MCP client/loader that routes every server load
 * exclusively through `gate.admit` and every tool invocation exclusively
 * through `gate.invoke`.
 */
export function createTrustedMcpLoader(
  options: TrustedMcpLoaderOptions,
): TrustedMcpLoader {
  const { gate, registry, credentialResolver, isGrantActive } = options;
  const revocationPollMs = options.revocationPollMs ?? 50;
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 10_000;
  const authenticationKey = randomBytes(32);
  let lifecycle = new AbortController();
  const connections = new Map<
    string,
    {
      grantId: string;
      bindingSha256: string;
      contexts: Map<string, Promise<ActiveConnection>>;
    }
  >();

  async function teardownServer(serverId: string): Promise<void> {
    const server = connections.get(serverId);
    if (!server) return;
    connections.delete(serverId);
    await Promise.allSettled(
      [...server.contexts.values()].map(async (connection) => {
        const active = await connection;
        await closeConnection(active);
      }),
    );
  }

  async function closeConnection(active: ActiveConnection) {
    for (const controller of active.inFlight) controller.abort();
    active.inFlight.clear();
    await active.transport.close().catch(() => {});
  }

  async function openConnection(
    server: McpServerConfig,
    artifact: AuthorizedArtifact,
    timeoutMs: number,
    signal: AbortSignal,
    authentication?: McpAuthentication,
  ): Promise<ActiveConnection> {
    signal.throwIfAborted();
    let current = connections.get(server.id);
    if (
      current &&
      (current.grantId !== artifact.grant_id ||
        current.bindingSha256 !== artifact.binding_sha256)
    ) {
      void teardownServer(server.id);
      current = undefined;
    }
    if (!current) {
      current = {
        grantId: artifact.grant_id,
        bindingSha256: artifact.binding_sha256,
        contexts: new Map(),
      };
      connections.set(server.id, current);
    }
    const contexts = current.contexts;
    const key = authentication
      ? createHmac("sha256", authenticationKey)
          .update(JSON.stringify([authentication.ref, authentication.headers]))
          .digest("hex")
      : "anonymous";
    for (
      let existing = contexts.get(key);
      existing;
      existing = contexts.get(key)
    ) {
      const active = await existing;
      signal.throwIfAborted();
      if (
        !(active.transport instanceof StdioMcpTransport) ||
        active.transport.isRunning
      ) {
        await verifyMcpConfig(server, artifact.evidence, signal);
        signal.throwIfAborted();
        return active;
      }
      await active.evict();
      if (connections.get(server.id) !== current) {
        throw new McpConnectionLostError("MCP connection was closed");
      }
    }
    signal.throwIfAborted();
    const pending = (async (): Promise<ActiveConnection> => {
      let prepared: McpTransportConnection | undefined;
      try {
        const transport = await createVerifiedMcpTransport(
          server,
          artifact.evidence,
          signal,
          registry,
        );
        prepared = transport;
        const descriptor = await transport.initialize({
          timeoutMs,
          signal,
          ...(authentication ? { extraHeaders: authentication.headers } : {}),
        });
        signal.throwIfAborted();
        if (
          transport.transportType === "streamable-http"
            ? buildDescriptorHash(descriptor) !==
              artifact.evidence.endpoint?.descriptor_sha256
            : !matchesMcpToolEvidence(descriptor, artifact.evidence)
        ) {
          throw new IntegrationTrustError("drift");
        }
        const active: ActiveConnection = {
          transport,
          descriptor,
          inFlight: new Set(),
          async evict() {
            if (contexts.get(key) === pending) contexts.delete(key);
            await closeConnection(active);
          },
        };
        return active;
      } catch (error) {
        contexts.delete(key);
        await prepared?.close().catch(() => {});
        throw error;
      }
    })();
    contexts.set(key, pending);
    return pending;
  }

  function assertOriginMatch(
    server: McpServerConfig,
    authorized: AuthorizedInvocation,
  ): string | null {
    if (server.transport.type !== "streamable-http") {
      if (authorized.target_origin || authorized.credential_ref) {
        throw new IntegrationTrustError("credential_denied");
      }
      return null;
    }
    const serverOrigin = normalizeOrigin(new URL(server.transport.url).origin);
    if (authorized.target_origin) {
      const requestedOrigin = normalizeOrigin(authorized.target_origin);
      if (requestedOrigin !== serverOrigin) {
        throw new IntegrationTrustError("endpoint_mismatch");
      }
    }
    return serverOrigin;
  }

  async function resolveInvocationAuthentication(
    server: McpServerConfig,
    authorized: AuthorizedInvocation,
    serverOrigin: string | null,
  ): Promise<McpAuthentication | undefined> {
    if (!authorized.credential_ref) return undefined;
    if (
      !serverOrigin ||
      !authorized.target_origin ||
      normalizeOrigin(authorized.target_origin) !== serverOrigin
    ) {
      throw new IntegrationTrustError("credential_denied");
    }
    const authentication = await selectMcpAuthentication(
      server,
      credentialResolver,
      authorized.grant_id,
      authorized,
      authorized.credential_ref,
    );
    if (!authentication) {
      throw new IntegrationTrustError("credential_denied");
    }
    return authentication;
  }

  return {
    async admitServer(ctx, serverId, action = "load", requestSignal) {
      const signal = requestSignal
        ? AbortSignal.any([lifecycle.signal, requestSignal])
        : lifecycle.signal;
      signal.throwIfAborted();
      try {
        return await gate.admit(
          ctx,
          { kind: "mcp", integration_id: serverId, action },
          async (artifact) => {
            const server = await registry.get(serverId);
            if (!server) {
              throw new IntegrationTrustError("evidence_unavailable");
            }
            const currentOrigin =
              server.transport.type === "streamable-http"
                ? normalizeOrigin(new URL(server.transport.url).origin)
                : undefined;
            if (currentOrigin !== artifact.evidence.endpoint?.origin) {
              throw new IntegrationTrustError("endpoint_mismatch");
            }
            const authentication = await selectMcpAuthentication(
              server,
              credentialResolver,
              artifact.grant_id,
              artifact,
            );
            const active = await openConnection(
              server,
              artifact,
              defaultTimeoutMs,
              signal,
              authentication,
            );
            return frozenClone<AdmittedMcpServer>({
              server_id: server.id,
              grant_id: artifact.grant_id,
              binding_sha256: artifact.binding_sha256,
              transport: server.transport.type,
              origin: active.transport.origin,
              descriptor: active.descriptor,
              permissions: [...artifact.permissions],
              ...(authentication ? { credential_ref: authentication.ref } : {}),
            });
          },
          signal,
        );
      } catch (error) {
        if (
          error instanceof IntegrationTrustError &&
          (error.code === "revoked" ||
            error.code === "drift" ||
            error.code === "expired")
        ) {
          await teardownServer(serverId);
        }
        throw error;
      }
    },

    async invokeTool(ctx, request) {
      const signal = request.signal
        ? AbortSignal.any([lifecycle.signal, request.signal])
        : lifecycle.signal;
      signal.throwIfAborted();
      const server = await registry.get(request.server_id);
      const inferredOrigin =
        request.target_origin ??
        (server?.transport.type === "streamable-http"
          ? normalizeOrigin(new URL(server.transport.url).origin)
          : undefined);
      const requestedPermissions: Permission[] =
        request.requested_permissions ?? [
          { capability: "tool.invoke", resource: request.tool },
          ...(inferredOrigin
            ? [
                {
                  capability: "network.connect" as const,
                  resource: inferredOrigin,
                },
              ]
            : []),
          ...(request.credential_ref
            ? [
                {
                  capability: "credential.use" as const,
                  resource: request.credential_ref,
                },
              ]
            : []),
        ];
      const callerCapabilities: Permission[] =
        request.caller_capabilities ?? requestedPermissions;

      try {
        return await gate.invoke(
          ctx,
          {
            kind: "mcp",
            integration_id: request.server_id,
            tool: request.tool,
            input: request.input,
            permissions: requestedPermissions,
            caller: {
              permissions: callerCapabilities,
              delegation_depth: request.delegation_depth ?? 0,
            },
            ...(inferredOrigin ? { target_origin: inferredOrigin } : {}),
            ...(request.credential_ref
              ? { credential_ref: request.credential_ref }
              : {}),
          },
          async (authorized) => {
            const currentServer = await registry.get(request.server_id);
            if (!currentServer) {
              throw new IntegrationTrustError("evidence_unavailable");
            }
            const serverOrigin = assertOriginMatch(currentServer, authorized);
            const authentication = await resolveInvocationAuthentication(
              currentServer,
              authorized,
              serverOrigin,
            );
            const timeoutMs = request.timeout_ms ?? defaultTimeoutMs;
            const active = await openConnection(
              currentServer,
              authorized,
              timeoutMs,
              signal,
              authentication,
            );

            signal.throwIfAborted();
            if (isGrantActive && !(await isGrantActive(authorized.grant_id))) {
              throw new IntegrationTrustError("revoked");
            }
            const abortController = new AbortController();
            active.inFlight.add(abortController);
            let revokedMidFlight = false;
            let pollTimer: ReturnType<typeof setInterval> | undefined;

            if (isGrantActive) {
              pollTimer = setInterval(() => {
                void isGrantActive(authorized.grant_id)
                  .then((stillActive) => {
                    if (!stillActive) {
                      revokedMidFlight = true;
                      abortController.abort();
                    }
                  })
                  .catch(() => {});
              }, revocationPollMs);
            }

            try {
              const rawResult = await active.transport.callTool(
                authorized.tool,
                (authorized.input ?? {}) as Record<string, unknown>,
                {
                  timeoutMs,
                  signal: AbortSignal.any([abortController.signal, signal]),
                },
              );

              // Final revocation check before releasing tool output to caller.
              if (
                revokedMidFlight ||
                (isGrantActive && !(await isGrantActive(authorized.grant_id)))
              ) {
                revokedMidFlight = true;
                throw new IntegrationTrustError("revoked");
              }

              return sanitizeToolOutput(rawResult, {
                server_id: currentServer.id,
                tool: authorized.tool,
                grant_id: authorized.grant_id,
                binding_sha256: authorized.binding_sha256,
              });
            } catch (error) {
              if (revokedMidFlight) {
                await teardownServer(currentServer.id);
                throw new IntegrationTrustError("revoked", { cause: error });
              }
              if (error instanceof McpConnectionLostError) {
                await active.evict();
              }
              throw error;
            } finally {
              if (pollTimer) clearInterval(pollTimer);
              active.inFlight.delete(abortController);
            }
          },
          signal,
        );
      } catch (error) {
        if (
          error instanceof IntegrationTrustError &&
          (error.code === "revoked" ||
            error.code === "drift" ||
            error.code === "expired")
        ) {
          await teardownServer(request.server_id);
        }
        throw error;
      }
    },

    async closeServer(serverId) {
      await teardownServer(serverId);
    },

    async closeAll() {
      const closing = lifecycle;
      lifecycle = new AbortController();
      closing.abort();
      const ids = [...connections.keys()];
      await Promise.all(ids.map((id) => teardownServer(id)));
    },
  };
}
