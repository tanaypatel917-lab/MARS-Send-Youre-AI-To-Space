import { createHash, randomUUID } from "node:crypto";
import type {
  ArtifactRef,
  EventEnvelope,
  PatchExport,
  Scope,
  Task,
} from "@mars/contracts";
import {
  type ArtifactData,
  type BridgeError,
  type BridgeResult,
  bridgeError,
  bridgeFailure,
  isBridgeMethod,
  type JournalResult,
} from "../shared/methods";
import { ParamsSchema, ResultSchema } from "./protocol";
import {
  type RpcTransport,
  TransportError,
  type TransportRequest,
} from "./transport";

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
        error: options.connectionError ?? bridgeError("not_connected"),
      };
    try {
      const raw = await options.transport.send({
        method: "workbench.describe",
        params: {},
      });
      const parsed = ResultSchema["workbench.describe"].safeParse(raw);
      if (!parsed.success) return bridgeFailure("protocol");
      if (!sameConnectionScope(parsed.data.scope, options.connectionScope))
        return bridgeFailure("refused");
      describedScope = parsed.data.scope;
      return { ok: true, scope: parsed.data.scope, result: parsed.data };
    } catch (error) {
      return { ok: false, error: mapError(error) };
    }
  };

  return {
    async call(method, params) {
      if (!isBridgeMethod(method)) return bridgeFailure("refused");
      if (!options.transport || !options.connectionScope)
        return {
          ok: false,
          error: options.connectionError ?? bridgeError("not_connected"),
        };
      const parsedParams = ParamsSchema[method].safeParse(params);
      if (!parsedParams.success) return bridgeFailure("protocol");

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
      if (!scope) return bridgeFailure("protocol");
      if (method === "tasks.create") {
        const createdInput = (parsedParams.data as { task: Task }).task;
        if (!scopeForTask(createdInput, scope)) return bridgeFailure("refused");
      }
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
        if (!parsedResult.success) return bridgeFailure("protocol");
        const result: unknown = parsedResult.data;
        const requestParams = parsedParams.data as Record<string, unknown>;
        if (method === "tasks.list") {
          const ids = new Set<string>();
          for (const task of result as Task[]) {
            if (!scopeForTask(task, scope) || ids.has(task.task_id))
              return bridgeFailure("protocol");
            ids.add(task.task_id);
          }
        } else if (
          method === "tasks.inspect" ||
          method === "tasks.start" ||
          method === "tasks.resume"
        ) {
          const task = result as Task;
          if (
            task.task_id !== requestParams.task_id ||
            !scopeForTask(task, scope)
          )
            return bridgeFailure("protocol");
        } else if (method === "tasks.create") {
          const task = result as Task;
          const requested = requestParams.task as Task;
          if (
            task.task_id !== requested.task_id ||
            task.session_id !== requested.session_id ||
            !scopeForTask(task, scope)
          )
            return bridgeFailure("protocol");
        } else if (method === "tasks.export") {
          const exported = result as PatchExport;
          if (
            exported.patch_sha256 !== requestParams.expected_patch_sha256 ||
            exported.artifact.sha256 !== requestParams.expected_patch_sha256
          )
            return bridgeFailure("hash_mismatch");
        } else if (method === "tasks.events") {
          const ids = new Set<string>();
          for (const event of result as EventEnvelope[]) {
            if (
              event.task_id !== requestParams.task_id ||
              !sameScope(event.scope, scope) ||
              event.event_id === requestParams.after_event_id ||
              ids.has(event.event_id)
            )
              return bridgeFailure("protocol");
            ids.add(event.event_id);
          }
        } else if (method === "tasks.journal") {
          const requestedIds = new Set(requestParams.entry_ids as string[]);
          for (const entry of result as JournalResult) {
            if (!requestedIds.has(entry.entry_id))
              return bridgeFailure("invalid_response");
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
            return bridgeFailure("hash_mismatch");
        }
        return success(result);
      } catch (error) {
        return { ok: false, error: mapError(error) };
      }
    },
  };
}

function mapError(error: unknown): BridgeError {
  return bridgeError(
    error instanceof TransportError ? error.kind : "unavailable",
  );
}
