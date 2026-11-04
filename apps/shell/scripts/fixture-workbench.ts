import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ArtifactRef,
  EventEnvelope,
  RequestContext,
  Scope,
  Task,
  VerificationView,
} from "@mars/contracts";
import {
  serveWorkbench,
  WorkbenchError,
  type WorkbenchOperations,
} from "@mars/workbench";
import type {
  ArtifactData,
  DescribeResult,
  DiffResult,
  EvidenceResult,
  InspectResult,
} from "../src/shared/methods";

type FixtureDetail = {
  verification: VerificationView;
  diff?: DiffResult;
  evidence?: EvidenceResult;
  events: EventEnvelope[];
  model_tier?: InspectResult["model_tier"];
};

export type FixtureData = {
  describe: DescribeResult;
  tasks: Task[];
  details: Record<string, FixtureDetail>;
  artifact_data: Record<string, ArtifactData>;
};

export function createFixtureOperations(
  data: FixtureData,
): WorkbenchOperations {
  const operation = (taskId: string) => {
    const detail = data.details[taskId];
    if (!detail) throw new WorkbenchError("not_found");
    return detail;
  };
  const readOperations = {
    scope: data.describe.scope as Scope,
    async describe() {
      return data.describe;
    },
    async list(_context: RequestContext) {
      return data.tasks;
    },
    async inspect(_context: RequestContext, taskId: string) {
      const task = data.tasks.find((candidate) => candidate.task_id === taskId);
      if (!task) throw new WorkbenchError("not_found");
      const detail = operation(taskId);
      return {
        ...task,
        ...("model_tier" in detail ? { model_tier: detail.model_tier } : {}),
      };
    },
    async journal(
      _context: RequestContext,
      _taskId: string,
      entryIds: string[],
    ) {
      return entryIds.map((entry_id) => ({
        entry_id,
        kind: "user" as const,
        text: "Fixture journal entry.",
      }));
    },
    async events(
      _context: RequestContext,
      taskId: string,
      afterEventId?: string,
    ) {
      const events = operation(taskId).events;
      const cursorIndex =
        afterEventId === undefined
          ? -1
          : events.findIndex((event) => event.event_id === afterEventId);
      if (afterEventId !== undefined && cursorIndex < 0)
        throw new WorkbenchError("invalid_request");
      return events.slice(cursorIndex + 1, cursorIndex + 101);
    },
    async artifact(_context: RequestContext, taskId: string, ref: ArtifactRef) {
      const task = data.tasks.find((candidate) => candidate.task_id === taskId);
      const artifact = task?.artifacts.find(
        (candidate) => candidate.artifact_id === ref.artifact_id,
      );
      if (!artifact) throw new WorkbenchError("not_found");
      return (
        data.artifact_data[ref.artifact_id] ??
        (() => {
          throw new WorkbenchError("not_found");
        })()
      );
    },
    async diff(_context: RequestContext, taskId: string) {
      const diff = operation(taskId).diff;
      if (!diff) throw new WorkbenchError("not_found");
      return diff;
    },
    async evidence(_context: RequestContext, taskId: string) {
      const evidence = operation(taskId).evidence;
      if (!evidence) throw new WorkbenchError("not_found");
      return evidence;
    },
    async verification(_context: RequestContext, taskId: string) {
      return operation(taskId).verification;
    },
  };
  return new Proxy(readOperations, {
    get(target, property, receiver) {
      if (Object.hasOwn(target, property))
        return Reflect.get(target, property, receiver);
      return async () => {
        throw new WorkbenchError("forbidden");
      };
    },
  }) as WorkbenchOperations;
}

async function loadFixture(): Promise<FixtureData> {
  const path = fileURLToPath(
    new URL("../fixtures/workbench.json", import.meta.url),
  );
  return JSON.parse(await readFile(path, "utf8")) as FixtureData;
}

export async function runFixtureWorkbench(): Promise<string> {
  const stateIndex = process.argv.indexOf("--state");
  const stateArgument = process.argv[stateIndex + 1];
  if (stateIndex < 0 || !stateArgument) throw new Error("Pass --state DIR.");
  const stateDir = join(stateArgument);
  const portIndex = process.argv.indexOf("--port");
  const port = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 0;
  const data = await loadFixture();
  const token = randomBytes(32).toString("base64url");
  const server = serveWorkbench({
    api: createFixtureOperations(data),
    token,
    port,
  });
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await chmod(stateDir, 0o700);
  const connectionPath = join(stateDir, "connection.json");
  await writeFile(
    connectionPath,
    `${JSON.stringify({
      schema_version: 1,
      url: `http://127.0.0.1:${server.port}`,
      token,
      scope: {
        owner_id: data.describe.scope.owner_id,
        project_id: data.describe.scope.project_id,
      },
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await chmod(connectionPath, 0o600);
  console.log(`Workbench connection: ${connectionPath}`);
  return connectionPath;
}

if (import.meta.main) await runFixtureWorkbench();
