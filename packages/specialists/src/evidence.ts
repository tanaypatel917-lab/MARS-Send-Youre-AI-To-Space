import { createHmac, timingSafeEqual } from "node:crypto";
import type { RequestContext, VersionRef } from "@mars/contracts";
import {
  canonicalJson,
  sameJson,
  sha256,
  withoutAttestation,
} from "./canonical";
import {
  DatasetLineageSchema,
  type EvaluationReport,
  EvaluationReportSchema,
  type ReasonCode,
  type SpecialistRegistration,
} from "./schemas";

export interface ArtifactLoader {
  get(
    context: RequestContext,
    ref: {
      artifact_id: string;
      sha256: string;
      media_type: string;
      byte_length: number;
    },
  ): Promise<Uint8Array>;
}

export type EvidenceKind = "evaluation_report" | "dataset_lineage";

export interface EvidenceVerifier {
  verify(
    context: RequestContext,
    input: {
      kind: EvidenceKind;
      document: EvaluationReport | zInferDatasetLineage;
      manifest: SpecialistRegistration;
    },
  ): Promise<
    | { verified: true; authority_id: string }
    | {
        verified: false;
        reason:
          | "unknown_key"
          | "bad_mac"
          | "owner_not_authorized"
          | "evaluator_not_authorized"
          | "alg_unsupported";
      }
  >;
}

type zInferDatasetLineage = ReturnType<typeof DatasetLineageSchema.parse>;

export interface TripleGate {
  domain: string;
  role: SpecialistRegistration["profile"]["roles"][number];
  complexity: SpecialistRegistration["profile"]["complexity"][number];
  pass_rate: number;
  base_pass_rate: number;
  delta_vs_base: number;
  prompt_optimized_pass_rate: number;
  delta_vs_prompt_optimized: number;
  current_pass_rate: number | null;
  delta_vs_current: number | null;
  cost_usd_per_task: number | null;
  runtime_ms_p95: number | null;
  passed: boolean;
}

export interface EvidenceVerdict {
  status: "proposed" | "evaluated" | "rejected";
  codes: ReasonCode[];
  covered_triples: TripleGate[];
  report_id: string | null;
  report_sha256: string | null;
  synthetic_fixture: boolean;
  evidence_artifacts: string[];
  lineage_dataset_sha256s: string[];
  current_specialist_revision: string | null;
  note: string;
}

export interface VerifyEvidenceOptions {
  artifacts: ArtifactLoader;
  evidenceVerifier?: EvidenceVerifier;
  allowSyntheticFixtures?: boolean;
  maxArtifactBytes?: number;
  currentProductionRevision?: string | null;
  checkCurrentFreshness?: boolean;
}

interface Loaded<T> {
  value?: T;
  bytes?: Uint8Array;
}

async function loadJsonArtifact<T>(
  ctx: RequestContext,
  ref: SpecialistRegistration["evaluation"],
  options: VerifyEvidenceOptions,
  kind: "report" | "lineage",
): Promise<{ loaded: Loaded<T>; code?: ReasonCode }> {
  const missingCode =
    kind === "report" ? "evidence_missing" : "lineage_missing";
  const digestCode =
    kind === "report" ? "evidence_digest_mismatch" : "lineage_digest_mismatch";
  const malformedCode =
    kind === "report" ? "evidence_malformed" : "lineage_malformed";
  let bytes: Uint8Array;
  try {
    bytes = await options.artifacts.get(ctx, ref);
  } catch {
    return { loaded: {}, code: missingCode };
  }
  if (
    ref.media_type !== "application/json" ||
    bytes.byteLength !== ref.byte_length ||
    sha256(bytes) !== ref.sha256 ||
    bytes.byteLength > (options.maxArtifactBytes ?? 4 * 1024 * 1024)
  ) {
    return { loaded: {}, code: digestCode };
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { loaded: {}, code: malformedCode };
  }
  const schema =
    kind === "report" ? EvaluationReportSchema : DatasetLineageSchema;
  const parsed = schema.safeParse(value);
  if (!parsed.success) return { loaded: {}, code: malformedCode };
  return { loaded: { value: parsed.data as T, bytes } };
}

