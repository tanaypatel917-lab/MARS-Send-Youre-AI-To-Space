import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import {
  MCP_PROTOCOL_VERSION,
  type McpServerDescriptor,
  type McpToolDescriptor,
  type McpTransportConfig,
  type RawMcpToolCallResult,
  type StdioTransportConfig,
  type StreamableHttpTransportConfig,
} from "./schemas";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface McpRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  extraHeaders?: Record<string, string>;
}

export interface McpTransportConnection {
  readonly transportType: "stdio" | "streamable-http";
  readonly origin: string | null;
  initialize(options?: McpRequestOptions): Promise<McpServerDescriptor>;
  listTools(options?: McpRequestOptions): Promise<McpToolDescriptor[]>;
  callTool(
    tool: string,
    args: Record<string, unknown>,
    options?: McpRequestOptions,
  ): Promise<RawMcpToolCallResult>;
  close(): Promise<void>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const BASELINE_SAFE_ENV_KEYS = ["PATH", "HOME", "TMPDIR", "LANG", "TERM"];

function buildSanitizedEnv(allowlist: readonly string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of BASELINE_SAFE_ENV_KEYS) {
    const val = process.env[key];
    if (val !== undefined) env[key] = val;
  }
  for (const key of allowlist) {
    const val = process.env[key];
    if (val !== undefined) env[key] = val;
  }
  return env;
}

function parseInitializeResult(raw: unknown): {
  protocolVersion: string;
  serverInfo: { name: string; version: string };
  capabilities: Record<string, unknown>;
  droppedInstructions: boolean;
} {
  if (!raw || typeof raw !== "object") {
    throw new Error("MCP initialize returned non-object result");
  }
  const obj = raw as Record<string, unknown>;
  const protocolVersion =
    typeof obj.protocolVersion === "string"
      ? obj.protocolVersion
      : MCP_PROTOCOL_VERSION;
  const infoRaw =
    obj.serverInfo && typeof obj.serverInfo === "object"
      ? (obj.serverInfo as Record<string, unknown>)
      : {};
  const serverInfo = {
    name: typeof infoRaw.name === "string" ? infoRaw.name : "unknown",
    version: typeof infoRaw.version === "string" ? infoRaw.version : "0.0.0",
  };
  const capabilities =
    obj.capabilities && typeof obj.capabilities === "object"
      ? (obj.capabilities as Record<string, unknown>)
      : {};
  // Deliberately drop server-supplied `instructions` / `_instructions` so
  // untrusted MCP servers cannot inject prompt-steering instructions at connect time.
  const droppedInstructions = "instructions" in obj || "_instructions" in obj;
  return { protocolVersion, serverInfo, capabilities, droppedInstructions };
}

const MAX_TOOLS_LIST_PAGES = 100;

function compareCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function parseToolsListPage(raw: unknown): {
  tools: McpToolDescriptor[];
  nextCursor: string | undefined;
} {
  if (!raw || typeof raw !== "object") {
    throw new Error("MCP tools/list returned non-object result");
  }
  const obj = raw as Record<string, unknown>;
  const toolsRaw = obj.tools;
  if (!Array.isArray(toolsRaw)) {
    throw new Error("MCP tools/list missing tools array");
  }
  const tools: McpToolDescriptor[] = [];
  for (const item of toolsRaw) {
    if (!item || typeof item !== "object") continue;
    const t = item as Record<string, unknown>;
    if (typeof t.name !== "string" || t.name.length === 0) {
      throw new Error("MCP tool descriptor missing valid name");
    }
    const inputSchema =
      t.inputSchema && typeof t.inputSchema === "object"
        ? (t.inputSchema as Record<string, unknown>)
        : { type: "object", properties: {} };
    const outputSchema =
      t.outputSchema && typeof t.outputSchema === "object"
        ? (t.outputSchema as Record<string, unknown>)
        : undefined;
    tools.push({
      name: t.name,
      ...(typeof t.description === "string"
        ? { description: t.description }
        : {}),
      inputSchema,
      ...(outputSchema ? { outputSchema } : {}),
    });
  }
  const nextCursor =
    typeof obj.nextCursor === "string" && obj.nextCursor.length > 0
      ? obj.nextCursor
      : undefined;
  return { tools, nextCursor };
}

