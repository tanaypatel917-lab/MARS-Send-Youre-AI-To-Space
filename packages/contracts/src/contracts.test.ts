import { describe, expect, test } from "bun:test";
import {
  ArtifactRefSchema,
  BudgetSchema,
  canTransition,
  type EventEnvelope,
  EventEnvelopeSchema,
  ScopeSchema,
  type Task,
  TaskSchema,
} from "./index";

const scope = { owner_id: "owner-1", project_id: "project-1" };
const artifact = {
  artifact_id: "artifact-1",
  sha256: "a".repeat(64),
  media_type: "text/plain",
  byte_length: 10,
};
const budget = {
  max_tokens: 500,
  max_usd: 0,
  max_duration_ms: 1000,
  max_depth: 0,
  max_concurrency: 1,
};
const event: EventEnvelope = {
  schema_version: 1,
  event_id: "event-1",
  scope,
  session_id: "session-1",
  task_id: "task-1",
  occurred_at: "2026-10-30T19:00:00Z",
  event_type: "task.created",
  parent_event_id: null,
  run_id: "run-1",
  producer: "execution",
  versions: [{ component: "execution", revision: "18.14.0" }],
  payload: artifact,
  source_event_ids: [],
  access: "private",
};

describe("versioned transport contracts", () => {
  test("round-trips a scoped event with provenance and immutable payload", () => {
    expect(
      EventEnvelopeSchema.parse(JSON.parse(JSON.stringify(event))),
    ).toEqual(event);
  });
  test("rejects future schema versions, missing ownership, and unbounded payloads", () => {
    expect(
      EventEnvelopeSchema.safeParse({ ...event, schema_version: 2 }).success,
    ).toBe(false);
    expect(ScopeSchema.safeParse({ project_id: "project-1" }).success).toBe(
      false,
    );
    expect(
      EventEnvelopeSchema.safeParse({ ...event, raw_output: "not an artifact" })
        .success,
    ).toBe(false);
    expect(
      EventEnvelopeSchema.safeParse({ ...event, source_event_ids: undefined })
        .success,
    ).toBe(false);
  });
  test("requires valid artifact hashes, sizes, and budget bounds", () => {
    expect(
      ArtifactRefSchema.safeParse({ ...artifact, sha256: "unverified" })
        .success,
    ).toBe(false);
    expect(
      ArtifactRefSchema.safeParse({ ...artifact, byte_length: -1 }).success,
    ).toBe(false);
    expect(BudgetSchema.parse(budget)).toEqual(budget);
    for (const change of [
      { max_usd: Infinity },
      { max_usd: -1 },
      { max_duration_ms: 0 },
      { max_concurrency: 0 },
      { max_tokens: 1.5 },
    ]) {
      expect(BudgetSchema.safeParse({ ...budget, ...change }).success).toBe(
        false,
      );
    }
  });
  test("requires checkable task criteria and a nonnegative revision", () => {
    const task: Task = {
      schema_version: 1,
      task_id: "task-1",
      session_id: "session-1",
      scope,
      revision: 0,
      request: "Fix a bug",
      acceptance_criteria: ["Regression test passes"],
      budget,
      status: "pending",
      specialist_revision: null,
      artifacts: [],
    };
    expect(TaskSchema.parse(task)).toEqual(task);
    expect(
      TaskSchema.safeParse({ ...task, acceptance_criteria: [] }).success,
    ).toBe(false);
    expect(TaskSchema.safeParse({ ...task, revision: -1 }).success).toBe(false);
  });
  test("does not treat unavailable cost as zero", () => {
    const unavailable = EventEnvelopeSchema.parse({
      ...event,
      usage: { input_tokens: 1, output_tokens: 2, cost_usd: null },
    });
    expect(unavailable.usage?.cost_usd).toBeNull();
    expect(
      EventEnvelopeSchema.safeParse({
        ...event,
        usage: { input_tokens: -1, output_tokens: 0, cost_usd: 0 },
      }).success,
    ).toBe(false);
  });
  test("permits resume but does not silently reopen terminal tasks", () => {
    expect(canTransition("pending", "running")).toBe(true);
    expect(canTransition("paused", "running")).toBe(true);
    expect(canTransition("running", "cancelled")).toBe(true);
    for (const status of ["completed", "failed", "cancelled"] as const) {
      expect(canTransition(status, "running")).toBe(false);
    }
  });
});
