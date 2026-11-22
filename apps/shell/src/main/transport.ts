import { readBoundedUtf8 } from "@mars/contracts/bounded-read";
import { isLoopbackHost } from "@mars/contracts/connection-file";
import { BRIDGE_ERROR_MESSAGES, type BridgeErrorKind } from "../shared/methods";

export type RequestContext = {
  schema_version: 1;
  scope: { owner_id: string; project_id: string; workspace_id?: string };
  request_id: string;
};

export type TransportRequest = {
  method: string;
  params: unknown;
  context?: RequestContext;
};

export type RpcTransport = {
  send(request: TransportRequest): Promise<unknown>;
};

export class TransportError extends Error {
  constructor(readonly kind: BridgeErrorKind) {
    super(BRIDGE_ERROR_MESSAGES[kind]);
    this.name = "TransportError";
  }
}

export type FetchLike = typeof fetch;

const MAX_DEFAULT_RESPONSE_BYTES = 4 * 1024 * 1024 + 64 * 1024;

function validateLoopbackUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TransportError("refused");
  }
  if (
    url.protocol !== "http:" ||
    !isLoopbackHost(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new TransportError("refused");
  return url.origin;
}

async function readBounded(
  response: Response,
  maxBytes: number,
): Promise<string> {
  try {
    return await readBoundedUtf8(response, maxBytes);
  } catch {
    throw new TransportError("protocol");
  }
}

function statusKind(status: number): BridgeErrorKind | undefined {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status >= 500) return "unavailable";
  return undefined;
}

function codeKind(code: string): BridgeErrorKind | undefined {
  if (code === "unauthorized" || code === "unauthenticated")
    return "unauthorized";
  if (code === "forbidden" || code === "permission_denied") return "forbidden";
  if (code === "not_found") return "not_found";
  if (code === "conflict" || code === "revision_conflict") return "conflict";
  if (code === "unavailable" || code === "model_unavailable") return code;
  return undefined;
}

export function createLoopbackTransport(options: {
  url: string;
  token: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  maxResponseBytes?: number;
}): RpcTransport {
  const origin = validateLoopbackUrl(options.url);
  const endpoint = `${origin}/v1/rpc`;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxBytes = options.maxResponseBytes ?? MAX_DEFAULT_RESPONSE_BYTES;
  return {
    async send(request) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      let body: string;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.token}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify(request),
          signal: controller.signal,
          redirect: "error",
        });
        if (
          !(response.headers.get("content-type") ?? "")
            .toLowerCase()
            .startsWith("application/json")
        )
          throw new TransportError("protocol");
        body = await readBounded(response, maxBytes);
      } catch (error) {
        if (controller.signal.aborted) throw new TransportError("timeout");
        if (error instanceof TransportError) throw error;
        throw new TransportError("unavailable");
      } finally {
        clearTimeout(timer);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new TransportError("protocol");
      }
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      )
        throw new TransportError("protocol");
      const keys = Object.keys(parsed);
      const record = parsed as Record<string, unknown>;
      if (keys.length !== 1 || (keys[0] !== "result" && keys[0] !== "error")) {
        const kind = statusKind(response.status);
        throw new TransportError(kind ?? "protocol");
      }
      if (keys[0] === "error") {
        const error = record.error;
        if (
          error === null ||
          typeof error !== "object" ||
          Array.isArray(error) ||
          Object.keys(error).length !== 2 ||
          typeof (error as Record<string, unknown>).code !== "string" ||
          typeof (error as Record<string, unknown>).message !== "string"
        )
          throw new TransportError("protocol");
        const kind =
          codeKind((error as { code: string }).code) ??
          statusKind(response.status) ??
          "unavailable";
        throw new TransportError(kind);
      }
      const kind = statusKind(response.status);
      if (kind) throw new TransportError(kind);
      if (response.status < 200 || response.status >= 300)
        throw new TransportError("protocol");
      return record.result;
    },
  };
}
