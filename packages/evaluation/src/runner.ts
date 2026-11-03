import { access, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import type { ComparisonManifest } from "./manifest";
import { DOCKER_DIGEST_PATTERN, sha256Hex } from "./manifest";
import {
  BASELINE_AGENT_NAME,
  HARBOR_VERSION,
  MARS_AGENT_IMPORT_PATH,
  MIN_PYTHON,
  MINI_SWE_AGENT_VERSION,
} from "./pins";

/** Which agent a Harbor run launches; both arms share dataset, model and environment. */
export type HarborArm = "baseline" | "candidate";

export interface HarborRunnerOptions {
  /** Absolute path of the pinned venv interpreter (e.g. `<venv>/bin/python`). */
  pythonPath: string;
  /** Absolute path of the `harbor` entry point inside the same venv. */
  harborPath: string;
  /** Absolute path added to PYTHONPATH so `mars_harbor_agent` is importable. */
  agentPythonPath: string;
  /** Directory under which Harbor job directories are created. */
  jobsDir: string;
  /** Absolute `setsid` path used to start Harbor in its own process group. */
  setsidPath?: string;
  /**
   * Absolute `docker` path used to check that every pinned image is present
   * locally with the pinned digest before launching. `null` disables the check
   * (offline tests only); the default is `/usr/bin/docker`.
   */
  dockerPath?: string | null;
  env?: Record<string, string | undefined>;
  now?: () => number;
}

export interface HarborRunRequest {
  manifest: ComparisonManifest;
  arm: HarborArm;
  /** Task ids to run (subset of `manifest.tasks` for the scoring backend). */
  tasks: readonly string[];
  repeats: number;
  jobName: string;
  deadlineMs: number;
  maxConcurrency: number;
  signal?: AbortSignal;
  /** Candidate prompt components file written by the caller (candidate arm only). */
  candidatePath?: string;
  /**
   * Replace the arm's agent with a Harbor control agent (no model): `nop`
   * proves the verifier fails an untouched task, `oracle` proves it passes the
   * reference solution. Results are never counted as baseline/candidate.
   */
  controlAgent?: "nop" | "oracle";
  /** Pass `--dry-run`: Harbor resolves and validates but runs nothing. */
  dryRun?: boolean;
  /**
   * Called with the Harbor process id (= its process-group id under setsid) as
   * soon as it starts, so callers can persist it and kill the group later even
   * if this process does not survive.
   */
  onSpawn?: (pid: number) => void;
}

export interface HarborRunOutcome {
  job_dir: string;
  argv: string[];
  exit_code: number | null;
  signal: string | null;
  /** True when the runner killed the process group on deadline or cancellation. */
  killed: "deadline" | "cancelled" | null;
  started_at: string;
  finished_at: string;
  stdout_tail: string;
  stderr_tail: string;
}

const probeSchema = z
  .object({
    python: z.tuple([z.number().int(), z.number().int(), z.number().int()]),
    harbor: z.string().nullable(),
    mini_swe_agent: z.string().nullable(),
  })
  .strict();
export type EnvironmentProbe = z.infer<typeof probeSchema>;

const PROBE_SCRIPT =
  "import json,sys,importlib.metadata as m\n" +
  "def v(n):\n" +
  "  try: return m.version(n)\n" +
  "  except m.PackageNotFoundError: return None\n" +
  "print(json.dumps({'python': list(sys.version_info[:3]), 'harbor': v('harbor'), 'mini_swe_agent': v('mini-swe-agent')}))";

export class PinMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PinMismatchError";
  }
}

