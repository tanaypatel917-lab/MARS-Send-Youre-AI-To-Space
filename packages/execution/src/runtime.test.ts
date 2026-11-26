import { expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelConfig, RequestContext, Task } from "@mars/contracts";
import {
  createHostMcpControlPlane,
  type McpServerConfig,
} from "@mars/mcp-client";
import { loadModelRegistry, ModelRouter } from "@mars/providers";
import type { Model } from "@oh-my-pi/pi-ai";
import { AgentSession, SessionManager } from "@oh-my-pi/pi-coding-agent";
import { startStatefulMcpServer } from "../../mcp-client/src/__fixtures__/stateful-http";
import { anchorOf } from "./anchored-edit";
import type { EditFormat } from "./edit-format";
import {
  type BudgetLedger,
  createModelBridge,
  selectExecutionModel,
  toChatRequest,
  WORKSPACE_PLACEHOLDER,
} from "./model-bridge";
import {
  boundPatchSummary,
  DEFAULT_GREP_FORMATTER,
  initialRequestAllowance,
  MAX_SYSTEM_PROMPT_CHARS,
  openRuntimeSession,
  type RuntimeSession,
  type RuntimeTools,
} from "./runtime";

test("mars_grep is essential only with read approval and a provider search binding", async () => {
  for (const read of [true, false])
    for (const available of [true, false]) {
      const f = await fixture();
      try {
        const session = await f.open({
          approvals: { read, write: false, execute: false },
          tools: {
            ...f.tools,
            ...(available
              ? {
                  grep: async () => ({
                    matches: [],
                    truncated: false,
                    limitReached: false,
                  }),
                }
              : {}),
          },
        });
        expect(session.toolNames.includes("mars_grep")).toBe(read && available);
        expect(session.toolNames).not.toContain("grep");
        const allowance = {
          approvals: { read, write: false, execute: false },
          recall: false,
          instruction: "search",
        };
        const baseline = initialRequestAllowance(allowance);
        const withGrep = initialRequestAllowance({
          ...allowance,
          grep: available,
        });
        if (read && available) expect(withGrep).toBeGreaterThan(baseline);
        else expect(withGrep).toBe(baseline);
      } finally {
        await f.cleanup();
      }
    }
});

test("mars_grep formats search results, supports a formatter seam and journals tool calls", async () => {
  for (const custom of [false, true]) {
    const f = await fixture();
    const requests: Record<string, unknown>[] = [];
    const observed: string[] = [];
    try {
      const session = await f.open({
        tools: {
          ...f.tools,
          async grep(request) {
            expect(request.pattern).toBe("needle");
            expect(request.signal).toBeInstanceOf(AbortSignal);
            return {
              matches: [
                {
                  path: "src/a.ts",
                  lineNumber: 2,
                  line: "needle",
                  contextBefore: [{ lineNumber: 1, line: "before" }],
                  contextAfter: [{ lineNumber: 3, line: "after" }],
                },
              ],
              truncated: false,
              limitReached: false,
            };
          },
        },
        ...(custom
          ? {
              grepFormatter: {
                match: (match) =>
                  `anchor|${DEFAULT_GREP_FORMATTER.match(match)}`,
                context: (path, line) =>
                  `anchor|${DEFAULT_GREP_FORMATTER.context(path, line)}`,
              },
            }
          : {}),
        onEvent: async (event) => {
          if (event.tool_name === "mars_grep") observed.push(event.type);
        },
        fetch: async (_url, init) => {
          requests.push(JSON.parse(String(init?.body)));
          return requests.length === 1
            ? sse(
                {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_grep",
                      type: "function",
                      function: {
                        name: "mars_grep",
                        arguments: JSON.stringify({
                          pattern: "needle",
                          context: 1,
                        }),
                      },
                    },
                  ],
                },
                "tool_calls",
              )
            : sse({ content: "Found it." });
        },
      });
      expect((await session.run(f.task.request)).status).toBe("completed");
      expect(requests).toHaveLength(2);
      for (const line of [
        `src/a.ts:${anchorOf(1, "before")}|before`,
        `src/a.ts:${anchorOf(2, "needle")}|needle`,
        `src/a.ts:${anchorOf(3, "after")}|after`,
      ])
        expect(JSON.stringify(requests[1])).toContain(
          `${custom ? "anchor|" : ""}${line}`,
        );
      expect(observed).toContain("tool_execution_start");
      expect(observed).toContain("tool_execution_end");
      expect(await readFile(session.journalPath, "utf8")).toContain(
        '"toolName":"mars_grep"',
      );
    } finally {
      await f.cleanup();
    }
  }
});

test("mars_grep handles empty results, strict params, host denial and oversized formatter output", async () => {
  for (const kind of ["empty", "invalid", "denied", "oversized"] as const) {
    const f = await fixture();
    const requests: Record<string, unknown>[] = [];
    let calls = 0;
    try {
      const session = await f.open({
        tools: {
          ...f.tools,
          async grep() {
            calls += 1;
            if (kind === "denied")
              throw new Error("Read approval revoked by host");
            return {
              matches:
                kind === "oversized"
                  ? [{ path: "a.ts", lineNumber: 1, line: "needle" }]
                  : [],
              truncated: false,
              limitReached: false,
            };
          },
        },
        ...(kind === "oversized"
          ? {
              grepFormatter: {
                match: () => "😀".repeat(20000),
                context: () => "",
              },
            }
          : {}),
        fetch: async (_url, init) => {
          requests.push(JSON.parse(String(init?.body)));
          return requests.length === 1
            ? sse(
                {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_grep",
                      type: "function",
                      function: {
                        name: "mars_grep",
                        arguments: JSON.stringify({
                          pattern: "needle",
                          ...(kind === "invalid" ? { extra: true } : {}),
                        }),
                      },
                    },
                  ],
                },
                "tool_calls",
              )
            : sse({ content: "Done." });
        },
      });
      await session.run(f.task.request);
      expect(calls).toBe(kind === "invalid" ? 0 : 1);
      const relayed = JSON.stringify(requests[1]);
      if (kind === "empty") expect(relayed).toContain("No matches found.");
      if (kind === "denied")
        expect(relayed).toContain("Read approval revoked by host");
      if (kind === "invalid") expect(relayed).toContain("extra");
      if (kind === "oversized") {
        expect(relayed).toContain("search output truncated / limit reached");
        expect(Buffer.byteLength(relayed)).toBeLessThan(64 * 1024);
      }
    } finally {
      await f.cleanup();
    }
  }
});

test("mars_grep checkTool blocks searching outside an active run", async () => {
  const f = await fixture();
  let calls = 0;
  let sdkSession: AgentSession | undefined;
  const prompt = spyOn(AgentSession.prototype, "prompt").mockImplementation(
    async function (this: AgentSession) {
      sdkSession = this;
      return true;
    },
  );
  try {
    const session = await f.open({
      tools: {
        ...f.tools,
        async grep() {
          calls += 1;
          return { matches: [], truncated: false, limitReached: false };
        },
      },
    });
    await session.run(f.task.request);
    const tool = sdkSession?.getToolByName("mars_grep");
    if (!tool) throw new Error("Missing grep tool");
    await expect(
      tool.execute("stopped", { pattern: "needle" }),
    ).rejects.toThrow("not authorized");
    expect(calls).toBe(0);
  } finally {
    prompt.mockRestore();
    await f.cleanup();
  }
});

function sse(
  delta: Record<string, unknown>,
  reason = "stop",
  completionTokens = 12,
) {
  return new Response(
    [
      `data: ${JSON.stringify({ choices: [{ delta, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }], usage: { prompt_tokens: 50, completion_tokens: completionTokens } })}\n\n`,
      "data: [DONE]\n\n",
    ].join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

test("mars_read outlines large files, returns ranges and refuses policy-denied reads", async () => {
  for (const kind of [
    "outline",
    "long-line",
    "range",
    "denied",
    "invalid",
  ] as const) {
    const f = await fixture();
    const requests: Record<string, unknown>[] = [];
    let reads = 0;
    let readStarted = 0;
    let readDuration = Number.POSITIVE_INFINITY;
    try {
      const session = await f.open({
        readSummary: { thresholdBytes: 16 },
        tools: {
          ...f.tools,
          async read() {
            reads += 1;
            if (kind === "denied")
              throw new Error("Read denied by host policy");
            if (kind === "long-line") {
              readStarted = performance.now();
              return new TextEncoder().encode(`a(${"b):".repeat(333334)}`);
            }
            return new TextEncoder().encode(
              `first\nsecond\n${"export function large() {}\n".repeat(6000)}`,
            );
          },
        },
        fetch: async (_url, init) => {
          requests.push(JSON.parse(String(init?.body)));
          if (kind === "long-line" && requests.length === 2)
            readDuration = performance.now() - readStarted;
          return requests.length === 1
            ? sse(
                {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_read",
                      type: "function",
                      function: {
                        name: "mars_read",
                        arguments: JSON.stringify({
                          path: "large.ts",
                          ...(kind === "range" ? { offset: 2, limit: 1 } : {}),
                          ...(kind === "invalid"
                            ? { offset: 0, unexpected: true }
                            : {}),
                        }),
                      },
                    },
                  ],
                },
                "tool_calls",
              )
            : sse({ content: "Done." });
        },
      });
      await session.run(f.task.request);
      expect(reads).toBe(kind === "invalid" ? 0 : 1);
      const result = JSON.stringify(requests[1]);
      if (kind === "outline") {
        expect(result).toContain("Heuristic outline");
        expect(result).toContain("16-byte summary threshold");
      }
      if (kind === "long-line") {
        expect(result).toContain("Heuristic outline");
        expect(result).toContain("1 lines, 1000004 bytes");
        expect(readDuration).toBeLessThan(1000);
      }
      if (kind === "range") {
        expect(result).toContain(`${anchorOf(2, "second")}|second`);
        expect(result).not.toContain("export function large");
      }
      if (kind === "denied")
        expect(result).toContain("Read denied by host policy");
    } finally {
      await f.cleanup();
    }
  }
});

test("mars_read checkTool refuses reads outside an active run", async () => {
  const f = await fixture();
  let reads = 0;
  let sdkSession: AgentSession | undefined;
  const prompt = spyOn(AgentSession.prototype, "prompt").mockImplementation(
    async function (this: AgentSession) {
      sdkSession = this;
      return true;
    },
  );
  try {
    const session = await f.open({
      tools: {
        ...f.tools,
        async read() {
          reads += 1;
          return new Uint8Array();
        },
      },
    });
    await session.run(f.task.request);
    const tool = sdkSession?.getToolByName("mars_read");
    if (!tool) throw new Error("Missing read tool");
    await expect(
      tool.execute("stopped", { path: "a.ts", offset: 1 }),
    ).rejects.toThrow("not authorized");
    expect(reads).toBe(0);
  } finally {
    prompt.mockRestore();
    await f.cleanup();
  }
});

