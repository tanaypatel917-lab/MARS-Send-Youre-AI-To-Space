import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { RequestContext } from "@mars/contracts";
import {
  canonicalJSON,
  type EvidenceProbe,
  type Identity,
  IntegrationTrustError,
  type SourceEvidence,
  sha256,
} from "@mars/integration-trust";
import type { McpServerRegistry } from "./registry";
import {
  type McpCredentialResolver,
  type McpServerConfig,
  type McpServerDescriptor,
  normalizeOrigin,
  type StdioTransportConfig,
} from "./schemas";
import { createMcpTransport } from "./transports";

export interface TrustedStdioBaseline {
  evidence: SourceEvidence;
}

export interface McpEvidenceProbeOptions {
  registry: McpServerRegistry;
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
}

async function hashFileOrSpec(
  filePath: string | undefined,
  fallbackSpec: unknown,
): Promise<string> {
  if (filePath) {
    const abs = resolve(filePath);
    const bytes = await readFile(abs);
    return sha256(bytes.toString("base64"));
  }
  return sha256(canonicalJSON(fallbackSpec));
}

function buildConfigHash(
  server: McpServerConfig,
  entrypointSha?: string,
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
        entrypoint_sha256: entrypointSha ?? null,
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

function buildDescriptorHash(descriptor: McpServerDescriptor): string {
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

export function buildCredentialHeaders(
  server: McpServerConfig,
  secretValue: string,
): Record<string, string> {
  if (server.transport.type !== "streamable-http") {
    throw new IntegrationTrustError("credential_denied");
  }
  const headerName = server.transport.credential_header ?? "Authorization";
  const prefix = server.transport.credential_prefix ?? "Bearer ";
  return { [headerName]: `${prefix}${secretValue}` };
}

export async function probeMcpServerDescriptor(
  server: McpServerConfig,
  timeoutMs = 5_000,
  extraHeaders?: Record<string, string>,
): Promise<McpServerDescriptor> {
  const transport = createMcpTransport(server.transport);
  try {
    return await transport.initialize({
      timeoutMs,
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
    this.clock = options.clock ?? (() => new Date());
    this.probeTimeoutMs = options.probeTimeoutMs ?? 4_000;
    this.getTrustedBaseline = options.getTrustedBaseline;
    this.allowUnapprovedStdioProbe = options.allowUnapprovedStdioProbe ?? false;
    this.credentialResolver = options.credentialResolver;
  }

  async observe(
    ctx: RequestContext,
    identity: Identity,
  ): Promise<SourceEvidence> {
    if (identity.kind !== "mcp") {
      throw new IntegrationTrustError("evidence_unavailable");
    }
    const server = await this.registry.get(identity.integration_id);
    if (!server) {
      throw new IntegrationTrustError("evidence_unavailable");
    }
    return this.observeServer(ctx, server);
  }

  async observeServer(
    ctx: RequestContext,
    server: McpServerConfig,
    options?: ObserveServerOptions,
  ): Promise<SourceEvidence> {
    const observedAt = this.clock().toISOString();

    if (server.transport.type === "streamable-http") {
      const canonicalOrigin = normalizeOrigin(
        new URL(server.transport.url).origin,
      );
      let extraHeaders: Record<string, string> | undefined;
      if (this.credentialResolver) {
        const binding = server.credential_bindings.find(
          (b) => normalizeOrigin(b.allowed_origin) === canonicalOrigin,
        );
        if (binding) {
          const secretValue = await this.credentialResolver.resolve({
            ref_id: binding.ref_id,
            target_origin: canonicalOrigin,
            server_id: server.id,
            grant_id: "probe",
          });
          if (secretValue) {
            extraHeaders = buildCredentialHeaders(server, secretValue);
          }
        }
      }
      const descriptor = await probeMcpServerDescriptor(
        server,
        this.probeTimeoutMs,
        extraHeaders,
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

    const stdio: StdioTransportConfig = server.transport;
    // Hash static local artifacts BEFORE spawning the stdio process so
    // tampered or unapproved executables are never launched before trust checks.
    const entrypointSha = stdio.entrypoint
      ? await hashFileOrSpec(stdio.entrypoint, null)
      : undefined;
    const configSha = buildConfigHash(server, entrypointSha);
    const dependencySha = await hashFileOrSpec(stdio.dependency_manifest, {
      command: stdio.command,
      args: stdio.args,
    });

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
            artifact_sha256: entrypointSha ?? configSha,
            descriptor_sha256: "unprobed-artifact-drift",
          }),
        );
        return {
          schema_version: 1,
          kind: "mcp",
          integration_id: server.id,
          source: {
            type: "local-artifact",
            locator: stdio.entrypoint ?? stdio.command,
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

    const descriptor = await probeMcpServerDescriptor(
      server,
      this.probeTimeoutMs,
    );
    const tools = buildToolEvidence(descriptor);
    const descriptorSha = buildDescriptorHash(descriptor);
    const contentSha =
      entrypointSha ??
      sha256(
        canonicalJSON({
          command: stdio.command,
          args: stdio.args,
          descriptor_sha256: descriptorSha,
        }),
      );
    // Mix descriptorSha into content_sha256 so even if entrypoint bytes didn't
    // change (e.g. dynamic tool list), descriptor drift always changes the binding.
    const combinedContentSha = sha256(
      canonicalJSON({
        artifact_sha256: contentSha,
        descriptor_sha256: descriptorSha,
      }),
    );

    return {
      schema_version: 1,
      kind: "mcp",
      integration_id: server.id,
      source: {
        type: "local-artifact",
        locator: stdio.entrypoint ?? stdio.command,
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
