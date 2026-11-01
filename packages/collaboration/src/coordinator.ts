import {
  type ArtifactRef,
  ArtifactRefSchema,
  type Budget,
  type RequestContext,
  type Scope,
  type Task,
  TaskSchema,
} from "@mars/contracts";
import { assertPublishable, renderUntrustedMessage } from "./content";
import { CollaborationError } from "./errors";
import {
  type AgentAuthority,
  type AgentBudget,
  type AgentCapability,
  AgentCapabilitySchema,
  type AgentView,
  AgentViewSchema,
  type ChildUsage,
  type ChildView,
  ChildViewSchema,
  type CollaborationLimits,
  CollaborationLimitsSchema,
  DelegateInputSchema,
  type DelegationPool,
  DelegationPoolSchema,
  type DeliveredMessage,
  DeliveredMessageSchema,
  ListInputSchema,
  MessageInputSchema,
  type MessageView,
  MessageViewSchema,
  type OpenRoomInput,
  OpenRoomInputSchema,
  type ResultView,
  ResultViewSchema,
  ReviewResultInputSchema,
  type RoomStats,
  RoomStatsSchema,
  type RoomView,
  RoomViewSchema,
} from "./schemas";
import {
  CollaborationStore,
  type CollaborationStoreOptions,
  canonicalJson,
  EMPTY_STATS,
  isTerminalStatus,
  type MemberRow,
  parseContext,
  parseJson,
  type RoomRow,
  sha256,
} from "./store";

const zeroUsage: ChildUsage = {
  input_tokens: 0,
  output_tokens: 0,
  usd: 0,
  steps: 0,
};
const zeroMemberUsage: MemberUsage = {
  ...zeroUsage,
  messages_sent: 0,
};
const zeroReserved = { tokens: 0, usd: 0 };

function invalidInput(message: string): never {
  throw new CollaborationError("invalid_input", message);
}

function parseWith<T>(schema: { parse(value: unknown): T }, value: unknown): T {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof CollaborationError) throw error;
    throw new CollaborationError(
      "invalid_input",
      "Input does not match schema",
    );
  }
}

function decodeJson<T>(value: string): T {
  return parseJson<T>(value);
}

function json(value: unknown): string {
  return canonicalJson(value);
}

function scopeOf(room: RoomRow): Scope {
  return decodeJson<Scope>(room.scope_json);
}

function roomView(store: CollaborationStore, room: RoomRow): RoomView {
  const budget = decodeJson<Budget>(room.budget_json);
  const pool = decodeJson<DelegationPool>(
    store.getMemberRow(room.root_agent_id).pool_json,
  );
  return RoomViewSchema.parse({
    room_id: room.room_id,
    scope: scopeOf(room),
    task_id: room.task_id,
    task_revision: room.task_revision,
    budget,
    coordinator_runtime_budget: {
      ...budget,
      max_tokens: budget.max_tokens - pool.tokens,
      max_usd: budget.max_usd - pool.usd,
    },
    deadline: room.deadline,
    limits: decodeJson<CollaborationLimits>(room.limits_json),
    status: room.status,
    model_id: room.model_id,
    next_seq: room.next_seq,
    created_at: room.created_at,
    counters: decodeJson<RoomStats>(room.counters_json),
  });
}

function memberView(member: MemberRow): AgentView {
  return AgentViewSchema.parse({
    agent_id: member.agent_id,
    parent_agent_id: member.parent_agent_id,
    depth: member.depth,
    role_label: member.role_label,
    status: member.status,
    task_revision: member.task_revision,
    authority: decodeJson<AgentAuthority>(member.authority_json),
    peers: decodeJson<string[]>(member.peers_json),
    budget: decodeJson<AgentBudget>(member.budget_json),
    pool: decodeJson<DelegationPool>(member.pool_json),
    usage: decodeJson<ChildUsage>(member.usage_json),
    reserved: decodeJson<{ tokens: number; usd: number }>(member.reserved_json),
    workspace_mode: member.workspace_mode,
    write_paths: decodeJson<string[]>(member.write_paths_json),
    created_at: member.created_at,
  });
}

function updateStats(
  store: CollaborationStore,
  roomId: string,
  mutate: (stats: RoomStats) => void,
): void {
  const room = store.getRoomRow(roomId);
  const stats = decodeJson<RoomStats>(room.counters_json);
  mutate(stats);
  RoomStatsSchema.parse(stats);
  store.db
    .query("UPDATE rooms SET counters_json = ? WHERE room_id = ?")
    .run(JSON.stringify(stats), roomId);
}

function contextForRoom(context: RequestContext, room: RoomRow): void {
  if (!equalContextScope(context.scope, scopeOf(room)))
    throw new CollaborationError(
      "forbidden",
      "Request scope is not authorized",
    );
}

function equalContextScope(left: Scope, right: Scope): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function capabilityFor(roomId: string, agentId: string, token: string) {
  return AgentCapabilitySchema.parse({
    room_id: roomId,
    agent_id: agentId,
    token,
  });
}

function liveStatus(status: string): void {
  if (status === "cancelled")
    throw new CollaborationError(
      "cancelled",
      "Collaboration member was cancelled",
    );
  if (status !== "active")
    throw new CollaborationError(
      "closed",
      "Collaboration member is no longer active",
    );
}

function assertRoomMutation(room: RoomRow): void {
  if (room.status !== "open")
    throw new CollaborationError("closed", "Collaboration room is not open");
}

function pageLimit(room: RoomRow, requested: number | undefined): number {
  const limits = decodeJson<CollaborationLimits>(room.limits_json);
  const limit = requested ?? limits.page_limit;
  if (limit > limits.page_limit)
    throw new CollaborationError(
      "invalid_input",
      "Page limit exceeds room cap",
    );
  return limit;
}

function encodeCursor(
  roomId: string,
  agentId: string,
  sequence: number,
): string {
  return Buffer.from(
    JSON.stringify({ r: roomId, a: agentId, s: sequence }),
  ).toString("base64url");
}

function decodeCursor(
  cursor: string | undefined,
  roomId: string,
  agentId: string,
): number {
  if (!cursor) return 0;
  try {
    const decoded = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as { r?: unknown; a?: unknown; s?: unknown };
    if (
      decoded.r !== roomId ||
      decoded.a !== agentId ||
      typeof decoded.s !== "number" ||
      !Number.isSafeInteger(decoded.s) ||
      decoded.s < 0
    )
      throw new Error("invalid cursor");
    return decoded.s;
  } catch {
    throw new CollaborationError("unknown_cursor", "Cursor is not valid here");
  }
}

export interface CollaborationOptions extends CollaborationStoreOptions {
  rootDir: string;
}

export interface Collaboration {
  host: CollaborationHost;
  agents: AgentPort;
  close(): Promise<void>;
}

export interface CollaborationHost {
  openRoom(
    context: RequestContext,
    input: OpenRoomInput,
  ): Promise<{ room: RoomView; coordinator: AgentCapability }>;
  issueCapability(
    context: RequestContext,
    roomId: string,
    agentId: string,
  ): Promise<AgentCapability>;
  reviseTask(
    context: RequestContext,
    roomId: string,
    task: Task,
  ): Promise<{ room: RoomView; coordinator: AgentCapability }>;
  closeRoom(
    context: RequestContext,
    roomId: string,
    mode: "drain" | "cancel",
  ): Promise<RoomView>;
  inspectRoom(context: RequestContext, roomId: string): Promise<RoomView>;
  stats(context: RequestContext, roomId: string): Promise<RoomStats>;
  jobs: CollaborationJobs;
}

export interface AgentPort {
  send(
    context: RequestContext,
    capability: AgentCapability,
    input: unknown,
  ): Promise<MessageView>;
  inbox(
    context: RequestContext,
    capability: AgentCapability,
    input?: unknown,
  ): Promise<{ messages: DeliveredMessage[]; next_cursor: string | null }>;
  ack(
    context: RequestContext,
    capability: AgentCapability,
    messageIds: string[],
  ): Promise<{ acknowledged: number }>;
  members(
    context: RequestContext,
    capability: AgentCapability,
    input?: unknown,
  ): Promise<{ members: AgentView[]; next_cursor: string | null }>;
  delegate(
    context: RequestContext,
    capability: AgentCapability,
    input: unknown,
  ): Promise<ChildView & { capability: AgentCapability | null }>;
  cancelChild(
    context: RequestContext,
    capability: AgentCapability,
    childId: string,
  ): Promise<void>;
  children(
    context: RequestContext,
    capability: AgentCapability,
    input?: unknown,
  ): Promise<{ children: ChildView[]; next_cursor: string | null }>;
  results(
    context: RequestContext,
    capability: AgentCapability,
    input?: unknown,
  ): Promise<{ results: ResultView[]; next_cursor: string | null }>;
  reviewResult(
    context: RequestContext,
    capability: AgentCapability,
    resultId: string,
    input: unknown,
  ): Promise<ResultView>;
}

export interface CollaborationJobs {
  readonly leaseMs: number;
  currentTime(): number;
  claim(runnerId: string): Promise<ClaimedJob | null>;
  requestCancel(jobId: string, runnerId: string, epoch: number): Promise<void>;
  setModelSelection(
    jobId: string,
    runnerId: string,
    epoch: number,
    modelId: string | null,
    reason: string,
  ): Promise<void>;
  heartbeat(
    jobId: string,
    runnerId: string,
    epoch: number,
    progress: JobProgress,
  ): Promise<{ stop: boolean }>;
  finalize(
    jobId: string,
    runnerId: string,
    epoch: number,
    outcome: JobOutcome,
  ): Promise<void>;
  recoverExpired(): Promise<ExpiredJob[]>;
  recoverJob(
    jobId: string,
    usage: ChildUsage | null,
  ): Promise<"requeued" | "failed" | "unchanged">;
  getLaunchContext(jobId: string): Promise<LaunchContext>;
  expireUnstarted(now?: number): Promise<number>;
}

export interface ClaimedJob {
  job_id: string;
  room_id: string;
  agent_id: string;
  parent_agent_id: string;
  lease_epoch: number;
  attempt: number;
}

export interface JobProgress {
  steps: number;
  usage: ChildUsage | null;
  session_ref?: string;
  base_revision?: string | null;
}

export interface JobOutcome {
  status: "completed" | "paused" | "failed" | "cancelled";
  summary: string;
  artifacts: ArtifactRef[];
  usage: ChildUsage | null;
  errorCode?: "usage_unaccounted" | "budget_exceeded";
}

export interface ExpiredJob {
  job_id: string;
  room_id: string;
  agent_id: string;
  attempt: number;
  session_ref: string | null;
  cancel_requested: boolean;
  deadline: number;
}

export interface LaunchContext {
  now: number;
  room: RoomView;
  task_id: string;
  task_revision: number;
  member: AgentView;
  instruction: string;
  acceptance_criteria: string[];
  solution_space: string | null;
  complexity: "light" | "medium" | "heavy" | null;
  paid_models: boolean;
  parent_model_id: string | null;
  session_ref: string | null;
  attempt: number;
  job_id: string;
  model_id: string | null;
  model_reason: string | null;
  charged_usage: ChildUsage;
}

