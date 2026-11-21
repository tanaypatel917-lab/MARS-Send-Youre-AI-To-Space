import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  type CandidateEvaluator,
  createEvolutionDockerSandbox,
  createFixtureEvaluator,
  createModelProposer,
  createProcessSandbox,
  createScriptedProposer,
  DEFAULT_EVOLUTION_DOCKER_IMAGE,
  DEFAULT_FREE_PROPOSER_MODEL,
  digestOf,
  EvolutionError,
  EvolutionService,
  isFreeOpenRouterModel,
  runOfflineDemo,
} from "@mars/evolution";
import { loadModelRegistry, ModelRouter } from "@mars/providers";
import { CliUsageError } from "./cli-errors";

export const EVOLUTION_USAGE = [
  "Usage: mars evolution <command> --state DIR [options]",
  "  demo                                  offline FAKE end-to-end run (no model requests)",
  "  live-smoke [--model ID] [--image REF] live OpenRouter :free proposer + Docker (--network=none) build + held-out gate",
  "  status|lineage|metrics|verify --run ID",
  "  champion|history --scope KEY",
  "  rollback --scope KEY --to SEQ --expect-version N",
].join("\n");

export class EvolutionUsageError extends CliUsageError {}

/** Opens the durable store read-mostly: evaluator/proposer are inert placeholders. */
async function openStore(state: string): Promise<EvolutionService> {
  return EvolutionService.open({
    storeDir: join(state, "store"),
    workDir: join(state, "work"),
    evaluator: createFixtureEvaluator(),
    proposer: createScriptedProposer("cli-readonly", () => {
      throw new EvolutionError(
        "invalid_state",
        "the CLI does not propose mutations",
      );
    }),
    sandbox: createProcessSandbox(),
  });
}

interface SmokeTaskSpec {
  id: string;
  input: string;
  expected: string;
}

const SMOKE_SELECTION_TASKS: readonly SmokeTaskSpec[] = [
  {
    id: "sel-trim-collapse",
    input: "  hello   world  ",
    expected: "hello world",
  },
  {
    id: "sel-slug-normalize",
    input: "Mars_Evolution--v1!",
    expected: "mars-evolution-v1",
  },
];

const SMOKE_FINAL_TASKS: readonly SmokeTaskSpec[] = [
  {
    id: "final-mixed-spaces",
    input: "\talpha\n\n  beta  ",
    expected: "alpha beta",
  },
  {
    id: "final-punct-slug",
    input: "  DGM++ Archive: #5b  ",
    expected: "dgm-archive-5b",
  },
];

