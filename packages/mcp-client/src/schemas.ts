import {
  CredentialBindingSchema,
  IntegrationTrustError,
  isOrigin,
  PermissionSchema,
} from "@mars/integration-trust";
import { z } from "zod";

export const MCP_PROTOCOL_VERSION = "2025-03-26";

export function normalizeOrigin(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new IntegrationTrustError("endpoint_mismatch");
  }
  const origin = parsed.origin;
  if (!isOrigin(origin)) {
    throw new IntegrationTrustError("endpoint_mismatch");
  }
  return origin;
}

const ServerIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[a-z0-9][a-z0-9._-]*$/,
    "server id must be lowercase ASCII alphanumeric with ., _, or -",
  );

const EnvKeySchema = z
  .string()
  .min(1)
  .regex(/^[A-Z_][A-Z0-9_]*$/, "env key must be uppercase ASCII identifier");

export const StdioTransportConfigSchema = z
  .object({
    type: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    /** Absent on pre-package registrations. Never infer argument roles from the filesystem. */
    launch: z
      .object({
        version: z.literal(1),
        command_root: z.string().min(1).optional(),
        pin_cwd: z.boolean().optional(),
        arguments: z.array(
          z.union([
            z.literal("text"),
            z.literal("data"),
            z
              .object({
                code: z.string().min(1).nullable(),
                sha256: z
                  .string()
                  .regex(/^[a-f0-9]{64}$/)
                  .optional(),
              })
              .strict(),
          ]),
        ),
      })
      .strict()
      .optional(),
    cwd: z.string().min(1).optional(),
    /** Explicit allowlist of environment variable names forwarded to the server process. */
    env_allowlist: z.array(EnvKeySchema).default([]),
    /** Optional local entrypoint file hashed into content_sha256 for artifact drift detection. */
    entrypoint: z.string().min(1).optional(),
    /** Optional dependency manifest file hashed into dependency_sha256. */
    dependency_manifest: z.string().min(1).optional(),
  })
  .strict();

const StreamableHttpUrlSchema = z
  .string()
  .url()
  .superRefine((raw, ctx) => {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "invalid URL",
      });
      return;
    }
    if (!isOrigin(parsed.origin)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Streamable HTTP transport requires https: or localhost/127.0.0.1 http: URL",
      });
    }
    if (parsed.username || parsed.password) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "URL must not embed credentials",
      });
    }
  });

export const StreamableHttpTransportConfigSchema = z
  .object({
    type: z.literal("streamable-http"),
    url: StreamableHttpUrlSchema,
    /** Optional HTTP header name used for origin-bound credentials (default: Authorization). */
    credential_header: z
      .string()
      .min(1)
      .regex(/^[A-Za-z0-9-]+$/)
      .optional(),
    /** Prefix before the credential value (default: "Bearer "). */
    credential_prefix: z.string().optional(),
  })
  .strict();

export const McpTransportConfigSchema = z.discriminatedUnion("type", [
  StdioTransportConfigSchema,
  StreamableHttpTransportConfigSchema,
]);

export const McpServerConfigSchema = z
  .object({
    schema_version: z.literal(1),
    id: ServerIdSchema,
    transport: McpTransportConfigSchema,
    permissions: z.array(PermissionSchema).default([]),
    credential_bindings: z.array(CredentialBindingSchema).default([]),
    registered_at: z.string().datetime(),
    legacy_notice_grant: z.string().optional(),
    migration_review_id: z.string().uuid().optional(),
  })
  .strict();

export const McpRegistryStateSchema = z
  .object({
    schema_version: z.literal(1),
    servers: z
      .record(ServerIdSchema, McpServerConfigSchema)
      .refine(
        (servers) =>
          Object.entries(servers).every(([id, server]) => id === server.id),
        "registry key must match server id",
      ),
  })
  .strict();

export type StdioTransportConfig = z.infer<typeof StdioTransportConfigSchema>;
export type StreamableHttpTransportConfig = z.infer<
  typeof StreamableHttpTransportConfigSchema
>;
export type McpTransportConfig = z.infer<typeof McpTransportConfigSchema>;
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;
export type McpRegistryState = z.infer<typeof McpRegistryStateSchema>;

export interface McpToolDescriptor {
  name: string;
  description?: string | undefined;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown> | undefined;
}

export interface McpServerDescriptor {
  protocolVersion: string;
  serverInfo: {
    name: string;
    version: string;
  };
  capabilities: Record<string, unknown>;
  tools: McpToolDescriptor[];
  /** Number of server-provided instruction/steering fields dropped on initialize. */
  dropped_server_instructions: boolean;
}

export interface McpContentItem {
  type: string;
  text?: string | undefined;
  data?: string | undefined;
  mimeType?: string | undefined;
  [key: string]: unknown;
}

export interface RawMcpToolCallResult {
  content: McpContentItem[];
  structuredContent?: unknown;
  isError?: boolean | undefined;
  [key: string]: unknown;
}

/**
 * Explicitly untrusted envelope returned from every MCP tool call.
 * Prompt-steering fields (such as `_instructions`, `instructions`, `system_prompt`)
 * are stripped recursively and recorded in `stripped_steering_fields`.
 */
export interface UntrustedToolOutput {
  readonly untrusted: true;
  readonly server_id: string;
  readonly tool: string;
  readonly grant_id: string;
  readonly binding_sha256: string;
  readonly is_error: boolean;
  readonly content: readonly McpContentItem[];
  readonly structured_content: unknown;
  readonly stripped_steering_fields: readonly string[];
}

export interface CredentialResolutionRequest {
  readonly ref_id: string;
  readonly target_origin: string;
  readonly server_id: string;
  readonly grant_id: string;
}

export interface McpCredentialResolver {
  resolve(request: CredentialResolutionRequest): Promise<string | undefined>;
}
