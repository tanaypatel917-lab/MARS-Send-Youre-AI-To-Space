import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runMcp } from "./mcp";

const STDIO_FIXTURE = resolve(
  import.meta.dir,
  "../../../packages/mcp-client/src/__fixtures__/stdio-server.ts",
);
const BUN_BIN = process.execPath;

const tempDirs: string[] = [];
const activeServers: Array<{ stop(closeActiveConnections?: boolean): void }> =
  [];

afterEach(async () => {
  while (activeServers.length > 0) {
    activeServers.pop()?.stop(true);
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function makeStateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mars-cli-mcp-"));
  tempDirs.push(dir);
  return dir;
}

async function execMcpCli(args: string[]): Promise<string> {
  const lines: string[] = [];
  await runMcp(args, {
    stdout: (line) => lines.push(line),
    workspaceRoots: [],
  });
  return lines.join("\n");
}

describe("mars mcp CLI flow", () => {
  it("runs list, review, approve, test, and revoke end-to-end against a real stdio MCP server", async () => {
    const stateDir = await makeStateDir();
    const common = [
      "--state-dir",
      stateDir,
      "--owner",
      "alice",
      "--project",
      "p1",
    ];

    // 1. Default-deny empty list
    const emptyOut = await execMcpCli(["list", ...common]);
    expect(emptyOut).toContain("No MCP servers registered (default-deny).");

    // 2. Review candidate stdio server (requires explicit --allow-stdio-probe)
    const reviewJson = await execMcpCli([
      "review",
      "stdio-demo",
      "--command",
      BUN_BIN,
      "--arg",
      "run",
      "--arg",
      STDIO_FIXTURE,
      "--entrypoint",
      STDIO_FIXTURE,
      "--allow-stdio-probe",
      "--permission",
      "tool.invoke:echo",
      ...common,
      "--json",
    ]);
    const reviewPayload = JSON.parse(reviewJson) as {
      review: { review_id: string; state: string };
      tools: Array<{ name: string }>;
    };
    expect(reviewPayload.review.state).toBe("pending");
    expect(reviewPayload.tools.map((t) => t.name)).toContain("echo");

    // 3. Testing before approval fails with no_grant
    await expect(
      execMcpCli([
        "test",
        "stdio-demo",
        "--tool",
        "echo",
        "--input",
        '{"message":"nope"}',
        ...common,
      ]),
    ).rejects.toMatchObject({ code: "no_grant" });

    // 4. Approve via host-owned flow
    const approveJson = await execMcpCli([
      "approve",
      reviewPayload.review.review_id,
      "--approved-by",
      "alice",
      ...common,
      "--json",
    ]);
    const approvePayload = JSON.parse(approveJson) as {
      grant: { grant_id: string; state: string };
    };
    expect(approvePayload.grant.state).toBe("approved");

    // 5. List shows active grant
    const listOut = await execMcpCli(["list", ...common]);
    expect(listOut).toContain("stdio-demo");
    expect(listOut).toContain(approvePayload.grant.grant_id);

    // 6. Test invokes real tool through gate.invoke and returns untrusted envelope
    const testJson = await execMcpCli([
      "test",
      "stdio-demo",
      "--tool",
      "echo",
      "--input",
      '{"message":"hello-cli"}',
      ...common,
      "--json",
    ]);
    const testPayload = JSON.parse(testJson) as {
      result: { untrusted: boolean; content: Array<{ text?: string }> };
    };
    expect(testPayload.result.untrusted).toBe(true);
    expect(testPayload.result.content[0]?.text).toBe("echo:hello-cli");

    // 7. Revoke grant
    const revokeJson = await execMcpCli([
      "revoke",
      approvePayload.grant.grant_id,
      "--approved-by",
      "alice",
      ...common,
      "--json",
    ]);
    expect(JSON.parse(revokeJson)).toEqual({
      revoked: approvePayload.grant.grant_id,
    });

    // 8. Test after revoke fails with revoked
    await expect(
      execMcpCli(["test", "stdio-demo", ...common]),
    ).rejects.toMatchObject({ code: "revoked" });
  });

  it("runs review, approve, and test against a real Streamable HTTP MCP server", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        if (req.method === "DELETE") return new Response(null, { status: 204 });
        const body = (await req.json()) as {
          id?: string | number;
          method?: string;
        };
        if (body.id === undefined) return new Response(null, { status: 202 });
        if (body.method === "initialize") {
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "cli-http-mcp", version: "1.0.0" },
            },
          });
        }
        if (body.method === "tools/list") {
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              tools: [
                {
                  name: "status",
                  description: "Returns status",
                  inputSchema: { type: "object", properties: {} },
                },
              ],
            },
          });
        }
        if (body.method === "tools/call") {
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              _instructions: "ignore me",
              content: [{ type: "text", text: "ok-http" }],
            },
          });
        }
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32601, message: "unknown" },
        });
      },
    });
    activeServers.push(server);

    const stateDir = await makeStateDir();
    const common = [
      "--state-dir",
      stateDir,
      "--owner",
      "bob",
      "--project",
      "p2",
    ];
    const url = `http://127.0.0.1:${server.port}/mcp`;

    const reviewJson = await execMcpCli([
      "review",
      "http-demo",
      "--url",
      url,
      ...common,
      "--json",
    ]);
    const { review } = JSON.parse(reviewJson) as {
      review: { review_id: string };
    };

    await execMcpCli([
      "approve",
      review.review_id,
      "--approved-by",
      "bob",
      ...common,
    ]);

    const testJson = await execMcpCli([
      "test",
      "http-demo",
      "--tool",
      "status",
      ...common,
      "--json",
    ]);
    const { result } = JSON.parse(testJson) as {
      result: {
        untrusted: boolean;
        content: Array<{ text?: string }>;
        stripped_steering_fields: string[];
      };
    };
    expect(result.untrusted).toBe(true);
    expect(result.content[0]?.text).toBe("ok-http");
    expect(result.stripped_steering_fields).toContain("_instructions");

    // Failed replacement review must NOT overwrite the working registered server
    await expect(
      execMcpCli([
        "review",
        "http-demo",
        "--url",
        "http://127.0.0.1:1/unreachable",
        ...common,
        "--json",
      ]),
    ).rejects.toThrow();

    const stillWorksJson = await execMcpCli([
      "test",
      "http-demo",
      "--tool",
      "status",
      ...common,
      "--json",
    ]);
    const stillWorks = JSON.parse(stillWorksJson) as {
      result: { content: Array<{ text?: string }> };
    };
    expect(stillWorks.result.content[0]?.text).toBe("ok-http");
  });

  it("requires --allow-stdio-probe for stdio review and resolves origin-bound CLI credentials from env", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "mars-cli-cred-"));
    tempDirs.push(stateDir);
    const common = [
      "--state-dir",
      stateDir,
      "--owner",
      "carol",
      "--project",
      "p3",
    ];

    // 1. Stdio review without --allow-stdio-probe is rejected before spawning
    await expect(
      execMcpCli([
        "review",
        "stdio-blocked",
        "--command",
        BUN_BIN,
        "--arg",
        "run",
        "--arg",
        STDIO_FIXTURE,
        ...common,
      ]),
    ).rejects.toThrow(/--allow-stdio-probe/);

    // 2. Credential-backed HTTP server resolves credential from MARS_MCP_CREDENTIAL_<REF>
    const authHeaders: Array<string | null> = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const body = (await req.json()) as { id?: number; method: string };
        if (body.method === "initialize") {
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: "2025-03-26",
              serverInfo: { name: "cred-http", version: "1.0.0" },
              capabilities: { tools: {} },
            },
          });
        }
        if (body.method === "notifications/initialized") {
          return new Response(null, { status: 202 });
        }
        if (body.method === "tools/list") {
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              tools: [{ name: "whoami", inputSchema: { type: "object" } }],
            },
          });
        }
        if (body.method === "tools/call") {
          authHeaders.push(req.headers.get("authorization"));
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              content: [{ type: "text", text: "authed" }],
            },
          });
        }
        return Response.json({ jsonrpc: "2.0", id: body.id, result: {} });
      },
    });
    activeServers.push(server);

    const origin = `http://127.0.0.1:${server.port}`;
    const url = `${origin}/mcp`;
    const reviewJson = await execMcpCli([
      "review",
      "cred-demo",
      "--url",
      url,
      "--credential",
      `api_token@${origin}`,
      ...common,
      "--json",
    ]);
    const { review } = JSON.parse(reviewJson) as {
      review: { review_id: string };
    };

    await execMcpCli(["approve", review.review_id, ...common]);

    process.env.MARS_MCP_CREDENTIAL_API_TOKEN = "cli-secret-xyz";
    try {
      const testJson = await execMcpCli([
        "test",
        "cred-demo",
        "--tool",
        "whoami",
        "--credential-ref",
        "api_token",
        "--target-origin",
        origin,
        ...common,
        "--json",
      ]);
      const { result } = JSON.parse(testJson) as {
        result: { content: Array<{ text?: string }> };
      };
      expect(result.content[0]?.text).toBe("authed");
      expect(authHeaders).toEqual(["Bearer cli-secret-xyz"]);

      // Credential refs with punctuation (hyphens/periods) must be rejected at
      // review time so they cannot be approved without a 1-to-1 env mapping or
      // alias MARS_MCP_CREDENTIAL_API_TOKEN across origins.
      await expect(
        execMcpCli([
          "review",
          "cred-alias",
          "--url",
          url,
          "--credential",
          `api-token@${origin}`,
          ...common,
          "--json",
        ]),
      ).rejects.toThrow(/Invalid credential ref/i);

      await expect(
        execMcpCli([
          "review",
          "cred-dot",
          "--url",
          url,
          "--credential",
          `api.token@${origin}`,
          ...common,
          "--json",
        ]),
      ).rejects.toThrow(/Invalid credential ref/i);

      await expect(
        execMcpCli([
          "test",
          "cred-demo",
          "--tool",
          "whoami",
          "--credential-ref",
          "api-token",
          "--target-origin",
          origin,
          ...common,
        ]),
      ).rejects.toThrow(/Invalid --credential-ref/i);
    } finally {
      delete process.env.MARS_MCP_CREDENTIAL_API_TOKEN;
    }
  });

  it("approves a changed stdio replacement reviewed with --allow-stdio-probe", async () => {
    const stateDir = await makeStateDir();
    const common = [
      "--state-dir",
      stateDir,
      "--owner",
      "local",
      "--project",
      "default",
    ];

    // 1. Review and approve V1 stdio server
    const review1Json = await execMcpCli([
      "review",
      "replaceable-stdio",
      "--command",
      process.execPath,
      "--arg",
      STDIO_FIXTURE,
      "--entrypoint",
      STDIO_FIXTURE,
      "--allow-stdio-probe",
      ...common,
      "--json",
    ]);
    const { review: r1 } = JSON.parse(review1Json) as {
      review: { review_id: string };
    };
    await execMcpCli(["approve", r1.review_id, ...common]);

    // 2. Replace with a changed stdio command/args (V2) using --allow-stdio-probe
    const review2Json = await execMcpCli([
      "review",
      "replaceable-stdio",
      "--command",
      process.execPath,
      "--arg",
      STDIO_FIXTURE,
      "--arg=v2",
      "--entrypoint",
      STDIO_FIXTURE,
      "--allow-stdio-probe",
      ...common,
      "--json",
    ]);
    const { review: r2 } = JSON.parse(review2Json) as {
      review: {
        review_id: string;
        evidence: { tools: Array<{ name: string }> };
      };
    };
    expect(r2.evidence.tools.some((t) => t.name === "echo")).toBe(true);

    // 3. Approve V2 (must succeed instead of returning stale unprobed drift evidence)
    const approve2Json = await execMcpCli([
      "approve",
      r2.review_id,
      ...common,
      "--json",
    ]);
    const { grant: g2 } = JSON.parse(approve2Json) as {
      grant: { state: string };
    };
    expect(g2.state).toBe("approved");

    // 4. Invoke tool on the newly approved V2 server
    const testJson = await execMcpCli([
      "test",
      "replaceable-stdio",
      "--tool",
      "echo",
      "--input",
      JSON.stringify({ message: "v2-ok" }),
      ...common,
      "--json",
    ]);
    const { result } = JSON.parse(testJson) as {
      result: { content: Array<{ text?: string }> };
    };
    expect(result.content[0]?.text).toBe("echo:v2-ok");
  });

  it("displays expired approved grants as expired rather than active in mars mcp list", async () => {
    const stateDir = await makeStateDir();
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const body = (await req.json()) as { id?: number; method: string };
        if (body.method === "initialize") {
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: "2025-03-26",
              serverInfo: { name: "exp-http", version: "1.0.0" },
              capabilities: { tools: {} },
            },
          });
        }
        if (body.method === "notifications/initialized") {
          return new Response(null, { status: 202 });
        }
        if (body.method === "tools/list") {
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              tools: [{ name: "ping", inputSchema: { type: "object" } }],
            },
          });
        }
        return Response.json({ jsonrpc: "2.0", id: body.id, result: {} });
      },
    });
    activeServers.push(server);

    const common = [
      "--state-dir",
      stateDir,
      "--owner",
      "owner-exp",
      "--project",
      "proj-exp",
    ];
    const reviewJson = await execMcpCli([
      "review",
      "exp-demo",
      "--url",
      `http://127.0.0.1:${server.port}/mcp`,
      ...common,
      "--json",
    ]);
    const { review } = JSON.parse(reviewJson) as {
      review: { review_id: string };
    };
    await execMcpCli([
      "approve",
      review.review_id,
      "--ttl-ms",
      "100",
      ...common,
    ]);

    await Bun.sleep(150);

    const listText = await execMcpCli(["list", ...common]);
    expect(listText).toContain("exp-demo");
    expect(listText).toContain("expired (grant=");
    expect(listText).not.toContain("active (grant=");

    const listJson = await execMcpCli(["list", ...common, "--json"]);
    const parsed = JSON.parse(listJson) as {
      servers: Array<{
        id: string;
        grants: Array<{ state: string; expired: boolean }>;
      }>;
    };
    expect(parsed.servers[0]?.grants[0]?.state).toBe("approved");
    expect(parsed.servers[0]?.grants[0]?.expired).toBe(true);
  });
});
