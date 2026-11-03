import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type {
  ArtifactRef,
  Budget,
  EvaluationService,
  JobRef,
  JobResult,
  RequestContext,
} from "@mars/contracts";
import { ArtifactRefSchema, BudgetSchema } from "@mars/contracts";
import { z } from "zod";
import { readHarborJob } from "./harbor-records";
import {
  type ComparisonManifest,
  canonicalJson,
  parseComparisonManifestBytes,
  sha256Hex,
} from "./manifest";
import { MARS_AGENT_NAME, MINI_SWE_AGENT_VERSION } from "./pins";
import { buildEvaluationReport, EVALUATION_REPORT_MEDIA_TYPE } from "./report";
import type { HarborRunner } from "./runner";
import { type ArtifactSink, storeTrialBundle } from "./trajectory";

export interface ArtifactReader {
  get(context: RequestContext, ref: ArtifactRef): Promise<Uint8Array>;
}

export interface EvaluationServiceOptions {
  /** Absolute directory holding the durable job records (`<stateDir>/jobs/<id>.json`). */
  stateDir: string;
  runner: HarborRunner;
  artifacts: ArtifactSink & ArtifactReader;
  now?: () => number;
  /** Candidate component files are written here (absolute) for the Python adapter. */
  candidateDir?: string;
}

const RunStateSchema = z
  .object({
    arm: z.enum(["baseline", "candidate"]),
    job_name: z.string(),
    outcome: z.unknown().nullable(),
    error: z.string().nullable(),
  })
  .strict();

export const JobRecordSchema = z
  .object({
    schema: z.literal("mars.evaluation-job/v1"),
    job_id: z.string(),
    scope: z.object({ owner_id: z.string(), project_id: z.string() }).strict(),
    input_manifest: ArtifactRefSchema,
    comparison_id: z.string(),
    budget: BudgetSchema,
    status: z.enum(["pending", "running", "completed", "failed", "cancelled"]),
    created_at: z.string(),
    updated_at: z.string(),
    deadline_ms: z.number().int(),
    runs: z.array(RunStateSchema),
    /** Process-group ids of Harbor runs still believed to be alive. */
    active_pids: z.array(z.number().int()),
    report: ArtifactRefSchema.nullable(),
    trajectories: z.array(ArtifactRefSchema),
    cost_usd: z.number().nullable(),
    error: z.string().nullable(),
  })
  .strict();
export type JobRecord = z.infer<typeof JobRecordSchema>;

const JOB_ID_PATTERN = /^[a-f0-9]{32}$/;

function killProcessGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    return;
  }
  const escalate = setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // already gone
    }
  }, 5000);
  escalate.unref();
}

function scopeKey(context: RequestContext): string {
  return `${context.scope.owner_id}/${context.scope.project_id}`;
}

