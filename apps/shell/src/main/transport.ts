import type { BridgeErrorKind } from "../shared/methods";
import { isLoopbackHost } from "./connection";

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
  constructor(
    readonly kind: BridgeErrorKind,
    message: string,
  ) {
    super(message);
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
    throw new TransportError("refused", "Workbench connection URL is invalid.");
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
    throw new TransportError(
      "refused",
      "Workbench connection must be loopback HTTP.",
    );
  return url.origin;
}

async function readBounded(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes)
    throw new TransportError("protocol", "Workbench response is too large.");
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes)
      throw new TransportError("protocol", "Workbench response is too large.");
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new TransportError("protocol", "Workbench response is malformed.");
    }
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new TransportError(
          "protocol",
          "Workbench response is too large.",
        );
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    if (error instanceof TransportError) throw error;
    throw new TransportError("protocol", "Workbench response is malformed.");
  } finally {
    reader.releaseLock();
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
  if (code === "unavailable" || code === "model_unavailable")
    return "unavailable";
  return undefined;
}

const ERROR_MESSAGES: Record<BridgeErrorKind, string> = {
  not_connected: "Not connected to a workbench.",
  refused: "Workbench request was refused.",
  unauthorized: "Workbench authentication failed.",
  forbidden: "Workbench request is not permitted.",
  not_found: "Workbench resource was not found.",
  conflict: "Workbench request conflicts with the current state.",
  timeout: "Workbench did not respond in time.",
  unavailable: "Workbench is unavailable.",
  protocol: "Workbench returned an invalid response.",
  invalid_response: "Workbench returned an invalid response.",
  hash_mismatch: "Workbench artifact failed integrity verification.",
};

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
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
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
          throw new TransportError("protocol", ERROR_MESSAGES.protocol);
        body = await readBounded(response, maxBytes);
      } catch (error) {
        if (error instanceof TransportError) throw error;
        if (timedOut)
          throw new TransportError("timeout", ERROR_MESSAGES.timeout);
        throw new TransportError("unavailable", ERROR_MESSAGES.unavailable);
      } finally {
        clearTimeout(timer);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new TransportError("protocol", ERROR_MESSAGES.protocol);
      }
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      )
        throw new TransportError("protocol", ERROR_MESSAGES.protocol);
      const keys = Object.keys(parsed);
      const record = parsed as Record<string, unknown>;
      if (keys.length !== 1 || (keys[0] !== "result" && keys[0] !== "error")) {
        const kind = statusKind(response.status);
        throw new TransportError(
          kind ?? "protocol",
          kind ? ERROR_MESSAGES[kind] : ERROR_MESSAGES.protocol,
        );
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
          throw new TransportError("protocol", ERROR_MESSAGES.protocol);
        const kind =
          codeKind((error as { code: string }).code) ??
          statusKind(response.status) ??
          "unavailable";
        throw new TransportError(kind, ERROR_MESSAGES[kind]);
      }
      const kind = statusKind(response.status);
      if (kind) throw new TransportError(kind, ERROR_MESSAGES[kind]);
      if (response.status < 200 || response.status >= 300)
        throw new TransportError("protocol", ERROR_MESSAGES.protocol);
      return record.result;
    },
  };
}
