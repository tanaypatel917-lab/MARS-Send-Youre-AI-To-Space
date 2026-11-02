import { z } from "zod";

export const SCHEMA_VERSION = 1;
const id = z.string().min(1);
const revision = z.string().min(1);
const timestamp = z.string().datetime({ offset: true });

export const ScopeSchema = z
  .object({
    owner_id: id,
    project_id: id,
    workspace_id: id.optional(),
  })
  .strict();
export type Scope = z.infer<typeof ScopeSchema>;

export const ArtifactRefSchema = z
  .object({
    artifact_id: id,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    media_type: id,
    byte_length: z.number().int().nonnegative(),
  })
  .strict();
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

export const VersionRefSchema = z.object({ component: id, revision }).strict();
export type VersionRef = z.infer<typeof VersionRefSchema>;

export const BudgetSchema = z
  .object({
    max_tokens: z.number().int().positive(),
    max_usd: z.number().finite().nonnegative(),
    max_duration_ms: z.number().int().positive(),
    max_depth: z.number().int().nonnegative(),
    max_concurrency: z.number().int().positive(),
  })
  .strict();
export type Budget = z.infer<typeof BudgetSchema>;

export const EventEnvelopeSchema = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    event_id: id,
    scope: ScopeSchema,
    session_id: id,
    task_id: id,
    occurred_at: timestamp,
    event_type: z.enum([
      "task.created",
      "task.updated",
      "execution.observed",
      "tool.completed",
      "research.proposed",
      "research.stale",
      "memory.revised",
      "skill.revised",
      "evaluation.completed",
      "training.updated",
      "promotion.decided",
    ]),
    parent_event_id: id.nullable(),
    run_id: id,
    producer: id,
    versions: z.array(VersionRefSchema).min(1),
    payload: ArtifactRefSchema,
    source_event_ids: z.array(id),
    access: z.enum(["private", "project"]),
    usage: z
      .object({
        input_tokens: z.number().int().nonnegative(),
        output_tokens: z.number().int().nonnegative(),
        cost_usd: z.number().finite().nonnegative().nullable(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

export const TaskStatusSchema = z.enum([
  "pending",
  "running",
  "paused",
  "completed",
  "cancelled",
  "failed",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskSchema = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    task_id: id,
    session_id: id,
    scope: ScopeSchema,
    revision: z.number().int().nonnegative(),
    request: id,
    acceptance_criteria: z.array(id).min(1),
    budget: BudgetSchema,
    status: TaskStatusSchema,
    specialist_revision: revision.nullable(),
    artifacts: z.array(ArtifactRefSchema),
  })
  .strict();
export type Task = z.infer<typeof TaskSchema>;

const transitions: Record<TaskStatus, readonly TaskStatus[]> = {
  pending: ["running", "cancelled"],
  running: ["paused", "completed", "cancelled", "failed"],
  paused: ["running", "cancelled", "failed"],
  completed: [],
  cancelled: [],
  failed: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return transitions[from].includes(to);
}

export interface RequestContext {
  schema_version: 1;
  scope: Scope;
  request_id: string;
}

export interface TaskService {
  create(context: RequestContext, task: Task): Promise<Task>;
  inspect(context: RequestContext, taskId: string): Promise<Task>;
  resume(
    context: RequestContext,
    taskId: string,
    expectedRevision: number,
  ): Promise<Task>;
  steer(
    context: RequestContext,
    taskId: string,
    instruction: string,
  ): Promise<void>;
  cancel(context: RequestContext, taskId: string): Promise<void>;
  events(
    context: RequestContext,
    taskId: string,
    afterEventId?: string,
  ): AsyncIterable<EventEnvelope>;
}

export interface WorkspaceRef {
  workspace_id: string;
  provider: string;
  revision: string;
}
export interface CheckpointRef {
  checkpoint_id: string;
  workspace: WorkspaceRef;
  artifact: ArtifactRef;
}
export interface ExecutionResult {
  exit_code: number;
  stdout: ArtifactRef;
  stderr: ArtifactRef;
  started_at: string;
  finished_at: string;
}
export interface ExecutionProvider {
  prepare(context: RequestContext, taskId: string): Promise<WorkspaceRef>;
  read(
    context: RequestContext,
    workspace: WorkspaceRef,
    relativePath: string,
  ): Promise<ArtifactRef>;
  write(
    context: RequestContext,
    workspace: WorkspaceRef,
    relativePath: string,
    artifact: ArtifactRef,
  ): Promise<void>;
  execute(
    context: RequestContext,
    workspace: WorkspaceRef,
    argv: readonly string[],
    budget: Budget,
  ): Promise<ExecutionResult>;
  checkpoint(
    context: RequestContext,
    workspace: WorkspaceRef,
  ): Promise<CheckpointRef>;
  restore(
    context: RequestContext,
    checkpoint: CheckpointRef,
    expectedRevision: string,
  ): Promise<WorkspaceRef>;
  collect(
    context: RequestContext,
    workspace: WorkspaceRef,
  ): Promise<ArtifactRef[]>;
  stop(context: RequestContext, workspace: WorkspaceRef): Promise<void>;
}

export interface ResearchRequest {
  question: string;
  task_id: string;
  task_revision: number;
  known_context: ArtifactRef[];
  source_requirements: string[];
  deadline: string;
  budget: Budget;
}
export interface ResearchFinding {
  finding_id: string;
  request_id: string;
  task_revision: number;
  claim: string;
  sources: { url: string; retrieved_at: string; evidence: ArtifactRef }[];
  recommendation: string;
  confidence: "low" | "medium" | "high";
  remaining_uncertainty: string[];
  status: "proposed" | "used" | "stale";
}
export interface ResearchService {
  submit(context: RequestContext, request: ResearchRequest): Promise<string>;
  findings(
    context: RequestContext,
    requestId: string,
  ): AsyncIterable<ResearchFinding>;
  cancel(context: RequestContext, requestId: string): Promise<void>;
  markStale(context: RequestContext, requestId: string): Promise<void>;
}

export interface MemoryEntry {
  entry_id: string;
  scope: Scope;
  target: "profile" | "project";
  fact: string;
  revision: number;
  source_event_ids: string[];
  observed_at: string;
  verified_at: string | null;
  supersedes: string | null;
  deleted: boolean;
}
export type MemoryOperation =
  | { operation: "add"; entry: MemoryEntry }
  | {
      operation: "patch";
      entry_id: string;
      fact: string;
      source_event_ids: string[];
    }
  | { operation: "remove"; entry_id: string };
export interface MemoryService {
  snapshot(
    context: RequestContext,
  ): Promise<{ revision: number; entries: MemoryEntry[] }>;
  batch(
    context: RequestContext,
    expectedRevision: number,
    operations: MemoryOperation[],
  ): Promise<number>;
  search(context: RequestContext, query: string): Promise<MemoryEntry[]>;
  provenance(context: RequestContext, entryId: string): Promise<MemoryEntry[]>;
  export(context: RequestContext): Promise<ArtifactRef>;
  delete(
    context: RequestContext,
  ): Promise<{ affected_training_manifests: string[] }>;
}

export type MemoryProposalStatus = "pending" | "accepted" | "rejected";
/** A proposed memory batch awaiting a human/host decision; only the memory owner applies it. */
export interface MemoryProposal {
  proposal_id: string;
  scope: Scope;
  source: string;
  operations: MemoryOperation[];
  rationale: string;
  expected_revision: number;
  status: MemoryProposalStatus;
  reason?: string;
  submitted_at: string;
  resolved_at?: string;
  applied_revision?: number;
}
export interface MemoryProposalInput {
  source: string;
  operations: MemoryOperation[];
  rationale: string;
  expected_revision: number;
}
/** Proposal-only surface handed to background review; it can never write authoritative memory. */
export interface MemoryProposalService {
  submitProposal(
    context: RequestContext,
    proposal: MemoryProposalInput,
  ): Promise<MemoryProposal>;
  listProposals(
    context: RequestContext,
    status?: MemoryProposalStatus,
  ): Promise<MemoryProposal[]>;
  acceptProposal(
    context: RequestContext,
    proposalId: string,
  ): Promise<MemoryProposal>;
  rejectProposal(
    context: RequestContext,
    proposalId: string,
    reason: string,
  ): Promise<MemoryProposal>;
}

export interface SkillRevision {
  skill_id: string;
  revision: string;
  parent_revision: string | null;
  instructions: ArtifactRef;
  prerequisites: string[];
  source_event_ids: string[];
  evaluation_ids: string[];
  status: "draft" | "accepted" | "rejected" | "archived";
}
export interface SkillService {
  discover(context: RequestContext, query: string): Promise<SkillRevision[]>;
  read(
    context: RequestContext,
    skillId: string,
    revision: string,
  ): Promise<SkillRevision>;
  propose(
    context: RequestContext,
    candidate: SkillRevision,
  ): Promise<SkillRevision>;
  evaluate(
    context: RequestContext,
    skillId: string,
    revision: string,
  ): Promise<string>;
  accept(
    context: RequestContext,
    skillId: string,
    revision: string,
    expectedRevision: string | null,
  ): Promise<void>;
  archive(
    context: RequestContext,
    skillId: string,
    expectedRevision: string,
  ): Promise<void>;
  restore(
    context: RequestContext,
    skillId: string,
    revision: string,
    expectedRevision: string,
  ): Promise<void>;
}

export interface JobRef {
  job_id: string;
  input_manifest: ArtifactRef;
}
export interface JobResult {
  job: JobRef;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  artifacts: ArtifactRef[];
  cost_usd: number | null;
}
export interface EvaluationService {
  submitComparison(
    context: RequestContext,
    immutableManifest: ArtifactRef,
    budget: Budget,
  ): Promise<JobRef>;
  inspect(context: RequestContext, jobId: string): Promise<JobResult>;
  cancel(context: RequestContext, jobId: string): Promise<void>;
}
export interface OptimizationService {
  registerTarget(context: RequestContext, target: ArtifactRef): Promise<string>;
  propose(
    context: RequestContext,
    targetId: string,
    manifest: ArtifactRef,
    budget: Budget,
  ): Promise<JobRef>;
  evaluate(context: RequestContext, candidate: ArtifactRef): Promise<JobRef>;
  publish(context: RequestContext, jobId: string): Promise<ArtifactRef>;
}
export interface DatasetService {
  select(
    context: RequestContext,
    sourceEventIds: string[],
  ): Promise<ArtifactRef>;
  review(
    context: RequestContext,
    dataset: ArtifactRef,
    decisions: ArtifactRef,
  ): Promise<ArtifactRef>;
  deduplicate(
    context: RequestContext,
    dataset: ArtifactRef,
  ): Promise<ArtifactRef>;
  split(
    context: RequestContext,
    dataset: ArtifactRef,
    policy: ArtifactRef,
  ): Promise<ArtifactRef>;
  export(context: RequestContext, dataset: ArtifactRef): Promise<ArtifactRef>;
  lineage(context: RequestContext, dataset: ArtifactRef): Promise<ArtifactRef>;
}
export interface TrainingService {
  validate(
    context: RequestContext,
    manifest: ArtifactRef,
  ): Promise<{ ready: boolean; missing: string[] }>;
  estimate(
    context: RequestContext,
    manifest: ArtifactRef,
  ): Promise<{ estimated_usd: number | null; hardware: string[] }>;
  submit(
    context: RequestContext,
    manifest: ArtifactRef,
    budget: Budget,
  ): Promise<JobRef>;
  inspect(context: RequestContext, jobId: string): Promise<JobResult>;
  cancel(context: RequestContext, jobId: string): Promise<void>;
}
export interface SpecialistManifest {
  specialist_id: string;
  revision: string;
  scope: Scope;
  tested_task_coverage: string[];
  base_model: VersionRef;
  tokenizer: VersionRef;
  chat_template: ArtifactRef;
  adapter: ArtifactRef | null;
  tools: VersionRef[];
  skills: VersionRef[];
  knowledge: VersionRef[];
  evaluation: ArtifactRef;
  dataset_lineage: ArtifactRef | null;
  fallback_specialist_revision: string;
}
export interface ModelRegistry {
  register(
    context: RequestContext,
    manifest: SpecialistManifest,
  ): Promise<void>;
  verifyCompatibility(
    context: RequestContext,
    specialistId: string,
    servingBase: VersionRef,
  ): Promise<{ compatible: boolean; reasons: string[] }>;
  evaluate(context: RequestContext, specialistId: string): Promise<JobRef>;
  deploy(
    context: RequestContext,
    specialistId: string,
    expectedProductionRevision: string,
  ): Promise<void>;
  select(
    context: RequestContext,
    task: Task,
  ): Promise<{ manifest: SpecialistManifest; reason: string }>;
  retire(context: RequestContext, specialistId: string): Promise<void>;
  rollback(
    context: RequestContext,
    specialistId: string,
    expectedProductionRevision: string,
  ): Promise<void>;
}

export * from "./models";
