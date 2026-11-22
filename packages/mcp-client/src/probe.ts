import type { RequestContext, Scope } from "@mars/contracts";
import {
  type AuthorizedArtifact,
  canonicalJSON,
  type EvidenceProbe,
  type Identity,
  IntegrationTrustError,
  type SourceEvidence,
  scopeKey,
  sha256,
} from "@mars/integration-trust";
import { selectMcpAuthentication } from "./credentials";
import type { McpServerRegistry } from "./registry";
import {
  type McpCredentialResolver,
  type McpServerConfig,
  type McpServerDescriptor,
  normalizeOrigin,
  type StdioTransportConfig,
} from "./schemas";
import {
  captureStdioArtifact,
  hashFile,
  readStdioArtifact,
} from "./stdio-artifact";
import { createMcpTransport, type McpTransportConnection } from "./transports";

export interface TrustedStdioBaseline {
  evidence: SourceEvidence;
}

export interface McpEvidenceProbeOptions {
  registry: McpServerRegistry;
  scope?: Scope;
  clock?: () => Date;
  probeTimeoutMs?: number;
  /**
   * Look up the currently trusted baseline (approved grant or pending review
   * undergoing host-signed approval) for `(ctx, identity)`. When provided,
   * stdio servers are only spawned after verifying that either a trusted
   * baseline exists with matching static artifact hashes (`config_sha256`,
   * `dependency_sha256`), or `allowUnapprovedStdioProbe` was explicitly enabled.
   */
  getTrustedBaseline?: (
    ctx: RequestContext,
    identity: Identity,
  ) => Promise<TrustedStdioBaseline | TrustedStdioBaseline[] | undefined>;
  /**
   * Explicit opt-in allowing unapproved stdio servers to be spawned for
   * descriptor discovery. Defaults to `false` so untrusted local code is never
   * executed implicitly before approval.
   */
  allowUnapprovedStdioProbe?: boolean;
  /**
   * Optional host-owned origin-bound credential resolver used when probing
   * Streamable HTTP servers that require authentication for `initialize` and
   * `tools/list`. Only credentials explicitly bound to the server's exact
   * canonical origin are resolved.
   */
  credentialResolver?: McpCredentialResolver;
}

export interface ObserveServerOptions {
  allowUnapprovedStdioProbe?: boolean;
  signal?: AbortSignal;
  authorization?: Pick<
    AuthorizedArtifact,
    "permissions" | "credential_bindings"
  >;
}

function buildConfigHash(
  server: McpServerConfig,
  artifactSha?: string,
): string {
  if (server.transport.type === "stdio") {
    return sha256(
      canonicalJSON({
        type: "stdio",
        command: server.transport.command,
        args: server.transport.args,
        cwd: server.transport.cwd ?? null,
        env_allowlist: [...server.transport.env_allowlist].sort(),
        entrypoint: server.transport.entrypoint ?? null,
        artifact_sha256: artifactSha ?? null,
      }),
    );
  }
  return sha256(
    canonicalJSON({
      type: "streamable-http",
      url: server.transport.url,
      credential_header: server.transport.credential_header ?? null,
      credential_prefix: server.transport.credential_prefix ?? null,
    }),
  );
}

async function checkConfig(
  server: McpServerConfig,
  expected: SourceEvidence,
  artifactSha?: string,
  signal?: AbortSignal,
) {
  if (
    buildConfigHash(server, artifactSha) !== expected.config_sha256 ||
    (server.transport.type === "stdio" &&
      (await stdioDependencyHash(server.transport, signal)) !==
        expected.dependency_sha256)
  ) {
    throw new IntegrationTrustError("drift");
  }
}

/** Check current source state only. To launch, use createVerifiedMcpTransport. */
export async function verifyMcpConfig(
  server: McpServerConfig,
  expected: SourceEvidence,
  signal?: AbortSignal,
) {
  const artifact =
    server.transport.type === "stdio"
      ? await readStdioArtifact(server.transport, signal)
      : undefined;
  await checkConfig(server, expected, artifact?.sha, signal);
  return artifact?.executable;
}

export async function createVerifiedMcpTransport(
  server: McpServerConfig,
  expected: SourceEvidence,
  signal?: AbortSignal,
  registry?: McpServerRegistry,
): Promise<McpTransportConnection> {
  if (server.transport.type !== "stdio") {
    await checkConfig(server, expected);
    return createMcpTransport(server.transport);
  }
  const captured = await captureStdioArtifact(
    server.transport,
    signal,
    registry,
  );
  try {
    await checkConfig(server, expected, captured.sha, signal);
    return captured.transport;
  } catch (error) {
    await captured.transport.close();
    throw error;
  }
}

