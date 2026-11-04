import { createHash, timingSafeEqual } from "node:crypto";
import {
  type ArtifactRef,
  type CheckpointRef,
  type EventEnvelope,
  EventEnvelopeSchema,
  type RequestContext,
  type Scope,
  ScopeSchema,
  type Task,
  TaskSchema,
  type VerificationView,
  VerificationViewSchema,
  type WorkspaceRef,
} from "@mars/contracts";
import { z } from "zod";
import {
  type ArtifactData,
  ArtifactDataSchema,
  CheckpointRefSchema,
  type DescribeResult,
  DescribeResultSchema,
  type DiffResult,
  DiffResultSchema,
  type RpcRequest,
  RpcRequestSchema,
  type StartParams,
  WorkspaceRefSchema,
} from "./protocol";

export interface WorkbenchOperations {
  readonly scope: Scope;
  describe(): Promise<DescribeResult>;
  create(context: RequestContext, task: Task): Promise<Task>;
  list(context: RequestContext): Promise<Task[]>;
  inspect(context: RequestContext, taskId: string): Promise<Task>;
  start(context: RequestContext, params: StartParams): Promise<Task>;
  resume(
    context: RequestContext,
    taskId: string,
    revision: number,
  ): Promise<Task>;
  steer(
    context: RequestContext,
    taskId: string,
    instruction: string,
  ): Promise<void>;
  cancel(context: RequestContext, taskId: string): Promise<void>;
  /** Earliest events after cursor, in order; callers resume from the last returned id. */
  events(
    context: RequestContext,
    taskId: string,
    cursor?: string,
  ): Promise<EventEnvelope[]>;
  artifact(
    context: RequestContext,
    taskId: string,
    ref: ArtifactRef,
  ): Promise<ArtifactData>;
  diff(context: RequestContext, taskId: string): Promise<DiffResult>;
  checkpoint(context: RequestContext, taskId: string): Promise<CheckpointRef>;
  /** The host-owned verification verdict for the task's current candidate revision. */
  verification(
    context: RequestContext,
    taskId: string,
  ): Promise<VerificationView>;
  restore(
    context: RequestContext,
    taskId: string,
    checkpointId: string,
    revision: string,
  ): Promise<WorkspaceRef>;
}

export interface WorkbenchServerOptions {
  api: WorkbenchOperations;
  token: string;
  port?: number;
}

export type RpcErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "unavailable"
  | "model_unavailable"
  | "too_large"
  | "internal_error";
const errors: Record<RpcErrorCode, { status: number; message: string }> = {
  invalid_request: { status: 400, message: "Invalid workbench request." },
  unauthorized: {
    status: 401,
    message: "A valid workbench token is required.",
  },
  forbidden: {
    status: 403,
    message: "The workbench request is not permitted.",
  },
  not_found: { status: 404, message: "Workbench resource not found." },
  conflict: {
    status: 409,
    message: "Workbench revision or execution conflict.",
  },
  unavailable: { status: 503, message: "Workbench execution is unavailable." },
  model_unavailable: {
    status: 503,
    message:
      "No eligible configured model. Configure a tool-capable free model and its credential, then retry. Paid models require explicit selection and authorization.",
  },
  too_large: {
    status: 413,
    message: "Workbench payload exceeds the size limit.",
  },
  internal_error: { status: 500, message: "Workbench operation failed." },
};
export class WorkbenchError extends Error {
  constructor(readonly code: RpcErrorCode) {
    super(errors[code].message);
    this.name = "WorkbenchError";
  }
}

const MAX_REQUEST_BYTES = 512 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_EVENT_PAGE_EVENTS = 1000;
const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};
const taskList = z.array(TaskSchema).max(10_000);
const eventList = z.array(EventEnvelopeSchema).max(10_000);
const digest = (value: string) => createHash("sha256").update(value).digest();

function eventPage(events: EventEnvelope[]): EventEnvelope[] {
  if (!Array.isArray(events)) throw new WorkbenchError("internal_error");
  const page: EventEnvelope[] = [];
  let bytes = Buffer.byteLength('{"result":[]}');
  for (const value of events) {
    if (page.length >= MAX_EVENT_PAGE_EVENTS) break;
    const event = EventEnvelopeSchema.parse(value);
    const size =
      Buffer.byteLength(JSON.stringify(event)) + (page.length ? 1 : 0);
    if (bytes + size > MAX_RESPONSE_BYTES) {
      if (page.length === 0) throw new WorkbenchError("too_large");
      break;
    }
    page.push(event);
    bytes += size;
  }
  return page;
}

function sameScope(a: Scope, b: Scope): boolean {
  return (
    a.owner_id === b.owner_id &&
    a.project_id === b.project_id &&
    a.workspace_id === b.workspace_id
  );
}

function responseError(code: RpcErrorCode): Response {
  const detail = errors[code];
  return Response.json(
    { error: { code, message: detail.message } },
    { status: detail.status, headers },
  );
}

function errorCode(error: unknown): RpcErrorCode {
  if (error instanceof WorkbenchError) return error.code;
  if (error instanceof Error && "code" in error) {
    switch (error.code) {
      case "stale_revision":
      case "revision_conflict":
      case "conflict":
      case "invalid_transition":
        return "conflict";
      case "not_found":
        return "not_found";
      case "unsafe_path":
      case "permission_denied":
        return "forbidden";
      case "invalid_input":
      case "unknown_cursor":
        return "invalid_request";
    }
  }
  return "internal_error";
}