async function verifySignature(
  ctx: RequestContext,
  kind: EvidenceKind,
  document: EvaluationReport | zInferDatasetLineage,
  manifest: SpecialistRegistration,
  verifier: EvidenceVerifier | undefined,
): Promise<ReasonCode | undefined> {
  if (!verifier) return "evidence_unverified";
  let result: Awaited<ReturnType<EvidenceVerifier["verify"]>>;
  try {
    result = await verifier.verify(ctx, { kind, document, manifest });
  } catch {
    return kind === "evaluation_report"
      ? "evidence_unverified"
      : "lineage_unverified";
  }
  if (result.verified) return undefined;
  return kind === "evaluation_report"
    ? "evidence_unverified"
    : "lineage_unverified";
}

function rate(
  report: EvaluationReport,
  arm: string,
  triple: {
    domain: string;
    role: string;
    complexity: string;
  },
) {
  return report.results.find(
    (result) =>
      result.arm === arm &&
      result.domain === triple.domain &&
      result.role === triple.role &&
      result.complexity === triple.complexity,
  );
}

function sameStringSet(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index])
  );
}

function reportIsMalformed(report: EvaluationReport): boolean {
  const heldout = new Set(report.heldout.task_ids);
  const groups = new Map<string, typeof report.results>();
  for (const result of report.results) {
    const key = `${result.domain}\u0000${result.role}\u0000${result.complexity}`;
    const group = groups.get(key) ?? [];
    group.push(result);
    groups.set(key, group);
    if (
      result.attempted !== result.task_ids.length ||
      result.passed > result.attempted ||
      result.task_ids.some((taskId) => !heldout.has(taskId))
    ) {
      return true;
    }
  }
  const requiredArms = new Set(
    report.arms
      .filter(
        (arm) =>
          arm.arm !== "current_specialist" || arm.specialist_revision !== null,
      )
      .map(({ arm }) => arm),
  );
  for (const group of groups.values()) {
    for (const arm of report.arms) {
      const results = group.filter((result) => result.arm === arm.arm);
      if (results.length > 1) return true;
    }
    const present = group;
    if (
      [...requiredArms].some(
        (arm) => !present.some((result) => result.arm === arm),
      ) ||
      new Set(present.map((result) => result.arm)).size !== present.length ||
      !present.every((result) =>
        sameStringSet(result.task_ids, present[0]?.task_ids ?? []),
      )
    ) {
      return true;
    }
  }
  return false;
}