function stdioDependencyHash(
  config: StdioTransportConfig,
  signal?: AbortSignal,
) {
  return config.dependency_manifest
    ? hashFile(config.dependency_manifest, signal)
    : sha256(canonicalJSON({ command: config.command, args: config.args }));
}

function buildToolEvidence(descriptor: McpServerDescriptor) {
  return descriptor.tools.map((tool) => ({
    name: tool.name,
    input_schema_sha256: sha256(
      canonicalJSON({
        description: tool.description ?? null,
        inputSchema: tool.inputSchema,
      }),
    ),
    output_schema_sha256: tool.outputSchema
      ? sha256(canonicalJSON(tool.outputSchema))
      : null,
  }));
}

export function matchesMcpToolEvidence(
  descriptor: McpServerDescriptor,
  evidence: SourceEvidence,
): boolean {
  return (
    canonicalJSON(
      buildToolEvidence(descriptor).sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
    ) ===
    canonicalJSON(
      [...evidence.tools].sort((a, b) => a.name.localeCompare(b.name)),
    )
  );
}

export function buildDescriptorHash(descriptor: McpServerDescriptor): string {
  return sha256(
    canonicalJSON({
      protocolVersion: descriptor.protocolVersion,
      serverInfo: descriptor.serverInfo,
      capabilities: descriptor.capabilities,
      tools: descriptor.tools,
    }),
  );
}

function deriveStdioRevision(contentHash: string): string {
  // SourceEvidence requires a 40-char hex git revision or semver.
  return contentHash.slice(0, 40);
}

export { buildCredentialHeaders } from "./credentials";

export async function probeMcpServerDescriptor(
  server: McpServerConfig,
  timeoutMs = 5_000,
  extraHeaders?: Record<string, string>,
  signal?: AbortSignal,
): Promise<McpServerDescriptor> {
  signal?.throwIfAborted();
  const transport =
    server.transport.type === "stdio"
      ? (await captureStdioArtifact(server.transport, signal)).transport
      : createMcpTransport(server.transport);
  try {
    return await transport.initialize({
      timeoutMs,
      ...(signal ? { signal } : {}),
      ...(extraHeaders ? { extraHeaders } : {}),
    });
  } finally {
    await transport.close();
  }
}

/**
 * Live MCP EvidenceProbe for `@mars/integration-trust`.
 *
 * Looks up servers exclusively from the host-owned registry (default-deny:
 * unknown servers fail with `evidence_unavailable`) and re-probes live tool
 * descriptors on every admission and every dispatch so descriptor drift is
 * detected and old grants are superseded.
 */
export class McpEvidenceProbe implements EvidenceProbe {
  private readonly registry: McpServerRegistry;
  private readonly registryScope: string | undefined;
  private readonly clock: () => Date;
  private readonly probeTimeoutMs: number;
  private readonly getTrustedBaseline:
    | ((
        ctx: RequestContext,
        identity: Identity,
      ) => Promise<TrustedStdioBaseline | TrustedStdioBaseline[] | undefined>)
    | undefined;
  private readonly allowUnapprovedStdioProbe: boolean;
  private readonly credentialResolver: McpCredentialResolver | undefined;

  constructor(options: McpEvidenceProbeOptions) {
    this.registry = options.registry;
    this.registryScope = options.scope ? scopeKey(options.scope) : undefined;
    this.clock = options.clock ?? (() => new Date());
    this.probeTimeoutMs = options.probeTimeoutMs ?? 4_000;
    this.getTrustedBaseline = options.getTrustedBaseline;
    this.allowUnapprovedStdioProbe = options.allowUnapprovedStdioProbe ?? false;
    this.credentialResolver = options.credentialResolver;
  }

  async observe(
    ctx: RequestContext,
    identity: Identity,
    authorization?: ObserveServerOptions["authorization"],
    signal?: AbortSignal,
  ): Promise<SourceEvidence> {
    if (
      this.registryScope !== undefined &&
      this.registryScope !== scopeKey(ctx.scope)
    ) {
      throw new IntegrationTrustError("scope_mismatch");
    }
    if (identity.kind !== "mcp") {
      throw new IntegrationTrustError("evidence_unavailable");
    }
    const server = await this.registry.get(identity.integration_id);
    if (!server) {
      throw new IntegrationTrustError("evidence_unavailable");
    }
    return this.observeServer(ctx, server, {
      ...(authorization ? { authorization } : {}),
      ...(signal ? { signal } : {}),
    });
  }

