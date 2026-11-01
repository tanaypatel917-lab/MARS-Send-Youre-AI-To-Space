import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openRuntimeSession,
  type RuntimeSessionOptions,
  type RuntimeTools,
} from "@mars/execution";
import { loadModelRegistry } from "@mars/providers";
import { CollaborationError, createOhMyPiChildAdapter } from "./index";
import type { ChildLaunch } from "./runner";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function sse(delta: object, reason = "stop"): Response {
  return new Response(
    `data: ${JSON.stringify({ choices: [{ delta, finish_reason: null }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }], usage: { prompt_tokens: 50, completion_tokens: 12 } })}\n\n` +
      "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mars-collaboration-omp-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "workspace");
  const home = join(root, "home");
  const stateRoot = join(root, "state");
  await mkdir(cwd);
  await mkdir(join(home, ".mars"), { recursive: true });
  await writeFile(
    join(home, ".mars", "models.json"),
    JSON.stringify({
      version: 1,
      providers: [
        {
          id: "fixture",
          kind: "openai-compatible",
          baseUrl: "https://fixture.invalid/v1",
          apiKeyEnv: "FIXTURE_KEY",
        },
      ],
      models: [
        {
          id: "fixture/free",
          providerId: "fixture",
          model: "stub",
          capabilities: { tools: true, vision: false, contextWindow: 32000 },
          pricing: { free: true },
        },
        {
          id: "fixture/paid",
          providerId: "fixture",
          model: "stub",
          capabilities: { tools: true, vision: false, contextWindow: 32000 },
          pricing: {
            free: false,
            inputPerMTokUsd: 1,
            outputPerMTokUsd: 2,
          },
        },
      ],
      routes: { default: ["fixture/free"] },
      policy: { allowPaid: true },
    }),
  );
  const registry = await loadModelRegistry({
    cwd,
    home,
    env: { FIXTURE_KEY: "dummy-not-real" },
  });
  const tools: RuntimeTools = {
    read: async (path) => new Uint8Array(await readFile(join(cwd, path))),
    write: async () => {
      throw new Error("Read-only fixture.");
    },
    execute: async () => {
      throw new Error("Read-only fixture.");
    },
    stop: async () => undefined,
  };
  const launch: ChildLaunch = {
    room_id: "room",
    agent_id: "child",
    parent_agent_id: "parent",
    role_label: "worker",
    scope: {
      owner_id: "test-owner",
      project_id: "test-project",
      workspace_id: "test-workspace",
    },
    task_id: "task",
    task_revision: 0,
    child_task_id: "task.child",
    instruction: "Return a brief greeting.",
    approvals: { read: true, write: false, execute: false },
    paid_models: false,
    model_id: "fixture/free",
    budget: {
      max_tokens: 24_000,
      max_usd: 0,
      max_duration_ms: 60_000,
      max_depth: 0,
      max_concurrency: 1,
    },
    max_steps: 10,
    workspace_mode: "read_only",
    write_paths: [],
    session_ref: null,
    attempt: 1,
  };
  const fetchCalls: string[] = [];
  const runtimeFactory = async (options: RuntimeSessionOptions) =>
    openRuntimeSession({
      ...options,
      env: { FIXTURE_KEY: "dummy-not-real" },
      fetch: async (url, _init) => {
        fetchCalls.push(url);
        return sse({ content: "Hello from the offline fixture." });
      },
    });
  const adapter = createOhMyPiChildAdapter({
    registry,
    stateRoot,
    workspaceFor: async () => ({
      cwd,
      tools,
      base_revision: "fixture-base",
    }),
    runtimeFactory,
  });
  return { root, cwd, stateRoot, registry, launch, adapter, fetchCalls };
}

test("OMP adapter uses the runtime journal, persists only its binding, and reconciles its ledger", async () => {
  const f = await fixture();
  const progress: { steps: number; session_ref?: string }[] = [];
  const run = await f.adapter.start(f.launch, {
    signal: new AbortController().signal,
    async onProgress(value) {
      progress.push({
        steps: value.steps,
        ...(value.session_ref ? { session_ref: value.session_ref } : {}),
      });
    },
  });
  const outcome = await run.outcome;
  expect(outcome).toMatchObject({
    status: "completed",
    summary: "Hello from the offline fixture.",
    usage: {
      input_tokens: 50,
      output_tokens: 12,
    },
  });
  expect(outcome.usage?.steps).toBeGreaterThanOrEqual(1);
  expect(f.fetchCalls).toHaveLength(1);
  expect(progress.some((value) => value.steps >= 1)).toBe(true);
  expect(progress.some((value) => value.session_ref === run.session_ref)).toBe(
    true,
  );
  expect(await f.adapter.reconcile?.(run.session_ref)).toMatchObject({
    input_tokens: 50,
    output_tokens: 12,
  });
  const stateFiles = new Bun.Glob("**/*").scan({
    cwd: f.stateRoot,
    onlyFiles: true,
  });
  const paths: string[] = [];
  for await (const path of stateFiles) paths.push(path);
  expect(paths.some((path) => path.endsWith("binding.json"))).toBe(true);
  expect(paths.some((path) => path.includes("transcript"))).toBe(false);
});

test("paid model rejection happens before runtime or fetch", async () => {
  const f = await fixture();
  const paidLaunch: ChildLaunch = {
    ...f.launch,
    model_id: "fixture/paid",
  };
  let runtimeOpens = 0;
  const adapter = createOhMyPiChildAdapter({
    registry: f.registry,
    stateRoot: f.stateRoot,
    workspaceFor: async () => ({
      cwd: f.cwd,
      tools: {
        read: async () => new Uint8Array(),
        write: async () => undefined,
        execute: async () => ({ exit_code: 0, stdout: "", stderr: "" }),
        stop: async () => undefined,
      },
      base_revision: null,
    }),
    runtimeFactory: async (options) => {
      runtimeOpens += 1;
      return openRuntimeSession(options);
    },
  });
  let error: unknown;
  try {
    await adapter.start(paidLaunch, {
      signal: new AbortController().signal,
      async onProgress() {},
    });
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(CollaborationError);
  expect(error).toMatchObject({ code: "forbidden" });
  expect(runtimeOpens).toBe(0);
  expect(f.fetchCalls).toHaveLength(0);
});

test("OMP adapter cancels after the child exceeds its step limit", async () => {
  const f = await fixture();
  const limitedLaunch: ChildLaunch = { ...f.launch, max_steps: 0 };
  const run = await f.adapter.start(limitedLaunch, {
    signal: new AbortController().signal,
    async onProgress() {},
  });
  const outcome = await run.outcome;
  expect(["cancelled", "failed"]).toContain(outcome.status);
  expect(outcome.usage?.steps).toBeGreaterThanOrEqual(1);
  expect(f.fetchCalls).toHaveLength(1);
});
