import type { ModelConfig, RequestContext, VersionRef } from "@mars/contracts";
import { sameJson } from "./canonical";
import type {
  AcceptancePolicy,
  ReasonCode,
  RoutingRequest,
  SelectedTarget,
  ServingBinding,
  SpecialistRegistration,
} from "./schemas";

export interface ModelCatalog {
  readonly policy: { allowPaid: boolean };
  getModel(id: string): ModelConfig | undefined;
  unavailableReason(providerId: string): string | undefined;
}

export interface ServingAttestation {
  model_id: string;
  provider_id: string;
  provider_model: string;
  base_model: VersionRef;
  tokenizer: VersionRef;
  chat_template_sha256: string;
  adapter_formats: string[];
  loaded_adapter_sha256s: string[];
}

export interface ServingAttestor {
  attest(
    context: RequestContext,
    binding: ServingBinding,
  ): Promise<ServingAttestation | null>;
}

export interface BindingCompatibility {
  binding: ServingBinding;
  model?: ModelConfig;
  reasons: ReasonCode[];
  serving_attestation: "verified" | "absent";
  cost_basis: SelectedTarget["cost_basis"];
  cost_usd_per_task: number | null;
  runtime_ms_p95: number | null;
}

export interface CompatibilityOptions {
  catalog: ModelCatalog;
  servingAttestor?: ServingAttestor;
}

export interface ServingReadiness {
  binding: ServingBinding;
  model?: ModelConfig;
  reasons: ReasonCode[];
  serving_attestation: "verified" | "absent";
}

function addCapabilityReasons(
  model: ModelConfig,
  request: RoutingRequest,
  reasons: Set<ReasonCode>,
) {
  if (request.requires.tools && !model.capabilities.tools)
    reasons.add("capability_tools");
  if (request.requires.vision && !model.capabilities.vision)
    reasons.add("capability_vision");
  if (request.requires.reasoning && model.capabilities.reasoning !== true)
    reasons.add("capability_reasoning");
  if (model.capabilities.contextWindow < request.requires.min_context_tokens)
    reasons.add("capability_context");
}

function addAttestationReasons(
  attestation: ServingAttestation,
  registration: SpecialistRegistration,
  binding: ServingBinding,
  reasons: Set<ReasonCode>,
  checkBinding: boolean,
) {
  if (
    checkBinding &&
    (attestation.model_id !== binding.model_id ||
      attestation.provider_id !== binding.provider_id ||
      attestation.provider_model !== binding.provider_model)
  ) {
    reasons.add("model_binding_mismatch");
  }
  if (!sameJson(attestation.base_model, registration.base_model))
    reasons.add("serving_base_mismatch");
  if (!sameJson(attestation.tokenizer, registration.tokenizer))
    reasons.add("serving_tokenizer_mismatch");
  if (attestation.chat_template_sha256 !== registration.chat_template.sha256) {
    reasons.add("serving_chat_template_mismatch");
  }
  if (registration.adapter) {
    const format = registration.profile.adapter_spec?.format;
    if (!format || !attestation.adapter_formats.includes(format))
      reasons.add("serving_adapter_unsupported");
    if (
      !attestation.loaded_adapter_sha256s.includes(registration.adapter.sha256)
    ) {
      reasons.add("serving_adapter_not_loaded");
    }
  }
}

export async function checkSpecialistBindings(
  context: RequestContext,
  registration: SpecialistRegistration,
  request: RoutingRequest,
  gate: {
    cost_usd_per_task: number | null;
    runtime_ms_p95: number | null;
  },
  options: CompatibilityOptions,
): Promise<BindingCompatibility[]> {
  const output: BindingCompatibility[] = [];
  for (const binding of registration.profile.serving) {
    const reasons = new Set<ReasonCode>();
    const model = options.catalog.getModel(binding.model_id);
    let servingAttestation: "verified" | "absent" = "absent";
    let costBasis: SelectedTarget["cost_basis"] = "measured";
    if (!model) {
      reasons.add("model_not_configured");
    } else {
      if (
        model.providerId !== binding.provider_id ||
        model.model !== binding.provider_model
      ) {
        reasons.add("model_binding_mismatch");
      }
      if (registration.adapter) {
        if (!options.servingAttestor) {
          reasons.add("serving_unattested");
        } else {
          let attestation: ServingAttestation | null = null;
          try {
            attestation = await options.servingAttestor.attest(
              context,
              binding,
            );
          } catch {
            attestation = null;
          }
          if (!attestation) {
            reasons.add("serving_unattested");
          } else {
            servingAttestation = "verified";
            addAttestationReasons(
              attestation,
              registration,
              binding,
              reasons,
              true,
            );
          }
        }
      } else if (options.servingAttestor) {
        let attestation: ServingAttestation | null = null;
        try {
          attestation = await options.servingAttestor.attest(context, binding);
        } catch {
          attestation = null;
        }
        if (attestation) {
          servingAttestation = "verified";
          addAttestationReasons(
            attestation,
            registration,
            binding,
            reasons,
            true,
          );
        }
      }
      addCapabilityReasons(model, request, reasons);
      if (options.catalog.unavailableReason(binding.provider_id) !== undefined)
        reasons.add("provider_unavailable");

      if (model.pricing.free) {
        costBasis = gate.cost_usd_per_task === null ? "free" : "measured";
        if (
          gate.cost_usd_per_task !== null &&
          gate.cost_usd_per_task > request.budget.max_usd
        ) {
          reasons.add("budget_cost_exceeded");
        }
      } else {
        if (!options.catalog.policy.allowPaid) reasons.add("paid_not_allowed");
        if (!request.paid_consent) reasons.add("paid_consent_missing");
        if (
          model.pricing.inputPerMTokUsd === undefined ||
          model.pricing.outputPerMTokUsd === undefined
        ) {
          reasons.add("pricing_unknown");
        }
        if (gate.cost_usd_per_task === null) {
          reasons.add("pricing_unknown");
        } else if (gate.cost_usd_per_task > request.budget.max_usd) {
          reasons.add("budget_cost_exceeded");
        }
      }
      if (
        gate.runtime_ms_p95 !== null &&
        gate.runtime_ms_p95 > request.budget.max_duration_ms
      ) {
        reasons.add("budget_runtime_exceeded");
      }
      if (
        registration.profile.acceptance.max_cost_usd_per_task !== null &&
        gate.cost_usd_per_task === null
      ) {
        reasons.add("cost_unmeasured");
      }
      if (
        registration.profile.acceptance.max_runtime_ms_p95 !== null &&
        gate.runtime_ms_p95 === null
      ) {
        reasons.add("runtime_unmeasured");
      }
    }
    output.push({
      binding,
      ...(model ? { model } : {}),
      reasons: [...reasons].sort(),
      serving_attestation: servingAttestation,
      cost_basis: costBasis,
      cost_usd_per_task: gate.cost_usd_per_task,
      runtime_ms_p95: gate.runtime_ms_p95,
    });
  }
  return output;
}

