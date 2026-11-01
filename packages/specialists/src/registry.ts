import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  ArtifactRef,
  Budget,
  EvaluationService,
  JobRef,
  ModelRegistry,
  RequestContext,
  SpecialistManifest,
  Task,
  VersionRef,
} from "@mars/contracts";
import {
  assertPublishable,
  candidateDigest,
  canonicalJson,
  decisionDigest,
  sameJson,
  scopeKey,
  sha256,
} from "./canonical";
import {
  type BindingCompatibility,
  baselineCompatibility,
  type CompatibilityOptions,
  checkSpecialistBindings,
  compatibleBase,
  firstPassingBinding,
  type ModelCatalog,
  type ServingAttestor,
} from "./compat";
import { SpecialistRegistryError } from "./errors";
import {
  type ArtifactLoader,
  type EvidenceVerdict,
  type EvidenceVerifier,
  type TripleGate,
  verifyEvidence,
} from "./evidence";
import {
  makeRoutingDecision,
  normalizeReasons,
  rankCandidates,
  resolveFallbackChain,
} from "./routing";
import {
  type BaselineProfile,
  BaselineProfileSchema,
  type Complexity,
  type ReasonCode,
  RequestContextSchema,
  type RoutingDecision,
  RoutingDecisionSchema,
  type RoutingRequest,
  RoutingRequestSchema,
  type SelectedTarget,
  type SpecialistRegistration,
  SpecialistRegistrationSchema,
} from "./schemas";
import {
  type BaselineRow,
  type ProductionRow,
  type SpecialistRevisionRow,
  SpecialistStore,
} from "./store";

export interface EvaluationArtifacts {
  put(
    context: RequestContext,
    data: Uint8Array,
    mediaType: string,
  ): Promise<ArtifactRef>;
}

export interface SpecialistEvaluationOptions {
  service: EvaluationService;
  artifacts: EvaluationArtifacts;
  defaultBudget: Budget;
}

export interface SpecialistRegistryOptions {
  rootDir: string;
  artifacts: ArtifactLoader;
  catalog: ModelCatalog;
  evidenceVerifier?: EvidenceVerifier;
  servingAttestor?: ServingAttestor;
  hostPrivateRoots?: readonly string[];
  maxArtifactBytes?: number;
  allowSyntheticFixtures?: boolean;
  evaluation?: SpecialistEvaluationOptions;
  taskRouting?: (task: Task) => RoutingRequest;
}

export interface SpecialistPointerView {
  specialist_id: string;
  production_revision: string | null;
  history: string[];
  retired: boolean;
  pointer_version: number;
}

export interface SpecialistRevisionView {
  registration: SpecialistRegistration;
  status: "proposed" | "evaluated" | "rejected" | "archived" | "invalidated";
  candidate_sha256: string;
  verdict: EvidenceVerdict;
  deployment: "production" | "previous" | "none";
  rolled_back: boolean;
  invalidated_reason: string | null;
  evaluation_jobs: JobRef[];
}

export interface SpecialistInspection {
  pointer: SpecialistPointerView;
  revisions: SpecialistRevisionView[];
}

export interface BaselineView {
  profile: BaselineProfile;
  status: "active" | "retired";
}

export type SpecialistRef =
  | { kind: "specialist"; id: string; revision: string }
  | { kind: "baseline"; id: string; revision: string };

export function formatRef(
  kind: "specialist" | "baseline",
  id: string,
  revision: string,
): string {
  return `${kind}:${id}@${revision}`;
}

export function parseRef(value: string): SpecialistRef | null {
  const match =
    /^(specialist|baseline):([a-z0-9][a-z0-9._:-]{0,127})@([a-z0-9][a-z0-9._:-]{0,127})$/.exec(
      value,
    );
  if (!match || match[3] === "none") return null;
  return {
    kind: match[1] as "specialist" | "baseline",
    id: match[2] as string,
    revision: match[3] as string,
  };
}

function contractRef(value: string): { id: string; revision: string } {
  const match =
    /^([a-z0-9][a-z0-9._:-]{0,127})@([a-z0-9][a-z0-9._:-]{0,127})$/.exec(value);
  if (!match || match[2] === "none") {
    throw new SpecialistRegistryError("invalid_input", "ref_invalid");
  }
  return { id: match[1] as string, revision: match[2] as string };
}

type ScopeValue = {
  owner_id: string;
  project_id: string;
  workspace_id?: string | undefined;
};

function scopeEquals(left: ScopeValue, right: ScopeValue): boolean {
  return sameJson(
    {
      owner_id: left.owner_id,
      project_id: left.project_id,
      workspace_id: left.workspace_id ?? null,
    },
    {
      owner_id: right.owner_id,
      project_id: right.project_id,
      workspace_id: right.workspace_id ?? null,
    },
  );
}

function visible(scope: ScopeValue, context: RequestContext): boolean {
  return (
    scope.owner_id === context.scope.owner_id &&
    scope.project_id === context.scope.project_id &&
    (scope.workspace_id === undefined ||
      scope.workspace_id === context.scope.workspace_id)
  );
}

function parseRegistration(value: unknown): SpecialistRegistration {
  const parsed = SpecialistRegistrationSchema.safeParse(value);
  if (!parsed.success) {
    throw new SpecialistRegistryError("invalid_input", "schema_invalid");
  }
  return parsed.data as SpecialistRegistration;
}

function parseBaseline(value: unknown): BaselineProfile {
  const parsed = BaselineProfileSchema.safeParse(value);
  if (!parsed.success) {
    throw new SpecialistRegistryError("invalid_input", "schema_invalid");
  }
  return parsed.data;
}

function assertContext(context: RequestContext): RequestContext {
  const parsed = RequestContextSchema.safeParse(context);
  if (!parsed.success) {
    throw new SpecialistRegistryError("invalid_input", "context_invalid");
  }
  return parsed.data;
}

function parseVerdict(value: string): EvidenceVerdict {
  try {
    return JSON.parse(value) as EvidenceVerdict;
  } catch {
    throw new SpecialistRegistryError("corrupt_record");
  }
}

function parseHistory(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !Array.isArray(parsed) ||
      parsed.some((item) => typeof item !== "string")
    ) {
      throw new Error();
    }
    return parsed as string[];
  } catch {
    throw new SpecialistRegistryError("corrupt_record");
  }
}

function parseContractRevision(value: string | null): string | null {
  return value === "none" ? null : value;
}

function noReasonDuplicates(reasons: ReasonCode[]): ReasonCode[] {
  return normalizeReasons(reasons);
}

function makeSelectedSpecialist(
  registration: SpecialistRegistration,
  revisionRow: {
    candidate_sha256: string;
  },
  verdict: EvidenceVerdict,
  binding: BindingCompatibility,
  triple: TripleGate,
): SelectedTarget {
  return {
    kind: "specialist",
    ref: formatRef(
      "specialist",
      registration.specialist_id,
      registration.revision,
    ),
    specialist_id: registration.specialist_id,
    baseline_id: null,
    revision: registration.revision,
    model_id: binding.binding.model_id,
    provider_id: binding.binding.provider_id,
    provider_model: binding.binding.provider_model,
    base_model: registration.base_model,
    adapter_sha256: registration.adapter?.sha256 ?? null,
    manifest_sha256: revisionRow.candidate_sha256,
    evidence:
      verdict.report_id === null || verdict.report_sha256 === null
        ? null
        : {
            report_id: verdict.report_id,
            report_sha256: verdict.report_sha256,
            pass_rate: triple.pass_rate,
            base_pass_rate: triple.base_pass_rate,
            prompt_optimized_pass_rate: triple.prompt_optimized_pass_rate,
            current_pass_rate: triple.current_pass_rate,
            cost_usd_per_task: triple.cost_usd_per_task,
            runtime_ms_p95: triple.runtime_ms_p95,
            synthetic_fixture: verdict.synthetic_fixture,
          },
    cost_basis: "measured",
    serving_attestation: binding.serving_attestation,
  };
}

function makeSelectedBaseline(
  baseline: BaselineProfile,
  binding: BindingCompatibility,
): SelectedTarget {
  return {
    kind: "baseline",
    ref: formatRef("baseline", baseline.baseline_id, baseline.revision),
    specialist_id: null,
    baseline_id: baseline.baseline_id,
    revision: baseline.revision,
    model_id: baseline.model_id,
    provider_id: baseline.provider_id,
    provider_model: baseline.provider_model,
    base_model: null,
    adapter_sha256: null,
    manifest_sha256: null,
    evidence: null,
    cost_basis: binding.cost_basis,
    serving_attestation: "absent",
  };
}

interface CandidateResult {
  ref: string;
  specialist_id: string;
  revision: string;
  registration: SpecialistRegistration;
  candidate_sha256: string;
  verdict: EvidenceVerdict;
  reasons: ReasonCode[];
  target: SelectedTarget | null;
  pass_rate: number;
  cost_usd_per_task: number | null;
  runtime_ms_p95: number | null;
  covering: boolean;
  production: ProductionRow;
}

interface RouteMeta {
  retry_of: string | null;
  attempt: number;
}

export class SpecialistRegistry implements ModelRegistry {
  readonly options: SpecialistRegistryOptions;
  readonly store: SpecialistStore;
  private readonly compatibilityOptions: CompatibilityOptions;
  private readonly rootDir: string;

  constructor(options: SpecialistRegistryOptions) {
    if (
      !options ||
      typeof options.rootDir !== "string" ||
      !Array.isArray(options.hostPrivateRoots ?? [])
    ) {
      throw new SpecialistRegistryError("unsafe_path", "options_invalid");
    }
    for (const root of options.hostPrivateRoots ?? []) {
      if (
        typeof root !== "string" ||
        !path.isAbsolute(root) ||
        path.resolve(root) === path.parse(path.resolve(root)).root
      ) {
        throw new SpecialistRegistryError(
          "invalid_input",
          "private_root_invalid",
        );
      }
    }
    this.options = options;
    this.store = new SpecialistStore({
      rootDir: options.rootDir,
      ...(options.hostPrivateRoots
        ? { hostPrivateRoots: options.hostPrivateRoots }
        : {}),
    });
    this.rootDir = this.store.rootDir;
    this.compatibilityOptions = {
      catalog: options.catalog,
      ...(options.servingAttestor
        ? { servingAttestor: options.servingAttestor }
        : {}),
    };
  }

