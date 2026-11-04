import { createHash, randomUUID } from "node:crypto";
import type { ArtifactRef, EventEnvelope, Scope, Task } from "@mars/contracts";
import type {
  ArtifactData,
  BridgeErrorKind,
  BridgeResult,
  ReadMethod,
} from "../shared/methods";
import { READ_METHODS } from "../shared/methods";
import { ParamsSchema, ResultSchema } from "./protocol";
import {
  type RpcTransport,
  TransportError,
  type TransportRequest,
} from "./transport";

type BridgeError = { kind: BridgeErrorKind; message: string };

const ERROR_MESSAGES: Record<BridgeErrorKind, string> = {
  not_connected: "Not connected to a workbench.",
  refused: "Workbench request was refused.",
  unauthorized: "Workbench authentication failed.",
  forbidden: "Workbench request is not permitted.",
  not_found: "Workbench resource was not found.",
  conflict: "Workbench request conflicts with the current state.",
  timeout: "Workbench did not respond in time.",
  unavailable: "Workbench is unavailable.",
  protocol: "Workbench returned an invalid response.",
  hash_mismatch: "Workbench artifact failed integrity verification.",
};

function failure<T>(
  kind: BridgeErrorKind,
  message = ERROR_MESSAGES[kind],
): BridgeResult<T> {
  return { ok: false, error: { kind, message } };
}

function success<T>(result: T): BridgeResult<T> {
  return { ok: true, result };
}

function sameScope(a: Scope, b: Scope): boolean {
  return (
    a.owner_id === b.owner_id &&
    a.project_id === b.project_id &&
    a.workspace_id === b.workspace_id
  );
}

function sameConnectionScope(
  scope: Scope,
  connection: { owner_id: string; project_id: string },
): boolean {
  return (
    scope.owner_id === connection.owner_id &&
    scope.project_id === connection.project_id
  );
}

function scopeForTask(task: Task, scope: Scope): boolean {
  return sameScope(task.scope, scope);
}

function isReadMethod(value: unknown): value is ReadMethod {
  if (typeof value !== "string") return false;
  const lookup = Object.fromEntries(
    READ_METHODS.map((method) => [method, true]),
  );
  return Object.hasOwn(lookup, value);
}

export type BridgeOptions = {
  transport?: RpcTransport;
  connectionError?: BridgeError;
  connectionScope?: { owner_id: string; project_id: string };
  requestId?: () => string;
};

export type Bridge = {
  call(method: unknown, params: unknown): Promise<BridgeResult<unknown>>;
};

export function createBridge(options: BridgeOptions): Bridge {
  let describedScope: Scope | undefined;
  const nextRequestId = options.requestId ?? randomUUID;

  const describe = async (): Promise<
    | { ok: true; scope: Scope; result: unknown }
    | { ok: false; error: BridgeError }
  > => {
    if (!options.transport || !options.connectionScope)
      return {
        ok: false,
        error: options.connectionError ?? {
          kind: "not_connected",
          message: ERROR_MESSAGES.not_connected,
        },
      };
    try {
      const raw = await options.transport.send({
        method: "workbench.describe",
        params: {},
      });
      const parsed = ResultSchema["workbench.describe"].safeParse(raw);
      if (!parsed.success)
        return {
          ok: false,
          error: { kind: "protocol", message: ERROR_MESSAGES.protocol },
        };
      if (!sameConnectionScope(parsed.data.scope, options.connectionScope))
        return {
          ok: false,
          error: { kind: "refused", message: ERROR_MESSAGES.refused },
        };
      describedScope = parsed.data.scope;
      return { ok: true, scope: parsed.data.scope, result: parsed.data };
    } catch (error) {
      return { ok: false, error: mapError(error) };
    }
  };

  return {
    async call(method, params) {
      if (!isReadMethod(method)) return failure("refused");
      if (!options.transport || !options.connectionScope)
        return failure(
          options.connectionError?.kind ?? "not_connected",
          options.connectionError?.message ?? ERROR_MESSAGES.not_connected,
        );
      const parsedParams = ParamsSchema[method].safeParse(params);
      if (!parsedParams.success) return failure("protocol");

      if (method === "workbench.describe") {
        const result = await describe();
        return result.ok
          ? success(result.result)
          : { ok: false, error: result.error };
      }

      if (!describedScope) {
        const initial = await describe();
        if (!initial.ok) return { ok: false, error: initial.error };
      }
      const scope = describedScope;
      if (!scope) return failure("protocol");
      const request = {
        method,
        params: parsedParams.data,
        context: {
          schema_version: 1 as const,
          scope,
          request_id: `shell-${nextRequestId()}`,
        },
      } as unknown as TransportRequest;
      try {
        const raw = await options.transport.send(request);
        const parsedResult = ResultSchema[method].safeParse(raw);
        if (!parsedResult.success) return failure("protocol");
        const result: unknown = parsedResult.data;
        const requestParams = parsedParams.data as Record<string, unknown>;
        if (method === "tasks.list") {
          const ids = new Set<string>();
          for (const task of result as Task[]) {
            if (!scopeForTask(task, scope) || ids.has(task.task_id))
              return failure("protocol");
            ids.add(task.task_id);
          }
        } else if (method === "tasks.inspect") {
          const task = result as Task;
          if (
            task.task_id !== requestParams.task_id ||
            !scopeForTask(task, scope)
          )
            return failure("protocol");
        } else if (method === "tasks.events") {
          const ids = new Set<string>();
          for (const event of result as EventEnvelope[]) {
            if (
              event.task_id !== requestParams.task_id ||
              !sameScope(event.scope, scope) ||
              event.event_id === requestParams.after_event_id ||
              ids.has(event.event_id)
            )
              return failure("protocol");
            ids.add(event.event_id);
          }
        } else if (method === "tasks.artifact") {
          const ref = requestParams.artifact as ArtifactRef;
          const artifact = result as ArtifactData;
          const bytes = Buffer.from(artifact.data_base64, "base64");
          const canonical =
            bytes.toString("base64").replace(/=+$/, "") ===
            artifact.data_base64.replace(/=+$/, "");
          const digest = createHash("sha256").update(bytes).digest("hex");
          if (
            !canonical ||
            bytes.byteLength !== ref.byte_length ||
            digest !== ref.sha256 ||
            artifact.media_type !== ref.media_type
          )
            return failure("hash_mismatch");
        }
        return success(result);
      } catch (error) {
        return { ok: false, error: mapError(error) };
      }
    },
  };
}

function mapError(error: unknown): BridgeError {
  if (error instanceof TransportError)
    return { kind: error.kind, message: ERROR_MESSAGES[error.kind] };
  return { kind: "unavailable", message: ERROR_MESSAGES.unavailable };
}
