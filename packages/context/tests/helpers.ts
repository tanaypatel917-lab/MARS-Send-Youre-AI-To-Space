import { afterEach } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { RequestContext, WorkspaceRef } from "@mars/contracts";
import { createRepositoryMapProvider } from "../src";
import type { RepositoryMapProviderOptions } from "../src/types";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

export async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mars-context-"));
  roots.push(root);
  return root;
}

export async function putFile(
  root: string,
  path: string,
  contents: string | Uint8Array,
): Promise<void> {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents);
}

export const workspace: WorkspaceRef = {
  workspace_id: "ws-1",
  provider: "local",
  revision: "rev-1",
};

export const context: RequestContext = {
  schema_version: 1,
  scope: {
    owner_id: "owner-1",
    project_id: "project-1",
    workspace_id: "ws-1",
  },
  request_id: "request-1",
};

export function providerFor(
  root: string,
  options: Omit<RepositoryMapProviderOptions, "resolveRoot"> = {},
) {
  return createRepositoryMapProvider({
    ...options,
    resolveRoot: async (_context, selectedWorkspace) => ({
      root,
      revision: selectedWorkspace.revision,
    }),
  });
}
