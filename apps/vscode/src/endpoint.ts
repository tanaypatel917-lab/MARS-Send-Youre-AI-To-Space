export type EndpointCheck =
  | { ok: true; rpcUrl: string; origin: string; loopback: boolean }
  | { ok: false; reason: string };

export const DEFAULT_SERVER_URL = "http://127.0.0.1:7331";

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "[::1]") return true;
  const parts = host.split(".");
  if (parts.length !== 4 || parts[0] !== "127") return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/**
 * Validates the configured server URL. Loopback HTTP(S) is accepted; any other
 * host requires both the explicit opt-in setting and HTTPS. Credentials,
 * query strings and fragments are rejected so the bearer token can only be
 * sent to `<origin><path>/v1/rpc`.
 */
export function checkServerUrl(
  raw: string,
  allowNonLoopback: boolean,
): EndpointCheck {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "Server URL is not a valid URL." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return { ok: false, reason: "Server URL must use http or https." };
  if (url.username || url.password)
    return { ok: false, reason: "Server URL must not contain credentials." };
  if (url.search || url.hash)
    return {
      ok: false,
      reason: "Server URL must not contain a query or fragment.",
    };
  const loopback = isLoopbackHost(url.hostname);
  if (!loopback) {
    if (!allowNonLoopback)
      return {
        ok: false,
        reason:
          "Non-loopback servers are blocked. Enable mars.allowNonLoopbackServer in user settings to allow one.",
      };
    if (url.protocol !== "https:")
      return { ok: false, reason: "Non-loopback servers must use https." };
  }
  const path = url.pathname.replace(/\/+$/, "");
  return {
    ok: true,
    origin: url.origin,
    rpcUrl: `${url.origin}${path}/v1/rpc`,
    loopback,
  };
}
