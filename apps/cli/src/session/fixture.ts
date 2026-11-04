import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactRef, Task, VerificationView } from "@mars/contracts";
import type { ProjectionEvent } from "@mars/ui-core";
import {
  EVENT_FIXTURES,
  FIXTURE_ROOT,
  FIXTURE_SCOPE,
  FIXTURE_SESSION_ID,
  FIXTURE_TASK_ID,
  type FixtureEventSpec,
  fixtureEvents,
  generateLargeTask,
  JOURNAL_ENTRIES,
} from "@mars/ui-core/testing";
import { type RpcBody, SessionRpcError, type SessionTransport } from "./client";

/** Fixture evidence only: an in-process stand-in for the workbench RPC. No model, no network. */
export interface FixtureOptions {
  journal?: "available" | "unavailable";
  large?: boolean;
  status?: Task["status"];
}

const platform = (name: string) =>
  JSON.parse(readFileSync(join(FIXTURE_ROOT, "platform", name), "utf8"));

export const FINAL_TEXT = [
  "Added `--json` to `mars render`.",
  "",
  "- `apps/cli/src/render.ts` parses the flag",
  "- `documentation/CLI.md` documents it",
  "",
  "Verification is reported separately by the workbench.",
].join("\n");

/** Demo order: request → thinking → tools → hook → diff → child → research → verify → proposals → summary. */
function demoSpecs(): FixtureEventSpec[] {
  const tools = EVENT_FIXTURES["tool.completed"];
  const updates = EVENT_FIXTURES["task.updated"];
  const observed = EVENT_FIXTURES["execution.observed"];
  return [
    ...EVENT_FIXTURES["task.created"],
    updates[0],
    observed[0],
    observed[1],
    tools[0],
    tools[1],
    tools[2],
    observed[2],
    tools[3],
    tools[4],
    tools[5],
    tools[6],
    updates[1],
    ...EVENT_FIXTURES["research.proposed"],
    EVENT_FIXTURES["research.stale"][1],
    tools[7],
    tools[8],
    tools[9],
    tools[10],
    tools[11],
    ...EVENT_FIXTURES["memory.revised"],
    ...EVENT_FIXTURES["skill.revised"],
    ...EVENT_FIXTURES["evaluation.completed"],
    ...EVENT_FIXTURES["training.updated"],
    ...EVENT_FIXTURES["promotion.decided"],
    updates[2],
    updates[3],
    observed[3],
    tools[12],
  ].filter((spec): spec is FixtureEventSpec => spec !== undefined);
}

function ref(id: string, bytes: Uint8Array, media_type: string): ArtifactRef {
  return {
    artifact_id: id,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    media_type,
    byte_length: bytes.byteLength,
  };
}

export interface FixtureWorkbench {
  transport: SessionTransport;
  sent: RpcBody[];
  events: ProjectionEvent[];
}

export function fixtureWorkbench(
  options: FixtureOptions = {},
): FixtureWorkbench {
  const events = options.large
    ? generateLargeTask(10_000)
    : fixtureEvents(demoSpecs(), { prefix: "demo" });
  const artifacts = new Map<
    string,
    { bytes: Uint8Array; media_type: string }
  >();
  for (const { event, payload } of events)
    artifacts.set(event.payload.artifact_id, {
      bytes: new TextEncoder().encode(JSON.stringify(payload)),
      media_type: "application/json",
    });
  const finalBytes = new TextEncoder().encode(FINAL_TEXT);
  artifacts.set("artifact-final", {
    bytes: finalBytes,
    media_type: "text/plain",
  });
  const describe = platform("describe.json");
  const inspectExtras = platform("inspect.json");
  const tasks: Task[] = (
    platform("tasks.json") as {
      task_id: string;
      request: string;
      status: Task["status"];
      revision: number;
    }[]
  ).map((row) => ({
    schema_version: 1,
    task_id: row.task_id,
    session_id: FIXTURE_SESSION_ID,
    scope: FIXTURE_SCOPE,
    revision: row.revision,
    request: row.request,
    acceptance_criteria: [
      "bun test apps/cli passes",
      "documentation/CLI.md documents --json",
    ],
    budget: {
      max_tokens: 200_000,
      max_usd: 0.5,
      max_duration_ms: 1_800_000,
      max_depth: 2,
      max_concurrency: 2,
    },
    status:
      row.task_id === FIXTURE_TASK_ID
        ? (options.status ?? row.status)
        : row.status,
    specialist_revision: null,
    artifacts:
      row.task_id === FIXTURE_TASK_ID
        ? [ref("artifact-final", finalBytes, "text/plain")]
        : [],
  }));
  const verification: VerificationView = {
    candidate: null,
    state: "failed",
    record: null,
    reasons: ["biome reported 1 error"],
    records: [],
  };
  const sent: RpcBody[] = [];
  const task = (id: unknown) => {
    const found = tasks.find((candidate) => candidate.task_id === id);
    if (!found) throw new SessionRpcError("not_found", "Task not found.", 404);
    return found;
  };
  const transport: SessionTransport = async (body) => {
    sent.push(structuredClone(body));
    const params = body.params;
    switch (body.method) {
      case "workbench.describe":
        return describe;
      case "tasks.list":
        return tasks;
      case "tasks.inspect":
        return {
          ...task(params.task_id),
          ...(params.task_id === FIXTURE_TASK_ID ? inspectExtras : {}),
        };
      case "tasks.events": {
        const own =
          params.task_id === FIXTURE_TASK_ID
            ? events.map((row) => row.event)
            : [];
        const after = own.findIndex(
          (event) => event.event_id === params.after_event_id,
        );
        return own.slice(after + 1, after + 1 + 1_000);
      }
      case "tasks.artifact": {
        const artifact = artifacts.get(
          (params.artifact as ArtifactRef).artifact_id,
        );
        if (!artifact)
          throw new SessionRpcError("not_found", "Artifact not found.", 404);
        return {
          data_base64: Buffer.from(artifact.bytes).toString("base64"),
          media_type: artifact.media_type,
        };
      }
      case "tasks.diff":
        return { files: [] };
      case "tasks.verification":
        return verification;
      case "tasks.evidence":
        throw new SessionRpcError("not_found", "No evidence.", 404);
      case "tasks.journal": {
        if (options.journal === "unavailable")
          throw new SessionRpcError(
            "invalid_request",
            "Invalid workbench request.",
            400,
          );
        const ids = new Set(params.entry_ids as string[]);
        return JOURNAL_ENTRIES.filter((entry) => ids.has(entry.entry_id));
      }
    }
  };
  return { transport, sent, events };
}