function createLiveSmokeEvaluator(
  sandbox: ReturnType<typeof createEvolutionDockerSandbox>,
): CandidateEvaluator {
  const allTasks = new Map(
    [...SMOKE_SELECTION_TASKS, ...SMOKE_FINAL_TASKS].map((t) => [t.id, t]),
  );
  const digest = digestOf(["mars-evolution-live-smoke-evaluator", "v2"]);
  const decoder = new TextDecoder("utf-8", { fatal: false });
  return {
    digest,
    simulated: false,
    async evaluate(request, signal) {
      const started = Date.now();
      const per_task: {
        task_id: string;
        rewards: (number | null)[];
        baseline_rewards: (number | null)[] | null;
      }[] = [];
      const notes: string[] = [];
      for (const taskId of request.tasks) {
        const spec = allTasks.get(taskId);
        const rewards: (number | null)[] = [];
        for (let r = 0; r < request.repeats; r += 1) {
          if (signal.aborted) {
            throw new EvolutionError(
              "deadline_exceeded",
              "live smoke evaluation cancelled",
            );
          }
          if (!spec) {
            rewards.push(0);
            continue;
          }
          const remainingMs = request.deadline_ms - (Date.now() - started);
          if (remainingMs <= 0) {
            throw new EvolutionError(
              "deadline_exceeded",
              "live smoke evaluation deadline exceeded",
            );
          }
          const result = await sandbox.run({
            workspaceDir: request.bundle_dir,
            argv: [
              "bun",
              "-e",
              `import { solve } from "/workspace/solver.mjs"; console.log(JSON.stringify(solve(${JSON.stringify(spec.id)}, ${JSON.stringify(spec.input)})));`,
            ],
            timeoutMs: Math.min(10_000, Math.max(1_000, remainingMs)),
            maxOutputBytes: 64 * 1024,
            signal,
            runId: request.run_id,
            labels: {
              phase: "live-smoke-eval",
              subject: request.subject_id,
            },
          });
          if (result.cancelled || signal.aborted) {
            throw new EvolutionError(
              "deadline_exceeded",
              "live smoke evaluation cancelled",
            );
          }
          if (result.timedOut) {
            rewards.push(0);
            notes.push(`task ${taskId} timed out in sandbox`);
            continue;
          }
          const stdout = decoder.decode(result.stdout);
          const stderr = decoder.decode(result.stderr);
          if (result.exitCode !== 0) {
            rewards.push(0);
            notes.push(
              `task ${taskId} exited ${result.exitCode}: ${stderr.trim()}`,
            );
            continue;
          }
          let actual: unknown;
          try {
            actual = JSON.parse(stdout.trim());
          } catch {
            actual = stdout.trim();
          }
          const passed = actual === spec.expected;
          rewards.push(passed ? 1 : 0);
          if (!passed && request.split === "selection") {
            notes.push(
              `task ${taskId} failed: input=${JSON.stringify(spec.input)} expected=${JSON.stringify(spec.expected)} got=${JSON.stringify(actual)}`,
            );
          }
        }
        per_task.push({ task_id: taskId, rewards, baseline_rewards: null });
      }
      return {
        evaluator_digest: digest,
        simulated: false,
        per_task,
        cost_usd: 0,
        tokens: 0,
        runtime_ms: Math.max(1, Date.now() - started),
        report: null,
        notes,
      };
    },
  };
}

