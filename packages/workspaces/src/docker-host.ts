import { isAbsolute, posix } from "node:path";

export function isSafeDockerWorkspacePath(path: string): boolean {
  return (
    isAbsolute(path) &&
    /^[A-Za-z0-9._/ -]+$/.test(path) &&
    !path.split("/").includes("..")
  );
}

export function isLocalDockerHost(
  host: string,
  platform: string = process.platform,
): boolean {
  if (/[\0\r\n?#]/.test(host)) return false;
  if (host.startsWith("unix://")) return posix.isAbsolute(host.slice(7));
  return platform === "win32" && /^npipe:\/\/\/\/\.\/pipe\/[^/]+$/.test(host);
}
