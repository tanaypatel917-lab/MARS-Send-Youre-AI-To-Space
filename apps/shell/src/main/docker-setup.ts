import { VERIFICATION_SANDBOX_SETUP } from "@mars/contracts";
import type { LocalConnection } from "@mars/contracts/connection-file";
import { type Bridge, createBridge } from "./bridge";
import { dockerHelperPath } from "./docker-path";
import { ResultSchema } from "./protocol";
import { createLoopbackTransport } from "./transport";

export function dockerPullOptions(
  executable: string,
  dockerHost: string | undefined,
  home: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const defaultHost =
    process.platform === "win32"
      ? "npipe:////./pipe/docker_engine"
      : "unix:///var/run/docker.sock";
  return {
    args: ["--host", dockerHost ?? defaultHost],
    env: {
      PATH: dockerHelperPath(executable, env.PATH),
      HOME: home,
      ...(env.DOCKER_CONFIG ? { DOCKER_CONFIG: env.DOCKER_CONFIG } : {}),
    },
  };
}

export async function ensureDockerImage(
  image: string,
  run: (args: string[]) => Promise<boolean>,
  confirmPull: () => Promise<boolean>,
) {
  if (await run(["image", "inspect", image])) return "present";
  if (!(await confirmPull())) return "cancelled";
  return (await run(["pull", image])) ? "downloaded" : "failed";
}

export function sandboxStatusBridge(connection: LocalConnection) {
  return createBridge({
    transport: createLoopbackTransport(connection),
    connectionScope: connection.scope,
  });
}

export async function sandboxRefreshState(
  bridge: Bridge,
  dockerChanged = false,
) {
  const description = await bridge.call("workbench.describe", {});
  if (!description.ok) return "unknown";
  const parsed = ResultSchema["workbench.describe"].safeParse(
    description.result,
  );
  if (!parsed.success) return "unknown";
  const readiness = parsed.data.verification_readiness;
  if (readiness?.status === "ready" && !dockerChanged) return "ready";
  if (
    readiness?.status !== "ready" &&
    readiness?.setup !== VERIFICATION_SANDBOX_SETUP
  )
    return "unavailable";
  const tasks = await bridge.call("tasks.list", {});
  if (!tasks.ok) return "unknown";
  const listed = ResultSchema["tasks.list"].safeParse(tasks.result);
  if (!listed.success) return "unknown";
  return listed.data.some(({ status }) => status === "running")
    ? "busy"
    : "idle";
}