  private assertOpen(): void {
    this.store.assertOpen();
  }

  private checkContext(context: RequestContext): RequestContext {
    this.assertOpen();
    return assertContext(context);
  }

  private publish(value: unknown): void {
    assertPublishable(value, {
      rootDir: this.rootDir,
      ...(this.options.hostPrivateRoots
        ? { hostPrivateRoots: this.options.hostPrivateRoots }
        : {}),
    });
  }

  private evidenceOptions(
    extra: {
      currentProductionRevision?: string | null;
      checkCurrentFreshness?: boolean;
    } = {},
  ) {
    return {
      artifacts: this.options.artifacts,
      ...(this.options.evidenceVerifier
        ? { evidenceVerifier: this.options.evidenceVerifier }
        : {}),
      ...(this.options.allowSyntheticFixtures !== undefined
        ? { allowSyntheticFixtures: this.options.allowSyntheticFixtures }
        : {}),
      ...(this.options.maxArtifactBytes !== undefined
        ? { maxArtifactBytes: this.options.maxArtifactBytes }
        : {}),
      ...extra,
    };
  }

  private verifiedRegistration(row: {
    record_json: string;
    record_sha256: string;
  }): SpecialistRegistration {
    return this.store.parseRecord(
      row.record_json,
      row.record_sha256,
      parseRegistration,
    );
  }

  private specialistRow(context: RequestContext, id: string, revision: string) {
    const row = this.store.readSpecialist(
      scopeKey(context.scope),
      id,
      revision,
    );
    if (!row) throw new SpecialistRegistryError("not_found");
    const registration = this.verifiedRegistration(row);
    if (!visible(registration.scope, context)) {
      throw new SpecialistRegistryError("not_found");
    }
    return { row, registration };
  }

  private visibleSpecialist(
    context: RequestContext,
    id: string,
    revision: string,
  ) {
    const keys = [
      scopeKey(context.scope),
      scopeKey({
        owner_id: context.scope.owner_id,
        project_id: context.scope.project_id,
      }),
    ];
    const uniqueKeys = [...new Set(keys)];
    const rows = this.store.db
      .query(
        `SELECT scope_key, specialist_id, revision, record_json, record_sha256,
          candidate_sha256, status, verdict_json, invalidated_reason,
          rolled_back_at, created_at, updated_at
         FROM specialist_revisions
         WHERE specialist_id = ? AND revision = ? AND scope_key IN (${uniqueKeys
           .map(() => "?")
           .join(", ")})`,
      )
      .all(id, revision, ...uniqueKeys) as SpecialistRevisionRow[];
    const ordered = rows.sort(
      (left, right) =>
        Number(right.scope_key === scopeKey(context.scope)) -
        Number(left.scope_key === scopeKey(context.scope)),
    );
    for (const row of ordered) {
      const registration = this.verifiedRegistration(row);
      if (visible(registration.scope, context)) {
        return { row, registration };
      }
    }
    throw new SpecialistRegistryError("not_found");
  }

  private visibleBaseline(
    context: RequestContext,
    id: string,
    revision: string,
  ) {
    const keys = [
      scopeKey(context.scope),
      scopeKey({
        owner_id: context.scope.owner_id,
        project_id: context.scope.project_id,
      }),
    ];
    const uniqueKeys = [...new Set(keys)];
    const rows = this.store.db
      .query(
        `SELECT scope_key, baseline_id, revision, record_json, record_sha256,
          status, created_at FROM baselines
         WHERE baseline_id = ? AND revision = ? AND scope_key IN (${uniqueKeys
           .map(() => "?")
           .join(", ")})`,
      )
      .all(id, revision, ...uniqueKeys) as BaselineRow[];
    rows.sort(
      (left, right) =>
        Number(right.scope_key === scopeKey(context.scope)) -
        Number(left.scope_key === scopeKey(context.scope)),
    );
    for (const row of rows) {
      const profile = this.store.parseRecord(
        row.record_json,
        row.record_sha256,
        parseBaseline,
      );
      if (visible(profile.scope, context)) return { row, profile };
    }
    throw new SpecialistRegistryError("not_found");
  }

  private baselineRow(context: RequestContext, id: string, revision: string) {
    const row = this.store.readBaseline(scopeKey(context.scope), id, revision);
    if (!row) throw new SpecialistRegistryError("not_found");
    const profile = this.store.parseRecord(
      row.record_json,
      row.record_sha256,
      parseBaseline,
    );
    if (!visible(profile.scope, context)) {
      throw new SpecialistRegistryError("not_found");
    }
    return { row, profile };
  }

  private assertRegistrationStructure(
    context: RequestContext,
    registration: SpecialistRegistration,
  ): void {
    if (!scopeEquals(registration.scope, context.scope)) {
      throw new SpecialistRegistryError("scope_denied");
    }
    const adapterSpec = registration.profile.adapter_spec;
    if (registration.adapter) {
      if (!adapterSpec) {
        throw new SpecialistRegistryError(
          "invalid_input",
          "adapter_spec_required",
        );
      }
      if (!registration.dataset_lineage) {
        throw new SpecialistRegistryError("invalid_input", "lineage_required");
      }
      if (!sameJson(adapterSpec.base_model, registration.base_model)) {
        throw new SpecialistRegistryError(
          "invalid_input",
          "adapter_base_mismatch",
        );
      }
      if (!sameJson(adapterSpec.tokenizer, registration.tokenizer)) {
        throw new SpecialistRegistryError(
          "invalid_input",
          "adapter_tokenizer_mismatch",
        );
      }
      if (
        adapterSpec.chat_template_sha256 !== registration.chat_template.sha256
      ) {
        throw new SpecialistRegistryError(
          "invalid_input",
          "adapter_chat_template_mismatch",
        );
      }
      if (
        registration.profile.serving.some(
          (binding) => binding.adapter_format !== adapterSpec.format,
        )
      ) {
        throw new SpecialistRegistryError(
          "invalid_input",
          "serving_format_mismatch",
        );
      }
    } else if (
      adapterSpec !== null ||
      registration.profile.serving.some(
        (binding) => binding.adapter_format !== null,
      )
    ) {
      throw new SpecialistRegistryError(
        "invalid_input",
        "serving_format_mismatch",
      );
    }
    const fallback = parseRef(registration.fallback_specialist_revision);
    if (!fallback) {
      throw new SpecialistRegistryError(
        "invalid_input",
        "fallback_ref_invalid",
      );
    }
    if (
      fallback.kind === "specialist" &&
      fallback.id === registration.specialist_id &&
      fallback.revision === registration.revision
    ) {
      throw new SpecialistRegistryError(
        "invalid_input",
        "fallback_self_reference",
      );
    }
    const sameScopeKey = scopeKey(registration.scope);
    const found =
      fallback.kind === "specialist"
        ? this.store.readSpecialist(
            sameScopeKey,
            fallback.id,
            fallback.revision,
          )
        : this.store.readBaseline(sameScopeKey, fallback.id, fallback.revision);
    if (!found) {
      throw new SpecialistRegistryError(
        "invalid_input",
        "fallback_target_missing",
      );
    }
    const fallbackScope =
      fallback.kind === "specialist"
        ? this.store.parseRecord(
            found.record_json,
            found.record_sha256,
            parseRegistration,
          ).scope
        : this.store.parseRecord(
            found.record_json,
            found.record_sha256,
            parseBaseline,
          ).scope;
    if (!scopeEquals(fallbackScope, registration.scope)) {
      throw new SpecialistRegistryError(
        "invalid_input",
        "fallback_target_missing",
      );
    }
    this.publish(registration);
  }

