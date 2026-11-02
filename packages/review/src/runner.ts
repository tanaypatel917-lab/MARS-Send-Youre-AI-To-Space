import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  MemoryEntry,
  MemoryOperation,
  MemoryProposalService,
  RequestContext,
  SkillProposalService,
} from "@mars/contracts";
import { MemoryStoreError } from "@mars/memory";
import { SkillError, withDirectoryLock } from "@mars/skills";
import { type ReviewModelGateway, ReviewRateLimit } from "./model";
import {
  InvalidOutput,
  OUTPUT_LIMITS,
  parseOutput,
  SYSTEM_PROMPT,
} from "./output";

/**
 * Single proposal-only background review runner. Ported from
 * mars-platform/services/review (Hermes background-review safety semantics,
 * OpenClaw experience-review scheduling; see NOTICE). It never executes tools,
 * never accepts proposals, never writes authoritative memory or skills, and
 * never schedules itself: only foreground turns are eligible.
 */
export type TurnOrigin =
  | "foreground"
  | "review"
  | "cron"
  | "heartbeat"
  | "subagent";
export interface TranscriptMessage {
  role: "user" | "assistant" | "tool";
  content: string;
}
export interface Turn {
  sessionId: string;
  origin: TurnOrigin;
  iterations: number;
  transcript: readonly TranscriptMessage[];
  success?: boolean;
}
export interface ReviewDependencies {
  /** Exact scope the review proposes into; proposals never widen it. */
  context: RequestContext;
  memory: Pick<MemoryProposalService, "submitProposal"> & {
    snapshot(
      context: RequestContext,
    ): Promise<{ revision: number; entries: MemoryEntry[] }>;
  };
  skills: SkillProposalService;
  model: ReviewModelGateway;
  logRoot: string;
  idleMs?: number;
  timeoutMs?: number;
  clock?: () => number;
}
export interface ReviewResult {
  reviewId: string;
  status:
    | "completed"
    | "rejected"
    | "cancelled"
    | "rate-limited"
    | "error"
    | "skipped";
  proposals: { store: "memory" | "skills"; id: string }[];
}
export const REVIEW_LIMITS = {
  iterations_threshold: 10,
  pending_sessions: 32,
  counters: 1024,
  context_chars: 64_000,
  memory_entries: 200,
  skills: 64,
  skill_content_chars: 4000,
  max_tokens: 1024,
  backoff_initial_ms: 15 * 60_000,
  backoff_max_ms: 60 * 60_000,
} as const;

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const EXCLUDED =
  /(^|:)(review|background_review|cron|heartbeat|hook|subagent|acp|memory|overflow)(:|$)|active-memory|incognito|internal:/i;
/** Recursion guard: only named foreground sessions are ever reviewed. */
export const eligible = (turn: Turn) =>
  turn.origin === "foreground" &&
  Boolean(turn.sessionId.trim()) &&
  !EXCLUDED.test(turn.sessionId);

function memoryEntries(
  context: RequestContext,
  reviewId: string,
  ops: { target: "memory" | "user"; content: string }[],
  now: string,
): MemoryOperation[] {
  return ops.map((op, index) => {
    const target = op.target === "user" ? "profile" : "project";
    const scope =
      target === "profile"
        ? {
            owner_id: context.scope.owner_id,
            project_id: context.scope.project_id,
          }
        : context.scope;
    const entry: MemoryEntry = {
      entry_id: `review:${reviewId}:${index}`,
      scope,
      target,
      fact: op.content,
      revision: 0,
      source_event_ids: [`review:${reviewId}`],
      observed_at: now,
      verified_at: null,
      supersedes: null,
      deleted: false,
    };
    return { operation: "add", entry };
  });
}

export class ReviewRunner {
  private readonly deps: ReviewDependencies;
  private readonly now: () => number;
  private readonly idleMs: number;
  private readonly timeoutMs: number;
  private readonly logRoot: string;
  private counters = new Map<string, number>();
  private pending = new Map<string, Turn>();
  private live = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<ReviewResult> | undefined;
  private abort: AbortController | undefined;
  private stopped = false;
  private cooldown = 0;
  private backoff = 0;
  private quietUntil = 0;
  private requests = 0;

  constructor(deps: ReviewDependencies) {
    this.deps = {
      ...deps,
      context: structuredClone(deps.context),
      memory: {
        snapshot: deps.memory.snapshot.bind(deps.memory),
        submitProposal: deps.memory.submitProposal.bind(deps.memory),
      },
      skills: {
        list: deps.skills.list.bind(deps.skills),
        getRevision: deps.skills.getRevision.bind(deps.skills),
        submitProposal: deps.skills.submitProposal.bind(deps.skills),
      },
    };
    this.now = deps.clock ?? Date.now;
    this.idleMs = deps.idleMs ?? 30_000;
    this.timeoutMs = deps.timeoutMs ?? 60_000;
    if (
      !Number.isFinite(this.idleMs) ||
      this.idleMs < 0 ||
      !Number.isFinite(this.timeoutMs) ||
      this.timeoutMs <= 0
    )
      throw new Error("Invalid review timing");
    this.logRoot = resolve(deps.logRoot);
  }

