import type { RequestContext } from "@mars/contracts";
import { RpcErrorSchema, type RpcMethod } from "./protocol";

export type RpcErrorKind =
  | "no-token"
  | "endpoint"
  | "disconnected"
  | "timeout"
  | "cancelled"
  | "unauthorized"
  | "forbidden"
  | "conflict"
  | "not-found"
  | "server"
  | "protocol";

export class RpcError extends Error {
  constructor(
    readonly kind: RpcErrorKind,
    message: string,
    readonly code?: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export function isRpcError(error: unknown, kind?: RpcErrorKind): boolean {
  return (
    error instanceof RpcError && (kind === undefined || error.kind === kind)
  );
}

export interface RpcRequest {
  method: RpcMethod;
  context?: RequestContext;
  params: Record<string, unknown>;
}

/** Sends one RPC and returns the raw `result`, or throws {@link RpcError}. */
export interface RpcTransport {
  send(request: RpcRequest, signal?: AbortSignal): Promise<unknown>;
}

export type FetchLike = (
  input: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
    redirect: "error";
  },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface HttpTransportOptions {
  rpcUrl: string;
  getToken: () => Promise<string | undefined>;
  fetch?: FetchLike;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

const CONFLICT_CODES = new Set(["conflict", "revision_conflict"]);
const KIND_BY_CODE: Record<string, RpcErrorKind> = {
  unauthorized: "unauthorized",
  unauthenticated: "unauthorized",
  forbidden: "forbidden",
  permission_denied: "forbidden",
  not_found: "not-found",
};

/** Server-provided text is untrusted: bound it and never echo the token. */
export function sanitizeServerText(text: string, token?: string): string {
  let clean = Array.from(text, (char) => {
    const code = char.charCodeAt(0);
    return (code < 0x20 && code !== 0x0a && code !== 0x09) || code === 0x7f
      ? " "
      : char;
  }).join("");
  if (token && token.length >= 4) clean = clean.split(token).join("[redacted]");
  return clean.length > 500 ? `${clean.slice(0, 500)}…` : clean;
}

function kindForStatus(status: number): RpcErrorKind | undefined {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not-found";
  if (status === 409) return "conflict";
  return undefined;
}

export class HttpRpcTransport implements RpcTransport {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;

  constructor(private readonly options: HttpTransportOptions) {
    this.fetchImpl =
      options.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxBytes = options.maxResponseBytes ?? 64 * 1024 * 1024;
  }

  async send(request: RpcRequest, signal?: AbortSignal): Promise<unknown> {
    const token = await this.options.getToken();
    if (!token)
      throw new RpcError("no-token", "No MARS server token is configured.");
    if (signal?.aborted) throw new RpcError("cancelled", "Request cancelled.");
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const body: Record<string, unknown> = {
      method: request.method,
      params: request.params,
    };
    if (request.context) body.context = request.context;
    let status: number;
    let text: string;
    let contentType: string | null;
    try {
      const response = await this.fetchImpl(this.options.rpcUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: "error",
      });
      status = response.status;
      contentType = response.headers.get("content-type");
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (declared > this.maxBytes)
        throw new RpcError("protocol", "Server response is too large.");
      text = await response.text();
    } catch (error) {
      if (error instanceof RpcError) throw error;
      if (signal?.aborted)
        throw new RpcError("cancelled", "Request cancelled.");
      if (timedOut)
        throw new RpcError("timeout", "MARS server did not respond in time.");
      throw new RpcError("disconnected", "Cannot reach the MARS server.");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    if (text.length > this.maxBytes)
      throw new RpcError("protocol", "Server response is too large.");
    return this.parse(status, contentType, text, token);
  }

  private parse(
    status: number,
    contentType: string | null,
    text: string,
    token: string,
  ): unknown {
    let parsed: unknown;
    const isJson = (contentType ?? "")
      .toLowerCase()
      .startsWith("application/json");
    try {
      parsed = isJson ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    const statusKind = kindForStatus(status);
    if (parsed === undefined || typeof parsed !== "object" || parsed === null) {
      if (statusKind)
        throw new RpcError(
          statusKind,
          `Server returned HTTP ${status}.`,
          undefined,
          status,
        );
      throw new RpcError(
        status >= 500 ? "server" : "protocol",
        `Server returned an unreadable response (HTTP ${status}).`,
        undefined,
        status,
      );
    }
    const keys = Object.keys(parsed);
    if (keys.length === 1 && keys[0] === "error") {
      const error = RpcErrorSchema.safeParse(
        (parsed as { error: unknown }).error,
      );
      if (!error.success)
        throw new RpcError(
          "protocol",
          "Server returned a malformed error.",
          undefined,
          status,
        );
      const code = error.data.code;
      const kind = CONFLICT_CODES.has(code)
        ? "conflict"
        : (KIND_BY_CODE[code] ?? statusKind ?? "server");
      throw new RpcError(
        kind,
        sanitizeServerText(error.data.message, token) || code,
        sanitizeServerText(code, token),
        status,
      );
    }
    if (statusKind)
      throw new RpcError(
        statusKind,
        `Server returned HTTP ${status}.`,
        undefined,
        status,
      );
    if (
      status < 200 ||
      status >= 300 ||
      keys.length !== 1 ||
      keys[0] !== "result"
    )
      throw new RpcError(
        "protocol",
        "Server returned a malformed response.",
        undefined,
        status,
      );
    return (parsed as { result: unknown }).result;
  }
}
