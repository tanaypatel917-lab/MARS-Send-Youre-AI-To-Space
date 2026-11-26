import type { z } from "zod";
import type {
  ParamsSchema,
  RendererExportParamsSchema,
  ResultSchema,
} from "../main/protocol";

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

export const WRITE_METHODS = [
  "tasks.create",
  "tasks.start",
  "tasks.resume",
  "tasks.steer",
  "tasks.cancel",
  "tasks.export",
] as const;

export const BRIDGE_METHODS = [...READ_METHODS, ...WRITE_METHODS] as const;

export type ReadMethod = (typeof READ_METHODS)[number];
export type WriteMethod = (typeof WRITE_METHODS)[number];
export type BridgeMethod = (typeof BRIDGE_METHODS)[number];

const READ_METHOD_SET: ReadonlySet<string> = new Set(READ_METHODS);
const WRITE_METHOD_SET: ReadonlySet<string> = new Set(WRITE_METHODS);
const BRIDGE_METHOD_SET: ReadonlySet<string> = new Set(BRIDGE_METHODS);

export function isReadMethod(value: unknown): value is ReadMethod {
  return typeof value === "string" && READ_METHOD_SET.has(value);
}

export function isWriteMethod(value: unknown): value is WriteMethod {
  return typeof value === "string" && WRITE_METHOD_SET.has(value);
}

export function isBridgeMethod(value: unknown): value is BridgeMethod {
  return typeof value === "string" && BRIDGE_METHOD_SET.has(value);
}

export const BRIDGE_CHANNEL = "mars-shell:rpc";
export const BRIDGE_GLOBAL = "marsWorkbench";

export type ParamsFor<M extends BridgeMethod> = z.infer<
  M extends "tasks.export"
    ? typeof RendererExportParamsSchema
    : (typeof ParamsSchema)[M]
>;
export type ResultFor<M extends BridgeMethod> = z.infer<
  (typeof ResultSchema)[M]
>;

export type DescribeResult = ResultFor<"workbench.describe">;
export type DiffResult = ResultFor<"tasks.diff">;
export type EvidenceResult = ResultFor<"tasks.evidence">;
export type ArtifactData = ResultFor<"tasks.artifact">;
export type InspectResult = ResultFor<"tasks.inspect">;
export type JournalResult = ResultFor<"tasks.journal">;
export type PatchExportResult = ResultFor<"tasks.export">;

export type BridgeErrorKind =
  | "not_connected"
  | "refused"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "patch_round_trip_failed"
  | "too_large"
  | "timeout"
  | "unavailable"
  | "model_unavailable"
  | "protocol"
  | "invalid_response"
  | "hash_mismatch";

export type BridgeError = { kind: BridgeErrorKind; message: string };

export type BridgeResult<T> =
  | { ok: true; result: T }
  | { ok: false; error: BridgeError };

export const BRIDGE_ERROR_MESSAGES: Readonly<Record<BridgeErrorKind, string>> =
  Object.freeze({
    not_connected: "Not connected to a workbench.",
    refused: "Workbench request was refused.",
    unauthorized: "Workbench authentication failed.",
    forbidden: "Workbench request is not permitted.",
    not_found: "Workbench resource was not found.",
    conflict: "Workbench request conflicts with the current state.",
    patch_round_trip_failed:
      "The patch cannot be reconstructed from the task baseline. Review unsupported changes and run a new task with text-only changes.",
    too_large: "The workbench request or response exceeds the size limit.",
    timeout: "Workbench did not respond in time.",
    unavailable: "Workbench is unavailable.",
    model_unavailable:
      "No available model matches this task. Check model setup or choose another model.",
    protocol: "Workbench returned an invalid response.",
    invalid_response: "Workbench returned an invalid response.",
    hash_mismatch: "Workbench artifact failed integrity verification.",
  });

export function bridgeError(kind: BridgeErrorKind): BridgeError {
  return { kind, message: BRIDGE_ERROR_MESSAGES[kind] };
}

export function bridgeFailure(kind: BridgeErrorKind): {
  ok: false;
  error: BridgeError;
} {
  return { ok: false, error: bridgeError(kind) };
}

export type ShellBridge = {
  readonly [M in BridgeMethod]: (
    params: ParamsFor<M>,
  ) => Promise<BridgeResult<ResultFor<M>>>;
};