  /** Number of model calls made so far (offline tests assert 0 without a fake). */
  get modelRequests() {
    return this.requests;
  }
  get pendingSessions() {
    return [...this.pending.keys()];
  }

  private async log(
    turn: Turn,
    result: ReviewResult,
    event: string,
    extra: Record<string, unknown> = {},
  ) {
    const record = {
      ts: new Date(this.now()).toISOString(),
      actor: "@mars/review",
      source: "background_review",
      sessionId: turn.sessionId,
      reviewId: result.reviewId,
      model: this.deps.model.id,
      event,
      ...extra,
    };
    await mkdir(this.logRoot, { recursive: true, mode: 0o700 });
    await withDirectoryLock(this.logRoot, () =>
      appendFile(
        join(this.logRoot, "review.jsonl"),
        `${JSON.stringify(record)}\n`,
        { mode: 0o600 },
      ),
    );
  }
  private arm() {
    clearTimeout(this.timer);
    if (this.stopped || this.running || this.live.size || !this.pending.size)
      return;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        const next = this.pending.entries().next();
        if (next.done) return;
        const [key, turn] = next.value;
        this.pending.delete(key);
        void this.reviewNow(turn).catch(() => undefined);
      },
      Math.max(0, this.quietUntil - this.now(), this.cooldown - this.now()),
    );
    this.timer.unref();
  }
  /** Foreground work is starting: defer scheduling and cancel in-flight review. */
  beginLiveTurn(sessionId: string) {
    this.live.add(sessionId);
    clearTimeout(this.timer);
    this.abort?.abort();
  }
  endLiveTurn(sessionId: string) {
    this.live.delete(sessionId);
    this.quietUntil = this.now() + this.idleMs;
    this.arm();
  }
  /** Record a completed foreground turn; review runs once 10 iterations accumulate. */
  recordTurn(turn: Turn) {
    if (this.stopped || !eligible(turn)) return;
    this.quietUntil = this.now() + this.idleMs;
    if (turn.success === false) {
      this.arm();
      return;
    }
    if (!Number.isSafeInteger(turn.iterations) || turn.iterations <= 0) return;
    const count = (this.counters.get(turn.sessionId) ?? 0) + turn.iterations;
    if (
      this.pending.has(turn.sessionId) ||
      count >= REVIEW_LIMITS.iterations_threshold
    ) {
      this.counters.delete(turn.sessionId);
      if (
        !this.pending.has(turn.sessionId) &&
        this.pending.size >= REVIEW_LIMITS.pending_sessions
      ) {
        const oldest = this.pending.keys().next();
        if (!oldest.done) this.pending.delete(oldest.value);
      }
      this.pending.set(turn.sessionId, structuredClone(turn));
    } else {
      this.counters.delete(turn.sessionId);
      this.counters.set(turn.sessionId, count);
      if (this.counters.size > REVIEW_LIMITS.counters) {
        const oldest = this.counters.keys().next();
        if (!oldest.done) this.counters.delete(oldest.value);
      }
    }
    this.arm();
  }
  async reviewNow(input: Turn): Promise<ReviewResult> {
    const turn = structuredClone(input);
    const result: ReviewResult = {
      reviewId: randomUUID(),
      status: "skipped",
      proposals: [],
    };
    if (
      this.stopped ||
      !eligible(turn) ||
      this.live.size ||
      this.running ||
      this.now() < this.cooldown
    )
      return result;
    clearTimeout(this.timer);
    this.pending.delete(turn.sessionId);
    const abort = new AbortController();
    this.abort = abort;
    const timeout = setTimeout(() => abort.abort(), this.timeoutMs);
    const action = this.execute(turn, result, abort.signal);
    this.running = action;
    try {
      return await action;
    } finally {
      clearTimeout(timeout);
      this.running = undefined;
      this.abort = undefined;
      this.arm();
    }
  }
  private async execute(
    turn: Turn,
    result: ReviewResult,
    signal: AbortSignal,
  ): Promise<ReviewResult> {
    let outputHash: string | undefined;
    const context = this.deps.context;
    try {
      await this.log(turn, result, "started", {
        transcriptHash: hash(JSON.stringify(turn.transcript)),
      });
      signal.throwIfAborted();
      if (
        !Array.isArray(turn.transcript) ||
        turn.transcript.some(
          (message) =>
            !message ||
            !["user", "assistant", "tool"].includes(message.role) ||
            typeof message.content !== "string",
        )
      )
        throw new InvalidOutput("transcript");
      const [memory, skillsRevision] = await Promise.all([
        this.deps.memory.snapshot(context),
        this.deps.skills.getRevision(),
      ]);
      const skills = await this.deps.skills.list();
      if ((await this.deps.skills.getRevision()) !== skillsRevision)
        throw new Error("Snapshot changed");
      const prompt = JSON.stringify({
        untrusted_evidence: true,
        transcript: turn.transcript,
        memory: memory.entries
          .slice(0, REVIEW_LIMITS.memory_entries)
          .map((entry) => ({ target: entry.target, fact: entry.fact })),
        skills: skills
          .filter((skill) => skill.status !== "archived")
          .slice(0, REVIEW_LIMITS.skills)
          .map((skill) => ({
            name: skill.name,
            status: skill.status,
            content: skill.content.slice(0, REVIEW_LIMITS.skill_content_chars),
          })),
        memoryRevision: memory.revision,
        skillsRevision,
      });
      if (prompt.length > REVIEW_LIMITS.context_chars)
        throw new InvalidOutput("context size");
      signal.throwIfAborted();
      this.requests++;
      const reply = await this.deps.model.complete({
        system: SYSTEM_PROMPT,
        user: prompt,
        maxTokens: REVIEW_LIMITS.max_tokens,
        timeoutMs: this.timeoutMs,
        signal,
      });
      if (
        reply.toolCalls ||
        (reply.finishReason !== null && reply.finishReason !== "stop") ||
        typeof reply.text !== "string" ||
        reply.text.length > OUTPUT_LIMITS.output_bytes
      )
        throw new InvalidOutput("reply");
      outputHash = hash(reply.text);
      const proposals = parseOutput(reply.text);
      signal.throwIfAborted();
      const source = `background_review:${turn.sessionId}:${result.reviewId}`;
      const now = new Date(this.now()).toISOString();
      for (const proposal of proposals) {
        signal.throwIfAborted();
        if (
          (await this.deps.memory.snapshot(context)).revision !==
            memory.revision ||
          (await this.deps.skills.getRevision()) !== skillsRevision
        )
          throw new Error("Snapshot changed");
        signal.throwIfAborted();
        if (proposal.tool === "memory.submitProposal") {
          const submitted = await this.deps.memory.submitProposal(
            {
              ...context,
              request_id: `${context.request_id}:${result.reviewId}`,
            },
            {
              source,
              rationale: proposal.rationale,
              expected_revision: memory.revision,
              operations: memoryEntries(
                context,
                result.reviewId,
                proposal.ops,
                now,
              ),
            },
          );
          result.proposals.push({ store: "memory", id: submitted.proposal_id });
          await this.log(turn, result, "proposal", {
            store: "memory",
            proposalId: submitted.proposal_id,
            memoryRevision: memory.revision,
            skillsRevision,
          });
        } else {
          const submitted = await this.deps.skills.submitProposal(
            { source, rationale: proposal.rationale, ops: proposal.ops },
            {
              actor: "@mars/review",
              source,
              reviewId: result.reviewId,
              expectedRevision: skillsRevision,
            },
          );
          result.proposals.push({ store: "skills", id: submitted.id });
          await this.log(turn, result, "proposal", {
            store: "skills",
            proposalId: submitted.id,
            expectedRevision: submitted.expectedRevision,
            memoryRevision: memory.revision,
            skillsRevision,
          });
        }
      }
      signal.throwIfAborted();
      this.backoff = 0;
      result.status = "completed";
    } catch (error) {
      if (signal.aborted) result.status = "cancelled";
      else if (error instanceof ReviewRateLimit) {
        result.status = "rate-limited";
        this.backoff = Math.min(
          REVIEW_LIMITS.backoff_max_ms,
          this.backoff * 2 || REVIEW_LIMITS.backoff_initial_ms,
        );
        this.cooldown = this.now() + this.backoff;
        this.pending.set(turn.sessionId, turn);
      } else
        result.status =
          error instanceof InvalidOutput ||
          error instanceof SyntaxError ||
          error instanceof MemoryStoreError ||
          error instanceof SkillError
            ? "rejected"
            : "error";
    }
    await this.log(turn, result, result.status, {
      proposals: result.proposals,
      outputHash,
      cooldownUntil: this.cooldown || undefined,
    });
    return result;
  }
  /** Clears pending work, aborts in-flight review and drains it. */
  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.pending.clear();
    this.counters.clear();
    this.abort?.abort();
    await this.running?.catch(() => undefined);
  }
}
