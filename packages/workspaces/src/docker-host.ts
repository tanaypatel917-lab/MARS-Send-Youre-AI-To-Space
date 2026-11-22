import { posix } from "node:path";

export function isLocalDockerHost(
  host: string,
  platform: string = process.platform,
): boolean {
  if (/[\0\r\n?#]/.test(host)) return false;
  if (host.startsWith("unix://")) return posix.isAbsolute(host.slice(7));
  return platform === "win32" && /^npipe:\/\/\/\/\.\/pipe\/[^/]+$/.test(host);
}
