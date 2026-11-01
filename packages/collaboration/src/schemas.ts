import {
  ArtifactRefSchema,
  BudgetSchema,
  SCHEMA_VERSION,
  ScopeSchema,
  TaskSchema,
} from "@mars/contracts";
import { z } from "zod";

const nonempty = z.string().min(1);
const roleLabel = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z][a-z0-9-]*$/);
const safeName = z.string().min(1).max(256);
const approvalSchema = z
  .object({ read: z.boolean(), write: z.boolean(), execute: z.boolean() })
  .strict();
const usageSchema = z
  .object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    usd: z.number().finite().nonnegative(),
    steps: z.number().int().nonnegative(),
  })
  .strict();
const memberUsageSchema = usageSchema.extend({
  messages_sent: z.number().int().nonnegative(),
});
const tokenUsdSchema = z
  .object({
    tokens: z.number().int().nonnegative(),
    usd: z.number().finite().nonnegative(),
  })
  .strict();
export const DelegationPoolSchema = tokenUsdSchema;
export type DelegationPool = z.infer<typeof DelegationPoolSchema>;

export const RequestContextSchema = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    scope: ScopeSchema,
    request_id: nonempty,
  })
  .strict();

export const AgentCapabilitySchema = z
  .object({
    room_id: nonempty,
    agent_id: nonempty,
    token: nonempty,
  })
  .strict();
export type AgentCapability = z.infer<typeof AgentCapabilitySchema>;

export const CollaborationLimitsSchema = z
  .object({
    max_depth: z.number().int().nonnegative(),
    max_children_per_agent: z.number().int().positive(),
    max_total_children: z.number().int().positive(),
    max_recipients: z.number().int().positive(),
    max_body_bytes: z.number().int().positive().max(32768),
    max_instruction_bytes: z.number().int().positive(),
    max_summary_bytes: z.number().int().positive(),
    max_artifacts: z.number().int().nonnegative(),
    max_inbox_backlog: z.number().int().positive(),
    max_room_messages: z.number().int().positive(),
    max_pair_messages: z.number().int().positive(),
    max_reply_hops: z.number().int().nonnegative(),
    default_ttl_ms: z.number().int().positive(),
    max_ttl_ms: z.number().int().positive(),
    page_limit: z.number().int().positive().max(500),
    lease_ms: z.number().int().positive().max(2_147_483_647),
    max_attempts: z.number().int().positive(),
  })
  .strict();
export type CollaborationLimits = z.infer<typeof CollaborationLimitsSchema>;

export const RootAuthoritySchema = z
  .object({
    approvals: approvalSchema,
    allow_delegation: z.boolean(),
    paid_consent: z.boolean(),
  })
  .strict();
export type RootAuthority = z.infer<typeof RootAuthoritySchema>;

