import type {
  ArtifactRef,
  EventEnvelope,
  Task,
  VerificationView,
} from "@mars/contracts";

export const READ_METHODS = [
  "workbench.describe",
  "tasks.list",
  "tasks.inspect",
  "tasks.events",
  "tasks.artifact",
  "tasks.diff",
  "tasks.verification",
  "tasks.evidence",
] as const;

export type ReadMethod = (typeof READ_METHODS)[number];

export const BRIDGE_CHANNEL = "mars-shell:rpc";
export const BRIDGE_GLOBAL = "marsWorkbench";

export type DescribeResult = {
  scope: { owner_id: string; project_id: string; workspace_id?: string };
  workspaceLabel: string;
  capabilities: { execute: boolean; checkpoint: boolean };
};

export type DiffResult = {
  files: {
    path: string;
    status: "added" | "modified" | "deleted";
    patch: string;
  }[];
  digest?: string;
};

export type EvidenceResult = {
  task_revision: number;
  workspace: { workspace_id: string; provider: string; revision: string };
  diff_sha256: string;
  verify_records: {
    event_id: string;
    verdict: "pass" | "fail" | "inconclusive" | "error";
    assurance:
      | "none"
      | "visual_advisory"
      | "deterministic_local"
      | "isolated_local"
      | "remote_attested";
    verified: boolean;
    contract_id?: string;
    contract_digest?: string;
    recorded_at: string;
    workspace_id: string | null;
    workspace_revision: string | null;
    diff_sha256: string | null;
    stale: boolean;
  }[];
};

export type ArtifactData = { data_base64: string; media_type: string };

export type ParamsFor<M extends ReadMethod> = M extends
  | "workbench.describe"
  | "tasks.list"
  ? Record<string, never>
  : M extends "tasks.events"
    ? { task_id: string; after_event_id?: string }
    : M extends "tasks.artifact"
      ? { task_id: string; artifact: ArtifactRef }
      : { task_id: string };

export type ResultFor<M extends ReadMethod> = M extends "workbench.describe"
  ? DescribeResult
  : M extends "tasks.list"
    ? Task[]
    : M extends "tasks.inspect"
      ? Task
      : M extends "tasks.events"
        ? EventEnvelope[]
        : M extends "tasks.artifact"
          ? ArtifactData
          : M extends "tasks.diff"
            ? DiffResult
            : M extends "tasks.verification"
              ? VerificationView
              : EvidenceResult;

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
  | "hash_mismatch";

export type BridgeResult<T> =
  | { ok: true; result: T }
  | { ok: false; error: { kind: BridgeErrorKind; message: string } };

export type ShellBridge = {
  readonly [M in ReadMethod]: (
    params: ParamsFor<M>,
  ) => Promise<BridgeResult<ResultFor<M>>>;
};
