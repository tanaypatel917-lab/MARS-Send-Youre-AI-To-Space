/**
 * Tiny real-model run of the MARS runtime (Oh My Pi) against a locally
 * configured model, intended for the documented Ollama / Qwen3-Coder path.
 *
 * Usage:
 *   MARS_HOME=<dir with models.json> bun scripts/local-model-run.ts <modelId> [--cwd DIR] [--dump DIR]
 *
 * `--dump DIR` writes every provider request body and raw response to DIR as
 * evidence (requests may contain the task text; never pass a directory that
 * is shared or committed).
 *
 * Executes a two-tool task (write a file, then report) with write approval only;
 * command execution is refused so nothing leaves the scratch directory. Prints a
 * JSON evidence record (model, status, content, usage, request count, duration).
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { parseArgs } from "node:util";
import type { Task } from "../packages/contracts/src/index";
import {
  openRuntimeSession,
  type RuntimeTools,
} from "../packages/execution/src/index";
import { loadModelRegistry } from "../packages/providers/src/index";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: { cwd: { type: "string" }, dump: { type: "string" } },
  strict: true,
  allowPositionals: true,
});
const modelId = positionals[0];
if (!modelId)
  throw new Error(
    "Usage: MARS_HOME=<dir> bun scripts/local-model-run.ts <modelId> [--cwd DIR]",
  );

const cwd = values.cwd ?? (await mkdtemp(join(tmpdir(), "mars-local-run-")));
const stateDir = await mkdtemp(join(tmpdir(), "mars-local-state-"));
const registry = await loadModelRegistry({
  cwd,
  home: process.env.MARS_HOME ?? join(process.env.HOME ?? "", ".mars"),
  env: process.env,
});

function scoped(path: string): string {
  const target = join(cwd, path);
  const rel = relative(cwd, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel))
    throw new Error(`Path escapes the scratch directory: ${path}`);
  return target;
}

const tools: RuntimeTools = {
  read: (path) => readFile(scoped(path)),
  write: (path, content) => writeFile(scoped(path), content),
  execute: async () => {
    throw new Error("Command execution is disabled in local-model-run.");
  },
  stop: async () => undefined,
};

const task: Task = {
  schema_version: 1,
  task_id: randomUUID(),
  session_id: randomUUID(),
  scope: {
    owner_id: "local-model-run",
    project_id: "local-model-run",
    workspace_id: "scratch",
  },
  revision: 0,
  request:
    "Create a file named greet.txt containing exactly the text Hello, then reply with one sentence describing what you did. Do not run commands.",
  acceptance_criteria: ["greet.txt contains Hello"],
  budget: {
    max_tokens: 24000,
    max_usd: 0,
    max_duration_ms: 10 * 60 * 1000,
    max_depth: 0,
    max_concurrency: 1,
  },
  status: "pending",
  specialist_revision: null,
  artifacts: [],
};

let modelRequests = 0;
const startedAt = Date.now();
const session = await openRuntimeSession({
  task,
  cwd,
  stateDir,
  registry,
  modelId,
  tools,
  approvals: { read: true, write: true, execute: false },
  env: process.env,
  fetch: async (input, init) => {
    modelRequests += 1;
    const response = await fetch(input, init);
    if (values.dump) {
      const base = join(values.dump, `request-${modelRequests}`);
      await writeFile(`${base}.json`, String(init?.body ?? ""));
      const copy = response.clone();
      await writeFile(`${base}.response.txt`, await copy.text());
    }
    return response;
  },
});
try {
  const outcome = await session.run(task.request);
  let greet: string | null = null;
  try {
    greet = await readFile(join(cwd, "greet.txt"), "utf8");
  } catch {
    greet = null;
  }
  console.log(
    JSON.stringify(
      {
        label: "live-model-run",
        model_id: session.modelId,
        status: outcome.status,
        content: outcome.content,
        error: outcome.error ?? null,
        usage: outcome.usage,
        model_requests: modelRequests,
        greet_txt: greet,
        duration_ms: Date.now() - startedAt,
        cwd,
      },
      null,
      2,
    ),
  );
  process.exitCode =
    outcome.status === "completed" && greet?.trim() === "Hello" ? 0 : 1;
} finally {
  await session.dispose();
}