export async function verifyEvidence(
  ctx: RequestContext,
  manifest: SpecialistRegistration,
  candidateSha256: string,
  options: VerifyEvidenceOptions,
): Promise<EvidenceVerdict> {
  const codes = new Set<ReasonCode>();
  const reportResult = await loadJsonArtifact<EvaluationReport>(
    ctx,
    manifest.evaluation,
    options,
    "report",
  );
  if (reportResult.code) codes.add(reportResult.code);
  const report = reportResult.loaded.value;
  let synthetic = report?.provenance.synthetic_fixture ?? false;
  const reportId: string | null = report?.report_id ?? null;
  const evidenceArtifactHashes = report
    ? [
        manifest.evaluation.sha256,
        ...report.provenance.evidence_artifacts.map(
          ({ sha256: digest }) => digest,
        ),
      ]
    : [manifest.evaluation.sha256];
  let lineageDatasetHashes: string[] = [];
  let currentRevision: string | null = null;

  if (report) {
    if (reportIsMalformed(report)) codes.add("evidence_malformed");
    const baseArm = report.arms.find((arm) => arm.arm === "base");
    if (
      report.subject.specialist_id !== manifest.specialist_id ||
      report.subject.revision !== manifest.revision ||
      report.subject.candidate_sha256 !== candidateSha256 ||
      !baseArm ||
      !sameJson(baseArm.model, manifest.base_model)
    ) {
      codes.add("evidence_subject_mismatch");
    }
    if (
      report.authorization.owner_id !== manifest.scope.owner_id ||
      report.authorization.project_id !== manifest.scope.project_id
    ) {
      codes.add("evidence_unauthorized");
    }
    const signatureCode = await verifySignature(
      ctx,
      "evaluation_report",
      report,
      manifest,
      options.evidenceVerifier,
    );
    if (signatureCode) codes.add(signatureCode);
    if (synthetic && options.allowSyntheticFixtures !== true) {
      codes.add("evidence_synthetic_fixture");
    }
    currentRevision =
      report.arms.find((arm) => arm.arm === "current_specialist")
        ?.specialist_revision ?? null;
  }

  if (manifest.dataset_lineage) {
    const lineageResult = await loadJsonArtifact<zInferDatasetLineage>(
      ctx,
      manifest.dataset_lineage,
      options,
      "lineage",
    );
    if (lineageResult.code) codes.add(lineageResult.code);
    const lineage = lineageResult.loaded.value;
    if (lineage) {
      synthetic ||= lineage.provenance.synthetic_fixture;
      lineageDatasetHashes = lineage.datasets.map(
        ({ sha256: digest }) => digest,
      );
      evidenceArtifactHashes.push(manifest.dataset_lineage.sha256);
      const lineageSignatureCode = await verifySignature(
        ctx,
        "dataset_lineage",
        lineage,
        manifest,
        options.evidenceVerifier,
      );
      if (lineageSignatureCode) codes.add(lineageSignatureCode);
      if (
        lineage.subject.specialist_id !== manifest.specialist_id ||
        !sameJson(lineage.subject.base_model, manifest.base_model)
      ) {
        codes.add("lineage_subject_mismatch");
      }
      const leaked = new Set([
        ...lineage.train_task_ids,
        ...lineage.validation_task_ids,
      ]);
      if (
        report?.heldout.task_ids.some((taskId) => leaked.has(taskId)) ||
        lineage.datasets.some(
          ({ sha256: digest }) => digest === report?.heldout.split_sha256,
        )
      ) {
        codes.add("lineage_leakage");
      }
      if (
        lineage.source_scopes.some(
          ({ owner_id }) => owner_id !== manifest.scope.owner_id,
        )
      ) {
        codes.add("lineage_out_of_scope");
      }
      if (
        report &&
        report.provenance.evaluator_id === lineage.training.producer_id
      ) {
        codes.add("evidence_not_independent");
      }
      if (synthetic && options.allowSyntheticFixtures !== true) {
        codes.add("evidence_synthetic_fixture");
      }
    }
  }

  const coveredTriples: TripleGate[] = [];
  if (report) {
    if (
      report.regressions.length > manifest.profile.acceptance.max_regressions
    ) {
      codes.add("regressions_exceeded");
    }
    for (const domain of manifest.tested_task_coverage) {
      for (const role of manifest.profile.roles) {
        for (const complexity of manifest.profile.complexity) {
          const triple = { domain, role, complexity };
          const candidate = rate(report, "candidate", triple);
          const base = rate(report, "base", triple);
          const prompt = rate(report, "prompt_optimized_baseline", triple);
          const current = rate(report, "current_specialist", triple);
          if (!candidate || !base || !prompt) continue;
          const currentRequired = currentRevision !== null;
          if (currentRequired && !current) continue;
          const passRate = candidate.passed / candidate.attempted;
          const baseRate = base.passed / base.attempted;
          const promptRate = prompt.passed / prompt.attempted;
          const currentRate =
            current && currentRevision !== null
              ? current.passed / current.attempted
              : null;
          const deltaVsBase = passRate - baseRate;
          const deltaVsPrompt = passRate - promptRate;
          const deltaVsCurrent =
            currentRate === null ? null : passRate - currentRate;
          let passed =
            candidate.attempted >=
              manifest.profile.acceptance.min_heldout_tasks_per_coverage &&
            deltaVsBase >=
              manifest.profile.acceptance.min_pass_rate_delta_vs_base &&
            deltaVsPrompt >=
              manifest.profile.acceptance
                .min_pass_rate_delta_vs_prompt_optimized &&
            (deltaVsCurrent === null ||
              deltaVsCurrent >=
                manifest.profile.acceptance.min_pass_rate_delta_vs_current);
          const cost =
            candidate.cost_usd_total === null
              ? null
              : candidate.cost_usd_total / candidate.attempted;
          const maxCost = manifest.profile.acceptance.max_cost_usd_per_task;
          if (maxCost !== null && cost === null) {
            codes.add("cost_unmeasured");
            passed = false;
          } else if (maxCost !== null && cost !== null && cost > maxCost) {
            passed = false;
          }
          const runtime = candidate.runtime_ms_p95;
          const maxRuntime = manifest.profile.acceptance.max_runtime_ms_p95;
          if (maxRuntime !== null && runtime === null) {
            codes.add("runtime_unmeasured");
            passed = false;
          } else if (
            maxRuntime !== null &&
            runtime !== null &&
            runtime > maxRuntime
          ) {
            passed = false;
          }
          coveredTriples.push({
            domain,
            role,
            complexity,
            pass_rate: passRate,
            base_pass_rate: baseRate,
            delta_vs_base: deltaVsBase,
            prompt_optimized_pass_rate: promptRate,
            delta_vs_prompt_optimized: deltaVsPrompt,
            current_pass_rate: currentRate,
            delta_vs_current: deltaVsCurrent,
            cost_usd_per_task: cost,
            runtime_ms_p95: runtime,
            passed,
          });
        }
      }
    }
    if (
      coveredTriples.length === 0 ||
      !coveredTriples.some((item) => item.passed)
    ) {
      codes.add("evaluation_gate_failed");
    }
    if (
      options.checkCurrentFreshness === true &&
      currentRevision !== (options.currentProductionRevision ?? null)
    ) {
      codes.add("evidence_stale_current_baseline");
    }
  }

  const sortedCodes = [...codes].sort();
  const retryable = new Set<ReasonCode>([
    "evidence_missing",
    "evidence_unverified",
    "lineage_missing",
    "lineage_unverified",
  ]);
  const status =
    sortedCodes.length === 0
      ? "evaluated"
      : sortedCodes.every((code) => retryable.has(code))
        ? "proposed"
        : "rejected";
  return {
    status,
    codes: sortedCodes,
    covered_triples: coveredTriples,
    report_id: reportId,
    report_sha256: report ? manifest.evaluation.sha256 : null,
    synthetic_fixture: synthetic,
    evidence_artifacts: [...new Set(evidenceArtifactHashes)].sort(),
    lineage_dataset_sha256s: [...new Set(lineageDatasetHashes)].sort(),
    current_specialist_revision: currentRevision,
    note: "Hashes and HMAC prove origin and integrity of report bytes, not that results are true.",
  };
}