async function fixture(
  contextWindow = 32000,
  modelConfig: Partial<ModelConfig> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "mars-runtime-test-"));
  const cwd = join(root, "workspace");
  const home = join(root, "home");
  await mkdir(cwd);
  await mkdir(join(home, ".mars"), { recursive: true });
  await writeFile(
    join(home, ".mars", "models.json"),
    JSON.stringify({
      version: 1,
      providers: [
        {
          id: "fixture",
          kind: "openai-compatible",
          baseUrl: "https://fixture.invalid/v1",
          apiKeyEnv: "MARS_FIXTURE_KEY",
        },
      ],
      models: [
        {
          id: "fixture/free",
          providerId: "fixture",
          model: "stub",
          capabilities: { tools: true, vision: false, contextWindow },
          pricing: { free: true },
          ...modelConfig,
        },
        {
          id: "fixture/paid",
          providerId: "fixture",
          model: "stub",
          capabilities: { tools: true, vision: false, contextWindow },
          pricing: { free: false, inputPerMTokUsd: 1, outputPerMTokUsd: 2 },
        },
        {
          id: "fixture/unknown",
          providerId: "fixture",
          model: "stub",
          capabilities: { tools: true, vision: false, contextWindow },
          pricing: { free: false },
        },
      ],
      routes: { default: ["fixture/paid", "fixture/free"] },
      policy: { allowPaid: true },
    }),
  );
  const env = { MARS_FIXTURE_KEY: "dummy-key-not-real" };
  const registry = await loadModelRegistry({ cwd, home, env });
  const task: Task = {
    schema_version: 1,
    task_id: randomUUID(),
    session_id: randomUUID(),
    scope: {
      owner_id: "fixture",
      project_id: "fixture",
      workspace_id: "fixture",
    },
    revision: 0,
    request: "Create a greeting file.",
    acceptance_criteria: ["File contains Hello"],
    budget: {
      max_tokens: 24000,
      max_usd: 0,
      max_duration_ms: 60000,
      max_depth: 0,
      max_concurrency: 1,
    },
    status: "pending",
    specialist_revision: null,
    artifacts: [],
  };
  const tools: RuntimeTools = {
    read: (path) => readFile(join(cwd, path)),
    write: (path, content) => writeFile(join(cwd, path), content),
    execute: async () => {
      throw new Error("No execution sandbox in this unit fixture.");
    },
    stop: async () => undefined,
  };
  const sessions: RuntimeSession[] = [];
  return {
    root,
    cwd,
    env,
    registry,
    task,
    tools,
    stateDir: join(root, "state"),
    async open(extra: Partial<Parameters<typeof openRuntimeSession>[0]> = {}) {
      const session = await openRuntimeSession({
        task,
        cwd,
        stateDir: join(root, "state"),
        registry,
        tools,
        env,
        approvals: { read: true, write: true, execute: false },
        ...extra,
      });
      sessions.push(session);
      return session;
    },
    async cleanup() {
      for (const session of sessions) await session.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("execution chooses free models automatically and rejects unpriced paid models", async () => {
  const f = await fixture();
  try {
    expect(selectExecutionModel(f.registry).id).toBe("fixture/free");
    expect(selectExecutionModel(f.registry, "fixture/paid").id).toBe(
      "fixture/paid",
    );
    expect(() => selectExecutionModel(f.registry, "fixture/unknown")).toThrow(
      "No eligible",
    );
  } finally {
    await f.cleanup();
  }
});

test("a text-only model completes a task with MCP configured and no tools", async () => {
  const f = await fixture(32000, {
    capabilities: { tools: false, vision: false, contextWindow: 32000 },
  });
  try {
    const cp = await createHostMcpControlPlane({
      stateDir: join(f.root, "mcp"),
      workspaceRoots: [f.cwd],
      scope: f.task.scope,
    });
    let requested = false;
    const session = await f.open({
      modelId: "fixture/free",
      approvals: { read: false, write: false, execute: false },
      mcp: async () => ({
        loader: cp.loader,
        async listServerIds() {
          return (await cp.registry.list()).map(({ id }) => id);
        },
      }),
      fetch: async (_url, init) => {
        expect(JSON.parse(String(init?.body)).tools).toBeUndefined();
        requested = true;
        return sse({ content: "Done." });
      },
    });
    expect((await session.run("Give a text response.")).status).toBe(
      "completed",
    );
    expect(requested).toBe(true);
  } finally {
    await f.cleanup();
  }
});

async function registerRuntimeMcp(
  f: Awaited<ReturnType<typeof fixture>>,
  origin: string,
) {
  const { owner_id, project_id } = f.task.scope;
  const context: RequestContext = {
    schema_version: 1,
    scope: f.task.scope,
    request_id: f.task.task_id,
  };
  const cp = await createHostMcpControlPlane({
    stateDir: join(f.root, "mcp"),
    workspaceRoots: [f.cwd],
    scope: f.task.scope,
    approvers: [{ approver_id: owner_id, owner_id, project_ids: [project_id] }],
    credentialResolver: {
      async resolve(request) {
        expect(request.target_origin).toBe(origin);
        expect(request.ref_id).toBe("runtime_token");
        return "runtime-test-token";
      },
    },
  });
  const config: McpServerConfig = {
    schema_version: 1,
    id: "runtime-demo",
    transport: { type: "streamable-http", url: `${origin}/mcp` },
    registered_at: new Date().toISOString(),
    permissions: [
      { capability: "network.connect", resource: origin },
      { capability: "tool.invoke", resource: "ping" },
      { capability: "credential.use", resource: "runtime_token" },
    ],
    credential_bindings: [{ ref_id: "runtime_token", allowed_origin: origin }],
  };
  await cp.registry.upsert(config);
  const mcp = async () => ({
    loader: cp.loader,
    async listServerIds() {
      return (await cp.registry.list()).map(({ id }) => id);
    },
  });
  return { cp, context, config, mcp };
}

async function approveRuntimeMcp(
  {
    admin,
    probe,
    signHostProof,
  }: Awaited<ReturnType<typeof createHostMcpControlPlane>>,
  context: RequestContext,
  config: McpServerConfig,
) {
  const review = await admin.submitCandidate(context, {
    evidence: await probe.observeServer(context, config),
    permissions: config.permissions,
    credential_bindings: config.credential_bindings,
  });
  return admin.approve(context, {
    review_id: review.review_id,
    expected_revision: review.revision,
    proof: signHostProof({
      review_id: review.review_id,
      review_revision: review.revision,
      binding_sha256: review.binding_sha256,
      scope: review.scope,
      expires_at: review.expires_at,
      decision: "approve",
    }),
  });
}

test("normal runtime registers only scope-approved MCP tools and checks revocation before each model call", async () => {
  const f = await fixture();
  const http = startStatefulMcpServer(["ping", "unapproved"], {
    type: "object",
    properties: {
      tree: { $ref: "#/$defs/Tree" },
      query: { type: "string", description: "Untrusted server prose" },
      filter: {
        $ref: "#/$defs/Filter",
        properties: { limit: { type: "integer" } },
        required: ["limit"],
      },
      requiredOnly: { $ref: "#/$defs/Filter", required: ["term"] },
      delivery: {
        $ref: "#/$defs/Address",
        properties: { fallback: { $ref: "#/$defs/Address" } },
      },
      ...Object.fromEntries(
        Array.from({ length: 11 }, (_, i) => [`flag${i}`, { type: "boolean" }]),
      ),
      wide: {
        type: "object",
        properties: {
          ...Object.fromEntries(
            Array.from({ length: 4 }, (_, group) => [
              `group${group}`,
              {
                type: "object",
                properties: Object.fromEntries(
                  Array.from({ length: 63 }, (_, field) => [
                    `field${field}`,
                    { type: "string" },
                  ]),
                ),
              },
            ]),
          ),
          routes: {
            type: "array",
            items: {
              type: "object",
              properties: { destination: { type: "string" } },
              required: ["destination"],
            },
          },
        },
      },
      config: {
        type: "object",
        properties: {
          enabled: { type: "boolean" },
          retries: { type: "integer" },
          label: { type: "string" },
          timeoutSeconds: { type: "number" },
          routes: {
            type: "array",
            items: {
              type: "object",
              properties: {
                source: { type: "string" },
                destination: { type: "string" },
                protocol: { type: "string" },
              },
              required: ["source", "destination", "protocol"],
            },
          },
        },
      },
    },
    $defs: {
      Address: {
        type: "object",
        properties: { postalCode: { type: "string" } },
        required: ["postalCode"],
      },
      Tree: {
        type: "object",
        properties: Object.fromEntries(
          Array.from({ length: 8 }, (_, i) => [
            `branch${i}`,
            { $ref: "#/$defs/Tree" },
          ]),
        ),
      },
      Filter: {
        type: "object",
        properties: {
          exact: { type: "boolean", description: "Untrusted server prose" },
          term: { type: "string" },
        },
        required: ["exact"],
      },
    },
    required: ["query", "filter"],
  });
  const origin = http.server.url.origin;
  try {
    const { cp, context, config, mcp } = await registerRuntimeMcp(f, origin);
    const denied = await f.open({ mcp });
    expect(denied.toolNames.some((name) => name.startsWith("mars_mcp_"))).toBe(
      false,
    );
    expect(http.deleted).toHaveLength(0);
    await denied.dispose();

    const grant = await approveRuntimeMcp(cp, context, config);
    let modelCalls = 0;
    let modelSchema: unknown;
    const session = await f.open({
      task: { ...f.task, budget: { ...f.task.budget, max_tokens: 400_000 } },
      mcp,
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as {
          tools: Array<{ function: { name: string; parameters: unknown } }>;
          messages: unknown[];
        };
        const tool = body.tools.find(({ function: tool }) =>
          tool.name.startsWith("mars_mcp_ping_"),
        )?.function;
        const name = tool?.name;
        if (!name)
          throw new Error("Approved MCP tool was not offered to the model.");
        modelSchema ??= tool?.parameters;
        modelCalls++;
        if (modelCalls === 2) {
          expect(JSON.stringify(body.messages)).toContain("pong");
          expect(JSON.stringify(body.messages)).toContain("untrusted");
          await cp.admin.revoke(context, {
            grant_id: grant.grant_id,
            expected_revision: grant.revision,
            proof: cp.signHostProof({
              review_id: grant.review_id,
              review_revision: grant.revision,
              binding_sha256: grant.binding_sha256,
              scope: grant.scope,
              expires_at: grant.expires_at,
              decision: "revoke",
            }),
          });
        }
        if (modelCalls === 3) {
          expect(JSON.stringify(body.messages)).toContain(
            "MCP tool invocation was denied or failed",
          );
          return sse({ content: "Done." });
        }
        return sse(
          {
            tool_calls: [
              {
                index: 0,
                id: `mcp_${modelCalls}`,
                type: "function",
                function: {
                  name,
                  arguments: JSON.stringify({
                    query: "ping",
                    filter: { exact: true, limit: 1 },
                  }),
                },
              },
            ],
          },
          "tool_calls",
        );
      },
    });
    expect(
      session.toolNames.filter((name) => name.startsWith("mars_mcp_")),
    ).toHaveLength(1);
    const outcome = await session.run("Call the approved MCP tool.");
    expect(modelSchema).toMatchObject({
      type: "object",
      properties: {
        tree: { type: "object" },
        query: { type: "string" },
        filter: {
          type: "object",
          properties: {
            exact: { type: "boolean" },
            limit: { type: "integer" },
          },
          required: expect.arrayContaining(["exact", "limit"]),
        },
        requiredOnly: {
          properties: { term: { type: "string" } },
          required: expect.arrayContaining(["exact", "term"]),
        },
        delivery: {
          required: ["postalCode"],
          properties: {
            postalCode: { type: "string" },
            fallback: {
              required: ["postalCode"],
              properties: { postalCode: { type: "string" } },
            },
          },
        },
        wide: {
          properties: {
            group0: { type: "object" },
            group1: { type: "object" },
            group2: { type: "object" },
            group3: { type: "object" },
            routes: {
              type: "array",
              items: {
                type: "object",
                properties: { destination: { type: "string" } },
                required: ["destination"],
              },
            },
          },
        },
        config: {
          properties: {
            enabled: { type: "boolean" },
            routes: {
              items: {
                properties: {
                  source: { type: "string" },
                  destination: { type: "string" },
                  protocol: { type: "string" },
                },
                required: ["source", "destination", "protocol"],
              },
            },
          },
        },
      },
      required: expect.arrayContaining(["query", "filter"]),
    });
    expect(JSON.stringify(modelSchema)).not.toContain("Untrusted server prose");
    expect(outcome).toMatchObject({ status: "completed" });
    expect(modelCalls).toBe(3);
    expect(http.calls.map(({ identity }) => identity)).toEqual([
      "Bearer runtime-test-token",
    ]);
    expect(http.sessions.size).toBe(0);
  } finally {
    await f.cleanup();
    http.server.stop(true);
  }
}, 30000);

async function modelFacingMcpSchema(schema: Record<string, unknown>) {
  const f = await fixture();
  const http = startStatefulMcpServer(["ping"], schema);
  try {
    const { cp, context, config, mcp } = await registerRuntimeMcp(
      f,
      http.server.url.origin,
    );
    await approveRuntimeMcp(cp, context, config);
    let modelSchema: unknown;
    const session = await f.open({
      task: { ...f.task, budget: { ...f.task.budget, max_tokens: 400_000 } },
      mcp,
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as {
          tools: Array<{ function: { name: string; parameters: unknown } }>;
        };
        modelSchema = body.tools.find(({ function: tool }) =>
          tool.name.startsWith("mars_mcp_ping_"),
        )?.function.parameters;
        return sse({ content: "Done." });
      },
    });
    expect((await session.run("Describe the tool.")).status).toBe("completed");
    return modelSchema as SchemaNode;
  } finally {
    await f.cleanup();
    http.server.stop(true);
  }
}
type SchemaNode = {
  type?: string;
  required?: string[];
  properties?: Record<string, SchemaNode>;
};