export async function checkServingReadiness(
  context: RequestContext,
  registration: SpecialistRegistration,
  options: CompatibilityOptions,
): Promise<ServingReadiness[]> {
  const output: ServingReadiness[] = [];
  for (const binding of registration.profile.serving) {
    const reasons = new Set<ReasonCode>();
    const model = options.catalog.getModel(binding.model_id);
    let serving_attestation: ServingReadiness["serving_attestation"] = "absent";
    if (!model) {
      reasons.add("model_not_configured");
    } else if (
      model.providerId !== binding.provider_id ||
      model.model !== binding.provider_model
    ) {
      reasons.add("model_binding_mismatch");
    }
    if (model && (registration.adapter || options.servingAttestor)) {
      let attestation: ServingAttestation | null = null;
      try {
        attestation =
          (await options.servingAttestor?.attest(context, binding)) ?? null;
      } catch {
        attestation = null;
      }
      if (!attestation) {
        if (registration.adapter) reasons.add("serving_unattested");
      } else {
        serving_attestation = "verified";
        addAttestationReasons(
          attestation,
          registration,
          binding,
          reasons,
          true,
        );
      }
    } else if (registration.adapter) {
      reasons.add("serving_unattested");
    }
    output.push({
      binding,
      ...(model ? { model } : {}),
      reasons: [...reasons].sort(),
      serving_attestation,
    });
  }
  return output;
}

export function compatibleBase(
  registration: SpecialistRegistration,
  servingBase: VersionRef,
): boolean {
  return sameJson(registration.base_model, servingBase);
}

export function baselineCompatibility(
  binding: Pick<ServingBinding, "model_id" | "provider_id" | "provider_model">,
  catalog: ModelCatalog,
  request: RoutingRequest,
): BindingCompatibility {
  const reasons = new Set<ReasonCode>();
  const model = catalog.getModel(binding.model_id);
  let costBasis: SelectedTarget["cost_basis"] = "free";
  let cost: number | null = 0;
  if (!model) {
    reasons.add("model_not_configured");
    cost = null;
  } else {
    if (
      model.providerId !== binding.provider_id ||
      model.model !== binding.provider_model
    ) {
      reasons.add("model_binding_mismatch");
    }
    addCapabilityReasons(model, request, reasons);
    if (catalog.unavailableReason(binding.provider_id) !== undefined)
      reasons.add("provider_unavailable");
    if (!model.pricing.free) {
      costBasis = "configured_price_upper_bound";
      if (!catalog.policy.allowPaid) reasons.add("paid_not_allowed");
      if (!request.paid_consent) reasons.add("paid_consent_missing");
      if (
        model.pricing.inputPerMTokUsd === undefined ||
        model.pricing.outputPerMTokUsd === undefined
      ) {
        reasons.add("pricing_unknown");
        cost = null;
      } else {
        cost =
          (request.budget.max_tokens *
            Math.max(
              model.pricing.inputPerMTokUsd,
              model.pricing.outputPerMTokUsd,
            )) /
          1_000_000;
        if (cost > request.budget.max_usd) reasons.add("budget_cost_exceeded");
      }
    }
  }
  return {
    binding: binding as ServingBinding,
    ...(model ? { model } : {}),
    reasons: [...reasons].sort(),
    serving_attestation: "absent",
    cost_basis: costBasis,
    cost_usd_per_task: cost,
    runtime_ms_p95: null,
  };
}

export function firstPassingBinding(
  bindings: BindingCompatibility[],
): BindingCompatibility | undefined {
  return bindings.find((binding) => binding.reasons.length === 0);
}

export function acceptancePolicy(
  registration: SpecialistRegistration,
): AcceptancePolicy {
  return registration.profile.acceptance;
}
