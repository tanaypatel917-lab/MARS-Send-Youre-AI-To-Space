import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RequestContext, Task } from "@mars/contracts";
import { createTaskStore } from "@mars/tasks";
import {
  buildDataset,
  collectVerifiedExamples,
  DatasetError,
  findHeldOutLeakage,
  HELD_OUT_SPLIT_SCHEMA,
  type HeldOutSplit,
  parseHeldOutSplit,
  requestSha256,
  type VerifiedExample,
} from "./index";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const scope = { owner_id: "owner-1", project_id: "project-1" };
const context: RequestContext = {
  schema_version: 1,
  scope,
  request_id: "request-1",
};
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const example = (
  id: string,
  request = `Fix ${id}`,
  patch = `--- a/${id}.ts\n+++ b/${id}.ts\n@@ -1 +1 @@\n-bad\n+good\n`,
): VerifiedExample => ({
  task_id: id,
  scope,
  request,
  patch,
  patch_sha256: sha(patch),
  verdict_run_id: `run-${id}`,
  check_manifest_sha256: null,
});

const task = (id: string): Task => ({
  schema_version: 1,
  task_id: id,
  session_id: `session-${id}`,
  scope,
  revision: 0,
  request: `Fix ${id}`,
  acceptance_criteria: ["It is done"],
  budget: {
    max_tokens: 1000,
    max_usd: 1,
    max_duration_ms: 1000,
    max_depth: 1,
    max_concurrency: 1,
  },
  status: "pending",
  specialist_revision: null,
  artifacts: [],
});

const verdict = (id: string, patch: string, passed: boolean) => ({
  schema_version: 1,
  operation: "verification.verdict",
  run_id: `run-${id}`,
  task_id: id,
  task_revision: 1,
  candidate: { workspace_id: "w", provider: "local", revision: "r1" },
  verdict: passed ? "passed" : "failed",
  verified: passed,
  checks: [
    {
      kind: "file_content",
      path: "a.txt",
      expected_sha256: sha("x"),
      observed_sha256: sha(passed ? "x" : "y"),
      status: passed ? "passed" : "failed",
      reason: null,
      duration_ms: 1,
    },
  ],
  reasons: [],
  diagnostics: [],
  duration_ms: 1,
  recorded_at: new Date(0).toISOString(),
  patch_sha256: sha(patch),
});

test("collects only completed tasks whose newest verdict passed on the exported tested patch", async () => {
  const root = mkdtempSync(join(tmpdir(), "mars-datasets-"));
  roots.push(root);
  const store = await createTaskStore({ rootDir: root, workspaceRoots: [] });
  const emit = (id: string, payload: unknown) =>
    store.appendEvent(context, id, {
      event_type: "tool.completed",
      run_id: `run-${id}`,
      producer: "@mars/workbench",
      versions: [{ component: "@mars/workbench", revision: "1" }],
      payload,
    });
  const exportPatch = async (
    id: string,
    patch: string,
    round_trip = "passed",
    operation = "patch.exported",
  ) =>
    emit(id, {
      operation,
      round_trip,
      artifact: await store.artifacts.put(
        context,
        new TextEncoder().encode(patch),
        "text/x-diff",
      ),
    });
  const patch = "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n";
  for (const id of [
    "good",
    "regressed",
    "other-patch",
    "no-round-trip",
    "handoff-only",
    "pending",
  ]) {
    await store.create(context, task(id));
    if (id === "pending") continue;
    await store.update(context, id, 0, { status: "running" });
    await store.update(context, id, 1, { status: "completed" });
  }
  await emit("good", verdict("good", patch, true));
  await exportPatch("good", patch);
  await emit("regressed", verdict("regressed", patch, true));
  await emit("regressed", verdict("regressed", patch, false));
  await exportPatch("regressed", patch);
  await emit("other-patch", verdict("other-patch", patch, true));
  await exportPatch("other-patch", `${patch}+extra\n`);
  await emit("no-round-trip", verdict("no-round-trip", patch, true));
  await exportPatch("no-round-trip", patch, "failed");
  await emit("handoff-only", verdict("handoff-only", patch, true));
  await exportPatch(
    "handoff-only",
    patch,
    "passed",
    "patch.prepared_for_handoff",
  );
  // An agent-produced record never counts as host evidence.
  await store.appendEvent(context, "pending", {
    event_type: "tool.completed",
    run_id: "x",
    producer: "agent",
    versions: [{ component: "agent", revision: "1" }],
    payload: verdict("pending", patch, true),
  });

  const result = await collectVerifiedExamples(store, context);
  expect(result.examples.map((e) => [e.task_id, e.patch])).toEqual([
    ["good", patch],
  ]);
  expect(result.examples[0]?.patch_sha256).toBe(sha(patch));
  expect(
    Object.fromEntries(result.skipped.map((s) => [s.task_id, s.reason])),
  ).toEqual({
    regressed: "latest-verdict-not-verified",
    "other-patch": "no-exported-tested-patch",
    "no-round-trip": "export-round-trip-failed",
    "handoff-only": "no-exported-tested-patch",
    pending: "not-completed",
  });
  await store.close();
});

