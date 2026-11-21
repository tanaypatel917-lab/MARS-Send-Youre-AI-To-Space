import { parseArgs } from "node:util";
import {
  type CredentialBinding,
  normalizePermission,
  type Permission,
  PermissionSchema,
} from "@mars/integration-trust";
import {
  createHostMcpControlPlane,
  defaultRequestContext,
  type HostMcpControlPlane,
  type McpServerConfig,
  McpServerConfigSchema,
  normalizeOrigin,
} from "@mars/mcp-client";
import { CliUsageError } from "./cli-errors";

const MCP_USAGE = [
  "Usage: mars mcp <list|review|approve|revoke|test> [options]",
  "  mars mcp list [--state-dir <dir>] [--owner <id>] [--project <id>] [--json]",
  "  mars mcp review <server-id> (--command <cmd> --allow-stdio-probe [--arg <arg>]... | --url <url>) [--permission <cap>:<res>]... [--credential <ref>@<origin>]... [--json]",
  "  mars mcp approve <review-id> [--ttl-ms <ms>] [--approved-by <name>] [--json]",
  "  mars mcp revoke <grant-id> [--approved-by <name>] [--json]",
  "  mars mcp test <server-id> [--tool <name>] [--input <json>] [--permission <cap>:<res>]... [--credential-ref <ref>] [--target-origin <origin>] [--json]",
].join("\n");

export interface RunMcpOptions {
  stdout?: (line: string) => void;
  workspaceRoots?: string[];
}

function parsePermissionFlag(raw: string): Permission {
  const sep = raw.indexOf(":");
  if (sep <= 0 || sep === raw.length - 1) {
    throw new CliUsageError(
      `Invalid --permission "${raw}". Expected <capability>:<resource> (e.g. tool.invoke:echo).`,
    );
  }
  const capability = raw.slice(0, sep);
  const resource = raw.slice(sep + 1);
  const parsed = PermissionSchema.safeParse({ capability, resource });
  if (!parsed.success) {
    throw new CliUsageError(
      `Invalid --permission "${raw}": unsupported capability or malformed resource.`,
    );
  }
  return parsed.data;
}

const CLI_CREDENTIAL_REF_RE = /^[a-z0-9][a-z0-9_]*$/;

function parseCredentialFlag(raw: string): CredentialBinding {
  const at = raw.indexOf("@");
  if (at <= 0 || at === raw.length - 1) {
    throw new CliUsageError(
      `Invalid --credential "${raw}". Expected <ref_id>@<origin> (e.g. api_key@https://mcp.example.com).`,
    );
  }
  const ref_id = raw.slice(0, at);
  if (!CLI_CREDENTIAL_REF_RE.test(ref_id)) {
    throw new CliUsageError(
      `Invalid credential ref "${ref_id}". CLI credential refs must use lowercase letters, digits, and underscores only (matching /^[a-z0-9][a-z0-9_]*$/) so they map 1-to-1 to MARS_MCP_CREDENTIAL_<UPPER>.`,
    );
  }
  const allowed_origin = normalizeOrigin(raw.slice(at + 1));
  return { ref_id, allowed_origin };
}

function parsePositiveInt(
  raw: string | undefined,
  flag: string,
): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CliUsageError(`Invalid ${flag}: expected positive integer`);
  }
  return parsed;
}

function resolveCliCredentialFromEnv(refId: string): string | undefined {
  // Strict injective lookup: only lowercase alphanumeric + underscore refs
  // map 1-to-1 to MARS_MCP_CREDENTIAL_<UPPER>, preventing case or punctuation
  // aliases (e.g. api-token vs api_token vs api.token) from sharing a secret
  // across origins.
  if (!CLI_CREDENTIAL_REF_RE.test(refId)) {
    return undefined;
  }
  const prefixed = process.env[`MARS_MCP_CREDENTIAL_${refId.toUpperCase()}`];
  if (prefixed !== undefined && prefixed.length > 0) {
    return prefixed;
  }
  return undefined;
}

