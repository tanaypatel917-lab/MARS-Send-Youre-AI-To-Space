import { createHash, randomUUID } from "node:crypto";
import {
  type ArtifactRef,
  type CheckpointRef,
  type EventEnvelope,
  type RequiredCheck,
  RequiredCheckSchema,
  type Scope,
  type Task,
  TaskSchema,
  type VerificationView,
  VerificationViewSchema,
  type WorkspaceRef,
} from "@mars/contracts";
import type { z } from "zod";
import {
  type Approvals,
  ApprovalsSchema,
  ArtifactDataSchema,
  CheckpointRefSchema,
  type DescribeResult,
  DescribeResultSchema,
  type DiffResult,
  DiffResultSchema,
  EventBatchSchema,
  makeContext,
  NullResultSchema,
  RPC_METHODS,
  type RpcMethod,
  sameScope,
  TaskListSchema,
  WorkspaceRefSchema,
} from "./protocol";
import { RpcError, type RpcTransport } from "./rpc";

export interface StartOptions {
  expectedRevision: number;
  approvals: Approvals;
  modelId?: string;
  /** Host-run checks fixed at launch; the server verifies the finished candidate against them. */
  requiredChecks?: readonly RequiredCheck[];
}

export interface VerifiedArtifact {
  ref: ArtifactRef;
  media_type: string;
  bytes: Uint8Array;
}

function invalid(what: string): RpcError {
  return new RpcError("protocol", `Server returned an invalid ${what}.`);
}

function validate<T extends z.ZodTypeAny>(
  schema: T,
  value: unknown,
  what: string,
): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw invalid(what);
  return parsed.data;
}

/**
 * Typed client for the frozen MARS workbench RPC protocol. Every response is
 * validated against @mars/contracts schemas and the server's own scope;
 * anything unexpected is rejected as a protocol error.
 */
export class MarsClient {
  private described: DescribeResult | undefined;

  constructor(
    private readonly transport: RpcTransport,
    private readonly newId: () => string = randomUUID,
  ) {}

  get server(): DescribeResult | undefined {
    return this.described;
  }

  async describe(signal?: AbortSignal): Promise<DescribeResult> {
    const result = await this.transport.send(
      { method: RPC_METHODS.describe, params: {} },
      signal,
    );
    this.described = validate(
      DescribeResultSchema,
      result,
      "server description",
    );
    return this.described;
  }

  private scope(): Scope {
    if (!this.described)
      throw new RpcError("disconnected", "Not connected to a MARS server.");
    return this.described.scope;
  }

  private async call(
    method: RpcMethod,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const context = makeContext(this.scope(), this.newId());
    return this.transport.send({ method, context, params }, signal);
  }

  private checkTask(value: unknown, taskId?: string): Task {
    const task = validate(TaskSchema, value, "task");
    if (!sameScope(task.scope, this.scope())) throw invalid("task scope");
    if (taskId !== undefined && task.task_id !== taskId)
      throw invalid("task identity");
    return task;
  }

  private checkWorkspace(workspace: WorkspaceRef): WorkspaceRef {
    const expected = this.scope().workspace_id;
    if (expected !== undefined && workspace.workspace_id !== expected)
      throw invalid("workspace identity");
    return workspace;
  }

  async create(task: Task, signal?: AbortSignal): Promise<Task> {
    const created = this.checkTask(
      await this.call(RPC_METHODS.create, { task }, signal),
      task.task_id,
    );
    if (created.session_id !== task.session_id) throw invalid("task session");
    return created;
  }

  async list(signal?: AbortSignal): Promise<Task[]> {
    const tasks = validate(
      TaskListSchema,
      await this.call(RPC_METHODS.list, {}, signal),
      "task list",
    );
    const ids = new Set<string>();
    for (const task of tasks) {
      if (!sameScope(task.scope, this.scope()) || ids.has(task.task_id))
        throw invalid("task list");
      ids.add(task.task_id);
    }
    return tasks;
  }

  async inspect(taskId: string, signal?: AbortSignal): Promise<Task> {
    return this.checkTask(
      await this.call(RPC_METHODS.inspect, { task_id: taskId }, signal),
      taskId,
    );
  }

  async start(
    taskId: string,
    options: StartOptions,
    signal?: AbortSignal,
  ): Promise<Task> {
    const params: Record<string, unknown> = {
      task_id: taskId,
      expected_revision: options.expectedRevision,
      approvals: ApprovalsSchema.parse(options.approvals),
    };
    if (options.modelId) params.model_id = options.modelId;
    if (options.requiredChecks?.length)
      params.required_checks = options.requiredChecks.map((check) =>
        RequiredCheckSchema.parse(check),
      );
    return this.checkTask(
      await this.call(RPC_METHODS.start, params, signal),
      taskId,
    );
  }