test("a deep optional MCP argument leaves later top-level arguments visible to the model", async () => {
  const modelSchema = await modelFacingMcpSchema({
    type: "object",
    properties: {
      defaults: { $ref: "#/$defs/Defaults" },
      routes: {
        type: "array",
        items: {
          type: "object",
          properties: { destination: { type: "string" } },
          required: ["destination"],
        },
      },
    },
    $defs: {
      Defaults: {
        type: "object",
        properties: Object.fromEntries(
          Array.from({ length: 5 }, (_, group) => [
            `group${group}`,
            {
              type: "object",
              properties: {
                settings: {
                  type: "object",
                  properties: Object.fromEntries(
                    Array.from({ length: 50 }, (_, field) => [
                      `field${field}`,
                      { type: "string" },
                    ]),
                  ),
                  required: Array.from(
                    { length: 50 },
                    (_, field) => `field${field}`,
                  ),
                },
              },
              required: ["settings"],
            },
          ]),
        ),
        required: Array.from({ length: 5 }, (_, group) => `group${group}`),
      },
    },
  });
  const settings = (group: number) =>
    modelSchema.properties?.defaults?.properties?.[`group${group}`]?.properties
      ?.settings;
  expect(modelSchema).toMatchObject({
    properties: {
      defaults: {
        type: "object",
        required: ["group0", "group1", "group2", "group3", "group4"],
      },
      routes: {
        type: "array",
        items: {
          type: "object",
          properties: { destination: { type: "string" } },
          required: ["destination"],
        },
      },
    },
  });
  for (let group = 0; group < 5; group++)
    expect(settings(group)?.type).toBe("object");
  expect(settings(0)?.required).toHaveLength(50);
  // Past the node bound the last group is truncated, and `required` lists
  // only fields the model can see.
  const last = settings(4)?.required ?? [];
  expect(last).toEqual(Object.keys(settings(4)?.properties ?? {}));
  expect(last.length).toBeGreaterThan(0);
  expect(last.length).toBeLessThan(50);
}, 30000);

test("deep required MCP descendants leave optional top-level arguments visible to the model", async () => {
  const chain = (depth: number): Record<string, unknown> =>
    depth === 0
      ? { type: "string" }
      : {
          type: "object",
          properties: { next: chain(depth - 1) },
          required: ["next"],
        };
  const steps = Array.from({ length: 60 }, (_, step) => `step${step}`);
  const options = Array.from({ length: 63 }, (_, option) => `option${option}`);
  const modelSchema = await modelFacingMcpSchema({
    type: "object",
    properties: {
      config: {
        type: "object",
        properties: Object.fromEntries(steps.map((step) => [step, chain(6)])),
        required: steps,
      },
      ...Object.fromEntries(
        options.map((option) => [option, { type: "string" }]),
      ),
    },
    required: ["config"],
  });
  expect(Object.keys(modelSchema.properties ?? {})).toEqual(
    expect.arrayContaining(["config", ...options]),
  );
  for (const option of options)
    expect(modelSchema.properties?.[option]).toEqual({ type: "string" });
  expect(modelSchema.required).toContain("config");
  const config = modelSchema.properties?.config;
  expect(config?.required).toEqual(steps);
  expect(config?.properties?.step59).toMatchObject({
    type: "object",
    properties: { next: { type: "object" } },
    required: ["next"],
  });
}, 30000);

test("bridge preserves tool call identities and tool results without inventing another agent loop", () => {
  const request = toChatRequest({
    systemPrompt: ["System"],
    messages: [
      { role: "user", content: "Read file", timestamp: 1 },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call",
            name: "mars_read",
            arguments: { path: "a.txt" },
          },
        ],
        api: "fixture",
        provider: "fixture",
        model: "stub",
        timestamp: 2,
        stopReason: "toolUse",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
      {
        role: "toolResult",
        toolCallId: "call",
        toolName: "mars_read",
        content: [{ type: "text", text: "file contents" }],
        isError: false,
        timestamp: 3,
      },
    ],
  });
  expect(request.messages[2]).toMatchObject({
    role: "assistant",
    tool_calls: [{ id: "call", name: "mars_read" }],
  });
  expect(request.messages[3]).toEqual({
    role: "tool",
    tool_call_id: "call",
    content: "file contents",
  });
  expect(() =>
    toChatRequest({
      messages: [
        {
          role: "user",
          content: [{ type: "image", data: "fake", mimeType: "image/png" }],
          timestamp: 1,
        },
      ],
    }),
  ).toThrow("only supports text");
});

test("mars_proposals is a read-only host-bound tool rendering untrusted proposal text", async () => {
  const f = await fixture();
  const requests: Record<string, unknown>[] = [];
  let summaries = 0;
  try {
    const session = await f.open({
      proposals: {
        async summary() {
          summaries += 1;
          return "[untrusted optimization candidate c1 · proposed · promotion none_automatic]";
        },
      },
      fetch: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return requests.length === 1
          ? sse(
              {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_proposals",
                    type: "function",
                    function: { name: "mars_proposals", arguments: "{}" },
                  },
                ],
              },
              "tool_calls",
            )
          : sse({ content: "One proposed candidate; nothing promoted." });
      },
    });
    const outcome = await session.run(f.task.request);
    expect(outcome.status).toBe("completed");
    expect(summaries).toBe(1);
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[0])).toContain("mars_proposals");
    expect(JSON.stringify(requests[1])).toContain(
      "untrusted optimization candidate c1",
    );
  } finally {
    await f.cleanup();
  }
});

test("delegation tools reject oversized output with a delegation-labelled error", async () => {
  const f = await fixture(1_000_000);
  const requests: Record<string, unknown>[] = [];
  const unused = async () => "unused";
  try {
    const session = await f.open({
      task: { ...f.task, budget: { ...f.task.budget, max_tokens: 400_000 } },
      collaboration: {
        send: unused,
        inbox: unused,
        ack: unused,
        members: unused,
        delegation: {
          delegate: unused,
          cancelChild: unused,
          children: async () => "c".repeat(128 * 1024 + 1),
          results: unused,
          reviewResult: unused,
        },
      },
      fetch: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return requests.length === 1
          ? sse(
              {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_children",
                    type: "function",
                    function: { name: "mars_children", arguments: "{}" },
                  },
                ],
              },
              "tool_calls",
            )
          : sse({ content: "Children unavailable." });
      },
    });
    await session.run(f.task.request);
    expect(requests).toHaveLength(2);
    const relayed = JSON.stringify(requests[1]);
    expect(relayed).toContain("Delegation output exceeds tool output limit.");
    expect(relayed).not.toContain("Room output");
    expect(relayed).not.toContain("c".repeat(1024));
  } finally {
    await f.cleanup();
  }
}, 30000);

test("mars_proposals is absent without read approval or a proposals source", async () => {
  const f = await fixture();
  const requests: Record<string, unknown>[] = [];
  try {
    const reply = async (_url: string, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      return sse({ content: "Done." });
    };
    const plain = await f.open({ fetch: reply });
    await plain.run(f.task.request);
    const noRead = await f.open({
      approvals: { read: false, write: true, execute: false },
      proposals: { summary: async () => "unused" },
      fetch: reply,
    });
    await noRead.run(f.task.request);
    expect(requests).toHaveLength(2);
    for (const request of requests)
      expect(JSON.stringify(request)).not.toContain("mars_proposals");
  } finally {
    await f.cleanup();
  }
});

test("actual Oh My Pi owns a two-turn write-tool session through the existing provider adapter", async () => {
  const f = await fixture();
  const requests: Record<string, unknown>[] = [];
  const observations: string[] = [];
  try {
    const session = await f.open({
      onEvent: async (event) => {
        observations.push(event.type);
      },
      fetch: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return requests.length === 1
          ? sse(
              {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_write",
                    type: "function",
                    function: {
                      name: "mars_write",
                      arguments: JSON.stringify({
                        path: "greet.txt",
                        content: "Hello",
                      }),
                    },
                  },
                ],
              },
              "tool_calls",
            )
          : sse({ content: "Created greet.txt. No tests were run." });
      },
    });
    const outcome = await session.run(f.task.request);
    expect(outcome.status).toBe("completed");
    expect(outcome.content).toBe("Created greet.txt. No tests were run.");
    expect(await readFile(join(f.cwd, "greet.txt"), "utf8")).toBe("Hello");
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1])).toContain("call_write");
    expect(JSON.stringify(requests[0])).not.toContain("mars_execute");
    expect(observations).toContain("tool_execution_end");
    expect(outcome.usage.reserved_tokens).toBeGreaterThan(0);
    expect(outcome.usage.input_tokens).toBe(100);
    const journal = await readFile(session.journalPath, "utf8");
    const frozenJournal = session.journalSnapshot();
    expect(frozenJournal.session_id).toBe(session.sessionId);
    const identities = (records: unknown[]) =>
      records.map((record) => {
        const entry = record as { type: string; id?: string };
        return { type: entry.type, id: entry.id };
      });
    expect(identities(frozenJournal.entries)).toEqual(
      identities(
        journal
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
          .filter((entry) => entry.type !== "title"),
      ),
    );
    frozenJournal.entries.length = 0;
    expect(session.journalSnapshot().entries.length).toBeGreaterThan(0);
    expect(journal).toContain("mars.binding");
    expect(journal).toContain("mars.budget");
    expect(journal).toContain("call_write");
    expect(journal).not.toContain("dummy-key-not-real");
  } finally {
    await f.cleanup();
  }
}, 30000);

test("a run never outlives the task's fixed deadline, even when resumed", async () => {
  const f = await fixture();
  try {
    const fixed = Date.now() + 30_000;
    const first = await f.open({
      deadline: fixed,
      fetch: async () => sse({ content: "First turn" }),
    });
    const result = await first.run("First instruction");
    expect(result.usage.deadline).toBe(fixed);
    const file = first.journalPath;
    await first.dispose();
    const second = await f.open({
      sessionFile: file,
      deadline: fixed - 10_000,
      fetch: async () => sse({ content: "Resumed turn" }),
    });
    const resumed = await second.run("Continue");
    expect(resumed.usage.deadline).toBe(fixed - 10_000);
    await second.dispose();
  } finally {
    await f.cleanup();
  }
}, 30000);

test("a stopped SDK session reopens its original journal and retains budget and conversation", async () => {
  const f = await fixture();
  let requests = 0;
  try {
    const first = await f.open({
      fetch: async () => {
        requests++;
        return sse({ content: "First turn" });
      },
    });
    const result = await first.run("First instruction");
    expect(result.status).toBe("completed");
    const file = first.journalPath;
    await first.dispose();
    const second = await f.open({
      sessionFile: file,
      fetch: async (_url, init) => {
        requests++;
        const body = String(init?.body);
        expect(body).toContain("First instruction");
        expect(body).toContain("First turn");
        return sse({ content: "Resumed turn" });
      },
    });
    expect(second.sessionId).toBe(first.sessionId);
    const resumed = await second.run(
      "Continue from the persisted conversation",
    );
    expect(resumed.status).toBe("completed");
    expect(resumed.usage.reserved_tokens).toBeGreaterThan(
      result.usage.reserved_tokens,
    );
    expect(resumed.usage.deadline).toBe(result.usage.deadline);
    expect(requests).toBe(2);
    await second.dispose();
    await expect(
      f.open({
        task: { ...f.task, task_id: "another-task" },
        sessionFile: file,
      }),
    ).rejects.toThrow("binding");
  } finally {
    await f.cleanup();
  }
}, 30000);