async function openControlPlane(
  stateDir: string | undefined,
  workspaceRoots: string[] | undefined,
  scope?: { ownerId?: string; projectId?: string; approverId?: string },
): Promise<HostMcpControlPlane> {
  const ownerId = scope?.ownerId ?? process.env.USER ?? "local-operator";
  const projectId = scope?.projectId ?? "default";
  const approverId = scope?.approverId ?? ownerId;
  return createHostMcpControlPlane({
    ...(stateDir ? { stateDir } : {}),
    ...(workspaceRoots ? { workspaceRoots } : {}),
    approvers: [
      {
        approver_id: approverId,
        owner_id: ownerId,
        project_ids: [projectId],
      },
    ],
    credentialResolver: {
      async resolve({ ref_id }) {
        return resolveCliCredentialFromEnv(ref_id);
      },
    },
  });
}

async function handleList(
  args: string[],
  out: (line: string) => void,
  workspaceRoots: string[] | undefined,
): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      "state-dir": { type: "string" },
      owner: { type: "string" },
      project: { type: "string" },
      json: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  const cp = await openControlPlane(values["state-dir"], workspaceRoots);
  const ctx = defaultRequestContext(values.owner, values.project);
  const servers = await cp.registry.list();
  const nowMs = Date.now();
  const items = await Promise.all(
    servers.map(async (server) => {
      const inspected = await cp.admin.inspect(ctx, {
        kind: "mcp",
        integration_id: server.id,
      });
      return {
        id: server.id,
        transport: server.transport.type,
        target:
          server.transport.type === "stdio"
            ? `${server.transport.command} ${server.transport.args.join(" ")}`.trim()
            : server.transport.url,
        permissions: server.permissions,
        credential_bindings: server.credential_bindings,
        reviews: inspected.reviews.map((r) => ({
          review_id: r.review_id,
          state: r.state,
          revision: r.revision,
          binding_sha256: r.binding_sha256,
          expires_at: r.expires_at,
        })),
        grants: inspected.grants.map((g) => ({
          grant_id: g.grant_id,
          state: g.state,
          expired: g.state === "approved" && Date.parse(g.expires_at) <= nowMs,
          revision: g.revision,
          binding_sha256: g.binding_sha256,
          expires_at: g.expires_at,
        })),
      };
    }),
  );

  if (values.json) {
    out(JSON.stringify({ servers: items }, null, 2));
    return;
  }
  if (items.length === 0) {
    out("No MCP servers registered (default-deny).");
    return;
  }
  for (const item of items) {
    const activeGrant = item.grants.findLast(
      (g) => g.state === "approved" && !g.expired,
    );
    const pendingReview = item.reviews.findLast((r) => r.state === "pending");
    const expiredGrant = !activeGrant
      ? item.grants.findLast((g) => g.state === "approved" && g.expired)
      : undefined;
    const status = activeGrant
      ? `active (grant=${activeGrant.grant_id}, expires=${activeGrant.expires_at})`
      : pendingReview
        ? `pending_review (review=${pendingReview.review_id})`
        : expiredGrant
          ? `expired (grant=${expiredGrant.grant_id}, expired_at=${expiredGrant.expires_at})`
          : "unapproved";
    out(`${item.id} [${item.transport}] ${item.target} — ${status}`);
  }
}

