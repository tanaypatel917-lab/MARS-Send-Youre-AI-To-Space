import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isLocalDockerHost } from "../../../../packages/workspaces/src/docker-host";

const exec = promisify(execFile);

async function inspectHost(path: string): Promise<string> {
  const result = await exec(
    path,
    ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
    { timeout: 5000, maxBuffer: 16384 },
  );
  return result.stdout.trim();
}

export async function resolveDockerHost(
  dockerPath: string | undefined,
  options: {
    env?: NodeJS.ProcessEnv;
    inspect?: (path: string) => Promise<string>;
  } = {},
): Promise<string | undefined> {
  const env = options.env ?? process.env;
  let host = env.DOCKER_HOST;
  if (host === undefined && dockerPath) {
    try {
      host = await (options.inspect ?? inspectHost)(dockerPath);
    } catch {
      return undefined;
    }
  }
  return host !== undefined && isLocalDockerHost(host) ? host : undefined;
}