async function dispatch(
  api: WorkbenchOperations,
  request: RpcRequest,
): Promise<unknown> {
  if (request.method === "workbench.describe")
    return DescribeResultSchema.parse(await api.describe());
  const context = request.context;
  switch (request.method) {
    case "tasks.create":
      return TaskSchema.parse(await api.create(context, request.params.task));
    case "tasks.list":
      return taskList.parse(await api.list(context));
    case "tasks.inspect":
      return TaskSchema.parse(
        await api.inspect(context, request.params.task_id),
      );
    case "tasks.start":
      return TaskSchema.parse(await api.start(context, request.params));
    case "tasks.resume":
      return TaskSchema.parse(
        await api.resume(
          context,
          request.params.task_id,
          request.params.expected_revision,
        ),
      );
    case "tasks.steer":
      await api.steer(
        context,
        request.params.task_id,
        request.params.instruction,
      );
      return null;
    case "tasks.cancel":
      await api.cancel(context, request.params.task_id);
      return null;
    case "tasks.events":
      return eventPage(
        await api.events(
          context,
          request.params.task_id,
          request.params.after_event_id,
        ),
      );
    case "tasks.artifact":
      return ArtifactDataSchema.parse(
        await api.artifact(
          context,
          request.params.task_id,
          request.params.artifact,
        ),
      );
    case "tasks.diff":
      return DiffResultSchema.parse(
        await api.diff(context, request.params.task_id),
      );
    case "tasks.checkpoint":
      return CheckpointRefSchema.parse(
        await api.checkpoint(context, request.params.task_id),
      );
    case "tasks.verification":
      return VerificationViewSchema.parse(
        await api.verification(context, request.params.task_id),
      );
    case "tasks.restore":
      return WorkspaceRefSchema.parse(
        await api.restore(
          context,
          request.params.task_id,
          request.params.checkpoint_id,
          request.params.expected_revision,
        ),
      );
  }
}

function validateResult(request: RpcRequest, result: unknown, scope: Scope) {
  const invalid = () => {
    throw new WorkbenchError("internal_error");
  };
  if (request.method === "workbench.describe") {
    if (!sameScope(DescribeResultSchema.parse(result).scope, scope)) invalid();
  } else if (request.method === "tasks.list") {
    const seen = new Set<string>();
    for (const task of taskList.parse(result)) {
      if (!sameScope(task.scope, scope) || seen.has(task.task_id)) invalid();
      seen.add(task.task_id);
    }
  } else if (request.method === "tasks.events") {
    const seen = new Set<string>();
    for (const event of eventList.parse(result)) {
      if (
        !sameScope(event.scope, scope) ||
        event.task_id !== request.params.task_id ||
        event.event_id === request.params.after_event_id ||
        seen.has(event.event_id)
      )
        invalid();
      seen.add(event.event_id);
    }
  } else if (
    request.method === "tasks.create" ||
    request.method === "tasks.inspect" ||
    request.method === "tasks.start" ||
    request.method === "tasks.resume"
  ) {
    const task = TaskSchema.parse(result);
    const taskId =
      request.method === "tasks.create"
        ? request.params.task.task_id
        : request.params.task_id;
    if (
      !sameScope(task.scope, scope) ||
      task.task_id !== taskId ||
      (request.method === "tasks.create" &&
        task.session_id !== request.params.task.session_id)
    )
      invalid();
  }
}

export function serveWorkbench(options: WorkbenchServerOptions) {
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(options.token))
    throw new Error(
      "Workbench requires a random URL-safe token of at least 32 characters.",
    );
  const tokenHash = digest(`Bearer ${options.token}`);
  const scope = ScopeSchema.parse(options.api.scope);
  const port = options.port ?? 7331;
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    throw new Error("Invalid workbench port.");
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    maxRequestBodySize: MAX_REQUEST_BYTES,
    async fetch(request, server) {
      const url = new URL(request.url);
      if (
        !["127.0.0.1", "localhost"].includes(url.hostname) ||
        Number(url.port || 80) !== server.port ||
        request.headers.has("origin")
      )
        return responseError("forbidden");
      if (request.method !== "POST" || url.pathname !== "/v1/rpc" || url.search)
        return responseError("not_found");
      const auth = request.headers.get("authorization") ?? "";
      if (auth.length > 300 || !timingSafeEqual(digest(auth), tokenHash))
        return responseError("unauthorized");
      if (
        request.headers
          .get("content-type")
          ?.split(";", 1)[0]
          ?.trim()
          .toLowerCase() !== "application/json"
      )
        return responseError("invalid_request");
      try {
        const bytes = await request.arrayBuffer();
        if (bytes.byteLength > MAX_REQUEST_BYTES)
          return responseError("too_large");
        let raw: unknown;
        try {
          raw = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          );
        } catch {
          return responseError("invalid_request");
        }
        const parsed = RpcRequestSchema.safeParse(raw);
        if (!parsed.success) return responseError("invalid_request");
        if (parsed.data.method !== "workbench.describe") {
          if (!sameScope(parsed.data.context.scope, scope))
            return responseError("forbidden");
          if (parsed.data.method === "tasks.create") {
            const task = parsed.data.params.task;
            if (!sameScope(task.scope, scope))
              return responseError("forbidden");
            if (
              task.status !== "pending" ||
              task.revision !== 0 ||
              task.artifacts.length ||
              task.specialist_revision !== null
            )
              return responseError("invalid_request");
          }
        }
        const result = await dispatch(options.api, parsed.data);
        validateResult(parsed.data, result, scope);
        const body = JSON.stringify({ result });
        if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES)
          return responseError("too_large");
        return new Response(body, { headers });
      } catch (error) {
        return responseError(errorCode(error));
      }
    },
    error() {
      return responseError("internal_error");
    },
  });
}