async function handleReview(
  args: string[],
  out: (line: string) => void,
  workspaceRoots: string[] | undefined,
): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      "state-dir": { type: "string" },
      owner: { type: "string" },
      project: { type: "string" },
      command: { type: "string" },
      arg: { type: "string", multiple: true },
      cwd: { type: "string" },
      "env-allow": { type: "string", multiple: true },
      entrypoint: { type: "string" },
      "dependency-manifest": { type: "string" },
      "allow-stdio-probe": { type: "boolean", default: false },
      url: { type: "string" },
      "credential-header": { type: "string" },
      "credential-prefix": { type: "string" },
      permission: { type: "string", multiple: true },
      credential: { type: "string", multiple: true },
      json: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  const serverId = positionals[0];
  if (!serverId) {
    throw new CliUsageError(
      `Missing <server-id> for "mars mcp review".\n${MCP_USAGE}`,
    );
  }
  if (Boolean(values.command) === Boolean(values.url)) {
    throw new CliUsageError(
      "Specify exactly one of --command (stdio) or --url (streamable-http).",
    );
  }

  const permissions = (values.permission ?? []).map(parsePermissionFlag);
  const credentialBindings = (values.credential ?? []).map(parseCredentialFlag);

  const config: McpServerConfig = McpServerConfigSchema.parse({
    schema_version: 1,
    id: serverId,
    transport: values.command
      ? {
          type: "stdio",
          command: values.command,
          args: values.arg ?? [],
          ...(values.cwd ? { cwd: values.cwd } : {}),
          env_allowlist: values["env-allow"] ?? [],
          ...(values.entrypoint ? { entrypoint: values.entrypoint } : {}),
          ...(values["dependency-manifest"]
            ? { dependency_manifest: values["dependency-manifest"] }
            : {}),
        }
      : {
          type: "streamable-http",
          url: values.url,
          ...(values["credential-header"]
            ? { credential_header: values["credential-header"] }
            : {}),
          ...(values["credential-prefix"] !== undefined
            ? { credential_prefix: values["credential-prefix"] }
            : {}),
        },
    permissions,
    credential_bindings: credentialBindings,
    registered_at: new Date().toISOString(),
  });

  if (config.transport.type === "stdio" && !values["allow-stdio-probe"]) {
    throw new CliUsageError(
      "Reviewing a stdio MCP server spawns the configured executable to discover its tools. Pass --allow-stdio-probe to explicitly authorize running this unapproved command during review.",
    );
  }

  const cp = await openControlPlane(values["state-dir"], workspaceRoots);
  const ctx = defaultRequestContext(values.owner, values.project);
  const evidence = await cp.probe.observeServer(ctx, config, {
    allowUnapprovedStdioProbe: Boolean(values["allow-stdio-probe"]),
  });

  const defaultRemotePerms: Permission[] =
    config.transport.type === "streamable-http" && evidence.endpoint
      ? [
          normalizePermission(
            {
              capability: "network.connect",
              resource: evidence.endpoint.origin,
            },
            evidence,
          ),
        ]
      : [];

  const effectivePermissions: Permission[] =
    permissions.length > 0
      ? permissions.map((p) => normalizePermission(p, evidence))
      : [
          ...defaultRemotePerms,
          ...credentialBindings.map((b) =>
            normalizePermission(
              { capability: "credential.use", resource: b.ref_id },
              evidence,
            ),
          ),
          ...evidence.tools.map((t) =>
            normalizePermission(
              { capability: "tool.invoke", resource: t.name },
              evidence,
            ),
          ),
        ];

  const review = await cp.admin.submitCandidate(ctx, {
    evidence,
    permissions: effectivePermissions,
    credential_bindings: credentialBindings,
  });

  await cp.registry.upsert({
    ...config,
    permissions: effectivePermissions,
  });

  if (values.json) {
    out(JSON.stringify({ review, tools: evidence.tools }, null, 2));
    return;
  }
  out(`Review created: ${review.review_id}`);
  out(`Server: ${review.integration_id} (${config.transport.type})`);
  out(`Binding SHA-256: ${review.binding_sha256}`);
  out(
    `Tools (${evidence.tools.length}): ${evidence.tools.map((t) => t.name).join(", ") || "(none)"}`,
  );
  out(
    `Permissions (${review.permissions.length}): ${review.permissions.map((p) => `${p.capability}:${p.resource}`).join(", ") || "(none)"}`,
  );
  out(`Next: mars mcp approve ${review.review_id}`);
}

