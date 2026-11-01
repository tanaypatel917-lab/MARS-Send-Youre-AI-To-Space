import { lookup } from "node:dns/promises";
import { canonicalizeUrl } from "./url";

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;
export type HostResolver = (hostname: string) => Promise<string[]>;

export const defaultHostResolver: HostResolver = async (hostname) =>
  (await lookup(hostname, { all: true })).map((entry) => entry.address);

const BLOCKED_HOSTS = new Set(["localhost"]);
const BLOCKED_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".home.arpa",
  ".onion",
];

function parseIpv4(address: string): number[] | undefined {
  const parts = address.split(".");
  if (parts.length !== 4) return undefined;
  const octets = parts.map((part) =>
    /^\d{1,3}$/.test(part) ? Number(part) : Number.NaN,
  );
  return octets.every((octet) => Number.isInteger(octet) && octet <= 255)
    ? octets
    : undefined;
}

function ipv4Private(octets: number[]): boolean {
  const [a = 0, b = 0, c = 0] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function parseIpv6(address: string): number[] | undefined {
  let text = address.replace(/^\[|\]$/g, "").split("%")[0] ?? "";
  if (!/^[0-9a-f:.]+$/i.test(text)) return undefined;
  let tail: number[] = [];
  const v4 = text.match(/([0-9]{1,3}(?:\.[0-9]{1,3}){3})$/);
  if (v4?.[1]) {
    const octets = parseIpv4(v4[1]);
    if (!octets) return undefined;
    tail = [
      ((octets[0] ?? 0) << 8) | (octets[1] ?? 0),
      ((octets[2] ?? 0) << 8) | (octets[3] ?? 0),
    ];
    text = text.slice(0, -v4[1].length);
    if (text.endsWith(":") && !text.endsWith("::")) text = text.slice(0, -1);
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const parse = (segment: string): number[] | undefined => {
    if (segment === "") return [];
    const groups = segment.split(":");
    const values = groups.map((group) =>
      /^[0-9a-f]{1,4}$/i.test(group) ? Number.parseInt(group, 16) : Number.NaN,
    );
    return values.every((value) => Number.isInteger(value))
      ? values
      : undefined;
  };
  const head = parse(halves[0] ?? "");
  const rest = halves.length === 2 ? parse(halves[1] ?? "") : [];
  if (!head || !rest) return undefined;
  const total = head.length + rest.length + tail.length;
  if (halves.length === 2) {
    if (total > 7) return undefined;
    return [...head, ...new Array(8 - total).fill(0), ...rest, ...tail];
  }
  return total === 8 ? [...head, ...rest, ...tail] : undefined;
}

export function isPrivateAddress(address: string): boolean {
  const v4 = parseIpv4(address);
  if (v4) return ipv4Private(v4);
  const v6 = parseIpv6(address);
  if (!v6) return true;
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = v6;
  const leading = g0 | g1 | g2 | g3 | g4;
  if (leading === 0 && g5 === 0xffff) {
    return ipv4Private([g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff]);
  }
  if (leading === 0 && g5 === 0) return true;
  if (g0 === 0x64 && g1 === 0xff9b) return true;
  if ((g0 & 0xfe00) === 0xfc00) return true;
  if ((g0 & 0xffc0) === 0xfe80) return true;
  if ((g0 & 0xff00) === 0xff00) return true;
  if (g0 === 0x2001 && g1 === 0x0db8) return true;
  if (g0 === 0x2002) {
    return ipv4Private([g1 >> 8, g1 & 0xff, g2 >> 8, g2 & 0xff]);
  }
  return false;
}

export function hostnameBlocked(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (
    host === "" ||
    BLOCKED_HOSTS.has(host) ||
    BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
  ) {
    return true;
  }
  if (host.startsWith("[") || parseIpv4(host)) return isPrivateAddress(host);
  return false;
}

export type FetchBlockReason =
  | "invalid_url"
  | "host_denied"
  | "private_address"
  | "unresolvable_host"
  | "too_many_redirects"
  | "http_status"
  | "unsupported_media_type"
  | "too_large"
  | "network_error";

export type GuardedFetchResult =
  | {
      ok: true;
      url: string;
      status: number;
      media_type: string;
      data: Uint8Array;
    }
  | { ok: false; url: string; reason: FetchBlockReason; status?: number };

export interface GuardedFetchOptions {
  fetch: FetchLike;
  resolve: HostResolver;
  signal: AbortSignal;
  maxBytes: number;
  maxRedirects: number;
  timeoutMs: number;
  userAgent: string;
  allowHost: (hostname: string) => boolean;
  acceptMediaType: (mediaType: string) => boolean;
}

export function mediaTypeOf(contentType: string | null): string {
  const value = (contentType ?? "application/octet-stream")
    .split(";")[0]
    ?.trim()
    .toLowerCase();
  return value && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(value)
    ? value
    : "application/octet-stream";
}

export type HostVerdict = "public" | "private" | "unresolvable";

export async function classifyHost(
  hostname: string,
  resolve: HostResolver,
): Promise<HostVerdict> {
  if (hostnameBlocked(hostname)) return "private";
  const literal = hostname.startsWith("[") || parseIpv4(hostname);
  if (literal) return isPrivateAddress(hostname) ? "private" : "public";
  let addresses: string[];
  try {
    addresses = await resolve(hostname);
  } catch {
    return "unresolvable";
  }
  if (addresses.length === 0) return "unresolvable";
  return addresses.some((address) => isPrivateAddress(address))
    ? "private"
    : "public";
}

async function readBounded(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array | undefined> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    return undefined;
  }
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    signal.throwIfAborted();
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export async function guardedFetch(
  input: string,
  options: GuardedFetchOptions,
): Promise<GuardedFetchResult> {
  let current = input;
  for (let hop = 0; hop <= options.maxRedirects; hop += 1) {
    const url = canonicalizeUrl(current);
    if (!url) return { ok: false, url: current, reason: "invalid_url" };
    const { hostname } = new URL(url);
    if (!options.allowHost(hostname)) {
      return { ok: false, url, reason: "host_denied" };
    }
    const verdict = await classifyHost(hostname, options.resolve);
    if (verdict !== "public") {
      return {
        ok: false,
        url,
        reason: verdict === "private" ? "private_address" : "unresolvable_host",
      };
    }
    options.signal.throwIfAborted();
    const signal = AbortSignal.any([
      options.signal,
      AbortSignal.timeout(Math.max(1, options.timeoutMs)),
    ]);
    let response: Response;
    try {
      response = await options.fetch(url, {
        method: "GET",
        redirect: "manual",
        signal,
        headers: {
          "user-agent": options.userAgent,
          accept: "text/html, text/plain;q=0.9, */*;q=0.1",
        },
      });
    } catch (error) {
      options.signal.throwIfAborted();
      if (error instanceof Error && error.name === "AbortError") throw error;
      return { ok: false, url, reason: "network_error" };
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => {});
      if (!location) {
        return {
          ok: false,
          url,
          reason: "http_status",
          status: response.status,
        };
      }
      try {
        current = new URL(location, url).toString();
      } catch {
        return { ok: false, url, reason: "invalid_url" };
      }
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel().catch(() => {});
      return { ok: false, url, reason: "http_status", status: response.status };
    }
    const mediaType = mediaTypeOf(response.headers.get("content-type"));
    if (!options.acceptMediaType(mediaType)) {
      await response.body?.cancel().catch(() => {});
      return { ok: false, url, reason: "unsupported_media_type" };
    }
    const data = await readBounded(response, options.maxBytes, options.signal);
    if (!data) return { ok: false, url, reason: "too_large" };
    return {
      ok: true,
      url,
      status: response.status,
      media_type: mediaType,
      data,
    };
  }
  return { ok: false, url: current, reason: "too_many_redirects" };
}
