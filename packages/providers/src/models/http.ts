import type { ChatResponse, ChatToolCall } from "@mars/contracts";
import type { AdapterOptions } from "./adapter-types";
import { ProviderError } from "./errors";

export type JsonObject = Record<string, unknown>;

type Fetcher = NonNullable<AdapterOptions["fetch"]>;

export function asObject(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function unexpectedResponseShape(providerId: string): ProviderError {
  return new ProviderError(
    providerId,
    "Provider returned an unexpected response shape.",
    { retryable: false },
  );
}

/** A token count is reported only when it is an integer; otherwise it is unknown. */
export function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : undefined;
}

/** Reads `{ inputTokens, outputTokens }` from a usage object, or nothing unless both counts are reported. */
export function usageFrom(
  raw: unknown,
  inputKey: string,
  outputKey: string,
): ChatResponse["usage"] {
  const usage = asObject(raw);
  const inputTokens = tokenCount(usage[inputKey]);
  const outputTokens = tokenCount(usage[outputKey]);
  return inputTokens !== undefined && outputTokens !== undefined
    ? { inputTokens, outputTokens }
    : undefined;
}

/*
 * Tool-call policy shared by every adapter in both complete and stream mode:
 * a tool call needs a non-empty string id and name, and its arguments must be
 * a JSON object (an empty argument string means `{}`). A call that breaks
 * either rule fails the request with a non-retryable ProviderError; it is
 * never dropped, coerced to `{}`, or given a synthesized id.
 */

/** Decodes a JSON tool-argument string into an object, per the tool-call policy. */
export function parseToolArguments(
  raw: string,
  providerId: string,
): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw || "{}");
  } catch {
    parsed = undefined;
  }
  if (isJsonObject(parsed)) return parsed;
  throw new ProviderError(
    providerId,
    "Provider returned invalid tool arguments.",
    { retryable: false },
  );
}

/** Validates a decoded tool call against the tool-call policy. */
export function requireToolCall(
  call: { id: unknown; name: unknown; arguments: unknown },
  providerId: string,
): ChatToolCall {
  const { id, name } = call;
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    typeof name !== "string" ||
    name.length === 0
  ) {
    throw new ProviderError(
      providerId,
      "Provider returned a tool call without an id or name.",
      { retryable: false },
    );
  }
  if (!isJsonObject(call.arguments)) {
    throw new ProviderError(
      providerId,
      "Provider returned invalid tool arguments.",
      { retryable: false },
    );
  }
  return { id, name, arguments: call.arguments };
}

export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const timestamp = Date.parse(header);
  return Number.isNaN(timestamp)
    ? undefined
    : Math.max(0, timestamp - Date.now());
}

export function isRetryableStatus(status: number | undefined): boolean {
  return (
    status === 408 || status === 429 || (status !== undefined && status >= 500)
  );
}

function statusFromLabel(label: string): number | undefined {
  const normalized = label.toLowerCase();
  if (/rate.?limit|too.?many.?requests|quota/.test(normalized)) return 429;
  if (/timeout|timed.?out/.test(normalized)) return 408;
  if (/overload/.test(normalized)) return 529;
  if (/server|internal|unavailable/.test(normalized)) return 500;
  return undefined;
}

/** Maps a provider error envelope to an HTTP-like status: `status`, then `code`, then `type`. */
export function envelopeStatus(error: JsonObject): number | undefined {
  const status = error.status;
  if (typeof status === "number" && Number.isInteger(status)) return status;
  if (typeof status === "string" && /^\d{3}$/.test(status))
    return Number(status);
  const code = error.code;
  if (typeof code === "number" && Number.isInteger(code)) return code;
  if (typeof code === "string") {
    if (/^\d{3}$/.test(code)) return Number(code);
    const fromCode = statusFromLabel(code);
    if (fromCode !== undefined) return fromCode;
  }
  return typeof error.type === "string"
    ? statusFromLabel(error.type)
    : undefined;
}

export function hasErrorEnvelope(payload: JsonObject): boolean {
  return (
    Object.hasOwn(payload, "error") &&
    payload.error !== null &&
    typeof payload.error === "object"
  );
}