export function createHmacEvidenceSigner(options: {
  key_id: string;
  secret: Uint8Array;
}) {
  const secret = Uint8Array.from(options.secret);
  return {
    sign<T extends Record<string, unknown>>(documentWithoutAttestation: T) {
      const mac_hex = createHmac("sha256", secret)
        .update(canonicalJson(documentWithoutAttestation))
        .digest("hex");
      return {
        ...documentWithoutAttestation,
        attestation: {
          alg: "hmac-sha256" as const,
          key_id: options.key_id,
          mac_hex,
        },
      };
    },
  };
}

export function createHmacEvidenceVerifier(options: {
  authorities: Array<{
    key_id: string;
    secret: Uint8Array;
    authority_id: string;
    owner_ids: string[];
    evaluator_ids: string[];
  }>;
}): EvidenceVerifier {
  const authorities = options.authorities.map((authority) => ({
    ...authority,
    secret: Uint8Array.from(authority.secret),
  }));
  return {
    async verify(_ctx, input) {
      const attestation = input.document.attestation;
      if (attestation.alg !== "hmac-sha256") {
        return { verified: false, reason: "alg_unsupported" };
      }
      const authority = authorities.find(
        (item) => item.key_id === attestation.key_id,
      );
      if (!authority) return { verified: false, reason: "unknown_key" };
      const unsigned = withoutAttestation(input.document);
      const expected = createHmac("sha256", authority.secret)
        .update(canonicalJson(unsigned))
        .digest();
      const actual = Buffer.from(attestation.mac_hex, "hex");
      if (
        actual.byteLength !== expected.byteLength ||
        !timingSafeEqual(expected, actual)
      ) {
        return { verified: false, reason: "bad_mac" };
      }
      if (!authority.owner_ids.includes(input.manifest.scope.owner_id)) {
        return { verified: false, reason: "owner_not_authorized" };
      }
      if (
        input.kind === "evaluation_report" &&
        !authority.evaluator_ids.includes(
          (input.document as EvaluationReport).provenance.evaluator_id,
        )
      ) {
        return { verified: false, reason: "evaluator_not_authorized" };
      }
      return { verified: true, authority_id: authority.authority_id };
    },
  };
}

export function hasCurrentArm(report: EvaluationReport): boolean {
  return (
    report.arms.find((arm) => arm.arm === "current_specialist")
      ?.specialist_revision !== null
  );
}

export function versionRefEqual(left: VersionRef, right: VersionRef): boolean {
  return sameJson(left, right);
}
