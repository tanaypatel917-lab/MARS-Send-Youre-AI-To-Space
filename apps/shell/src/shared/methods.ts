import type { z } from "zod";
import type { ParamsSchema, ResultSchema } from "../main/protocol";

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

export const BRIDGE_CHANNEL = "mars-shell:rpc";
export const BRIDGE_GLOBAL = "marsWorkbench";

export type ParamsFor<M extends ReadMethod> = z.infer<(typeof ParamsSchema)[M]>;
export type ResultFor<M extends ReadMethod> = z.infer<(typeof ResultSchema)[M]>;

export type DescribeResult = ResultFor<"workbench.describe">;
export type DiffResult = ResultFor<"tasks.diff">;
export type EvidenceResult = ResultFor<"tasks.evidence">;
export type ArtifactData = ResultFor<"tasks.artifact">;
export type InspectResult = ResultFor<"tasks.inspect">;
export type JournalResult = ResultFor<"tasks.journal">;

export type BridgeErrorKind =
  | "not_connected"
  | "refused"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "timeout"
  | "unavailable"
  | "protocol"
  | "invalid_response"
  | "hash_mismatch";

export type BridgeResult<T> =
  | { ok: true; result: T }
  | { ok: false; error: { kind: BridgeErrorKind; message: string } };

export type ShellBridge = {
  readonly [M in ReadMethod]: (
    params: ParamsFor<M>,
  ) => Promise<BridgeResult<ResultFor<M>>>;
};
