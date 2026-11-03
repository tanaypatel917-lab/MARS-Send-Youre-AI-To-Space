/**
 * MARS agent bundle entry for Harbor trials. Runs INSIDE the task container.
 *
 * Reads `MARS_AGENT_CONFIG` (provider + budget + prompt components, written by
 * `mars_harbor_agent.agent.MarsAgent`, never containing key values) and
 * `MARS_AGENT_INSTRUCTION`, drives the existing Oh My Pi runtime through
 * `openRuntimeSession` with local RuntimeTools scoped to the task workdir, and
 * writes a usage summary to `MARS_AGENT_USAGE`. It is not a second agent loop:
 * every model request and tool call goes through `@mars/execution`.
 *
 * Build (host): bun build --compile --target=bun-linux-x64 \
 *   --external omp-legacy-pi-modules packages/evaluation/agent/main.ts \
 *   --outfile <bundle>/mars-agent ; copy pi_natives.linux-x64-*.node beside it.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { openRuntimeSession, type RuntimeTools } from "@mars/execution";
import { loadModelRegistry } from "@mars/providers";
import { z } from "zod";
import { claimCredential } from "./credential";

const ConfigSchema = z
  .object({
    schema: z.literal("mars.evaluation-agent-config/v1"),
    model_id: z.string().min(1),
    base_url: z.string().url(),
    api_key_env: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/),
    pricing: z
      .object({
        input_per_mtok_usd: z.number().finite().nonnegative(),
        output_per_mtok_usd: z.number().finite().nonnegative(),
      })
      .strict()
      .nullable()
      .default(null),
    api_format: z.literal("openai_chat_completions"),
    context_window: z.number().int().positive(),
    max_tokens: z.number().int().positive(),
    max_usd: z.number().nonnegative(),
    timeout_ms: z.number().int().positive(),
    workdir: z.string().regex(/^\/[A-Za-z0-9._/-]*$/),
    state_dir: z.string().regex(/^\/[A-Za-z0-9._/-]*$/),
    components: z.record(z.string().min(1), z.string()),
  })
  .strict();

interface Usage {
  schema: "mars.evaluation-agent-usage/v1";
  status: "completed" | "paused" | "cancelled" | "failed";
  error: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_tokens: number;
  cost_usd: number | null;
  model_requests: number;
  tool_calls: number;
  elapsed_ms: number;
  components_applied: string[];
  content_tail: string;
}

/** Only `system_prompt` is applied today; other component keys are reported but inert. */
const APPLIED_COMPONENTS = ["system_prompt"] as const;

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return (
    rel === "" ||
    (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
  );
}