export const OpenRoomInputSchema = z
  .object({
    task: TaskSchema,
    idempotency_key: z.string().min(1).max(128),
    authority: RootAuthoritySchema,
    delegation_pool: z
      .object({
        max_tokens: z.number().int().nonnegative(),
        max_usd: z.number().finite().nonnegative().optional(),
      })
      .strict()
      .optional(),
    model_id: nonempty.optional(),
    limits: z
      .object({
        max_depth: z.number().int().nonnegative().optional(),
        max_children_per_agent: z.number().int().positive().optional(),
        max_total_children: z.number().int().positive().optional(),
        max_recipients: z.number().int().positive().optional(),
        max_body_bytes: z.number().int().positive().max(32768).optional(),
        max_inbox_backlog: z.number().int().positive().optional(),
        max_room_messages: z.number().int().positive().optional(),
        max_pair_messages: z.number().int().positive().optional(),
        max_reply_hops: z.number().int().nonnegative().optional(),
        default_ttl_ms: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type OpenRoomInput = z.infer<typeof OpenRoomInputSchema>;

export const RoomViewSchema = z
  .object({
    room_id: nonempty,
    scope: ScopeSchema,
    task_id: nonempty,
    task_revision: z.number().int().nonnegative(),
    budget: BudgetSchema,
    coordinator_runtime_budget: BudgetSchema,
    deadline: z.number().finite(),
    limits: CollaborationLimitsSchema,
    status: z.enum(["open", "draining", "closed"]),
    model_id: nonempty.nullable(),
    next_seq: z.number().int().positive(),
    created_at: z.number().finite(),
    counters: z.record(z.string(), z.unknown()),
  })
  .strict();
export type RoomView = z.infer<typeof RoomViewSchema>;

export const AgentAuthoritySchema = z
  .object({
    read: z.boolean(),
    write: z.boolean(),
    execute: z.boolean(),
    paid: z.boolean(),
    delegate: z.boolean(),
    may_message: z.array(nonempty),
  })
  .strict();
export type AgentAuthority = z.infer<typeof AgentAuthoritySchema>;

export const AgentBudgetSchema = z
  .object({
    max_tokens: z.number().int().positive(),
    max_usd: z.number().finite().nonnegative(),
    max_steps: z.number().int().nonnegative().nullable(),
    max_messages: z.number().int().nonnegative().nullable(),
    deadline: z.number().finite(),
  })
  .strict();
export type AgentBudget = z.infer<typeof AgentBudgetSchema>;

export const AgentViewSchema = z
  .object({
    agent_id: nonempty,
    parent_agent_id: nonempty.nullable(),
    depth: z.number().int().nonnegative(),
    role_label: roleLabel,
    status: z.enum(["active", "completed", "failed", "cancelled", "expired"]),
    task_revision: z.number().int().nonnegative(),
    authority: AgentAuthoritySchema,
    peers: z.array(nonempty),
    budget: AgentBudgetSchema,
    pool: tokenUsdSchema,
    usage: memberUsageSchema,
    reserved: tokenUsdSchema,
    workspace_mode: z.enum(["private", "read_only", "parent"]),
    write_paths: z.array(safeName),
    created_at: z.number().finite(),
  })
  .strict();
export type AgentView = z.infer<typeof AgentViewSchema>;

export const MessageInputSchema = z
  .object({
    idempotency_key: z.string().min(1).max(128),
    recipients: z.array(nonempty).min(1),
    kind: z.enum(["request", "reply", "notice"]),
    body: z.string().min(1),
    in_reply_to: nonempty.optional(),
    artifacts: z.array(ArtifactRefSchema).optional(),
    ttl_ms: z.number().int().positive().optional(),
  })
  .strict();
export type MessageInput = z.infer<typeof MessageInputSchema>;

export const MessageViewSchema = z
  .object({
    message_id: nonempty,
    seq: z.number().int().positive(),
    room_id: nonempty,
    sender_id: nonempty,
    recipients: z.array(nonempty),
    kind: z.enum(["request", "reply", "notice"]),
    body: z.string(),
    in_reply_to: nonempty.nullable(),
    artifacts: z.array(ArtifactRefSchema),
    created_at: z.number().finite(),
    expires_at: z.number().finite(),
    replayed: z.boolean(),
  })
  .strict();
export type MessageView = z.infer<typeof MessageViewSchema>;

export const DeliveredMessageSchema = z
  .object({
    message_id: nonempty,
    seq: z.number().int().positive(),
    sender: z.object({ agent_id: nonempty, role_label: roleLabel }).strict(),
    kind: z.enum(["request", "reply", "notice"]),
    body: z.string(),
    in_reply_to: nonempty.nullable(),
    artifacts: z.array(ArtifactRefSchema),
    created_at: z.number().finite(),
    expires_at: z.number().finite(),
    delivered_count: z.number().int().positive(),
    trust: z.literal("untrusted"),
    authority: z.literal("none"),
  })
  .strict();
export type DeliveredMessage = z.infer<typeof DeliveredMessageSchema>;

export const DelegateInputSchema = z
  .object({
    idempotency_key: z.string().min(1).max(128),
    role_label: roleLabel,
    instruction: z.string().min(1),
    acceptance_criteria: z.array(z.string().min(1)).max(8).optional(),
    solution_space: z.string().max(512).optional(),
    complexity: z.enum(["light", "medium", "heavy"]).optional(),
    approvals: z
      .object({
        read: z.boolean().optional(),
        write: z.boolean().optional(),
        execute: z.boolean().optional(),
      })
      .strict()
      .optional(),
    paid_models: z.boolean().optional(),
    may_delegate: z.boolean().optional(),
    budget: z
      .object({
        max_tokens: z.number().int().positive(),
        max_usd: z.number().finite().nonnegative().optional(),
        max_duration_ms: z.number().int().positive(),
        max_steps: z.number().int().positive().max(10_000),
        max_messages: z.number().int().nonnegative(),
        delegation_pool_tokens: z.number().int().nonnegative().optional(),
        delegation_pool_usd: z.number().finite().nonnegative().optional(),
      })
      .strict(),
    peers: z.array(nonempty).optional(),
    workspace: z.enum(["private", "read_only"]).optional(),
    write_paths: z.array(z.string().min(1)).max(32).optional(),
  })
  .strict();
export type DelegateInput = z.infer<typeof DelegateInputSchema>;

export const ChildViewSchema = z
  .object({
    agent_id: nonempty,
    parent_agent_id: nonempty,
    role_label: roleLabel,
    depth: z.number().int().nonnegative(),
    state: z.enum([
      "queued",
      "running",
      "completed",
      "paused",
      "failed",
      "cancelled",
      "expired",
    ]),
    budget: AgentBudgetSchema,
    usage: usageSchema,
    task_revision: z.number().int().nonnegative(),
    workspace_mode: z.enum(["private", "read_only"]),
    write_paths: z.array(safeName),
    created_at: z.number().finite(),
    result_id: nonempty.nullable(),
    replayed: z.boolean().optional(),
  })
  .strict();
export type ChildView = z.infer<typeof ChildViewSchema>;

export const ChildUsageSchema = usageSchema;
export type ChildUsage = z.infer<typeof ChildUsageSchema>;

export const ResultViewSchema = z
  .object({
    result_id: nonempty,
    child_agent_id: nonempty,
    parent_agent_id: nonempty,
    source_task_id: nonempty,
    source_task_revision: z.number().int().nonnegative(),
    base_revision: z.string().nullable(),
    status: z.enum(["proposed", "accepted", "rejected", "stale", "discarded"]),
    outcome: z.enum(["completed", "paused", "failed", "cancelled"]),
    summary: z.string(),
    summary_truncated: z.boolean(),
    unsafe_summary: z.boolean(),
    unsafe_artifacts: z.number().int().nonnegative(),
    artifacts: z.array(ArtifactRefSchema),
    usage: ChildUsageSchema,
    created_at: z.number().finite(),
    trust: z.literal("untrusted"),
  })
  .strict();
export type ResultView = z.infer<typeof ResultViewSchema>;

export const RoomStatsSchema = z
  .object({
    messages_sent: z.number().int().nonnegative(),
    deliveries: z.number().int().nonnegative(),
    redeliveries: z.number().int().nonnegative(),
    acked: z.number().int().nonnegative(),
    expired: z.number().int().nonnegative(),
    rejected_backpressure: z.number().int().nonnegative(),
    rejected_loop: z.number().int().nonnegative(),
    rejected_forbidden: z.number().int().nonnegative(),
    replayed_sends: z.number().int().nonnegative(),
    delegations: z.number().int().nonnegative(),
    replayed_delegations: z.number().int().nonnegative(),
    children_completed: z.number().int().nonnegative(),
    children_failed: z.number().int().nonnegative(),
    children_cancelled: z.number().int().nonnegative(),
    children_expired: z.number().int().nonnegative(),
    discarded_results: z.number().int().nonnegative(),
    usage_unaccounted: z.number().int().nonnegative(),
    over_budget: z.number().int().nonnegative(),
    results_accepted: z.number().int().nonnegative(),
    results_rejected: z.number().int().nonnegative(),
    results_stale: z.number().int().nonnegative(),
    tokens: z
      .object({ input: z.number().int(), output: z.number().int() })
      .strict(),
    usd: z.number().finite(),
    steps: z.number().int(),
    reserved: z
      .object({
        tokens: z.number().int().nonnegative(),
        usd: z.number().finite().nonnegative(),
      })
      .strict(),
  })
  .strict();
export type RoomStats = z.infer<typeof RoomStatsSchema>;

export const ListInputSchema = z
  .object({
    cursor: z.string().optional(),
    limit: z.number().int().positive().optional(),
  })
  .strict();

export const ReviewResultInputSchema = z
  .object({
    decision: z.enum(["accept", "reject"]),
    expected_task_revision: z.number().int().nonnegative(),
    current_base_revision: z.string().nullable().optional(),
  })
  .strict();

export const TaskInputSchema = TaskSchema;