async function seedLiveSmokeBase(baseDir: string): Promise<void> {
  await mkdir(join(baseDir, "harness"), { recursive: true });
  await mkdir(join(baseDir, "protected"), { recursive: true });
  await writeFile(
    join(baseDir, "harness", "solver.mjs"),
    [
      "export function solve(taskId, input) {",
      "  const text = String(input);",
      "  if (taskId.includes('slug')) {",
      "    // BUG: does not lowercase or collapse punctuation to single hyphens",
      "    return text.trim().replace(/\\s+/g, '-');",
      "  }",
      "  // BUG: only trims, does not collapse internal whitespace",
      "  return text.trim();",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(baseDir, "protected", "policy.txt"),
    "immutable-control-file\n",
  );
  await writeFile(
    join(baseDir, "build.sh"),
    [
      "#!/bin/sh",
      "set -eu",
      "mkdir -p dist",
      "bun build harness/solver.mjs --outfile dist/solver.mjs --target bun >/dev/null",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
}

async function runLiveSmoke(options: {
  state: string;
  model: string;
  image: string;
  runId: string;
  scopeKey: string;
  generations: number;
  children: number;
}): Promise<Record<string, unknown>> {
  if (!isFreeOpenRouterModel(options.model)) {
    throw new EvolutionUsageError(
      `--model must be "openrouter/free" or end in ":free" (got "${options.model}")`,
    );
  }
  const apiKey =
    process.env.OPENROUTER_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
  if (!apiKey) {
    throw new EvolutionUsageError(
      "OPENROUTER_API_KEY (or OPENAI_API_KEY holding an OpenRouter key) is required for live-smoke",
    );
  }

  const providerEnv: Record<string, string | undefined> = {
    ...process.env,
    OPENROUTER_API_KEY: apiKey,
  };
  const registry = await loadModelRegistry({
    cwd: options.state,
    env: providerEnv,
    trustProjectConfig: false,
  });
  if (registry.policy.allowPaid) {
    throw new EvolutionError(
      "invalid_input",
      "live-smoke requires allowPaid=false in the model registry",
    );
  }
  const router = new ModelRouter(registry, {
    adapterOptions: { env: providerEnv, timeoutMs: 90_000 },
  });

  let routedModel: string | null = null;
  let proposerRequests = 0;
  const instrumentedClient = {
    async complete(
      request: Parameters<ModelRouter["complete"]>[0],
      selection?: { model?: string; route?: string },
    ) {
      proposerRequests += 1;
      const reply = await router.complete(request, selection);
      routedModel = reply.model ?? options.model;
      return reply;
    },
  };

  const baseDir = join(options.state, "base");
  await seedLiveSmokeBase(baseDir);

  const sandbox = createEvolutionDockerSandbox({ image: options.image });
  const open = () =>
    EvolutionService.open({
      storeDir: join(options.state, "store"),
      workDir: join(options.state, "work"),
      evaluator: createLiveSmokeEvaluator(sandbox),
      proposer: createModelProposer({
        client: instrumentedClient,
        model: options.model,
        allowPaid: false,
      }),
      sandbox,
    });

  const service = await open();
  try {
    await service.startRun({
      config: {
        schema: "mars.evolution-run/v1",
        run_id: options.runId,
        seed: "live-smoke-v1",
        generations: options.generations,
        children_per_generation: options.children,
        selection: {
          stages: [{ tasks: SMOKE_SELECTION_TASKS.map((t) => t.id) }],
          repeats: 1,
        },
        final_test: {
          tasks: SMOKE_FINAL_TASKS.map((t) => t.id),
          repeats: 2,
        },
        evaluation_budget: {
          max_usd: 0,
          max_tokens: 100_000,
          max_duration_ms: 120_000,
          max_depth: 2,
          max_concurrency: 1,
        },
        budget: {
          max_usd: 0,
          max_tokens: 500_000,
          max_duration_ms: 300_000,
          max_depth: 4,
          max_concurrency: 1,
        },
        harness: {
          mutable_paths: ["harness/**"],
          protected_paths: ["protected/**", "build.sh"],
          build: {
            argv: ["/bin/sh", "build.sh"],
            timeout_ms: 60_000,
            bundle_dir: "dist",
          },
        },
      },
      scope_key: options.scopeKey,
      base_dir: baseDir,
      base_ref: "live-smoke-base",
      model: {
        id: options.model,
        provider: "openrouter",
        revision: "free-tier",
      },
      prompts: {
        system_prompt:
          "Normalize whitespace or slugs cleanly in harness/solver.mjs.",
      },
      skills: { store_revision: "live-smoke" },
      tools: [],
      retrieval: {
        repo_map_tokens: 0,
        memory_top_k: 0,
        context_window_tokens: 32_768,
        research: false,
      },
    });
    const status = await service.run(options.runId);
    const preSmokeChampion = service.champion(options.scopeKey);
    const lineageBeforePromote = service.lineage(options.runId);
    const hasEvaluatedChild = lineageBeforePromote.some(
      (c) => c.parent_id !== null && c.state === "evaluated",
    );
    const decision = hasEvaluatedChild
      ? await service.promote({
          run_id: options.runId,
          idempotency_key: `${options.runId}-promote`,
        })
      : null;
    const verifyBeforeReopen = await service.verify(options.runId);
    let rolledBack = false;
    if (decision?.verdict === "accepted" && preSmokeChampion) {
      const champion = service.champion(options.scopeKey);
      service.rollback({
        scope_key: options.scopeKey,
        to_entry_seq: preSmokeChampion.entry_seq,
        expected_pointer_version: champion?.pointer_version ?? 0,
      });
      rolledBack = true;
    }
    const lineage = service.lineage(options.runId);
    service.close();

    const reopened = await open();
    try {
      const verifyAfterReopen = await reopened.verify(options.runId);
      return {
        schema: "mars.evolution-live-smoke/v1",
        run_id: options.runId,
        proposer_model_requested: options.model,
        proposer_model_routed: routedModel,
        proposer_requests: proposerRequests,
        build_isolation: "docker-network-none",
        docker_image: options.image,
        status: status.status,
        candidates: lineage.map((c) => ({
          candidate_id: c.candidate_id,
          parent_id: c.parent_id,
          state: c.state,
          score: c.score,
          reason: c.reason,
        })),
        held_out_gate: decision
          ? {
              verdict: decision.verdict,
              honest_result:
                decision.verdict === "accepted" ? "improved" : "no_improvement",
              simulated: decision.simulated,
              candidate_id: decision.candidate_id,
              quality: decision.quality,
              gates: decision.gates,
              notes: decision.notes,
            }
          : {
              verdict: "no_improvement" as const,
              honest_result: "no_improvement" as const,
              simulated: false,
              candidate_id: null,
              quality: null,
              gates: [],
              notes: [
                "No evaluated child candidate reached the held-out gate; see candidate rejection reasons.",
              ],
            },
        rolled_back: rolledBack,
        verified_before_reopen: verifyBeforeReopen.ok,
        verified_after_reopen: verifyAfterReopen.ok,
        champion_after_reopen:
          reopened.champion(options.scopeKey)?.candidate_id ?? null,
      };
    } finally {
      reopened.close();
    }
  } finally {
    try {
      service.close();
    } catch {
      // already closed
    }
  }
}

export async function runEvolution(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  const { values } = parseArgs({
    args: rest,
    options: {
      state: { type: "string" },
      run: { type: "string" },
      scope: { type: "string" },
      to: { type: "string" },
      "expect-version": { type: "string" },
      model: { type: "string" },
      image: { type: "string" },
      generations: { type: "string" },
      children: { type: "string" },
    },
    strict: true,
  });
  if (!command || !values.state) throw new EvolutionUsageError(EVOLUTION_USAGE);
  const state = isAbsolute(values.state) ? values.state : resolve(values.state);
  if (command === "demo") {
    const { service, summary } = await runOfflineDemo(state);
    service.close();
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  if (command === "live-smoke") {
    const generations = values.generations ? Number(values.generations) : 1;
    const children = values.children ? Number(values.children) : 1;
    if (
      !Number.isSafeInteger(generations) ||
      generations < 1 ||
      !Number.isSafeInteger(children) ||
      children < 1
    ) {
      throw new EvolutionUsageError(
        "--generations and --children must be positive integers",
      );
    }
    const summary = await runLiveSmoke({
      state,
      model: values.model ?? DEFAULT_FREE_PROPOSER_MODEL,
      image: values.image ?? DEFAULT_EVOLUTION_DOCKER_IMAGE,
      runId: values.run ?? "live-smoke",
      scopeKey: values.scope ?? "live-smoke",
      generations,
      children,
    });
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  const need = (value: string | undefined, flag: string) => {
    if (!value)
      throw new EvolutionUsageError(
        `--${flag} is required\n${EVOLUTION_USAGE}`,
      );
    return value;
  };
  const integer = (value: string | undefined, flag: string) => {
    const parsed = Number(need(value, flag));
    if (!Number.isSafeInteger(parsed) || parsed < 0)
      throw new EvolutionUsageError(`--${flag} must be a non-negative integer`);
    return parsed;
  };
  const service = await openStore(state);
  try {
    let output: unknown;
    if (command === "status") output = service.status(need(values.run, "run"));
    else if (command === "lineage")
      output = service.lineage(need(values.run, "run"));
    else if (command === "metrics")
      output = service.metrics(need(values.run, "run"));
    else if (command === "verify")
      output = await service.verify(need(values.run, "run"));
    else if (command === "champion")
      output = service.champion(need(values.scope, "scope"));
    else if (command === "history")
      output = service.history(need(values.scope, "scope"));
    else if (command === "rollback")
      output = service.rollback({
        scope_key: need(values.scope, "scope"),
        to_entry_seq: integer(values.to, "to"),
        expected_pointer_version: integer(
          values["expect-version"],
          "expect-version",
        ),
      });
    else throw new EvolutionUsageError(EVOLUTION_USAGE);
    console.log(JSON.stringify(output, null, 2));
    if (command === "verify" && !(output as { ok: boolean }).ok)
      process.exitCode = 1;
  } finally {
    service.close();
  }
}
