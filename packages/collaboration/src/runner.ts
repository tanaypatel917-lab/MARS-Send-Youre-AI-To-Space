import { randomUUID } from "node:crypto";
import type { ArtifactRef, Budget, Scope } from "@mars/contracts";
import type { Collaboration, LaunchContext } from "./coordinator";
import { CollaborationError } from "./errors";
import type { ChildUsage } from "./schemas";

export interface ChildLaunch {
  room_id: string;
  agent_id: string;
  parent_agent_id: string;
  role_label: string;
  scope: Scope;
  task_id: string;
  task_revision: number;
  child_task_id: string;
  instruction: string;
  approvals: { read: boolean; write: boolean; execute: boolean };
  paid_models: boolean;
  model_id: string | null;
  budget: Budget;
  max_steps: number;
  workspace_mode: "private" | "read_only";
  write_paths: string[];
  session_ref: string | null;
  attempt: number;
}

/** `steps` counts this attempt only; the runner adds earlier attempts. */
export interface ChildProgress {
  steps: number;
  usage: ChildUsage | null;
  session_ref?: string;
  base_revision?: string | null;
}

export interface ChildRun {
  session_ref: string | null;
  base_revision: string | null;
  outcome: Promise<ChildOutcome>;
  cancel(): Promise<void>;
}

/** `usage.steps` counts this attempt only; tokens and usd are session totals. */
export interface ChildOutcome {
  status: "completed" | "paused" | "failed" | "cancelled";
  summary: string;
  artifacts: ArtifactRef[];
  usage: ChildUsage | null;
}

export interface ChildRuntimeAdapter {
  start(
    launch: ChildLaunch,
    hooks: {
      signal: AbortSignal;
      onProgress(progress: ChildProgress): Promise<void>;
    },
  ): Promise<ChildRun>;
  reconcile?(sessionRef: string): Promise<ChildUsage | null>;
}

export type ModelSelectionPolicy = (request: {
  role_label: string;
  complexity: "light" | "medium" | "heavy" | null;
  solution_space: string | null;
  parent_model_id: string | null;
  paid_allowed: boolean;
  depth: number;
  task_id: string;
  task_revision: number;
  child_task_id: string;
  instruction: string;
  approvals: { read: boolean; write: boolean; execute: boolean };
  budget: Budget;
}) => Promise<{ model_id: string | null; reason: string }>;

export const inheritModelPolicy: ModelSelectionPolicy = async () => ({
  model_id: null,
  reason: "inherit",
});

export interface ChildRunner {
  tick(): Promise<number>;
  idle(): Promise<void>;
  recover(): Promise<RecoveryReport>;
  shutdown(): Promise<void>;
  readonly runnerId: string;
}

export interface RecoveryReport {
  examined: number;
  requeued: number;
  failed_closed: number;
}

export interface ChildRunnerOptions {
  collaboration: Collaboration;
  adapter: ChildRuntimeAdapter;
  modelPolicy?: ModelSelectionPolicy;
  runnerId?: string;
  heartbeatMs?: number;
}

interface LocalRun {
  promise: Promise<void>;
  cancel(): Promise<void>;
}

