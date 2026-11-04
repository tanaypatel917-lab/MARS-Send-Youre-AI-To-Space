import type { ModelConfig, ProviderConfig } from "@mars/contracts";
import {
  type AdapterFactory,
  type AdapterOptions,
  createProviderAdapter,
  type ProviderAdapter,
  ProviderError,
} from "@mars/providers";
import {
  type CatalogEntry,
  type FreeTierCatalog,
  findCatalogEntry,
} from "./catalog";
import { type ExclusionOverrides, exclusionReasons } from "./exclusions";

/** Header carrying the MARS task's paid-consent state on every OmniRoute request. */
export const PAID_CONSENT_HEADER = "X-MARS-Paid-Consent";
/** Header naming the MARS policy owner so gateway logs show who decided the route. */
export const POLICY_OWNER_HEADER = "X-MARS-Policy-Owner";

export type PaidConsentState = "granted" | "absent";

export interface OmniRoutePolicyOptions {
  catalog: FreeTierCatalog;
  overrides?: ExclusionOverrides;
  /** Provider id the guard applies to; other providers pass straight through. */
  providerId?: string;
  /**
   * The MARS task's paid-consent state: a boolean, or a predicate over the
   * selected model. Default `false`: the router can reach a paid model under
   * `allowPaid: true` without an explicit selection, so `allowPaid` alone is
   * never read as task consent and every non-free route is refused.
   */
  paidConsent?: boolean | ((model: ModelConfig) => boolean);
  /** Wrapped factory; defaults to the standard provider adapters. */
  inner?: AdapterFactory;
}

export class OmniRoutePolicyError extends ProviderError {
  readonly modelKey: string;
  readonly reasons: string[];

  constructor(providerId: string, modelKey: string, reasons: string[]) {
    super(
      providerId,
      `MARS policy refused OmniRoute model "${modelKey}" without paid consent: ${reasons.join(", ")}.`,
      { retryable: false, status: 403 },
    );
    this.name = "OmniRoutePolicyError";
    this.modelKey = modelKey;
    this.reasons = reasons;
  }
}

export interface RouteDecision {
  allowed: boolean;
  consent: PaidConsentState;
  entry: CatalogEntry | undefined;
  reasons: string[];
}

/**
 * MARS-side decision for one OmniRoute route. A route is free only when its
 * catalog entry grants free access and survives the default exclusions;
 * anything else (unknown model, excluded entry, discontinued tier) needs
 * paid consent from the MARS task.
 */
export function decideOmniRouteRoute(
  catalog: FreeTierCatalog,
  modelKey: string,
  consent: PaidConsentState,
  overrides: ExclusionOverrides = {},
): RouteDecision {
  const entry = findCatalogEntry(catalog, modelKey);
  const reasons = entry
    ? exclusionReasons(entry, overrides).map(String)
    : ["not in the MARS free-tier catalog"];
  return {
    allowed: reasons.length === 0 || consent === "granted",
    consent,
    entry,
    reasons,
  };
}

export function omnirouteRequestHeaders(
  consent: PaidConsentState,
): Record<string, string> {
  return {
    [PAID_CONSENT_HEADER]: consent,
    [POLICY_OWNER_HEADER]: "mars",
  };
}

/**
 * Adapter factory that keeps MARS the policy owner in front of OmniRoute:
 * every request is checked against the catalog, carries the paid-consent
 * header, and is refused (non-retryable, so the router does not fall back
 * into a paid route) when the route is not free and consent is absent.
 */
export function createOmniRouteAdapterFactory(
  options: OmniRoutePolicyOptions,
): AdapterFactory {
  const providerId = options.providerId ?? "omniroute";
  const inner = options.inner ?? createProviderAdapter;
  const consentOption = options.paidConsent ?? false;
  const paidConsent = (model: ModelConfig) =>
    typeof consentOption === "function" ? consentOption(model) : consentOption;
  return (provider: ProviderConfig, adapterOptions?: AdapterOptions) => {
    if (provider.id !== providerId) return inner(provider, adapterOptions);
    const adapterFor = (model: ModelConfig): ProviderAdapter => {
      const consent: PaidConsentState = paidConsent(model)
        ? "granted"
        : "absent";
      const decision = decideOmniRouteRoute(
        options.catalog,
        model.model,
        consent,
        options.overrides,
      );
      if (!decision.allowed)
        throw new OmniRoutePolicyError(
          provider.id,
          model.model,
          decision.reasons,
        );
      return inner(provider, {
        ...adapterOptions,
        headers: {
          ...adapterOptions?.headers,
          ...omnirouteRequestHeaders(consent),
        },
      });
    };
    return {
      complete: (request, model) => adapterFor(model).complete(request, model),
      async *stream(request, model) {
        yield* adapterFor(model).stream(request, model);
      },
      listModels: () =>
        inner(provider, {
          ...adapterOptions,
          headers: {
            ...adapterOptions?.headers,
            ...omnirouteRequestHeaders("absent"),
          },
        }).listModels?.() ?? Promise.resolve([]),
    };
  };
}
