import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { canonicalJson, sha256 } from "@mars/contracts/canonical";
import {
  createHeldOutGuard,
  HELD_OUT_SPLIT_SCHEMA,
  HeldOutTaskSchema,
  requestSha256,
} from "@mars/datasets";
import { z } from "zod";
import {
  EDIT_BENCHMARK_TASK_SCHEMA,
  type EditBenchmarkTask,
  MAX_EDIT_TASK_FILE_BYTES,
} from "./edit-benchmark/tasks";

const GitSha = z.string().regex(/^[a-f0-9]{40}$/);
const Sha = z.string().regex(/^[a-f0-9]{64}$/);
const SafePath = z
  .string()
  .regex(/^[\w.-]+(?:\/[\w.-]+)*$/)
  .refine(
    (value) =>
      !value
        .split("/")
        .some((part) => [".", "..", ".git"].includes(part.toLowerCase())),
  );

export const LearningSuiteSchema = z
  .object({
    schema: z.literal("mars.learning-suite/v1"),
    split_id: HeldOutTaskSchema.shape.task_id,
    repository: z.string().url(),
    tasks: z
      .array(
        HeldOutTaskSchema.omit({ role: true }).extend({
          parent: GitSha,
          fix: GitSha,
          paths: z.array(SafePath).min(1).max(20),
        }),
      )
      .min(1),
  })
  .strict();

export const LEARNING_FIXTURE_SUITE = fileURLToPath(
  new URL("../fixtures/learning-benchmark.json", import.meta.url),
);

export type LearningSuite = Awaited<ReturnType<typeof loadLearningSuite>>;

async function git(repo: string, args: string[]): Promise<Uint8Array> {
  const child = Bun.spawn(
    ["git", "--no-replace-objects", "--literal-pathspecs", ...args],
    {
      cwd: repo,
      env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    },
  );
  const [bytes, code] = await Promise.all([
    new Response(child.stdout).bytes(),
    child.exited,
  ]);
  if (code !== 0)
    throw new Error(`Cannot read pinned Git object (${args[0]}).`);
  return bytes;
}

const decoder = new TextDecoder("utf-8", { fatal: true });

async function readBlob(repo: string, commit: string, path: string) {
  const entry = decoder.decode(
    await git(repo, ["ls-tree", "-z", commit, "--", path]),
  );
  if (!entry) return undefined;
  const match = /^(100644|100755) blob ([a-f0-9]{40})\t([^\0]+)\0$/.exec(entry);
  if (!match?.[2] || match[3] !== path)
    throw new Error(`Expected a regular file for ${commit}:${path}.`);
  const size = Number(
    decoder.decode(await git(repo, ["cat-file", "-s", match[2]])),
  );
  if (size > MAX_EDIT_TASK_FILE_BYTES)
    throw new Error(`Pinned file exceeds the trial file limit: ${path}.`);
  const bytes = await git(repo, ["cat-file", "blob", match[2]]);
  if (decoder.decode(bytes).includes("\0"))
    throw new Error(`Pinned file is not text: ${path}.`);
  return bytes;
}

export async function loadLearningSuite(file: string, repo: string) {
  const manifest = LearningSuiteSchema.parse(
    JSON.parse(await readFile(file, "utf8")),
  );
  const guard = createHeldOutGuard({
    schema: HELD_OUT_SPLIT_SCHEMA,
    split_id: manifest.split_id,
    tasks: manifest.tasks.map(({ task_id, domain, complexity, request }) => ({
      task_id,
      domain,
      complexity,
      request,
      role: "worker",
    })),
  });
  const seenFixes = new Set<string>();
  const seenChanges = new Set<string>();
  const seenRequests = new Set<string>();
  const tasks = [];
  for (const pin of manifest.tasks) {
    const request = requestSha256(pin.request);
    if (seenFixes.has(pin.fix) || seenRequests.has(request))
      throw new Error(`Duplicate fix or request: ${pin.task_id}.`);
    seenFixes.add(pin.fix);
    seenRequests.add(request);
    if (new Set(pin.paths).size !== pin.paths.length)
      throw new Error(`Duplicate path: ${pin.task_id}.`);
    const parents = decoder
      .decode(await git(repo, ["rev-list", "--parents", "-n", "1", pin.fix]))
      .trim();
    if (parents !== `${pin.fix} ${pin.parent}`)
      throw new Error(
        `Expected a single-parent fix and its exact parent: ${pin.task_id}.`,
      );
    const created = decoder
      .decode(await git(repo, ["show", "-s", "--format=%cs", pin.fix]))
      .trim();
    const before = new Map<string, Uint8Array>();
    const after = new Map<string, Uint8Array>();
    const changes = [];
    for (const path of [...pin.paths].sort()) {
      const [oldBytes, newBytes] = await Promise.all([
        readBlob(repo, pin.parent, path),
        readBlob(repo, pin.fix, path),
      ]);
      if (!oldBytes && !newBytes)
        throw new Error(
          `Path missing in both commits: ${pin.task_id}:${path}.`,
        );
      if (oldBytes) before.set(path, oldBytes);
      if (newBytes) after.set(path, newBytes);
      const oldHash = oldBytes ? sha256(oldBytes) : null;
      const newHash = newBytes ? sha256(newBytes) : null;
      if (oldHash !== newHash) changes.push([oldHash, newHash]);
    }
    const change = sha256(canonicalJson(changes.sort()));
    if (!before.size || !changes.length || seenChanges.has(change))
      throw new Error(`Empty, unchanged or duplicate fix: ${pin.task_id}.`);
    seenChanges.add(change);
    const task: EditBenchmarkTask = {
      schema: EDIT_BENCHMARK_TASK_SCHEMA,
      task_id: pin.task_id,
      category: "multi_site",
      complexity: pin.complexity,
      instruction: pin.request,
      provenance: { origin: "derived", created },
      before,
      after,
    };
    tasks.push({ pin, task });
  }
  return { manifest, sha256: sha256(canonicalJson(manifest)), guard, tasks };
}

const LineageView = z.object({
  schema: z.literal("mars.specialist-dataset-lineage/v1"),
  train_task_ids: z.array(HeldOutTaskSchema.shape.task_id),
  validation_task_ids: z.array(HeldOutTaskSchema.shape.task_id),
  request_sha256s: z.array(Sha).min(1),
  datasets: z.array(z.object({ sha256: Sha })).min(1),
  provenance: z.object({ synthetic_fixture: z.literal(false) }),
});

export function assertLearningHoldout(
  suite: LearningSuite,
  input: string,
  expectedSha256: string,
) {
  if (sha256(input) !== expectedSha256)
    throw new Error("Training lineage digest mismatch.");
  const lineage = LineageView.parse(JSON.parse(input));
  const datasets = lineage.datasets.map((dataset) => dataset.sha256);
  const leaks = suite.guard.findLeakage({
    task_ids: [...lineage.train_task_ids, ...lineage.validation_task_ids],
    request_sha256s: lineage.request_sha256s,
    dataset_sha256s: datasets,
  });
  if (datasets.includes(suite.sha256) || leaks.length)
    throw new Error(
      `heldout_leakage: ${leaks.map((item) => `${item.task_id}:${item.reason}`).join(", ") || "suite digest"}`,
    );
}
