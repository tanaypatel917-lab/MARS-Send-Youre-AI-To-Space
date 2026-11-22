import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  type ConnectionResult,
  loadConnectionFile,
} from "@mars/contracts/connection-file";
import { findExtension } from "../runtime/extension-catalog";
import {
  type CatalogStatus,
  EXPIRED_PREFIX,
  ExtensionReply,
  type OperatorAction,
  REPLY_PREFIX,
} from "../runtime/extension-wire";

type WorkbenchOptions = {
  resources: string;
  source: string;
  state: string;
  openRouterKey?: string;
  image?: string;
  checksFile?: string;
  dockerPath?: string;
  verificationUnavailableReason?: string;
  onExpired?: (name: string) => void;
  extensionTimeoutMs?: number;
};

const unavailable: ConnectionResult = {
  ok: false,
  reason:
    "The local workbench couldn’t start. Retry or choose another project folder from the Project menu.",
};

export function startLocalWorkbench(options: WorkbenchOptions) {
  const child = spawn(
    join(options.resources, "bun"),
    [
      "--no-env-file",
      join(
        options.resources,
        "apps",
        "shell",
        "src",
        "runtime",
        "workbench.ts",
      ),
    ],
    {
      cwd: options.resources,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  child.stdin.on("error", () => {});
  child.stderr.resume();
  const messages = createInterface({ input: child.stdout, terminal: false });
  const ready = Promise.withResolvers<boolean>();
  const exited = Promise.withResolvers<void>();
  let pending:
    | { token: string; finish(value: CatalogStatus | null): void }
    | undefined;
  let stopping = false;
  const timer = setTimeout(() => {
    ready.resolve(false);
    child.kill("SIGKILL");
  }, 20_000);
  messages.on("line", (line) => {
    if (line === "MARS_WORKBENCH_READY") {
      clearTimeout(timer);
      ready.resolve(true);
    } else if (line.startsWith(EXPIRED_PREFIX)) {
      const entry = findExtension(line.slice(EXPIRED_PREFIX.length));
      if (!stopping && entry?.kind === "mcp") options.onExpired?.(entry.name);
    } else if (pending && line.startsWith(REPLY_PREFIX)) {
      try {
        const reply = ExtensionReply.parse(
          JSON.parse(line.slice(REPLY_PREFIX.length)),
        );
        if (reply.token === pending.token) pending.finish(reply.status);
      } catch {
        /* Ignore unrelated child output. */
      }
    }
  });
  const onExit = () => {
    clearTimeout(timer);
    ready.resolve(false);
    exited.resolve();
    pending?.finish(null);
  };
  child.once("error", onExit);
  child.once("close", onExit);
  const connectionPath = (async () => {
    try {
      const source = await realpath(options.source);
      const id = createHash("sha256").update(source).digest("hex").slice(0, 24);
      const state = join(options.state, `desktop-${id}`);
      child.stdin.write(
        `${JSON.stringify({ source, state, openRouterKey: options.openRouterKey, image: options.image, checksFile: options.checksFile, dockerPath: options.dockerPath, verificationUnavailableReason: options.verificationUnavailableReason })}\n`,
      );
      return join(state, "connection.json");
    } catch {
      child.stdin.end();
      return undefined;
    }
  })();

  async function send(request: OperatorAction): Promise<CatalogStatus> {
    if (
      !(await ready.promise) ||
      stopping ||
      child.exitCode !== null ||
      child.signalCode ||
      pending
    )
      throw new Error("Extensions are unavailable.");
    return new Promise((resolve, reject) => {
      const token = randomUUID();
      const deadline = setTimeout(() => {
        // Stop waiting, not the task service. Keep this token as a fence:
        // no second mutation can start until the late reply or child exit.
        reject(
          new Error(
            "Catalog response timed out; installation status is unknown.",
          ),
        );
      }, options.extensionTimeoutMs ?? 60_000);
      const finish = (value: CatalogStatus | null) => {
        if (pending?.token !== token) return;
        clearTimeout(deadline);
        pending = undefined;
        if (value === null)
          reject(new Error("Could not verify or apply extension."));
        else resolve(value);
      };
      pending = { token, finish };
      child.stdin.write(`${JSON.stringify({ token, request })}\n`, (error) => {
        if (error) finish(null);
      });
    });
  }
  let tail = Promise.resolve();
  let listing: Promise<CatalogStatus> | undefined;
  return {
    exited: exited.promise,
    extensionAction(request: OperatorAction) {
      if (request.action === "list" && listing) return listing;
      const result = tail.then(() => send(request));
      tail = result
        .then(
          () => {},
          () => {},
        )
        .finally(() => {
          if (listing === result) listing = undefined;
        });
      listing = request.action === "list" ? result : undefined;
      return result;
    },
    async connection(): Promise<ConnectionResult> {
      if (!(await ready.promise) || child.exitCode !== null || child.signalCode)
        return unavailable;
      const path = await connectionPath;
      return path ? loadConnectionFile(path) : unavailable;
    },
    async stop(): Promise<void> {
      stopping = true;
      child.stdin.end();
      const deadline = setTimeout(() => child.kill("SIGKILL"), 7500);
      try {
        await exited.promise;
      } finally {
        clearTimeout(deadline);
      }
    },
  };
}