export function providerEnvelopeError(
  providerId: string,
  error: JsonObject,
): ProviderError {
  const status = envelopeStatus(error);
  return new ProviderError(
    providerId,
    `Provider returned an error envelope${status ? ` (HTTP ${status})` : ""}.`,
    {
      ...(status !== undefined ? { status } : {}),
      retryable: isRetryableStatus(status),
    },
  );
}

export interface ProviderRequest {
  providerId: string;
  fetch: Fetcher;
  url: string;
  headers: Headers;
  body?: JsonObject;
  timeoutMs: number;
}

export interface ProviderResponse {
  response: Response;
  signal: AbortSignal;
  /** Clears the request timeout; call once the body has been consumed. */
  cleanup: () => void;
}

/** Sends a request whose timeout covers the response body until `cleanup`. */
export async function sendProviderRequest(
  request: ProviderRequest,
): Promise<ProviderResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);
  try {
    const response = await request.fetch(request.url, {
      method: request.body ? "POST" : "GET",
      headers: request.headers,
      ...(request.body ? { body: JSON.stringify(request.body) } : {}),
      signal: controller.signal,
    });
    return {
      response,
      signal: controller.signal,
      cleanup: () => clearTimeout(timer),
    };
  } catch {
    clearTimeout(timer);
    throw new ProviderError(
      request.providerId,
      "Provider network request failed or timed out.",
      { retryable: true, timedOut: controller.signal.aborted },
    );
  }
}

export function assertOk(providerId: string, response: Response): void {
  if (response.ok) return;
  const retryable = isRetryableStatus(response.status);
  const retryAfterMs = retryable
    ? parseRetryAfter(response.headers.get("retry-after"))
    : undefined;
  throw new ProviderError(
    providerId,
    `Provider returned HTTP ${response.status}.`,
    {
      status: response.status,
      retryable,
      definitelyNoGeneration: response.status === 429,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    },
  );
}

export async function readJson(
  providerId: string,
  response: Response,
  signal: AbortSignal,
): Promise<JsonObject> {
  try {
    return asObject(await response.json());
  } catch {
    if (signal.aborted) {
      throw new ProviderError(providerId, "Provider request timed out.", {
        retryable: true,
        timedOut: true,
      });
    }
    throw new ProviderError(providerId, "Provider returned invalid JSON.", {
      status: response.status,
      retryable: false,
    });
  }
}

export function streamBody(
  providerId: string,
  response: Response,
): ReadableStream<Uint8Array> {
  if (!response.body) {
    throw new ProviderError(
      providerId,
      "Provider response had no stream body.",
      { retryable: false },
    );
  }
  return response.body;
}

export function parseSseJson(providerId: string, data: string): JsonObject {
  try {
    return asObject(JSON.parse(data));
  } catch {
    throw new ProviderError(providerId, "Provider returned invalid SSE JSON.", {
      retryable: false,
    });
  }
}

/**
 * Wraps a non-provider failure raised while reading a stream. Once text has
 * been emitted to the caller a retry would duplicate output, so the failure is
 * only retryable before the first delta (matching the router's `emitted` guard).
 */
export function streamFailure(
  providerId: string,
  cause: unknown,
  emittedContent: boolean,
  timedOut = false,
): ProviderError {
  if (cause instanceof ProviderError) return cause;
  return new ProviderError(providerId, "Provider stream failed or timed out.", {
    retryable: !emittedContent,
    timedOut,
  });
}

export interface SseFrame {
  event: string;
  data: string;
}

export async function* readSseFrames(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "";
  let dataLines: string[] = [];
  const processLine = (rawLine: string): SseFrame | undefined => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line) {
      const frame =
        dataLines.length > 0
          ? { event: eventName, data: dataLines.join("\n") }
          : undefined;
      eventName = "";
      dataLines = [];
      return frame;
    }
    if (line.startsWith(":")) return undefined;
    if (line.startsWith("event:")) {
      eventName = line.slice(6).replace(/^ /, "");
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    return undefined;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done
        ? decoder.decode()
        : decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const frame = processLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (frame) yield frame;
        newline = buffer.indexOf("\n");
      }
      if (done) break;
    }
    if (buffer) {
      const frame = processLine(buffer);
      if (frame) yield frame;
    }
    if (dataLines.length > 0) {
      yield { event: eventName, data: dataLines.join("\n") };
    }
  } finally {
    reader.releaseLock();
  }
}