function localTools(
  root: string,
  timeoutMs: number,
  secretEnvNames: readonly string[],
): RuntimeTools {
  const escapeError = (path: string) =>
    new Error(`Path escapes the task workspace: ${path}`);
  // Resolve symlinks on the deepest existing ancestor so a link inside the
  // workspace cannot point file tools outside `root` (which is a realpath).
  const resolveInside = async (path: string) => {
    const target = resolve(root, path);
    if (!inside(root, target)) throw escapeError(path);
    let probe = target;
    const missing: string[] = [];
    for (;;) {
      try {
        const real = await realpath(probe);
        const resolved = join(real, ...[...missing].reverse());
        if (!inside(root, resolved)) throw escapeError(path);
        return resolved;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const parent = dirname(probe);
        if (parent === probe) throw error;
        missing.push(basename(probe));
        probe = parent;
      }
    }
  };
  // Task commands never inherit the model credential or the adapter's
  // control-file locations.
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (secretEnvNames.includes(key) || key.startsWith("MARS_AGENT_")) continue;
    childEnv[key] = value;
  }
  return {
    async read(path) {
      return new Uint8Array(await readFile(await resolveInside(path)));
    },
    async write(path, content) {
      const target = await resolveInside(path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    },
    async execute(argv) {
      if (argv.length === 0) throw new Error("Empty command.");
      const proc = Bun.spawn(argv, {
        cwd: root,
        env: childEnv,
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      });
      const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
      try {
        const [stdout, stderr, exit_code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        return {
          exit_code,
          stdout: stdout.slice(-64 * 1024),
          stderr: stderr.slice(-64 * 1024),
        };
      } finally {
        clearTimeout(timer);
      }
    },
    async stop() {},
  };
}

async function main(): Promise<number> {
  const started = Date.now();
  const configPath = process.env.MARS_AGENT_CONFIG;
  const instructionPath = process.env.MARS_AGENT_INSTRUCTION;
  const usagePath = process.env.MARS_AGENT_USAGE;
  if (!configPath || !instructionPath || !usagePath)
    throw new Error(
      "MARS_AGENT_CONFIG, MARS_AGENT_INSTRUCTION and MARS_AGENT_USAGE are required.",
    );
  const config = ConfigSchema.parse(
    JSON.parse(await readFile(configPath, "utf8")),
  );
  const instruction = (await readFile(instructionPath, "utf8")).trim();
  if (!instruction) throw new Error("Empty instruction.");
  const usage: Usage = {
    schema: "mars.evaluation-agent-usage/v1",
    status: "failed",
    error: null,
    input_tokens: 0,
    output_tokens: 0,
    cache_tokens: 0,
    cost_usd: null,
    model_requests: 0,
    tool_calls: 0,
    elapsed_ms: 0,
    components_applied: [],
    content_tail: "",
  };
  const flush = async () => {
    usage.elapsed_ms = Date.now() - started;
    await writeFile(usagePath, JSON.stringify(usage, null, 2));
  };
  try {
    const cwd = await realpath(config.workdir);
    const home = resolve(config.state_dir, "home");
    await mkdir(resolve(home, ".mars"), { recursive: true, mode: 0o700 });
    await writeFile(
      resolve(home, ".mars", "models.json"),
      JSON.stringify({
        version: 1,
        providers: [
          {
            id: "harbor",
            kind: "openai-compatible",
            baseUrl: config.base_url,
            apiKeyEnv: config.api_key_env,
          },
        ],
        models: [
          {
            id: "harbor/model",
            providerId: "harbor",
            model: config.model_id,
            capabilities: {
              tools: true,
              vision: false,
              contextWindow: config.context_window,
            },
            // Paid rates from the manifest flow into the runtime ledger so
            // `cost_usd` reflects them; without rates the model is declared
            // free and paid use stays disabled.
            pricing: config.pricing
              ? {
                  free: false,
                  inputPerMTokUsd: config.pricing.input_per_mtok_usd,
                  outputPerMTokUsd: config.pricing.output_per_mtok_usd,
                }
              : { free: true },
          },
        ],
        routes: { default: ["harbor/model"] },
        policy: { allowPaid: config.pricing !== null },
      }),
    );
    const apiKey = claimCredential(process.env, config.api_key_env);
    const env: Record<string, string | undefined> = {
      ...process.env,
      HOME: config.state_dir,
      MARS_HOME: resolve(home, ".mars"),
      ...(apiKey === undefined ? {} : { [config.api_key_env]: apiKey }),
    };
    const registry = await loadModelRegistry({
      cwd: config.state_dir,
      home,
      env,
    });
    const systemPrompt = config.components.system_prompt;
    if (systemPrompt !== undefined)
      usage.components_applied.push(...APPLIED_COMPONENTS);
    const session = await openRuntimeSession({
      task: {
        schema_version: 1,
        task_id: randomUUID(),
        session_id: randomUUID(),
        scope: { owner_id: "harbor-eval", project_id: "harbor-eval" },
        revision: 0,
        request: instruction,
        acceptance_criteria: [
          "Task instruction satisfied as verified by Harbor's independent verifier.",
        ],
        budget: {
          max_tokens: config.max_tokens,
          max_usd: config.max_usd,
          max_duration_ms: config.timeout_ms,
          max_depth: 0,
          max_concurrency: 1,
        },
        status: "pending",
        specialist_revision: null,
        artifacts: [],
      },
      cwd,
      stateDir: resolve(config.state_dir, "runtime"),
      registry,
      modelId: "harbor/model",
      approvals: { read: true, write: true, execute: true },
      tools: localTools(cwd, Math.min(config.timeout_ms, 10 * 60 * 1000), [
        config.api_key_env,
      ]),
      env,
      onEvent: async (event) => {
        // Oh My Pi emits one `message_start` per assistant turn, i.e. per
        // provider request; tool executions are explicit events.
        if (event.type === "message_start") usage.model_requests += 1;
        if (event.type === "tool_execution_start") usage.tool_calls += 1;
      },
      ...(systemPrompt !== undefined
        ? { systemPromptOverride: systemPrompt }
        : {}),
    });
    try {
      const outcome = await session.run(instruction);
      usage.status = outcome.status;
      usage.error = outcome.error ?? null;
      usage.input_tokens = outcome.usage.input_tokens;
      usage.output_tokens = outcome.usage.output_tokens;
      usage.cost_usd = outcome.usage.reserved_usd;
      usage.content_tail = outcome.content.slice(-4096);
    } finally {
      await session.dispose();
    }
  } catch (error) {
    usage.status = "failed";
    usage.error =
      error instanceof Error ? error.message.slice(0, 2048) : String(error);
  }
  await flush();
  return usage.status === "completed" ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  },
);
