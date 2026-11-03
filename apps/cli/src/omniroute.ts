import {
  type CatalogHealth,
  catalogHealth,
  type ExclusionOverrides,
  type FetchLike,
  loadFreeTierCatalog,
  OMNIROUTE_API_KEY_ENV,
  OMNIROUTE_DEFAULT_URL,
  OMNIROUTE_PIN,
  type OmniRouteProbe,
  omnirouteBaseUrl,
  probeOmniRoute,
} from "@mars/providers-omniroute";
import type { WorkbenchOmniRouteOptions } from "@mars/workbench";
import { ServeUsageError } from "./serve-errors";

/** `--omniroute-allow` values; everything is excluded unless listed. */
export const OMNIROUTE_ALLOW_VALUES = [
  "web-session",
  "browser-session",
  "caution",
  "ambiguous",
  "unknown",
] as const;
export type OmniRouteAllowValue = (typeof OMNIROUTE_ALLOW_VALUES)[number];

export interface OmniRouteFlags {
  enabled?: boolean;
  url?: string;
  start?: boolean;
  allow?: string[];
}

export function omnirouteOverrides(allow: string[]): ExclusionOverrides {
  const overrides: ExclusionOverrides = {};
  const termsRisk: Exclude<ExclusionOverrides["allowTermsRisk"], undefined> =
    [];
  for (const value of allow) {
    switch (value as OmniRouteAllowValue) {
      case "web-session":
        overrides.allowWebSession = true;
        break;
      case "browser-session":
        overrides.allowBrowserSession = true;
        break;
      case "caution":
      case "ambiguous":
      case "unknown":
        termsRisk.push(value as "caution" | "ambiguous" | "unknown");
        break;
      default:
        throw new ServeUsageError(
          `Unknown --omniroute-allow value "${value}"; expected one of ${OMNIROUTE_ALLOW_VALUES.join(", ")} (avoid can never be allowed).`,
        );
    }
  }
  if (termsRisk.length) overrides.allowTermsRisk = termsRisk;
  return overrides;
}

/** Builds the OmniRoute service options from CLI flags; nothing here is a credential. */
export function omnirouteFromFlags(
  flags: OmniRouteFlags,
): WorkbenchOmniRouteOptions | undefined {
  if (!flags.enabled) {
    for (const [flag, value] of Object.entries({
      "--omniroute-url": flags.url,
      "--omniroute-start": flags.start,
      "--omniroute-allow": flags.allow,
    })) {
      if (value !== undefined && value !== false)
        throw new ServeUsageError(`${flag} requires --omniroute.`);
    }
    return undefined;
  }
  const url = flags.url ?? OMNIROUTE_DEFAULT_URL;
  try {
    omnirouteBaseUrl(url);
  } catch (error) {
    throw new ServeUsageError(
      `--omniroute-url must be http://LOOPBACK[:PORT] or https://HOST[:PORT] (optionally ending in /v1): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const overrides = omnirouteOverrides(flags.allow ?? []);
  return {
    url,
    ...(flags.start ? { start: true } : {}),
    ...(Object.keys(overrides).length ? { overrides } : {}),
  };
}

export interface OmniRouteDoctorReport {
  package: string;
  pinned_release: string;
  default_url: string;
  enabled_by: string;
  api_key_env: string;
  gateway: OmniRouteProbe;
  catalog: CatalogHealth;
  default_exclusions: string[];
  mcp_a2a_used: false;
  compression: "off (unverified; not exposed)";
  live_verified: false;
}

/** Booleans, counts and ages only; one GET /v1/models, no model request. */
export async function omnirouteDoctorReport(
  options: {
    env?: Record<string, string | undefined>;
    url?: string;
    fetch?: FetchLike;
    now?: Date;
    catalogPath?: string;
  } = {},
): Promise<OmniRouteDoctorReport> {
  const env = options.env ?? process.env;
  const url = options.url ?? env.MARS_OMNIROUTE_URL ?? OMNIROUTE_DEFAULT_URL;
  const [gateway, catalog] = await Promise.all([
    probeOmniRoute({
      url,
      env,
      timeoutMs: 1_500,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    }),
    loadFreeTierCatalog(options.catalogPath).catch(() => undefined),
  ]);
  return {
    package: "@mars/providers-omniroute",
    pinned_release: OMNIROUTE_PIN.release,
    default_url: OMNIROUTE_DEFAULT_URL,
    enabled_by:
      "mars serve --omniroute [--omniroute-url URL] [--omniroute-start]",
    api_key_env: OMNIROUTE_API_KEY_ENV,
    gateway,
    catalog: catalogHealth(catalog, options.now ? { now: options.now } : {}),
    default_exclusions: [
      "web-session providers (ChatGPT Web, Claude Web, Grok Web, Gemini Web and every other web-cookie login)",
      "browser-session providers (anonymous or reverse-engineered browser transports)",
      "terms verdicts caution, ambiguous, unknown (opt-in) and avoid (never)",
      "discontinued free tiers",
      "OmniRoute MCP and A2A endpoints",
      "RTK/Caveman compression",
    ],
    mcp_a2a_used: false,
    compression: "off (unverified; not exposed)",
    live_verified: false,
  };
}
