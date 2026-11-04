import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { ScopeSchema } from "@mars/contracts";
import { z } from "zod";

export const MAX_CONNECTION_FILE_BYTES = 16 * 1024;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;
const ConnectionFileSchema = z
  .object({
    schema_version: z.literal(1),
    url: z.string().max(256),
    token: z.string(),
    scope: z
      .object({
        owner_id: ScopeSchema.shape.owner_id,
        project_id: ScopeSchema.shape.project_id,
      })
      .strict(),
  })
  .strict();

export type LocalConnection = {
  url: string;
  token: string;
  scope: { owner_id: string; project_id: string };
};

export type ConnectionResult =
  | { ok: true; connection: LocalConnection }
  | { ok: false; reason: string };

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "[::1]") return true;
  const parts = host.split(".");
  return (
    parts.length === 4 &&
    parts[0] === "127" &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  );
}

export function parseConnectionFile(bytes: Uint8Array): ConnectionResult {
  if (bytes.byteLength > MAX_CONNECTION_FILE_BYTES)
    return { ok: false, reason: "Connection file is larger than 16 KiB." };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: "Connection file is not valid UTF-8." };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: "Connection file is not valid JSON." };
  }
  const parsed = ConnectionFileSchema.safeParse(raw);
  if (!parsed.success)
    return {
      ok: false,
      reason:
        "Connection file must contain exactly schema_version 1, url, token and scope {owner_id, project_id}.",
    };
  const file = parsed.data;
  if (!TOKEN_PATTERN.test(file.token))
    return {
      ok: false,
      reason: "Connection file token has an invalid format.",
    };
  let url: URL;
  try {
    url = new URL(file.url);
  } catch {
    return { ok: false, reason: "Connection file url is not a valid URL." };
  }
  if (url.protocol !== "http:" || !isLoopbackHost(url.hostname))
    return {
      ok: false,
      reason: "Connection file url must use http on a loopback address.",
    };
  if (url.username || url.password || url.search || url.hash)
    return {
      ok: false,
      reason:
        "Connection file url must not contain credentials, a query or a fragment.",
    };
  if (url.pathname !== "/" || file.url.includes("?") || file.url.includes("#"))
    return {
      ok: false,
      reason: "Connection file url must be a root URL with no path.",
    };
  return {
    ok: true,
    connection: { url: url.origin, token: file.token, scope: file.scope },
  };
}

export type FileRead =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: string };

export async function readConnectionFile(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<FileRead> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      filePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
  } catch {
    return { ok: false, reason: "Could not open the connection file." };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile())
      return { ok: false, reason: "Connection file is not a regular file." };
    if (platform !== "win32" && (info.mode & 0o077) !== 0)
      return {
        ok: false,
        reason:
          "Connection file is accessible to other users. Restrict it with chmod 600 and try again.",
      };
    if (info.size > MAX_CONNECTION_FILE_BYTES)
      return { ok: false, reason: "Connection file is larger than 16 KiB." };
    const buffer = new Uint8Array(MAX_CONNECTION_FILE_BYTES + 1);
    let total = 0;
    while (total < buffer.byteLength) {
      const { bytesRead } = await handle.read(
        buffer,
        total,
        buffer.byteLength - total,
        null,
      );
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > MAX_CONNECTION_FILE_BYTES)
      return { ok: false, reason: "Connection file is larger than 16 KiB." };
    return { ok: true, bytes: buffer.slice(0, total) };
  } catch {
    return { ok: false, reason: "Could not read the connection file." };
  } finally {
    await handle.close().catch(() => {});
  }
}

export type ConnectionOptions = {
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
};

export async function resolveConnection(
  options: ConnectionOptions = {},
): Promise<ConnectionResult> {
  const args = options.argv ?? process.argv.slice(2);
  const argument = args.find((value) => value.startsWith("--connection="));
  const explicitPath =
    argument?.slice("--connection=".length) ||
    (options.env ?? process.env).MARS_SHELL_CONNECTION;
  let filePath = explicitPath;
  if (!filePath) {
    const home = options.homeDir ?? process.env.HOME ?? "";
    let paths: string[];
    try {
      const entries = await readdir(join(home, ".mars", "workbench"), {
        withFileTypes: true,
      });
      const candidates = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) =>
          join(home, ".mars", "workbench", entry.name, "connection.json"),
        );
      paths = (
        await Promise.all(
          candidates.map(async (path) => {
            try {
              return (await lstat(path)).isFile() ? path : undefined;
            } catch {
              return undefined;
            }
          }),
        )
      ).filter((path): path is string => path !== undefined);
    } catch {
      paths = [];
    }
    if (paths.length === 0)
      return {
        ok: false,
        reason:
          "No workbench connection file found. Start `mars serve` or pass --connection=PATH.",
      };
    if (paths.length > 1)
      return {
        ok: false,
        reason: "Several workbench connections found; pass --connection=PATH.",
      };
    filePath = paths[0];
  }
  if (!filePath)
    return { ok: false, reason: "Could not open the connection file." };
  const file = await readConnectionFile(filePath);
  if (!file.ok) return file;
  return parseConnectionFile(file.bytes);
}