function tokenUse(usage: ChildUsage): number {
  return usage.input_tokens + usage.output_tokens;
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;

type DeadlineTimerSetter = (
  callback: () => void,
  delay: number,
) => ReturnType<typeof setTimeout>;

export function armDeadline(
  deadlineAt: number,
  now: () => number,
  onExpire: () => void,
  setTimer: DeadlineTimerSetter = setTimeout,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disarmed = false;
  const arm = () => {
    if (disarmed) return;
    const delay = Math.min(Math.max(deadlineAt - now(), 0), MAX_TIMER_DELAY_MS);
    timer = setTimer(() => {
      if (disarmed) return;
      if (now() >= deadlineAt) {
        disarmed = true;
        onExpire();
        return;
      }
      arm();
    }, delay);
    timer.unref();
  };
  arm();
  return () => {
    disarmed = true;
    if (timer) clearTimeout(timer);
  };
}

function childTaskId(context: LaunchContext): string {
  return `${context.task_id}.child.${context.member.agent_id}`;
}

function launchBudget(context: LaunchContext, now: number): Budget {
  const budget = context.member.budget;
  const pool = context.member.pool;
  const charged = context.charged_usage;
  const remainingTokens =
    budget.max_tokens -
    pool.tokens -
    charged.input_tokens -
    charged.output_tokens;
  const remainingUsd = budget.max_usd - pool.usd - charged.usd;
  const remainingMs = Math.floor(budget.deadline - now);
  if (remainingTokens <= 0)
    throw new CollaborationError(
      "budget_exceeded",
      "Child token budget is exhausted",
    );
  if (remainingUsd < 0)
    throw new CollaborationError(
      "budget_exceeded",
      "Child cost budget is exhausted",
    );
  if (remainingMs <= 0)
    throw new CollaborationError("expired", "Child deadline has passed");
  return {
    max_tokens: remainingTokens,
    max_usd: remainingUsd,
    max_duration_ms: remainingMs,
    max_depth: 0,
    max_concurrency: 1,
  };
}

function remainingSteps(context: LaunchContext): number {
  const limit = context.member.budget.max_steps ?? 10_000;
  const remaining = limit - context.charged_usage.steps;
  if (remaining <= 0)
    throw new CollaborationError(
      "budget_exceeded",
      "Child step budget is exhausted",
    );
  return remaining;
}

function makeLaunch(
  context: LaunchContext,
  modelId: string | null,
  now: number,
): ChildLaunch {
  const authority = context.member.authority;
  return {
    room_id: context.room.room_id,
    agent_id: context.member.agent_id,
    parent_agent_id: context.member.parent_agent_id ?? "",
    role_label: context.member.role_label,
    scope: context.room.scope,
    task_id: context.task_id,
    task_revision: context.task_revision,
    child_task_id: childTaskId(context),
    instruction: context.instruction,
    approvals: {
      read: authority.read,
      write: authority.write,
      execute: authority.execute,
    },
    paid_models: context.paid_models,
    model_id: modelId,
    budget: launchBudget(context, now),
    max_steps: remainingSteps(context),
    workspace_mode:
      context.member.workspace_mode === "private" ? "private" : "read_only",
    write_paths: context.member.write_paths,
    session_ref: context.session_ref,
    attempt: context.attempt,
  };
}

export function createChildRunner(options: ChildRunnerOptions): ChildRunner {
  const runnerId = options.runnerId ?? randomUUID();
  const modelPolicy = options.modelPolicy ?? inheritModelPolicy;
  const heartbeatMs =
    options.heartbeatMs ??
    Math.floor(options.collaboration.host.jobs.leaseMs / 3);
  if (
    !Number.isSafeInteger(heartbeatMs) ||
    heartbeatMs <= 0 ||
    heartbeatMs > MAX_TIMER_DELAY_MS
  )
    throw new CollaborationError("invalid_input", "Invalid heartbeat interval");
  const localRuns = new Map<string, LocalRun>();
  let stopped = false;

  async function startClaimed(
    claimed: NonNullable<
      Awaited<ReturnType<typeof options.collaboration.host.jobs.claim>>
    >,
  ): Promise<void> {
    const jobId = claimed.job_id;
    const controller = new AbortController();
    let childRun: ChildRun | undefined;
    let launch: ChildLaunch | undefined;
    let latest: ChildProgress = { steps: 0, usage: null };
    let leaseLost = false;
    let stopReason: "budget" | "cancelled" | null = null;
    let adapterCalled = false;
    let heartbeatBusy = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let disarmDeadline: (() => void) | undefined;
    let contextDeadline: number | undefined;
    let usageBaseline: ChildUsage = {
      input_tokens: 0,
      output_tokens: 0,
      usd: 0,
      steps: 0,
    };
    const cancelRun = async (reason: "budget" | "cancelled" | "lease_lost") => {
      if (reason !== "lease_lost") stopReason ??= reason;
      if (!controller.signal.aborted) controller.abort();
      await childRun?.cancel().catch(() => undefined);
    };
    const onProgress = async (progress: ChildProgress) => {
      const { session_ref: reportedSessionRef, ...progressWithoutSessionRef } =
        progress;
      const sessionRef = reportedSessionRef || latest.session_ref;
      const baseRevision =
        progress.base_revision !== undefined
          ? progress.base_revision
          : latest.base_revision;
      const normalizedProgress: ChildProgress = {
        ...progressWithoutSessionRef,
        steps: usageBaseline.steps + progress.steps,
        usage: progress.usage
          ? {
              ...progress.usage,
              steps: usageBaseline.steps + progress.usage.steps,
            }
          : null,
        ...(sessionRef ? { session_ref: sessionRef } : {}),
      };
      latest = {
        ...latest,
        ...progressWithoutSessionRef,
        ...(sessionRef ? { session_ref: sessionRef } : {}),
        ...(baseRevision !== undefined ? { base_revision: baseRevision } : {}),
      };
      const observedDelta = progress.usage
        ? {
            input_tokens: Math.max(
              0,
              progress.usage.input_tokens - usageBaseline.input_tokens,
            ),
            output_tokens: Math.max(
              0,
              progress.usage.output_tokens - usageBaseline.output_tokens,
            ),
            usd: Math.max(0, progress.usage.usd - usageBaseline.usd),
            steps: progress.usage.steps,
          }
        : null;
      const isBudgetStop =
        (launch !== undefined &&
          (progress.steps > launch.max_steps ||
            (observedDelta !== null &&
              (tokenUse(observedDelta) > launch.budget.max_tokens ||
                observedDelta.usd > launch.budget.max_usd)))) ||
        options.collaboration.host.jobs.currentTime() >=
          (contextDeadline ?? Number.MAX_SAFE_INTEGER);
      try {
        const result = await options.collaboration.host.jobs.heartbeat(
          jobId,
          runnerId,
          claimed.lease_epoch,
          normalizedProgress,
        );
        if (isBudgetStop) await cancelRun("budget");
        else if (result.stop) await cancelRun("cancelled");
      } catch (error) {
        if (
          error instanceof CollaborationError &&
          error.code === "lease_lost"
        ) {
          leaseLost = true;
          await cancelRun("lease_lost");
          return;
        }
        throw error;
      }
    };
    let readyResolve: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      readyResolve = resolve;
    });
    let readySettled = false;
    const markReady = () => {
      if (readySettled) return;
      readySettled = true;
      readyResolve?.();
    };

    const promise = (async () => {
      try {
        const context =
          await options.collaboration.host.jobs.getLaunchContext(jobId);
        contextDeadline = context.member.budget.deadline;
        usageBaseline = context.charged_usage;
        let modelId: string | null = context.model_id;
        if (context.session_ref === null) {
          const selected = await modelPolicy({
            role_label: context.member.role_label,
            complexity: context.complexity,
            solution_space: context.solution_space,
            parent_model_id: context.parent_model_id,
            paid_allowed: context.paid_models,
            depth: context.member.depth,
            task_id: context.task_id,
            task_revision: context.task_revision,
            child_task_id: childTaskId(context),
            instruction: context.instruction,
            approvals: {
              read: context.member.authority.read,
              write: context.member.authority.write,
              execute: context.member.authority.execute,
            },
            budget: launchBudget(context, context.now),
          });
          if (
            !selected ||
            (typeof selected.model_id !== "string" &&
              selected.model_id !== null) ||
            typeof selected.reason !== "string"
          )
            throw new CollaborationError(
              "invalid_input",
              "Model policy returned invalid selection",
            );
          modelId = selected.model_id ?? context.parent_model_id;
          await options.collaboration.host.jobs.setModelSelection(
            jobId,
            runnerId,
            claimed.lease_epoch,
            modelId,
            selected.reason,
          );
        }
        launch = makeLaunch(context, modelId, context.now);
        disarmDeadline = armDeadline(
          context.member.budget.deadline,
          () => options.collaboration.host.jobs.currentTime(),
          () => void cancelRun("budget"),
        );
        adapterCalled = true;
        childRun = await options.adapter.start(launch, {
          signal: controller.signal,
          onProgress,
        });
        latest = {
          ...latest,
          ...(childRun.session_ref
            ? { session_ref: childRun.session_ref }
            : {}),
          base_revision: childRun.base_revision,
        };
        if (controller.signal.aborted)
          await childRun.cancel().catch(() => undefined);
        try {
          await onProgress(latest);
        } catch (error) {
          if (
            error instanceof CollaborationError &&
            error.code === "lease_lost"
          ) {
            leaseLost = true;
            await cancelRun("lease_lost");
          } else {
            throw error;
          }
        }
        const heartbeat = async () => {
          if (heartbeatBusy || leaseLost || controller.signal.aborted) return;
          heartbeatBusy = true;
          try {
            await onProgress(latest);
          } catch (error) {
            if (
              error instanceof CollaborationError &&
              error.code === "lease_lost"
            ) {
              leaseLost = true;
              await cancelRun("lease_lost");
            } else {
              await cancelRun("cancelled");
            }
          } finally {
            heartbeatBusy = false;
          }
        };
        timer = setInterval(() => void heartbeat(), heartbeatMs);
        timer.unref();
        markReady();
        let outcome: ChildOutcome;
        try {
          outcome = await childRun.outcome;
        } catch {
          outcome = {
            status: "failed",
            summary: "Child runtime failed without a reportable result.",
            artifacts: [],
            usage: null,
          };
        }
        if (leaseLost) return;
        const errorCode =
          stopReason === "budget" ? "budget_exceeded" : undefined;
        if (stopReason === "budget") outcome = { ...outcome, status: "failed" };
        if (stopReason === "cancelled" && outcome.status !== "failed")
          outcome = { ...outcome, status: "cancelled" };
        if (outcome.usage)
          outcome = {
            ...outcome,
            usage: {
              ...outcome.usage,
              steps: usageBaseline.steps + outcome.usage.steps,
            },
          };
        await options.collaboration.host.jobs.finalize(
          jobId,
          runnerId,
          claimed.lease_epoch,
          {
            ...outcome,
            ...(errorCode ? { errorCode } : {}),
          },
        );
      } catch (error) {
        markReady();
        if (leaseLost) return;
        const zeroUsageStartFailure =
          childRun === undefined &&
          adapterCalled &&
          error instanceof CollaborationError &&
          (error.code === "forbidden" || error.code === "invalid_input");
        const budgetBeforeOpen =
          error instanceof CollaborationError &&
          (error.code === "budget_exceeded" || error.code === "expired");
        const usage =
          !adapterCalled || zeroUsageStartFailure
            ? { input_tokens: 0, output_tokens: 0, usd: 0, steps: 0 }
            : null;
        const errorCode =
          error instanceof CollaborationError &&
          error.code === "budget_exceeded"
            ? "budget_exceeded"
            : undefined;
        try {
          await options.collaboration.host.jobs.finalize(
            jobId,
            runnerId,
            claimed.lease_epoch,
            {
              status: "failed",
              summary: budgetBeforeOpen
                ? "Child budget expired before execution."
                : "Child runtime could not be started.",
              artifacts: [],
              usage,
              ...(errorCode ? { errorCode } : {}),
            },
          );
        } catch {
          return;
        }
      } finally {
        if (timer) clearInterval(timer);
        disarmDeadline?.();
        if (controller.signal.aborted)
          await childRun?.cancel().catch(() => undefined);
        markReady();
      }
    })().finally(() => localRuns.delete(jobId));
    localRuns.set(jobId, {
      promise,
      async cancel() {
        try {
          await options.collaboration.host.jobs.requestCancel(
            jobId,
            runnerId,
            claimed.lease_epoch,
          );
        } catch (error) {
          if (
            !(
              error instanceof CollaborationError && error.code === "lease_lost"
            )
          )
            throw error;
        }
        await cancelRun("cancelled");
      },
    });
    await ready;
  }

  async function tick(): Promise<number> {
    if (stopped) return 0;
    let claimedCount = 0;
    while (!stopped) {
      const claim = await options.collaboration.host.jobs.claim(runnerId);
      if (!claim) break;
      claimedCount += 1;
      await startClaimed(claim);
    }
    return claimedCount;
  }

  return {
    runnerId,
    tick,
    async idle() {
      while (localRuns.size > 0)
        await Promise.all([...localRuns.values()].map((run) => run.promise));
    },
    async recover() {
      const expired = await options.collaboration.host.jobs.recoverExpired();
      let requeued = 0;
      let failedClosed = 0;
      for (const job of expired) {
        let usage: ChildUsage | null = null;
        if (job.session_ref && options.adapter.reconcile) {
          try {
            usage = await options.adapter.reconcile(job.session_ref);
          } catch {
            usage = null;
          }
        }
        const recovered = await options.collaboration.host.jobs.recoverJob(
          job.job_id,
          usage,
        );
        if (recovered === "requeued") requeued += 1;
        if (recovered === "failed") failedClosed += 1;
      }
      return {
        examined: expired.length,
        requeued,
        failed_closed: failedClosed,
      };
    },
    async shutdown() {
      stopped = true;
      await Promise.all([...localRuns.values()].map((run) => run.cancel()));
      await this.idle();
    },
  };
}