async function handleApprove(
  args: string[],
  out: (line: string) => void,
  workspaceRoots: string[] | undefined,
): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      "state-dir": { type: "string" },
      owner: { type: "string" },
      project: { type: "string" },
      "ttl-ms": { type: "string" },
      "approved-by": { type: "string" },
      json: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  const reviewId = positionals[0];
  if (!reviewId) {
    throw new CliUsageError(
      `Missing <review-id> for "mars mcp approve".\n${MCP_USAGE}`,
    );
  }
  const ttlMs = parsePositiveInt(values["ttl-ms"], "--ttl-ms");

  const cp = await openControlPlane(values["state-dir"], workspaceRoots, {
    ...(values.owner ? { ownerId: values.owner } : {}),
    ...(values.project ? { projectId: values.project } : {}),
    ...(values["approved-by"] ? { approverId: values["approved-by"] } : {}),
  });
  const ctx = defaultRequestContext(values.owner, values.project);
  const { state } = await cp.readState();
  const review = state.reviews.find((r) => r.review_id === reviewId);
  if (!review) {
    throw new CliUsageError(`Review not found: ${reviewId}`);
  }

  const proof = cp.signHostProof({
    review_id: review.review_id,
    review_revision: review.revision,
    binding_sha256: review.binding_sha256,
    scope: review.scope,
    decision: "approve",
    expires_at: review.expires_at,
    ...(values["approved-by"] ? { approver_id: values["approved-by"] } : {}),
  });

  const grant = await cp.admin.approve(ctx, {
    review_id: review.review_id,
    expected_revision: review.revision,
    proof,
    ...(ttlMs !== undefined ? { ttl_ms: ttlMs } : {}),
  });

  if (values.json) {
    out(JSON.stringify({ grant }, null, 2));
    return;
  }
  out(`Grant approved: ${grant.grant_id}`);
  out(`Server: ${grant.integration_id}`);
  out(`Binding SHA-256: ${grant.binding_sha256}`);
  out(`Expires: ${grant.expires_at}`);
}

async function handleRevoke(
  args: string[],
  out: (line: string) => void,
  workspaceRoots: string[] | undefined,
): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      "state-dir": { type: "string" },
      owner: { type: "string" },
      project: { type: "string" },
      "approved-by": { type: "string" },
      json: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  const grantId = positionals[0];
  if (!grantId) {
    throw new CliUsageError(
      `Missing <grant-id> for "mars mcp revoke".\n${MCP_USAGE}`,
    );
  }

  const cp = await openControlPlane(values["state-dir"], workspaceRoots, {
    ...(values.owner ? { ownerId: values.owner } : {}),
    ...(values.project ? { projectId: values.project } : {}),
    ...(values["approved-by"] ? { approverId: values["approved-by"] } : {}),
  });
  const ctx = defaultRequestContext(values.owner, values.project);
  const { state } = await cp.readState();
  const grant = state.grants.find((g) => g.grant_id === grantId);
  if (!grant) {
    throw new CliUsageError(`Grant not found: ${grantId}`);
  }

  const proof = cp.signHostProof({
    review_id: grant.review_id,
    review_revision: grant.revision,
    binding_sha256: grant.binding_sha256,
    scope: grant.scope,
    decision: "revoke",
    expires_at: grant.expires_at,
    ...(values["approved-by"] ? { approver_id: values["approved-by"] } : {}),
  });

  await cp.admin.revoke(ctx, {
    grant_id: grant.grant_id,
    expected_revision: grant.revision,
    proof,
  });

  if (values.json) {
    out(JSON.stringify({ revoked: grant.grant_id }, null, 2));
    return;
  }
  out(`Grant revoked: ${grant.grant_id} (${grant.integration_id})`);
}

