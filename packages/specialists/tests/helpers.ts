import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ArtifactRef,
  ModelConfig,
  RequestContext,
  Scope,
} from "@mars/contracts";
import {
  type ArtifactLoader,
  type BaselineProfile,
  candidateDigest,
  canonicalJson,
  createHmacEvidenceSigner,
  createHmacEvidenceVerifier,
  type EvidenceVerifier,
  type ModelCatalog,
  type RoutingRequest,
  type SpecialistRegistration,
  SpecialistRegistry,
  type SpecialistRegistryOptions,
  sha256,
} from "../src/index";
import type { EvaluationReport } from "../src/schemas";

export const SYNTHETIC_FIXTURE_NOTICE =
  "SYNTHETIC TEST FIXTURE — not a real evaluation and not a quality claim.";
export const EVIDENCE_SECRET = new TextEncoder().encode(
  "synthetic-test-only-evidence-signing-key",
);

export const context: RequestContext = {
  schema_version: 1,
  scope: { owner_id: "owner-1", project_id: "project-1" },
  request_id: "request-1",
};

export const baseModel = {
  component: "model/base",
  revision: "1",
};
export const tokenizer = {
  component: "tokenizer/base",
  revision: "1",
};

export class MemoryArtifacts implements ArtifactLoader {
  private readonly values = new Map<string, Uint8Array>();

  set(ref: ArtifactRef, bytes: Uint8Array): void {
    this.values.set(this.key(ref), Uint8Array.from(bytes));
  }

  delete(ref: ArtifactRef): void {
    this.values.delete(this.key(ref));
  }

  async get(_context: RequestContext, ref: ArtifactRef): Promise<Uint8Array> {
    const value = this.values.get(this.key(ref));
    if (!value) throw new Error("synthetic artifact missing");
    return Uint8Array.from(value);
  }

  private key(ref: Pick<ArtifactRef, "artifact_id" | "sha256">): string {
    return `${ref.artifact_id}:${ref.sha256}`;
  }
}

export async function createTempRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "mars-specialists-"));
}

