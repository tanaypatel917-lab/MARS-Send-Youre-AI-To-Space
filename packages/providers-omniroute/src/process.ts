import { type FetchLike, probeOmniRoute } from "./health";
import { OMNIROUTE_PIN } from "./pin";
import {
  isLoopbackUrl,
  OMNIROUTE_DEFAULT_URL,
  omnirouteBaseUrl,
} from "./provider";

/** Minimal process handle so tests can inject a fake instead of spawning. */
export interface SpawnedProcess {
  pid: number;
  exited: Promise<number>;
  kill(signal: "SIGTERM" | "SIGKILL"): void;
}

export interface SpawnRequest {
  command: string[];
  env: Record<string, string>;
}

export type SpawnLike = (request: SpawnRequest) => SpawnedProcess;
export type RunLike = (
  request: SpawnRequest,
) => Promise<{ code: number; stdout: string }>;

export type OmniRouteProcessMode = "attach" | "start";

export interface OmniRouteProcessOptions {
  /** `attach` only uses an already running instance; `start` spawns one when none answers. */
  mode: OmniRouteProcessMode;
  url?: string;
  /** Executable and arguments; defaults to the `omniroute` CLI on PATH. */
  command?: string[];
  /** Version the `--version` output must contain before MARS starts it. */
  version?: string;
  allowVersionMismatch?: boolean;
  env?: Record<string, string | undefined>;
  apiKeyEnv?: string;
  fetch?: FetchLike;
  spawn?: SpawnLike;
  run?: RunLike;
  startupTimeoutMs?: number;
  pollMs?: number;
  shutdownGraceMs?: number;
  log?: (event: OmniRouteProcessEvent) => void;
}

export type OmniRouteProcessEvent =
  | { type: "attached"; url: string }
  | { type: "spawned"; url: string; pid: number; version: string }
  | { type: "ready"; url: string }
  | { type: "stopped"; url: string; code: number | null };

export interface OmniRouteProcessStatus {
  mode: OmniRouteProcessMode;
  url: string;
  attached: boolean;
  spawned: boolean;
  pid: number | null;
  running: boolean;
}

export interface OmniRouteProcess {
  start(): Promise<OmniRouteProcessStatus>;
  stop(): Promise<void>;
  status(): OmniRouteProcessStatus;
}

export class OmniRouteProcessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OmniRouteProcessError";
  }
}

/**
 * Only these names reach a spawned OmniRoute. Upstream provider credentials
 * live in OmniRoute's own data directory under HOME; MARS secrets and the
 * rest of the MARS environment are never forwarded.
 */
const ENV_PASSTHROUGH = ["PATH", "HOME", "TMPDIR", "LANG", "DATA_DIR"];

function spawnWithBun(request: SpawnRequest): SpawnedProcess {
  const proc = Bun.spawn(request.command, {
    env: request.env,
    stdin: "ignore",
    // OmniRoute logs may echo provider material; MARS never captures them.
    stdout: "ignore",
    stderr: "ignore",
  });
  return {
    pid: proc.pid,
    exited: proc.exited,
    kill: (signal) => proc.kill(signal),
  };
}

async function runWithBun(
  request: SpawnRequest,
): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn(request.command, {
    env: request.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const stdout = await new Response(proc.stdout).text();
  return { code: await proc.exited, stdout };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createOmniRouteProcess(
  options: OmniRouteProcessOptions,
): OmniRouteProcess {
  const url = omnirouteBaseUrl(options.url ?? OMNIROUTE_DEFAULT_URL);
  const origin = new URL(url);
  const version = options.version ?? OMNIROUTE_PIN.version;
  const command = options.command ?? ["omniroute"];
  const spawn = options.spawn ?? spawnWithBun;
  const run = options.run ?? runWithBun;
  const env = options.env ?? process.env;
  const log = options.log ?? (() => {});
  let child: SpawnedProcess | undefined;
  let attached = false;
  let running = false;
  let exitCode: number | null = null;

  const probeOptions = {
    url,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    env,
    ...(options.apiKeyEnv ? { apiKeyEnv: options.apiKeyEnv } : {}),
    timeoutMs: 1_000,
  };

  const status = (): OmniRouteProcessStatus => ({
    mode: options.mode,
    url,
    attached,
    spawned: child !== undefined,
    pid: child?.pid ?? null,
    running,
  });

  function childEnv(): Record<string, string> {
    const forwarded: Record<string, string> = {};
    for (const name of ENV_PASSTHROUGH) {
      const value = env[name];
      if (value !== undefined) forwarded[name] = value;
    }
    return {
      ...forwarded,
      PORT: origin.port || "80",
      HOST: "127.0.0.1",
      HOSTNAME: "127.0.0.1",
    };
  }

  async function start(): Promise<OmniRouteProcessStatus> {
    if (running) return status();
    const existing = await probeOmniRoute(probeOptions);
    if (existing.reachable) {
      attached = true;
      running = true;
      log({ type: "attached", url });
      return status();
    }
    if (options.mode === "attach")
      throw new OmniRouteProcessError(
        `No OmniRoute instance answers at ${url}; start one or use --omniroute-start.`,
      );
    if (!isLoopbackUrl(url))
      throw new OmniRouteProcessError(
        "MARS only starts OmniRoute on a loopback address.",
      );
    const check = await run({
      command: [...command, "--version"],
      env: childEnv(),
    });
    if (
      !options.allowVersionMismatch &&
      (check.code !== 0 || !check.stdout.includes(version))
    )
      throw new OmniRouteProcessError(
        `"${command.join(" ")} --version" did not report the pinned OmniRoute ${version}; install omniroute@${version} or pass allowVersionMismatch.`,
      );
    child = spawn({ command, env: childEnv() });
    running = true;
    log({ type: "spawned", url, pid: child.pid, version });
    const exited = child.exited.then((code) => {
      running = false;
      exitCode = code;
      log({ type: "stopped", url, code });
      return code;
    });
    const deadline = Date.now() + (options.startupTimeoutMs ?? 30_000);
    while (Date.now() < deadline) {
      if (!running)
        throw new OmniRouteProcessError(
          `OmniRoute exited during startup with code ${exitCode}.`,
        );
      const probe = await probeOmniRoute(probeOptions);
      if (probe.reachable) {
        log({ type: "ready", url });
        return status();
      }
      await sleep(options.pollMs ?? 250);
    }
    await stop();
    await exited.catch(() => undefined);
    throw new OmniRouteProcessError(
      `OmniRoute did not answer at ${url} within the startup timeout.`,
    );
  }

  async function stop(): Promise<void> {
    if (!child) {
      running = false;
      return;
    }
    if (running) {
      child.kill("SIGTERM");
      const grace = options.shutdownGraceMs ?? 5_000;
      const settled = await Promise.race([
        child.exited.then(() => true),
        sleep(grace).then(() => false),
      ]);
      if (!settled) {
        child.kill("SIGKILL");
        await child.exited;
      }
    }
    running = false;
  }

  return { start, stop, status };
}