function auth(
  store: CollaborationStore,
  contextValue: RequestContext,
  capabilityValue: AgentCapability,
  mutation: boolean,
): { context: RequestContext; member: MemberRow; room: RoomRow } {
  let context: RequestContext;
  let capability: AgentCapability;
  try {
    context = parseContext(contextValue);
    capability = AgentCapabilitySchema.parse(capabilityValue);
  } catch {
    throw new CollaborationError(
      "invalid_input",
      "Invalid request context or capability",
    );
  }
  const member = store.getMemberByToken(capability.token);
  if (!member) {
    const stale = store.db
      .query<{ room_id: string; agent_id: string }, [string]>(
        "SELECT room_id, agent_id FROM stale_capabilities WHERE token_hash = ?",
      )
      .get(sha256(capability.token));
    if (
      stale &&
      stale.agent_id === capability.agent_id &&
      stale.room_id === capability.room_id
    ) {
      const staleRoom = store.getRoomRow(stale.room_id);
      if (!equalContextScope(context.scope, scopeOf(staleRoom)))
        throw new CollaborationError(
          "forbidden",
          "Request scope is not authorized",
        );
      throw new CollaborationError(
        "stale_revision",
        "Capability has a stale task revision",
      );
    }
  }
  if (
    !member ||
    !store.tokenMatches(capability.token, member.token_hash) ||
    member.agent_id !== capability.agent_id ||
    member.room_id !== capability.room_id
  )
    throw new CollaborationError("forbidden", "Capability is not authorized");
  const room = store.getRoomRow(member.room_id);
  if (!equalContextScope(context.scope, scopeOf(room)))
    throw new CollaborationError(
      "forbidden",
      "Request scope is not authorized",
    );
  if (member.task_revision !== room.task_revision)
    throw new CollaborationError(
      "stale_revision",
      "Capability has a stale task revision",
    );
  liveStatus(member.status);
  if (room.status === "closed")
    throw new CollaborationError("closed", "Collaboration room is closed");
  if (mutation) assertRoomMutation(room);
  return { context, member, room };
}

function upsertMemberToken(
  store: CollaborationStore,
  member: MemberRow,
): AgentCapability {
  const token = store.randomToken();
  store.db
    .query("UPDATE members SET token_hash = ? WHERE agent_id = ?")
    .run(sha256(token), member.agent_id);
  return capabilityFor(member.room_id, member.agent_id, token);
}

function roomByContext(
  store: CollaborationStore,
  context: RequestContext,
  roomId: string,
): RoomRow {
  const room = store.getRoomRow(roomId);
  contextForRoom(context, room);
  return room;
}

function resultViewFromRow(row: ResultRow): ResultView {
  return ResultViewSchema.parse({
    result_id: row.result_id,
    child_agent_id: row.child_agent_id,
    parent_agent_id: row.parent_agent_id,
    source_task_id: row.source_task_id,
    source_task_revision: row.source_task_revision,
    base_revision: row.base_revision,
    status: row.status,
    outcome: row.outcome,
    summary: row.summary,
    summary_truncated: Boolean(row.summary_truncated),
    unsafe_summary: Boolean(row.unsafe_summary),
    artifacts: decodeJson<ArtifactRef[]>(row.artifacts_json),
    usage: decodeJson<ChildUsage>(row.usage_json),
    created_at: row.created_at,
    trust: "untrusted",
  });
}

interface ResultRow {
  result_id: string;
  room_id: string;
  child_agent_id: string;
  parent_agent_id: string;
  source_task_id: string;
  source_task_revision: number;
  base_revision: string | null;
  status: "proposed" | "accepted" | "rejected" | "stale" | "discarded";
  outcome: "completed" | "paused" | "failed" | "cancelled";
  summary: string;
  summary_truncated: number;
  unsafe_summary: number;
  artifacts_json: string;
  usage_json: string;
  created_at: number;
}

interface JobRow {
  job_id: string;
  room_id: string;
  agent_id: string;
  state: string;
  attempt: number;
  lease_owner: string | null;
  lease_epoch: number;
  lease_expires_at: number | null;
  cancel_requested: number;
  session_ref: string | null;
  base_revision: string | null;
  charged_usage_json: string;
  created_seq: number;
  model_id: string | null;
  model_reason: string | null;
}

function applyStoreLimits(
  store: CollaborationStore,
  requested: OpenRoomInput["limits"],
): CollaborationLimits {
  const effective = { ...store.limits };
  for (const [key, value] of Object.entries(requested ?? {})) {
    const name = key as keyof CollaborationLimits;
    if (value !== undefined && value > effective[name])
      throw new CollaborationError(
        "invalid_input",
        "Room limit exceeds host cap",
      );
    if (value !== undefined) effective[name] = value as never;
  }
  return CollaborationLimitsSchema.parse(effective);
}

function expireMemberDeliveries(
  store: CollaborationStore,
  agentId: string,
): void {
  const result = store.db
    .query(
      "UPDATE deliveries SET state = 'expired' WHERE recipient_id = ? AND state IN ('pending', 'delivered')",
    )
    .run(agentId);
  if (result.changes > 0) {
    const room = store.db
      .query<{ room_id: string }, [string]>(
        "SELECT room_id FROM members WHERE agent_id = ?",
      )
      .get(agentId);
    if (room)
      updateStats(store, room.room_id, (stats) => {
        stats.expired += result.changes;
      });
  }
}

function releaseClaims(store: CollaborationStore, agentId: string): void {
  store.db.query("DELETE FROM write_claims WHERE agent_id = ?").run(agentId);
}

function releaseReservation(
  store: CollaborationStore,
  member: MemberRow,
): void {
  if (!member.parent_agent_id) return;
  const budget = agentBudget(member);
  const reserved = { tokens: budget.max_tokens, usd: budget.max_usd };
  const parent = store.getMemberRow(member.parent_agent_id);
  const parentReserved = decodeJson<{ tokens: number; usd: number }>(
    parent.reserved_json,
  );
  const next = {
    tokens: Math.max(0, parentReserved.tokens - reserved.tokens),
    usd: Math.max(0, parentReserved.usd - reserved.usd),
  };
  store.db
    .query("UPDATE members SET reserved_json = ? WHERE agent_id = ?")
    .run(JSON.stringify(next), parent.agent_id);
  if (parent.parent_agent_id === null)
    updateStats(store, member.room_id, (stats) => {
      stats.reserved.tokens = Math.max(
        0,
        stats.reserved.tokens - reserved.tokens,
      );
      stats.reserved.usd = Math.max(0, stats.reserved.usd - reserved.usd);
    });
  store.db
    .query("UPDATE members SET reserved_json = ? WHERE agent_id = ?")
    .run(JSON.stringify(zeroReserved), member.agent_id);
}

function cancelSubtree(
  store: CollaborationStore,
  roomId: string,
  agentId: string,
): void {
  const descendants = store.db
    .query<MemberRow, [string, string]>(
      "SELECT * FROM members WHERE room_id = ? AND parent_agent_id = ?",
    )
    .all(roomId, agentId);
  for (const child of descendants) cancelSubtree(store, roomId, child.agent_id);
  const member = store.getMemberRow(agentId);
  if (member.status !== "active") return;
  const job = store.db
    .query<JobRow, [string]>("SELECT * FROM jobs WHERE agent_id = ?")
    .get(agentId);
  if (job?.state === "running") {
    store.db
      .query("UPDATE jobs SET cancel_requested = 1 WHERE job_id = ?")
      .run(job.job_id);
  } else if (job && job.state === "queued") {
    store.db
      .query("UPDATE jobs SET state = 'cancelled' WHERE job_id = ?")
      .run(job.job_id);
    releaseReservation(store, member);
  }
  store.db
    .query("UPDATE members SET status = 'cancelled' WHERE agent_id = ?")
    .run(agentId);
  releaseClaims(store, agentId);
  expireMemberDeliveries(store, agentId);
}

function activeJobs(store: CollaborationStore, roomId: string): number {
  const row = store.db
    .query<{ amount: number }, [string]>(
      "SELECT COUNT(*) AS amount FROM jobs WHERE room_id = ? AND state IN ('queued', 'running')",
    )
    .get(roomId);
  return row?.amount ?? 0;
}

