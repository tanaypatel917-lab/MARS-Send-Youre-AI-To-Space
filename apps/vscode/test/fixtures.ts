import { createHash } from "node:crypto";
import type {
  ArtifactRef,
  CheckpointRef,
  EventEnvelope,
  RequestContext,
  Scope,
  Task,
  WorkspaceRef,
} from "@mars/contracts";
import { MarsClient } from "../src/client";
import type { ConnectResult, WorkbenchUi } from "../src/controller";
import type { OpenOutcome } from "../src/diffOpener";
import type { ViewState } from "../src/messages";
import type { DescribeResult } from "../src/protocol";
import { RpcError, type RpcRequest, type RpcTransport } from "../src/rpc";

export const scope: Scope = {
  owner_id: "owner-1",
  project_id: "project-1",
  workspace_id: "ws-1",
};

export const describeResult: DescribeResult = {
  scope,
  workspaceLabel: "demo",
  capabilities: { execute: false, checkpoint: true },
};

export const budget = {
  max_tokens: 1000,
  max_usd: 0,
  max_duration_ms: 60_000,
  max_depth: 0,
  max_concurrency: 1,
};

export function artifactFor(
  text: string,
  id = "artifact-1",
  mediaType = "text/plain",
): {
  ref: ArtifactRef;
  data_base64: string;
} {
  const bytes = Buffer.from(text, "utf8");
  return {
    ref: {
      artifact_id: id,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      media_type: mediaType,
      byte_length: bytes.byteLength,
    },
    data_base64: bytes.toString("base64"),
  };
}

export function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    schema_version: 1,
    task_id: "task-1",
    session_id: "session-1",
    scope,
    revision: 0,
    request: "Fix the failing test",
    acceptance_criteria: ["bun test passes"],
    budget,
    status: "pending",
    specialist_revision: null,
    artifacts: [],
    ...overrides,
  };
}

export function makeEvent(
  id: string,
  overrides: Partial<EventEnvelope> = {},
): EventEnvelope {
  return {
    schema_version: 1,
    event_id: id,
    scope,
    session_id: "session-1",
    task_id: "task-1",
    occurred_at: "2026-11-01T12:00:00Z",
    event_type: "execution.observed",
    parent_event_id: null,
    run_id: "run-1",
    producer: "execution",
    versions: [{ component: "oh-my-pi", revision: "18.14.0" }],
    payload: artifactFor(`payload ${id}`, `a-${id}`).ref,
    source_event_ids: [],
    access: "private",
    ...overrides,
  };
}

export const workspace: WorkspaceRef = {
  workspace_id: "ws-1",
  provider: "git-worktree",
  revision: "rev-2",
};

export const checkpointArtifact = artifactFor("checkpoint", "cp-artifact");
export const checkpoint: CheckpointRef = {
  checkpoint_id: "cp-1",
  workspace: { ...workspace, revision: "rev-1" },
  artifact: checkpointArtifact.ref,
};

export type Handler = (
  params: Record<string, unknown>,
  context?: RequestContext,
) => unknown;

/** In-memory stand-in for the MARS RPC server; records every call. */
export class FakeServer implements RpcTransport {
  readonly calls: RpcRequest[] = [];
  readonly handlers = new Map<string, Handler>();
  tasks = new Map<string, Task>();
  events: EventEnvelope[] = [];
  artifacts = new Map<string, string>();

  constructor() {
    this.on("workbench.describe", () => describeResult);
    this.on("tasks.list", () => [...this.tasks.values()]);
    this.on("tasks.inspect", (p) => this.task(p.task_id));
    this.on("tasks.create", (p) => {
      const task = p.task as Task;
      this.tasks.set(task.task_id, task);
      return task;
    });
    this.on("tasks.start", (p) => this.bump(p, "running"));
    this.on("tasks.resume", (p) => this.bump(p, "running"));
    this.on("tasks.steer", () => null);
    this.on("tasks.cancel", (p) => {
      const task = this.task(p.task_id);
      this.tasks.set(task.task_id, {
        ...task,
        status: "cancelled",
        revision: task.revision + 1,
      });
      return null;
    });
    this.on("tasks.events", (p) => {
      const after = p.after_event_id as string | undefined;
      const mine = this.events.filter((event) => event.task_id === p.task_id);
      const index = after
        ? mine.findIndex((event) => event.event_id === after)
        : -1;
      return mine.slice(index + 1, index + 3);
    });
    this.on("tasks.artifact", (p) => {
      const ref = p.artifact as ArtifactRef;
      const data = this.artifacts.get(ref.artifact_id);
      if (data === undefined) throw new RpcError("not-found", "no artifact");
      return { data_base64: data, media_type: ref.media_type };
    });
    this.on("tasks.diff", () => ({ files: [] }));
    this.on("tasks.checkpoint", () => checkpoint);
    this.on("tasks.restore", () => ({ ...workspace, revision: "rev-1" }));
  }

  on(method: string, handler: Handler): void {
    this.handlers.set(method, handler);
  }

  task(id: unknown): Task {
    const task = this.tasks.get(String(id));
    if (!task) throw new RpcError("not-found", "no such task");
    return task;
  }

  private bump(p: Record<string, unknown>, status: Task["status"]): Task {
    const task = this.task(p.task_id);
    if (p.expected_revision !== task.revision)
      throw new RpcError(
        "conflict",
        "revision mismatch",
        "revision_conflict",
        409,
      );
    const next = { ...task, status, revision: task.revision + 1 };
    this.tasks.set(task.task_id, next);
    return next;
  }

  methods(): string[] {
    return this.calls.map((call) => call.method);
  }

  async send(request: RpcRequest, signal?: AbortSignal): Promise<unknown> {
    this.calls.push(structuredClone(request));
    if (signal?.aborted) throw new RpcError("cancelled", "cancelled");
    const handler = this.handlers.get(request.method);
    if (!handler)
      throw new RpcError("protocol", `no handler ${request.method}`);
    return structuredClone(handler(request.params, request.context));
  }
}

export interface Harness {
  server: FakeServer;
  states: ViewState[];
  confirms: Array<{ message: string; detail: string; action: string }>;
  answer: { value: boolean };
  opened: string[];
  ui: WorkbenchUi;
  connect: () => Promise<ConnectResult>;
  last(): ViewState;
}

export function harness(server = new FakeServer()): Harness {
  const states: ViewState[] = [];
  const confirms: Harness["confirms"] = [];
  const answer = { value: true };
  const opened: string[] = [];
  let id = 0;
  const ui: WorkbenchUi = {
    confirm: async (message, detail, action) => {
      confirms.push({ message, detail, action });
      return answer.value;
    },
    promptToken: async () => {},
    openDiff: async (_server, file): Promise<OpenOutcome> => {
      opened.push(file.path);
      return { mode: "diff" };
    },
    openArtifact: async (artifact) => {
      opened.push(artifact.ref.artifact_id);
    },
  };
  return {
    server,
    states,
    confirms,
    answer,
    opened,
    ui,
    connect: async () => ({
      ok: true,
      client: new MarsClient(server, () => `req-${++id}`),
      server: "http://127.0.0.1:7331",
    }),
    last: () => {
      const state = states.at(-1);
      if (!state) throw new Error("no state posted");
      return state;
    },
  };
}

export async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i++)
    await new Promise((resolve) => setTimeout(resolve, 0));
}
