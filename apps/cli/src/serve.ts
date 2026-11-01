import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { registerRuntimeCleanup } from "@mars/execution";
import { createWorkbenchService } from "@mars/workbench";

export async function runServer(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      source: { type: "string" },
      state: { type: "string" },
      port: { type: "string" },
      owner: { type: "string" },
      project: { type: "string" },
      image: { type: "string" },
      "trust-project": { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "Usage: mars serve [--source DIR] [--state PRIVATE_DIR] [--port 7331] [--owner ID] [--project ID] [--image REPO@sha256:DIGEST] [--trust-project]\nWithout a pre-pulled digest-pinned image, command execution is disabled. No model request is made at startup. Connection credentials are written only to the private connection file.",
    );
    return;
  }
  const source = await realpath(resolve(values.source ?? process.cwd()));
  const project =
    values.project ??
    `project-${createHash("sha256").update(source).digest("hex").slice(0, 24)}`;
  const state = resolve(
    values.state ?? join(homedir(), ".mars", "workbench", project),
  );
  const service = await createWorkbenchService({
    sourceRoot: source,
    stateRoot: state,
    scope: { owner_id: values.owner ?? "local", project_id: project },
    port: values.port === undefined ? 7331 : Number(values.port),
    ...(values.image ? { image: values.image } : {}),
    trustProjectConfig:
      values["trust-project"] === true ||
      process.env.MARS_TRUST_PROJECT_CONFIG === "1",
  });
  await new Promise<void>((resolve, reject) => {
    registerRuntimeCleanup("mars-workbench", async () => {
      try {
        await service.close();
        resolve();
      } catch {
        reject(new Error("Workbench shutdown failed."));
      }
    });
    console.log(
      JSON.stringify({
        status: "listening",
        url: service.url,
        connection_file: service.connectionFile,
        execute_enabled: Boolean(values.image),
      }),
    );
  });
}
