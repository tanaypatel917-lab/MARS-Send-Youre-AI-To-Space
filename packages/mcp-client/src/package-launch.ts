import { realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import {
  canonicalJSON,
  IntegrationTrustError,
  sha256,
} from "@mars/integration-trust";
import { type McpPackageStore, within } from "./package-store";
import type { StdioTransportConfig } from "./schemas";
import { resolveStdioExecutable } from "./transports";

export function reapprovalMessage(id: string) {
  return `“${id}” is paused. Its old approval did not say which files are programs and which hold your data. Run mars mcp reapprove ${id} to choose once and turn it back on.`;
}

export class McpReapprovalRequired extends IntegrationTrustError {
  constructor(id: string) {
    super("reapproval_required");
    this.message = reapprovalMessage(id);
  }
}

/** Do not collapse symlink/.. before the filesystem follows the link. */
export function fromCwd(cwd: string, path: string) {
  return isAbsolute(path) ? path : `${cwd}${sep}${path}`;
}

export async function preparePackageLaunch(
  id: string,
  config: StdioTransportConfig,
  store?: McpPackageStore,
  signal?: AbortSignal,
) {
  if (!config.launch) throw new McpReapprovalRequired(id);
  if (!process.getuid)
    throw new Error(
      "Protected local MCP servers require a POSIX host; this server was not started.",
    );
  if (!store) throw new IntegrationTrustError("store_location_unsafe");
  const packages = store;
  const { arguments: roles, command_root } = config.launch;
  if (roles.length !== config.args.length)
    throw new Error("Choose a purpose for every server argument.");
  const cwd = await realpath(config.cwd ?? process.cwd());
  const command = resolveStdioExecutable(config);
  const exclude = config.args.flatMap((arg, i) =>
    roles[i] === "data" ? [fromCwd(cwd, arg)] : [],
  );
  const revisions = new Map<
    string,
    Awaited<ReturnType<McpPackageStore["inspect"]>>
  >();
  const bindings: { sha: string; name: string }[] = [];
  const sources = new Set<string>();
  async function pin(raw: string, root?: string | null) {
    const actual = await realpath(raw);
    const lexical = join(await realpath(dirname(raw)), basename(raw));
    const path = root ? await realpath(fromCwd(cwd, root)) : lexical;
    const name = root
      ? relative(path, within(path, lexical) ? lexical : actual)
      : basename(path);
    if (
      !name ||
      !within(path, join(path, name)) ||
      !(await stat(actual)).isFile()
    )
      throw new Error("Choose a package folder containing the program file.");
    if (root && !(await stat(path)).isDirectory())
      throw new Error("The package folder must be a directory.");
    let rev = revisions.get(path);
    if (!rev) {
      rev = await packages.inspect(
        { path, externalExecutable: command, exclude },
        signal,
      );
      revisions.set(path, rev);
    }
    bindings.push({ sha: rev.sha, name });
    sources.add(actual);
    return join(rev.directory, name);
  }
  const pinnedCommand = await pin(command, command_root);
  let pinnedCwd: string | undefined;
  if (config.launch.pin_cwd) {
    if (!config.cwd)
      throw new Error("Select a working folder before protecting it.");
    const path = await realpath(config.cwd);
    const rev =
      revisions.get(path) ??
      (await packages.inspect(
        { path, externalExecutable: command, exclude },
        signal,
      ));
    revisions.set(path, rev);
    bindings.push({ sha: rev.sha, name: "." });
    pinnedCwd = rev.directory;
  }
  const args: string[] = [];
  for (const [i, arg] of config.args.entries()) {
    const role = roles[i];
    args.push(
      typeof role === "object"
        ? await pin(fromCwd(cwd, arg), role.code)
        : role === "data" && pinnedCwd
          ? fromCwd(cwd, arg)
          : arg,
    );
  }
  if (
    config.entrypoint &&
    !sources.has(await realpath(fromCwd(cwd, config.entrypoint)))
  )
    throw new Error(
      "Select the entrypoint as the program or a program-file argument.",
    );
  return {
    executable: command,
    sha: sha256(canonicalJSON({ version: 1, bindings, command })),
    config: {
      ...config,
      command: pinnedCommand,
      args,
      ...(pinnedCwd ? { cwd: pinnedCwd } : {}),
    },
    install: async () => {
      for (const rev of revisions.values()) await rev.install();
    },
    verifyPublished: async () => {
      for (const [i, path] of args.entries()) {
        const role = roles[i];
        if (
          typeof role === "object" &&
          role.sha256 &&
          new Bun.CryptoHasher("sha256")
            .update(await Bun.file(path).arrayBuffer())
            .digest("hex") !== role.sha256
        )
          throw new IntegrationTrustError("drift");
      }
    },
  };
}
