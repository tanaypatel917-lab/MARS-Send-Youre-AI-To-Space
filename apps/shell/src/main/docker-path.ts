import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

const fallbackPaths = [
  "/usr/local/bin/docker",
  "/opt/homebrew/bin/docker",
  "/Applications/Docker.app/Contents/Resources/bin/docker",
  "/usr/bin/docker",
];

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function resolveDockerPath(
  options: {
    path?: string;
    isExecutable?: (candidate: string) => boolean;
  } = {},
): string | undefined {
  const candidates = [
    ...(options.path ?? process.env.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .map((directory) => resolve(join(directory, "docker"))),
    ...fallbackPaths,
  ];
  return candidates.find(options.isExecutable ?? isExecutable);
}
