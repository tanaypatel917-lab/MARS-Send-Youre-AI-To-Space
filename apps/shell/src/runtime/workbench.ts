import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { loadModelRegistry } from "@mars/providers";
import { createWorkbenchService } from "@mars/workbench";
import { z } from "zod";
import {
  type CatalogStatus,
  EXPIRED_PREFIX,
  ExtensionRequest,
  REPLY_PREFIX,
} from "./extension-wire";
import { projectExtensions } from "./extensions";

const StartSchema = z
  .object({
    source: z.string().min(1),
    state: z.string().min(1),
    openRouterKey: z.string().max(512).optional(),
    image: z.string().min(1).optional(),
    checksFile: z.string().min(1).optional(),
    dockerPath: z.string().min(1).optional(),
  })
  .strict();

async function serve(): Promise<void> {
  const input = createInterface({ input: process.stdin, terminal: false });
  let stop: () => void = () => {};
  const stopped = new Promise<void>((resolve) => {
    stop = resolve;
    input.once("close", resolve);
  });
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    const line = await Promise.race([
      new Promise<string>((resolve) => input.once("line", resolve)),
      stopped,
    ]);
    if (line === undefined) return;
    const { source, state, openRouterKey, image, checksFile, dockerPath } =
      StartSchema.parse(JSON.parse(line));
    const scope = { owner_id: "local", project_id: basename(state) };
    const extensions = projectExtensions(source, state, scope, undefined, {
      onExpired(id) {
        process.stdout.write(`${EXPIRED_PREFIX}${id}\n`);
      },
    });
    const service = await createWorkbenchService({
      sourceRoot: source,
      ...(image ? { image } : {}),
      ...(checksFile ? { checksFile } : {}),
      sandboxDockerPath: dockerPath ?? Bun.which("docker") ?? "/usr/bin/docker",
      allowUnavailableSandbox: true,
      verifiedExportsOnly: Boolean(image),
      stateRoot: state,
      scope,
      mcp: extensions.runtime,
      port: 0,
      registry: await loadModelRegistry({
        cwd: source,
        trustProjectConfig: false,
        env: {
          MARS_HOME: join(state, "desktop-models"),
          OPENROUTER_API_KEY: openRouterKey,
        },
      }),
    });
    // Operator-only control pipe, never exposed as model tools or loopback RPC.
    let pending: Promise<void> | undefined;
    const onCommand = (line: string) => {
      let command: z.infer<typeof ExtensionRequest>;
      try {
        command = ExtensionRequest.parse(JSON.parse(line));
      } catch {
        return;
      }
      const { token, request } = command;
      const reply = (status: CatalogStatus | null) => {
        process.stdout.write(
          `${REPLY_PREFIX}${JSON.stringify({ token, status })}\n`,
        );
      };
      if (pending) {
        reply(null);
        return;
      }
      const run = async (): Promise<CatalogStatus> => {
        const result: CatalogStatus = {
          installed: [],
          expired: [],
          conflicts: [],
        };
        switch (request.action) {
          case "list":
            return extensions.status();
          case "preview-remove":
            return {
              ...result,
              removal: await extensions.previewRemoval(request.id),
            };
          case "remove":
            await extensions.remove(request.id, request.revision);
            return result;
          default:
            await extensions.install(
              request.id,
              request.action === "restore" ? request.revision : undefined,
            );
            return { ...result, installed: [request.id] };
        }
      };
      pending = run()
        .then(reply, () => reply(null))
        .finally(() => {
          pending = undefined;
        });
    };
    input.on("line", onCommand);
    try {
      process.stdout.write("MARS_WORKBENCH_READY\n");
      await stopped;
    } finally {
      input.off("line", onCommand);
      await pending;
      await service.close();
    }
  } finally {
    input.close();
    process.stdin.destroy();
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
}

if (import.meta.main) {
  try {
    await serve();
  } catch {
    process.stderr.write("MARS could not start or stop its local workbench.\n");
    process.exitCode = 1;
  }
}