test("a resumed journal rebinds only from an allowed earlier model", async () => {
  const f = await fixture();
  const task = { ...f.task, budget: { ...f.task.budget, max_usd: 1 } };
  try {
    const first = await f.open({
      task,
      modelId: "fixture/paid",
      fetch: async () => sse({ content: "First turn" }),
    });
    expect((await first.run("First instruction")).status).toBe("completed");
    const file = first.journalPath;
    await first.dispose();
    await expect(
      f.open({ task, sessionFile: file, modelId: "fixture/free" }),
    ).rejects.toThrow("binding");
    await expect(
      f.open({
        task,
        sessionFile: file,
        modelId: "fixture/free",
        rebindFromModelIds: ["fixture/unknown"],
      }),
    ).rejects.toThrow("binding");
    await expect(
      f.open({
        task: { ...task, task_id: "another-task" },
        sessionFile: file,
        modelId: "fixture/free",
        rebindFromModelIds: ["fixture/paid"],
      }),
    ).rejects.toThrow("binding");
    const second = await f.open({
      task,
      sessionFile: file,
      modelId: "fixture/free",
      rebindFromModelIds: ["fixture/paid"],
      fetch: async (_url, init) => {
        const body = String(init?.body);
        expect(body).toContain("First turn");
        return sse({ content: "Resumed turn" });
      },
    });
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.modelId).toBe("fixture/free");
    expect((await second.run("Continue")).status).toBe("completed");
    await second.dispose();
    const journal = await readFile(file, "utf8");
    expect(journal).toContain("mars.model_rebind");
    // The journal is now bound to the fallback; reopening needs no rebind.
    const third = await f.open({
      task,
      sessionFile: file,
      modelId: "fixture/free",
      rebindFromModelIds: ["fixture/paid"],
    });
    await third.dispose();
    const reopened = await f.open({
      task,
      sessionFile: file,
      modelId: "fixture/free",
    });
    await reopened.dispose();
    expect(
      (await readFile(file, "utf8")).split("mars.model_rebind").length - 1,
    ).toBe(1);
    await expect(
      f.open({ task, sessionFile: file, modelId: "fixture/paid" }),
    ).rejects.toThrow("binding");
  } finally {
    await f.cleanup();
  }
}, 30000);

test("truncated streams cannot complete successfully or execute partial tool calls", async () => {
  const f = await fixture();
  let writes = 0;
  try {
    const session = await f.open({
      tools: {
        ...f.tools,
        write: async () => {
          writes++;
        },
      },
      fetch: async () =>
        new Response(
          `data: ${JSON.stringify({ choices: [{ delta: { content: "Partial" } }] })}\n\n`,
        ),
    });
    const outcome = await session.run("Fail safely");
    expect(outcome.status).toBe("failed");
    expect(writes).toBe(0);
  } finally {
    await f.cleanup();
  }
}, 30000);

test("cancellation aborts the provider request, stops workspace execution and forbids further dispatch", async () => {
  const f = await fixture();
  let stops = 0;
  let entered: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  try {
    const session = await f.open({
      tools: {
        ...f.tools,
        stop: async () => {
          stops++;
        },
      },
      fetch: async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          entered?.();
          const abort = () =>
            reject(new DOMException("Cancelled", "AbortError"));
          if (init?.signal?.aborted) abort();
          else init?.signal?.addEventListener("abort", abort, { once: true });
        }),
    });
    const running = session.run("Wait until cancelled");
    await started;
    await session.cancel();
    expect((await running).status).toBe("cancelled");
    expect(stops).toBeGreaterThan(0);
    await expect(session.run("Do not dispatch")).rejects.toThrow("stopped");
  } finally {
    await f.cleanup();
  }
}, 30000);

test("pre-dispatch reservation and persistence failure fail closed without provider calls", async () => {
  const f = await fixture();
  let calls = 0;
  const selected = selectExecutionModel(f.registry);
  const ledger: BudgetLedger = {
    deadline: Date.now() + 60000,
    reserved_tokens: 0,
    reserved_usd: 0,
    input_tokens: 0,
    output_tokens: 0,
  };
  const model = { api: "fixture", provider: "fixture", id: "stub" } as Model;
  try {
    const exhausted = createModelBridge({
      registry: f.registry,
      selected,
      budget: { ...f.task.budget, max_tokens: 1 },
      ledger,
      signal: new AbortController().signal,
      persistLedger: async () => undefined,
      fetch: async () => {
        calls++;
        return sse({ content: "Should not run" });
      },
      env: f.env,
    });
    expect(
      (
        await exhausted(model, {
          messages: [{ role: "user", content: "Hello", timestamp: 1 }],
        }).result()
      ).stopReason,
    ).toBe("error");
    const failedPersistence = createModelBridge({
      registry: f.registry,
      selected,
      budget: f.task.budget,
      ledger,
      signal: new AbortController().signal,
      persistLedger: async () => {
        throw new Error("Disk full");
      },
      fetch: async () => {
        calls++;
        return sse({ content: "Should not run" });
      },
      env: f.env,
    });
    expect(
      (
        await failedPersistence(model, {
          messages: [{ role: "user", content: "Hello", timestamp: 1 }],
        }).result()
      ).stopReason,
    ).toBe("error");
    const failures: string[] = [];
    const sharedLedger = { ...ledger };
    const refusedByTask = createModelBridge({
      registry: f.registry,
      selected,
      budget: f.task.budget,
      ledger: sharedLedger,
      signal: new AbortController().signal,
      persistLedger: async () => undefined,
      sharedBudget: {
        reserve: async () => {
          throw Object.assign(new Error("full"), { code: "budget_exceeded" });
        },
        record: async () => undefined,
      },
      onFailure: (code) => failures.push(code),
      fetch: async () => {
        calls++;
        return sse({ content: "Should not run" });
      },
      env: f.env,
    });
    expect(
      (
        await refusedByTask(model, {
          messages: [{ role: "user", content: "Hello", timestamp: 1 }],
        }).result()
      ).stopReason,
    ).toBe("error");
    expect(failures).toEqual(["budget_exhausted"]);
    expect(sharedLedger.reserved_tokens).toBe(ledger.reserved_tokens);
    expect(calls).toBe(0);
  } finally {
    await f.cleanup();
  }
});

test("runtime dispatch inherits registry credentials when env is omitted, for both stream and complete", async () => {
  const f = await fixture();
  let session: RuntimeSession | undefined;
  let calls = 0;
  const fetchFixture = async (_url: string, init?: RequestInit) => {
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer dummy-key-not-real",
    );
    calls++;
    const body = JSON.parse(String(init?.body)) as { stream?: boolean };
    return body.stream
      ? sse({ content: "Configured credentials reached the adapter" })
      : Response.json({
          choices: [{ message: { role: "assistant", content: "Complete" } }],
        });
  };
  try {
    session = await openRuntimeSession({
      task: f.task,
      cwd: f.cwd,
      stateDir: f.stateDir,
      registry: f.registry,
      tools: f.tools,
      approvals: { read: false, write: false, execute: false },
      fetch: fetchFixture,
    });
    expect(
      (await session.run("Use configured provider credentials")).status,
    ).toBe("completed");
    const router = new ModelRouter(f.registry, {
      adapterOptions: { fetch: fetchFixture },
    });
    expect(
      (
        await router.complete(
          { messages: [{ role: "user", content: "Hello" }] },
          { model: "fixture/free" },
        )
      ).content,
    ).toBe("Complete");
    expect(calls).toBe(2);
    expect(Object.keys(f.registry.getProviderEnvironment("fixture"))).toEqual([
      "MARS_FIXTURE_KEY",
    ]);
    expect(f.registry.getProviderEnvironment("unknown")).toEqual({});
  } finally {
    await session?.dispose();
    await f.cleanup();
  }
}, 30000);

test("cancellation flushes its journal even when workspace stop rejects", async () => {
  const f = await fixture();
  let entered: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let flush: ReturnType<typeof spyOn> | undefined;
  try {
    const session = await f.open({
      tools: {
        ...f.tools,
        stop: async () => {
          throw new Error("Untrusted stop detail");
        },
      },
      fetch: async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          entered?.();
          const abort = () =>
            reject(new DOMException("Cancelled", "AbortError"));
          if (init?.signal?.aborted) abort();
          else init?.signal?.addEventListener("abort", abort, { once: true });
        }),
    });
    const running = session.run("Cancel despite workspace failure");
    await started;
    flush = spyOn(AgentSession.prototype, "flushToDisk");
    await expect(session.cancel()).rejects.toThrow(
      "Runtime cancellation encountered a cleanup failure.",
    );
    expect(flush).toHaveBeenCalled();
    expect((await running).status).toBe("cancelled");
    expect(await readFile(session.journalPath, "utf8")).toContain(
      '"stopReason":"aborted"',
    );
    await expect(session.dispose()).rejects.toThrow(
      "Runtime disposal encountered a cleanup failure.",
    );
  } finally {
    flush?.mockRestore();
    await f.cleanup();
  }
}, 30000);

test("disposal closes the SDK journal even when workspace stop rejects", async () => {
  const f = await fixture();
  let dispose: ReturnType<typeof spyOn> | undefined;
  let close: ReturnType<typeof spyOn> | undefined;
  try {
    dispose = spyOn(AgentSession.prototype, "dispose");
    const session = await f.open({
      tools: {
        ...f.tools,
        stop: async () => {
          throw new Error("Stop failed");
        },
      },
      fetch: async () => sse({ content: "Durable final response" }),
    });
    await session.run("Complete before disposal");
    close = spyOn(SessionManager.prototype, "close");
    await expect(session.dispose()).rejects.toThrow(
      "Runtime disposal encountered a cleanup failure.",
    );
    expect(dispose).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
    expect(await readFile(session.journalPath, "utf8")).toContain(
      "Durable final response",
    );
    await session.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  } finally {
    dispose?.mockRestore();
    close?.mockRestore();
    await f.cleanup();
  }
}, 30000);