  async observeServer(
    ctx: RequestContext,
    server: McpServerConfig,
    options?: ObserveServerOptions,
  ): Promise<SourceEvidence> {
    const signal = options?.signal;
    signal?.throwIfAborted();
    if (
      this.registryScope !== undefined &&
      this.registryScope !== scopeKey(ctx.scope)
    ) {
      throw new IntegrationTrustError("scope_mismatch");
    }
    const observedAt = this.clock().toISOString();

    if (server.transport.type === "streamable-http") {
      const canonicalOrigin = normalizeOrigin(
        new URL(server.transport.url).origin,
      );
      const authentication = await selectMcpAuthentication(
        server,
        this.credentialResolver,
        "probe",
        options?.authorization,
      );
      const descriptor = await probeMcpServerDescriptor(
        server,
        this.probeTimeoutMs,
        authentication?.headers,
        signal,
      );
      const tools = buildToolEvidence(descriptor);
      const descriptorSha = buildDescriptorHash(descriptor);
      const configSha = buildConfigHash(server);
      return {
        schema_version: 1,
        kind: "mcp",
        integration_id: server.id,
        source: {
          type: "remote-endpoint",
          locator: canonicalOrigin,
          revision: descriptorSha.slice(0, 40),
          content_sha256: descriptorSha,
        },
        dependency_sha256: sha256(
          canonicalJSON({
            protocolVersion: descriptor.protocolVersion,
            serverInfo: descriptor.serverInfo,
          }),
        ),
        config_sha256: configSha,
        endpoint: {
          origin: canonicalOrigin,
          descriptor_sha256: descriptorSha,
        },
        tools,
        observed_at: observedAt,
      };
    }

    const stdio = server.transport;
    const captured = await captureStdioArtifact(stdio, signal, this.registry);
    try {
      return await this.observeStdioServer(
        ctx,
        server,
        stdio,
        captured,
        observedAt,
        options,
      );
    } finally {
      await captured.transport.close();
    }
  }

  private async observeStdioServer(
    ctx: RequestContext,
    server: McpServerConfig,
    stdio: StdioTransportConfig,
    captured: Awaited<ReturnType<typeof captureStdioArtifact>>,
    observedAt: string,
    options?: ObserveServerOptions,
  ): Promise<SourceEvidence> {
    const signal = options?.signal;
    const { executable, sha: artifactSha } = captured;
    const configSha = buildConfigHash(server, artifactSha);
    const dependencySha = await stdioDependencyHash(stdio, signal);

    const allowUnapproved =
      options?.allowUnapprovedStdioProbe ?? this.allowUnapprovedStdioProbe;
    if (!allowUnapproved) {
      const rawBaseline = this.getTrustedBaseline
        ? await this.getTrustedBaseline(ctx, {
            kind: "mcp",
            integration_id: server.id,
          })
        : undefined;
      const baselines = rawBaseline
        ? Array.isArray(rawBaseline)
          ? rawBaseline
          : [rawBaseline]
        : [];

      const primary = baselines[0];
      if (!primary) {
        throw new IntegrationTrustError("evidence_unavailable", {
          cause: new Error(
            `Refusing to spawn unapproved stdio MCP server "${server.id}" before approval; pass allowUnapprovedStdioProbe (or --allow-stdio-probe) to explicitly authorize live discovery.`,
          ),
        });
      }

      const matched = baselines.some(
        (b) =>
          configSha === b.evidence.config_sha256 &&
          dependencySha === b.evidence.dependency_sha256,
      );
      if (!matched) {
        const driftedContentSha = sha256(
          canonicalJSON({
            artifact_sha256: artifactSha,
            descriptor_sha256: "unprobed-artifact-drift",
          }),
        );
        return {
          schema_version: 1,
          kind: "mcp",
          integration_id: server.id,
          source: {
            type: "local-artifact",
            locator: stdio.entrypoint ?? executable,
            revision: deriveStdioRevision(driftedContentSha),
            content_sha256: driftedContentSha,
          },
          dependency_sha256: dependencySha,
          config_sha256: configSha,
          endpoint: null,
          tools: primary.evidence.tools,
          observed_at: observedAt,
        };
      }
    }

    const descriptor = await captured.transport.initialize({
      timeoutMs: this.probeTimeoutMs,
      ...(signal ? { signal } : {}),
    });
    const tools = buildToolEvidence(descriptor);
    const descriptorSha = buildDescriptorHash(descriptor);
    // Mix descriptorSha into content_sha256 so even if entrypoint bytes didn't
    // change (e.g. dynamic tool list), descriptor drift always changes the binding.
    const combinedContentSha = sha256(
      canonicalJSON({
        artifact_sha256: artifactSha,
        descriptor_sha256: descriptorSha,
      }),
    );

    return {
      schema_version: 1,
      kind: "mcp",
      integration_id: server.id,
      source: {
        type: "local-artifact",
        locator: stdio.entrypoint ?? executable,
        revision: deriveStdioRevision(combinedContentSha),
        content_sha256: combinedContentSha,
      },
      dependency_sha256: dependencySha,
      config_sha256: configSha,
      endpoint: null,
      tools,
      observed_at: observedAt,
    };
  }
}
