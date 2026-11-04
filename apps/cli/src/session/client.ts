import { createHash, randomUUID } from "node:crypto";
import {
  type ArtifactRef,
  type EventEnvelope,
  EventEnvelopeSchema,
  type Task,
  TaskSchema,
  type VerificationView,
  VerificationViewSchema,
} from "@mars/contracts";
import {
  type DescribeExtras,
  DescribeExtrasSchema,
  type InspectExtras,
  InspectExtrasSchema,
  type JournalEntry,
  JournalReplySchema,
  LIMITS,
  readExtras,
} from "@mars/ui-core";
import {
  ArtifactDataSchema,
  type DescribeResult,
  DescribeResultSchema,
  type DiffResult,
  DiffResultSchema,
  type EvidenceResult,
  EvidenceResultSchema,
} from "@mars/workbench";
import { z } from "zod";
import type { LocalConnection } from "./connection";

/** The only methods this client may send (UI PR 1 is read-only). */
export const READ_METHODS = [
  "workbench.describe",
  "tasks.list",
  "tasks.inspect",
  "tasks.events",
  "tasks.artifact",
  "tasks.diff",
  "tasks.verification",
  "tasks.evidence",
  "tasks.journal",
] as const;
export type ReadMethod = (typeof READ_METHODS)[number];

export class SessionRpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface RpcBody {
  method: ReadMethod;
  context?: {
    schema_version: 1;
    scope: LocalConnection["scope"];
    request_id: string;
  };
  params: Record<string, unknown>;
}

/** Sends one request body and returns `result`, or throws `SessionRpcError`. */
export type SessionTransport = (body: RpcBody) => Promise<unknown>;

export function httpTransport(
  connection: LocalConnection,
  fetchImpl: typeof fetch = fetch,
): SessionTransport {
  return async (body) => {
    let response: Response;
    try {
      response = await fetchImpl(`${connection.url}/v1/rpc`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${connection.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new SessionRpcError("unreachable", "Workbench unreachable.");
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new SessionRpcError(
        "protocol",
        "Workbench answered with invalid JSON.",
        response.status,
      );
    }
    const reply = parsed as {
      result?: unknown;
      error?: { code?: unknown; message?: unknown };
    };
    if (reply?.error)
      throw new SessionRpcError(
        typeof reply.error.code === "string" ? reply.error.code : "protocol",
        typeof reply.error.message === "string"
          ? reply.error.message
          : "Workbench error.",
        response.status,
      );
    if (!response.ok || !("result" in (reply ?? {})))
      throw new SessionRpcError(
        response.status === 401 ? "unauthorized" : "protocol",
        `HTTP ${response.status}`,
        response.status,
      );
    return reply.result;
  };
}

function validate<T extends z.ZodTypeAny>(
  schema: T,
  value: unknown,
  what: string,
): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new SessionRpcError(
      "protocol",
      `Workbench returned an invalid ${what}.`,
    );
  return parsed.data;
}

/** Strict frozen schema over the known keys only, so §8.3 additive fields never fail validation. */
function knownKeys(schema: z.ZodTypeAny, value: unknown): unknown {
  const shape = schema instanceof z.ZodObject ? schema.shape : null;
  if (!shape || !value || typeof value !== "object" || Array.isArray(value))
    return value;
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => key in shape),
  );
}

export interface Described {
  result: DescribeResult;
  extras: Partial<DescribeExtras>;
}
export interface Inspected {
  task: Task;
  extras: Partial<InspectExtras>;
}
export type JournalResult =
  | { available: true; entries: JournalEntry[] }
  | { available: false };

const sameScope = (
  a: { owner_id: string; project_id: string },
  b: { owner_id: string; project_id: string },
) => a.owner_id === b.owner_id && a.project_id === b.project_id;

/** Read-only workbench client. Every reply is validated; nothing here can mutate a task. */
export class SessionClient {
  private scope: LocalConnection["scope"] | null = null;
  constructor(
    private readonly transport: SessionTransport,
    private readonly newId: () => string = randomUUID,
  ) {}

  private send(
    method: ReadMethod,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (!(READ_METHODS as readonly string[]).includes(method))
      throw new SessionRpcError(
        "invalid_request",
        `${method} is not a read method.`,
      );
    if (method === "workbench.describe")
      return this.transport({ method, params });
    if (!this.scope) throw new SessionRpcError("unreachable", "Not connected.");
    return this.transport({
      method,
      context: {
        schema_version: 1,
        scope: this.scope,
        request_id: this.newId(),
      },
      params,
    });
  }