test("held-out tasks, secrets, private paths, duplicates and mismatched patches never reach the dataset", () => {
  const tampered = {
    ...example("tampered"),
    patch: "--- a\n+++ b\n+changed\n",
  };
  const built = buildDataset({
    dataset_id: "pilot-1",
    examples: [
      ...["a", "b", "c", "d", "e", "f"].map((id) => example(id)),
      example("heldout-id"),
      example("renamed", "  FIX   tb2-task "),
      example("copy", "fix HELDOUT-id", "--- a/c\n+++ b/c\n+copy\n"),
      example("secret", "Use key AKIAABCDEFGHIJKLMNOP"),
      example("private", "Read /home/u/.mars/state/x"),
      example("dup", "fix a", example("a").patch),
      tampered,
    ],
    held_out: [
      { source: "gate-trials", task_ids: ["heldout-id"] },
      { source: "tb2", task_ids: ["tb2-task"], requests: ["Fix tb2-task"] },
    ],
    private_patterns: ["/home/u/.mars"],
  });
  expect(
    Object.fromEntries(
      built.manifest.excluded.map((e) => [e.task_id, e.reason]),
    ),
  ).toEqual({
    copy: "held-out-request",
    dup: "duplicate",
    "heldout-id": "held-out-task",
    private: "private-path",
    renamed: "held-out-request",
    secret: "secret",
    tampered: "patch-mismatch",
  });
  const [train, validation] = built.manifest.splits;
  const all = [
    ...(train?.task_ids ?? []),
    ...(validation?.task_ids ?? []),
  ].sort();
  expect(all).toEqual(["a", "b", "c", "d", "e", "f"]);
  expect(validation?.task_ids.length).toBeGreaterThan(0);
  expect(train?.task_ids.some((id) => validation?.task_ids.includes(id))).toBe(
    false,
  );
  expect(train?.sha256).toBe(
    createHash("sha256").update(built.files.train).digest("hex"),
  );
  const rows = new TextDecoder()
    .decode(built.files.train)
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(rows).toHaveLength(train?.example_count ?? -1);
  expect(rows[0].messages.map((m: { role: string }) => m.role)).toEqual([
    "system",
    "user",
    "assistant",
  ]);
  expect(built.manifest.held_out.map((h) => h.source)).toEqual([
    "gate-trials",
    "tb2",
  ]);
});

test("the build is deterministic and refuses an empty result", () => {
  const examples = ["a", "b", "c", "d"].map((id) => example(id));
  const first = buildDataset({
    dataset_id: "d",
    examples,
    held_out: [],
    private_patterns: ["/state"],
  });
  const second = buildDataset({
    dataset_id: "d",
    examples: [...examples].reverse(),
    held_out: [],
    private_patterns: ["/state"],
  });
  expect(second.manifest).toEqual(first.manifest);
  expect(
    Buffer.from(second.files.train).equals(Buffer.from(first.files.train)),
  ).toBe(true);
  expect(() =>
    buildDataset({
      dataset_id: "d",
      examples,
      held_out: [{ source: "all", task_ids: ["a", "b", "c", "d"] }],
      private_patterns: ["/state"],
    }),
  ).toThrow(DatasetError);
  // Without host roots, private paths could not be filtered: refuse.
  expect(() =>
    buildDataset({
      dataset_id: "d",
      examples,
      held_out: [],
      private_patterns: [" "],
    }),
  ).toThrow("private_patterns");
});

test("examples sharing a request stay in the same split under every seed", () => {
  const examples = [
    ...["a", "b", "c", "d", "e", "f", "g", "h"].map((id) => example(id)),
    example("p", "Shared request", "--- a/p\n+++ b/p\n+p\n"),
    example("q", "shared   REQUEST", "--- a/q\n+++ b/q\n+q\n"),
  ];
  for (let seed = 0; seed < 25; seed++) {
    const built = buildDataset({
      dataset_id: "d",
      examples,
      held_out: [],
      private_patterns: ["/state"],
      validation_fraction: 0.3,
      seed: String(seed),
    });
    const validation = built.manifest.splits[1]?.task_ids ?? [];
    expect(validation.includes("p")).toBe(validation.includes("q"));
  }
});

test("the held-out digest covers request texts inferred from held-out examples", () => {
  const digest = (heldRequest: string) =>
    buildDataset({
      dataset_id: "d",
      examples: [example("a"), example("b"), example("h", heldRequest)],
      held_out: [{ source: "gate-trials", task_ids: ["h"] }],
      private_patterns: ["/state"],
    }).manifest.held_out[0]?.sha256;
  expect(digest("Fix h")).not.toBe(digest("Fix something else"));
  expect(digest("Fix h")).toBe(digest("  FIX   h "));
});

test("held-out request digests catch normalized request overlap across task ids", () => {
  const split: HeldOutSplit = {
    schema: HELD_OUT_SPLIT_SCHEMA,
    split_id: "heldout-digest-test",
    tasks: [
      {
        task_id: "heldout-task",
        domain: "coding/mechanical-edit",
        role: "worker" as const,
        complexity: "medium" as const,
        request: "  rename the widget ",
      },
    ],
  };
  expect(
    findHeldOutLeakage(split, {
      task_ids: ["different-training-task"],
      request_sha256s: [requestSha256("Rename  the Widget")],
    }),
  ).toEqual([{ task_id: "heldout-task", reason: "training-request" }]);
  expect(
    findHeldOutLeakage(split, {
      task_ids: [],
      request_sha256s: [requestSha256("unrelated request")],
    }),
  ).toEqual([]);
});

test("held-out tasks must carry request text for cross-id exclusion", () => {
  expect(() =>
    parseHeldOutSplit({
      schema: HELD_OUT_SPLIT_SCHEMA,
      split_id: "heldout-no-request",
      tasks: [
        {
          task_id: "heldout-task",
          domain: "coding/mechanical-edit",
          role: "worker",
          complexity: "medium",
        },
      ],
    }),
  ).toThrow();
});
