import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { Budget } from "@mars/contracts";
import type { SandboxRunner } from "@mars/workspaces";
import { z } from "zod";
import { EvolutionError, fail } from "./errors";
import type { CandidateEvaluator, EvaluationRequest } from "./evaluators";
import {
  assertDisjointRoots,
  assertNoHoldoutLeak,
  assertTreeChangeAllowed,
  digestControlPath,
  digestControlPaths,
  verifyControlDigests,
} from "./guard";
import type { MutationProposer, ProposalContext } from "./proposers";
import {
  AGENT_MANIFEST_SCHEMA,
  type AgentManifest,
  AgentManifestSchema,
  type EvaluationOutcome,
  EvaluationOutcomeSchema,
  type Gate,
  IdSchema,
  type Interval,
  MutationProposalSchema,
  type PromotionDecision,
  PromotionDecisionSchema,
  type RunConfig,
  type RunConfigInput,
  RunConfigSchema,
  type Split,
} from "./schemas";
import {
  type ArchiveMember,
  admitToArchive,
  chooseEntry,
  selectParents,
} from "./selection";
import { mean, pairedInterval, strictMean } from "./stats";
import {
  type CandidateRow,
  type ChampionEntryRow,
  EvolutionStore,
} from "./store";
import {
  applyPatch,
  enforcePathPolicy,
  materialize,
  parsePatch,
  snapshotDirectory,
  type TreeEntry,
} from "./tree";
import {
  bounded,
  canonicalJson,
  digestOf,
  scrubSecrets,
  seededRandom,
  sha256,
} from "./util";

export interface EvolutionServiceOptions {
  /** Host control root: holds the SQLite store. Must be disjoint from `workDir`. */
  storeDir: string;
  /** Root for per-candidate build/eval workspaces. */
  workDir: string;
  evaluator: CandidateEvaluator;
  proposer: MutationProposer;
  /** Runs candidate builds (Docker sandbox in production, process sandbox offline). */
  sandbox: SandboxRunner;
  gitPath?: string;
  /** Absolute host paths a candidate must never change (evaluator config, permission policy, ...). */
  protectedControlPaths?: string[];
  /** Absolute hidden-answer / holdout files: digest-pinned and never allowed into a harness tree. */
  hiddenAnswerPaths?: string[];
  holder?: string;
  leaseTtlMs?: number;
  now?: () => number;
}

export interface StartRunInput {
  config: RunConfigInput;
  scope_key: string;
  /** Directory with the frozen base harness tree (copied into the store). */
  base_dir: string;
  base_ref: string;
  model: AgentManifest["model"];
  prompts: AgentManifest["prompts"];
  skills: AgentManifest["skills"];
  tools: AgentManifest["tools"];
  retrieval: AgentManifest["retrieval"];
}

const ControlSchema = z
  .object({
    evaluator_digest: z.string(),
    simulated: z.boolean(),
    proposer_id: z.string(),
    control_digests: z.record(z.string()),
    hidden_digests: z.array(z.string()),
    created_ms: z.number(),
  })
  .strict();
type Control = z.infer<typeof ControlSchema>;

interface SelectionRecord {
  score: number;
  per_task: { task_id: string; mean: number; rewards: (number | null)[] }[];
  stages_completed: number;
  unresolved: string[];
  unstable: string[];
  admitted: boolean;
  tree_sha256: string;
  build: {
    reproducible: boolean;
    bundle_sha256: string;
    changed_paths: string[];
  };
}

export interface GenerationRecord {
  generation: number;
  parents: string[];
  entries: string[];
  proposed: number;
  rejected: Record<string, number>;
  eligible: number;
  admitted: number;
  archive_size: number;
  best_selection_score: number;
  mean_child_score: number | null;
  distinct_parents: number;
}

interface Plan {
  parents: string[];
  entries: ReturnType<typeof chooseEntry>[];
}

const CHAMPION_PREFIX = "champion-";

function nowIso(ms: number): string {
  return new Date(ms).toISOString();
}

function reasonOf(error: unknown): string {
  const text =
    error instanceof EvolutionError
      ? error.message
      : error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
  return bounded(scrubSecrets(text), 2000);
}

function reasonCode(reason: string): string {
  return reason.split(":")[0] ?? "unknown";
}

/**
 * DGM-style open-ended harness evolution with a separate production champion.
 *
 * Search (archive, parent selection, proposals, builds, selection-split
 * evaluation) and promotion (held-out final test, regression families, cost,
 * reproducibility and integrity gates) are separate methods; only `promote`
 * ever reads the final test set, and only the champion tables are production.
 */
export class EvolutionService {
  readonly store: EvolutionStore;
  private readonly options: Required<
    Omit<EvolutionServiceOptions, "protectedControlPaths" | "hiddenAnswerPaths">
  > & {
    protectedControlPaths: string[];
    hiddenAnswerPaths: string[];
  };

  private constructor(options: EvolutionServiceOptions, store: EvolutionStore) {
    this.store = store;
    this.options = {
      gitPath: "/usr/bin/git",
      holder: `evolution-${randomUUID()}`,
      leaseTtlMs: 10 * 60 * 1000,
      now: Date.now,
      ...options,
      protectedControlPaths: [...(options.protectedControlPaths ?? [])],
      hiddenAnswerPaths: [...(options.hiddenAnswerPaths ?? [])],
    };
  }

  static async open(
    options: EvolutionServiceOptions,
  ): Promise<EvolutionService> {
    for (const path of [
      options.storeDir,
      options.workDir,
      ...(options.protectedControlPaths ?? []),
      ...(options.hiddenAnswerPaths ?? []),
    ])
      if (!isAbsolute(path))
        fail("unsafe_path", `path must be absolute: ${path}`);
    await mkdir(options.storeDir, { recursive: true, mode: 0o700 });
    await mkdir(options.workDir, { recursive: true, mode: 0o700 });
    await assertDisjointRoots(options.storeDir, options.workDir);
    for (const path of [
      ...(options.protectedControlPaths ?? []),
      ...(options.hiddenAnswerPaths ?? []),
    ])
      await assertDisjointRoots(path, options.workDir).catch((error) => {
        if (error instanceof EvolutionError && error.code === "unsafe_path")
          fail(
            "unsafe_path",
            `protected path ${path} overlaps the candidate work root`,
          );
        throw error;
      });
    return new EvolutionService(options, new EvolutionStore(options.storeDir));
  }

  close(): void {
    this.store.close();
  }

  private now(): number {
    return this.options.now();
  }

  private config(runId: string): {
    config: RunConfig;
    control: Control;
    scope_key: string;
    deadline_ms: number;
  } {
    const run = this.store.getRun(runId);
    if (!run) fail("not_found", `run ${runId}`);
    if (sha256(run.config_json) !== run.config_sha256)
      fail("accounting_tampered", "run config digest mismatch");
    return {
      config: RunConfigSchema.parse(JSON.parse(run.config_json)),
      control: ControlSchema.parse(JSON.parse(run.control_json)),
      scope_key: run.scope_key,
      deadline_ms: run.deadline_ms,
    };
  }

  private manifestOf(row: {
    manifest_json: string;
    manifest_sha256: string;
  }): AgentManifest {
    if (
      digestOf(JSON.parse(row.manifest_json)) !== row.manifest_sha256 ||
      sha256(row.manifest_json) !== row.manifest_sha256
    )
      fail("corrupt_record", "manifest digest mismatch");
    return AgentManifestSchema.parse(JSON.parse(row.manifest_json));
  }

  private entriesOf(treeSha256: string): TreeEntry[] {
    const entries = JSON.parse(
      this.store.getSnapshot(treeSha256),
    ) as TreeEntry[];
    return entries;
  }

  private storeSnapshot(snapshot: {
    entries: TreeEntry[];
    blobs: Map<string, Uint8Array>;
    tree_sha256: string;
  }): void {
    this.store.transaction(() => {
      for (const data of snapshot.blobs.values()) this.store.putBlob(data);
      this.store.putSnapshot(
        snapshot.tree_sha256,
        canonicalJson(snapshot.entries),
      );
    });
  }

  private async scratch(runId: string, label: string): Promise<string> {
    const dir = join(this.options.workDir, runId, `${label}-${randomUUID()}`);
    await mkdir(join(this.options.workDir, runId), {
      recursive: true,
      mode: 0o700,
    });
    return dir;
  }