export async function removeTempRoot(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

export function installNoNetworkStub(): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("network disabled in specialist tests");
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

export function artifactRef(
  artifactId: string,
  bytes = new Uint8Array(),
): ArtifactRef {
  return {
    artifact_id: artifactId,
    sha256: sha256(bytes),
    media_type: "application/json",
    byte_length: bytes.byteLength,
  };
}

export function fakeModel(
  input: Partial<ModelConfig> &
    Pick<ModelConfig, "id" | "providerId" | "model">,
): ModelConfig {
  return {
    id: input.id,
    providerId: input.providerId,
    model: input.model,
    capabilities: {
      tools: true,
      vision: true,
      contextWindow: 8192,
      reasoning: true,
      ...input.capabilities,
    },
    pricing: {
      free: true,
      ...input.pricing,
    },
    ...(input.tags ? { tags: input.tags } : {}),
  };
}

export function fakeCatalog(
  options: {
    models?: ModelConfig[];
    allowPaid?: boolean;
    unavailableProviders?: readonly string[];
  } = {},
): ModelCatalog {
  const models = options.models ?? [
    fakeModel({
      id: "baseline-model",
      providerId: "local",
      model: "baseline-upstream",
    }),
    fakeModel({
      id: "specialist-model",
      providerId: "local",
      model: "specialist-upstream",
    }),
    fakeModel({
      id: "specialist-model-2",
      providerId: "local",
      model: "specialist-upstream-2",
    }),
    fakeModel({
      id: "reviewer-model",
      providerId: "local",
      model: "reviewer-upstream",
    }),
    fakeModel({
      id: "paid-model",
      providerId: "remote",
      model: "paid-upstream",
      pricing: {
        free: false,
        inputPerMTokUsd: 1,
        outputPerMTokUsd: 2,
      },
    }),
  ];
  const byId = new Map(models.map((model) => [model.id, model]));
  const unavailable = new Set(options.unavailableProviders ?? []);
  return {
    policy: { allowPaid: options.allowPaid ?? false },
    getModel(id) {
      return byId.get(id);
    },
    unavailableReason(providerId) {
      return unavailable.has(providerId) ? "synthetic unavailable" : undefined;
    },
  };
}

export function evidenceVerifier(
  overrides: {
    ownerIds?: string[];
    evaluatorIds?: string[];
    keyId?: string;
  } = {},
): EvidenceVerifier {
  return createHmacEvidenceVerifier({
    authorities: [
      {
        key_id: overrides.keyId ?? "test-key",
        secret: EVIDENCE_SECRET,
        authority_id: "synthetic-authority",
        owner_ids: overrides.ownerIds ?? ["owner-1"],
        evaluator_ids: overrides.evaluatorIds ?? ["eval-1"],
      },
    ],
  });
}

export function createRegistry(
  rootDir: string,
  artifacts: MemoryArtifacts,
  overrides: Omit<
    Partial<Omit<SpecialistRegistryOptions, "rootDir" | "artifacts">>,
    "evidenceVerifier"
  > & { evidenceVerifier?: EvidenceVerifier | null } = {},
): SpecialistRegistry {
  const { evidenceVerifier: verifierOption, ...otherOptions } = overrides;
  const verifier =
    verifierOption === null
      ? undefined
      : (verifierOption ?? evidenceVerifier());
  return new SpecialistRegistry({
    rootDir,
    artifacts,
    catalog: otherOptions.catalog ?? fakeCatalog(),
    allowSyntheticFixtures: otherOptions.allowSyntheticFixtures ?? true,
    ...(verifier ? { evidenceVerifier: verifier } : {}),
    ...(otherOptions.servingAttestor
      ? { servingAttestor: otherOptions.servingAttestor }
      : {}),
    ...(otherOptions.hostPrivateRoots
      ? { hostPrivateRoots: otherOptions.hostPrivateRoots }
      : {}),
    ...(otherOptions.maxArtifactBytes !== undefined
      ? { maxArtifactBytes: otherOptions.maxArtifactBytes }
      : {}),
    ...(otherOptions.evaluation ? { evaluation: otherOptions.evaluation } : {}),
    ...(otherOptions.taskRouting
      ? { taskRouting: otherOptions.taskRouting }
      : {}),
  });
}

export function makeBaseline(
  scope: Scope = context.scope,
  overrides: Partial<BaselineProfile> = {},
): BaselineProfile {
  return {
    schema_version: 1,
    baseline_id: "baseline",
    revision: "1",
    scope,
    display_name: "Synthetic baseline",
    model_id: "baseline-model",
    provider_id: "local",
    provider_model: "baseline-upstream",
    roles: ["lead", "worker", "reviewer"],
    complexity: ["light", "medium", "heavy"],
    priority: 10,
    ...overrides,
  };
}

export interface SpecialistFixtureOptions {
  specialistId?: string;
  revision?: string;
  scope?: Scope;
  modelId?: string;
  providerId?: string;
  providerModel?: string;
  fallbackRef?: string;
  roles?: SpecialistRegistration["profile"]["roles"];
  complexity?: SpecialistRegistration["profile"]["complexity"];
  domains?: string[];
  candidatePassed?: number;
  basePassed?: number;
  promptPassed?: number;
  currentPassed?: number;
  currentRevision?: string | null;
  costUsdTotal?: number | null;
  runtimeMsP95?: number | null;
  acceptance?: Partial<SpecialistRegistration["profile"]["acceptance"]>;
  reportId?: string;
  evaluatorId?: string;
  synthetic?: boolean;
  tamperSignature?: "bad_mac" | "unknown_key";
  reportTransform?: (
    report: Record<string, unknown>,
  ) => Record<string, unknown>;
  datasetLineage?: ArtifactRef | null;
  adapter?: ArtifactRef | null;
  adapterSpec?: SpecialistRegistration["profile"]["adapter_spec"];
  adapterFormat?: "peft-lora" | null;
}

export interface SpecialistFixture {
  registration: SpecialistRegistration;
  report: EvaluationReport;
  reportBytes: Uint8Array;
  candidateSha256: string;
}

export async function makeSpecialistFixture(
  artifacts: MemoryArtifacts,
  options: SpecialistFixtureOptions = {},
): Promise<SpecialistFixture> {
  const specialistId = options.specialistId ?? "specialist-1";
  const revision = options.revision ?? "1";
  const scope = options.scope ?? context.scope;
  const roles = options.roles ?? ["worker"];
  const complexity = options.complexity ?? ["medium"];
  const domains = options.domains ?? ["coding/mechanical-edit"];
  const placeholderEvaluation = artifactRef(`placeholder-${specialistId}`);
  const registration = {
    specialist_id: specialistId,
    revision,
    scope,
    tested_task_coverage: domains,
    base_model: baseModel,
    tokenizer,
    chat_template: artifactRef(`template-${specialistId}`),
    adapter: options.adapter ?? null,
    tools: [],
    skills: [],
    knowledge: [],
    evaluation: placeholderEvaluation,
    dataset_lineage: options.datasetLineage ?? null,
    fallback_specialist_revision: options.fallbackRef ?? "baseline:baseline@1",
    profile: {
      schema_version: 1,
      display_name: "Synthetic evaluated specialist",
      roles,
      complexity,
      serving: [
        {
          model_id: options.modelId ?? "specialist-model",
          provider_id: options.providerId ?? "local",
          provider_model: options.providerModel ?? "specialist-upstream",
          adapter_format: options.adapterFormat ?? null,
        },
      ],
      adapter_spec: options.adapterSpec ?? null,
      acceptance: {
        min_heldout_tasks_per_coverage: 1,
        min_pass_rate_delta_vs_base: 0,
        min_pass_rate_delta_vs_prompt_optimized: 0,
        min_pass_rate_delta_vs_current: 0,
        max_regressions: 0,
        max_cost_usd_per_task: null,
        max_runtime_ms_p95: null,
        ...options.acceptance,
      },
      limitations: [SYNTHETIC_FIXTURE_NOTICE],
    },
  } satisfies SpecialistRegistration;
  const candidateSha256 = candidateDigest(registration);
  const taskIds = ["heldout-task-1"];
  const arms = [
    { arm: "base", specialist_revision: null },
    { arm: "prompt_optimized_baseline", specialist_revision: null },
    {
      arm: "current_specialist",
      specialist_revision: options.currentRevision ?? null,
    },
    { arm: "candidate", specialist_revision: revision },
  ] as const;
  const versions = {
    base: { component: "model/base", revision: "1" },
    prompt_optimized_baseline: {
      component: "model/prompt-optimized",
      revision: "1",
    },
    current_specialist: {
      component: "model/current",
      revision: "1",
    },
    candidate: { component: "model/candidate", revision },
  };
  const reportValue: Record<string, unknown> = {
    schema: "mars.specialist-evaluation-report/v1",
    report_id: options.reportId ?? `report-${specialistId}-${revision}`,
    subject: {
      specialist_id: specialistId,
      revision,
      candidate_sha256: candidateSha256,
    },
    authorization: {
      owner_id: scope.owner_id,
      project_id: scope.project_id,
    },
    suite: {
      suite_id: "synthetic-suite",
      revision: "1",
      harness: { component: "synthetic-harness", revision: "1" },
    },
    heldout: {
      split_id: "synthetic-heldout",
      split_sha256: "a".repeat(64),
      task_ids: taskIds,
    },
    arms: arms.map(({ arm, specialist_revision }) => ({
      arm,
      agent_manifest_sha256: "b".repeat(64),
      model: versions[arm],
      specialist_revision,
    })),
    results: arms.map(({ arm }) => ({
      arm,
      domain: domains[0],
      role: roles[0],
      complexity: complexity[0],
      task_ids: taskIds,
      passed:
        arm === "candidate"
          ? (options.candidatePassed ?? 1)
          : arm === "base"
            ? (options.basePassed ?? 0)
            : arm === "prompt_optimized_baseline"
              ? (options.promptPassed ?? 0)
              : (options.currentPassed ?? 0),
      attempted: taskIds.length,
      repeats: 1,
      cost_usd_total:
        arm === "candidate"
          ? "costUsdTotal" in options
            ? options.costUsdTotal
            : 0.01
          : null,
      runtime_ms_p95:
        arm === "candidate"
          ? "runtimeMsP95" in options
            ? options.runtimeMsP95
            : 100
          : null,
      input_tokens: 10,
      output_tokens: 10,
    })),
    regressions: [],
    uncertainty: [],
    limitations: [SYNTHETIC_FIXTURE_NOTICE],
    provenance: {
      evaluator_id: options.evaluatorId ?? "eval-1",
      evaluator_revision: "1",
      job_id: `job-${specialistId}-${revision}`,
      produced_at: "2026-01-01T00:00:00.000Z",
      synthetic_fixture: options.synthetic ?? true,
      evidence_artifacts: [],
    },
  };
  const transformed = options.reportTransform
    ? options.reportTransform(reportValue)
    : reportValue;
  const signer = createHmacEvidenceSigner({
    key_id: "test-key",
    secret: EVIDENCE_SECRET,
  });
  let signed = signer.sign(transformed) as unknown as EvaluationReport;
  if (options.tamperSignature === "bad_mac") {
    signed = {
      ...signed,
      attestation: { ...signed.attestation, mac_hex: "0".repeat(64) },
    };
  } else if (options.tamperSignature === "unknown_key") {
    signed = {
      ...signed,
      attestation: { ...signed.attestation, key_id: "unknown-key" },
    };
  }
  const reportBytes = new TextEncoder().encode(canonicalJson(signed));
  const evaluation = {
    artifact_id: `report-artifact-${specialistId}-${revision}`,
    sha256: sha256(reportBytes),
    media_type: "application/json",
    byte_length: reportBytes.byteLength,
  };
  registration.evaluation = evaluation;
  artifacts.set(evaluation, reportBytes);
  return { registration, report: signed, reportBytes, candidateSha256 };
}

export async function makeLineageArtifact(
  artifacts: MemoryArtifacts,
  scope: Scope = context.scope,
  options: {
    specialistId?: string;
    producerId?: string;
    trainTaskIds?: string[];
    validationTaskIds?: string[];
    sourceScopes?: Scope[];
    datasetSha256?: string;
  } = {},
): Promise<ArtifactRef> {
  const signer = createHmacEvidenceSigner({
    key_id: "test-key",
    secret: EVIDENCE_SECRET,
  });
  const lineage = signer.sign({
    schema: "mars.specialist-dataset-lineage/v1",
    lineage_id: "synthetic-lineage",
    subject: {
      specialist_id: options.specialistId ?? "specialist-1",
      base_model: baseModel,
    },
    datasets: [
      {
        dataset_id: "synthetic-train-set",
        sha256: options.datasetSha256 ?? "c".repeat(64),
        split: "train",
      },
    ],
    training: {
      job_id: "synthetic-training-job",
      producer_id: options.producerId ?? "trainer-1",
      config_sha256: "d".repeat(64),
    },
    source_scopes: options.sourceScopes ?? [scope],
    train_task_ids: options.trainTaskIds ?? ["training-task-1"],
    validation_task_ids: options.validationTaskIds ?? ["validation-task-1"],
    provenance: { synthetic_fixture: true },
  });
  const bytes = new TextEncoder().encode(canonicalJson(lineage));
  const ref = artifactRef("synthetic-lineage-artifact", bytes);
  artifacts.set(ref, bytes);
  return ref;
}

export function routingRequest(
  overrides: Partial<RoutingRequest> = {},
): RoutingRequest {
  return {
    schema_version: 1,
    task_id: "route-task",
    role: "worker",
    domain: "coding/mechanical-edit",
    complexity: "medium",
    requires: {
      tools: false,
      vision: false,
      reasoning: false,
      min_context_tokens: 1000,
    },
    budget: {
      max_tokens: 1000,
      max_usd: 1,
      max_duration_ms: 1000,
      max_depth: 2,
      max_concurrency: 1,
    },
    paid_consent: false,
    ...overrides,
  } as RoutingRequest;
}