async function readStream(
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<string> {
  if (!stream) return "";
  const text = await new Response(stream).text();
  return text.length > limit ? text.slice(-limit) : text;
}

export function createHarborRunner(options: HarborRunnerOptions) {
  const now = options.now ?? Date.now;
  for (const [name, value] of Object.entries({
    pythonPath: options.pythonPath,
    harborPath: options.harborPath,
    agentPythonPath: options.agentPythonPath,
    jobsDir: options.jobsDir,
  })) {
    if (!isAbsolute(value)) throw new TypeError(`${name} must be absolute`);
  }
  const setsidPath = options.setsidPath ?? "/usr/bin/setsid";
  if (!isAbsolute(setsidPath))
    throw new TypeError("setsidPath must be absolute");
  const dockerPath =
    options.dockerPath === undefined ? "/usr/bin/docker" : options.dockerPath;
  if (dockerPath !== null && !isAbsolute(dockerPath))
    throw new TypeError("dockerPath must be absolute");
  const baseEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.env ?? process.env))
    if (value !== undefined) baseEnv[key] = value;

  async function probe(): Promise<EnvironmentProbe> {
    const proc = Bun.spawn([options.pythonPath, "-c", PROBE_SCRIPT], {
      stdout: "pipe",
      stderr: "pipe",
      env: baseEnv,
    });
    const [stdout, stderr, code] = await Promise.all([
      readStream(proc.stdout, 4096),
      readStream(proc.stderr, 4096),
      proc.exited,
    ]);
    if (code !== 0)
      throw new PinMismatchError(
        `Python probe failed (${code}): ${stderr.trim()}`,
      );
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new PinMismatchError("Python probe returned invalid JSON.");
    }
    return probeSchema.parse(parsed);
  }

  /** Refuses to run unless the venv matches the audited pins exactly. */
  async function verifyPins(
    manifest: ComparisonManifest,
  ): Promise<EnvironmentProbe> {
    const result = await probe();
    const [major, minor] = result.python;
    if (
      major < MIN_PYTHON[0] ||
      (major === MIN_PYTHON[0] && minor < MIN_PYTHON[1])
    )
      throw new PinMismatchError(
        `Python ${result.python.join(".")} is older than ${MIN_PYTHON.join(".")}.`,
      );
    if (
      result.harbor !== HARBOR_VERSION ||
      result.harbor !== manifest.python.harbor_version
    )
      throw new PinMismatchError(
        `harbor ${result.harbor ?? "missing"} does not match pin ${HARBOR_VERSION}.`,
      );
    if (
      result.mini_swe_agent !== MINI_SWE_AGENT_VERSION ||
      result.mini_swe_agent !== manifest.python.mini_swe_agent_version
    )
      throw new PinMismatchError(
        `mini-swe-agent ${result.mini_swe_agent ?? "missing"} does not match pin ${MINI_SWE_AGENT_VERSION}.`,
      );
    return result;
  }

  /** Checks the local registry copy against the manifest's dataset pin. */
  async function verifyRegistry(manifest: ComparisonManifest): Promise<void> {
    const pin = manifest.dataset;
    const path = resolve(pin.registry.path);
    const bytes = new Uint8Array(await readFile(path));
    if (sha256Hex(bytes) !== pin.registry.sha256)
      throw new PinMismatchError(
        "Registry file sha256 does not match the manifest pin.",
      );
    const datasets = z
      .array(
        z
          .object({
            name: z.string(),
            version: z.string(),
            tasks: z.array(
              z
                .object({
                  name: z.string(),
                  git_url: z.string().nullable().optional(),
                  git_commit_id: z.string().nullable().optional(),
                })
                .passthrough(),
            ),
          })
          .passthrough(),
      )
      .parse(JSON.parse(new TextDecoder().decode(bytes)));
    const dataset = datasets.find(
      (entry) => entry.name === pin.name && entry.version === pin.version,
    );
    if (!dataset)
      throw new PinMismatchError(`Registry has no ${pin.name}@${pin.version}.`);
    const names = new Set(dataset.tasks.map((task) => task.name));
    for (const task of manifest.tasks)
      if (!names.has(task))
        throw new PinMismatchError(
          `Task ${task} is not in ${pin.name}@${pin.version}.`,
        );
    for (const task of dataset.tasks) {
      if (!manifest.tasks.includes(task.name)) continue;
      if (
        task.git_url !== pin.tasks_source.git_url ||
        task.git_commit_id !== pin.tasks_source.git_commit_id
      )
        throw new PinMismatchError(
          `Registry resolves ${task.name} to a different repository/commit than the manifest pin.`,
        );
    }
  }

  /**
   * Refuses to launch unless every pinned image is present locally under the
   * pinned digest. Harbor itself builds/pulls from the task definition, so this
   * is a pre-flight guard, not a substitute for the per-trial record check.
   */
  async function verifyImages(manifest: ComparisonManifest): Promise<void> {
    if (dockerPath === null) return;
    for (const image of manifest.environment.images) {
      const [repository, digest] = image.reference.split("@");
      const proc = Bun.spawn(
        [
          dockerPath,
          "image",
          "inspect",
          "--format",
          "{{json .RepoDigests}}",
          image.reference,
        ],
        { stdout: "pipe", stderr: "pipe", env: baseEnv },
      );
      const [stdout, stderr, code] = await Promise.all([
        readStream(proc.stdout, 8192),
        readStream(proc.stderr, 4096),
        proc.exited,
      ]);
      if (code !== 0)
        throw new PinMismatchError(
          `Image ${image.reference} is not available locally: ${stderr.trim()}`,
        );
      const digests = z
        .array(z.string())
        .parse(JSON.parse(stdout.trim() || "[]"));
      if (
        !digests.some(
          (entry) =>
            entry === `${repository?.split(":")[0]}@${digest}` ||
            entry.endsWith(`@${digest}`),
        )
      )
        throw new PinMismatchError(
          `Local image ${repository} does not carry digest ${digest}.`,
        );
    }
  }

  function buildArgv(request: HarborRunRequest): string[] {
    const { manifest } = request;
    if (manifest.environment.type !== "docker")
      throw new TypeError("Only Docker environments are supported.");
    for (const image of manifest.environment.images)
      if (!DOCKER_DIGEST_PATTERN.test(image.reference))
        throw new TypeError("Docker image must be pinned to a sha256 digest");
    if (request.tasks.length === 0)
      throw new TypeError("At least one task is required.");
    for (const task of request.tasks)
      if (!manifest.tasks.includes(task))
        throw new TypeError(`Task ${task} is not in the manifest.`);
    if (!Number.isSafeInteger(request.repeats) || request.repeats < 1)
      throw new TypeError("Invalid repeats.");
    if (
      !Number.isSafeInteger(request.maxConcurrency) ||
      request.maxConcurrency < 1
    )
      throw new TypeError("Invalid concurrency.");
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(request.jobName))
      throw new TypeError("Invalid job name.");
    const argv = [
      options.harborPath,
      "run",
      "-d",
      `${manifest.dataset.name}@${manifest.dataset.version}`,
      "--registry-path",
      resolve(manifest.dataset.registry.path),
      ...request.tasks.flatMap((task) => ["-i", task]),
      "-k",
      String(request.repeats),
      "-n",
      String(Math.min(request.maxConcurrency, manifest.budget.max_concurrency)),
      "-o",
      options.jobsDir,
      "--job-name",
      request.jobName,
      "--env",
      "docker",
      "--timeout-multiplier",
      String(manifest.timeouts.timeout_multiplier),
      "-m",
      manifest.model.id,
      "--base-url",
      manifest.model.base_url,
      "--api-key-name",
      manifest.model.api_key_env,
      "--api-format",
      manifest.model.api_format,
      "-q",
      "-y",
    ];
    if (request.dryRun) argv.push("--dry-run");
    if (request.controlAgent) {
      // Control agents take no model; drop the matched-model flags.
      for (const flag of [
        "-m",
        "--base-url",
        "--api-key-name",
        "--api-format",
      ]) {
        const index = argv.indexOf(flag);
        if (index !== -1) argv.splice(index, 2);
      }
      argv.push("-a", request.controlAgent);
    } else if (request.arm === "baseline") {
      argv.push(
        "-a",
        BASELINE_AGENT_NAME,
        "--ak",
        `version=${manifest.arms.baseline.version}`,
      );
    } else {
      if (!request.candidatePath || !isAbsolute(request.candidatePath))
        throw new TypeError(
          "Candidate arm requires an absolute candidatePath.",
        );
      argv.push(
        "-a",
        MARS_AGENT_IMPORT_PATH,
        "--ak",
        `bundle_dir=${manifest.arms.candidate.bundle.path}`,
        "--ak",
        `bundle_sha256=${manifest.arms.candidate.bundle.sha256}`,
        "--ak",
        `candidate_path=${request.candidatePath}`,
        "--ak",
        `workdir=${manifest.arms.candidate.workdir}`,
        "--ak",
        `trial_timeout_ms=${manifest.timeouts.trial_timeout_ms}`,
        "--ak",
        `max_tokens=${manifest.per_trial.max_tokens}`,
        "--ak",
        `max_usd=${manifest.per_trial.max_usd}`,
        "--ak",
        `context_window=${manifest.model.context_window}`,
      );
      if (manifest.model.pricing) {
        argv.push(
          "--ak",
          `pricing_input_per_mtok_usd=${manifest.model.pricing.input_per_mtok_usd}`,
          "--ak",
          `pricing_output_per_mtok_usd=${manifest.model.pricing.output_per_mtok_usd}`,
        );
      }
    }
    return argv;
  }

  async function run(request: HarborRunRequest): Promise<HarborRunOutcome> {
    await verifyPins(request.manifest);
    await verifyRegistry(request.manifest);
    if (!request.dryRun) await verifyImages(request.manifest);
    if (request.arm === "candidate" && !request.controlAgent) {
      const bundle = request.manifest.arms.candidate.bundle;
      const binary = join(bundle.path, "mars-agent");
      if (
        !(await stat(binary).then(
          (info) => info.isFile(),
          () => false,
        ))
      )
        throw new Error(`Agent bundle binary missing: ${binary}`);
      if (sha256Hex(new Uint8Array(await readFile(binary))) !== bundle.sha256)
        throw new PinMismatchError(
          "Agent bundle sha256 does not match the manifest.",
        );
    }
    await mkdir(options.jobsDir, { recursive: true, mode: 0o700 });
    const jobDir = join(await realpath(options.jobsDir), request.jobName);
    if (
      await access(jobDir).then(
        () => true,
        () => false,
      )
    )
      throw new Error(`Job directory already exists: ${jobDir}`);
    await access(setsidPath);
    const argv = buildArgv(request);
    const remaining = request.deadlineMs - now();
    if (remaining <= 0) throw new Error("Deadline already passed.");
    request.signal?.throwIfAborted();
    const startedAt = new Date(now()).toISOString();
    const proc = Bun.spawn([setsidPath, ...argv], {
      cwd: options.jobsDir,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: {
        ...baseEnv,
        PYTHONPATH:
          options.agentPythonPath +
          (baseEnv.PYTHONPATH ? `:${baseEnv.PYTHONPATH}` : ""),
        PYTHONUNBUFFERED: "1",
        HARBOR_NO_TELEMETRY: "1",
        MARS_EVALUATION_ARM: request.arm,
      },
    });
    request.onSpawn?.(proc.pid);
    let killed: HarborRunOutcome["killed"] = null;
    const killTree = (reason: NonNullable<HarborRunOutcome["killed"]>) => {
      if (killed) return;
      killed = reason;
      try {
        process.kill(-proc.pid, "SIGTERM");
      } catch {
        proc.kill("SIGTERM");
      }
      const escalate = setTimeout(() => {
        try {
          process.kill(-proc.pid, "SIGKILL");
        } catch {
          proc.kill("SIGKILL");
        }
      }, 5000);
      escalate.unref();
      void proc.exited.finally(() => clearTimeout(escalate));
    };
    const deadline = setTimeout(() => killTree("deadline"), remaining);
    deadline.unref();
    const onAbort = () => killTree("cancelled");
    request.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        readStream(proc.stdout, 16 * 1024),
        readStream(proc.stderr, 16 * 1024),
        proc.exited,
      ]);
      return {
        job_dir: jobDir,
        argv,
        exit_code: killed ? null : exitCode,
        signal: proc.signalCode === null ? null : String(proc.signalCode),
        killed,
        started_at: startedAt,
        finished_at: new Date(now()).toISOString(),
        stdout_tail: stdout,
        stderr_tail: stderr,
      };
    } finally {
      clearTimeout(deadline);
      request.signal?.removeEventListener("abort", onAbort);
    }
  }

  return { probe, verifyPins, verifyRegistry, verifyImages, buildArgv, run };
}
export type HarborRunner = ReturnType<typeof createHarborRunner>;