  /** Base snapshot + ordered ancestor patch chain → tree, verified against the manifest. */
  async reproduceTree(
    manifest: AgentManifest,
    dir: string,
    policy: RunConfig["harness"],
  ): Promise<TreeEntry[]> {
    await materialize(
      dir,
      this.entriesOf(manifest.harness.base.tree_sha256),
      (digest) => this.store.getBlob(digest),
    );
    for (const patchDigest of manifest.harness.patches) {
      const patch = new TextDecoder().decode(this.store.getBlob(patchDigest));
      enforcePathPolicy(
        parsePatch(patch).map((file) => file.path),
        policy,
      );
      await applyPatch(dir, patch, { gitPath: this.options.gitPath });
    }
    const snapshot = await snapshotDirectory(dir);
    if (snapshot.tree_sha256 !== manifest.harness.tree_sha256)
      fail(
        "irreproducible",
        `tree ${snapshot.tree_sha256} ≠ manifest ${manifest.harness.tree_sha256}`,
      );
    return snapshot.entries;
  }

  private async buildOnce(
    runId: string,
    label: string,
    entries: readonly TreeEntry[],
    config: RunConfig,
    control: Control,
  ): Promise<{ bundle: Awaited<ReturnType<typeof snapshotDirectory>> }> {
    const dir = await this.scratch(runId, label);
    try {
      const tree = join(dir, "tree");
      await materialize(tree, entries, (digest) => this.store.getBlob(digest));
      await verifyControlDigests(control.control_digests, "before build");
      const result = await this.options.sandbox.run({
        workspaceDir: tree,
        argv: config.harness.build.argv,
        timeoutMs: config.harness.build.timeout_ms,
        maxOutputBytes: 64 * 1024,
        signal: AbortSignal.timeout(config.harness.build.timeout_ms + 5000),
        runId: `${runId}-${label}`,
        labels: { "mars.evolution.run": runId, "mars.evolution.build": label },
      });
      await verifyControlDigests(control.control_digests, "after build");
      if (result.timedOut) fail("build_failed", "build timed out");
      if (result.exitCode !== 0)
        fail(
          "build_failed",
          `exit ${result.exitCode}: ${bounded(scrubSecrets(new TextDecoder().decode(result.stderr)), 500)}`,
        );
      const bundleDir = join(tree, config.harness.build.bundle_dir);
      const bundle = await snapshotDirectory(bundleDir).catch((error) => {
        if (error instanceof EvolutionError) throw error;
        return fail(
          "build_failed",
          `build produced no ${config.harness.build.bundle_dir}`,
        );
      });
      if (bundle.entries.length === 0)
        fail("build_failed", "build produced an empty bundle");
      assertNoHoldoutLeak(bundle.entries, new Set(control.hidden_digests));
      return { bundle };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Builds a tree (twice when reproducibility is required) and stores the bundle snapshot. */
  private async build(
    runId: string,
    label: string,
    entries: readonly TreeEntry[],
    config: RunConfig,
    control: Control,
  ) {
    const first = await this.buildOnce(
      runId,
      `${label}-build`,
      entries,
      config,
      control,
    );
    let reproducible = false;
    if (config.harness.build.require_reproducible_bundle) {
      const second = await this.buildOnce(
        runId,
        `${label}-rebuild`,
        entries,
        config,
        control,
      );
      if (second.bundle.tree_sha256 !== first.bundle.tree_sha256)
        fail(
          "irreproducible",
          `bundle digests differ across rebuilds (${first.bundle.tree_sha256} vs ${second.bundle.tree_sha256})`,
        );
      reproducible = true;
    }
    this.storeSnapshot(first.bundle);
    return { bundle_sha256: first.bundle.tree_sha256, reproducible };
  }

  async startRun(
    input: StartRunInput,
  ): Promise<{ run_id: string; created: boolean }> {
    const config = RunConfigSchema.parse(input.config);
    IdSchema.parse(input.scope_key);
    const existing = this.store.getRun(config.run_id);
    const configJson = canonicalJson(config);
    if (existing) {
      if (
        existing.config_sha256 !== sha256(configJson) ||
        existing.scope_key !== input.scope_key
      )
        fail("conflict", `run ${config.run_id} exists with a different config`);
      return { run_id: config.run_id, created: false };
    }
    const base = await snapshotDirectory(input.base_dir);
    const hiddenDigests: string[] = [];
    for (const path of this.options.hiddenAnswerPaths) {
      const snap = await snapshotDirectory(path, { skipDirs: [] }).catch(
        () => null,
      );
      if (snap)
        hiddenDigests.push(...snap.entries.map((entry) => entry.sha256));
      else hiddenDigests.push(await digestControlPath(path));
    }
    assertNoHoldoutLeak(base.entries, new Set(hiddenDigests));
    const manifest = AgentManifestSchema.parse({
      schema: AGENT_MANIFEST_SCHEMA,
      model: input.model,
      prompts: input.prompts,
      skills: input.skills,
      tools: input.tools,
      retrieval: input.retrieval,
      harness: {
        base: { ref: input.base_ref, tree_sha256: base.tree_sha256 },
        patches: [],
        tree_sha256: base.tree_sha256,
      },
    });
    const pointer = this.store.championPointer(input.scope_key);
    if (pointer) {
      const champion = this.store.championEntry(
        input.scope_key,
        pointer.entry_seq,
      );
      if (champion && this.manifestOf(champion).model.id !== manifest.model.id)
        fail(
          "invalid_input",
          "the run's frozen model differs from the production champion's model",
        );
    }
    const createdMs = this.now();
    const control: Control = {
      evaluator_digest: this.options.evaluator.digest,
      simulated: this.options.evaluator.simulated,
      proposer_id: this.options.proposer.id,
      control_digests: await digestControlPaths([
        ...this.options.protectedControlPaths,
        ...this.options.hiddenAnswerPaths,
      ]),
      hidden_digests: [...new Set(hiddenDigests)].sort(),
      created_ms: createdMs,
    };
    this.storeSnapshot(base);
    const built = await this.build(
      config.run_id,
      "initial",
      base.entries,
      config,
      control,
    );
    const manifestJson = canonicalJson(manifest);
    const at = nowIso(createdMs);
    this.store.transaction(() => {
      if (this.store.getRun(config.run_id))
        fail("conflict", `run ${config.run_id} was created concurrently`);
      this.store.insertRun({
        run_id: config.run_id,
        scope_key: input.scope_key,
        config_json: configJson,
        config_sha256: sha256(configJson),
        control_json: canonicalJson(control),
        status: "running",
        revision: 1,
        created_at: at,
        updated_at: at,
        deadline_ms: createdMs + config.budget.max_duration_ms,
        lease_holder: null,
        lease_token: 0,
        lease_expires_ms: 0,
      });
      this.store.insertCandidate({
        run_id: config.run_id,
        candidate_id: "initial",
        parent_id: null,
        generation: 0,
        seq: 0,
        depth: 0,
        manifest_json: manifestJson,
        manifest_sha256: sha256(manifestJson),
        proposal_json: canonicalJson({ hypothesis: "frozen baseline" }),
        state: "evaluating",
        eligible: 0,
        score: null,
        selection_json: canonicalJson({
          build: {
            reproducible: built.reproducible,
            bundle_sha256: built.bundle_sha256,
            changed_paths: [],
          },
        }),
        bundle_sha256: built.bundle_sha256,
        reason: null,
        revision: 1,
        created_at: at,
        updated_at: at,
      });
      if (!this.store.championPointer(input.scope_key))
        this.store.moveChampion(
          {
            scope_key: input.scope_key,
            run_id: config.run_id,
            candidate_id: "initial",
            manifest_json: manifestJson,
            manifest_sha256: sha256(manifestJson),
            bundle_sha256: built.bundle_sha256,
            decision_id: null,
            action: "initial",
            target_seq: null,
            created_at: at,
          },
          null,
          "new",
        );
    });
    return { run_id: config.run_id, created: true };
  }

  private spent(runId: string): { tokens: number; usd: number; ms: number } {
    const settled = new Map<
      string,
      { tokens: number; usd: number; ms: number }
    >();
    const reserved = new Map<
      string,
      { tokens: number; usd: number; ms: number }
    >();
    for (const row of this.store.ledger(runId))
      (row.kind === "settle" ? settled : reserved).set(row.key, row);
    const total = { tokens: 0, usd: 0, ms: 0 };
    for (const [key, row] of reserved) {
      const used = settled.get(key) ?? row;
      total.tokens += used.tokens;
      total.usd += used.usd;
      total.ms += used.ms;
    }
    return total;
  }

  /** Every evaluation passes here: split fence, budget reservation, digest checks, idempotent persistence. */
  private async evaluate(
    runId: string,
    lease: number,
    subject: {
      id: string;
      manifest: AgentManifest;
      manifest_sha256: string;
      bundle_sha256: string;
    },
    split: Split,
    key: string,
    tasks: string[],
    repeats: number,
    seed: string,
    family: string | null,
  ): Promise<EvaluationOutcome> {
    const { config, control, deadline_ms } = this.config(runId);
    const selection = new Set(
      config.selection.stages.flatMap((stage) => stage.tasks),
    );
    const final = new Set(config.final_test.tasks);
    if (
      split === "selection" &&
      tasks.some((task) => !selection.has(task) || final.has(task))
    )
      fail(
        "split_violation",
        "selection evaluation may only use selection tasks",
      );
    if (
      split === "final" &&
      canonicalJson([...tasks].sort()) !== canonicalJson([...final].sort())
    )
      fail(
        "split_violation",
        "final evaluation must use exactly the held-out final tasks",
      );
    if (split === "regression") {
      const familyTasks =
        config.regression_families.find((row) => row.family === family)
          ?.tasks ?? [];
      if (tasks.some((task) => !familyTasks.includes(task)))
        fail("split_violation", "regression tasks must belong to the family");
    }
    const budget: Budget = config.evaluation_budget;
    const cached = this.store.getEvaluation(runId, subject.id, split, key);
    if (cached) {
      const outcome = EvaluationOutcomeSchema.parse(JSON.parse(cached));
      assertWithinBudget(subject.id, outcome, budget);
      return outcome;
    }
    const now = this.now();
    if (now >= deadline_ms)
      fail("deadline_exceeded", `run ${runId} passed its deadline`);
    this.store.verifyLedger(runId);
    const ledgerKey = `${subject.id}/${split}/${key}`;
    this.store.transaction(() => {
      this.store.assertLease(runId, lease, this.now());
      if (
        this.store
          .ledger(runId)
          .some((row) => row.kind === "reserve" && row.key === ledgerKey)
      )
        return;
      const spent = this.spent(runId);
      if (
        spent.tokens + budget.max_tokens > config.budget.max_tokens ||
        spent.usd + budget.max_usd > config.budget.max_usd + 1e-9 ||
        spent.ms + budget.max_duration_ms > config.budget.max_duration_ms
      )
        fail(
          "budget_exhausted",
          `run ${runId} cannot reserve another matched evaluation budget`,
        );
      this.store.appendLedger(
        runId,
        "reserve",
        ledgerKey,
        {
          tokens: budget.max_tokens,
          usd: budget.max_usd,
          ms: budget.max_duration_ms,
        },
        nowIso(this.now()),
      );
    });
    const bundleDir = await this.scratch(runId, `bundle-${subject.id}`);
    try {
      await materialize(
        bundleDir,
        this.entriesOf(subject.bundle_sha256),
        (digest) => this.store.getBlob(digest),
      );
      await verifyControlDigests(control.control_digests, "before evaluation");
      const request: EvaluationRequest = {
        run_id: runId,
        subject_id: subject.id,
        manifest: subject.manifest,
        manifest_sha256: subject.manifest_sha256,
        bundle_dir: bundleDir,
        bundle_sha256: subject.bundle_sha256,
        split,
        family,
        tasks,
        repeats,
        seed,
        budget,
        deadline_ms: Math.min(deadline_ms, now + budget.max_duration_ms),
      };
      const timeout = Math.max(
        1,
        Math.min(deadline_ms, now + budget.max_duration_ms) - now,
      );
      // Keep the run lease alive while a long evaluation runs; losing it aborts.
      const lost = new AbortController();
      const heartbeat = setInterval(
        () => {
          try {
            const token = this.store.acquireLease(
              runId,
              this.options.holder,
              this.now(),
              this.options.leaseTtlMs,
            );
            if (token !== lease) lost.abort();
          } catch {
            lost.abort();
          }
        },
        Math.max(10, Math.floor(this.options.leaseTtlMs / 3)),
      );
      let outcome: EvaluationOutcome;
      try {
        outcome = EvaluationOutcomeSchema.parse(
          await this.options.evaluator.evaluate(
            request,
            AbortSignal.any([AbortSignal.timeout(timeout), lost.signal]),
          ),
        );
      } finally {
        clearInterval(heartbeat);
      }
      await verifyControlDigests(control.control_digests, "after evaluation");
      if (
        outcome.evaluator_digest !== control.evaluator_digest ||
        this.options.evaluator.digest !== control.evaluator_digest
      )
        fail(
          "evaluator_mismatch",
          "evaluator digest differs from the digest pinned at run start",
        );
      if (outcome.simulated !== control.simulated)
        fail("evaluator_mismatch", "evaluator simulation flag changed");
      if (
        canonicalJson(outcome.per_task.map((row) => row.task_id)) !==
          canonicalJson(tasks) ||
        outcome.per_task.some((row) => row.rewards.length !== repeats)
      )
        fail(
          "evaluator_mismatch",
          "evaluator returned a different task/repeat grid than requested",
        );
      const json = canonicalJson(outcome);
      this.store.transaction(() => {
        this.store.assertLease(runId, lease, this.now());
        this.store.putEvaluation(
          runId,
          subject.id,
          split,
          key,
          json,
          nowIso(this.now()),
        );
        this.store.appendLedger(
          runId,
          "settle",
          ledgerKey,
          {
            tokens: chargedSpend(
              outcome.tokens,
              outcome.baseline_tokens,
              budget.max_tokens,
            ),
            usd: chargedSpend(
              outcome.cost_usd,
              outcome.baseline_cost_usd,
              budget.max_usd,
            ),
            ms: Math.min(outcome.runtime_ms, budget.max_duration_ms * 4),
          },
          nowIso(this.now()),
        );
      });
      assertWithinBudget(subject.id, outcome, budget);
      return outcome;
    } finally {
      await rm(bundleDir, { recursive: true, force: true });
    }
  }

  private async evaluateSelection(
    runId: string,
    lease: number,
    row: CandidateRow,
    manifest: AgentManifest,
    config: RunConfig,
  ) {
    const per_task: SelectionRecord["per_task"] = [];
    let stages = 0;
    for (const [index, stage] of config.selection.stages.entries()) {
      const outcome = await this.evaluate(
        runId,
        lease,
        {
          id: row.candidate_id,
          manifest,
          manifest_sha256: row.manifest_sha256,
          bundle_sha256: row.bundle_sha256 as string,
        },
        "selection",
        `stage-${index}`,
        stage.tasks,
        config.selection.repeats,
        digestOf([config.seed, "selection", row.candidate_id, index]),
        null,
      );
      for (const task of outcome.per_task)
        per_task.push({
          task_id: task.task_id,
          rewards: task.rewards,
          mean: strictMean(task.rewards, config.selection.repeats),
        });
      stages += 1;
      const soFar = mean(per_task.map((task) => task.mean));
      if (soFar < stage.min_score_to_continue) break;
    }
    const allTasks = config.selection.stages.flatMap((stage) => stage.tasks);
    const score =
      per_task.reduce((sum, task) => sum + task.mean, 0) / allTasks.length;
    const evaluated = new Set(per_task.map((task) => task.task_id));
    return {
      score,
      per_task,
      stages_completed: stages,
      unresolved: [
        ...per_task.filter((task) => task.mean < 1).map((task) => task.task_id),
        ...allTasks.filter((task) => !evaluated.has(task)),
      ],
      unstable: per_task
        .filter(
          (task) =>
            new Set(task.rewards.map((reward) => reward ?? -1)).size > 1,
        )
        .map((task) => task.task_id),
      anyValid: per_task.some((task) =>
        task.rewards.some((reward) => reward !== null),
      ),
    };
  }

  private archive(runId: string, config: RunConfig): ArchiveMember[] {
    return this.store
      .listCandidates(runId)
      .filter(
        (row) =>
          row.state !== "rejected" &&
          row.selection_json !== null &&
          row.score !== null,
      )
      .filter(
        (row) =>
          (JSON.parse(row.selection_json as string) as Partial<SelectionRecord>)
            .admitted === true,
      )
      .map((row) => {
        const record = JSON.parse(
          row.selection_json as string,
        ) as SelectionRecord;
        return {
          candidate_id: row.candidate_id,
          parent_id: row.parent_id,
          score: row.score as number,
          eligible: row.eligible === 1 && row.depth < config.budget.max_depth,
          seq: row.seq,
          unresolved: record.unresolved,
          unstable: record.unstable,
        };
      });
  }

  private reject(
    runId: string,
    lease: number,
    row: CandidateRow,
    reason: string,
  ): void {
    this.store.transaction(() => {
      this.store.assertLease(runId, lease, this.now());
      const current = this.store.getCandidate(
        runId,
        row.candidate_id,
      ) as CandidateRow;
      this.store.updateCandidate(
        runId,
        row.candidate_id,
        current.revision,
        { state: "rejected", eligible: 0, reason },
        nowIso(this.now()),
      );
    });
  }

  /** Builds (if needed) and evaluates one candidate on the selection split; records the archive decision. */
  private async process(
    runId: string,
    lease: number,
    candidateId: string,
    config: RunConfig,
    control: Control,
  ): Promise<void> {
    let row = this.store.getCandidate(runId, candidateId) as CandidateRow;
    if (row.state === "rejected" || row.state === "evaluated") return;
    const manifest = this.manifestOf(row);
    try {
      if (row.bundle_sha256 === null) {
        const parent = this.store.getCandidate(
          runId,
          row.parent_id as string,
        ) as CandidateRow;
        const parentManifest = this.manifestOf(parent);
        const parentEntries = this.entriesOf(
          parentManifest.harness.tree_sha256,
        );
        const proposal = MutationProposalSchema.parse(
          JSON.parse(row.proposal_json),
        );
        const dir = await this.scratch(runId, `${candidateId}-tree`);
        let changed: string[] = [];
        try {
          await materialize(dir, parentEntries, (digest) =>
            this.store.getBlob(digest),
          );
          if (proposal.patch) {
            enforcePathPolicy(
              parsePatch(proposal.patch).map((file) => file.path),
              config.harness,
            );
            await applyPatch(dir, proposal.patch, {
              gitPath: this.options.gitPath,
            });
          }
          const snapshot = await snapshotDirectory(dir);
          changed = assertTreeChangeAllowed(
            parentEntries,
            snapshot.entries,
            config.harness,
          );
          assertNoHoldoutLeak(
            snapshot.entries,
            new Set(control.hidden_digests),
          );
          if (snapshot.tree_sha256 !== manifest.harness.tree_sha256)
            fail(
              "irreproducible",
              "applied tree differs from the manifest tree digest",
            );
          this.storeSnapshot(snapshot);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
        const built = await this.build(
          runId,
          candidateId,
          this.entriesOf(manifest.harness.tree_sha256),
          config,
          control,
        );
        this.store.transaction(() => {
          this.store.assertLease(runId, lease, this.now());
          const current = this.store.getCandidate(
            runId,
            candidateId,
          ) as CandidateRow;
          this.store.updateCandidate(
            runId,
            candidateId,
            current.revision,
            {
              state: "evaluating",
              bundle_sha256: built.bundle_sha256,
              selection_json: canonicalJson({
                build: {
                  reproducible: built.reproducible,
                  bundle_sha256: built.bundle_sha256,
                  changed_paths: changed,
                },
              }),
            },
            nowIso(this.now()),
          );
        });
        row = this.store.getCandidate(runId, candidateId) as CandidateRow;
      }
      const result = await this.evaluateSelection(
        runId,
        lease,
        row,
        manifest,
        config,
      );
      const initial = this.store.getCandidate(runId, "initial") as CandidateRow;
      const eligible = result.stages_completed >= 1 && result.anyValid;
      const admitted =
        candidateId === "initial" ||
        (eligible &&
          admitToArchive(
            result.score,
            initial.score ?? 0,
            config.selection.archive_update,
            config.selection.noise_leeway,
          ));
      const prior = JSON.parse(
        row.selection_json ?? "{}",
      ) as Partial<SelectionRecord>;
      const record: SelectionRecord = {
        score: result.score,
        per_task: result.per_task,
        stages_completed: result.stages_completed,
        unresolved: result.unresolved,
        unstable: result.unstable,
        admitted,
        tree_sha256: manifest.harness.tree_sha256,
        build: prior.build as SelectionRecord["build"],
      };
      this.store.transaction(() => {
        this.store.assertLease(runId, lease, this.now());
        const current = this.store.getCandidate(
          runId,
          candidateId,
        ) as CandidateRow;
        this.store.updateCandidate(
          runId,
          candidateId,
          current.revision,
          {
            state: "evaluated",
            eligible: eligible ? 1 : 0,
            score: result.score,
            selection_json: canonicalJson(record),
            reason: admitted ? null : "not_admitted",
          },
          nowIso(this.now()),
        );
      });
    } catch (error) {
      if (
        error instanceof EvolutionError &&
        [
          "budget_exhausted",
          "deadline_exceeded",
          "stale_lease",
          "closed",
          "accounting_tampered",
        ].includes(error.code)
      )
        throw error;
      if (error instanceof EvolutionError && error.code === "tamper_detected") {
        this.reject(runId, lease, row, reasonOf(error));
        throw error;
      }
      this.reject(runId, lease, row, reasonOf(error));
    }
  }

  private async propose(
    runId: string,
    lease: number,
    generation: number,
    index: number,
    parentId: string,
    entry: Plan["entries"][number],
    config: RunConfig,
    control: Control,
  ) {
    const candidateId = `g${generation}-c${index}`;
    if (this.store.getCandidate(runId, candidateId)) return candidateId;
    const parent = this.store.getCandidate(runId, parentId) as CandidateRow;
    const parentManifest = this.manifestOf(parent);
    const parentRecord = JSON.parse(
      parent.selection_json as string,
    ) as SelectionRecord;
    const allCandidates = this.store.listCandidates(runId);
    const byId = new Map(allCandidates.map((row) => [row.candidate_id, row]));
    const archiveSummary = this.archive(runId, config).map((member) => {
      const candidateRow = byId.get(member.candidate_id);
      return {
        candidate_id: member.candidate_id,
        parent_id: member.parent_id,
        generation: candidateRow?.generation ?? 0,
        depth: candidateRow?.depth ?? 0,
        selection_score: member.score,
        eligible: member.eligible,
        unresolved: [...member.unresolved],
        unstable: [...member.unstable],
      };
    });
    const lineage: NonNullable<ProposalContext["lineage"]> = [];
    {
      let cursor: CandidateRow | undefined = parent;
      const seen = new Set<string>();
      while (cursor && !seen.has(cursor.candidate_id)) {
        seen.add(cursor.candidate_id);
        let hypothesis = "";
        try {
          const parsed = JSON.parse(cursor.proposal_json) as {
            hypothesis?: unknown;
          };
          if (typeof parsed.hypothesis === "string")
            hypothesis = bounded(scrubSecrets(parsed.hypothesis), 400);
        } catch {
          // ignore malformed proposal JSON in lineage summary
        }
        let changedPaths: string[] = [];
        if (cursor.selection_json) {
          try {
            const parsed = JSON.parse(
              cursor.selection_json,
            ) as Partial<SelectionRecord>;
            if (Array.isArray(parsed.build?.changed_paths))
              changedPaths = [...parsed.build.changed_paths];
          } catch {
            // ignore malformed selection JSON in lineage summary
          }
        }
        lineage.push({
          candidate_id: cursor.candidate_id,
          parent_id: cursor.parent_id,
          generation: cursor.generation,
          depth: cursor.depth,
          selection_score: cursor.score,
          hypothesis,
          changed_paths: changedPaths,
        });
        cursor = cursor.parent_id ? byId.get(cursor.parent_id) : undefined;
      }
      lineage.reverse();
    }
    const failureTraces: NonNullable<ProposalContext["failure_traces"]> = [];
    const unresolvedSet = new Set(parentRecord.unresolved);
    const unstableSet = new Set(parentRecord.unstable);
    for (const evalRow of this.store.listSelectionEvaluations(
      runId,
      parentId,
    )) {
      const outcome = EvaluationOutcomeSchema.parse(
        JSON.parse(evalRow.outcome_json),
      );
      const scrubbedNotes = outcome.notes
        .slice(0, 8)
        .map((note) => bounded(scrubSecrets(note), 400));
      for (const task of outcome.per_task) {
        if (unresolvedSet.has(task.task_id) || unstableSet.has(task.task_id)) {
          failureTraces.push({
            source: "selection_eval",
            candidate_id: parentId,
            stage: evalRow.key,
            task_id: task.task_id,
            rewards: [...task.rewards],
            notes: scrubbedNotes,
          });
        }
      }
    }
    const rejectedChildren = allCandidates
      .filter(
        (candidate) =>
          candidate.parent_id === parentId &&
          candidate.state === "rejected" &&
          candidate.reason !== null,
      )
      .slice(-8);
    for (const rejected of rejectedChildren) {
      failureTraces.push({
        source: "rejected_child",
        candidate_id: rejected.candidate_id,
        reason: bounded(scrubSecrets(rejected.reason ?? "rejected"), 400),
        notes: [],
      });
    }
    const scratch = await this.scratch(runId, `${candidateId}-proposal`);
    let proposalJson: string;
    let manifest: AgentManifest = parentManifest;
    let reason: string | null = null;
    try {
      this.store.verifyLedger(runId);
      const spentBeforeProposal = this.spent(runId);
      if (
        spentBeforeProposal.tokens >= config.budget.max_tokens ||
        spentBeforeProposal.usd > config.budget.max_usd + 1e-9 ||
        spentBeforeProposal.ms >= config.budget.max_duration_ms
      ) {
        fail(
          "budget_exhausted",
          `run ${runId} exhausted its budget before proposal`,
        );
      }
      await verifyControlDigests(control.control_digests, "before proposal");
      await materialize(
        scratch,
        this.entriesOf(parentManifest.harness.tree_sha256),
        (digest) => this.store.getBlob(digest),
      );
      const raw = await this.options.proposer.propose(
        {
          run_id: runId,
          generation,
          child_index: index,
          parent: {
            candidate_id: parentId,
            manifest: parentManifest,
            selection_score: parent.score ?? 0,
            per_task: parentRecord.per_task.map((task) => ({
              task_id: task.task_id,
              mean: task.mean,
            })),
          },
          entry,
          harness_dir: scratch,
          seed: digestOf([config.seed, "proposal", generation, index]),
          archive: archiveSummary,
          lineage,
          failure_traces: failureTraces,
          harness_policy: {
            mutable_paths: [...config.harness.mutable_paths],
            protected_paths: [...config.harness.protected_paths],
            max_patch_bytes: config.harness.max_patch_bytes,
          },
          applied_components: this.options.evaluator.appliedComponents,
        },
        AbortSignal.timeout(config.evaluation_budget.max_duration_ms),
      );
      await verifyControlDigests(control.control_digests, "after proposal");
      const proposal = MutationProposalSchema.parse(raw);
      proposal.hypothesis = bounded(scrubSecrets(proposal.hypothesis), 4000);
      if (proposal.usage !== undefined) {
        const usage = {
          tokens: proposal.usage.tokens,
          usd: proposal.usage.usd,
          ms: proposal.usage.ms,
        };
        this.store.transaction(() => {
          this.store.assertLease(runId, lease, this.now());
          const prefix = `${candidateId}/proposal`;
          const attempt = this.store
            .ledger(runId)
            .filter(
              (row) =>
                row.kind === "reserve" &&
                (row.key === prefix || row.key.startsWith(`${prefix}#`)),
            ).length;
          const proposalLedgerKey =
            attempt === 0 ? prefix : `${prefix}#${attempt}`;
          const atProposal = nowIso(this.now());
          this.store.appendLedger(
            runId,
            "reserve",
            proposalLedgerKey,
            usage,
            atProposal,
          );
          this.store.appendLedger(
            runId,
            "settle",
            proposalLedgerKey,
            usage,
            atProposal,
          );
        });
        const spentAfterProposal = this.spent(runId);
        if (
          spentAfterProposal.tokens > config.budget.max_tokens ||
          spentAfterProposal.usd > config.budget.max_usd + 1e-9 ||
          spentAfterProposal.ms > config.budget.max_duration_ms
        ) {
          fail(
            "budget_exhausted",
            `run ${runId} exhausted its budget during proposal`,
          );
        }
      }
      proposalJson = canonicalJson(proposal);
      const patches = [...parentManifest.harness.patches];
      let tree = parentManifest.harness.tree_sha256;
      if (proposal.patch !== undefined) {
        if (
          new TextEncoder().encode(proposal.patch).byteLength >
          config.harness.max_patch_bytes
        )
          fail("unsafe_patch", "patch exceeds max_patch_bytes");
        enforcePathPolicy(
          parsePatch(proposal.patch).map((file) => file.path),
          config.harness,
        );
        const probe = join(
          scratch,
          "..",
          `${candidateId}-probe-${randomUUID()}`,
        );
        try {
          await materialize(probe, this.entriesOf(tree), (digest) =>
            this.store.getBlob(digest),
          );
          await applyPatch(probe, proposal.patch, {
            gitPath: this.options.gitPath,
          });
          const snapshot = await snapshotDirectory(probe);
          assertTreeChangeAllowed(
            this.entriesOf(tree),
            snapshot.entries,
            config.harness,
          );
          assertNoHoldoutLeak(
            snapshot.entries,
            new Set(control.hidden_digests),
          );
          tree = snapshot.tree_sha256;
        } finally {
          await rm(probe, { recursive: true, force: true });
        }
        this.store.transaction(() => {
          patches.push(
            this.store.putBlob(new TextEncoder().encode(proposal.patch)),
          );
        });
      }
      manifest = AgentManifestSchema.parse({
        ...parentManifest,
        prompts: proposal.prompts ?? parentManifest.prompts,
        tools: proposal.tools ?? parentManifest.tools,
        retrieval: {
          ...parentManifest.retrieval,
          ...(proposal.retrieval ?? {}),
        },
        skills: proposal.skill_store_revision
          ? { store_revision: proposal.skill_store_revision }
          : parentManifest.skills,
        harness: { ...parentManifest.harness, patches, tree_sha256: tree },
      });
      if (digestOf(manifest) === digestOf(parentManifest))
        fail("invalid_input", "empty_mutation: proposal changes nothing");
      assertMutationApplied(
        parentManifest,
        manifest,
        this.options.evaluator.appliedComponents,
      );
    } catch (error) {
      if (
        error instanceof EvolutionError &&
        [
          "tamper_detected",
          "budget_exhausted",
          "deadline_exceeded",
          "stale_lease",
          "closed",
          "accounting_tampered",
        ].includes(error.code)
      )
        throw error;
      reason = reasonOf(error);
      proposalJson = canonicalJson({
        hypothesis: "proposal refused",
        refused: true,
      });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
    const manifestJson = canonicalJson(manifest);
    const at = nowIso(this.now());
    this.store.transaction(() => {
      this.store.assertLease(runId, lease, this.now());
      if (this.store.getCandidate(runId, candidateId)) return;
      this.store.insertCandidate({
        run_id: runId,
        candidate_id: candidateId,
        parent_id: parentId,
        generation,
        seq: this.store.nextSeq(runId),
        depth: parent.depth + 1,
        manifest_json: manifestJson,
        manifest_sha256: sha256(manifestJson),
        proposal_json: proposalJson,
        state: reason === null ? "proposed" : "rejected",
        eligible: 0,
        score: null,
        selection_json: null,
        bundle_sha256: null,
        reason,
        revision: 1,
        created_at: at,
        updated_at: at,
      });
    });
    return candidateId;
  }

  /**
   * Runs (or resumes) generations until `generations` complete, the budget
   * or deadline is exhausted, or `maxGenerations` more have run. Safe to call
   * after a crash: plans, proposals and evaluations are persisted and replayed.
   */
  async run(
    runId: string,
    options: { maxGenerations?: number } = {},
  ): Promise<{ status: string; generations_completed: number }> {
    const { config, control } = this.config(runId);
    const lease = this.store.acquireLease(
      runId,
      this.options.holder,
      this.now(),
      this.options.leaseTtlMs,
    );
    let ranNow = 0;
    try {
      await verifyControlDigests(control.control_digests, "run start");
      if (this.options.evaluator.digest !== control.evaluator_digest)
        fail(
          "evaluator_mismatch",
          "evaluator digest differs from the digest pinned at run start",
        );
      await this.process(runId, lease, "initial", config, control);
      const initial = this.store.getCandidate(runId, "initial") as CandidateRow;
      if (initial.state === "rejected") {
        this.store.setRunStatus(runId, "failed", nowIso(this.now()));
        return { status: "failed", generations_completed: 0 };
      }
      for (
        let generation = 1;
        generation <= config.generations;
        generation += 1
      ) {
        const existing = this.store.getGeneration(runId, generation);
        if (existing?.record_json) continue;
        if (
          options.maxGenerations !== undefined &&
          ranNow >= options.maxGenerations
        )
          break;
        this.store.acquireLease(
          runId,
          this.options.holder,
          this.now(),
          this.options.leaseTtlMs,
        );
        let plan: Plan;
        if (existing) plan = JSON.parse(existing.plan_json) as Plan;
        else {
          const random = seededRandom(
            digestOf([config.seed, "generation", generation]),
          );
          const archive = this.archive(runId, config);
          const parents = selectParents(
            archive,
            config.children_per_generation,
            config.selection.method,
            {
              lambda: config.selection.sigmoid_lambda,
              midpoint: config.selection.sigmoid_midpoint,
            },
            random,
          );
          if (parents.length === 0) {
            this.store.setRunStatus(runId, "stalled", nowIso(this.now()));
            return { status: "stalled", generations_completed: generation - 1 };
          }
          const byId = new Map(
            archive.map((member) => [member.candidate_id, member]),
          );
          plan = {
            parents,
            entries: parents.map((id) =>
              chooseEntry(byId.get(id) as ArchiveMember, random),
            ),
          };
          this.store.transaction(() => {
            this.store.assertLease(runId, lease, this.now());
            this.store.putGenerationPlan(
              runId,
              generation,
              canonicalJson(plan),
            );
          });
          plan = JSON.parse(
            (
              this.store.getGeneration(runId, generation) as {
                plan_json: string;
              }
            ).plan_json,
          ) as Plan;
        }
        const children: string[] = [];
        for (const [index, parentId] of plan.parents.entries()) {
          const id = await this.propose(
            runId,
            lease,
            generation,
            index,
            parentId,
            plan.entries[index] as Plan["entries"][number],
            config,
            control,
          );
          children.push(id);
          await this.process(runId, lease, id, config, control);
        }
        const rows = children.map(
          (id) => this.store.getCandidate(runId, id) as CandidateRow,
        );
        const rejected: Record<string, number> = {};
        for (const row of rows)
          if (row.state === "rejected" || row.reason)
            rejected[reasonCode(row.reason ?? "rejected")] =
              (rejected[reasonCode(row.reason ?? "rejected")] ?? 0) + 1;
        const archive = this.archive(runId, config);
        const childScores = rows
          .filter((row) => row.score !== null)
          .map((row) => row.score as number);
        const record: GenerationRecord = {
          generation,
          parents: plan.parents,
          entries: plan.entries.map((entry) =>
            entry.kind === "task" ? `task:${entry.task_id}` : entry.kind,
          ),
          proposed: rows.length,
          rejected,
          eligible: rows.filter((row) => row.eligible === 1).length,
          admitted: rows.filter(
            (row) =>
              row.selection_json &&
              (JSON.parse(row.selection_json) as Partial<SelectionRecord>)
                .admitted,
          ).length,
          archive_size: archive.length,
          best_selection_score: Math.max(
            ...archive.map((member) => member.score),
          ),
          mean_child_score: childScores.length ? mean(childScores) : null,
          distinct_parents: new Set(plan.parents).size,
        };
        this.store.transaction(() => {
          this.store.assertLease(runId, lease, this.now());
          this.store.finishGeneration(runId, generation, canonicalJson(record));
        });
        ranNow += 1;
      }
      const done = this.store
        .listGenerations(runId)
        .filter((row) => row.record_json).length;
      const status = done >= config.generations ? "completed" : "running";
      this.store.setRunStatus(runId, status, nowIso(this.now()));
      return { status, generations_completed: done };
    } catch (error) {
      if (
        error instanceof EvolutionError &&
        (error.code === "budget_exhausted" ||
          error.code === "deadline_exceeded")
      ) {
        this.store.setRunStatus(runId, error.code, nowIso(this.now()));
        return {
          status: error.code,
          generations_completed: this.store
            .listGenerations(runId)
            .filter((row) => row.record_json).length,
        };
      }
      if (error instanceof EvolutionError && error.code === "tamper_detected")
        this.store.setRunStatus(runId, "tamper_detected", nowIso(this.now()));
      throw error;
    } finally {
      this.store.releaseLease(runId, lease);
    }
  }

  /**
   * Compares an archive candidate against the production champion on the
   * held-out final test set (+ regression families) with repeated, paired
   * trials, applies every gate and records an honest verdict. Only an
   * `accepted` verdict moves the champion pointer.
   */
  async promote(input: {
    run_id: string;
    candidate_id?: string;
    idempotency_key: string;
  }): Promise<PromotionDecision> {
    IdSchema.parse(input.idempotency_key);
    const { config, control, scope_key } = this.config(input.run_id);
    const prior = this.store.getDecisionByKey(scope_key, input.idempotency_key);
    if (prior) {
      if (sha256(prior.decision_json) !== prior.decision_sha256)
        fail("accounting_tampered", "decision digest mismatch");
      return PromotionDecisionSchema.parse(JSON.parse(prior.decision_json));
    }
    const lease = this.store.acquireLease(
      input.run_id,
      this.options.holder,
      this.now(),
      this.options.leaseTtlMs,
    );
    try {
      const candidates = this.store.listCandidates(input.run_id);
      const chosen =
        input.candidate_id !== undefined
          ? candidates.find((row) => row.candidate_id === input.candidate_id)
          : candidates
              .filter(
                (row) =>
                  row.candidate_id !== "initial" &&
                  row.state === "evaluated" &&
                  row.eligible === 1,
              )
              .sort(
                (a, b) => (b.score ?? 0) - (a.score ?? 0) || a.seq - b.seq,
              )[0];
      if (!chosen) fail("invalid_state", "no evaluated candidate to promote");
      if (
        chosen.state !== "evaluated" ||
        chosen.eligible !== 1 ||
        chosen.bundle_sha256 === null
      )
        fail(
          "invalid_state",
          `candidate ${chosen.candidate_id} is not an eligible evaluated candidate`,
        );
      const manifest = this.manifestOf(chosen);
      const pointer = this.store.championPointer(scope_key);
      if (!pointer) fail("invalid_state", "scope has no champion");
      const championRow = this.store.championEntry(
        scope_key,
        pointer.entry_seq,
      ) as ChampionEntryRow;
      const championManifest = this.manifestOf(championRow);
      const decisionId = `dec-${digestOf([scope_key, input.idempotency_key]).slice(0, 24)}`;
      // A retry of this decision resumes its own partial comparison, but the
      // key may not be reused to put a different pair on the final set.
      const allowed = new Set([
        chosen.candidate_id,
        `${CHAMPION_PREFIX}${championRow.seq}`,
      ]);
      const foreign = this.store
        .evaluationSubjects(input.run_id, "final", decisionId)
        .filter((id) => !allowed.has(id));
      if (foreign.length > 0)
        fail(
          "conflict",
          `idempotency key ${input.idempotency_key} already compared ${foreign.join(", ")} on the final set`,
        );
      const uses = this.store.countEvaluations(
        input.run_id,
        "final",
        decisionId,
      );
      if (uses >= config.final_test.max_uses)
        fail(
          "budget_exhausted",
          `final test set already used ${uses} times (max ${config.final_test.max_uses})`,
        );
      const notes: string[] = [];
      const gates: Gate[] = [];
      const integrity: string[] = [];
      try {
        this.store.verifyLedger(input.run_id);
        this.store.verifyChampionChain(scope_key);
        await verifyControlDigests(control.control_digests, "promotion");
        if (this.options.evaluator.digest !== control.evaluator_digest)
          fail(
            "evaluator_mismatch",
            "evaluator digest changed since run start",
          );
        if (championManifest.model.id !== manifest.model.id)
          fail(
            "evaluator_mismatch",
            "candidate and champion use different models",
          );
      } catch (error) {
        integrity.push(reasonOf(error));
      }
      let reproducible = false;
      let reproDetail = "";
      const record = JSON.parse(
        chosen.selection_json as string,
      ) as SelectionRecord;
      try {
        const dir = await this.scratch(
          input.run_id,
          `${chosen.candidate_id}-reproduce`,
        );
        try {
          const entries = await this.reproduceTree(
            manifest,
            dir,
            config.harness,
          );
          const rebuilt = await this.buildOnce(
            input.run_id,
            `${chosen.candidate_id}-repro-build`,
            entries,
            config,
            control,
          );
          if (rebuilt.bundle.tree_sha256 !== chosen.bundle_sha256)
            fail(
              "irreproducible",
              "rebuilt bundle digest differs from the archived bundle",
            );
          reproducible =
            record.build.reproducible ||
            !config.harness.build.require_reproducible_bundle;
          reproDetail = `tree ${manifest.harness.tree_sha256.slice(0, 12)} and bundle ${chosen.bundle_sha256.slice(0, 12)} reproduced from the manifest`;
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      } catch (error) {
        if (error instanceof EvolutionError && error.code === "tamper_detected")
          integrity.push(reasonOf(error));
        reproDetail = reasonOf(error);
      }
      gates.push({
        name: "integrity",
        passed: integrity.length === 0,
        detail:
          integrity.join("; ") ||
          "ledger, champion history, control digests and evaluator digest verified",
      });
      gates.push({
        name: "reproducibility",
        passed: reproducible,
        detail: reproDetail,
      });
      const championSubject = {
        id: `${CHAMPION_PREFIX}${championRow.seq}`,
        manifest: championManifest,
        manifest_sha256: championRow.manifest_sha256,
        bundle_sha256: championRow.bundle_sha256 as string,
      };
      const candidateSubject = {
        id: chosen.candidate_id,
        manifest,
        manifest_sha256: chosen.manifest_sha256,
        bundle_sha256: chosen.bundle_sha256,
      };
      const compare = async (
        split: Split,
        tasks: string[],
        repeats: number,
        family: string | null,
      ) => {
        const seed = digestOf([config.seed, decisionId, split, family]);
        const key = family === null ? decisionId : `${decisionId}-${family}`;
        const champ = await this.evaluate(
          input.run_id,
          lease,
          championSubject,
          split,
          key,
          tasks,
          repeats,
          seed,
          family,
        );
        const cand = await this.evaluate(
          input.run_id,
          lease,
          candidateSubject,
          split,
          key,
          tasks,
          repeats,
          seed,
          family,
        );
        const diffs = tasks.map(
          (_, index) =>
            strictMean(cand.per_task[index]?.rewards ?? [], repeats) -
            strictMean(champ.per_task[index]?.rewards ?? [], repeats),
        );
        const interval = pairedInterval(diffs, {
          confidence: config.final_test.confidence,
          samples: config.final_test.bootstrap_samples,
          seed: digestOf([seed, "bootstrap"]),
        });
        return { champ, cand, interval };
      };
      let quality: Interval = pairedInterval([], {
        confidence: config.final_test.confidence,
        samples: 200,
        seed: "none",
      });
      const regressions: PromotionDecision["regressions"] = [];
      const cost = {
        candidate_usd_per_trial: null as number | null,
        champion_usd_per_trial: null as number | null,
      };
      let simulated = control.simulated;
      let overBudget: string | null = null;
      if (integrity.length === 0)
        try {
          const final = await compare(
            "final",
            config.final_test.tasks,
            config.final_test.repeats,
            null,
          );
          quality = final.interval;
          simulated = final.cand.simulated || final.champ.simulated;
          const trials =
            config.final_test.tasks.length * config.final_test.repeats;
          cost.candidate_usd_per_trial =
            final.cand.cost_usd === null ? null : final.cand.cost_usd / trials;
          cost.champion_usd_per_trial =
            final.champ.cost_usd === null
              ? null
              : final.champ.cost_usd / trials;
          for (const family of config.regression_families) {
            const result = await compare(
              "regression",
              family.tasks,
              config.final_test.repeats,
              family.family,
            );
            regressions.push({
              family: family.family,
              interval: result.interval,
              tolerance: family.tolerance,
            });
          }
          const baseline = final.cand.per_task.flatMap(
            (row) => row.baseline_rewards ?? [],
          );
          if (baseline.length > 0)
            notes.push(
              `mini-swe-agent baseline strict mean on final set: ${strictMean(baseline, baseline.length).toFixed(4)}`,
            );
        } catch (error) {
          if (
            !(error instanceof EvolutionError && error.code === "over_budget")
          )
            throw error;
          overBudget = reasonOf(error);
        }
      gates.push({
        name: "quality",
        passed:
          integrity.length === 0 &&
          overBudget === null &&
          quality.n >= 2 &&
          quality.low > config.final_test.min_improvement,
        detail: `Δ strict mean ${quality.mean.toFixed(4)}, ${Math.round(quality.confidence * 100)}% CI [${quality.low.toFixed(4)}, ${quality.high.toFixed(4)}] over ${quality.n} held-out tasks; needs low > ${config.final_test.min_improvement}`,
      });
      const regressed = regressions.filter(
        (row) => row.interval.mean < -row.tolerance,
      );
      gates.push({
        name: "regression",
        passed: integrity.length === 0 && regressed.length === 0,
        detail:
          regressions.length === 0
            ? "no regression families configured"
            : regressions
                .map(
                  (row) =>
                    `${row.family}: Δ ${row.interval.mean.toFixed(4)} (tol ${row.tolerance})`,
                )
                .join("; "),
      });
      const { candidate_usd_per_trial: c, champion_usd_per_trial: b } = cost;
      const costPassed =
        integrity.length === 0 &&
        overBudget === null &&
        (c === null || b === null
          ? config.cost_gate.allow_unknown_cost
          : c <= b * (1 + config.cost_gate.max_relative_increase) + 1e-12);
      gates.push({
        name: "cost",
        passed: costPassed,
        detail:
          overBudget ??
          `candidate ${c ?? "unknown"} vs champion ${b ?? "unknown"} USD/trial; max +${config.cost_gate.max_relative_increase * 100}%`,
      });
      const hard = gates.filter(
        (gate) => gate.name !== "quality" && !gate.passed,
      );
      const verdict: PromotionDecision["verdict"] =
        hard.length > 0
          ? "rejected"
          : gates.find((gate) => gate.name === "quality")?.passed
            ? "accepted"
            : "no_improvement";
      if (verdict === "no_improvement")
        notes.push(
          "no statistically supported improvement over the champion on the held-out set; champion unchanged",
        );
      if (simulated)
        notes.push(
          "SIMULATED evaluator: not evidence of real task-solving ability",
        );
      const decision = PromotionDecisionSchema.parse({
        schema: "mars.evolution-promotion/v1",
        decision_id: decisionId,
        run_id: input.run_id,
        candidate_id: chosen.candidate_id,
        candidate_manifest_sha256: chosen.manifest_sha256,
        champion: {
          entry_seq: championRow.seq,
          manifest_sha256: championRow.manifest_sha256,
        },
        verdict,
        gates,
        quality,
        regressions,
        cost,
        final_test_uses: this.store.countEvaluations(input.run_id, "final"),
        evaluator_digest: control.evaluator_digest,
        simulated,
        decided_at: nowIso(this.now()),
        notes,
      });
      const decisionJson = canonicalJson(decision);
      this.store.transaction(() => {
        this.store.assertLease(input.run_id, lease, this.now());
        this.store.insertDecision({
          decision_id: decisionId,
          scope_key,
          run_id: input.run_id,
          candidate_id: chosen.candidate_id,
          idempotency_key: input.idempotency_key,
          decision_json: decisionJson,
          created_at: decision.decided_at,
        });
        if (verdict === "accepted") {
          const moved = this.store.moveChampion(
            {
              scope_key,
              run_id: input.run_id,
              candidate_id: chosen.candidate_id,
              manifest_json: chosen.manifest_json,
              manifest_sha256: chosen.manifest_sha256,
              bundle_sha256: chosen.bundle_sha256,
              decision_id: decisionId,
              action: "deploy",
              target_seq: null,
              created_at: decision.decided_at,
            },
            pointer.pointer_version,
            "new",
          );
          this.store.markDecisionDeployed(decisionId, moved.entry_seq);
        }
      });
      return decision;
    } finally {
      this.store.releaseLease(input.run_id, lease);
    }
  }

  champion(scopeKey: string) {
    this.store.verifyChampionChain(scopeKey);
    const pointer = this.store.championPointer(scopeKey);
    if (!pointer) return null;
    const entry = this.store.championEntry(
      scopeKey,
      pointer.entry_seq,
    ) as ChampionEntryRow;
    return {
      pointer_version: pointer.pointer_version,
      entry_seq: entry.seq,
      run_id: entry.run_id,
      candidate_id: entry.candidate_id,
      action: entry.action,
      manifest_sha256: entry.manifest_sha256,
      bundle_sha256: entry.bundle_sha256,
      manifest: this.manifestOf(entry),
    };
  }

  history(scopeKey: string) {
    this.store.verifyChampionChain(scopeKey);
    return this.store.championEntries(scopeKey).map((entry) => ({
      seq: entry.seq,
      action: entry.action,
      run_id: entry.run_id,
      candidate_id: entry.candidate_id,
      manifest_sha256: entry.manifest_sha256,
      decision_id: entry.decision_id,
      target_seq: entry.target_seq,
      created_at: entry.created_at,
    }));
  }

  /** Re-points production at any earlier champion (appends a `rollback` history entry; nothing is deleted). */
  rollback(input: {
    scope_key: string;
    to_entry_seq: number;
    expected_pointer_version: number;
  }) {
    return this.store.transaction(() => {
      this.store.verifyChampionChain(input.scope_key);
      const target = this.store.championEntry(
        input.scope_key,
        input.to_entry_seq,
      );
      if (!target)
        fail("not_found", `champion history entry ${input.to_entry_seq}`);
      const pointer = this.store.championPointer(input.scope_key);
      if (pointer?.entry_seq === target.seq)
        fail("invalid_state", "that entry is already the champion");
      const moved = this.store.moveChampion(
        {
          scope_key: input.scope_key,
          run_id: target.run_id,
          candidate_id: target.candidate_id,
          manifest_json: target.manifest_json,
          manifest_sha256: target.manifest_sha256,
          bundle_sha256: target.bundle_sha256,
          decision_id: target.decision_id,
          action: "rollback",
          target_seq: target.seq,
          created_at: nowIso(this.now()),
        },
        input.expected_pointer_version,
        "new",
      );
      return { ...moved, manifest_sha256: target.manifest_sha256 };
    });
  }

  lineage(runId: string) {
    this.config(runId);
    const rows = this.store.listCandidates(runId);
    const children = new Map<string, number>();
    for (const row of rows)
      if (row.parent_id)
        children.set(row.parent_id, (children.get(row.parent_id) ?? 0) + 1);
    return rows.map((row) => ({
      candidate_id: row.candidate_id,
      parent_id: row.parent_id,
      generation: row.generation,
      depth: row.depth,
      state: row.state,
      eligible: row.eligible === 1,
      score: row.score,
      children: children.get(row.candidate_id) ?? 0,
      manifest_sha256: row.manifest_sha256,
      reason: row.reason,
    }));
  }

  /** Full integrity audit: manifests, DAG, patch-chain replay, ledger and champion chains. */
  async verify(
    runId: string,
  ): Promise<{ ok: boolean; problems: string[]; reproduced: number }> {
    const { config, scope_key } = this.config(runId);
    const problems: string[] = [];
    let reproduced = 0;
    const seen = new Map<string, AgentManifest>();
    for (const row of this.store.listCandidates(runId)) {
      try {
        const manifest = this.manifestOf(row);
        if (row.parent_id !== null) {
          const parent = seen.get(row.parent_id);
          if (!parent)
            fail(
              "corrupt_record",
              `parent ${row.parent_id} of ${row.candidate_id} is not an earlier candidate`,
            );
          const prefix = parent.harness.patches;
          if (
            canonicalJson(manifest.harness.patches.slice(0, prefix.length)) !==
            canonicalJson(prefix)
          )
            fail(
              "corrupt_record",
              `${row.candidate_id} patch chain does not extend its parent's`,
            );
        }
        seen.set(row.candidate_id, manifest);
        if (row.state !== "rejected") {
          const dir = await this.scratch(runId, `${row.candidate_id}-verify`);
          try {
            await this.reproduceTree(manifest, dir, config.harness);
            reproduced += 1;
          } finally {
            await rm(dir, { recursive: true, force: true });
          }
        }
      } catch (error) {
        problems.push(`${row.candidate_id}: ${reasonOf(error)}`);
      }
    }
    for (const check of [
      () => this.store.verifyLedger(runId),
      () => this.store.verifyChampionChain(scope_key),
    ])
      try {
        check();
      } catch (error) {
        problems.push(reasonOf(error));
      }
    return { ok: problems.length === 0, problems, reproduced };
  }

  /**
   * Search-process metrics (how well the search spends budget) are kept apart
   * from task-solving metrics (held-out final-set deltas from promotions).
   */
  metrics(runId: string) {
    const { config, scope_key, control } = this.config(runId);
    const rows = this.store.listCandidates(runId);
    const generations = this.store
      .listGenerations(runId)
      .flatMap((row) =>
        row.record_json
          ? [JSON.parse(row.record_json) as GenerationRecord]
          : [],
      );
    const rejected: Record<string, number> = {};
    for (const row of rows)
      if (row.state === "rejected")
        rejected[reasonCode(row.reason ?? "rejected")] =
          (rejected[reasonCode(row.reason ?? "rejected")] ?? 0) + 1;
    const archive = this.archive(runId, config);
    const children = new Map<string, number>();
    for (const member of archive)
      if (member.parent_id)
        children.set(
          member.parent_id,
          (children.get(member.parent_id) ?? 0) + 1,
        );
    const decisions = (
      this.store.db
        .query(
          "SELECT decision_json FROM decisions WHERE run_id = ? ORDER BY created_at",
        )
        .all(runId) as { decision_json: string }[]
    ).map((row) =>
      PromotionDecisionSchema.parse(JSON.parse(row.decision_json)),
    );
    const spent = this.spent(runId);
    const children_proposed = rows.length - 1;
    return {
      simulated: control.simulated,
      search_process: {
        children_proposed,
        rejected,
        eligible_rate:
          children_proposed === 0
            ? 0
            : rows.filter(
                (row) => row.candidate_id !== "initial" && row.eligible === 1,
              ).length / children_proposed,
        archive_size: archive.length,
        archive_leaves: archive.filter(
          (member) => !children.has(member.candidate_id),
        ).length,
        max_depth: Math.max(0, ...rows.map((row) => row.depth)),
        best_selection_score_by_generation: generations.map(
          (row) => row.best_selection_score,
        ),
        initial_selection_score: rows[0]?.score ?? null,
        spend: spent,
        budget: config.budget,
      },
      task_solving: {
        final_test_uses: this.store.countEvaluations(runId, "final"),
        decisions: decisions.map((row) => ({
          decision_id: row.decision_id,
          candidate_id: row.candidate_id,
          verdict: row.verdict,
          quality: row.quality,
        })),
        champion: this.champion(scope_key)?.candidate_id ?? null,
      },
    };
  }

  status(runId: string) {
    const run = this.store.getRun(runId);
    if (!run) fail("not_found", `run ${runId}`);
    return {
      run_id: run.run_id,
      scope_key: run.scope_key,
      status: run.status,
      revision: run.revision,
      created_at: run.created_at,
      updated_at: run.updated_at,
    };
  }
}

/** Known candidate plus in-job baseline spend; unknown parts count 0 here. */
function knownSpend(
  own: number | null,
  baseline: number | null | undefined,
): number {
  return (own ?? 0) + (baseline ?? 0);
}

/** Ledger charge: the known total, or at least the full matched budget when any part is unknown. */
function chargedSpend(
  own: number | null,
  baseline: number | null | undefined,
  cap: number,
): number {
  const known = knownSpend(own, baseline);
  return own === null || baseline === null ? Math.max(cap, known) : known;
}

/** Applied to fresh and cached outcomes alike, so a resumed decision cannot skip it. */
function assertWithinBudget(
  subjectId: string,
  outcome: EvaluationOutcome,
  budget: Budget,
): void {
  const usd = knownSpend(outcome.cost_usd, outcome.baseline_cost_usd);
  const tokens = knownSpend(outcome.tokens, outcome.baseline_tokens);
  if (usd > budget.max_usd + 1e-9 || tokens > budget.max_tokens)
    fail(
      "over_budget",
      `${subjectId} exceeded the matched evaluation budget (${usd} USD, ${tokens} tokens)`,
    );
}

/** Refuses mutations the evaluator would not apply, so their scores never measure the parent. */
function assertMutationApplied(
  parent: AgentManifest,
  child: AgentManifest,
  applied: readonly string[] | undefined,
): void {
  if (applied === undefined) return;
  const keys = new Set([
    ...Object.keys(parent.prompts),
    ...Object.keys(child.prompts),
  ]);
  const inert = [...keys].filter(
    (key) =>
      parent.prompts[key] !== child.prompts[key] && !applied.includes(key),
  );
  if (
    !applied.includes("mars_agent_settings") &&
    digestOf([parent.skills, parent.tools, parent.retrieval]) !==
      digestOf([child.skills, child.tools, child.retrieval])
  )
    inert.push("skills/tools/retrieval");
  if (inert.length > 0)
    fail(
      "invalid_input",
      `inert_mutation: evaluator does not apply ${inert.join(", ")}`,
    );
}