  async describe(): Promise<Described> {
    const raw = await this.send("workbench.describe", {});
    const result = validate(
      DescribeResultSchema,
      knownKeys(DescribeResultSchema, raw),
      "server description",
    );
    this.scope = result.scope;
    return { result, extras: readExtras(DescribeExtrasSchema, raw) };
  }

  private task(value: unknown, taskId?: string): Task {
    const task = validate(TaskSchema, knownKeys(TaskSchema, value), "task");
    if (
      !this.scope ||
      !sameScope(task.scope, this.scope) ||
      (taskId && task.task_id !== taskId)
    )
      throw new SessionRpcError(
        "protocol",
        "Workbench returned a task outside this scope.",
      );
    return task;
  }

  async list(): Promise<Task[]> {
    const raw = validate(
      z.array(z.unknown()).max(10_000),
      await this.send("tasks.list", {}),
      "task list",
    );
    return raw.map((task) => this.task(task));
  }

  async inspect(taskId: string): Promise<Inspected> {
    const raw = await this.send("tasks.inspect", { task_id: taskId });
    return {
      task: this.task(raw, taskId),
      extras: readExtras(InspectExtrasSchema, raw),
    };
  }

  async events(
    taskId: string,
    afterEventId?: string,
  ): Promise<EventEnvelope[]> {
    const params: Record<string, unknown> = { task_id: taskId };
    if (afterEventId) params.after_event_id = afterEventId;
    const events = validate(
      z.array(EventEnvelopeSchema).max(10_000),
      await this.send("tasks.events", params),
      "event batch",
    );
    const ids = new Set<string>();
    for (const event of events) {
      if (
        event.task_id !== taskId ||
        !this.scope ||
        !sameScope(event.scope, this.scope) ||
        event.event_id === afterEventId ||
        ids.has(event.event_id)
      )
        throw new SessionRpcError(
          "protocol",
          "Workbench returned an invalid event batch.",
        );
      ids.add(event.event_id);
    }
    return events;
  }

  /** Fetches an artifact and checks its bytes against the immutable ref. */
  async artifact(taskId: string, ref: ArtifactRef): Promise<Uint8Array> {
    const data = validate(
      ArtifactDataSchema,
      await this.send("tasks.artifact", { task_id: taskId, artifact: ref }),
      "artifact",
    );
    const bytes = Buffer.from(data.data_base64, "base64");
    if (
      bytes.byteLength !== ref.byte_length ||
      createHash("sha256").update(bytes).digest("hex") !== ref.sha256
    )
      throw new SessionRpcError(
        "protocol",
        "Artifact bytes do not match their reference.",
      );
    return new Uint8Array(bytes);
  }

  async json(taskId: string, ref: ArtifactRef): Promise<unknown> {
    if (ref.byte_length > LIMITS.artifactPreviewBytes) return undefined;
    return JSON.parse(
      new TextDecoder().decode(await this.artifact(taskId, ref)),
    );
  }

  async diff(taskId: string): Promise<DiffResult> {
    return validate(
      DiffResultSchema,
      await this.send("tasks.diff", { task_id: taskId }),
      "diff",
    );
  }

  async verification(taskId: string): Promise<VerificationView> {
    return validate(
      VerificationViewSchema,
      await this.send("tasks.verification", { task_id: taskId }),
      "verification",
    );
  }

  async evidence(taskId: string): Promise<EvidenceResult> {
    return validate(
      EvidenceResultSchema,
      await this.send("tasks.evidence", { task_id: taskId }),
      "evidence",
    );
  }

  /** §8.3 `tasks.journal`; a host without it answers `invalid_request`, which degrades to turn markers. */
  async journal(taskId: string, entryIds: string[]): Promise<JournalResult> {
    try {
      const raw = await this.send("tasks.journal", {
        task_id: taskId,
        entry_ids: entryIds,
      });
      return {
        available: true,
        entries: validate(JournalReplySchema, raw, "journal"),
      };
    } catch (error) {
      if (
        error instanceof SessionRpcError &&
        (error.code === "invalid_request" ||
          error.code === "method_not_found" ||
          error.code === "not_implemented" ||
          error.status === 404)
      )
        return { available: false };
      throw error;
    }
  }
}
