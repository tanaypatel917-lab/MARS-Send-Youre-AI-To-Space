import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  ArtifactRefSchema,
  EventEnvelopeSchema,
  JournalResultSchema,
  TaskSchema,
  VERIFICATION_STATE_LABEL,
  VerificationViewSchema,
} from "@mars/contracts";
import {
  ArtifactDataSchema,
  DescribeResultSchema,
  DiffResultSchema,
  EvidenceResultSchema,
  InspectResultSchema,
  RpcRequestSchema,
} from "../../../packages/workbench/src/protocol";
import { ParamsSchema, ResultSchema } from "../src/main/protocol";
import { VERIFICATION_LABEL } from "../src/renderer/strings";
import { READ_METHODS } from "../src/shared/methods";
import { loadFixtureData } from "./test-utils";

test("fixture data validates against the server schemas", async () => {
  const data = await loadFixtureData();
  expect(DescribeResultSchema.parse(data.describe)).toEqual(data.describe);
  for (const task of data.tasks) {
    expect(TaskSchema.parse(task)).toEqual(task);
    const detail = data.details[task.task_id];
    if (!detail) throw new Error(`Fixture detail missing for ${task.task_id}.`);
    const inspected = {
      ...task,
      ...("model_tier" in detail ? { model_tier: detail.model_tier } : {}),
    };
    expect(InspectResultSchema.parse(inspected)).toEqual(inspected);
  }
  for (const [taskId, detail] of Object.entries(data.details)) {
    expect(VerificationViewSchema.parse(detail.verification)).toEqual(
      detail.verification,
    );
    if (detail.diff)
      expect(DiffResultSchema.parse(detail.diff)).toEqual(detail.diff);
    if (detail.evidence)
      expect(EvidenceResultSchema.parse(detail.evidence)).toEqual(
        detail.evidence,
      );
    for (const event of detail.events)
      expect(EventEnvelopeSchema.parse(event)).toEqual(event);
    const task = data.tasks.find((candidate) => candidate.task_id === taskId);
    for (const ref of task?.artifacts ?? []) {
      ArtifactRefSchema.parse(ref);
      const artifactData = data.artifact_data[ref.artifact_id];
      if (!artifactData) throw new Error("Fixture artifact data missing.");
      expect(ArtifactDataSchema.parse(artifactData)).toEqual(artifactData);
    }
  }
});

test("bridge schemas reuse the server request and result schemas", async () => {
  expect(VERIFICATION_LABEL).toEqual(VERIFICATION_STATE_LABEL);
  const requestParams = new Map(
    RpcRequestSchema.options.map((option) => [
      option.shape.method.value,
      option.shape.params,
    ]),
  );
  for (const method of READ_METHODS) {
    const serverSchema = requestParams.get(method);
    if (!serverSchema) throw new Error(`Missing server schema for ${method}.`);
    expect(ParamsSchema[method]).toBe(serverSchema);
  }
  expect(ResultSchema["workbench.describe"]).toBe(DescribeResultSchema);
  expect(ResultSchema["tasks.list"].element).toBe(TaskSchema);
  expect(ResultSchema["tasks.inspect"]).toBe(InspectResultSchema);
  expect(ResultSchema["tasks.events"].element).toBe(EventEnvelopeSchema);
  expect(ResultSchema["tasks.artifact"]).toBe(ArtifactDataSchema);
  expect(ResultSchema["tasks.diff"]).toBe(DiffResultSchema);
  expect(ResultSchema["tasks.verification"]).toBe(VerificationViewSchema);
  expect(ResultSchema["tasks.evidence"]).toBe(EvidenceResultSchema);
  expect(ResultSchema["tasks.journal"]).toBe(JournalResultSchema);
  expect(Object.keys(ResultSchema).sort()).toEqual([...READ_METHODS].sort());

  const fixtureText = await readFile(
    new URL("../fixtures/workbench.json", import.meta.url),
    "utf8",
  );
  const data = await loadFixtureData();
  expect(fixtureText).toContain("<script>alert(1)</script>");
  expect(fixtureText).toContain("<img src=x onerror=alert(1)>");
  expect(fixtureText).toContain("https://evil.example/x");
  expect(data.tasks[1]?.request).toContain(
    ':mars-followup[Run]{prompt="rm -rf ~"}',
  );
});