  async registerSpecialist(
    context: RequestContext,
    input: unknown,
  ): Promise<SpecialistRevisionView> {
    const ctx = this.checkContext(context);
    const registration = parseRegistration(input);
    this.assertRegistrationStructure(ctx, registration);
    const key = scopeKey(ctx.scope);
    const recordJson = canonicalJson(registration);
    const recordSha = sha256(recordJson);
    const candidateSha = candidateDigest(registration);
    const existing = this.store.readSpecialist(
      key,
      registration.specialist_id,
      registration.revision,
    );
    if (existing) {
      const existingRegistration = this.verifiedRegistration(existing);
      if (canonicalJson(existingRegistration) !== recordJson) {
        throw new SpecialistRegistryError("conflict", "revision_immutable");
      }
      return this.revisionView(ctx, existing, existingRegistration);
    }
    const production = this.store.readProduction(
      key,
      registration.specialist_id,
    );
    const verdict = await verifyEvidence(
      ctx,
      registration,
      candidateSha,
      this.evidenceOptions({
        currentProductionRevision: production?.production_revision ?? null,
      }),
    );
    this.publish({ registration, verdict });
    const now = new Date().toISOString();
    let concurrentView: SpecialistRevisionView | undefined;
    this.store.transaction(() => {
      const concurrent = this.store.readSpecialist(
        key,
        registration.specialist_id,
        registration.revision,
      );
      if (concurrent) {
        const concurrentRegistration = this.verifiedRegistration(concurrent);
        if (canonicalJson(concurrentRegistration) !== recordJson) {
          throw new SpecialistRegistryError("conflict", "revision_immutable");
        }
        concurrentView = this.revisionView(
          ctx,
          concurrent,
          concurrentRegistration,
        );
        return;
      }
      this.store.db
        .query(
          `INSERT INTO specialist_revisions
           (scope_key, specialist_id, revision, record_json, record_sha256,
            candidate_sha256, status, verdict_json, invalidated_reason,
            rolled_back_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
        )
        .run(
          key,
          registration.specialist_id,
          registration.revision,
          recordJson,
          recordSha,
          candidateSha,
          verdict.status,
          canonicalJson(verdict),
          now,
          now,
        );
      this.store.db
        .query(
          `INSERT OR IGNORE INTO production
           (scope_key, specialist_id, production_revision, history_json,
            retired, pointer_version, updated_at)
           VALUES (?, ?, NULL, '[]', 0, 0, ?)`,
        )
        .run(key, registration.specialist_id, now);
      this.store.writeAudit({
        context: ctx,
        scope_key: key,
        action: "specialist.registered",
        subject: formatRef(
          "specialist",
          registration.specialist_id,
          registration.revision,
        ),
        detail: { candidate_sha256: candidateSha, status: verdict.status },
      });
    });
    if (concurrentView) return concurrentView;
    const row = this.store.readSpecialist(
      key,
      registration.specialist_id,
      registration.revision,
    );
    if (!row) throw new SpecialistRegistryError("corrupt_record");
    return this.revisionView(ctx, row, registration);
  }

  async register(
    context: RequestContext,
    manifest: SpecialistManifest,
  ): Promise<void> {
    const candidate = manifest as SpecialistManifest & {
      profile?: unknown;
    };
    if (candidate.profile === undefined) {
      throw new SpecialistRegistryError("invalid_input", "profile_required");
    }
    await this.registerSpecialist(context, manifest);
  }

  async registerBaseline(
    context: RequestContext,
    input: unknown,
  ): Promise<BaselineView> {
    const ctx = this.checkContext(context);
    const profile = parseBaseline(input);
    if (!scopeEquals(profile.scope, ctx.scope)) {
      throw new SpecialistRegistryError("scope_denied");
    }
    this.publish(profile);
    const key = scopeKey(ctx.scope);
    const json = canonicalJson(profile);
    const digest = sha256(json);
    const existing = this.store.readBaseline(
      key,
      profile.baseline_id,
      profile.revision,
    );
    if (existing) {
      const old = this.store.parseRecord(
        existing.record_json,
        existing.record_sha256,
        parseBaseline,
      );
      if (canonicalJson(old) !== json) {
        throw new SpecialistRegistryError("conflict", "revision_immutable");
      }
      return {
        profile: old,
        status: existing.status as BaselineView["status"],
      };
    }
    const now = new Date().toISOString();
    let concurrentView: BaselineView | undefined;
    this.store.transaction(() => {
      const concurrent = this.store.readBaseline(
        key,
        profile.baseline_id,
        profile.revision,
      );
      if (concurrent) {
        const old = this.store.parseRecord(
          concurrent.record_json,
          concurrent.record_sha256,
          parseBaseline,
        );
        if (canonicalJson(old) !== json) {
          throw new SpecialistRegistryError("conflict", "revision_immutable");
        }
        concurrentView = {
          profile: old,
          status: concurrent.status as BaselineView["status"],
        };
        return;
      }
      this.store.db
        .query(
          `INSERT INTO baselines
           (scope_key, baseline_id, revision, record_json, record_sha256, status, created_at)
           VALUES (?, ?, ?, ?, ?, 'active', ?)`,
        )
        .run(key, profile.baseline_id, profile.revision, json, digest, now);
      this.store.writeAudit({
        context: ctx,
        scope_key: key,
        action: "baseline.registered",
        subject: formatRef("baseline", profile.baseline_id, profile.revision),
        detail: { status: "active" },
      });
    });
    if (concurrentView) return concurrentView;
    return { profile, status: "active" };
  }

  async retireBaseline(
    context: RequestContext,
    id: string,
    revision: string,
  ): Promise<void> {
    const ctx = this.checkContext(context);
    const { row } = this.baselineRow(ctx, id, revision);
    this.store.transaction(() => {
      this.store.db
        .query(
          "UPDATE baselines SET status = 'retired' WHERE scope_key = ? AND baseline_id = ? AND revision = ?",
        )
        .run(row.scope_key, id, revision);
      this.store.writeAudit({
        context: ctx,
        scope_key: row.scope_key,
        action: "baseline.retired",
        subject: formatRef("baseline", id, revision),
        detail: { status: "retired" },
      });
    });
  }

  async reverify(
    context: RequestContext,
    id: string,
    revision: string,
  ): Promise<SpecialistRevisionView> {
    const ctx = this.checkContext(context);
    const { row, registration } = this.specialistRow(ctx, id, revision);
    if (!scopeEquals(registration.scope, ctx.scope)) {
      throw new SpecialistRegistryError("not_found");
    }
    const pointer = this.store.readProduction(row.scope_key, id);
    const verdict = await verifyEvidence(
      ctx,
      registration,
      row.candidate_sha256,
      this.evidenceOptions({
        currentProductionRevision: pointer?.production_revision ?? null,
      }),
    );
    this.publish({ registration, verdict });
    this.store.transaction(() => {
      this.store.db
        .query(
          `UPDATE specialist_revisions SET status = ?, verdict_json = ?,
           updated_at = ? WHERE scope_key = ? AND specialist_id = ? AND revision = ?`,
        )
        .run(
          verdict.status,
          canonicalJson(verdict),
          new Date().toISOString(),
          row.scope_key,
          id,
          revision,
        );
      this.store.writeAudit({
        context: ctx,
        scope_key: row.scope_key,
        action: "specialist.verified",
        subject: formatRef("specialist", id, revision),
        detail: { codes: verdict.codes, status: verdict.status },
      });
    });
    const updated = this.store.readSpecialist(row.scope_key, id, revision);
    if (!updated) throw new SpecialistRegistryError("corrupt_record");
    return this.revisionView(ctx, updated, registration);
  }

  async inspect(
    context: RequestContext,
    id: string,
  ): Promise<SpecialistInspection> {
    const ctx = this.checkContext(context);
    const keys = [
      scopeKey(ctx.scope),
      scopeKey({
        owner_id: ctx.scope.owner_id,
        project_id: ctx.scope.project_id,
      }),
    ];
    const uniqueKeys = [...new Set(keys)];
    const visibleRows = this.store.db
      .query(
        `SELECT scope_key, specialist_id, revision, record_json, record_sha256,
          candidate_sha256, status, verdict_json, invalidated_reason,
          rolled_back_at, created_at, updated_at
         FROM specialist_revisions WHERE specialist_id = ?
          AND scope_key IN (${uniqueKeys.map(() => "?").join(", ")})`,
      )
      .all(id, ...uniqueKeys) as Array<{
      scope_key: string;
      specialist_id: string;
      revision: string;
      record_json: string;
      record_sha256: string;
      candidate_sha256: string;
      status: string;
      verdict_json: string;
      invalidated_reason: string | null;
      rolled_back_at: string | null;
      created_at: string;
      updated_at: string;
    }>;
    const visibleRecord = visibleRows
      .filter((row) => visible(this.verifiedRegistration(row).scope, ctx))
      .sort(
        (left, right) =>
          Number(right.scope_key === scopeKey(ctx.scope)) -
          Number(left.scope_key === scopeKey(ctx.scope)),
      )[0];
    if (!visibleRecord) throw new SpecialistRegistryError("not_found");
    const key = visibleRecord.scope_key;
    const pointer = this.store.readProduction(key, id);
    if (!pointer) throw new SpecialistRegistryError("not_found");
    const rows = this.store.db
      .query(
        `SELECT scope_key, specialist_id, revision, record_json, record_sha256,
          candidate_sha256, status, verdict_json, invalidated_reason,
          rolled_back_at, created_at, updated_at
         FROM specialist_revisions WHERE scope_key = ? AND specialist_id = ?
         ORDER BY created_at, revision`,
      )
      .all(key, id) as Array<{
      scope_key: string;
      specialist_id: string;
      revision: string;
      record_json: string;
      record_sha256: string;
      candidate_sha256: string;
      status: string;
      verdict_json: string;
      invalidated_reason: string | null;
      rolled_back_at: string | null;
      created_at: string;
      updated_at: string;
    }>;
    const history = parseHistory(pointer.history_json);
    return {
      pointer: {
        specialist_id: id,
        production_revision: pointer.production_revision,
        history,
        retired: pointer.retired === 1,
        pointer_version: pointer.pointer_version,
      },
      revisions: rows.map((row) => {
        const registration = this.verifiedRegistration(row);
        return this.revisionView(ctx, row, registration, pointer);
      }),
    };
  }

  async list(context: RequestContext): Promise<SpecialistInspection[]> {
    const ctx = this.checkContext(context);
    const rows = this.store.db
      .query(
        "SELECT DISTINCT specialist_id FROM specialist_revisions ORDER BY specialist_id",
      )
      .all() as Array<{ specialist_id: string }>;
    const output: SpecialistInspection[] = [];
    for (const { specialist_id } of rows) {
      try {
        output.push(await this.inspect(ctx, specialist_id));
      } catch (error) {
        if (
          !(error instanceof SpecialistRegistryError) ||
          error.code !== "not_found"
        ) {
          throw error;
        }
      }
    }
    return output;
  }

  private revisionView(
    context: RequestContext,
    row: {
      scope_key?: string;
      specialist_id: string;
      revision: string;
      candidate_sha256: string;
      status: string;
      verdict_json: string;
      invalidated_reason: string | null;
      rolled_back_at: string | null;
    },
    registration: SpecialistRegistration,
    pointer = this.store.readProduction(
      scopeKey(context.scope),
      row.specialist_id,
    ),
  ): SpecialistRevisionView {
    const history = pointer ? parseHistory(pointer.history_json) : [];
    const deployment =
      pointer?.production_revision === row.revision
        ? "production"
        : history.includes(row.revision)
          ? "previous"
          : "none";
    const jobs = this.store.db
      .query(
        `SELECT job_id, input_manifest_json FROM evaluation_jobs
         WHERE scope_key = ? AND specialist_id = ? AND revision = ?
         ORDER BY submitted_at`,
      )
      .all(
        row.scope_key ?? scopeKey(context.scope),
        row.specialist_id,
        row.revision,
      ) as Array<{
      job_id: string;
      input_manifest_json: string;
    }>;
    const verdict = parseVerdict(row.verdict_json);
    const view = {
      registration,
      status: row.status as SpecialistRevisionView["status"],
      candidate_sha256: row.candidate_sha256,
      verdict,
      deployment,
      rolled_back: row.rolled_back_at !== null,
      invalidated_reason: row.invalidated_reason,
      evaluation_jobs: jobs.map((job) => ({
        job_id: job.job_id,
        input_manifest: JSON.parse(job.input_manifest_json) as ArtifactRef,
      })),
    } satisfies SpecialistRevisionView;
    this.publish(view);
    return view;
  }

  async promote(
    context: RequestContext,
    id: string,
    revision: string,
    expectedProductionRevision: string | null,
  ): Promise<void> {
    const ctx = this.checkContext(context);
    const { row, registration } = this.specialistRow(ctx, id, revision);
    if (!scopeEquals(registration.scope, ctx.scope)) {
      throw new SpecialistRegistryError("not_found");
    }
    const pointerBefore = this.store.readProduction(row.scope_key, id);
    const current = pointerBefore?.production_revision ?? null;
    if (current !== expectedProductionRevision) {
      throw new SpecialistRegistryError("stale_revision");
    }
    const verdict = await verifyEvidence(
      ctx,
      registration,
      row.candidate_sha256,
      this.evidenceOptions({
        currentProductionRevision: current,
        checkCurrentFreshness: true,
      }),
    );
    if (
      verdict.status !== "evaluated" ||
      ["proposed", "rejected", "invalidated", "archived"].includes(row.status)
    ) {
      throw new SpecialistRegistryError("invalid_state", "not_evaluated");
    }
    const fallbackTarget = parseRef(registration.fallback_specialist_revision);
    if (!fallbackTarget) {
      throw new SpecialistRegistryError("invalid_state", "fallback_invalid");
    }
    const fallbackCheck = this.lookupFallback(
      ctx,
      registration.fallback_specialist_revision,
    );
    if (fallbackCheck.error) {
      throw new SpecialistRegistryError("invalid_state", fallbackCheck.error);
    }
    const bindingChecks = registration.profile.serving.map((binding) => {
      const model = this.options.catalog.getModel(binding.model_id);
      return { model, binding };
    });
    const configured = bindingChecks.filter(({ model }) => model !== undefined);
    if (configured.length === 0) {
      throw new SpecialistRegistryError(
        "invalid_state",
        "model_not_configured",
      );
    }
    if (
      !configured.some(
        ({ model, binding }) =>
          model?.providerId === binding.provider_id &&
          model.model === binding.provider_model,
      )
    ) {
      throw new SpecialistRegistryError(
        "invalid_state",
        "model_binding_mismatch",
      );
    }
    const now = new Date().toISOString();
    this.store.transaction(() => {
      const pointer = this.store.readProduction(row.scope_key, id);
      const latest = this.store.readSpecialist(row.scope_key, id, revision);
      if (
        (pointer?.production_revision ?? null) !== expectedProductionRevision
      ) {
        throw new SpecialistRegistryError("stale_revision");
      }
      if (!latest || latest.status !== "evaluated") {
        throw new SpecialistRegistryError("invalid_state", "revision_changed");
      }
      const history = pointer ? parseHistory(pointer.history_json) : [];
      if (pointer?.production_revision)
        history.push(pointer.production_revision);
      this.store.db
        .query(
          `UPDATE production SET production_revision = ?, history_json = ?,
           retired = 0, pointer_version = pointer_version + 1, updated_at = ?
           WHERE scope_key = ? AND specialist_id = ?`,
        )
        .run(revision, canonicalJson(history), now, row.scope_key, id);
      this.store.db
        .query(
          `UPDATE specialist_revisions SET verdict_json = ?, updated_at = ?
           WHERE scope_key = ? AND specialist_id = ? AND revision = ?`,
        )
        .run(canonicalJson(verdict), now, row.scope_key, id, revision);
      this.store.writeAudit({
        context: ctx,
        scope_key: row.scope_key,
        action: "production.deployed",
        subject: formatRef("specialist", id, revision),
        detail: {
          expected_production_revision: expectedProductionRevision,
          production_revision: revision,
        },
      });
    });
  }

  async deploy(
    context: RequestContext,
    specialistId: string,
    expectedProductionRevision: string,
  ): Promise<void> {
    const { id, revision } = contractRef(specialistId);
    await this.promote(
      context,
      id,
      revision,
      parseContractRevision(expectedProductionRevision),
    );
  }

  async rollbackTo(
    context: RequestContext,
    id: string,
    expectedProductionRevision: string | null,
  ): Promise<void> {
    const ctx = this.checkContext(context);
    const pointer = this.store.readProduction(scopeKey(ctx.scope), id);
    if (!pointer) throw new SpecialistRegistryError("not_found");
    const { registration: currentRegistration } =
      pointer.production_revision === null
        ? { registration: null }
        : this.specialistRow(ctx, id, pointer.production_revision);
    if (
      currentRegistration &&
      !scopeEquals(currentRegistration.scope, ctx.scope)
    ) {
      throw new SpecialistRegistryError("not_found");
    }
    const history = parseHistory(pointer.history_json);
    const targetRevision = history.at(-1);
    if (targetRevision === undefined) {
      throw new SpecialistRegistryError("invalid_state", "no_rollback_target");
    }
    const { row, registration } = this.specialistRow(ctx, id, targetRevision);
    const verdict = await verifyEvidence(
      ctx,
      registration,
      row.candidate_sha256,
      this.evidenceOptions(),
    );
    if (row.status !== "evaluated" || verdict.status !== "evaluated") {
      throw new SpecialistRegistryError(
        "invalid_state",
        "rollback_target_invalid",
      );
    }
    const now = new Date().toISOString();
    this.store.transaction(() => {
      const latest = this.store.readProduction(row.scope_key, id);
      if (
        (latest?.production_revision ?? null) !== expectedProductionRevision
      ) {
        throw new SpecialistRegistryError("stale_revision");
      }
      if (!latest) throw new SpecialistRegistryError("not_found");
      const latestHistory = parseHistory(latest.history_json);
      if (latestHistory.at(-1) !== targetRevision) {
        throw new SpecialistRegistryError("stale_revision");
      }
      latestHistory.pop();
      if (latest.production_revision !== null) {
        this.store.db
          .query(
            `UPDATE specialist_revisions SET rolled_back_at = ?, updated_at = ?
             WHERE scope_key = ? AND specialist_id = ? AND revision = ?`,
          )
          .run(now, now, row.scope_key, id, latest.production_revision);
      }
      this.store.db
        .query(
          `UPDATE production SET production_revision = ?, history_json = ?,
           retired = 0, pointer_version = pointer_version + 1, updated_at = ?
           WHERE scope_key = ? AND specialist_id = ?`,
        )
        .run(
          targetRevision,
          canonicalJson(latestHistory),
          now,
          row.scope_key,
          id,
        );
      this.store.writeAudit({
        context: ctx,
        scope_key: row.scope_key,
        action: "production.rolled_back",
        subject: formatRef("specialist", id, targetRevision),
        detail: {
          expected_production_revision: expectedProductionRevision,
          production_revision: targetRevision,
        },
      });
    });
  }

  async rollback(
    context: RequestContext,
    specialistId: string,
    expectedProductionRevision: string,
  ): Promise<void> {
    await this.rollbackTo(
      context,
      specialistId,
      parseContractRevision(expectedProductionRevision),
    );
  }

  async retire(
    context: RequestContext,
    specialistId: string,
    expected?: string | null,
  ): Promise<void> {
    const ctx = this.checkContext(context);
    const key = scopeKey(ctx.scope);
    const pointer = this.store.readProduction(key, specialistId);
    if (!pointer) throw new SpecialistRegistryError("not_found");
    const productionRevision = pointer.production_revision;
    if (productionRevision === null) {
      throw new SpecialistRegistryError("invalid_state", "no_production");
    }
    const { registration } = this.specialistRow(
      ctx,
      specialistId,
      productionRevision,
    );
    if (!scopeEquals(registration.scope, ctx.scope)) {
      throw new SpecialistRegistryError("not_found");
    }
    const now = new Date().toISOString();
    this.store.transaction(() => {
      const currentPointer = this.store.readProduction(key, specialistId);
      if (
        expected !== undefined &&
        (currentPointer?.production_revision ?? null) !== expected
      ) {
        throw new SpecialistRegistryError("stale_revision");
      }
      if (
        !currentPointer ||
        currentPointer.production_revision !== productionRevision
      ) {
        throw new SpecialistRegistryError("stale_revision");
      }
      const history = parseHistory(currentPointer.history_json);
      history.push(productionRevision);
      this.store.db
        .query(
          `UPDATE production SET production_revision = NULL, history_json = ?,
           retired = 1, pointer_version = pointer_version + 1, updated_at = ?
           WHERE scope_key = ? AND specialist_id = ?`,
        )
        .run(canonicalJson(history), now, key, specialistId);
      this.store.writeAudit({
        context: ctx,
        scope_key: key,
        action: "production.retired",
        subject: formatRef("specialist", specialistId, productionRevision),
        detail: { retired: true },
      });
    });
  }

  async archive(
    context: RequestContext,
    id: string,
    revision: string,
  ): Promise<void> {
    const ctx = this.checkContext(context);
    const { row } = this.specialistRow(ctx, id, revision);
    if (!scopeEquals(this.verifiedRegistration(row).scope, ctx.scope)) {
      throw new SpecialistRegistryError("not_found");
    }
    const pointer = this.store.readProduction(row.scope_key, id);
    if (pointer?.production_revision === revision) {
      throw new SpecialistRegistryError("invalid_state", "production_revision");
    }
    this.store.transaction(() => {
      this.store.db
        .query(
          `UPDATE specialist_revisions SET status = 'archived', updated_at = ?
           WHERE scope_key = ? AND specialist_id = ? AND revision = ?`,
        )
        .run(new Date().toISOString(), row.scope_key, id, revision);
      this.store.writeAudit({
        context: ctx,
        scope_key: row.scope_key,
        action: "revision.archived",
        subject: formatRef("specialist", id, revision),
        detail: { status: "archived" },
      });
    });
  }

  async requestEvaluation(
    context: RequestContext,
    id: string,
    revision: string,
    budget?: Budget,
  ): Promise<JobRef> {
    const ctx = this.checkContext(context);
    const { row, registration } = this.specialistRow(ctx, id, revision);
    if (!scopeEquals(registration.scope, ctx.scope)) {
      throw new SpecialistRegistryError("not_found");
    }
    if (!this.options.evaluation) {
      throw new SpecialistRegistryError("evaluation_unavailable");
    }
    const pointer = this.store.readProduction(row.scope_key, id);
    const manifest = {
      schema: "mars.specialist-comparison-request/v1",
      subject: {
        specialist_id: id,
        revision,
        candidate_sha256: row.candidate_sha256,
      },
      required_arms: [
        "base",
        "prompt_optimized_baseline",
        "current_specialist",
        "candidate",
      ],
      current_production_revision: pointer?.production_revision ?? null,
      tested_task_coverage: registration.tested_task_coverage,
      acceptance: registration.profile.acceptance,
      roles: registration.profile.roles,
      complexity: registration.profile.complexity,
    };
    this.publish(manifest);
    const bytes = new TextEncoder().encode(canonicalJson(manifest));
    const ref = await this.options.evaluation.artifacts.put(
      ctx,
      bytes,
      "application/json",
    );
    const job = await this.options.evaluation.service.submitComparison(
      ctx,
      ref,
      budget ?? this.options.evaluation.defaultBudget,
    );
    const now = new Date().toISOString();
    this.store.transaction(() => {
      this.store.db
        .query(
          `INSERT INTO evaluation_jobs
           (job_id, scope_key, specialist_id, revision, input_manifest_json, submitted_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          job.job_id,
          row.scope_key,
          id,
          revision,
          canonicalJson(job.input_manifest),
          now,
        );
      this.store.writeAudit({
        context: ctx,
        scope_key: row.scope_key,
        action: "evaluation.delegated",
        subject: formatRef("specialist", id, revision),
        detail: { job_id: job.job_id },
      });
    });
    return job;
  }

  async evaluate(
    context: RequestContext,
    specialistId: string,
  ): Promise<JobRef> {
    const { id, revision } = contractRef(specialistId);
    return this.requestEvaluation(context, id, revision);
  }

  async evaluationJobs(
    context: RequestContext,
    id: string,
    revision: string,
  ): Promise<JobRef[]> {
    const ctx = this.checkContext(context);
    this.specialistRow(ctx, id, revision);
    const rows = this.store.db
      .query(
        `SELECT job_id, input_manifest_json FROM evaluation_jobs
         WHERE scope_key = ? AND specialist_id = ? AND revision = ?
         ORDER BY submitted_at`,
      )
      .all(scopeKey(ctx.scope), id, revision) as Array<{
      job_id: string;
      input_manifest_json: string;
    }>;
    return rows.map((row) => ({
      job_id: row.job_id,
      input_manifest: JSON.parse(row.input_manifest_json) as ArtifactRef,
    }));
  }

  async verifyCompatibility(
    context: RequestContext,
    specialistId: string,
    servingBase: VersionRef,
  ): Promise<{ compatible: boolean; reasons: string[] }> {
    const ctx = this.checkContext(context);
    const { id, revision } = contractRef(specialistId);
    const { registration } = this.visibleSpecialist(ctx, id, revision);
    const compatible = compatibleBase(registration, servingBase);
    return {
      compatible,
      reasons: compatible ? [] : ["serving_base_mismatch"],
    };
  }

  private lookupFallback(
    context: RequestContext,
    start: string,
    fallbackScopeKey = scopeKey(context.scope),
  ): ReturnType<typeof resolveFallbackChain> {
    return resolveFallbackChain(start, (ref) => {
      const parsed = parseRef(ref);
      if (!parsed) return undefined;
      if (parsed.kind === "baseline") {
        const row = this.store.readBaseline(
          fallbackScopeKey,
          parsed.id,
          parsed.revision,
        );
        return row ? null : undefined;
      }
      const row = this.store.readSpecialist(
        fallbackScopeKey,
        parsed.id,
        parsed.revision,
      );
      if (!row) return undefined;
      const registration = this.verifiedRegistration(row);
      return registration.fallback_specialist_revision;
    });
  }

  async invalidateDependency(
    context: RequestContext,
    dependency:
      | { artifact_sha256: string }
      | { component: string; revision: string },
    reason: string,
  ): Promise<{
    invalidated: Array<{ specialist_id: string; revision: string }>;
  }> {
    const ctx = this.checkContext(context);
    if (
      !/^[a-f0-9]{64}$/.test(reason) &&
      !/^[a-z0-9][a-z0-9._:-]{0,127}$/.test(reason)
    ) {
      throw new SpecialistRegistryError("invalid_input", "reason_invalid");
    }
    const key = scopeKey(ctx.scope);
    const rows = this.store.db
      .query(
        `SELECT scope_key, specialist_id, revision, record_json, record_sha256,
          candidate_sha256, status, verdict_json, invalidated_reason,
          rolled_back_at, created_at, updated_at
         FROM specialist_revisions WHERE scope_key = ?`,
      )
      .all(key) as Array<{
      scope_key: string;
      specialist_id: string;
      revision: string;
      record_json: string;
      record_sha256: string;
      candidate_sha256: string;
      status: string;
      verdict_json: string;
      invalidated_reason: string | null;
      rolled_back_at: string | null;
      created_at: string;
      updated_at: string;
    }>;
    const invalidated: Array<{ specialist_id: string; revision: string }> = [];
    for (const row of rows) {
      const registration = this.verifiedRegistration(row);
      const verdict = parseVerdict(row.verdict_json);
      const matches =
        "artifact_sha256" in dependency
          ? [
              registration.chat_template.sha256,
              registration.adapter?.sha256,
              registration.evaluation.sha256,
              registration.dataset_lineage?.sha256,
              ...verdict.evidence_artifacts,
              ...verdict.lineage_dataset_sha256s,
            ].includes(dependency.artifact_sha256)
          : [
              registration.base_model,
              registration.tokenizer,
              ...registration.tools,
              ...registration.skills,
              ...registration.knowledge,
              ...(registration.profile.adapter_spec
                ? [
                    registration.profile.adapter_spec.base_model,
                    registration.profile.adapter_spec.tokenizer,
                  ]
                : []),
            ].some(
              (ref) =>
                ref.component === dependency.component &&
                ref.revision === dependency.revision,
            );
      if (matches)
        invalidated.push({
          specialist_id: row.specialist_id,
          revision: row.revision,
        });
    }
    this.store.transaction(() => {
      for (const item of invalidated) {
        this.store.db
          .query(
            `UPDATE specialist_revisions SET status = 'invalidated',
             invalidated_reason = ?, updated_at = ?
             WHERE scope_key = ? AND specialist_id = ? AND revision = ?`,
          )
          .run(
            reason,
            new Date().toISOString(),
            key,
            item.specialist_id,
            item.revision,
          );
      }
      this.store.writeAudit({
        context: ctx,
        scope_key: key,
        action: "dependency.invalidated",
        subject: "dependency",
        detail: { dependency, invalidated, reason },
      });
    });
    return { invalidated };
  }

  async audit(
    context: RequestContext,
    filter?: { action?: string; subject?: string },
  ): Promise<
    Array<{
      seq: number;
      at: string;
      actor: string;
      action: string;
      subject: string;
      detail: unknown;
      prev_sha256: string;
      sha256: string;
    }>
  > {
    const ctx = this.checkContext(context);
    const events = this.store.audit(ctx, scopeKey(ctx.scope));
    return events.filter(
      (event) =>
        (filter?.action === undefined || event.action === filter.action) &&
        (filter?.subject === undefined || event.subject === filter.subject),
    );
  }

  close(): void {
    this.store.close();
  }

  private async resolveGate(
    context: RequestContext,
    registration: SpecialistRegistration,
    candidateSha: string,
    storedStatus: string,
    storedVerdict: EvidenceVerdict,
    request: RoutingRequest,
  ): Promise<{
    reasons: ReasonCode[];
    target: SelectedTarget | null;
    triple?: TripleGate;
    pass_rate: number;
    cost_usd_per_task: number | null;
    runtime_ms_p95: number | null;
  }> {
    const reasons = new Set<ReasonCode>();
    if (storedStatus === "invalidated") reasons.add("invalidated");
    if (storedStatus === "archived") reasons.add("archived");
    if (storedStatus !== "evaluated" || storedVerdict.status !== "evaluated") {
      reasons.add("status_not_evaluated");
    }
    const verdict = await verifyEvidence(
      context,
      registration,
      candidateSha,
      this.evidenceOptions(),
    );
    verdict.codes.forEach((code) => {
      reasons.add(code);
    });

    const domainMatches = storedVerdict.covered_triples.filter(
      (item) => item.domain === request.domain,
    );
    const roleMatches = domainMatches.filter(
      (item) => item.role === request.role,
    );
    const complexityMatches = roleMatches.filter(
      (item) => item.complexity === request.complexity,
    );
    if (
      !registration.tested_task_coverage.includes(request.domain) ||
      domainMatches.length === 0
    ) {
      reasons.add("domain_not_covered");
    } else if (roleMatches.length === 0) {
      reasons.add("role_not_covered");
    } else if (complexityMatches.length === 0) {
      reasons.add("complexity_not_covered");
    }
    const triple = complexityMatches[0];
    if (triple && !triple.passed) reasons.add("evaluation_gate_failed");
    if (triple) {
      const bindings = await checkSpecialistBindings(
        context,
        registration,
        request,
        {
          cost_usd_per_task: triple.cost_usd_per_task,
          runtime_ms_p95: triple.runtime_ms_p95,
        },
        this.compatibilityOptions,
      );
      const passing = firstPassingBinding(bindings);
      if (!passing) {
        for (const binding of bindings) {
          binding.reasons.forEach((reason) => {
            reasons.add(reason);
          });
        }
      } else if (request.independence?.policy !== "none") {
        const independent = this.checkIndependence(
          context,
          registration,
          passing.binding.model_id,
          request.independence?.from ?? [],
          request.independence?.policy ?? "none",
        );
        independent.forEach((reason) => {
          reasons.add(reason);
        });
        if (independent.size === 0 && reasons.size === 0) {
          const target = makeSelectedSpecialist(
            registration,
            { candidate_sha256: candidateSha },
            storedVerdict,
            passing,
            triple,
          );
          return {
            reasons: normalizeReasons(reasons),
            target,
            triple,
            pass_rate: triple.pass_rate,
            cost_usd_per_task: triple.cost_usd_per_task,
            runtime_ms_p95: triple.runtime_ms_p95,
          };
        }
      } else if (reasons.size === 0) {
        const target = makeSelectedSpecialist(
          registration,
          { candidate_sha256: candidateSha },
          storedVerdict,
          passing,
          triple,
        );
        return {
          reasons: normalizeReasons(reasons),
          target,
          triple,
          pass_rate: triple.pass_rate,
          cost_usd_per_task: triple.cost_usd_per_task,
          runtime_ms_p95: triple.runtime_ms_p95,
        };
      }
    }
    return {
      reasons: normalizeReasons(reasons),
      target: null,
      ...(triple ? { triple } : {}),
      pass_rate: triple?.pass_rate ?? 0,
      cost_usd_per_task: triple?.cost_usd_per_task ?? null,
      runtime_ms_p95: triple?.runtime_ms_p95 ?? null,
    };
  }

  private checkIndependence(
    context: RequestContext,
    registration: SpecialistRegistration,
    modelId: string,
    from: unknown[],
    policy: "none" | "distinct_model" | "distinct_lineage",
  ): Set<ReasonCode> {
    const reasons = new Set<ReasonCode>();
    if (policy === "none") return reasons;
    for (const item of from) {
      if (!item || typeof item !== "object") continue;
      const target = item as Partial<SelectedTarget>;
      if (target.model_id === modelId) reasons.add("independence_same_model");
      if (policy === "distinct_lineage") {
        const sameBase =
          registration.base_model !== undefined &&
          target.base_model !== null &&
          target.base_model?.component === registration.base_model.component;
        const candidateLineage = registration.dataset_lineage?.sha256 ?? null;
        let targetLineage: string | null = null;
        if (
          target.kind === "specialist" &&
          typeof target.specialist_id === "string" &&
          target.revision
        ) {
          try {
            targetLineage =
              this.visibleSpecialist(
                context,
                target.specialist_id,
                target.revision,
              ).registration.dataset_lineage?.sha256 ?? null;
          } catch (error) {
            if (
              !(error instanceof SpecialistRegistryError) ||
              error.code !== "not_found"
            ) {
              throw error;
            }
          }
        }
        const baselineIdentity =
          target.kind === "baseline" &&
          target.provider_id !== undefined &&
          target.provider_model !== undefined
            ? `${target.provider_id}/${target.provider_model}`
            : null;
        if (
          sameBase ||
          (candidateLineage !== null && candidateLineage === targetLineage) ||
          (baselineIdentity !== null &&
            registration.base_model.component === baselineIdentity)
        ) {
          reasons.add("independence_same_lineage");
        }
      }
    }
    return reasons;
  }

  private async tryBaseline(
    _context: RequestContext,
    profile: BaselineProfile,
    request: RoutingRequest,
  ): Promise<{ target: SelectedTarget | null; reasons: ReasonCode[] }> {
    if (!profile.roles.includes(request.role)) {
      return { target: null, reasons: ["role_not_covered"] };
    }
    if (!profile.complexity.includes(request.complexity)) {
      return { target: null, reasons: ["complexity_not_covered"] };
    }
    const binding: BindingCompatibility = baselineCompatibility(
      {
        model_id: profile.model_id,
        provider_id: profile.provider_id,
        provider_model: profile.provider_model,
      },
      this.options.catalog,
      request,
    );
    if (request.independence?.policy !== "none") {
      for (const item of request.independence?.from ?? []) {
        const prior = item as Partial<SelectedTarget>;
        if (prior.model_id === profile.model_id) {
          binding.reasons.push("independence_same_model");
        }
        if (
          request.independence?.policy === "distinct_lineage" &&
          ((prior.kind === "baseline" &&
            prior.provider_id === profile.provider_id &&
            prior.provider_model === profile.provider_model) ||
            (prior.kind === "specialist" &&
              prior.base_model?.component ===
                `${profile.provider_id}/${profile.provider_model}`))
        ) {
          binding.reasons.push("independence_same_lineage");
        }
      }
    }
    if (binding.reasons.length > 0) {
      return { target: null, reasons: normalizeReasons(binding.reasons) };
    }
    return { target: makeSelectedBaseline(profile, binding), reasons: [] };
  }

  async route(
    context: RequestContext,
    request: RoutingRequest,
  ): Promise<RoutingDecision> {
    const ctx = this.checkContext(context);
    return this.routeWithMeta(ctx, request, { retry_of: null, attempt: 0 });
  }

  private async routeWithMeta(
    context: RequestContext,
    input: RoutingRequest,
    meta: RouteMeta,
    forceUnavailable = false,
  ): Promise<RoutingDecision> {
    const parsedRequest = RoutingRequestSchema.safeParse(input);
    if (!parsedRequest.success) {
      throw new SpecialistRegistryError(
        "invalid_input",
        "routing_request_invalid",
      );
    }
    const request = parsedRequest.data;
    this.publish(request);
    const scope = scopeKey(context.scope);
    const rejected: Array<{ ref: string; reasons: ReasonCode[] }> = [];
    const ranking: Array<{
      ref: string;
      pass_rate: number;
      cost_usd_per_task: number | null;
      runtime_ms_p95: number | null;
    }> = [];
    const now = new Date().toISOString();
    const excluded = new Set(request.exclude_refs ?? []);

    const persist = (
      outcome: RoutingDecision["outcome"],
      selected: SelectedTarget | null,
      fallback: RoutingDecision["fallback"],
      explanations: string[],
      override = request.override !== undefined,
    ): RoutingDecision => {
      const decision = makeRoutingDecision({
        schema_version: 1,
        decision_id: randomUUID(),
        task_id: request.task_id,
        role: request.role,
        domain: request.domain,
        complexity: request.complexity,
        outcome,
        override,
        selected,
        fallback,
        rejected: [...rejected]
          .map((item) => ({
            ref: item.ref,
            reasons: noReasonDuplicates(item.reasons),
          }))
          .sort((left, right) => left.ref.localeCompare(right.ref)),
        ranking,
        explanation: explanations,
        retry_of: meta.retry_of,
        attempt: meta.attempt,
        created_at: now,
      });
      this.publish(decision);
      this.publish(decision.explanation);
      this.store.transaction(() => {
        this.store.db
          .query(
            `INSERT INTO routing_decisions
             (decision_id, scope_key, task_id, request_json, decision_json,
              decision_sha256, retry_of, attempt, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            decision.decision_id,
            scope,
            request.task_id,
            canonicalJson(request),
            canonicalJson(decision),
            decision.decision_sha256,
            decision.retry_of,
            decision.attempt,
            decision.created_at,
          );
        this.store.writeAudit({
          context,
          scope_key: scope,
          action: "routing.decided",
          subject: decision.decision_id,
          detail: {
            decision_sha256: decision.decision_sha256,
            outcome: decision.outcome,
            selected_ref: decision.selected?.ref ?? null,
          },
        });
      });
      return decision;
    };

    if (request.override) {
      const parsedRef = parseRef(request.override.ref);
      if (!parsedRef) {
        rejected.push({
          ref: request.override.ref,
          reasons: ["override_not_found"],
        });
        return persist("override_rejected", null, null, ["override_not_found"]);
      }
      if (excluded.has(request.override.ref)) {
        rejected.push({ ref: request.override.ref, reasons: ["excluded"] });
        return persist("override_rejected", null, null, [
          `override_rejected:${request.override.ref}:excluded`,
        ]);
      }
      if (parsedRef.kind === "specialist") {
        let visibleRevision: ReturnType<
          SpecialistRegistry["visibleSpecialist"]
        >;
        try {
          visibleRevision = this.visibleSpecialist(
            context,
            parsedRef.id,
            parsedRef.revision,
          );
        } catch (error) {
          if (
            !(error instanceof SpecialistRegistryError) ||
            error.code !== "not_found"
          ) {
            throw error;
          }
          rejected.push({
            ref: request.override.ref,
            reasons: ["override_not_found"],
          });
          return persist("override_rejected", null, null, [
            "override_not_found",
          ]);
        }
        const { row, registration } = visibleRevision;
        const verdict = parseVerdict(row.verdict_json);
        const gate = await this.resolveGate(
          context,
          registration,
          row.candidate_sha256,
          row.status,
          verdict,
          request,
        );
        if (gate.target) {
          const explanation = [
            `override_selected:${gate.target.ref}`,
            `candidate_pass_rate:${gate.pass_rate}`,
            `serving_attestation:${gate.target.serving_attestation}`,
          ];
          if (verdict.synthetic_fixture) {
            explanation.push(
              "Evidence is a synthetic fixture; it is not a real evaluation and supports no quality claim.",
            );
          }
          return persist("specialist", gate.target, null, explanation, true);
        }
        rejected.push({
          ref: request.override.ref,
          reasons: gate.reasons,
        });
        return persist(
          "override_rejected",
          null,
          null,
          gate.reasons.map((reason) => `override_rejected:${reason}`),
          true,
        );
      }
      let visibleBaseline: ReturnType<SpecialistRegistry["visibleBaseline"]>;
      try {
        visibleBaseline = this.visibleBaseline(
          context,
          parsedRef.id,
          parsedRef.revision,
        );
      } catch (error) {
        if (
          !(error instanceof SpecialistRegistryError) ||
          error.code !== "not_found"
        ) {
          throw error;
        }
        rejected.push({
          ref: request.override.ref,
          reasons: ["override_not_found"],
        });
        return persist(
          "override_rejected",
          null,
          null,
          ["override_not_found"],
          true,
        );
      }
      const { row, profile } = visibleBaseline;
      if (row.status !== "active") {
        rejected.push({
          ref: request.override.ref,
          reasons: ["override_not_found"],
        });
        return persist(
          "override_rejected",
          null,
          null,
          ["override_not_found"],
          true,
        );
      }
      const result = await this.tryBaseline(context, profile, request);
      if (!result.target) {
        rejected.push({
          ref: request.override.ref,
          reasons: result.reasons,
        });
        return persist(
          "override_rejected",
          null,
          null,
          result.reasons.map((reason) => `override_rejected:${reason}`),
          true,
        );
      }
      return persist(
        "baseline",
        result.target,
        null,
        [`override_selected:${result.target.ref}`],
        true,
      );
    }

    if (forceUnavailable) {
      return persist(
        "unavailable",
        null,
        null,
        [`fallback_attempt_cap:8`],
        false,
      );
    }

    const visibleScopeKeys = [
      scopeKey(context.scope),
      scopeKey({
        owner_id: context.scope.owner_id,
        project_id: context.scope.project_id,
      }),
    ];
    const uniqueVisibleScopeKeys = [...new Set(visibleScopeKeys)];
    const pointerRows = this.store.db
      .query(
        `SELECT scope_key, specialist_id, production_revision, history_json,
          retired, pointer_version, updated_at FROM production
         WHERE production_revision IS NOT NULL AND retired = 0
          AND scope_key IN (${uniqueVisibleScopeKeys.map(() => "?").join(", ")})
         ORDER BY specialist_id`,
      )
      .all(...uniqueVisibleScopeKeys) as ProductionRow[];
    const candidates: CandidateResult[] = [];
    for (const pointer of pointerRows) {
      if (!pointer.production_revision) continue;
      const ref = formatRef(
        "specialist",
        pointer.specialist_id,
        pointer.production_revision,
      );
      const excludedCandidate = excluded.has(ref);
      const row = this.store.readSpecialist(
        pointer.scope_key,
        pointer.specialist_id,
        pointer.production_revision,
      );
      if (!row) {
        throw new SpecialistRegistryError("corrupt_record");
      }
      const registration = this.verifiedRegistration(row);
      if (!visible(registration.scope, context)) continue;
      const verdict = parseVerdict(row.verdict_json);
      const gate = await this.resolveGate(
        context,
        registration,
        row.candidate_sha256,
        row.status,
        verdict,
        request,
      );
      const exactCoverage = verdict.covered_triples.some(
        (item) =>
          item.domain === request.domain &&
          item.role === request.role &&
          item.complexity === request.complexity,
      );
      const candidateReasons = excludedCandidate
        ? normalizeReasons([...gate.reasons, "excluded"])
        : gate.reasons;
      const candidateTarget = excludedCandidate ? null : gate.target;
      candidates.push({
        ref,
        specialist_id: registration.specialist_id,
        revision: registration.revision,
        registration,
        candidate_sha256: row.candidate_sha256,
        verdict,
        reasons: candidateReasons,
        target: candidateTarget,
        pass_rate: gate.pass_rate,
        cost_usd_per_task: gate.cost_usd_per_task,
        runtime_ms_p95: gate.runtime_ms_p95,
        covering: exactCoverage,
        production: pointer,
      });
      if (candidateTarget) {
        ranking.push({
          ref: candidateTarget.ref,
          pass_rate: gate.pass_rate,
          cost_usd_per_task: gate.cost_usd_per_task,
          runtime_ms_p95: gate.runtime_ms_p95,
        });
      } else {
        rejected.push({
          ref,
          reasons: candidateReasons,
        });
      }
    }
    const eligible = rankCandidates(
      candidates.filter(
        (candidate) =>
          candidate.target !== null && candidate.reasons.length === 0,
      ),
    );
    ranking.splice(
      0,
      ranking.length,
      ...eligible.map((candidate) => ({
        ref: formatRef(
          "specialist",
          candidate.registration.specialist_id,
          candidate.registration.revision,
        ),
        pass_rate: candidate.pass_rate,
        cost_usd_per_task: candidate.cost_usd_per_task,
        runtime_ms_p95: candidate.runtime_ms_p95,
      })),
    );
    if (eligible.length > 0) {
      const chosen = eligible[0];
      if (!chosen?.target) throw new SpecialistRegistryError("corrupt_record");
      const explanation = [
        `selected:${chosen.target.ref}`,
        `candidate_pass_rate:${chosen.pass_rate}`,
        `candidate_cost_usd_per_task:${chosen.cost_usd_per_task ?? "null"}`,
        `candidate_runtime_ms_p95:${chosen.runtime_ms_p95 ?? "null"}`,
        `serving_attestation:${chosen.target.serving_attestation}`,
      ];
      if (chosen.verdict.synthetic_fixture) {
        explanation.push(
          "Evidence is a synthetic fixture; it is not a real evaluation and supports no quality claim.",
        );
      }
      return persist("specialist", chosen.target, null, explanation, false);
    }

    if (forceUnavailable) {
      return persist(
        "unavailable",
        null,
        null,
        ["fallback_attempt_cap:8"],
        false,
      );
    }
    const coverageCandidates = rankCandidates(
      candidates.filter((candidate) => candidate.covering),
    );
    const fallbackReason =
      coverageCandidates.length > 0
        ? "intended_specialist_ineligible"
        : "no_covering_specialist";
    const chainRecords: Array<{ ref: string; reasons: ReasonCode[] }> = [];
    const visited = new Set<string>();
    let selectedFallback: SelectedTarget | null = null;
    let fallbackFrom: string | null = null;

    if (coverageCandidates.length > 0) {
      for (const candidate of coverageCandidates.slice(0, 1)) {
        const fromRef = formatRef(
          "specialist",
          candidate.registration.specialist_id,
          candidate.registration.revision,
        );
        const resolved = this.lookupFallback(
          context,
          candidate.registration.fallback_specialist_revision,
          scopeKey(candidate.registration.scope),
        );
        if (resolved.error) {
          const code = resolved.error as ReasonCode;
          chainRecords.push({
            ref: candidate.registration.fallback_specialist_revision,
            reasons: [code],
          });
          rejected.push({
            ref: candidate.registration.fallback_specialist_revision,
            reasons: [code],
          });
          continue;
        }
        for (const ref of resolved.chain) {
          if (visited.has(ref)) {
            chainRecords.push({ ref, reasons: ["fallback_cycle"] });
            continue;
          }
          visited.add(ref);
          if (excluded.has(ref)) {
            chainRecords.push({ ref, reasons: ["excluded"] });
            rejected.push({ ref, reasons: ["excluded"] });
            continue;
          }
          const parsed = parseRef(ref);
          if (!parsed) {
            chainRecords.push({ ref, reasons: ["fallback_target_missing"] });
            rejected.push({ ref, reasons: ["fallback_target_missing"] });
            continue;
          }
          if (parsed.kind === "specialist") {
            const row = this.store.readSpecialist(
              scopeKey(candidate.registration.scope),
              parsed.id,
              parsed.revision,
            );
            if (!row) {
              chainRecords.push({
                ref,
                reasons: ["fallback_target_missing"],
              });
              rejected.push({
                ref,
                reasons: ["fallback_target_missing"],
              });
              continue;
            }
            const registration = this.verifiedRegistration(row);
            if (!visible(registration.scope, context)) {
              chainRecords.push({ ref, reasons: ["fallback_target_missing"] });
              rejected.push({
                ref,
                reasons: ["fallback_target_missing"],
              });
              continue;
            }
            const verdict = parseVerdict(row.verdict_json);
            const gate = await this.resolveGate(
              context,
              registration,
              row.candidate_sha256,
              row.status,
              verdict,
              request,
            );
            chainRecords.push({ ref, reasons: gate.reasons });
            if (gate.target) {
              selectedFallback = gate.target;
              fallbackFrom = fromRef;
              break;
            }
            rejected.push({ ref, reasons: gate.reasons });
          } else {
            const row = this.store.readBaseline(
              scopeKey(candidate.registration.scope),
              parsed.id,
              parsed.revision,
            );
            if (!row || row.status !== "active") {
              chainRecords.push({ ref, reasons: ["fallback_target_missing"] });
              rejected.push({
                ref,
                reasons: ["fallback_target_missing"],
              });
              continue;
            }
            const profile = this.store.parseRecord(
              row.record_json,
              row.record_sha256,
              parseBaseline,
            );
            if (!visible(profile.scope, context)) {
              chainRecords.push({ ref, reasons: ["fallback_target_missing"] });
              rejected.push({
                ref,
                reasons: ["fallback_target_missing"],
              });
              continue;
            }
            const baselineResult = await this.tryBaseline(
              context,
              profile,
              request,
            );
            chainRecords.push({ ref, reasons: baselineResult.reasons });
            if (baselineResult.target) {
              selectedFallback = baselineResult.target;
              fallbackFrom = fromRef;
              break;
            }
            rejected.push({ ref, reasons: baselineResult.reasons });
          }
        }
        if (selectedFallback) break;
      }
    }

    if (!selectedFallback) {
      const baselineRows = this.store.db
        .query(
          `SELECT scope_key, baseline_id, revision, record_json, record_sha256,
            status, created_at FROM baselines WHERE status = 'active'
            AND scope_key IN (${uniqueVisibleScopeKeys.map(() => "?").join(", ")})`,
        )
        .all(...uniqueVisibleScopeKeys) as BaselineRow[];
      baselineRows.sort(
        (left, right) =>
          Number(right.scope_key === scopeKey(context.scope)) -
          Number(left.scope_key === scopeKey(context.scope)),
      );
      const baselines = baselineRows
        .map((row) => ({
          row,
          profile: this.store.parseRecord(
            row.record_json,
            row.record_sha256,
            parseBaseline,
          ),
        }))
        .filter(
          ({ profile }) =>
            visible(profile.scope, context) &&
            profile.roles.includes(request.role) &&
            profile.complexity.includes(request.complexity),
        )
        .sort((left, right) => {
          const leftModel = this.options.catalog.getModel(
            left.profile.model_id,
          );
          const rightModel = this.options.catalog.getModel(
            right.profile.model_id,
          );
          return (
            left.profile.priority - right.profile.priority ||
            Number(leftModel?.pricing.free !== true) -
              Number(rightModel?.pricing.free !== true) ||
            left.profile.baseline_id.localeCompare(right.profile.baseline_id) ||
            left.profile.revision.localeCompare(right.profile.revision)
          );
        });
      for (const { profile } of baselines) {
        const ref = formatRef(
          "baseline",
          profile.baseline_id,
          profile.revision,
        );
        if (excluded.has(ref)) {
          chainRecords.push({ ref, reasons: ["excluded"] });
          rejected.push({ ref, reasons: ["excluded"] });
          continue;
        }
        const result = await this.tryBaseline(context, profile, request);
        chainRecords.push({ ref, reasons: result.reasons });
        if (result.target) {
          selectedFallback = result.target;
          fallbackFrom = coverageCandidates.length
            ? formatRef(
                "specialist",
                coverageCandidates[0]?.registration.specialist_id ?? "",
                coverageCandidates[0]?.registration.revision ?? "",
              )
            : null;
          break;
        }
        rejected.push({ ref, reasons: result.reasons });
      }
    }

    if (selectedFallback) {
      const explanation = [
        `fallback:${fallbackReason}`,
        `fallback_selected:${selectedFallback.ref}`,
      ];
      const fallbackVerdict =
        selectedFallback.kind === "specialist" &&
        selectedFallback.specialist_id !== null
          ? (() => {
              const { row } = this.visibleSpecialist(
                context,
                selectedFallback.specialist_id as string,
                selectedFallback.revision,
              );
              return parseVerdict(row.verdict_json);
            })()
          : null;
      if (fallbackVerdict?.synthetic_fixture) {
        explanation.push(
          "Evidence is a synthetic fixture; it is not a real evaluation and supports no quality claim.",
        );
      }
      return persist(
        selectedFallback.kind,
        selectedFallback,
        {
          reason_code: fallbackReason,
          from: fallbackFrom,
          chain: chainRecords,
        },
        explanation,
        false,
      );
    }
    return persist(
      "unavailable",
      null,
      {
        reason_code: fallbackReason,
        from:
          coverageCandidates.length > 0
            ? formatRef(
                "specialist",
                coverageCandidates[0]?.registration.specialist_id ?? "",
                coverageCandidates[0]?.registration.revision ?? "",
              )
            : null,
        chain: chainRecords,
      },
      [`unavailable:${fallbackReason}`],
      false,
    );
  }

  async decision(
    context: RequestContext,
    decisionId: string,
  ): Promise<RoutingDecision> {
    const ctx = this.checkContext(context);
    const row = this.store.db
      .query(
        `SELECT decision_id, scope_key, task_id, request_json, decision_json,
          decision_sha256, retry_of, attempt, created_at
         FROM routing_decisions WHERE decision_id = ?`,
      )
      .get(decisionId) as {
      decision_id: string;
      scope_key: string;
      task_id: string;
      request_json: string;
      decision_json: string;
      decision_sha256: string;
      retry_of: string | null;
      attempt: number;
      created_at: string;
    } | null;
    if (!row || row.scope_key !== scopeKey(ctx.scope)) {
      throw new SpecialistRegistryError("not_found");
    }
    let value: unknown;
    try {
      value = JSON.parse(row.decision_json) as unknown;
    } catch {
      throw new SpecialistRegistryError("corrupt_record");
    }
    const parsed = RoutingDecisionSchema.safeParse(value);
    if (
      !parsed.success ||
      parsed.data.decision_sha256 !== row.decision_sha256 ||
      decisionDigest(parsed.data as unknown as Record<string, unknown>) !==
        row.decision_sha256
    ) {
      throw new SpecialistRegistryError("corrupt_record");
    }
    this.publish(parsed.data);
    return parsed.data;
  }

  async fallbackAfterFailure(
    context: RequestContext,
    decisionId: string,
    failure: {
      ref: string;
      side_effects: "none" | "output_emitted" | "tools_executed" | "unknown";
    },
  ): Promise<RoutingDecision> {
    const ctx = this.checkContext(context);
    const prior = await this.decision(ctx, decisionId);
    if (!prior.selected || prior.selected.ref !== failure.ref) {
      throw new SpecialistRegistryError(
        "invalid_input",
        "failure_ref_mismatch",
      );
    }
    if (failure.side_effects !== "none") {
      throw new SpecialistRegistryError("fallback_after_side_effects");
    }
    const lineage: Array<{
      decision_id: string;
      request_json: string;
      retry_of: string | null;
      attempt: number;
      selected_ref: string | null;
      rejected_json: string;
    }> = [];
    let currentId: string | null = decisionId;
    const seen = new Set<string>();
    while (currentId && !seen.has(currentId)) {
      seen.add(currentId);
      const row = this.store.db
        .query(
          `SELECT decision_id, request_json, retry_of, attempt, decision_json
           FROM routing_decisions WHERE decision_id = ? AND scope_key = ?`,
        )
        .get(currentId, scopeKey(ctx.scope)) as {
        decision_id: string;
        request_json: string;
        retry_of: string | null;
        attempt: number;
        decision_json: string;
      } | null;
      if (!row) break;
      const decision = JSON.parse(row.decision_json) as RoutingDecision;
      lineage.push({
        decision_id: row.decision_id,
        request_json: row.request_json,
        retry_of: row.retry_of,
        attempt: row.attempt,
        selected_ref: decision.selected?.ref ?? null,
        rejected_json: JSON.stringify(
          decision.rejected.map((item) => item.ref),
        ),
      });
      currentId = row.retry_of;
    }
    const requestRow = this.store.db
      .query(
        "SELECT request_json, attempt FROM routing_decisions WHERE decision_id = ? AND scope_key = ?",
      )
      .get(decisionId, scopeKey(ctx.scope)) as {
      request_json: string;
      attempt: number;
    } | null;
    if (!requestRow) throw new SpecialistRegistryError("not_found");
    let storedRequest: RoutingRequest;
    try {
      storedRequest = RoutingRequestSchema.parse(
        JSON.parse(requestRow.request_json) as unknown,
      );
    } catch {
      throw new SpecialistRegistryError("corrupt_record");
    }
    const exclusions = new Set(storedRequest.exclude_refs ?? []);
    for (const item of lineage) {
      if (item.selected_ref) exclusions.add(item.selected_ref);
      try {
        for (const ref of JSON.parse(item.rejected_json) as string[]) {
          exclusions.add(ref);
        }
      } catch {
        throw new SpecialistRegistryError("corrupt_record");
      }
    }
    exclusions.add(failure.ref);
    const attempt = requestRow.attempt + 1;
    const { override: _override, ...requestWithoutOverride } = storedRequest;
    const retryRequest = {
      ...requestWithoutOverride,
      exclude_refs: [...exclusions].sort(),
    };
    return this.routeWithMeta(
      ctx,
      retryRequest,
      { retry_of: decisionId, attempt },
      attempt >= 8,
    );
  }

  async routeTeam(
    context: RequestContext,
    input: {
      schema_version: 1;
      task_id: string;
      domain: string;
      complexity: Complexity;
      requires: RoutingRequest["requires"];
      budget: Budget;
      paid_consent: boolean;
      lead?: { complexity?: Complexity; override?: { ref: string } };
      worker?: { complexity?: Complexity; override?: { ref: string } };
      reviewer?: {
        complexity?: Complexity;
        override?: { ref: string };
        independence?: "none" | "distinct_model" | "distinct_lineage";
      };
    },
  ): Promise<{
    lead?: RoutingDecision;
    worker?: RoutingDecision;
    reviewer?: RoutingDecision;
  }> {
    const ctx = this.checkContext(context);
    if (input.schema_version !== 1) {
      throw new SpecialistRegistryError(
        "invalid_input",
        "team_request_invalid",
      );
    }
    const result: {
      lead?: RoutingDecision;
      worker?: RoutingDecision;
      reviewer?: RoutingDecision;
    } = {};
    const shared = {
      schema_version: 1 as const,
      task_id: input.task_id,
      domain: input.domain,
      requires: input.requires,
      budget: input.budget,
      paid_consent: input.paid_consent,
    };
    if (input.lead) {
      result.lead = await this.route(ctx, {
        ...shared,
        role: "lead",
        complexity: input.lead.complexity ?? input.complexity,
        ...(input.lead.override ? { override: input.lead.override } : {}),
      });
    }
    if (input.worker) {
      result.worker = await this.route(ctx, {
        ...shared,
        role: "worker",
        complexity: input.worker.complexity ?? input.complexity,
        ...(input.worker.override ? { override: input.worker.override } : {}),
      });
    }
    if (input.reviewer) {
      const from = [result.lead?.selected, result.worker?.selected].filter(
        (item): item is SelectedTarget => item !== null && item !== undefined,
      );
      result.reviewer = await this.route(ctx, {
        ...shared,
        role: "reviewer",
        complexity: input.reviewer.complexity ?? input.complexity,
        ...(input.reviewer.override
          ? { override: input.reviewer.override }
          : {}),
        independence: {
          policy: input.reviewer.independence ?? "distinct_model",
          from,
        },
      });
    }
    return result;
  }

  async select(
    context: RequestContext,
    task: Task,
  ): Promise<{ manifest: SpecialistManifest; reason: string }> {
    if (!this.options.taskRouting) {
      throw new SpecialistRegistryError(
        "invalid_input",
        "task_routing_unconfigured",
      );
    }
    const request = this.options.taskRouting(task);
    const decision = await this.route(context, request);
    if (decision.outcome === "specialist" && decision.selected?.specialist_id) {
      const registration = this.visibleSpecialist(
        context,
        decision.selected.specialist_id,
        decision.selected.revision,
      ).registration;
      return {
        manifest: registration,
        reason: decision.explanation.join(" "),
      };
    }
    if (decision.outcome === "baseline") {
      throw new SpecialistRegistryError(
        "baseline_selected",
        undefined,
        decision,
      );
    }
    throw new SpecialistRegistryError(
      "no_eligible_target",
      undefined,
      decision,
    );
  }
}

export function createSpecialistRegistry(
  options: SpecialistRegistryOptions,
): SpecialistRegistry {
  return new SpecialistRegistry(options);
}
