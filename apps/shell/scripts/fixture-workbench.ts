import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ArtifactRef,
  EventEnvelope,
  PatchExport,
  RequestContext,
  Scope,
  Task,
  VerificationView,
} from "@mars/contracts";
import {
  type CreateOptions,
  type ExportParams,
  type StartParams,
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

function canonicalPatchBytes(diff: DiffResult): Buffer {
  const joined = diff.files
    .map((file) => (file.patch.endsWith("\n") ? file.patch : `${file.patch}\n`))
    .join("");
  return Buffer.from(joined, "utf8");
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function createFixtureOperations(
  input: FixtureData,
): WorkbenchOperations {
  const data = structuredClone(input);
  let nextEventNumber = 1;
  const launchKeys = new Map<string, string>();

  const makeEvent = (
    task: Task,
    eventType: EventEnvelope["event_type"],
    payloadObj: Record<string, unknown>,
  ): EventEnvelope => {
    const seq = nextEventNumber++;
    const id = `fixture-event-${task.task_id}-${seq}`;
    const bytes = Buffer.from(JSON.stringify(payloadObj), "utf8");
    const artifactId = `event-payload-${id}`;
    const sha256 = sha256Hex(bytes);
    data.artifact_data[artifactId] = {
      media_type: "application/json",
      data_base64: bytes.toString("base64"),
    };
    const occurredAt = new Date(
      Date.UTC(2026, 2, 1, 12, 10, seq),
    ).toISOString();
    return {
      schema_version: 1,
      event_id: id,
      scope: task.scope,
      session_id: task.session_id,
      task_id: task.task_id,
      occurred_at: occurredAt,
      event_type: eventType,
      parent_event_id: null,
      run_id: `fixture-run-${task.task_id}`,
      producer: "fixture",
      versions: [{ component: "fixture", revision: "1" }],
      payload: {
        artifact_id: artifactId,
        sha256,
        media_type: "application/json",
        byte_length: bytes.byteLength,
      },
      source_event_ids: [],
      access: "project",
    };
  };

  const operation = (taskId: string) => {
    const detail = data.details[taskId];
    if (!detail) throw new WorkbenchError("not_found");
    return detail;
  };

  const findTask = (taskId: string) => {
    const index = data.tasks.findIndex(
      (candidate) => candidate.task_id === taskId,
    );
    if (index < 0) throw new WorkbenchError("not_found");
    return { index, task: data.tasks[index] as Task };
  };

  const operations = {
    scope: data.describe.scope as Scope,
    async describe() {
      return data.describe;
    },
    async list(_context: RequestContext) {
      return data.tasks;
    },
    async inspect(_context: RequestContext, taskId: string) {
      const { task } = findTask(taskId);
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
      const { task } = findTask(taskId);
      const inTask = task.artifacts.some(
        (candidate) => candidate.artifact_id === ref.artifact_id,
      );
      const inEvents = operation(taskId).events.some(
        (event) => event.payload.artifact_id === ref.artifact_id,
      );
      if (!inTask && !inEvents) throw new WorkbenchError("not_found");
      const artifact = data.artifact_data[ref.artifact_id];
      if (!artifact) throw new WorkbenchError("not_found");
      return artifact;
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
    async create(
      _context: RequestContext,
      task: Task,
      options?: CreateOptions,
    ) {
      if (options?.launch_key) {
        const existingId = launchKeys.get(options.launch_key);
        if (existingId) {
          const { task: existing } = findTask(existingId);
          return existing;
        }
      }
      if (data.tasks.some((candidate) => candidate.task_id === task.task_id))
        throw new WorkbenchError("conflict");
      const created: Task = structuredClone(task);
      data.tasks.unshift(created);
      const workspaceId =
        created.scope.workspace_id ??
        data.describe.scope.workspace_id ??
        "fixture-workspace";
      const emptyDigest = sha256Hex(Buffer.alloc(0));
      data.details[created.task_id] = {
        verification: {
          candidate: {
            workspace_id: workspaceId,
            provider: "fixture",
            revision: `fixture-r${created.revision}`,
          },
          state: "unverified",
          record: null,
          reasons: [],
          records: [],
        },
        diff: {
          files: [],
          digest: emptyDigest,
        },
        evidence: {
          task_revision: created.revision,
          workspace: {
            workspace_id: workspaceId,
            provider: "fixture",
            revision: `fixture-r${created.revision}`,
          },
          diff_sha256: emptyDigest,
          verify_records: [],
        },
        events: [
          makeEvent(created, "task.created", {
            request: created.request,
            acceptance_criteria: created.acceptance_criteria,
          }),
        ],
      };
      if (options?.launch_key)
        launchKeys.set(options.launch_key, created.task_id);
      return created;
    },
    async start(_context: RequestContext, params: StartParams) {
      const { index, task } = findTask(params.task_id);
      if (
        task.status !== "pending" ||
        task.revision !== params.expected_revision
      )
        throw new WorkbenchError("conflict");
      if (params.approvals.execute && !data.describe.capabilities.execute)
        throw new WorkbenchError("forbidden");
      const updated: Task = {
        ...task,
        status: "running",
        revision: task.revision + 1,
      };
      data.tasks[index] = updated;
      const detail = operation(task.task_id);
      detail.events.push(
        makeEvent(updated, "task.updated", {
          action: "started",
          status: updated.status,
          approvals: params.approvals,
          ...(params.model_id ? { model_id: params.model_id } : {}),
        }),
      );
      return updated;
    },
    async resume(
      _context: RequestContext,
      taskId: string,
      expectedRevision: number,
    ) {
      const { index, task } = findTask(taskId);
      if (task.status !== "paused" || task.revision !== expectedRevision)
        throw new WorkbenchError("conflict");
      const updated: Task = {
        ...task,
        status: "running",
        revision: task.revision + 1,
      };
      data.tasks[index] = updated;
      operation(taskId).events.push(
        makeEvent(updated, "task.updated", {
          action: "resumed",
          status: updated.status,
          revision: updated.revision,
        }),
      );
      return updated;
    },
    async steer(_context: RequestContext, taskId: string, instruction: string) {
      const { index, task } = findTask(taskId);
      if (task.status !== "running") throw new WorkbenchError("conflict");
      const updated: Task = {
        ...task,
        revision: task.revision + 1,
      };
      data.tasks[index] = updated;
      operation(taskId).events.push(
        makeEvent(updated, "task.updated", {
          action: "steered",
          instruction,
        }),
      );
    },
    async cancel(_context: RequestContext, taskId: string) {
      const { index, task } = findTask(taskId);
      if (
        task.status !== "running" &&
        task.status !== "paused" &&
        task.status !== "pending"
      )
        throw new WorkbenchError("conflict");
      const updated: Task = {
        ...task,
        status: "cancelled",
        revision: task.revision + 1,
      };
      data.tasks[index] = updated;
      operation(taskId).events.push(
        makeEvent(updated, "task.updated", {
          action: "cancelled",
          status: updated.status,
          reason: "user_cancelled",
        }),
      );
    },
    async export(
      _context: RequestContext,
      params: ExportParams,
    ): Promise<PatchExport> {
      const { index, task } = findTask(params.task_id);
      const detail = operation(params.task_id);
      if (!detail.diff) throw new WorkbenchError("not_found");
      const candidate =
        detail.verification.candidate ?? detail.evidence?.workspace ?? null;
      if (!candidate || candidate.revision !== params.expected_revision)
        throw new WorkbenchError("conflict");
      const bytes = canonicalPatchBytes(detail.diff);
      const computedSha = sha256Hex(bytes);
      if (params.expected_patch_sha256 !== computedSha)
        throw new WorkbenchError("conflict");
      const patchSha = computedSha;
      const artifactId = `export-patch-${task.task_id}-${candidate.revision}`;
      const artifactRef: ArtifactRef = {
        artifact_id: artifactId,
        sha256: patchSha,
        media_type: "text/x-diff",
        byte_length: bytes.byteLength,
      };
      data.artifact_data[artifactId] = {
        media_type: "text/x-diff",
        data_base64: bytes.toString("base64"),
      };
      if (!task.artifacts.some((a) => a.artifact_id === artifactId)) {
        data.tasks[index] = {
          ...task,
          artifacts: [...task.artifacts, artifactRef],
        };
      }
      const verified = detail.verification.state === "verified";
      return {
        candidate,
        patch_sha256: patchSha,
        artifact: artifactRef,
        files: detail.diff.files.length,
        verification: detail.verification.state,
        verified,
        verdict_run_id: detail.verification.record?.run_id ?? null,
        round_trip: {
          status: detail.diff.files.length > 0 ? "passed" : "unavailable",
          reason:
            detail.diff.files.length > 0 ? null : "No changed files in patch.",
        },
        unsupported: [],
      };
    },
  };

  return new Proxy(operations, {
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
