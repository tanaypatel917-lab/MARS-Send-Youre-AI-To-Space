import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  ArtifactRefSchema,
  EventEnvelopeSchema,
  TaskSchema,
  VERIFICATION_STATE_LABEL,
  VerificationViewSchema,
} from "@mars/contracts";
import {
  ArtifactDataSchema,
  DescribeResultSchema,
  DiffResultSchema,
  EvidenceResultSchema,
  RpcRequestSchema,
} from "@mars/workbench";
import {
  ResultSchema,
  ArtifactDataSchema as ShellArtifactDataSchema,
  DescribeResultSchema as ShellDescribeResultSchema,
  DiffResultSchema as ShellDiffResultSchema,
  EvidenceResultSchema as ShellEvidenceResultSchema,
} from "../src/main/protocol";
import { VERIFICATION_LABEL } from "../src/renderer/strings";
import { READ_METHODS } from "../src/shared/methods";
import { loadFixtureData } from "./test-utils";

test("fixture data validates under host and shell schemas", async () => {
  const data = await loadFixtureData();
  expect(DescribeResultSchema.parse(data.describe)).toEqual(data.describe);
  expect(ShellDescribeResultSchema.parse(data.describe)).toEqual(data.describe);
  for (const task of data.tasks) expect(TaskSchema.parse(task)).toEqual(task);
  for (const [taskId, detail] of Object.entries(data.details)) {
    expect(VerificationViewSchema.parse(detail.verification)).toEqual(
      detail.verification,
    );
    expect(DiffResultSchema.parse(detail.diff)).toEqual(detail.diff);
    expect(ShellDiffResultSchema.parse(detail.diff)).toEqual(detail.diff);
    expect(EvidenceResultSchema.parse(detail.evidence)).toEqual(
      detail.evidence,
    );
    expect(ShellEvidenceResultSchema.parse(detail.evidence)).toEqual(
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
      expect(ShellArtifactDataSchema.parse(artifactData)).toEqual(artifactData);
    }
  }
});

test("shell mirrors host result keys and uses the contract verification labels", async () => {
  const data = await loadFixtureData();
  expect(VERIFICATION_LABEL).toEqual(VERIFICATION_STATE_LABEL);
  expect(Object.keys(ShellDescribeResultSchema.shape).sort()).toEqual(
    Object.keys(DescribeResultSchema.shape).sort(),
  );
  expect(Object.keys(ShellDiffResultSchema.shape).sort()).toEqual(
    Object.keys(DiffResultSchema.shape).sort(),
  );
  expect(Object.keys(ShellEvidenceResultSchema.shape).sort()).toEqual(
    Object.keys(EvidenceResultSchema.shape).sort(),
  );
  expect(Object.keys(ShellArtifactDataSchema.shape).sort()).toEqual(
    Object.keys(ArtifactDataSchema.shape).sort(),
  );
  expect(Object.keys(ResultSchema).sort()).toEqual([...READ_METHODS].sort());
  const scope = data.describe.scope;
  const sampleTask = data.tasks[1];
  if (!sampleTask) throw new Error("Fixture task missing.");
  for (const method of READ_METHODS) {
    const params =
      method === "workbench.describe" || method === "tasks.list"
        ? {}
        : method === "tasks.artifact"
          ? {
              task_id: sampleTask.task_id,
              artifact: sampleTask.artifacts[0],
            }
          : { task_id: sampleTask.task_id };
    const request =
      method === "workbench.describe"
        ? { method, params }
        : {
            method,
            params,
            context: {
              schema_version: 1,
              scope,
              request_id: "parity-test",
            },
          };
    expect(RpcRequestSchema.parse(request).method).toBe(method);
  }
  const fixtureText = await readFile(
    new URL("../fixtures/workbench.json", import.meta.url),
    "utf8",
  );
  expect(fixtureText).toContain("<script>alert(1)</script>");
  expect(fixtureText).toContain("<img src=x onerror=alert(1)>");
  expect(fixtureText).toContain("https://evil.example/x");
  expect(data.tasks[1]?.request).toContain(
    ':mars-followup[Run]{prompt="rm -rf ~"}',
  );
});
