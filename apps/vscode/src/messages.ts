import type {
  ArtifactRef,
  Budget,
  CheckpointRef,
  Task,
  TaskStatus,
  WorkspaceRef,
} from "@mars/contracts";
import { z } from "zod";

const taskId = z.string().min(1).max(200);
const shortId = z.string().min(1).max(500);
const finite = z.number().finite();

/** Messages the webview may send. Anything else is dropped. */
export const WebviewMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }).strict(),
  z.object({ type: z.literal("connect") }).strict(),
  z.object({ type: z.literal("setToken") }).strict(),
  z.object({ type: z.literal("refresh") }).strict(),
  z.object({ type: z.literal("selectTask"), taskId }).strict(),
  z
    .object({
      type: z.literal("createTask"),
      request: z.string().max(20_000),
      acceptanceCriteria: z.array(z.string().max(2000)).max(50),
      budget: z
        .object({
          max_tokens: finite,
          max_usd: finite,
          max_duration_ms: finite,
          max_depth: finite,
          max_concurrency: finite,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("startTask"),
      taskId,
      approvals: z
        .object({ read: z.boolean(), write: z.boolean(), execute: z.boolean() })
        .strict(),
    })
    .strict(),
  z.object({ type: z.literal("resumeTask"), taskId }).strict(),
  z
    .object({
      type: z.literal("steerTask"),
      taskId,
      instruction: z.string().max(8000),
    })
    .strict(),
  z.object({ type: z.literal("cancelTask"), taskId }).strict(),
  z.object({ type: z.literal("loadDiff"), taskId }).strict(),
  z
    .object({
      type: z.literal("openDiff"),
      taskId,
      index: z.number().int().nonnegative().max(10_000),
    })
    .strict(),
  z
    .object({ type: z.literal("inspectArtifact"), taskId, artifactId: shortId })
    .strict(),
  z
    .object({ type: z.literal("openArtifact"), taskId, artifactId: shortId })
    .strict(),
  z.object({ type: z.literal("createCheckpoint"), taskId }).strict(),
  z
    .object({
      type: z.literal("restoreCheckpoint"),
      taskId,
      checkpointId: shortId,
    })
    .strict(),
]);
export type WebviewMessage = z.infer<typeof WebviewMessageSchema>;

export type ConnectionStatus =
  | "no-token"
  | "connecting"
  | "connected"
  | "disconnected"
  | "unauthorized"
  | "blocked"
  | "error";

export interface ConnectionView {
  status: ConnectionStatus;
  message: string | null;
  server: string | null;
  workspaceLabel: string | null;
  workspaceId: string | null;
  canExecute: boolean;
  canCheckpoint: boolean;
}

export interface EventView {
  event_id: string;
  event_type: string;
  occurred_at: string;
  producer: string;
  run_id: string;
  payload: ArtifactRef;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cost_usd: number | null;
  } | null;
}

export interface UsageView {
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  cost_unknown: boolean;
  budget: Budget;
}

export interface DiffFileView {
  index: number;
  path: string;
  status: "added" | "modified" | "deleted";
  additions: number;
  deletions: number;
  safe: boolean;
  reason: string | null;
}

export interface ArtifactView {
  artifact_id: string;
  media_type: string;
  byte_length: number;
  text: string | null;
  truncated: boolean;
  note: string | null;
}

export interface SelectedView {
  task: Task;
  events: EventView[];
  eventsTruncated: boolean;
  polling: "active" | "idle" | "error" | "stopped";
  usage: UsageView;
  diff: DiffFileView[] | null;
  checkpoints: CheckpointRef[];
  workspace: WorkspaceRef | null;
  artifact: ArtifactView | null;
}

export interface TaskSummary {
  task_id: string;
  request: string;
  status: TaskStatus;
  revision: number;
}

export interface Notice {
  kind: "info" | "error" | "conflict" | "permission";
  text: string;
}

export interface ViewState {
  connection: ConnectionView;
  policy: { modelId: string | null; paidPolicy: string };
  tasks: TaskSummary[];
  selected: SelectedView | null;
  busy: string | null;
  notice: Notice | null;
}

export type HostMessage =
  | { type: "state"; state: ViewState }
  | { type: "focusNewTask" };
