import type { RequestContext } from "@mars/contracts";
import {
  type AuthorizedArtifact,
  type AuthorizedInvocation,
  frozenClone,
  type IntegrationGate,
  IntegrationTrustError,
  type Permission,
} from "@mars/integration-trust";
import { buildCredentialHeaders } from "./probe";
import type { McpServerRegistry } from "./registry";
import { sanitizeToolOutput } from "./sanitize";
import {
  type McpCredentialResolver,
  type McpServerConfig,
  type McpServerDescriptor,
  normalizeOrigin,
  type UntrustedToolOutput,
} from "./schemas";
import { createMcpTransport, type McpTransportConnection } from "./transports";

export interface AdmittedMcpServer {
  readonly server_id: string;
  readonly grant_id: string;
  readonly binding_sha256: string;
  readonly transport: "stdio" | "streamable-http";
  readonly origin: string | null;
  readonly descriptor: McpServerDescriptor;
  readonly permissions: readonly Permission[];
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
  serverId: string;
  grantId: string;
  bindingSha256: string;
  transport: McpTransportConnection;
  descriptor: McpServerDescriptor;
  inFlight: Set<AbortController>;
}

export interface TrustedMcpLoader {
  admitServer(
    ctx: RequestContext,
    serverId: string,
    action?: "load" | "install" | "enable",
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
  const connections = new Map<string, ActiveConnection>();

  async function teardownServer(serverId: string): Promise<void> {
    const active = connections.get(serverId);
    if (!active) return;
    connections.delete(serverId);
    for (const controller of active.inFlight) {
      controller.abort();
    }
    active.inFlight.clear();
    await active.transport.close().catch(() => {});
  }

  async function openConnection(
    server: McpServerConfig,
    artifact: AuthorizedArtifact,
    timeoutMs: number,
    extraHeaders?: Record<string, string>,
  ): Promise<ActiveConnection> {
    const existing = connections.get(server.id);
    if (
      existing &&
      existing.grantId === artifact.grant_id &&
      existing.bindingSha256 === artifact.binding_sha256
    ) {
      return existing;
    }
    if (existing) {
      await teardownServer(server.id);
    }

    const transport = createMcpTransport(server.transport);
    try {
      const descriptor = await transport.initialize({
        timeoutMs,
        ...(extraHeaders ? { extraHeaders } : {}),
      });
      const active: ActiveConnection = {
        serverId: server.id,
        grantId: artifact.grant_id,
        bindingSha256: artifact.binding_sha256,
        transport,
        descriptor,
        inFlight: new Set(),
      };
      connections.set(server.id, active);
      return active;
    } catch (error) {
      await transport.close().catch(() => {});
      throw error;
    }
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

  async function resolveOriginBoundHeaders(
    server: McpServerConfig,
    authorized: AuthorizedInvocation,
    serverOrigin: string | null,
  ): Promise<Record<string, string> | undefined> {
    if (!authorized.credential_ref) return undefined;
    if (
      !serverOrigin ||
      !authorized.target_origin ||
      normalizeOrigin(authorized.target_origin) !== serverOrigin
    ) {
      throw new IntegrationTrustError("credential_denied");
    }
    if (!credentialResolver) {
      throw new IntegrationTrustError("credential_denied");
    }
    const value = await credentialResolver.resolve({
      ref_id: authorized.credential_ref,
      target_origin: serverOrigin,
      server_id: server.id,
      grant_id: authorized.grant_id,
    });
    if (!value) {
      throw new IntegrationTrustError("credential_denied");
    }
    return buildCredentialHeaders(server, value);
  }

  return {
    async admitServer(ctx, serverId, action = "load") {
      try {
        return await gate.admit(
          ctx,
          { kind: "mcp", integration_id: serverId, action },
          async (artifact) => {
            const server = await registry.get(serverId);
            if (!server) {
              throw new IntegrationTrustError("evidence_unavailable");
            }
            let admitHeaders: Record<string, string> | undefined;
            if (
              server.transport.type === "streamable-http" &&
              credentialResolver
            ) {
              const serverOrigin = normalizeOrigin(
                new URL(server.transport.url).origin,
              );
              const binding = server.credential_bindings.find(
                (b) =>
                  normalizeOrigin(b.allowed_origin) === serverOrigin &&
                  artifact.permissions.some(
                    (p) =>
                      p.capability === "credential.use" &&
                      p.resource === b.ref_id,
                  ),
              );
              if (binding) {
                const secretValue = await credentialResolver.resolve({
                  ref_id: binding.ref_id,
                  target_origin: serverOrigin,
                  server_id: server.id,
                  grant_id: artifact.grant_id,
                });
                if (secretValue) {
                  admitHeaders = buildCredentialHeaders(server, secretValue);
                }
              }
            }
            const active = await openConnection(
              server,
              artifact,
              defaultTimeoutMs,
              admitHeaders,
            );
            return frozenClone<AdmittedMcpServer>({
              server_id: server.id,
              grant_id: artifact.grant_id,
              binding_sha256: artifact.binding_sha256,
              transport: server.transport.type,
              origin: active.transport.origin,
              descriptor: active.descriptor,
              permissions: [...artifact.permissions],
            });
          },
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
            const extraHeaders = await resolveOriginBoundHeaders(
              currentServer,
              authorized,
              serverOrigin,
            );
            const timeoutMs = request.timeout_ms ?? defaultTimeoutMs;
            const active = await openConnection(
              currentServer,
              authorized,
              timeoutMs,
              extraHeaders,
            );

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
                  signal: abortController.signal,
                  ...(extraHeaders ? { extraHeaders } : {}),
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
              throw error;
            } finally {
              if (pollTimer) clearInterval(pollTimer);
              active.inFlight.delete(abortController);
            }
          },
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
      const ids = [...connections.keys()];
      await Promise.all(ids.map((id) => teardownServer(id)));
    },
  };
}