for (const damage of ["missing", "invalid"] as const) {
  test(`resuming a journal with ${damage} budget fails closed and closes the reopened manager`, async () => {
    const f = await fixture();
    let close: ReturnType<typeof spyOn> | undefined;
    let calls = 0;
    try {
      const first = await f.open({
        fetch: async () => sse({ content: "Original budget" }),
      });
      await first.run("Persist original budget");
      await first.dispose();
      const entries = (await readFile(first.journalPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const damaged =
        damage === "missing"
          ? entries.filter((entry) => entry.customType !== "mars.budget")
          : entries.map((entry) =>
              entry.customType === "mars.budget"
                ? { ...entry, data: { deadline: "invalid" } }
                : entry,
            );
      await writeFile(
        first.journalPath,
        `${damaged.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      );
      close = spyOn(SessionManager.prototype, "close");
      await expect(
        f.open({
          sessionFile: first.journalPath,
          fetch: async () => {
            calls++;
            return sse({ content: "Never dispatch" });
          },
        }),
      ).rejects.toThrow();
      expect(close).toHaveBeenCalledTimes(1);
      expect(calls).toBe(0);
    } finally {
      close?.mockRestore();
      await f.cleanup();
    }
  }, 30000);
}

test("systemPromptOverride replaces the fixed prompt only when supplied", async () => {
  const f = await fixture();
  const requests: Record<string, unknown>[] = [];
  const systemMessage = (request: Record<string, unknown> | undefined) => {
    const messages = request?.messages as
      | { role: string; content: unknown }[]
      | undefined;
    return messages?.find((message) => message.role === "system")?.content;
  };
  try {
    const fetch = async (_url: string, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      return sse({ content: "Done. No tests were run." });
    };
    const defaultSession = await f.open({ fetch });
    await defaultSession.run(f.task.request);
    expect(String(systemMessage(requests[0]))).toContain(
      "You are MARS, a coding assistant.",
    );

    const overridden = await f.open({
      fetch,
      systemPromptOverride:
        "  You are candidate prompt 7. Verify before claiming. ",
    });
    await overridden.run(f.task.request);
    expect(String(systemMessage(requests[1]))).toContain(
      "You are candidate prompt 7.",
    );
    expect(String(systemMessage(requests[1]))).not.toContain(
      "You are MARS, a coding assistant.",
    );

    await expect(
      f.open({ fetch, systemPromptOverride: "   " }),
    ).rejects.toThrow("System prompt override is empty.");
    await expect(
      f.open({
        fetch,
        systemPromptOverride: "x".repeat(MAX_SYSTEM_PROMPT_CHARS + 1),
      }),
    ).rejects.toThrow("exceeds the size limit");
  } finally {
    await f.cleanup();
  }
}, 30000);

test("the runtime forwards its seed on every model request and gates the edit tool by editFormat", async () => {
  const f = await fixture(32000, { editFormat: "apply_patch" });
  const bodies: Record<string, unknown>[] = [];
  const fetch = async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return sse({ content: "Done." });
  };
  const patch = { apply: async () => "applied" };
  try {
    const seeded = await f.open({ fetch, seed: 4242, patch });
    expect(seeded.toolNames).toContain("mars_apply_patch");
    await seeded.run(f.task.request);
    expect(bodies[0]?.seed).toBe(4242);
    const unseeded = await f.open({
      fetch,
      patch,
      editFormat: "apply_patch",
    });
    expect(unseeded.toolNames).toContain("mars_apply_patch");
    await unseeded.run(f.task.request);
    expect(Object.hasOwn(bodies[1] ?? {}, "seed")).toBe(false);
    for (const seed of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1])
      await expect(f.open({ fetch, seed })).rejects.toThrow(
        "Runtime seed must be a non-negative safe integer.",
      );
    await expect(
      f.open({ fetch, editFormat: "unknown" as "apply_patch" }),
    ).rejects.toThrow("Unknown MARS edit format.");
  } finally {
    await f.cleanup();
  }
}, 30000);

test.each(["hashline", "replace", "apply_patch"] as const)(
  "explicit runtime %s selection overrides the model setting without losing fallback evidence",
  async (editFormat) => {
    const f = await fixture(32000, { editFormat: "replace" });
    try {
      const session = await f.open({
        editFormat,
        patch: { apply: async () => "applied" },
      });
      expect(session.editFormat).toEqual({
        format: editFormat,
        requested: editFormat,
        source: "config",
      });
      expect(session.toolNames).toContain(
        editFormat === "hashline"
          ? "mars_edit"
          : editFormat === "replace"
            ? "mars_replace"
            : "mars_apply_patch",
      );
      const fallback = await f.open({ editFormat });
      expect(fallback.editFormat).toEqual({
        format: editFormat === "apply_patch" ? "hashline" : editFormat,
        requested: editFormat,
        source: "config",
      });
    } finally {
      await f.cleanup();
    }
  },
);

test("mars_apply_patch is a host-bound tool: Oh My Pi passes the patch text to the host applier and relays its summary", async () => {
  const f = await fixture(32000, { editFormat: "apply_patch" });
  const requests: Record<string, unknown>[] = [];
  const patches: string[] = [];
  const patchText =
    "*** Begin Patch\n*** Add File: greet.txt\n+Hello\n*** End Patch";
  try {
    const session = await f.open({
      patch: {
        async apply(patch) {
          patches.push(patch);
          await writeFile(join(f.cwd, "greet.txt"), "Hello\n");
          return "Success. Updated the following files:\nA greet.txt";
        },
      },
      fetch: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return requests.length === 1
          ? sse(
              {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_patch",
                    type: "function",
                    function: {
                      name: "mars_apply_patch",
                      arguments: JSON.stringify({ patch: patchText }),
                    },
                  },
                ],
              },
              "tool_calls",
            )
          : sse({ content: "Applied the patch." });
      },
    });
    const outcome = await session.run(f.task.request);
    expect(outcome.status).toBe("completed");
    expect(patches).toEqual([patchText]);
    expect(await readFile(join(f.cwd, "greet.txt"), "utf8")).toBe("Hello\n");
    expect(JSON.stringify(requests[0])).toContain("mars_apply_patch");
    expect(JSON.stringify(requests[1])).toContain(
      "Success. Updated the following files:",
    );
  } finally {
    await f.cleanup();
  }
}, 30000);

test("boundPatchSummary keeps the whole result within the byte limit at a character boundary", () => {
  const bytesOf = (text: string) => new TextEncoder().encode(text).byteLength;
  expect(boundPatchSummary("short", 64)).toBe("short");
  const ascii = "A path/to/file.txt\n".repeat(10_000);
  const boundedAscii = boundPatchSummary(ascii, 1_000);
  expect(bytesOf(boundedAscii)).toBeLessThanOrEqual(1_000);
  expect(boundedAscii).toMatch(
    /\n\[summary truncated: \d+ more bytes omitted\]$/,
  );
  expect(
    ascii.startsWith(boundedAscii.split("\n[summary truncated")[0] ?? ""),
  ).toBe(true);
  const multibyte = "A ééé/日本語/🙂.txt\n".repeat(2_000);
  for (const limit of [1_000, 1_001, 1_002, 1_003, 4_096]) {
    const bounded = boundPatchSummary(multibyte, limit);
    expect(bytesOf(bounded)).toBeLessThanOrEqual(limit);
    expect(bounded).not.toContain("\uFFFD");
    expect(
      multibyte.startsWith(bounded.split("\n[summary truncated")[0] ?? ""),
    ).toBe(true);
  }
  expect(bytesOf(boundPatchSummary(multibyte))).toBeLessThanOrEqual(128 * 1024);
  for (const limit of [0, 1, 2, 3, 4, 10, 40]) {
    const bounded = boundPatchSummary(multibyte, limit);
    expect(bytesOf(bounded)).toBeLessThanOrEqual(limit);
    expect(bounded).not.toContain("\uFFFD");
    expect(multibyte.startsWith(bounded)).toBe(true);
  }
});

test("mars_apply_patch keeps a persisted patch successful when its summary exceeds the output limit", async () => {
  const f = await fixture(1_000_000, { editFormat: "apply_patch" });
  const requests: Record<string, unknown>[] = [];
  const summary = `Success. Updated the following files:\n${"A a/very/long/path/to/a/generated/file.txt\n".repeat(4_000)}`;
  expect(summary.length).toBeGreaterThan(128 * 1024);
  try {
    const session = await f.open({
      task: { ...f.task, budget: { ...f.task.budget, max_tokens: 400_000 } },
      patch: { apply: async () => summary },
      fetch: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return requests.length === 1
          ? sse(
              {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_patch",
                    type: "function",
                    function: {
                      name: "mars_apply_patch",
                      arguments: JSON.stringify({
                        patch:
                          "*** Begin Patch\n*** Add File: a.txt\n+a\n*** End Patch",
                      }),
                    },
                  },
                ],
              },
              "tool_calls",
            )
          : sse({ content: "Applied." });
      },
    });
    const outcome = await session.run(f.task.request);
    expect(outcome.status).toBe("completed");
    const relayed = JSON.stringify(requests[1]);
    expect(relayed).toContain("Success. Updated the following files:");
    expect(relayed).toContain("[summary truncated:");
    expect(relayed).not.toContain("exceeds tool output limit");
    const relayedTool = (
      requests[1]?.messages as Array<{ role: string; content: string }>
    ).find((m) => m.role === "tool");
    expect(relayedTool?.content ?? "").not.toMatch(/\[…\d+ln elided/);
    expect(relayedTool?.content ?? "").not.toContain("artifact://");
    expect(
      new TextEncoder().encode(relayedTool?.content ?? "").byteLength,
    ).toBeLessThanOrEqual(128 * 1024);
  } finally {
    await f.cleanup();
  }
}, 30000);

test("mars_apply_patch relays >50 KiB summaries intact without omp middle-elision or artifact spill", async () => {
  const f = await fixture(1_000_000, { editFormat: "apply_patch" });
  const requests: Record<string, unknown>[] = [];
  const summary = `Success. Updated the following files:\n${"A a/very/long/path/to/a/generated/file-😀中.txt\n".repeat(1_500)}`;
  const summaryBytes = Buffer.byteLength(summary, "utf8");
  expect(summaryBytes).toBeGreaterThan(50 * 1024);
  expect(summaryBytes).toBeLessThan(128 * 1024);
  try {
    const session = await f.open({
      task: { ...f.task, budget: { ...f.task.budget, max_tokens: 400_000 } },
      patch: { apply: async () => summary },
      fetch: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return requests.length === 1
          ? sse(
              {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_patch_big",
                    type: "function",
                    function: {
                      name: "mars_apply_patch",
                      arguments: JSON.stringify({
                        patch:
                          "*** Begin Patch\n*** Add File: a.txt\n+a\n*** End Patch",
                      }),
                    },
                  },
                ],
              },
              "tool_calls",
            )
          : sse({ content: "Applied." });
      },
    });
    const outcome = await session.run(f.task.request);
    expect(outcome.status).toBe("completed");
    const relayedTool = (
      requests[1]?.messages as Array<{ role: string; content: string }>
    ).find((m) => m.role === "tool");
    expect(relayedTool?.content).toBe(summary);
    expect(relayedTool?.content ?? "").not.toMatch(/\[…\d+ln elided/);
    expect(relayedTool?.content ?? "").not.toContain("artifact://");
  } finally {
    await f.cleanup();
  }
}, 30000);

test("mars_read unranged in apply_patch mode relays >50 KiB files intact when below thresholdBytes", async () => {
  const f = await fixture(1_000_000, { editFormat: "apply_patch" });
  const task = {
    ...f.task,
    budget: { ...f.task.budget, max_tokens: 400_000 },
  };
  const body = `${Array.from({ length: 1_200 }, (_, i) => `line ${i + 1}: 😀中 payload for apply_patch read`).join("\n")}\n`;
  expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(50 * 1024);
  expect(Buffer.byteLength(body, "utf8")).toBeLessThan(128 * 1024);
  try {
    await writeFile(join(f.cwd, "big.txt"), body);
    const read = await callFileTool(
      f,
      "mars_read",
      { path: "big.txt" },
      {
        task,
        readSummary: { thresholdBytes: 128 * 1024 },
        patch: { apply: async () => "Success. Updated the following files:\n" },
      },
    );
    expect(read.relayed).toBe(body);
    expect(read.relayed).not.toMatch(/\[…\d+ln elided/);
    expect(read.relayed).not.toContain("artifact://");
  } finally {
    await f.cleanup();
  }
}, 30000);

test("mars_apply_patch is not declared without read approval, without write approval or without a host applier", async () => {
  const f = await fixture(32000, { editFormat: "apply_patch" });
  const requests: Record<string, unknown>[] = [];
  try {
    const respond = async (_url: string, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      return sse({ content: "Nothing to do." });
    };
    const readOnly = await f.open({
      approvals: { read: true, write: false, execute: false },
      patch: { apply: async () => "unreachable" },
      fetch: respond,
    });
    await readOnly.run(f.task.request);
    const writeOnly = await f.open({
      approvals: { read: false, write: true, execute: false },
      patch: { apply: async () => "unreachable" },
      fetch: respond,
    });
    await writeOnly.run(f.task.request);
    const noApplier = await f.open({ fetch: respond });
    await noApplier.run(f.task.request);
    expect(requests).toHaveLength(3);
    for (const request of requests)
      expect(JSON.stringify(request)).not.toContain("mars_apply_patch");
  } finally {
    await f.cleanup();
  }
}, 30000);

test("openRuntimeSession declares every capability's tools in a fixed order and gates them on approvals", async () => {
  const f = await fixture(32000, { editFormat: "apply_patch" });
  const declared: string[][] = [];
  const unused = async () => "unused";
  const respond = async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      tools?: { function: { name: string } }[];
    };
    declared.push((body.tools ?? []).map((tool) => tool.function.name));
    return sse({ content: "Done." });
  };
  const capabilities = {
    tools: {
      ...f.tools,
      grep: async () => ({
        matches: [],
        truncated: false,
        limitReached: false,
      }),
    },
    recall: unused,
    collaboration: {
      send: unused,
      inbox: unused,
      ack: unused,
      members: unused,
      delegation: {
        delegate: unused,
        cancelChild: unused,
        children: unused,
        results: unused,
        reviewResult: unused,
      },
    },
    research: { submit: unused, findings: unused },
    browser: { submit: unused, result: unused },
    proposals: { summary: unused },
    watch: {
      watch: unused,
      ask: unused,
      search: unused,
      capture: unused,
      extract: unused,
      loop: unused,
      verify: unused,
      evidence: unused,
    },
    knowledgeGraph: { build: unused, query: unused },
    patch: { apply: unused },
    teamContext: { context: unused },
    fetch: respond,
  };
  try {
    const full = await f.open({
      ...capabilities,
      approvals: { read: true, write: true, execute: true },
    });
    await full.run(f.task.request);
    const order = [
      "mars_read",
      "mars_grep",
      "mars_history",
      "mars_send",
      "mars_inbox",
      "mars_ack",
      "mars_members",
      "mars_delegate",
      "mars_cancel_child",
      "mars_children",
      "mars_results",
      "mars_review_result",
      "mars_research",
      "mars_findings",
      "mars_browse",
      "mars_browse_result",
      "mars_proposals",
      "mars_watch",
      "mars_watch_ask",
      "mars_watch_search",
      "mars_watch_capture",
      "mars_watch_extract",
      "mars_loop",
      "mars_verify",
      "mars_watch_evidence",
      "mars_graph_build",
      "mars_graph_query",
      "mars_write",
      "mars_apply_patch",
      "mars_team_context",
      "mars_execute",
    ];
    expect(declared[0]).toEqual(order);
    expect(full.toolNames).toEqual([...order].sort());
    const unapproved = await f.open({
      ...capabilities,
      approvals: { read: false, write: false, execute: false },
    });
    await unapproved.run(f.task.request);
    expect(declared[1]).toEqual(
      order.filter(
        (name) =>
          ![
            "mars_read",
            "mars_grep",
            "mars_history",
            "mars_proposals",
            "mars_write",
            "mars_apply_patch",
            "mars_execute",
          ].includes(name),
      ),
    );
    for (const format of ["hashline", "replace"] as const) {
      const other = await fixture(32000, { editFormat: format });
      try {
        const selected = await other.open({
          ...capabilities,
          approvals: { read: true, write: true, execute: true },
        });
        await selected.run(other.task.request);
        const expected = order.map((name) =>
          name === "mars_apply_patch"
            ? format === "hashline"
              ? "mars_edit"
              : "mars_replace"
            : name,
        );
        expect(declared.at(-1)).toEqual(expected);
        expect(selected.toolNames).toEqual([...expected].sort());
      } finally {
        await other.cleanup();
      }
    }
  } finally {
    await f.cleanup();
  }
}, 30000);

type RuntimeFixture = Awaited<ReturnType<typeof fixture>>;

async function callFileTool(
  f: RuntimeFixture,
  name: string,
  args: Record<string, unknown>,
  extra: Partial<Parameters<typeof openRuntimeSession>[0]> = {},
) {
  const requests: Array<{
    messages: Array<{ role: string; content: string }>;
  }> = [];
  const session = await f.open({
    ...extra,
    fetch: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return requests.length === 1
        ? sse(
            {
              tool_calls: [
                {
                  index: 0,
                  id: "file_call",
                  type: "function",
                  function: { name, arguments: JSON.stringify(args) },
                },
              ],
            },
            "tool_calls",
          )
        : sse({ content: "Done." });
    },
  });
  const outcome = await session.run(
    "Use the file tool, then report its result.",
  );
  expect(outcome.status).toBe("completed");
  expect(requests).toHaveLength(2);
  const relayed =
    requests[1]?.messages.find((message) => message.role === "tool")?.content ??
    "";
  return { session, requests, relayed };
}

test("edit defaults and overrides select only one tool and journal evidence once per open", async () => {
  for (const [model, override, expected, requested, source] of [
    ["stub", undefined, "hashline", "hashline", "default"],
    ["DeepSeek-v4", undefined, "replace", "replace", "default"],
    ["kimi-k2.5", undefined, "replace", "replace", "default"],
    ["Qwen3.8-Flash-Next", undefined, "replace", "replace", "default"],
    ["DeepSeek-v4", "hashline", "hashline", "hashline", "config"],
    ["stub", "replace", "replace", "replace", "config"],
    ["stub", "apply_patch", "hashline", "apply_patch", "config"],
  ] as const) {
    const f = await fixture(32000, {
      model,
      ...(override ? { editFormat: override } : {}),
    });
    try {
      const session = await f.open({
        fetch: async () => sse({ content: "Done." }),
      });
      expect(session.editFormat).toEqual({
        format: expected,
        requested,
        source,
      });
      expect(
        session.toolNames.filter((name) =>
          ["mars_edit", "mars_replace", "mars_apply_patch"].includes(name),
        ),
      ).toEqual([expected === "replace" ? "mars_replace" : "mars_edit"]);
      await session.run("Done");
      const evidence = session
        .journalSnapshot()
        .entries.filter(
          (entry) =>
            (entry as { customType?: string }).customType ===
            "mars.edit_format",
        );
      expect(evidence).toHaveLength(1);
      expect(evidence[0]).toMatchObject({ data: session.editFormat });
      const path = session.journalPath;
      await session.dispose();
      const resumed = await f.open({
        sessionFile: path,
        fetch: async () => sse({ content: "Done." }),
      });
      expect(
        resumed
          .journalSnapshot()
          .entries.filter(
            (entry) =>
              (entry as { customType?: string }).customType ===
              "mars.edit_format",
          ),
      ).toHaveLength(2);
    } finally {
      await f.cleanup();
    }
  }
}, 30000);

test("mars_read returns anchors, bounded ranges, empty guidance and row-boundary truncation", async () => {
  const f = await fixture(1_000_000);
  const task = { ...f.task, budget: { ...f.task.budget, max_tokens: 500_000 } };
  try {
    await writeFile(join(f.cwd, "a.txt"), "a\r\nb\r\n😀中");
    const range = await callFileTool(f, "mars_read", {
      path: "a.txt",
      offset: 2,
      limit: 1,
    });
    expect(range.relayed).toBe(
      `a.txt · lines 2-2 of 3\n${anchorOf(2, "b")}|b\n[continue with offset=3]`,
    );
    await writeFile(join(f.cwd, "empty"), "");
    expect(
      (await callFileTool(f, "mars_read", { path: "empty" })).relayed,
    ).toContain("anchor BOF");
    await writeFile(
      join(f.cwd, "large"),
      Array.from({ length: 4000 }, () => "😀".repeat(20)).join("\n"),
    );
    const large = await callFileTool(
      f,
      "mars_read",
      { path: "large", offset: 1 },
      { task },
    );
    expect(large.relayed).toMatch(
      /\n\[truncated at line (\d+) of 4000; continue with offset=(\d+)\]$/,
    );
    expect(Buffer.byteLength(large.relayed)).toBeLessThanOrEqual(128 * 1024);
    const last = large.relayed.split("\n").at(-2) ?? "";
    expect(last).toMatch(/^\d+:[a-z2-9]{3}\|(?:😀)+$/u);
    expect(
      (await callFileTool(f, "mars_read", { path: "a.txt", offset: 0 }))
        .relayed,
    ).toContain("greater than 0");
    expect(
      (await callFileTool(f, "mars_read", { path: "a.txt", limit: 2001 }))
        .relayed,
    ).toContain("2000");
  } finally {
    await f.cleanup();
  }
}, 30000);

test.each(["replace", "apply_patch"] as const)(
  "%s reads preserve raw behavior and support plain ranged reads",
  async (editFormat) => {
    const f = await fixture(1_000_000, { editFormat });
    const extra = { patch: { apply: async () => "unused" } };
    try {
      await writeFile(join(f.cwd, "a.txt"), "a\r\nb\r\n");
      // omp's existing coerceToolResult/sanitizeText normalizes CRLF on the wire.
      expect(
        (await callFileTool(f, "mars_read", { path: "a.txt" }, extra)).relayed,
      ).toBe("a\nb\n");
      expect(
        (
          await callFileTool(
            f,
            "mars_read",
            { path: "a.txt", offset: 2, limit: 1 },
            extra,
          )
        ).relayed,
      ).toBe("a.txt · lines 2-2 of 2\nb");
      await writeFile(join(f.cwd, "large"), "x\n".repeat(100_000));
      expect(
        (await callFileTool(f, "mars_read", { path: "large" }, extra)).relayed,
      ).toContain("Heuristic outline");
      expect(
        (
          await callFileTool(
            f,
            "mars_read",
            { path: "large", offset: 99_999, limit: 2 },
            extra,
          )
        ).relayed,
      ).toBe("large · lines 99999-100000 of 100000\nx\nx");
    } finally {
      await f.cleanup();
    }
  },
  30000,
);

test.each(["hashline", "replace", "apply_patch"] as const)(
  "%s oversized first row is UTF-8-safe and advances; full-line anchors still edit",
  async (editFormat) => {
    const f = await fixture(2_000_000, { editFormat });
    const task = {
      ...f.task,
      budget: { ...f.task.budget, max_tokens: 1_000_000 },
    };
    try {
      const longLine = "😀中".repeat(45000);
      await writeFile(join(f.cwd, "long.txt"), `${longLine}\nsecond\nthird`);
      const first = await callFileTool(
        f,
        "mars_read",
        { path: "long.txt", offset: 1, limit: 1 },
        {
          task,
          ...(editFormat === "apply_patch"
            ? {
                patch: {
                  apply: async () => "Success. Updated the following files:\n",
                },
              }
            : {}),
        },
      );
      expect(Buffer.byteLength(first.relayed, "utf8")).toBeLessThanOrEqual(
        128 * 1024,
      );
      expect(first.relayed).toContain("line 1 truncated");
      expect(first.relayed).toContain(
        editFormat === "hashline"
          ? "mars_edit range replacement"
          : editFormat === "apply_patch"
            ? "mars_apply_patch"
            : "mars_replace",
      );
      expect(first.relayed).toContain("continue with offset=2");
      expect(first.relayed).not.toContain("\uFFFD");
      const row = first.relayed.split("\n")[1] ?? "";
      const prefix =
        editFormat === "hashline" ? `${anchorOf(1, longLine)}|` : "";
      expect(row.startsWith(prefix)).toBe(true);
      expect(row.slice(prefix.length)).toMatch(/^(?:😀中)+(?:😀)?$/u);
      const next = await callFileTool(
        f,
        "mars_read",
        { path: "long.txt", offset: 2, limit: 1 },
        { task },
      );
      expect(next.relayed).toContain("lines 2-2 of 3");
      expect(next.relayed).toContain("second");
      expect(next.relayed).toContain("continue with offset=3");
      const last = await callFileTool(
        f,
        "mars_read",
        { path: "long.txt", offset: 3, limit: 1 },
        { task },
      );
      expect(last.relayed).toContain("third");
      expect(last.relayed).not.toContain("continue with offset=");
      if (editFormat === "hashline") {
        const anchor = row.slice(0, row.indexOf("|"));
        const edited = await callFileTool(
          f,
          "mars_edit",
          {
            path: "long.txt",
            edits: [{ op: "replace", anchor, content: "short" }],
          },
          { task },
        );
        expect(edited.relayed).toContain("Applied 1 edits");
        expect(await readFile(join(f.cwd, "long.txt"), "utf8")).toBe(
          "short\nsecond\nthird",
        );
      }
    } finally {
      await f.cleanup();
    }
  },
);

test.each([
  "a\nb\n",
  "a\r\nb\r\n",
  "a\nb",
  "\uFEFFa\r\nb",
  "😀e\u0301\n中文",
  "",
])(
  "mars_edit round trips %j through host read/write exactly once",
  async (text) => {
    const f = await fixture();
    let writes = 0;
    const reads: string[] = [];
    try {
      await writeFile(join(f.cwd, "a.txt"), text);
      const first = text.replace(/^\uFEFF/, "").split(/\r?\n/)[0] ?? "";
      const edits = text
        ? [{ op: "replace", anchor: anchorOf(1, first), content: "新😀" }]
        : [{ op: "insert_after", anchor: "BOF", content: "新😀" }];
      const { relayed } = await callFileTool(
        f,
        "mars_edit",
        { path: "a.txt", edits },
        {
          tools: {
            ...f.tools,
            read: async (path) => {
              reads.push(path);
              return f.tools.read(path);
            },
            write: async (path, bytes) => {
              writes++;
              expect(path).toBe("a.txt");
              return f.tools.write(path, bytes);
            },
          },
        },
      );
      expect(writes).toBe(1);
      expect(reads).toEqual(["a.txt", "a.txt"]);
      expect(await readFile(join(f.cwd, "a.txt"), "utf8")).toBe(
        text ? text.replace(first, "新😀") : "新😀",
      );
      expect(relayed).toContain(`${anchorOf(1, "新😀")}|新😀`);
    } finally {
      await f.cleanup();
    }
  },
  30000,
);

test("mars_edit stale and third-op failures relay recovery in the next request and never write", async () => {
  const f = await fixture();
  let writes = 0;
  const tools = {
    ...f.tools,
    write: async () => {
      writes++;
    },
  };
  try {
    await writeFile(join(f.cwd, "a.txt"), "fresh\nb\nc");
    const stale = await callFileTool(
      f,
      "mars_edit",
      { path: "a.txt", edits: [{ op: "delete", anchor: anchorOf(1, "old") }] },
      { tools },
    );
    expect(stale.relayed).toContain("is stale");
    expect(stale.relayed).toContain(`${anchorOf(1, "fresh")}|fresh`);
    expect(JSON.stringify(stale.session.journalSnapshot())).toContain(
      '"isError":true',
    );
    const atomic = await callFileTool(
      f,
      "mars_edit",
      {
        path: "a.txt",
        edits: [
          { op: "replace", anchor: anchorOf(1, "fresh"), content: "changed" },
          { op: "delete", anchor: anchorOf(2, "b") },
          { op: "delete", anchor: anchorOf(2, "b") },
        ],
      },
      { tools },
    );
    expect(atomic.relayed).toContain("Edit 3 rejected, nothing written");
    expect(atomic.relayed).toContain(`${anchorOf(1, "fresh")}|fresh`);
    expect(writes).toBe(0);
    expect(await readFile(join(f.cwd, "a.txt"), "utf8")).toBe("fresh\nb\nc");
  } finally {
    await f.cleanup();
  }
}, 30000);

test("mars_edit rejects a TOCTOU change with fresh anchors before writing", async () => {
  const f = await fixture();
  let reads = 0;
  let writes = 0;
  try {
    const result = await callFileTool(
      f,
      "mars_edit",
      {
        path: "a",
        edits: [{ op: "replace", anchor: anchorOf(1, "old"), content: "new" }],
      },
      {
        tools: {
          ...f.tools,
          read: async () =>
            new TextEncoder().encode(++reads === 1 ? "old" : "concurrent"),
          write: async () => {
            writes++;
          },
        },
      },
    );
    expect(reads).toBe(2);
    expect(writes).toBe(0);
    expect(result.relayed).toContain("is stale");
    expect(result.relayed).toContain(`${anchorOf(1, "concurrent")}|concurrent`);
  } finally {
    await f.cleanup();
  }
});

for (const format of ["hashline", "replace"] as const) {
  test(`${format} revalidates a changed second read and writes fresh content once`, async () => {
    const f = await fixture(32000, { editFormat: format });
    let reads = 0;
    const writes: string[] = [];
    const tool = format === "hashline" ? "mars_edit" : "mars_replace";
    try {
      const result = await callFileTool(
        f,
        tool,
        {
          path: "a",
          ...(format === "hashline"
            ? {
                edits: [
                  { op: "replace", anchor: anchorOf(1, "old"), content: "new" },
                ],
              }
            : { old: "old", new: "new" }),
        },
        {
          tools: {
            ...f.tools,
            read: async (_path, name) => {
              expect(name).toBe(tool);
              return new TextEncoder().encode(
                ++reads === 1 ? "old\nfirst" : "old\nfresh",
              );
            },
            write: async (_path, bytes, name) => {
              expect(name).toBe(tool);
              writes.push(new TextDecoder().decode(bytes));
            },
          },
        },
      );
      expect(reads).toBe(3);
      expect(writes).toEqual(["new\nfresh"]);
      expect(result.relayed).not.toContain("rejected");
    } finally {
      await f.cleanup();
    }
  });

  test(`${format} caps conflict retries at three reads with bounded format-specific recovery`, async () => {
    const f = await fixture(32000, { editFormat: format });
    let reads = 0;
    let writes = 0;
    try {
      const result = await callFileTool(
        f,
        format === "hashline" ? "mars_edit" : "mars_replace",
        {
          path: "a",
          ...(format === "hashline"
            ? {
                edits: [
                  { op: "replace", anchor: anchorOf(1, "old"), content: "new" },
                ],
              }
            : { old: "old", new: "new" }),
        },
        {
          tools: {
            ...f.tools,
            read: async () =>
              new TextEncoder().encode(
                `old\nrevision ${++reads}\n${"context\n".repeat(10000)}`,
              ),
            write: async () => {
              writes++;
            },
          },
        },
      );
      expect(reads).toBe(3);
      expect(writes).toBe(0);
      expect(result.relayed).toContain("file kept changing");
      expect(result.relayed).toContain(
        format === "hashline" ? `${anchorOf(1, "old")}|old` : "1|old",
      );
      expect(Buffer.byteLength(result.relayed)).toBeLessThan(9 * 1024);
      expect(result.relayed.split("\n").length).toBeLessThan(66);
      expect(JSON.stringify(result.session.journalSnapshot())).toContain(
        '"isError":true',
      );
    } finally {
      await f.cleanup();
    }
  });
}

test("mars_replace returns the fresh replacement failure with plain recovery", async () => {
  const f = await fixture(32000, { editFormat: "replace" });
  let reads = 0;
  let writes = 0;
  try {
    const result = await callFileTool(
      f,
      "mars_replace",
      { path: "a", old: "old", new: "new" },
      {
        tools: {
          ...f.tools,
          read: async () =>
            new TextEncoder().encode(++reads === 1 ? "old" : "old\nold"),
          write: async () => {
            writes++;
          },
        },
      },
    );
    expect(reads).toBe(2);
    expect(writes).toBe(0);
    expect(result.relayed).toContain("multiple matches at lines 1, 2");
    expect(result.relayed).toContain("1|old\n2|old");
    expect(result.relayed).not.toContain(`${anchorOf(1, "old")}|`);
  } finally {
    await f.cleanup();
  }
});

test("edit tools are absent without both approvals and respect host path isolation", async () => {
  const f = await fixture();
  let writes = 0;
  try {
    for (const approvals of [
      { read: true, write: false, execute: false },
      { read: false, write: true, execute: false },
    ]) {
      const session = await f.open({
        approvals,
        fetch: async () => sse({ content: "Done." }),
      });
      expect(session.toolNames).not.toContain("mars_edit");
      expect(session.toolNames).not.toContain("mars_replace");
    }
    const result = await callFileTool(
      f,
      "mars_edit",
      {
        path: "../outside",
        edits: [{ op: "insert_after", anchor: "BOF", content: "x" }],
      },
      {
        tools: {
          ...f.tools,
          read: async (path) => {
            expect(path).toBe("../outside");
            throw new Error("Workspace provider refused escaping path");
          },
          write: async () => {
            writes++;
          },
        },
      },
    );
    expect(result.relayed).toContain(
      "Workspace provider refused escaping path",
    );
    expect(writes).toBe(0);
  } finally {
    await f.cleanup();
  }
});

test("cancellation during an edit read forbids the subsequent read and write", async () => {
  const f = await fixture();
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  let writes = 0;
  try {
    const session = await f.open({
      tools: {
        ...f.tools,
        read: async () => {
          reads++;
          entered?.();
          await blocked;
          return new TextEncoder().encode("a");
        },
        write: async () => {
          writes++;
        },
      },
      fetch: async () =>
        sse(
          {
            tool_calls: [
              {
                index: 0,
                id: "cancel_edit",
                type: "function",
                function: {
                  name: "mars_edit",
                  arguments: JSON.stringify({
                    path: "a",
                    edits: [
                      { op: "replace", anchor: anchorOf(1, "a"), content: "b" },
                    ],
                  }),
                },
              },
            ],
          },
          "tool_calls",
        ),
    });
    const running = session.run("Edit");
    await started;
    const cancelling = session.cancel();
    release?.();
    await cancelling;
    expect((await running).status).toBe("cancelled");
    expect(reads).toBe(1);
    expect(writes).toBe(0);
    await expect(session.run("Again")).rejects.toThrow("stopped");
  } finally {
    release?.();
    await f.cleanup();
  }
}, 30000);

test("edits reject oversized files, content, results and invalid UTF-8 without writes", async () => {
  const f = await fixture(4_000_000);
  const task = {
    ...f.task,
    budget: { ...f.task.budget, max_tokens: 2_000_000 },
  };
  let writes = 0;
  try {
    for (const [bytes, content, expected] of [
      [new Uint8Array(1024 * 1024 + 1), "x", "File exceeds 1 MiB"],
      [new Uint8Array([255]), "x", "encoded data"],
      [
        new TextEncoder().encode("a"),
        "中".repeat(44_000),
        "content exceeds 128 KiB",
      ],
      [
        new TextEncoder().encode("a".repeat(1024 * 1024 - 1)),
        "bbb",
        "Edited file exceeds 1 MiB",
      ],
    ] as const) {
      const result = await callFileTool(
        f,
        "mars_edit",
        { path: "a", edits: [{ op: "insert_before", anchor: "BOF", content }] },
        {
          task,
          tools: {
            ...f.tools,
            read: async () => bytes,
            write: async () => {
              writes++;
            },
          },
        },
      );
      expect(result.relayed).toContain(expected);
    }
    const oversizedRead = await callFileTool(
      f,
      "mars_read",
      { path: "a", offset: 1, limit: 1 },
      {
        task,
        tools: {
          ...f.tools,
          read: async () =>
            new TextEncoder().encode(`first\n${"x".repeat(1024 * 1024)}`),
        },
      },
    );
    expect(oversizedRead.relayed).toContain(`${anchorOf(1, "first")}|first`);
    expect(oversizedRead.relayed).toContain("continue with offset=2");
    expect(writes).toBe(0);
  } finally {
    await f.cleanup();
  }
}, 30000);

test("mars_replace uniqueness errors include plain recovery, replace_all writes once", async () => {
  const f = await fixture(32000, { editFormat: "replace" });
  let writes = 0;
  const tools = {
    ...f.tools,
    write: async (path: string, content: Uint8Array) => {
      writes++;
      await f.tools.write(path, content);
    },
  };
  try {
    await writeFile(join(f.cwd, "a.txt"), "\uFEFFa\r\na");
    const rejected = await callFileTool(
      f,
      "mars_replace",
      { path: "a.txt", old: "a", new: "新" },
      { tools },
    );
    expect(rejected.relayed).toContain("multiple matches at lines 1, 2");
    expect(rejected.relayed).toContain("1|a\n2|a");
    expect(writes).toBe(0);
    expect(
      (
        await callFileTool(
          f,
          "mars_replace",
          { path: "a.txt", old: "a", new: "新", replace_all: true },
          { tools },
        )
      ).relayed,
    ).toContain("Replaced 2 match(es)");
    expect(writes).toBe(1);
    expect(await readFile(join(f.cwd, "a.txt"), "utf8")).toBe("\uFEFF新\r\n新");
  } finally {
    await f.cleanup();
  }
});

test("mars_replace rejects explosive replace_all before allocation without changing the file", async () => {
  const f = await fixture(1_000_000, { editFormat: "replace" });
  let writes = 0;
  try {
    const original = "a".repeat(100000);
    await writeFile(join(f.cwd, "a.txt"), original);
    const start = performance.now();
    const result = await callFileTool(
      f,
      "mars_replace",
      {
        path: "a.txt",
        old: "a",
        new: "x".repeat(64 * 1024),
        replace_all: true,
      },
      {
        task: { ...f.task, budget: { ...f.task.budget, max_tokens: 500_000 } },
        tools: {
          ...f.tools,
          write: async () => {
            writes++;
          },
        },
      },
    );
    expect(performance.now() - start).toBeLessThan(3000);
    expect(result.relayed).toContain(
      "Edited file exceeds 1 MiB limit; nothing written.",
    );
    expect(writes).toBe(0);
    expect(await readFile(join(f.cwd, "a.txt"), "utf8")).toBe(original);
    expect(JSON.stringify(result.session.journalSnapshot())).toContain(
      '"isError":true',
    );
  } finally {
    await f.cleanup();
  }
});

test("initial allowance uses exactly the selected edit declaration and conservative omission", () => {
  const base = {
    approvals: { read: true, write: true, execute: false },
    recall: false,
    instruction: "Edit",
    patch: true,
  };
  const sizes = (["hashline", "replace", "apply_patch"] as EditFormat[]).map(
    (editFormat) => initialRequestAllowance({ ...base, editFormat }),
  );
  expect(initialRequestAllowance(base)).toBe(Math.max(...sizes));
  expect(
    initialRequestAllowance({
      ...base,
      editFormat: "apply_patch",
      patch: false,
    }),
  ).toBe(
    initialRequestAllowance({ ...base, editFormat: "hashline", patch: false }),
  );
  expect(new Set(sizes).size).toBe(3);
});

test("a model request past the model's requestTimeoutMs fails as provider_timeout, not a generic error", async () => {
  const f = await fixture();
  const failures: string[] = [];
  const selected = {
    ...selectExecutionModel(f.registry),
    requestTimeoutMs: 1_000,
  };
  const ledger: BudgetLedger = {
    deadline: Date.now() + 60000,
    reserved_tokens: 0,
    reserved_usd: 0,
    input_tokens: 0,
    output_tokens: 0,
  };
  const model = { api: "fixture", provider: "fixture", id: "stub" } as Model;
  try {
    const started = Date.now();
    const bridge = createModelBridge({
      registry: f.registry,
      selected,
      budget: f.task.budget,
      ledger,
      signal: new AbortController().signal,
      persistLedger: async () => undefined,
      onFailure: (code) => failures.push(code),
      fetch: async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const abort = () =>
            reject(new DOMException("Timed out", "AbortError"));
          if (init?.signal?.aborted) abort();
          else init?.signal?.addEventListener("abort", abort, { once: true });
        }),
      env: f.env,
    });
    const result = await bridge(model, {
      messages: [{ role: "user", content: "Hello", timestamp: 1 }],
    }).result();
    expect(result.stopReason).toBe("error");
    expect(failures).toEqual(["provider_timeout"]);
    expect(Date.now() - started).toBeLessThan(20_000);

    const exhausted = createModelBridge({
      registry: f.registry,
      selected,
      budget: { ...f.task.budget, max_tokens: 1 },
      ledger,
      signal: new AbortController().signal,
      persistLedger: async () => undefined,
      onFailure: (code) => failures.push(code),
      fetch: async () => sse({ content: "Should not run" }),
      env: f.env,
    });
    await exhausted(model, {
      messages: [{ role: "user", content: "Hello", timestamp: 1 }],
    }).result();
    expect(failures).toEqual(["provider_timeout", "budget_exhausted"]);

    // An HTTP error that merely arrives late is still a provider error.
    const late = createModelBridge({
      registry: f.registry,
      selected,
      budget: f.task.budget,
      ledger,
      signal: new AbortController().signal,
      persistLedger: async () => undefined,
      onFailure: (code) => failures.push(code),
      fetch: async () => {
        await Bun.sleep(1_200);
        return new Response("bad request", { status: 400 });
      },
      env: f.env,
    });
    await late(model, {
      messages: [{ role: "user", content: "Hello", timestamp: 1 }],
    }).result();
    expect(failures.at(-1)).toBe("provider_error");

    const expired = createModelBridge({
      registry: f.registry,
      selected,
      budget: f.task.budget,
      ledger: { ...ledger, deadline: Date.now() - 1 },
      signal: new AbortController().signal,
      persistLedger: async () => undefined,
      onFailure: (code) => failures.push(code),
      fetch: async () => sse({ content: "Should not run" }),
      env: f.env,
    });
    await expired(model, {
      messages: [{ role: "user", content: "Hello", timestamp: 1 }],
    }).result();
    expect(failures.at(-1)).toBe("deadline_exceeded");
  } finally {
    await f.cleanup();
  }
}, 30000);

test("a failed run reports a distinct failure_code", async () => {
  const f = await fixture();
  try {
    const session = await f.open({
      fetch: async () => new Response("bad request", { status: 400 }),
    });
    const outcome = await session.run("Fail at the provider");
    expect(outcome.status).toBe("failed");
    expect(outcome.failure_code).toBe("provider_error");
    expect(outcome.error).toContain("provider_error");
  } finally {
    await f.cleanup();
  }
}, 30000);

test("bridge sends later developer reminders as user turns and hides workspace roots", () => {
  const root = "/host/private/work/abc/workspace";
  const request = toChatRequest(
    {
      systemPrompt: [`Workspace: ${root}`],
      messages: [
        { role: "developer", content: "Lead control", timestamp: 0 },
        { role: "user", content: `Edit ${root}/a.txt`, timestamp: 1 },
        {
          role: "developer",
          content: `<system-reminder>current working directory: '${root}'</system-reminder>`,
          timestamp: 2,
        },
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call",
              name: "mars_read",
              arguments: { path: `${root}/a.txt`, nested: [{ cwd: root }] },
            },
          ],
          api: "fixture",
          provider: "fixture",
          model: "stub",
          timestamp: 3,
          stopReason: "toolUse",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
        },
      ],
    },
    { workspaceRoots: [root] },
  );
  expect(request.messages.map((message) => message.role)).toEqual([
    "system",
    "system",
    "user",
    "user",
    "assistant",
  ]);
  expect(JSON.stringify(request)).not.toContain(root);
  expect(request.messages[4]).toMatchObject({
    tool_calls: [
      {
        arguments: {
          path: `${WORKSPACE_PLACEHOLDER}/a.txt`,
          nested: [{ cwd: WORKSPACE_PLACEHOLDER }],
        },
      },
    ],
  });
  expect(request.messages[0]?.content).toBe(
    `Workspace: ${WORKSPACE_PLACEHOLDER}`,
  );
  expect(request.messages[2]?.content).toBe(
    `Edit ${WORKSPACE_PLACEHOLDER}/a.txt`,
  );
  expect(request.messages[3]?.content).toContain(
    `current working directory: '${WORKSPACE_PLACEHOLDER}'`,
  );
});

for (const [label, contextWindow, config, check] of [
  ["defaults to 4096", 200_000, {}, (n: number) => n === 4096],
  [
    "honours maxOutputTokens",
    200_000,
    { maxOutputTokens: 8192 },
    (n: number) => n === 8192,
  ],
  [
    "caps maxOutputTokens by the context window",
    32_000,
    { maxOutputTokens: 100_000 },
    (n: number) => n > 4096 && n < 32_000,
  ],
] as const)
  test(`runtime output cap ${label} and never shows the host workspace path`, async () => {
    const f = await fixture(contextWindow, config);
    const requests: Record<string, unknown>[] = [];
    try {
      const session = await f.open({
        modelId: "fixture/free",
        task: { ...f.task, budget: { ...f.task.budget, max_tokens: 400_000 } },
        fetch: async (_url, init) => {
          requests.push(JSON.parse(String(init?.body)));
          return sse({ content: "Done." });
        },
      });
      await session.run(f.task.request);
      expect(requests.length).toBeGreaterThan(0);
      expect(check(Number(requests[0]?.max_tokens))).toBe(true);
      const wire = JSON.stringify(requests);
      expect(wire).not.toContain(f.root);
      expect(wire).not.toContain(await realpath(f.root));
    } finally {
      await f.cleanup();
    }
  });

for (const reason of ["length", "max_tokens"]) {
  test(`a ${reason} response pauses without running complete tool calls or retrying`, async () => {
    const f = await fixture(200_000, { maxOutputTokens: 32_000 });
    let requests = 0;
    let reads = 0;
    try {
      const session = await f.open({
        tools: {
          ...f.tools,
          read: async () => {
            reads++;
            return Buffer.from("Hello");
          },
        },
        fetch: async (_url, init) => {
          requests++;
          const request = JSON.parse(String(init?.body));
          return sse(
            {
              content: "Checking the file.",
              tool_calls: [
                {
                  index: 0,
                  id: "capped_read",
                  type: "function",
                  function: {
                    name: "mars_read",
                    arguments: JSON.stringify({ path: "greeting.txt" }),
                  },
                },
              ],
            },
            reason,
            request.max_tokens,
          );
        },
      });
      const outcome = await session.run(f.task.request);
      expect(outcome).toMatchObject({
        status: "paused",
        content: "Checking the file.",
        usage: { reserved_tokens: f.task.budget.max_tokens },
      });
      expect(requests).toBe(1);
      expect(reads).toBe(0);
      expect(JSON.stringify(session.journalSnapshot())).not.toContain(
        "capped_read",
      );
    } finally {
      await f.cleanup();
    }
  });
}

test("a file that names the workspace root can be read and exactly edited through the placeholder", async () => {
  const f = await fixture(200_000);
  const requests: Record<string, unknown>[] = [];
  try {
    const root = await realpath(f.cwd);
    await writeFile(join(f.cwd, "conf.py"), `base = "${root}/data"\n`);
    const call = (name: string, args: Record<string, unknown>) =>
      sse(
        {
          tool_calls: [
            {
              index: 0,
              id: `call_${requests.length}`,
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
        "tool_calls",
      );
    const session = await f.open({
      modelId: "fixture/free",
      editFormat: "replace",
      task: { ...f.task, budget: { ...f.task.budget, max_tokens: 400_000 } },
      fetch: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        if (requests.length === 1)
          return call("mars_read", { path: "conf.py" });
        if (requests.length === 2)
          return call("mars_replace", {
            path: "conf.py",
            old: `base = "${WORKSPACE_PLACEHOLDER}/data"`,
            new: `base = "${WORKSPACE_PLACEHOLDER}/other"`,
          });
        return sse({ content: "Done." });
      },
    });
    await session.run(f.task.request);
    expect(requests).toHaveLength(3);
    expect(JSON.stringify(requests[1])).toContain(
      `base = \\"${WORKSPACE_PLACEHOLDER}/data\\"`,
    );
    expect(JSON.stringify(requests)).not.toContain(root);
    expect(await readFile(join(f.cwd, "conf.py"), "utf8")).toBe(
      `base = "${root}/other"\n`,
    );
  } finally {
    await f.cleanup();
  }
});
