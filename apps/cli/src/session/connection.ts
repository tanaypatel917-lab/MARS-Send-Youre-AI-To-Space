import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { ScopeSchema } from "@mars/contracts";
import { z } from "zod";

/** Strict reader for the private `connection.json` that `mars serve` writes (same rules as the VS Code client). */
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

export interface LocalConnection {
  url: string;
  token: string;
  scope: { owner_id: string; project_id: string };
}

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host)
  );
}

export function parseConnectionFile(bytes: Uint8Array): LocalConnection {
  if (bytes.byteLength > MAX_CONNECTION_FILE_BYTES)
    throw new Error("Connection file is larger than 16 KiB.");
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("Connection file is not valid UTF-8 JSON.");
  }
  const parsed = ConnectionFileSchema.safeParse(raw);
  if (!parsed.success)
    throw new Error(
      "Connection file must contain exactly schema_version 1, url, token and scope {owner_id, project_id}.",
    );
  const file = parsed.data;
  if (!TOKEN_PATTERN.test(file.token))
    throw new Error("Connection file token has an invalid format.");
  let url: URL;
  try {
    url = new URL(file.url);
  } catch {
    throw new Error("Connection file url is not a valid URL.");
  }
  if (url.protocol !== "http:" || !isLoopbackHost(url.hostname))
    throw new Error("Connection file url must use http on a loopback address.");
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    file.url.includes("?") ||
    file.url.includes("#")
  )
    throw new Error(
      "Connection file url must be a root URL with no credentials, path, query or fragment.",
    );
  return { url: url.origin, token: file.token, scope: file.scope };
}

export async function readConnectionFile(
  path: string,
  platform: NodeJS.Platform = process.platform,
): Promise<LocalConnection> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    throw new Error(
      `Could not open the connection file ${path} · run mars serve`,
    );
  }
  try {
    const info = await handle.stat();
    if (!info.isFile())
      throw new Error("Connection file is not a regular file.");
    if (platform !== "win32" && (info.mode & 0o077) !== 0)
      throw new Error(
        "Connection file is accessible to other users · restrict it with chmod 600",
      );
    if (info.size > MAX_CONNECTION_FILE_BYTES)
      throw new Error("Connection file is larger than 16 KiB.");
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
    return parseConnectionFile(buffer.slice(0, total));
  } finally {
    await handle.close().catch(() => {});
  }
}
