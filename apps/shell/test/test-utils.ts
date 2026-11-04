import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type {
  ArtifactRef,
  EventEnvelope,
  Task,
  VerificationView,
} from "@mars/contracts";
import type {
  ArtifactData,
  DescribeResult,
  DiffResult,
  EvidenceResult,
  ShellBridge,
} from "../src/shared/methods";
import { READ_METHODS } from "../src/shared/methods";

export type FixtureData = {
  describe: DescribeResult;
  tasks: Task[];
  details: Record<
    string,
    {
      verification: VerificationView;
      diff: DiffResult;
      evidence: EvidenceResult;
      events: EventEnvelope[];
    }
  >;
  artifact_data: Record<string, ArtifactData>;
};

export async function loadFixtureData(): Promise<FixtureData> {
  const path = fileURLToPath(
    new URL("../fixtures/workbench.json", import.meta.url),
  );
  return JSON.parse(await readFile(path, "utf8")) as FixtureData;
}

export type RecordedCall = { method: string; params: unknown };

export function fakeBridge(
  data: FixtureData,
  calls: RecordedCall[] = [],
): ShellBridge {
  const invoke = async (method: string, params: unknown) => {
    calls.push({ method, params });
    const request = params as {
      task_id?: string;
      after_event_id?: string;
      artifact?: ArtifactRef;
    };
    let result: unknown;
    switch (method) {
      case "workbench.describe":
        result = data.describe;
        break;
      case "tasks.list":
        result = data.tasks;
        break;
      case "tasks.inspect":
        result = data.tasks.find((task) => task.task_id === request.task_id);
        break;
      case "tasks.events":
        result = data.details[request.task_id ?? ""]?.events ?? [];
        break;
      case "tasks.artifact":
        result = request.artifact
          ? data.artifact_data[request.artifact.artifact_id]
          : undefined;
        break;
      case "tasks.diff":
        result = data.details[request.task_id ?? ""]?.diff;
        break;
      case "tasks.evidence":
        result = data.details[request.task_id ?? ""]?.evidence;
        break;
      case "tasks.verification":
        result = data.details[request.task_id ?? ""]?.verification;
        break;
      default:
        return {
          ok: false as const,
          error: {
            kind: "refused" as const,
            message: "Workbench request was refused.",
          },
        };
    }
    return { ok: true as const, result };
  };
  return Object.fromEntries(
    READ_METHODS.map((method) => [
      method,
      (params: unknown) => invoke(method, params),
    ]),
  ) as ShellBridge;
}
