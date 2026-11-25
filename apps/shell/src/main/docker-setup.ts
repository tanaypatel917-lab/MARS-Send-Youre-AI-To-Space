export function dockerPullOptions(
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
      PATH: env.PATH,
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