export class EvaluationJobStore {
  constructor(private readonly dir: string) {
    if (!isAbsolute(dir))
      throw new TypeError("Job store directory must be absolute.");
  }
  private path(jobId: string): string {
    if (!JOB_ID_PATTERN.test(jobId)) throw new TypeError("Invalid job id.");
    return join(this.dir, `${jobId}.json`);
  }
  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
  }
  private readonly chains = new Map<string, Promise<void>>();
  private sequence = 0;
  /** Writes for one job are serialized so overlapping updates never race over the temp file or reorder. */
  write(record: JobRecord): Promise<void> {
    JobRecordSchema.parse(record);
    const target = this.path(record.job_id);
    const snapshot = JSON.stringify(record, null, 2);
    const previous = this.chains.get(record.job_id) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        this.sequence += 1;
        const tmp = `${target}.${process.pid}.${this.sequence}.tmp`;
        await writeFile(tmp, snapshot, { mode: 0o600 });
        await rename(tmp, target);
      });
    this.chains.set(record.job_id, next);
    const release = () => {
      if (this.chains.get(record.job_id) === next)
        this.chains.delete(record.job_id);
    };
    next.then(release, release);
    return next;
  }
  async read(jobId: string): Promise<JobRecord | null> {
    try {
      return JobRecordSchema.parse(
        JSON.parse(await readFile(this.path(jobId), "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  async list(): Promise<JobRecord[]> {
    const records: JobRecord[] = [];
    for (const entry of (await readdir(this.dir).catch(() => [])).sort()) {
      if (!entry.endsWith(".json")) continue;
      const record = await this.read(entry.slice(0, -5)).catch(() => null);
      if (record) records.push(record);
    }
    return records;
  }
}

/**
 * Durable Harbor comparison service. Both arms run sequentially from the same
 * manifest (same dataset pin, tasks, repeats, model endpoint, Docker images);
 * the baseline arm never sees candidate prompt components and the candidate
 * agent only ever receives the task instruction Harbor hands it.
 */
export function createEvaluationService(
  options: EvaluationServiceOptions,
): EvaluationService & {
  store: EvaluationJobStore;
  /** Resolves when the job's background execution settles (tests). */
  settled(jobId: string): Promise<void>;
} {
  if (!isAbsolute(options.stateDir))
    throw new TypeError("stateDir must be absolute.");
  const now = options.now ?? Date.now;
  const store = new EvaluationJobStore(join(options.stateDir, "jobs"));
  const candidateDir =
    options.candidateDir ?? join(options.stateDir, "candidates");
  const controllers = new Map<string, AbortController>();
  const settled = new Map<string, Promise<void>>();

  async function load(
    context: RequestContext,
    jobId: string,
  ): Promise<JobRecord> {
    const record = await store.read(jobId);
    if (
      !record ||
      scopeKey(context) !==
        `${record.scope.owner_id}/${record.scope.project_id}`
    )
      throw new Error(`Unknown evaluation job ${jobId}`);
    return record;
  }

  async function execute(
    context: RequestContext,
    record: JobRecord,
    manifest: ComparisonManifest,
  ) {
    const controller = controllers.get(record.job_id);
    if (!controller) return;
    const update = async (patch: Partial<JobRecord>) => {
      Object.assign(record, patch, {
        updated_at: new Date(now()).toISOString(),
      });
      await store.write(record);
    };
    try {
      await update({ status: "running" });
      await mkdir(candidateDir, { recursive: true, mode: 0o700 });
      const candidatePath = join(candidateDir, `${record.job_id}.json`);
      await writeFile(
        candidatePath,
        canonicalJson({
          schema: "mars.prompt-candidate/v1",
          ...manifest.arms.candidate.candidate,
        }),
        { mode: 0o600 },
      );
      const runArm = async (arm: "baseline" | "candidate") => {
        controller.signal.throwIfAborted();
        const jobName = `${record.job_id}-${arm}`;
        const pending: Promise<void>[] = [];
        const outcome = await options.runner.run({
          manifest,
          arm,
          tasks: manifest.tasks,
          repeats: manifest.repeats,
          jobName,
          deadlineMs: record.deadline_ms,
          maxConcurrency: record.budget.max_concurrency,
          signal: controller.signal,
          candidatePath,
          onSpawn: (pid) => {
            record.active_pids.push(pid);
            pending.push(update({}).catch(() => undefined));
          },
        });
        await Promise.all(pending);
        record.active_pids = [];
        record.runs.push({ arm, job_name: jobName, outcome, error: null });
        await update({});
        if (outcome.killed === "cancelled") throw new Error("cancelled");
        if (outcome.killed === "deadline")
          throw new Error(
            "Budget max_duration_ms exceeded; Harbor was killed.",
          );
        return outcome;
      };
      const outcomes = {
        baseline: await runArm("baseline"),
        candidate: await runArm("candidate"),
      };
      const parsed = {
        baseline: await readHarborJob(outcomes.baseline.job_dir),
        candidate: await readHarborJob(outcomes.candidate.job_dir),
      };
      const trajectories: ArtifactRef[] = [];
      for (const arm of ["baseline", "candidate"] as const) {
        for (const trial of parsed[arm].trials) {
          trajectories.push(
            await storeTrialBundle(
              options.artifacts,
              context,
              join(outcomes[arm].job_dir, trial.trial_name),
              trial,
            ),
          );
        }
      }
      const report = buildEvaluationReport(
        manifest,
        {
          baseline: {
            agent: { name: "mini-swe-agent", version: MINI_SWE_AGENT_VERSION },
            trials: parsed.baseline.trials,
            harbor: parsed.baseline.job.stats,
            unreadable_trials: parsed.baseline.unreadable_trials,
          },
          candidate: {
            agent: {
              name: MARS_AGENT_NAME,
              version: parsed.candidate.trials[0]?.agent.version ?? "unknown",
            },
            trials: parsed.candidate.trials,
            harbor: parsed.candidate.job.stats,
            unreadable_trials: parsed.candidate.unreadable_trials,
          },
        },
        now,
      );
      const reportRef = await options.artifacts.put(
        context,
        new TextEncoder().encode(JSON.stringify(report, null, 2)),
        EVALUATION_REPORT_MEDIA_TYPE,
      );
      const costs = [
        report.arms.baseline.total_cost_usd,
        report.arms.candidate.total_cost_usd,
      ];
      await update({
        status: "completed",
        report: reportRef,
        trajectories,
        cost_usd: costs.every((cost) => cost === null)
          ? null
          : costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const cancelled = controller.signal.aborted || message === "cancelled";
      await update({
        status: cancelled ? "cancelled" : "failed",
        error: cancelled ? "cancelled" : message,
      });
    } finally {
      controllers.delete(record.job_id);
    }
  }

  return {
    store,
    settled: (jobId) => settled.get(jobId) ?? Promise.resolve(),
    async submitComparison(context, immutableManifest, budget) {
      await store.init();
      const parsedBudget = BudgetSchema.parse(budget);
      const bytes = await options.artifacts.get(context, immutableManifest);
      if (sha256Hex(bytes) !== immutableManifest.sha256)
        throw new Error(
          "Manifest artifact bytes do not match the artifact ref digest.",
        );
      const manifest = parseComparisonManifestBytes(bytes);
      if (
        manifest.budget.max_usd > parsedBudget.max_usd ||
        manifest.budget.max_duration_ms > parsedBudget.max_duration_ms
      )
        throw new Error("Manifest budget exceeds the submitted budget.");
      const effective: Budget = {
        ...parsedBudget,
        max_usd: Math.min(parsedBudget.max_usd, manifest.budget.max_usd),
        max_duration_ms: Math.min(
          parsedBudget.max_duration_ms,
          manifest.budget.max_duration_ms,
        ),
        max_concurrency: Math.min(
          parsedBudget.max_concurrency,
          manifest.budget.max_concurrency,
        ),
      };
      const createdAt = now();
      const jobId = sha256Hex(
        new TextEncoder().encode(
          canonicalJson([
            scopeKey(context),
            context.request_id,
            immutableManifest.sha256,
            createdAt,
            randomUUID(),
          ]),
        ),
      ).slice(0, 32);
      const record: JobRecord = {
        schema: "mars.evaluation-job/v1",
        job_id: jobId,
        scope: {
          owner_id: context.scope.owner_id,
          project_id: context.scope.project_id,
        },
        input_manifest: immutableManifest,
        comparison_id: manifest.comparison_id,
        budget: effective,
        status: "pending",
        created_at: new Date(createdAt).toISOString(),
        updated_at: new Date(createdAt).toISOString(),
        deadline_ms: createdAt + effective.max_duration_ms,
        runs: [],
        active_pids: [],
        report: null,
        trajectories: [],
        cost_usd: null,
        error: null,
      };
      await store.write(record);
      controllers.set(jobId, new AbortController());
      settled.set(jobId, execute(context, record, manifest));
      return {
        job_id: jobId,
        input_manifest: immutableManifest,
      } satisfies JobRef;
    },
    async inspect(context, jobId) {
      const record = await load(context, jobId);
      return {
        job: { job_id: record.job_id, input_manifest: record.input_manifest },
        status: record.status,
        artifacts: [
          ...(record.report ? [record.report] : []),
          ...record.trajectories,
        ],
        cost_usd: record.cost_usd,
      } satisfies JobResult;
    },
    async cancel(context, jobId) {
      const record = await load(context, jobId);
      const controller = controllers.get(jobId);
      if (controller) {
        controller.abort();
        return;
      }
      if (record.status === "pending" || record.status === "running") {
        // No in-memory controller: this instance did not start the job (the
        // service restarted). Kill the persisted Harbor process groups
        // directly before recording the cancellation.
        for (const pid of record.active_pids) killProcessGroup(pid);
        record.active_pids = [];
        record.status = "cancelled";
        record.error = "cancelled";
        record.updated_at = new Date(now()).toISOString();
        await store.write(record);
      }
    },
  };
}