function createHost(store: CollaborationStore): CollaborationHost {
  const jobs = createJobsApi(store);
  return {
    jobs,
    async openRoom(contextValue, inputValue) {
      const context = parseContext(contextValue);
      const input = parseWith(OpenRoomInputSchema, inputValue);
      const task = parseWith(TaskSchema, input.task);
      if (!equalContextScope(context.scope, task.scope))
        throw new CollaborationError(
          "forbidden",
          "Task scope is not authorized",
        );
      const delegationPool = DelegationPoolSchema.parse({
        tokens: input.delegation_pool?.max_tokens ?? 0,
        usd: input.delegation_pool?.max_usd ?? 0,
      });
      if (
        delegationPool.tokens > task.budget.max_tokens - 1 ||
        delegationPool.usd > task.budget.max_usd
      )
        invalidInput("Delegation pool exceeds the task budget");
      if (delegationPool.usd > 0 && !input.authority.paid_consent)
        throw new CollaborationError(
          "forbidden",
          "Paid delegation pool requires paid consent",
        );
      assertPublishable(task.request, store.hostPrivateRoots, store.rootDir);
      const limits = applyStoreLimits(store, input.limits);
      const effectiveDepth = Math.min(
        task.budget.max_depth,
        limits.max_depth,
        store.limits.max_depth,
      );
      const created = store.now();
      const deadline = created + task.budget.max_duration_ms;
      const digest = sha256(
        json({
          task,
          authority: input.authority,
          delegation_pool: delegationPool,
          model_id: input.model_id ?? null,
          limits,
        }),
      );
      return store.transaction(() => {
        const sameKey = store.db
          .query<RoomRow, [string, string, string]>(
            "SELECT * FROM rooms WHERE scope_json = ? AND task_id = ? AND open_key = ?",
          )
          .get(json(task.scope), task.task_id, input.idempotency_key);
        if (sameKey) {
          if (sameKey.open_digest !== digest)
            throw new CollaborationError(
              "conflict",
              "Room idempotency key was reused",
            );
          const coordinator = upsertMemberToken(
            store,
            store.getMemberRow(sameKey.root_agent_id),
          );
          return {
            room: roomView(store, store.getRoomRow(sameKey.room_id)),
            coordinator,
          };
        }
        const existing = store.db
          .query<{ room_id: string }, [string, string]>(
            "SELECT room_id FROM rooms WHERE scope_json = ? AND task_id = ? AND status IN ('open', 'draining')",
          )
          .get(json(task.scope), task.task_id);
        if (existing)
          throw new CollaborationError(
            "conflict",
            "An active room already exists for this task",
          );
        const roomId = store.randomId();
        const agentId = store.randomId();
        const token = store.randomToken();
        const authority: AgentAuthority = {
          read: input.authority.approvals.read,
          write: input.authority.approvals.write,
          execute: input.authority.approvals.execute,
          paid: input.authority.paid_consent && task.budget.max_usd > 0,
          delegate:
            input.authority.allow_delegation &&
            delegationPool.tokens > 0 &&
            effectiveDepth > 0 &&
            task.budget.max_concurrency > 1,
          may_message: [],
        };
        const rootBudget: AgentBudget = {
          max_tokens: task.budget.max_tokens,
          max_usd: task.budget.max_usd,
          max_steps: null,
          max_messages: null,
          deadline,
        };
        store.db
          .query(
            `INSERT INTO rooms
             (room_id, scope_json, task_id, task_revision, budget_json, deadline, limits_json, status,
              model_id, next_seq, created_at, open_key, open_digest, root_agent_id, counters_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, 1, ?, ?, ?, ?, ?)`,
          )
          .run(
            roomId,
            json(task.scope),
            task.task_id,
            task.revision,
            json(task.budget),
            deadline,
            json(limits),
            input.model_id ?? null,
            created,
            input.idempotency_key,
            digest,
            agentId,
            json(EMPTY_STATS),
          );
        store.db
          .query(
            `INSERT INTO members
             (agent_id, room_id, parent_agent_id, depth, role_label, status, task_revision, token_hash,
             authority_json, peers_json, budget_json, usage_json, reserved_json, pool_json,
              instruction_digest,
          instruction_text, workspace_mode, write_paths_json, created_at, max_steps, max_messages, acceptance_json,
          solution_space, complexity, paid_models)
             VALUES (?, ?, NULL, 0, 'coordinator', 'active', ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, 'parent', '[]', ?, NULL, NULL, '[]', NULL, NULL, 0)`,
          )
          .run(
            agentId,
            roomId,
            task.revision,
            sha256(token),
            json(authority),
            json(rootBudget),
            json(zeroMemberUsage),
            json(zeroReserved),
            json(delegationPool),
            sha256(task.request.trim()),
            task.request,
            created,
          );
        return {
          room: roomView(store, store.getRoomRow(roomId)),
          coordinator: capabilityFor(roomId, agentId, token),
        };
      });
    },
    async issueCapability(contextValue, roomId, agentId) {
      const context = parseContext(contextValue);
      const room = roomByContext(store, context, roomId);
      const member = store.getMemberRow(agentId);
      if (member.room_id !== room.room_id)
        throw new CollaborationError(
          "forbidden",
          "Capability is not authorized",
        );
      liveStatus(member.status);
      return store.transaction(() => upsertMemberToken(store, member));
    },
    async reviseTask(contextValue, roomId, taskValue) {
      const context = parseContext(contextValue);
      const task = parseWith(TaskSchema, taskValue);
      const room = roomByContext(store, context, roomId);
      if (room.status === "closed")
        throw new CollaborationError("closed", "Collaboration room is closed");
      if (
        task.task_id !== room.task_id ||
        !equalContextScope(task.scope, scopeOf(room))
      )
        throw new CollaborationError(
          "forbidden",
          "Task identity is not authorized",
        );
      if (task.revision <= room.task_revision)
        throw new CollaborationError(
          "stale_revision",
          "Task revision must advance",
        );
      assertPublishable(task.request, store.hostPrivateRoots, store.rootDir);
      return store.transaction(() => {
        const children = store.db
          .query<MemberRow, [string]>(
            "SELECT * FROM members WHERE room_id = ? AND parent_agent_id IS NOT NULL",
          )
          .all(roomId);
        for (const child of children)
          cancelSubtree(store, roomId, child.agent_id);
        const staleResults = store.db
          .query<{ result_id: string }, [string]>(
            "UPDATE results SET status = 'stale' WHERE room_id = ? AND status = 'proposed' RETURNING result_id",
          )
          .all(roomId).length;
        if (staleResults > 0)
          updateStats(store, roomId, (stats) => {
            stats.results_stale += staleResults;
          });
        store.db
          .query(
            "UPDATE deliveries SET state = 'expired' WHERE message_id IN (SELECT message_id FROM messages WHERE room_id = ?) AND state IN ('pending', 'delivered')",
          )
          .run(roomId);
        const deadline = store.now() + task.budget.max_duration_ms;
        store.db
          .query(
            "UPDATE rooms SET task_revision = ?, budget_json = ?, deadline = ? WHERE room_id = ?",
          )
          .run(task.revision, json(task.budget), deadline, roomId);
        const root = store.getMemberRow(room.root_agent_id);
        const pool = decodeJson<DelegationPool>(root.pool_json);
        if (
          pool.tokens > task.budget.max_tokens - 1 ||
          pool.usd > task.budget.max_usd
        )
          invalidInput(
            "Delegation pool no longer fits the revised task budget",
          );
        const budget: AgentBudget = {
          max_tokens: task.budget.max_tokens,
          max_usd: task.budget.max_usd,
          max_steps: null,
          max_messages: null,
          deadline,
        };
        store.db
          .query(
            "UPDATE members SET task_revision = ?, budget_json = ?, instruction_digest = ? WHERE agent_id = ?",
          )
          .run(
            task.revision,
            json(budget),
            sha256(task.request.trim()),
            root.agent_id,
          );
        store.db
          .query(
            "INSERT OR IGNORE INTO stale_capabilities(token_hash, room_id, agent_id) VALUES (?, ?, ?)",
          )
          .run(root.token_hash, room.room_id, root.agent_id);
        const coordinator = upsertMemberToken(
          store,
          store.getMemberRow(root.agent_id),
        );
        return {
          room: roomView(store, store.getRoomRow(roomId)),
          coordinator,
        };
      });
    },
    async closeRoom(contextValue, roomId, mode) {
      const context = parseContext(contextValue);
      roomByContext(store, context, roomId);
      if (mode !== "drain" && mode !== "cancel")
        invalidInput("Invalid room close mode");
      return store.transaction(() => {
        if (store.getRoomRow(roomId).status === "closed")
          throw new CollaborationError(
            "closed",
            "Collaboration room is already closed",
          );
        if (mode === "cancel") {
          const roots = store.db
            .query<MemberRow, [string]>(
              "SELECT * FROM members WHERE room_id = ? AND parent_agent_id IS NULL",
            )
            .all(roomId);
          for (const member of roots) {
            const children = store.db
              .query<MemberRow, [string, string]>(
                "SELECT * FROM members WHERE room_id = ? AND parent_agent_id = ?",
              )
              .all(roomId, member.agent_id);
            for (const child of children)
              cancelSubtree(store, roomId, child.agent_id);
          }
        }
        const status = activeJobs(store, roomId) === 0 ? "closed" : "draining";
        store.db
          .query("UPDATE rooms SET status = ? WHERE room_id = ?")
          .run(status, roomId);
        return roomView(store, store.getRoomRow(roomId));
      });
    },
    async inspectRoom(contextValue, roomId) {
      const context = parseContext(contextValue);
      return roomView(store, roomByContext(store, context, roomId));
    },
    async stats(contextValue, roomId) {
      const context = parseContext(contextValue);
      const room = roomByContext(store, context, roomId);
      return RoomStatsSchema.parse(decodeJson<RoomStats>(room.counters_json));
    },
  };
}