function remainingOptions(
  options: McpRequestOptions | undefined,
  deadlineMs: number | undefined,
): McpRequestOptions | undefined {
  if (deadlineMs === undefined) return options;
  const remaining = deadlineMs - Date.now();
  if (remaining <= 0) {
    throw new Error("MCP operation timed out");
  }
  return { ...options, timeoutMs: remaining };
}

async function listAllToolsPaginated(
  fetchPage: (
    cursor: string | undefined,
    stepOptions: McpRequestOptions | undefined,
  ) => Promise<unknown>,
  options?: McpRequestOptions,
): Promise<McpToolDescriptor[]> {
  const deadlineMs =
    options?.timeoutMs !== undefined
      ? Date.now() + options.timeoutMs
      : undefined;
  const all: McpToolDescriptor[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_TOOLS_LIST_PAGES; page++) {
    const raw = await fetchPage(cursor, remainingOptions(options, deadlineMs));
    const parsed = parseToolsListPage(raw);
    all.push(...parsed.tools);
    if (!parsed.nextCursor) {
      break;
    }
    if (seenCursors.has(parsed.nextCursor)) {
      throw new Error("MCP tools/list returned duplicate pagination cursor");
    }
    seenCursors.add(parsed.nextCursor);
    cursor = parsed.nextCursor;
    if (page === MAX_TOOLS_LIST_PAGES - 1) {
      throw new Error("MCP tools/list exceeded maximum pagination depth");
    }
  }
  return all.sort((a, b) => compareCodeUnit(a.name, b.name));
}

function parseToolCallResult(raw: unknown): RawMcpToolCallResult {
  if (!raw || typeof raw !== "object") {
    throw new Error("MCP tools/call returned non-object result");
  }
  const obj = raw as Record<string, unknown>;
  const content = Array.isArray(obj.content) ? obj.content : [];
  return {
    ...obj,
    content,
    ...(obj.structuredContent !== undefined
      ? { structuredContent: obj.structuredContent }
      : {}),
    ...(typeof obj.isError === "boolean" ? { isError: obj.isError } : {}),
  } as RawMcpToolCallResult;
}

export class StdioMcpTransport implements McpTransportConnection {
  readonly transportType = "stdio" as const;
  readonly origin = null;

