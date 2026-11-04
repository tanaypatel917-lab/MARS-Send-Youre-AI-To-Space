import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { ScopeSchema } from "@mars/contracts";
import { z } from "zod";
import { isLoopbackHost } from "./endpoint";

/** Upper bound for a `mars serve` connection.json; real files are ~200 bytes. */
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
  /** Normalized `http://<loopback>[:port]` origin, no trailing slash. */
  url: string;
  token: string;
  scope: { owner_id: string; project_id: string };
}

export type ConnectionParse =
  | { ok: true; connection: LocalConnection }
  | { ok: false; reason: string };

function fail(reason: string): ConnectionParse {
  return { ok: false, reason };
}

/**
 * Strictly parses a `mars serve` connection file. Error reasons are fixed
 * strings: they never echo file content, so the token cannot leak through them.
 */
export function parseConnectionFile(bytes: Uint8Array): ConnectionParse {
  if (bytes.byteLength > MAX_CONNECTION_FILE_BYTES)
    return fail("Connection file is larger than 16 KiB.");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail("Connection file is not valid UTF-8.");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail("Connection file is not valid JSON.");
  }
  const parsed = ConnectionFileSchema.safeParse(raw);
  if (!parsed.success)
    return fail(
      "Connection file must contain exactly schema_version 1, url, token and scope {owner_id, project_id}.",
    );
  const file = parsed.data;
  if (!TOKEN_PATTERN.test(file.token))
    return fail("Connection file token has an invalid format.");
  let url: URL;
  try {
    url = new URL(file.url);
  } catch {
    return fail("Connection file url is not a valid URL.");
  }
  if (url.protocol !== "http:")
    return fail("Connection file url must use http on a loopback address.");
  if (!isLoopbackHost(url.hostname))
    return fail("Connection file url must be a loopback address.");
  if (url.username || url.password || url.search || url.hash)
    return fail(
      "Connection file url must not contain credentials, a query or a fragment.",
    );
  if (url.pathname !== "/" || file.url.includes("?") || file.url.includes("#"))
    return fail("Connection file url must be a root URL with no path.");
  return {
    ok: true,
    connection: { url: url.origin, token: file.token, scope: file.scope },
  };
}

export type FileRead =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: string };

/**
 * Reads at most `maxBytes` from a regular file. On POSIX the file must not be
 * readable or writable by group/others, matching the mode 0600 `mars serve` uses.
 */
export async function readConnectionFile(
  fsPath: string,
  maxBytes = MAX_CONNECTION_FILE_BYTES,
  platform: NodeJS.Platform = process.platform,
): Promise<FileRead> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      fsPath,
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
    if (info.size > maxBytes)
      return { ok: false, reason: "Connection file is larger than 16 KiB." };
    const buffer = new Uint8Array(maxBytes + 1);
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
    if (total > maxBytes)
      return { ok: false, reason: "Connection file is larger than 16 KiB." };
    return { ok: true, bytes: buffer.slice(0, total) };
  } catch {
    return { ok: false, reason: "Could not read the connection file." };
  } finally {
    await handle.close().catch(() => {});
  }
}

export interface ImportHost {
  pickFile(): Promise<string | undefined>;
  readFile(fsPath: string): Promise<FileRead>;
  /** `mars.serverUrl` from global (user) settings only; undefined when unset. */
  globalServerUrl(): string | undefined;
  getToken(): Promise<string | undefined>;
  storeToken(token: string): Promise<void>;
  deleteToken(): Promise<void>;
  storeGlobalServerUrl(url: string): Promise<void>;
  confirm(message: string, detail: string, action: string): Promise<boolean>;
  /**
   * Drops the live connection and blocks reconnects until the returned resume
   * is called, so neither token is ever paired with the other server's URL.
   */
  suspendConnections(): () => void;
}

export type ImportOutcome =
  | { status: "imported"; url: string; scope: LocalConnection["scope"] }
  | { status: "cancelled" }
  | { status: "rejected"; reason: string }
  | { status: "failed"; reason: string };

/**
 * Imports a local connection file: token to SecretStorage, URL to global
 * settings, after explicit confirmation when either would replace existing
 * configuration. Outcome messages never contain the token.
 */
export async function importConnection(
  host: ImportHost,
): Promise<ImportOutcome> {
  const fsPath = await host.pickFile();
  if (!fsPath) return { status: "cancelled" };
  const read = await host.readFile(fsPath);
  if (!read.ok) return { status: "rejected", reason: read.reason };
  const parsed = parseConnectionFile(read.bytes);
  if (!parsed.ok) return { status: "rejected", reason: parsed.reason };
  const { connection } = parsed;
  const previousUrl = host.globalServerUrl();
  const previousToken = await host.getToken();
  const urlChanges =
    previousUrl !== undefined &&
    previousUrl.replace(/\/+$/, "") !== connection.url;
  if (previousToken !== undefined || urlChanges) {
    const detail = [
      `Server URL: ${previousUrl ?? "(default)"} → ${connection.url}`,
      previousToken !== undefined
        ? "The stored MARS token will be replaced."
        : "A MARS token will be stored in Secret Storage.",
      `Owner: ${connection.scope.owner_id}`,
      `Project: ${connection.scope.project_id}`,
    ].join("\n");
    if (
      !(await host.confirm(
        "Replace your MARS connection settings?",
        detail,
        "Replace",
      ))
    )
      return { status: "cancelled" };
  }
  const resume = host.suspendConnections();
  try {
    return await storeConnection(host, connection, previousToken);
  } finally {
    resume();
  }
}

async function storeConnection(
  host: ImportHost,
  connection: LocalConnection,
  previousToken: string | undefined,
): Promise<ImportOutcome> {
  try {
    await host.storeToken(connection.token);
  } catch {
    return { status: "failed", reason: "Could not save the token." };
  }
  try {
    await host.storeGlobalServerUrl(connection.url);
  } catch {
    return {
      status: "failed",
      reason: `Could not save the server URL; ${await rollBackToken(host, previousToken)}`,
    };
  }
  return { status: "imported", url: connection.url, scope: connection.scope };
}

async function rollBackToken(
  host: ImportHost,
  previousToken: string | undefined,
): Promise<string> {
  try {
    if (previousToken !== undefined) {
      await host.storeToken(previousToken);
      return "the previous token was restored.";
    }
    await host.deleteToken();
    return "the new token was removed.";
  } catch {
    return "the stored token could not be rolled back, re-import the connection file.";
  }
}