function createAgentPort(store: CollaborationStore): AgentPort {
  return {
    async send(contextValue, capabilityValue, inputValue) {
      const { member, room } = auth(store, contextValue, capabilityValue, true);
      const input = parseWith(MessageInputSchema, inputValue);
      const limits = decodeJson<CollaborationLimits>(room.limits_json);
      const recipients = [...input.recipients];
      if (
        recipients.length > limits.max_recipients ||
        new Set(recipients).size !== recipients.length ||
        recipients.includes(member.agent_id)
      )
        invalidInput("Invalid message recipients");
      if (!input.body.trim()) invalidInput("Message body must not be blank");
      if (Buffer.byteLength(input.body, "utf8") > limits.max_body_bytes)
        invalidInput("Message body exceeds its byte limit");
      const artifacts = input.artifacts ?? [];
      if (artifacts.length > limits.max_artifacts)
        invalidInput("Too many message artifacts");
      for (const artifact of artifacts) {
        ArtifactRefSchema.parse(artifact);
        assertPublishable(
          json(artifact),
          store.hostPrivateRoots,
          store.rootDir,
        );
      }
      assertPublishable(input.body, store.hostPrivateRoots, store.rootDir);
      if (input.kind === "reply" && !input.in_reply_to)
        invalidInput("Replies require in_reply_to");
      const ttl = input.ttl_ms ?? limits.default_ttl_ms;
      if (ttl < 1 || ttl > limits.max_ttl_ms)
        invalidInput("Message TTL exceeds its allowed range");
      const digest = sha256(
        json({
          recipients: [...recipients].sort(),
          kind: input.kind,
          body: input.body,
          in_reply_to: input.in_reply_to ?? null,
          artifacts,
          ttl_ms: ttl,
        }),
      );
      return store.transaction(() => {
        const previous = store.db
          .query<MessageRow, [string, string, string]>(
            "SELECT * FROM messages WHERE room_id = ? AND sender_id = ? AND idempotency_key = ?",
          )
          .get(room.room_id, member.agent_id, input.idempotency_key);
        if (previous) {
          if (previous.digest !== digest)
            throw new CollaborationError(
              "conflict",
              "Message idempotency key was reused",
            );
          updateStats(store, room.room_id, (stats) => {
            stats.replayed_sends += 1;
          });
          return messageView(store, previous, true);
        }
        const now = store.now();
        const expiresAt = Math.min(
          now + ttl,
          room.deadline,
          agentBudget(member).deadline,
        );
        if (expiresAt <= now)
          throw new CollaborationError("expired", "Message has expired");
        const targets = recipients.map((id) => {
          const target = store.db
            .query<MemberRow, [string, string]>(
              "SELECT * FROM members WHERE room_id = ? AND agent_id = ?",
            )
            .get(room.room_id, id);
          if (!target || target.status !== "active")
            throw new CollaborationError(
              "forbidden",
              "Recipient is not authorized",
            );
          if (!canAddress(store, member, target, input.kind, input.in_reply_to))
            throw new CollaborationError(
              "forbidden",
              "Recipient is not authorized",
            );
          return target;
        });
        const hop = input.in_reply_to
          ? replyHop(store, room.room_id, input.in_reply_to) + 1
          : 0;
        if (hop > limits.max_reply_hops) {
          updateStats(store, room.room_id, (stats) => {
            stats.rejected_loop += 1;
          });
          throw new CollaborationError(
            "loop_limit",
            "Reply chain exceeds room limit",
          );
        }
        const total =
          store.db
            .query<{ amount: number }, [string]>(
              "SELECT COUNT(*) AS amount FROM messages WHERE room_id = ?",
            )
            .get(room.room_id)?.amount ?? 0;
        if (total >= limits.max_room_messages)
          throw new CollaborationError(
            "limit_exceeded",
            "Room message limit reached",
          );
        const maxMessages = agentBudget(member).max_messages;
        const sentCount =
          store.db
            .query<{ amount: number }, [string]>(
              "SELECT COUNT(*) AS amount FROM messages WHERE sender_id = ?",
            )
            .get(member.agent_id)?.amount ?? 0;
        if (maxMessages !== null && sentCount >= maxMessages)
          throw new CollaborationError(
            "budget_exceeded",
            "Message budget reached",
          );
        for (const target of targets) {
          const pairCount =
            store.db
              .query<{ amount: number }, [string, string, string]>(
                "SELECT COUNT(*) AS amount FROM messages m JOIN deliveries d ON d.message_id = m.message_id WHERE m.room_id = ? AND m.sender_id = ? AND d.recipient_id = ?",
              )
              .get(room.room_id, member.agent_id, target.agent_id)?.amount ?? 0;
          if (pairCount >= limits.max_pair_messages) {
            updateStats(store, room.room_id, (stats) => {
              stats.rejected_loop += 1;
            });
            throw new CollaborationError(
              "loop_limit",
              "Message pair limit reached",
            );
          }
          const backlog =
            store.db
              .query<{ amount: number }, [string, number]>(
                `SELECT COUNT(*) AS amount FROM deliveries d
               JOIN messages m ON m.message_id = d.message_id
               WHERE d.recipient_id = ? AND d.state IN ('pending', 'delivered') AND m.expires_at > ?`,
              )
              .get(target.agent_id, now)?.amount ?? 0;
          if (backlog >= limits.max_inbox_backlog) {
            updateStats(store, room.room_id, (stats) => {
              stats.rejected_backpressure += 1;
            });
            throw new CollaborationError(
              "backpressure",
              "Recipient inbox is full",
            );
          }
        }
        const seq = room.next_seq;
        const messageId = store.randomId();
        const message: MessageRow = {
          message_id: messageId,
          room_id: room.room_id,
          seq,
          sender_id: member.agent_id,
          kind: input.kind,
          body: input.body,
          in_reply_to: input.in_reply_to ?? null,
          artifacts_json: json(artifacts),
          created_at: now,
          expires_at: expiresAt,
          hop,
          idempotency_key: input.idempotency_key,
          digest,
        };
        store.db
          .query(
            `INSERT INTO messages
             (message_id, room_id, seq, sender_id, kind, body, in_reply_to, artifacts_json,
              created_at, expires_at, hop, idempotency_key, digest)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            messageId,
            room.room_id,
            seq,
            member.agent_id,
            input.kind,
            input.body,
            input.in_reply_to ?? null,
            json(artifacts),
            now,
            expiresAt,
            hop,
            input.idempotency_key,
            digest,
          );
        for (const target of targets) {
          store.db
            .query(
              "INSERT INTO deliveries(message_id, recipient_id, state, delivered_count) VALUES (?, ?, 'pending', 0)",
            )
            .run(messageId, target.agent_id);
        }
        store.db
          .query("UPDATE rooms SET next_seq = next_seq + 1 WHERE room_id = ?")
          .run(room.room_id);
        const usage = decodeJson<MemberUsage>(member.usage_json);
        usage.messages_sent += 1;
        store.db
          .query("UPDATE members SET usage_json = ? WHERE agent_id = ?")
          .run(json(usage), member.agent_id);
        updateStats(store, room.room_id, (stats) => {
          stats.messages_sent += 1;
          stats.deliveries += targets.length;
        });
        return messageView(store, message, false);
      });
    },
    async inbox(contextValue, capabilityValue, inputValue = {}) {
      const { member, room } = auth(
        store,
        contextValue,
        capabilityValue,
        false,
      );
      const input = parseWith(ListInputSchema, inputValue);
      const limit = pageLimit(room, input.limit);
      const cursor = decodeCursor(input.cursor, room.room_id, member.agent_id);
      return store.transaction(() => {
        const now = store.now();
        const expired = store.db
          .query<{ changes: number }, [string, number]>(
            `UPDATE deliveries SET state = 'expired' WHERE recipient_id = ? AND state IN ('pending', 'delivered')
             AND message_id IN (SELECT message_id FROM messages WHERE expires_at <= ?) RETURNING 1 AS changes`,
          )
          .all(member.agent_id, now).length;
        if (expired > 0)
          updateStats(store, room.room_id, (stats) => {
            stats.expired += expired;
          });
        const rows = store.db
          .query<InboxRow, [string, number, number, string, number]>(
            `SELECT m.*, d.delivered_count, d.state, sender.role_label
             FROM deliveries d JOIN messages m ON m.message_id = d.message_id
             JOIN members sender ON sender.agent_id = m.sender_id
             WHERE d.recipient_id = ? AND d.state IN ('pending', 'delivered') AND m.seq > ?
               AND m.expires_at > ? AND m.room_id = ?
             ORDER BY m.seq LIMIT ?`,
          )
          .all(member.agent_id, cursor, now, room.room_id, limit);
        const messages = rows.map((row) => {
          const nextCount = row.delivered_count + 1;
          store.db
            .query(
              "UPDATE deliveries SET state = 'delivered', delivered_count = ?, first_delivered_at = COALESCE(first_delivered_at, ?) WHERE message_id = ? AND recipient_id = ?",
            )
            .run(nextCount, now, row.message_id, member.agent_id);
          if (row.delivered_count > 0)
            updateStats(store, room.room_id, (stats) => {
              stats.redeliveries += 1;
            });
          return DeliveredMessageSchema.parse({
            message_id: row.message_id,
            seq: row.seq,
            sender: { agent_id: row.sender_id, role_label: row.role_label },
            kind: row.kind,
            body: row.body,
            in_reply_to: row.in_reply_to,
            artifacts: decodeJson<ArtifactRef[]>(row.artifacts_json),
            created_at: row.created_at,
            expires_at: row.expires_at,
            delivered_count: nextCount,
            trust: "untrusted",
            authority: "none",
          });
        });
        const next = rows.length === limit ? rows.at(-1)?.seq : undefined;
        return {
          messages,
          next_cursor:
            next === undefined
              ? null
              : encodeCursor(room.room_id, member.agent_id, next),
        };
      });
    },
    async ack(contextValue, capabilityValue, messageIds) {
      const { member, room } = auth(
        store,
        contextValue,
        capabilityValue,
        false,
      );
      if (
        !Array.isArray(messageIds) ||
        messageIds.some((id) => typeof id !== "string")
      )
        invalidInput("Message ids must be strings");
      return store.transaction(() => {
        let acknowledged = 0;
        for (const messageId of new Set(messageIds)) {
          const result = store.db
            .query(
              `UPDATE deliveries SET state = 'acked', acked_at = ?
               WHERE message_id = ? AND recipient_id = ? AND state = 'delivered'`,
            )
            .run(store.now(), messageId, member.agent_id);
          acknowledged += result.changes;
        }
        if (acknowledged > 0)
          updateStats(store, room.room_id, (stats) => {
            stats.acked += acknowledged;
          });
        return { acknowledged };
      });
    },
    async members(contextValue, capabilityValue, inputValue = {}) {
      const { member, room } = auth(
        store,
        contextValue,
        capabilityValue,
        false,
      );
      const input = parseWith(ListInputSchema, inputValue);
      const limit = pageLimit(room, input.limit);
      const cursor = decodeCursor(input.cursor, room.room_id, member.agent_id);
      const rows = store.db
        .query<MemberRow, [string, string, number, number]>(
          "SELECT * FROM members WHERE room_id = ? AND agent_id != ? AND rowid > ? ORDER BY rowid LIMIT ?",
        )
        .all(room.room_id, member.agent_id, cursor, limit);
      const next =
        rows.length === limit
          ? store.db
              .query<{ rowid: number }, [string]>(
                "SELECT rowid FROM members WHERE agent_id = ?",
              )
              .get(rows.at(-1)?.agent_id ?? "")?.rowid
          : undefined;
      return {
        members: rows.map(memberView),
        next_cursor:
          next === undefined
            ? null
            : encodeCursor(room.room_id, member.agent_id, next),
      };
    },
    async delegate(contextValue, capabilityValue, inputValue) {
      return delegateChild(store, contextValue, capabilityValue, inputValue);
    },
    async cancelChild(contextValue, capabilityValue, childId) {
      const { member, room } = auth(store, contextValue, capabilityValue, true);
      if (typeof childId !== "string" || !childId)
        invalidInput("Child id is required");
      return store.transaction(() => {
        const child = store.db
          .query<MemberRow, [string, string]>(
            "SELECT * FROM members WHERE room_id = ? AND agent_id = ?",
          )
          .get(room.room_id, childId);
        if (!child)
          throw new CollaborationError("forbidden", "Child is not authorized");
        if (!isAncestor(store, member.agent_id, child.agent_id, room.room_id))
          throw new CollaborationError("forbidden", "Child is not authorized");
        cancelSubtree(store, room.room_id, child.agent_id);
      });
    },
    async children(contextValue, capabilityValue, inputValue = {}) {
      const { member, room } = auth(
        store,
        contextValue,
        capabilityValue,
        false,
      );
      const input = parseWith(ListInputSchema, inputValue);
      const limit = pageLimit(room, input.limit);
      const cursor = decodeCursor(input.cursor, room.room_id, member.agent_id);
      const rows = store.db
        .query<MemberRow, [string, string, number, number]>(
          `SELECT * FROM members WHERE room_id = ? AND parent_agent_id = ?
           AND rowid > ? ORDER BY rowid LIMIT ?`,
        )
        .all(room.room_id, member.agent_id, cursor, limit);
      const children = rows.map((child) => childView(store, child));
      const next =
        rows.length === limit
          ? store.db
              .query<{ rowid: number }, [string]>(
                "SELECT rowid FROM members WHERE agent_id = ?",
              )
              .get(rows.at(-1)?.agent_id ?? "")?.rowid
          : undefined;
      return {
        children,
        next_cursor:
          next === undefined
            ? null
            : encodeCursor(room.room_id, member.agent_id, next),
      };
    },
    async results(contextValue, capabilityValue, inputValue = {}) {
      const { member, room } = auth(
        store,
        contextValue,
        capabilityValue,
        false,
      );
      const input = parseWith(ListInputSchema, inputValue);
      const limit = pageLimit(room, input.limit);
      const cursor = decodeCursor(input.cursor, room.room_id, member.agent_id);
      const rows = store.db
        .query<ResultRow, [string, string, number, number]>(
          `SELECT * FROM results WHERE room_id = ? AND parent_agent_id = ?
           AND rowid > ? ORDER BY rowid LIMIT ?`,
        )
        .all(room.room_id, member.agent_id, cursor, limit);
      const next =
        rows.length === limit
          ? store.db
              .query<{ rowid: number }, [string]>(
                "SELECT rowid FROM results WHERE result_id = ?",
              )
              .get(rows.at(-1)?.result_id ?? "")?.rowid
          : undefined;
      return {
        results: rows.map(resultViewFromRow),
        next_cursor:
          next === undefined
            ? null
            : encodeCursor(room.room_id, member.agent_id, next),
      };
    },
    async reviewResult(contextValue, capabilityValue, resultId, inputValue) {
      const { member, room } = auth(
        store,
        contextValue,
        capabilityValue,
        false,
      );
      const input = parseWith(ReviewResultInputSchema, inputValue);
      return store.transaction(() => {
        const result = store.db
          .query<ResultRow, [string, string]>(
            "SELECT * FROM results WHERE room_id = ? AND result_id = ?",
          )
          .get(room.room_id, resultId);
        if (!result || result.parent_agent_id !== member.agent_id)
          throw new CollaborationError("forbidden", "Result is not authorized");
        if (result.status === "stale")
          throw new CollaborationError("stale_revision", "Result is stale");
        if (result.status !== "proposed")
          throw new CollaborationError(
            "conflict",
            "Result is no longer proposed",
          );
        if (input.decision === "accept") {
          const current = store.getRoomRow(room.room_id);
          if (
            input.expected_task_revision !== current.task_revision ||
            result.source_task_revision !== current.task_revision
          ) {
            if (result.source_task_revision !== current.task_revision) {
              store.db
                .query(
                  "UPDATE results SET status = 'stale' WHERE result_id = ?",
                )
                .run(result.result_id);
              updateStats(store, room.room_id, (stats) => {
                stats.results_stale += 1;
              });
            }
            throw new CollaborationError(
              "stale_revision",
              "Task revision changed",
            );
          }
          if (
            result.base_revision !== null &&
            input.current_base_revision !== result.base_revision
          )
            throw new CollaborationError(
              "stale_base",
              "Workspace base revision changed",
            );
          store.db
            .query("UPDATE results SET status = 'accepted' WHERE result_id = ?")
            .run(result.result_id);
          updateStats(store, room.room_id, (stats) => {
            stats.results_accepted += 1;
          });
        } else {
          store.db
            .query("UPDATE results SET status = 'rejected' WHERE result_id = ?")
            .run(result.result_id);
          updateStats(store, room.room_id, (stats) => {
            stats.results_rejected += 1;
          });
        }
        const updated = store.db
          .query<ResultRow, [string]>(
            "SELECT * FROM results WHERE result_id = ?",
          )
          .get(result.result_id);
        if (!updated)
          throw new CollaborationError(
            "corrupt_record",
            "Result record is missing",
          );
        return resultViewFromRow(updated);
      });
    },
  };
}

interface MessageRow {
  message_id: string;
  room_id: string;
  seq: number;
  sender_id: string;
  kind: "request" | "reply" | "notice";
  body: string;
  in_reply_to: string | null;
  artifacts_json: string;
  created_at: number;
  expires_at: number;
  hop: number;
  idempotency_key: string;
  digest: string;
}

interface InboxRow extends MessageRow {
  delivered_count: number;
  state: string;
  role_label: string;
}

type MemberUsage = ChildUsage & { messages_sent: number };

function agentBudget(member: MemberRow): AgentBudget {
  return decodeJson<AgentBudget>(member.budget_json);
}

function runtimeCap(member: MemberRow): { tokens: number; usd: number } {
  const budget = agentBudget(member);
  const pool = decodeJson<DelegationPool>(member.pool_json);
  return {
    tokens: budget.max_tokens - pool.tokens,
    usd: budget.max_usd - pool.usd,
  };
}

function messageView(
  store: CollaborationStore,
  message: MessageRow,
  replayed: boolean,
): MessageView {
  const recipients = store.db
    .query<{ recipient_id: string }, [string]>(
      "SELECT recipient_id FROM deliveries WHERE message_id = ? ORDER BY recipient_id",
    )
    .all(message.message_id)
    .map((delivery) => delivery.recipient_id);
  return MessageViewSchema.parse({
    message_id: message.message_id,
    seq: message.seq,
    room_id: message.room_id,
    sender_id: message.sender_id,
    recipients,
    kind: message.kind,
    body: message.body,
    in_reply_to: message.in_reply_to,
    artifacts: decodeJson<ArtifactRef[]>(message.artifacts_json),
    created_at: message.created_at,
    expires_at: message.expires_at,
    replayed,
  });
}

function replyHop(
  store: CollaborationStore,
  roomId: string,
  messageId: string,
): number {
  const message = store.db
    .query<{ hop: number }, [string, string]>(
      "SELECT hop FROM messages WHERE room_id = ? AND message_id = ?",
    )
    .get(roomId, messageId);
  if (!message)
    throw new CollaborationError("forbidden", "Reply target is not authorized");
  return message.hop;
}

function canAddress(
  store: CollaborationStore,
  sender: MemberRow,
  recipient: MemberRow,
  kind: string,
  inReplyTo: string | undefined,
): boolean {
  if (
    recipient.parent_agent_id === sender.agent_id ||
    sender.parent_agent_id === recipient.agent_id
  )
    return true;
  const peers = decodeJson<string[]>(sender.peers_json);
  if (peers.includes(recipient.agent_id)) return true;
  if (kind === "reply" && inReplyTo) {
    const original = store.db
      .query<{ sender_id: string }, [string, string]>(
        "SELECT sender_id FROM messages WHERE room_id = ? AND message_id = ?",
      )
      .get(sender.room_id, inReplyTo);
    return (
      original?.sender_id === recipient.agent_id &&
      Boolean(
        store.db
          .query<{ message_id: string }, [string, string]>(
            "SELECT message_id FROM deliveries WHERE message_id = ? AND recipient_id = ?",
          )
          .get(inReplyTo, sender.agent_id),
      )
    );
  }
  return false;
}

function isAncestor(
  store: CollaborationStore,
  ancestorId: string,
  memberId: string,
  roomId: string,
): boolean {
  let current: MemberRow | null = store.getMemberRow(memberId);
  const seen = new Set<string>();
  while (current?.parent_agent_id) {
    if (seen.has(current.agent_id)) return false;
    seen.add(current.agent_id);
    if (current.parent_agent_id === ancestorId) return true;
    current =
      store.db
        .query<MemberRow, [string, string]>(
          "SELECT * FROM members WHERE room_id = ? AND agent_id = ?",
        )
        .get(roomId, current.parent_agent_id) ?? null;
  }
  return false;
}

function childView(store: CollaborationStore, child: MemberRow): ChildView {
  const job = store.db
    .query<JobRow, [string]>("SELECT * FROM jobs WHERE agent_id = ?")
    .get(child.agent_id);
  const result = store.db
    .query<{ result_id: string }, [string]>(
      "SELECT result_id FROM results WHERE child_agent_id = ? ORDER BY created_at DESC LIMIT 1",
    )
    .get(child.agent_id);
  const state =
    job?.state === "queued" || job?.state === "running"
      ? job.state
      : child.status === "active"
        ? "queued"
        : child.status;
  const usage = decodeJson<MemberUsage>(child.usage_json);
  return ChildViewSchema.parse({
    agent_id: child.agent_id,
    parent_agent_id: child.parent_agent_id,
    role_label: child.role_label,
    depth: child.depth,
    state,
    budget: agentBudget(child),
    usage: {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      usd: usage.usd,
      steps: usage.steps,
    },
    task_revision: child.task_revision,
    workspace_mode: child.workspace_mode,
    write_paths: decodeJson<string[]>(child.write_paths_json),
    created_at: child.created_at,
    result_id: result?.result_id ?? null,
  });
}

function validWritePaths(
  value: string[] | undefined,
  writes: boolean,
): string[] {
  const paths = value ?? [];
  for (const path of paths) {
    if (
      path.startsWith("/") ||
      path.includes("\\") ||
      path.includes("\0") ||
      path
        .split("/")
        .some((part) => part === "" || part === "." || part === "..")
    )
      invalidInput("Write paths must be normalized relative POSIX paths");
  }
  if (writes && paths.length === 0)
    invalidInput("Write permission requires explicit write paths");
  if (!writes && paths.length > 0)
    invalidInput("Write paths require write permission");
  if (new Set(paths).size !== paths.length)
    invalidInput("Write paths must be unique");
  return paths;
}

function pathsOverlap(left: string, right: string): boolean {
  return (
    left === right ||
    left.startsWith(`${right}/`) ||
    right.startsWith(`${left}/`)
  );
}

function delegateChild(
  store: CollaborationStore,
  contextValue: RequestContext,
  capabilityValue: AgentCapability,
  inputValue: unknown,
): ChildView & { capability: AgentCapability | null } {
  return store.transaction(() => {
    const { member, room } = auth(store, contextValue, capabilityValue, true);
    const input = parseWith(DelegateInputSchema, inputValue);
    const instruction = input.instruction.trim();
    const acceptance = input.acceptance_criteria ?? [];
    const requestedApprovals = {
      read: input.approvals?.read ?? true,
      write: input.approvals?.write ?? false,
      execute: input.approvals?.execute ?? false,
    };
    const paidModels = input.paid_models ?? false;
    const mayDelegate = input.may_delegate ?? false;
    const delegationPool = {
      tokens: input.budget.delegation_pool_tokens ?? 0,
      usd: input.budget.delegation_pool_usd ?? 0,
    };
    const workspaceMode =
      input.workspace ?? (requestedApprovals.write ? "private" : "read_only");
    const writePaths = input.write_paths ?? [];
    const canonicalInstructionDigest = sha256(instruction);
    const digest = sha256(
      json({
        role_label: input.role_label,
        instruction,
        acceptance_criteria: acceptance,
        solution_space: input.solution_space ?? null,
        complexity: input.complexity ?? null,
        approvals: requestedApprovals,
        paid_models: paidModels,
        may_delegate: mayDelegate,
        budget: {
          max_tokens: input.budget.max_tokens,
          max_usd: input.budget.max_usd ?? 0,
          max_duration_ms: input.budget.max_duration_ms,
          max_steps: input.budget.max_steps,
          max_messages: input.budget.max_messages,
          delegation_pool: delegationPool,
        },
        peers: [...(input.peers ?? [])].sort(),
        workspace: workspaceMode,
        write_paths: writePaths,
      }),
    );
    const old = store.db
      .query<{ digest: string; child_id: string }, [string, string, string]>(
        "SELECT digest, child_id FROM delegations WHERE room_id = ? AND parent_id = ? AND idempotency_key = ?",
      )
      .get(room.room_id, member.agent_id, input.idempotency_key);
    if (old) {
      if (old.digest !== digest)
        throw new CollaborationError(
          "conflict",
          "Delegation idempotency key was reused",
        );
      const child = store.getMemberRow(old.child_id);
      updateStats(store, room.room_id, (stats) => {
        stats.replayed_delegations += 1;
      });
      return { ...childView(store, child), replayed: true, capability: null };
    }
    const parentAuthority = decodeJson<AgentAuthority>(member.authority_json);
    if (!parentAuthority.delegate)
      throw new CollaborationError(
        member.parent_agent_id === null ? "single_agent" : "forbidden",
        "Delegation is not authorized",
      );
    const parentBudget = agentBudget(member);
    const limits = decodeJson<CollaborationLimits>(room.limits_json);
    const depth = member.depth + 1;
    const effectiveMaxDepth = Math.min(
      decodeJson<CollaborationLimits>(room.limits_json).max_depth,
      decodeJson<Budget>(room.budget_json).max_depth,
    );
    if (depth > effectiveMaxDepth)
      throw new CollaborationError(
        "limit_exceeded",
        "Delegation depth limit reached",
      );
    if (mayDelegate && depth + 1 > effectiveMaxDepth)
      throw new CollaborationError(
        "limit_exceeded",
        "Delegation depth limit reached",
      );
    const childCount =
      store.db
        .query<{ amount: number }, [string, string]>(
          "SELECT COUNT(*) AS amount FROM members WHERE room_id = ? AND parent_agent_id = ?",
        )
        .get(room.room_id, member.agent_id)?.amount ?? 0;
    const roomChildCount =
      store.db
        .query<{ amount: number }, [string]>(
          "SELECT COUNT(*) AS amount FROM members WHERE room_id = ? AND parent_agent_id IS NOT NULL",
        )
        .get(room.room_id)?.amount ?? 0;
    if (
      childCount >= limits.max_children_per_agent ||
      roomChildCount >= limits.max_total_children
    )
      throw new CollaborationError("limit_exceeded", "Child limit reached");
    const ancestors: MemberRow[] = [member];
    let ancestorId = member.parent_agent_id;
    while (ancestorId) {
      const ancestor = store.db
        .query<MemberRow, [string, string]>(
          "SELECT * FROM members WHERE room_id = ? AND agent_id = ?",
        )
        .get(room.room_id, ancestorId);
      if (!ancestor) break;
      ancestors.push(ancestor);
      ancestorId = ancestor.parent_agent_id;
    }
    if (
      ancestors.some(
        (ancestor) =>
          ancestor.instruction_digest === canonicalInstructionDigest,
      )
    )
      throw new CollaborationError(
        "recursive_delegation",
        "Instruction repeats an ancestor task",
      );
    if (!instruction) invalidInput("Delegation instruction must not be blank");
    if (Buffer.byteLength(instruction, "utf8") > limits.max_instruction_bytes)
      invalidInput("Delegation instruction exceeds its byte limit");
    assertPublishable(instruction, store.hostPrivateRoots, store.rootDir);
    for (const criteria of acceptance) {
      if (Buffer.byteLength(criteria, "utf8") > 512 || !criteria.trim())
        invalidInput("Acceptance criteria exceed their limit");
      assertPublishable(criteria, store.hostPrivateRoots, store.rootDir);
    }
    if (
      input.solution_space !== undefined &&
      Buffer.byteLength(input.solution_space, "utf8") > 512
    )
      invalidInput("Solution space exceeds its byte limit");
    if (input.solution_space)
      assertPublishable(
        input.solution_space,
        store.hostPrivateRoots,
        store.rootDir,
      );
    if (
      (requestedApprovals.read && !parentAuthority.read) ||
      (requestedApprovals.write && !parentAuthority.write) ||
      (requestedApprovals.execute && !parentAuthority.execute) ||
      (paidModels && !parentAuthority.paid) ||
      (mayDelegate && !parentAuthority.delegate)
    )
      throw new CollaborationError(
        "forbidden",
        "Requested authority exceeds parent authority",
      );
    if ((delegationPool.tokens > 0 || delegationPool.usd > 0) && !mayDelegate)
      throw new CollaborationError(
        "forbidden",
        "Delegation pool requires delegation authority",
      );
    if (
      delegationPool.tokens > input.budget.max_tokens - 1 ||
      delegationPool.usd > (input.budget.max_usd ?? 0)
    )
      invalidInput("Child delegation pool exceeds its budget envelope");
    if (requestedApprovals.write && workspaceMode === "read_only")
      invalidInput("A read-only workspace cannot receive write permission");
    if (input.budget.max_usd && !paidModels)
      throw new CollaborationError(
        "forbidden",
        "Paid budget requires paid-model authority",
      );
    if (input.peers && input.peers.length > limits.max_recipients)
      invalidInput("Too many peers");
    const validatedWritePaths = validWritePaths(
      writePaths,
      requestedApprovals.write,
    );
    const peers = [...new Set(input.peers ?? [])];
    const resolvedPeers: string[] = [];
    for (const peerId of peers) {
      const peer = store.db
        .query<MemberRow, [string, string]>(
          "SELECT * FROM members WHERE room_id = ? AND agent_id = ?",
        )
        .get(room.room_id, peerId);
      if (!peer || peer.status !== "active")
        throw new CollaborationError("forbidden", "Peer is not authorized");
      if (
        peer.agent_id !== member.agent_id &&
        !isAncestor(store, member.agent_id, peer.agent_id, room.room_id)
      )
        throw new CollaborationError("forbidden", "Peer is not authorized");
      resolvedPeers.push(peer.agent_id);
    }
    const claimedPaths = store.db
      .query<{ path: string; agent_id: string }, [string]>(
        "SELECT path, agent_id FROM write_claims WHERE room_id = ?",
      )
      .all(room.room_id);
    if (
      validatedWritePaths.some((requested) =>
        claimedPaths.some(
          (claim) =>
            claim.agent_id !== member.agent_id &&
            pathsOverlap(requested, claim.path) &&
            !isTerminalStatus(store.getMemberRow(claim.agent_id).status),
        ),
      )
    )
      throw new CollaborationError(
        "write_conflict",
        "Write path is already claimed",
      );
    const parentUsage = decodeJson<MemberUsage>(member.usage_json);
    const parentPool = decodeJson<DelegationPool>(member.pool_json);
    const parentReserved = decodeJson<{ tokens: number; usd: number }>(
      member.reserved_json,
    );
    const ownCharged = ownRuntimeCharged(store, member);
    const requestedUsd = input.budget.max_usd ?? 0;
    const subtreeTokens = Math.max(
      0,
      tokensUsed(parentUsage) - tokensUsed(ownCharged),
    );
    const subtreeUsd = Math.max(0, parentUsage.usd - ownCharged.usd);
    if (
      input.budget.max_tokens >
        parentPool.tokens - parentReserved.tokens - subtreeTokens ||
      requestedUsd > parentPool.usd - parentReserved.usd - subtreeUsd
    )
      throw new CollaborationError(
        "budget_exceeded",
        "Child budget exceeds available budget",
      );
    if (
      parentBudget.max_messages !== null &&
      parentUsage.messages_sent >= parentBudget.max_messages
    )
      throw new CollaborationError(
        "budget_exceeded",
        "Message budget is exhausted",
      );
    const deadline = Math.min(
      parentBudget.deadline,
      room.deadline,
      store.now() + input.budget.max_duration_ms,
    );
    if (deadline <= store.now())
      throw new CollaborationError("expired", "Child deadline has passed");
    const memberId = store.randomId();
    const token = store.randomToken();
    const childAuthority: AgentAuthority = {
      ...requestedApprovals,
      paid: paidModels,
      delegate: mayDelegate && delegationPool.tokens > 0,
      may_message: resolvedPeers,
    };
    const childBudget: AgentBudget = {
      max_tokens: input.budget.max_tokens,
      max_usd: requestedUsd,
      max_steps: input.budget.max_steps,
      max_messages: input.budget.max_messages,
      deadline,
    };
    const now = store.now();
    const nextSeq = room.next_seq;
    store.db
      .query(
        `INSERT INTO members
         (agent_id, room_id, parent_agent_id, depth, role_label, status, task_revision, token_hash,
          authority_json, peers_json, budget_json, usage_json, reserved_json, pool_json, instruction_digest,
          instruction_text, workspace_mode, write_paths_json, created_at, max_steps, max_messages, acceptance_json,
          solution_space, complexity, paid_models)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        memberId,
        room.room_id,
        member.agent_id,
        depth,
        input.role_label,
        room.task_revision,
        sha256(token),
        json(childAuthority),
        json(resolvedPeers),
        json(childBudget),
        json({ ...zeroUsage, messages_sent: 0 }),
        json(zeroReserved),
        json(delegationPool),
        canonicalInstructionDigest,
        instruction,
        workspaceMode,
        json(validatedWritePaths),
        now,
        input.budget.max_steps,
        input.budget.max_messages,
        json(acceptance),
        input.solution_space ?? null,
        input.complexity ?? null,
        paidModels ? 1 : 0,
      );
    store.db
      .query(
        `INSERT INTO jobs
         (job_id, room_id, agent_id, state, attempt, lease_owner, lease_epoch, lease_expires_at,
          cancel_requested, session_ref, base_revision, charged_usage_json, created_seq, model_id, model_reason)
         VALUES (?, ?, ?, 'queued', 0, NULL, 0, NULL, 0, NULL, NULL, ?, ?, NULL, NULL)`,
      )
      .run(store.randomId(), room.room_id, memberId, json(zeroUsage), nextSeq);
    for (const path of validatedWritePaths)
      store.db
        .query(
          "INSERT INTO write_claims(room_id, path, agent_id) VALUES (?, ?, ?)",
        )
        .run(room.room_id, path, memberId);
    store.db
      .query(
        "INSERT INTO delegations(room_id, parent_id, idempotency_key, digest, child_id) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        room.room_id,
        member.agent_id,
        input.idempotency_key,
        digest,
        memberId,
      );
    const nextReserved = {
      tokens: parentReserved.tokens + input.budget.max_tokens,
      usd: parentReserved.usd + requestedUsd,
    };
    store.db
      .query("UPDATE members SET reserved_json = ? WHERE agent_id = ?")
      .run(json(nextReserved), member.agent_id);
    updateStats(store, room.room_id, (stats) => {
      stats.delegations += 1;
      if (member.parent_agent_id === null) {
        stats.reserved.tokens += input.budget.max_tokens;
        stats.reserved.usd += requestedUsd;
      }
    });
    store.db
      .query("UPDATE rooms SET next_seq = next_seq + 1 WHERE room_id = ?")
      .run(room.room_id);
    const child = store.getMemberRow(memberId);
    return {
      ...childView(store, child),
      capability: capabilityFor(room.room_id, memberId, token),
    };
  });
}

function addUsage(left: ChildUsage, right: ChildUsage): ChildUsage {
  return {
    input_tokens: left.input_tokens + right.input_tokens,
    output_tokens: left.output_tokens + right.output_tokens,
    usd: left.usd + right.usd,
    steps: left.steps + right.steps,
  };
}

function subtractUsage(left: ChildUsage, right: ChildUsage): ChildUsage {
  return {
    input_tokens: Math.max(0, left.input_tokens - right.input_tokens),
    output_tokens: Math.max(0, left.output_tokens - right.output_tokens),
    usd: Math.max(0, left.usd - right.usd),
    steps: Math.max(0, left.steps - right.steps),
  };
}

function tokensUsed(usage: ChildUsage): number {
  return usage.input_tokens + usage.output_tokens;
}

function ownRuntimeCharged(
  store: CollaborationStore,
  member: MemberRow,
): ChildUsage {
  if (member.parent_agent_id === null) return zeroUsage;
  const job = store.db
    .query<{ charged_usage_json: string }, [string]>(
      "SELECT charged_usage_json FROM jobs WHERE agent_id = ?",
    )
    .get(member.agent_id);
  return job ? decodeJson<ChildUsage>(job.charged_usage_json) : zeroUsage;
}

function chargeUsage(
  store: CollaborationStore,
  member: MemberRow,
  delta: ChildUsage,
): void {
  if (
    delta.input_tokens === 0 &&
    delta.output_tokens === 0 &&
    delta.usd === 0 &&
    delta.steps === 0
  )
    return;
  const memberUsage = decodeJson<MemberUsage>(member.usage_json);
  const nextMember: MemberUsage = {
    ...addUsage(memberUsage, delta),
    messages_sent: memberUsage.messages_sent,
  };
  store.db
    .query("UPDATE members SET usage_json = ? WHERE agent_id = ?")
    .run(json(nextMember), member.agent_id);
  let parentId = member.parent_agent_id;
  while (parentId) {
    const parent = store.getMemberRow(parentId);
    const usage = decodeJson<MemberUsage>(parent.usage_json);
    store.db.query("UPDATE members SET usage_json = ? WHERE agent_id = ?").run(
      json({
        ...addUsage(usage, delta),
        messages_sent: usage.messages_sent,
      }),
      parent.agent_id,
    );
    parentId = parent.parent_agent_id;
  }
  updateStats(store, member.room_id, (stats) => {
    stats.tokens.input += delta.input_tokens;
    stats.tokens.output += delta.output_tokens;
    stats.usd += delta.usd;
    stats.steps += delta.steps;
    stats.reserved.tokens = Math.max(
      0,
      stats.reserved.tokens - tokensUsed(delta),
    );
    stats.reserved.usd = Math.max(0, stats.reserved.usd - delta.usd);
  });
}

function releaseChildReservation(
  store: CollaborationStore,
  member: MemberRow,
): { tokens: number; usd: number } {
  const budget = agentBudget(member);
  const reservation = {
    tokens: budget.max_tokens,
    usd: budget.max_usd,
  };
  if (member.parent_agent_id) {
    const parent = store.getMemberRow(member.parent_agent_id);
    const parentReservation = decodeJson<{ tokens: number; usd: number }>(
      parent.reserved_json,
    );
    store.db
      .query("UPDATE members SET reserved_json = ? WHERE agent_id = ?")
      .run(
        json({
          tokens: Math.max(0, parentReservation.tokens - reservation.tokens),
          usd: Math.max(0, parentReservation.usd - reservation.usd),
        }),
        parent.agent_id,
      );
  }
  store.db
    .query("UPDATE members SET reserved_json = ? WHERE agent_id = ?")
    .run(json(zeroReserved), member.agent_id);
  if (member.parent_agent_id) {
    const parent = store.getMemberRow(member.parent_agent_id);
    if (parent.parent_agent_id === null) {
      const usage = decodeJson<MemberUsage>(member.usage_json);
      updateStats(store, member.room_id, (stats) => {
        stats.reserved.tokens = Math.max(
          0,
          stats.reserved.tokens -
            Math.max(0, reservation.tokens - tokensUsed(usage)),
        );
        stats.reserved.usd = Math.max(
          0,
          stats.reserved.usd - Math.max(0, reservation.usd - usage.usd),
        );
      });
    }
  }
  return reservation;
}

function closeDrainedRoom(store: CollaborationStore, roomId: string): void {
  const room = store.getRoomRow(roomId);
  if (room.status === "draining" && activeJobs(store, roomId) === 0)
    store.db
      .query("UPDATE rooms SET status = 'closed' WHERE room_id = ?")
      .run(roomId);
}

function expireJob(
  store: CollaborationStore,
  job: JobRow,
  member: MemberRow,
): void {
  store.db
    .query("UPDATE jobs SET state = 'expired' WHERE job_id = ?")
    .run(job.job_id);
  store.db
    .query("UPDATE members SET status = 'expired' WHERE agent_id = ?")
    .run(member.agent_id);
  releaseChildReservation(store, member);
  releaseClaims(store, member.agent_id);
  expireMemberDeliveries(store, member.agent_id);
  updateStats(store, job.room_id, (stats) => {
    stats.children_expired += 1;
  });
}

function createJobsApi(store: CollaborationStore): CollaborationJobs {
  return {
    leaseMs: store.limits.lease_ms,
    currentTime() {
      return store.now();
    },
    async claim(runnerId) {
      if (!runnerId.trim()) invalidInput("Runner id is required");
      return store.transaction(() => {
        const now = store.now();
        const candidates = store.db
          .query<JobRow, []>(
            "SELECT * FROM jobs WHERE state = 'queued' ORDER BY created_seq, job_id",
          )
          .all();
        for (const job of candidates) {
          const room = store.getRoomRow(job.room_id);
          const member = store.getMemberRow(job.agent_id);
          if (
            (room.status !== "open" && room.status !== "draining") ||
            member.status !== "active" ||
            job.cancel_requested
          ) {
            if (job.cancel_requested || member.status !== "active") {
              store.db
                .query("UPDATE jobs SET state = 'cancelled' WHERE job_id = ?")
                .run(job.job_id);
              if (member.status === "active")
                store.db
                  .query(
                    "UPDATE members SET status = 'cancelled' WHERE agent_id = ?",
                  )
                  .run(member.agent_id);
              releaseChildReservation(store, member);
            }
            continue;
          }
          if (room.deadline <= now || agentBudget(member).deadline <= now) {
            expireJob(store, job, member);
            continue;
          }
          const roomBudget = decodeJson<Budget>(room.budget_json);
          const running =
            store.db
              .query<{ amount: number }, [string]>(
                "SELECT COUNT(*) AS amount FROM jobs WHERE room_id = ? AND state = 'running'",
              )
              .get(room.room_id)?.amount ?? 0;
          if (running >= Math.max(0, roomBudget.max_concurrency - 1)) continue;
          const leaseEpoch = job.lease_epoch + 1;
          const attempt = job.attempt + 1;
          store.db
            .query(
              `UPDATE jobs SET state = 'running', lease_owner = ?, lease_epoch = ?,
               lease_expires_at = ?, attempt = ? WHERE job_id = ? AND state = 'queued'`,
            )
            .run(
              runnerId,
              leaseEpoch,
              now + store.limits.lease_ms,
              attempt,
              job.job_id,
            );
          return {
            job_id: job.job_id,
            room_id: job.room_id,
            agent_id: job.agent_id,
            parent_agent_id: member.parent_agent_id ?? "",
            lease_epoch: leaseEpoch,
            attempt,
          };
        }
        return null;
      });
    },
    async requestCancel(jobId, runnerId, epoch) {
      return store.transaction(() => {
        const result = store.db
          .query(
            `UPDATE jobs SET cancel_requested = 1
             WHERE job_id = ? AND state = 'running' AND lease_owner = ? AND lease_epoch = ?`,
          )
          .run(jobId, runnerId, epoch);
        if (result.changes !== 1)
          throw new CollaborationError(
            "lease_lost",
            "Runner lease is no longer valid",
          );
      });
    },
    async setModelSelection(jobId, runnerId, epoch, modelId, reason) {
      return store.transaction(() => {
        const result = store.db
          .query(
            `UPDATE jobs SET model_id = ?, model_reason = ?
             WHERE job_id = ? AND state = 'running' AND lease_owner = ? AND lease_epoch = ?`,
          )
          .run(modelId, reason.slice(0, 256), jobId, runnerId, epoch);
        if (result.changes !== 1)
          throw new CollaborationError(
            "lease_lost",
            "Runner lease is no longer valid",
          );
      });
    },
    async heartbeat(jobId, runnerId, epoch, progress) {
      return store.transaction(() => {
        const job = store.db
          .query<JobRow, [string]>("SELECT * FROM jobs WHERE job_id = ?")
          .get(jobId);
        if (
          !job ||
          job.state !== "running" ||
          job.lease_owner !== runnerId ||
          job.lease_epoch !== epoch
        )
          throw new CollaborationError(
            "lease_lost",
            "Runner lease is no longer valid",
          );
        const room = store.getRoomRow(job.room_id);
        const member = store.getMemberRow(job.agent_id);
        const budget = agentBudget(member);
        const ownRuntimeCap = runtimeCap(member);
        const stop =
          Boolean(job.cancel_requested) ||
          member.status === "cancelled" ||
          room.status === "closed" ||
          store.now() >= budget.deadline ||
          Math.max(progress.steps, progress.usage?.steps ?? 0) >
            (member.max_steps ?? Number.MAX_SAFE_INTEGER) ||
          (progress.usage !== null &&
            (tokensUsed(progress.usage) > ownRuntimeCap.tokens ||
              progress.usage.usd > ownRuntimeCap.usd));
        store.db
          .query(
            `UPDATE jobs SET lease_expires_at = ?, session_ref = COALESCE(?, session_ref),
             base_revision = COALESCE(?, base_revision) WHERE job_id = ?`,
          )
          .run(
            store.now() + store.limits.lease_ms,
            progress.session_ref ?? null,
            progress.base_revision === undefined
              ? null
              : progress.base_revision,
            jobId,
          );
        const charged = decodeJson<ChildUsage>(job.charged_usage_json);
        const observed = progress.usage
          ? {
              ...progress.usage,
              steps: Math.max(progress.steps, progress.usage.steps),
            }
          : { ...charged, steps: Math.max(charged.steps, progress.steps) };
        const delta = subtractUsage(observed, charged);
        chargeUsage(store, member, delta);
        store.db
          .query("UPDATE jobs SET charged_usage_json = ? WHERE job_id = ?")
          .run(json(addUsage(charged, delta)), jobId);
        return { stop };
      });
    },
    async finalize(jobId, runnerId, epoch, outcome) {
      return store.transaction(() => {
        const job = store.db
          .query<JobRow, [string]>("SELECT * FROM jobs WHERE job_id = ?")
          .get(jobId);
        if (
          !job ||
          job.state !== "running" ||
          job.lease_owner !== runnerId ||
          job.lease_epoch !== epoch
        ) {
          if (job)
            updateStats(store, job.room_id, (stats) => {
              stats.discarded_results += 1;
            });
          throw new CollaborationError(
            "lease_lost",
            "Runner lease is no longer valid",
          );
        }
        const member = store.getMemberRow(job.agent_id);
        const room = store.getRoomRow(job.room_id);
        releaseChildReservation(store, member);
        const charged = decodeJson<ChildUsage>(job.charged_usage_json);
        const ownRuntimeCap = runtimeCap(member);
        let effectiveOutcome = outcome;
        if (outcome.usage === null) {
          const fullUsage: ChildUsage = {
            input_tokens: Math.max(
              0,
              ownRuntimeCap.tokens - tokensUsed(charged),
            ),
            output_tokens: 0,
            usd: Math.max(0, ownRuntimeCap.usd - charged.usd),
            steps: 0,
          };
          chargeUsage(store, member, fullUsage);
          store.db
            .query(
              "UPDATE jobs SET state = 'failed', lease_owner = NULL WHERE job_id = ?",
            )
            .run(jobId);
          store.db
            .query("UPDATE members SET status = 'failed' WHERE agent_id = ?")
            .run(member.agent_id);
          releaseClaims(store, member.agent_id);
          expireMemberDeliveries(store, member.agent_id);
          updateStats(store, room.room_id, (stats) => {
            stats.usage_unaccounted += 1;
          });
          updateStats(store, room.room_id, (stats) => {
            stats.children_failed += 1;
          });
          closeDrainedRoom(store, room.room_id);
          return;
        } else {
          const usage = outcome.usage;
          const delta = subtractUsage(usage, charged);
          chargeUsage(store, member, delta);
          if (
            tokensUsed(usage) > ownRuntimeCap.tokens ||
            usage.usd > ownRuntimeCap.usd ||
            usage.steps > (member.max_steps ?? Number.MAX_SAFE_INTEGER)
          ) {
            effectiveOutcome = {
              ...outcome,
              status: "failed",
              errorCode: "budget_exceeded",
            };
            updateStats(store, room.room_id, (stats) => {
              stats.over_budget += 1;
            });
          }
        }
        const cancelled =
          Boolean(job.cancel_requested) || member.status === "cancelled";
        if (cancelled) {
          store.db
            .query(
              "UPDATE jobs SET state = 'cancelled', lease_owner = NULL WHERE job_id = ?",
            )
            .run(jobId);
          store.db
            .query("UPDATE members SET status = 'cancelled' WHERE agent_id = ?")
            .run(member.agent_id);
          updateStats(store, room.room_id, (stats) => {
            stats.children_cancelled += 1;
            stats.discarded_results += 1;
          });
        } else {
          const freshRoom = store.getRoomRow(room.room_id);
          const status =
            effectiveOutcome.status === "completed" ||
            effectiveOutcome.status === "paused"
              ? "completed"
              : effectiveOutcome.status;
          store.db
            .query("UPDATE members SET status = ? WHERE agent_id = ?")
            .run(status, member.agent_id);
          store.db
            .query(
              "UPDATE jobs SET state = ?, lease_owner = NULL WHERE job_id = ?",
            )
            .run(status, jobId);
          releaseClaims(store, member.agent_id);
          expireMemberDeliveries(store, member.agent_id);
          if (status === "completed")
            updateStats(store, room.room_id, (stats) => {
              stats.children_completed += 1;
            });
          else if (status === "failed")
            updateStats(store, room.room_id, (stats) => {
              stats.children_failed += 1;
            });
          const summaryLimit = decodeJson<CollaborationLimits>(
            freshRoom.limits_json,
          ).max_summary_bytes;
          const { summary, truncated } = truncateUtf8(
            effectiveOutcome.summary,
            summaryLimit,
          );
          let safeSummary = summary;
          let unsafeSummary = false;
          try {
            assertPublishable(
              safeSummary,
              store.hostPrivateRoots,
              store.rootDir,
            );
          } catch (error) {
            if (!(error instanceof CollaborationError)) throw error;
            safeSummary = "";
            unsafeSummary = true;
          }
          const maxArtifacts = decodeJson<CollaborationLimits>(
            freshRoom.limits_json,
          ).max_artifacts;
          const artifacts = effectiveOutcome.artifacts
            .slice(0, maxArtifacts)
            .map((artifact) => ArtifactRefSchema.parse(artifact));
          const resultId = store.randomId();
          const resultStatus =
            freshRoom.task_revision === member.task_revision
              ? "proposed"
              : "stale";
          store.db
            .query(
              `INSERT INTO results
               (result_id, room_id, child_agent_id, parent_agent_id, source_task_id,
                source_task_revision, base_revision, status, outcome, summary,
                summary_truncated, unsafe_summary, artifacts_json, usage_json, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              resultId,
              room.room_id,
              member.agent_id,
              member.parent_agent_id ?? "",
              room.task_id,
              member.task_revision,
              job.base_revision,
              resultStatus,
              effectiveOutcome.status,
              safeSummary,
              truncated ? 1 : 0,
              unsafeSummary ? 1 : 0,
              json(artifacts),
              json(effectiveOutcome.usage ?? zeroUsage),
              store.now(),
            );
          if (resultStatus === "stale")
            updateStats(store, room.room_id, (stats) => {
              stats.results_stale += 1;
            });
        }
        closeDrainedRoom(store, room.room_id);
      });
    },
    async recoverExpired() {
      return store.transaction(() => {
        const now = store.now();
        const rows = store.db
          .query<JobRow, [number]>(
            "SELECT * FROM jobs WHERE state = 'running' AND lease_expires_at <= ? ORDER BY created_seq",
          )
          .all(now);
        return rows.map((job) => {
          const member = store.getMemberRow(job.agent_id);
          const room = store.getRoomRow(job.room_id);
          return {
            job_id: job.job_id,
            room_id: job.room_id,
            agent_id: job.agent_id,
            attempt: job.attempt,
            session_ref: job.session_ref,
            cancel_requested: Boolean(job.cancel_requested),
            deadline: Math.min(room.deadline, agentBudget(member).deadline),
          };
        });
      });
    },
    async recoverJob(jobId, usage) {
      return store.transaction(() => {
        const job = store.db
          .query<JobRow, [string]>("SELECT * FROM jobs WHERE job_id = ?")
          .get(jobId);
        if (
          !job ||
          job.state !== "running" ||
          job.lease_expires_at === null ||
          job.lease_expires_at > store.now()
        )
          return "unchanged" as const;
        const member = store.getMemberRow(job.agent_id);
        const room = store.getRoomRow(job.room_id);
        const charged = decodeJson<ChildUsage>(job.charged_usage_json);
        const ownRuntimeCap = runtimeCap(member);
        if (usage === null) {
          chargeUsage(store, member, {
            input_tokens: Math.max(
              0,
              ownRuntimeCap.tokens - tokensUsed(charged),
            ),
            output_tokens: 0,
            usd: Math.max(0, ownRuntimeCap.usd - charged.usd),
            steps: 0,
          });
          releaseChildReservation(store, member);
          store.db
            .query(
              "UPDATE jobs SET state = 'failed', lease_owner = NULL WHERE job_id = ?",
            )
            .run(jobId);
          store.db
            .query("UPDATE members SET status = 'failed' WHERE agent_id = ?")
            .run(member.agent_id);
          releaseClaims(store, member.agent_id);
          expireMemberDeliveries(store, member.agent_id);
          updateStats(store, room.room_id, (stats) => {
            stats.usage_unaccounted += 1;
            stats.children_failed += 1;
          });
          closeDrainedRoom(store, room.room_id);
          return "failed" as const;
        }
        const delta = subtractUsage(usage, charged);
        chargeUsage(store, member, delta);
        const nextCharged = addUsage(charged, delta);
        if (
          tokensUsed(usage) > ownRuntimeCap.tokens ||
          usage.usd > ownRuntimeCap.usd ||
          usage.steps > (member.max_steps ?? Number.MAX_SAFE_INTEGER)
        ) {
          releaseChildReservation(store, member);
          store.db
            .query(
              "UPDATE jobs SET state = 'failed', lease_owner = NULL WHERE job_id = ?",
            )
            .run(jobId);
          store.db
            .query("UPDATE members SET status = 'failed' WHERE agent_id = ?")
            .run(member.agent_id);
          releaseClaims(store, member.agent_id);
          expireMemberDeliveries(store, member.agent_id);
          updateStats(store, room.room_id, (stats) => {
            stats.over_budget += 1;
            stats.children_failed += 1;
          });
          closeDrainedRoom(store, room.room_id);
          return "failed" as const;
        }
        const shouldRetry =
          job.attempt < store.limits.max_attempts &&
          Math.min(room.deadline, agentBudget(member).deadline) > store.now() &&
          !job.cancel_requested &&
          member.status === "active";
        if (shouldRetry) {
          store.db
            .query(
              `UPDATE jobs SET state = 'queued', lease_owner = NULL,
               lease_expires_at = NULL, charged_usage_json = ? WHERE job_id = ?`,
            )
            .run(json(nextCharged), jobId);
          return "requeued" as const;
        }
        releaseChildReservation(store, member);
        store.db
          .query(
            "UPDATE jobs SET state = 'failed', lease_owner = NULL WHERE job_id = ?",
          )
          .run(jobId);
        store.db
          .query("UPDATE members SET status = 'failed' WHERE agent_id = ?")
          .run(member.agent_id);
        releaseClaims(store, member.agent_id);
        expireMemberDeliveries(store, member.agent_id);
        updateStats(store, room.room_id, (stats) => {
          stats.children_failed += 1;
        });
        closeDrainedRoom(store, room.room_id);
        return "failed" as const;
      });
    },
    async getLaunchContext(jobId) {
      return store.transaction(() => {
        const job = store.db
          .query<JobRow, [string]>("SELECT * FROM jobs WHERE job_id = ?")
          .get(jobId);
        if (!job)
          throw new CollaborationError("not_found", "Child job not found");
        const room = store.getRoomRow(job.room_id);
        const member = store.getMemberRow(job.agent_id);
        const parentModelId = member.parent_agent_id
          ? store.db
              .query<{ model_id: string | null }, [string]>(
                "SELECT model_id FROM jobs WHERE agent_id = ?",
              )
              .get(member.parent_agent_id)?.model_id
          : null;
        const criteria = decodeJson<string[]>(member.acceptance_json);
        const now = store.now();
        const delivered = store.db
          .query<InboxRow, [string, number]>(
            `SELECT m.*, d.delivered_count, d.state, sender.role_label
             FROM deliveries d JOIN messages m ON m.message_id = d.message_id
             JOIN members sender ON sender.agent_id = m.sender_id
             WHERE d.recipient_id = ? AND d.state IN ('pending', 'delivered') AND m.expires_at > ?
             ORDER BY m.seq`,
          )
          .all(member.agent_id, now);
        const rendered: string[] = [];
        for (const row of delivered) {
          const view = DeliveredMessageSchema.parse({
            message_id: row.message_id,
            seq: row.seq,
            sender: { agent_id: row.sender_id, role_label: row.role_label },
            kind: row.kind,
            body: row.body,
            in_reply_to: row.in_reply_to,
            artifacts: decodeJson<ArtifactRef[]>(row.artifacts_json),
            created_at: row.created_at,
            expires_at: row.expires_at,
            delivered_count: Math.max(1, row.delivered_count + 1),
            trust: "untrusted",
            authority: "none",
          });
          rendered.push(renderUntrustedMessage(view));
          store.db
            .query(
              "UPDATE deliveries SET state = 'delivered', delivered_count = delivered_count + 1 WHERE message_id = ? AND recipient_id = ?",
            )
            .run(row.message_id, member.agent_id);
          if (row.delivered_count > 0)
            updateStats(store, room.room_id, (stats) => {
              stats.redeliveries += 1;
            });
        }
        const instruction = [
          member.instruction_text,
          ...(criteria.length > 0
            ? [
                `Acceptance criteria:\n${criteria.map((item) => `- ${item}`).join("\n")}`,
              ]
            : []),
          ...(rendered.length > 0
            ? [`Untrusted coordination messages:\n${rendered.join("\n\n")}`]
            : []),
        ].join("\n\n");
        assertPublishable(instruction, store.hostPrivateRoots, store.rootDir);
        return {
          now,
          room: roomView(store, room),
          task_id: room.task_id,
          task_revision: room.task_revision,
          member: memberView(member),
          instruction,
          acceptance_criteria: criteria,
          solution_space: member.solution_space,
          complexity: member.complexity as "light" | "medium" | "heavy" | null,
          paid_models: Boolean(member.paid_models),
          parent_model_id: parentModelId ?? room.model_id,
          session_ref: job.session_ref,
          attempt: job.attempt,
          job_id: job.job_id,
          model_id: job.model_id,
          model_reason: job.model_reason,
          charged_usage: decodeJson<ChildUsage>(job.charged_usage_json),
        };
      });
    },
    async expireUnstarted(now = store.now()) {
      return store.transaction(() => {
        const jobs = store.db
          .query<JobRow, [number]>(
            "SELECT * FROM jobs WHERE state = 'queued' ORDER BY created_seq",
          )
          .all(now);
        let count = 0;
        for (const job of jobs) {
          const member = store.getMemberRow(job.agent_id);
          const room = store.getRoomRow(job.room_id);
          if (room.deadline <= now || agentBudget(member).deadline <= now) {
            expireJob(store, job, member);
            count += 1;
          }
        }
        return count;
      });
    },
  };
}

function truncateUtf8(
  value: string,
  maxBytes: number,
): { summary: string; truncated: boolean } {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(value);
  if (bytes.length <= maxBytes) return { summary: value, truncated: false };
  let end = maxBytes;
  while (end > 0) {
    try {
      return {
        summary: new TextDecoder("utf-8", { fatal: true }).decode(
          bytes.slice(0, end),
        ),
        truncated: true,
      };
    } catch {
      end -= 1;
    }
  }
  return { summary: "", truncated: true };
}

export async function createCollaboration(
  options: CollaborationOptions,
): Promise<Collaboration> {
  const store = await CollaborationStore.open(options);
  return {
    host: createHost(store),
    agents: createAgentPort(store),
    async close() {
      store.close();
    },
  };
}