  private readonly config: StdioTransportConfig;
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      cleanupAbort?: () => void;
    }
  >();

  constructor(config: StdioTransportConfig) {
    this.config = config;
  }

  private ensureStarted(): ChildProcessWithoutNullStreams {
    if (this.closed) {
      throw new Error("MCP stdio transport is closed");
    }
    if (this.child && !this.child.killed && this.child.exitCode === null) {
      return this.child;
    }
    const proc = spawn(this.config.command, this.config.args, {
      ...(this.config.cwd ? { cwd: this.config.cwd } : {}),
      env: buildSanitizedEnv(this.config.env_allowlist),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = proc;
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      this.onStdoutData(chunk);
    });
    proc.on("error", (err) => {
      this.rejectAllPending(
        new Error(`MCP stdio process error: ${err.message}`),
      );
    });
    proc.on("exit", (code, signal) => {
      this.child = null;
      this.rejectAllPending(
        new Error(
          `MCP stdio process exited (code=${String(code)}, signal=${String(signal)})`,
        ),
      );
    });
    return proc;
  }

  private onStdoutData(chunk: string): void {
    this.buffer += chunk;
    let newlineIdx = this.buffer.indexOf("\n");
    while (newlineIdx !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);
      newlineIdx = this.buffer.indexOf("\n");
      if (!line) continue;
      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(line) as JsonRpcResponse;
      } catch {
        continue;
      }
      if (typeof msg.id !== "number") continue;
      const entry = this.pending.get(msg.id);
      if (!entry) continue;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      entry.cleanupAbort?.();
      if (msg.error) {
        entry.reject(
          new Error(
            `MCP JSON-RPC error ${msg.error.code}: ${msg.error.message}`,
          ),
        );
      } else {
        entry.resolve(msg.result);
      }
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [id, entry] of this.pending.entries()) {
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.cleanupAbort?.();
      entry.reject(error);
    }
  }

  private sendRequest(
    method: string,
    params?: Record<string, unknown>,
    options?: McpRequestOptions,
  ): Promise<unknown> {
    if (options?.signal?.aborted) {
      return Promise.reject(new Error("MCP request aborted"));
    }
    const proc = this.ensureStarted();
    const id = this.nextId++;
    const timeoutMs = options?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const payload: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params ? { params } : {}),
    };
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        cleanupAbort?.();
        reject(new Error(`MCP stdio request timed out: ${method}`));
      }, timeoutMs);

      let cleanupAbort: (() => void) | undefined;
      if (options?.signal) {
        const onAbort = () => {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(new Error(`MCP stdio request aborted: ${method}`));
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
        cleanupAbort = () =>
          options.signal?.removeEventListener("abort", onAbort);
      }

      this.pending.set(id, {
        resolve,
        reject,
        timer,
        ...(cleanupAbort ? { cleanupAbort } : {}),
      });
      proc.stdin.write(`${JSON.stringify(payload)}\n`, (err) => {
        if (err) {
          const entry = this.pending.get(id);
          if (entry) {
            this.pending.delete(id);
            clearTimeout(entry.timer);
            entry.cleanupAbort?.();
            entry.reject(err);
          }
        }
      });
    });
  }

  private sendNotification(
    method: string,
    params?: Record<string, unknown>,
  ): void {
    if (!this.child || this.child.killed || this.child.exitCode !== null) {
      return;
    }
    const payload: JsonRpcNotification = {
      jsonrpc: "2.0",
      method,
      ...(params ? { params } : {}),
    };
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  async initialize(options?: McpRequestOptions): Promise<McpServerDescriptor> {
    const deadlineMs =
      options?.timeoutMs !== undefined
        ? Date.now() + options.timeoutMs
        : undefined;
    const raw = await this.sendRequest(
      "initialize",
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "mars-mcp-client", version: "0.0.1" },
      },
      remainingOptions(options, deadlineMs),
    );
    const init = parseInitializeResult(raw);
    this.sendNotification("notifications/initialized");
    const tools = await this.listTools(remainingOptions(options, deadlineMs));
    return {
      protocolVersion: init.protocolVersion,
      serverInfo: init.serverInfo,
      capabilities: init.capabilities,
      tools,
      dropped_server_instructions: init.droppedInstructions,
    };
  }

  async listTools(options?: McpRequestOptions): Promise<McpToolDescriptor[]> {
    return listAllToolsPaginated(
      (cursor, stepOptions) =>
        this.sendRequest("tools/list", cursor ? { cursor } : {}, stepOptions),
      options,
    );
  }

  async callTool(
    tool: string,
    args: Record<string, unknown>,
    options?: McpRequestOptions,
  ): Promise<RawMcpToolCallResult> {
    const raw = await this.sendRequest(
      "tools/call",
      { name: tool, arguments: args },
      options,
    );
    return parseToolCallResult(raw);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.rejectAllPending(new Error("MCP stdio transport closed"));
    const proc = this.child;
    this.child = null;
    if (!proc || proc.killed || proc.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {}
        resolve();
      }, 500);
      proc.once("exit", () => {
        clearTimeout(killTimer);
        resolve();
      });
      try {
        proc.kill("SIGTERM");
      } catch {
        clearTimeout(killTimer);
        resolve();
      }
    });
  }
}

function parseSseEventBlock(
  block: string,
  expectedId: number,
): JsonRpcResponse | undefined {
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (dataLines.length === 0) return undefined;
  const joined = dataLines.join("\n").trim();
  if (!joined) return undefined;
  let parsed: JsonRpcResponse;
  try {
    parsed = JSON.parse(joined) as JsonRpcResponse;
  } catch {
    return undefined;
  }
  return parsed.id === expectedId ? parsed : undefined;
}

