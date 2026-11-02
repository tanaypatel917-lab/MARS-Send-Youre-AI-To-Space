function hasUnsafeCharacters(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x21 || code === 0x7f) return true;
  }
  return false;
}

const TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$|ref$)/i;

export function canonicalizeUrl(input: string): string | undefined {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.username || url.password) return undefined;
  if (hasUnsafeCharacters(input)) return undefined;
  url.hash = "";
  url.hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  if (
    (url.protocol === "http:" && url.port === "80") ||
    (url.protocol === "https:" && url.port === "443")
  ) {
    url.port = "";
  }
  return url.toString();
}

export function hostMatches(hostname: string, pattern: string): boolean {
  const host = hostname.toLowerCase();
  const rule = pattern.toLowerCase();
  if (rule.startsWith("*.")) {
    const suffix = rule.slice(1);
    return host.endsWith(suffix) || host === rule.slice(2);
  }
  return host === rule;
}

export function hostAllowed(
  hostname: string,
  allow: readonly string[] | undefined,
  deny: readonly string[],
): boolean {
  if (deny.some((rule) => hostMatches(hostname, rule))) return false;
  if (allow === undefined) return true;
  return allow.some((rule) => hostMatches(hostname, rule));
}