async function handleTest(
  args: string[],
  out: (line: string) => void,
  workspaceRoots: string[] | undefined,
): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      "state-dir": { type: "string" },
      owner: { type: "string" },
      project: { type: "string" },
      tool: { type: "string" },
      input: { type: "string" },
      permission: { type: "string", multiple: true },
      "credential-ref": { type: "string" },
      "target-origin": { type: "string" },
      json: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  const serverId = positionals[0];
  if (!serverId) {
    throw new CliUsageError(
      `Missing <server-id> for "mars mcp test".\n${MCP_USAGE}`,
    );
  }

  let parsedInput: Record<string, unknown> = {};
  if (values.input !== undefined) {
    let raw: unknown;
    try {
      raw = JSON.parse(values.input);
    } catch {
      throw new CliUsageError("Invalid --input: must be valid JSON object");
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new CliUsageError("Invalid --input: must be a JSON object");
    }
    parsedInput = raw as Record<string, unknown>;
  }

  const requestedPermissions = values.permission
    ? values.permission.map(parsePermissionFlag)
    : undefined;

  if (
    values["credential-ref"] !== undefined &&
    !CLI_CREDENTIAL_REF_RE.test(values["credential-ref"])
  ) {
    throw new CliUsageError(
      `Invalid --credential-ref "${values["credential-ref"]}". CLI credential refs must use lowercase letters, digits, and underscores only (matching /^[a-z0-9][a-z0-9_]*$/) so they map 1-to-1 to MARS_MCP_CREDENTIAL_<UPPER>.`,
    );
  }

  const cp = await openControlPlane(values["state-dir"], workspaceRoots);
  const ctx = defaultRequestContext(values.owner, values.project);

  try {
    const admitted = await cp.loader.admitServer(ctx, serverId);
    if (!values.tool) {
      if (values.json) {
        out(JSON.stringify({ admitted }, null, 2));
        return;
      }
      out(
        `Admitted ${admitted.server_id} [${admitted.transport}] grant=${admitted.grant_id} tools=${admitted.descriptor.tools.map((t) => t.name).join(",") || "(none)"}`,
      );
      return;
    }

    const result = await cp.loader.invokeTool(ctx, {
      server_id: serverId,
      tool: values.tool,
      input: parsedInput,
      ...(requestedPermissions
        ? { requested_permissions: requestedPermissions }
        : {}),
      ...(values["credential-ref"]
        ? { credential_ref: values["credential-ref"] }
        : {}),
      ...(values["target-origin"]
        ? { target_origin: values["target-origin"] }
        : {}),
    });

    if (values.json) {
      out(JSON.stringify({ admitted, result }, null, 2));
      return;
    }
    out(
      `Invoked ${result.server_id}.${result.tool} (untrusted=${String(result.untrusted)}, stripped_steering=${result.stripped_steering_fields.length})`,
    );
    out(JSON.stringify(result.content));
  } finally {
    await cp.loader.closeAll();
  }
}

export async function runMcp(
  args: string[],
  options: RunMcpOptions = {},
): Promise<void> {
  const out = options.stdout ?? ((line: string) => console.log(line));
  const subcommand = args[0];
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    throw new CliUsageError(MCP_USAGE);
  }
  const rest = args.slice(1);
  if (subcommand === "list") {
    await handleList(rest, out, options.workspaceRoots);
    return;
  }
  if (subcommand === "review") {
    await handleReview(rest, out, options.workspaceRoots);
    return;
  }
  if (subcommand === "approve") {
    await handleApprove(rest, out, options.workspaceRoots);
    return;
  }
  if (subcommand === "revoke") {
    await handleRevoke(rest, out, options.workspaceRoots);
    return;
  }
  if (subcommand === "test") {
    await handleTest(rest, out, options.workspaceRoots);
    return;
  }
  throw new CliUsageError(
    `Unknown mcp subcommand: ${subcommand}\n${MCP_USAGE}`,
  );
}