async function readSseJsonRpcResponse(
  response: Response,
  expectedId: number,
  signal: AbortSignal,
): Promise<JsonRpcResponse> {
  if (!response.body) {
    const text = await response.text();
    for (const block of text.split(/\r?\n\r?\n/)) {
      const match = parseSseEventBlock(block, expectedId);
      if (match) return match;
    }
    throw new Error(
      `MCP Streamable HTTP SSE stream did not contain response for id=${expectedId}`,
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const onAbort = () => {
    void reader.cancel().catch(() => {});
  };
  if (signal.aborted) {
    await reader.cancel().catch(() => {});
    throw new Error("MCP Streamable HTTP request aborted");
  }
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    while (true) {
      if (signal.aborted) {
        throw new Error("MCP Streamable HTTP request aborted");
      }
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const separatorMatch = /\r?\n\r?\n/;
      let matchIdx = buffer.search(separatorMatch);
      while (matchIdx !== -1) {
        const sep = buffer.slice(matchIdx).match(separatorMatch)?.[0] ?? "\n\n";
        const block = buffer.slice(0, matchIdx);
        buffer = buffer.slice(matchIdx + sep.length);
        const found = parseSseEventBlock(block, expectedId);
        if (found) {
          await reader.cancel().catch(() => {});
          return found;
        }
        matchIdx = buffer.search(separatorMatch);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim().length > 0) {
      const found = parseSseEventBlock(buffer, expectedId);
      if (found) return found;
    }
    if (signal.aborted) {
      throw new Error("MCP Streamable HTTP request aborted");
    }
    throw new Error(
      `MCP Streamable HTTP SSE stream did not contain response for id=${expectedId}`,
    );
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

export class StreamableHttpMcpTransport implements McpTransportConnection {
  readonly transportType = "streamable-http" as const;
  readonly origin: string;

  private readonly config: StreamableHttpTransportConfig;
  private sessionId: string | null = null;
  private nextId = 1;
  private closed = false;

  constructor(config: StreamableHttpTransportConfig) {
    this.config = config;
    this.origin = new URL(config.url).origin;
  }

  private async withPostJsonRpc<T>(
    payload: JsonRpcRequest | JsonRpcNotification,
    options: McpRequestOptions | undefined,
    handleResponse: (response: Response, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.closed) {
      throw new Error("MCP Streamable HTTP transport is closed");
    }
    const targetUrl = new URL(this.config.url);
    if (targetUrl.origin !== this.origin) {
      throw new Error("MCP Streamable HTTP origin mismatch");
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
      ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
      ...(options?.extraHeaders ?? {}),
    };

    const controller = new AbortController();
    const timeoutMs = options?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onExternalAbort = () => controller.abort();
    if (options?.signal) {
      if (options.signal.aborted) {
        clearTimeout(timer);
        throw new Error("MCP Streamable HTTP request aborted");
      }
      options.signal.addEventListener("abort", onExternalAbort, { once: true });
    }

    try {
      const response = await fetch(targetUrl.toString(), {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        // Never follow redirects automatically: redirects could switch origin
        // and leak origin-bound credentials or bypass endpoint trust checks.
        redirect: "manual",
        signal: controller.signal,
      });

      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => {});
        throw new Error(
          `MCP Streamable HTTP rejected redirect (status=${response.status})`,
        );
      }

      const nextSessionId = response.headers.get("mcp-session-id");
      if (nextSessionId) {
        this.sessionId = nextSessionId;
      }

      return await handleResponse(response, controller.signal);
    } finally {
      clearTimeout(timer);
      options?.signal?.removeEventListener("abort", onExternalAbort);
    }
  }

  private async postJsonRpc(
    payload: JsonRpcRequest | JsonRpcNotification,
    options?: McpRequestOptions,
  ): Promise<void> {
    await this.withPostJsonRpc(payload, options, async (response) => {
      await response.body?.cancel().catch(() => {});
    });
  }

  private async sendRequest(
    method: string,
    params?: Record<string, unknown>,
    options?: McpRequestOptions,
  ): Promise<unknown> {
    const id = this.nextId++;
    const msg = await this.withPostJsonRpc(
      {
        jsonrpc: "2.0",
        id,
        method,
        ...(params ? { params } : {}),
      },
      options,
      async (response, signal) => {
        if (!response.ok) {
          const errBody = await response.text().catch(() => "");
          throw new Error(
            `MCP Streamable HTTP error ${response.status}: ${errBody.slice(0, 200)}`,
          );
        }

        const contentType = (
          response.headers.get("content-type") ?? ""
        ).toLowerCase();
        if (contentType.includes("text/event-stream")) {
          return await readSseJsonRpcResponse(response, id, signal);
        }
        if (contentType.includes("application/json")) {
          const readJson = async () => {
            if (!response.body) {
              return (await response.json()) as JsonRpcResponse;
            }
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let text = "";
            const onAbort = () => {
              void reader.cancel().catch(() => {});
            };
            if (signal.aborted) {
              await reader.cancel().catch(() => {});
              throw new Error("MCP Streamable HTTP request aborted");
            }
            signal.addEventListener("abort", onAbort, { once: true });
            try {
              while (true) {
                if (signal.aborted) {
                  throw new Error("MCP Streamable HTTP request aborted");
                }
                const { value, done } = await reader.read();
                if (done) break;
                text += decoder.decode(value, { stream: true });
              }
              text += decoder.decode();
              if (signal.aborted) {
                throw new Error("MCP Streamable HTTP request aborted");
              }
              return JSON.parse(text) as JsonRpcResponse;
            } finally {
              signal.removeEventListener("abort", onAbort);
              reader.releaseLock();
            }
          };
          return await readJson();
        }
        await response.body?.cancel().catch(() => {});
        throw new Error(
          `MCP Streamable HTTP unsupported Content-Type: ${contentType || "none"}`,
        );
      },
    );

    if (msg.error) {
      throw new Error(
        `MCP JSON-RPC error ${msg.error.code}: ${msg.error.message}`,
      );
    }
    return msg.result;
  }

  async initialize(options?: McpRequestOptions): Promise<McpServerDescriptor> {
    const deadlineMs =
      options?.timeoutMs !== undefined
        ? Date.now() + options.timeoutMs
        : undefined;
    const raw = await this.sendRequest(
      "initialize",
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "mars-mcp-client", version: "0.0.1" },
      },
      remainingOptions(options, deadlineMs),
    );
    const init = parseInitializeResult(raw);
    await this.postJsonRpc(
      {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      },
      remainingOptions(options, deadlineMs),
    ).catch(() => {});
    const tools = await this.listTools(remainingOptions(options, deadlineMs));
    return {
      protocolVersion: init.protocolVersion,
      serverInfo: init.serverInfo,
      capabilities: init.capabilities,
      tools,
      dropped_server_instructions: init.droppedInstructions,
    };
  }

  async listTools(options?: McpRequestOptions): Promise<McpToolDescriptor[]> {
    return listAllToolsPaginated(
      (cursor, stepOptions) =>
        this.sendRequest("tools/list", cursor ? { cursor } : {}, stepOptions),
      options,
    );
  }

  async callTool(
    tool: string,
    args: Record<string, unknown>,
    options?: McpRequestOptions,
  ): Promise<RawMcpToolCallResult> {
    const raw = await this.sendRequest(
      "tools/call",
      { name: tool, arguments: args },
      options,
    );
    return parseToolCallResult(raw);
  }

  async close(): Promise<void> {
    const sid = this.sessionId;
    this.sessionId = null;
    this.closed = true;
    if (!sid) return;
    await fetch(this.config.url, {
      method: "DELETE",
      headers: {
        "Mcp-Session-Id": sid,
        "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
      },
      redirect: "manual",
    }).catch(() => {});
  }
}

export function createMcpTransport(
  config: McpTransportConfig,
): McpTransportConnection {
  if (config.type === "stdio") {
    return new StdioMcpTransport(config);
  }
  return new StreamableHttpMcpTransport(config);
}