  /** The host-owned verification verdict for the task's current candidate revision. */
  async verification(
    taskId: string,
    signal?: AbortSignal,
  ): Promise<VerificationView> {
    const view = validate(
      VerificationViewSchema,
      await this.call(RPC_METHODS.verification, { task_id: taskId }, signal),
      "verification",
    );
    if (view.candidate) this.checkWorkspace(view.candidate);
    for (const record of view.records)
      if (record.task_id !== taskId) throw invalid("verification identity");
    if (view.record && !view.records.includes(view.record)) {
      const known = view.records.some(
        (record) =>
          record.run_id === view.record?.run_id &&
          record.recorded_at === view.record?.recorded_at &&
          record.candidate?.revision === view.record?.candidate?.revision,
      );
      if (!known) throw invalid("verification record");
    }
    return view;
  }

  async resume(
    taskId: string,
    expectedRevision: number,
    signal?: AbortSignal,
  ): Promise<Task> {
    return this.checkTask(
      await this.call(
        RPC_METHODS.resume,
        { task_id: taskId, expected_revision: expectedRevision },
        signal,
      ),
      taskId,
    );
  }

  async steer(
    taskId: string,
    instruction: string,
    signal?: AbortSignal,
  ): Promise<void> {
    validate(
      NullResultSchema,
      await this.call(
        RPC_METHODS.steer,
        { task_id: taskId, instruction },
        signal,
      ),
      "steer result",
    );
  }

  async cancel(taskId: string, signal?: AbortSignal): Promise<void> {
    validate(
      NullResultSchema,
      await this.call(RPC_METHODS.cancel, { task_id: taskId }, signal),
      "cancel result",
    );
  }

  async events(
    taskId: string,
    afterEventId: string | undefined,
    signal?: AbortSignal,
  ): Promise<EventEnvelope[]> {
    const params: Record<string, unknown> = { task_id: taskId };
    if (afterEventId !== undefined) params.after_event_id = afterEventId;
    const events = validate(
      EventBatchSchema,
      await this.call(RPC_METHODS.events, params, signal),
      "event batch",
    );
    const ids = new Set<string>();
    for (const event of events) {
      if (
        event.task_id !== taskId ||
        !sameScope(event.scope, this.scope()) ||
        event.event_id === afterEventId ||
        ids.has(event.event_id)
      )
        throw invalid("event batch");
      ids.add(event.event_id);
    }
    return events;
  }

  /** Fetches an artifact and verifies its bytes against the immutable ref. */
  async artifact(
    taskId: string,
    ref: ArtifactRef,
    signal?: AbortSignal,
  ): Promise<VerifiedArtifact> {
    const data = validate(
      ArtifactDataSchema,
      await this.call(
        RPC_METHODS.artifact,
        { task_id: taskId, artifact: ref },
        signal,
      ),
      "artifact",
    );
    const bytes = new Uint8Array(Buffer.from(data.data_base64, "base64"));
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (
      bytes.byteLength !== ref.byte_length ||
      digest !== ref.sha256 ||
      data.media_type !== ref.media_type
    )
      throw invalid("artifact content (hash, size or media type mismatch)");
    return { ref, media_type: data.media_type, bytes };
  }

  async diff(taskId: string, signal?: AbortSignal): Promise<DiffResult> {
    const result = validate(
      DiffResultSchema,
      await this.call(RPC_METHODS.diff, { task_id: taskId }, signal),
      "diff",
    );
    const paths = new Set<string>();
    for (const file of result.files) {
      if (paths.has(file.path)) throw invalid("diff (duplicate path)");
      paths.add(file.path);
    }
    return result;
  }

  async checkpoint(
    taskId: string,
    signal?: AbortSignal,
  ): Promise<CheckpointRef> {
    const checkpoint = validate(
      CheckpointRefSchema,
      await this.call(RPC_METHODS.checkpoint, { task_id: taskId }, signal),
      "checkpoint",
    );
    this.checkWorkspace(checkpoint.workspace);
    return checkpoint;
  }

  async restore(
    taskId: string,
    checkpoint: CheckpointRef,
    expectedRevision: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceRef> {
    const workspace = validate(
      WorkspaceRefSchema,
      await this.call(
        RPC_METHODS.restore,
        {
          task_id: taskId,
          checkpoint_id: checkpoint.checkpoint_id,
          expected_revision: expectedRevision,
        },
        signal,
      ),
      "restored workspace",
    );
    if (workspace.workspace_id !== checkpoint.workspace.workspace_id)
      throw invalid("restored workspace identity");
    return this.checkWorkspace(workspace);
  }
}
