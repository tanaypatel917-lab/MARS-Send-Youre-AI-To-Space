import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { RequestContext, Scope } from "@mars/contracts";
import {
  createHostMcpControlPlane,
  type HostMcpControlPlane,
  type McpServerConfig,
  type TrustedMcpLoader,
  verifyMcpConfig,
} from "@mars/mcp-client";
import { type Operation, SkillStore, withDirectoryLock } from "@mars/skills";
import { catalogSkills, skillRemoval } from "./catalog-skills";
import { CATALOG, type CatalogEntry, findExtension } from "./extension-catalog";
import type { CatalogStatus, Removal } from "./extension-wire";
import { projectRootIdentity, requireProjectRoot } from "./project-root";

const hash = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");

// Created by the managed workbench. Neither the project nor the renderer supplies a
// path, executable, permission manifest, or signing proof.
export function projectExtensions(
  source: string,
  state: string,
  scope: Scope,
  dir = join(import.meta.dir, "catalog"),
  options: { clock?: () => Date; onExpired?: (id: string) => void } = {},
) {
  const notified = new Set<string>();
  const openedRoot = projectRootIdentity(source);
  function notifyExpired(id: string) {
    if (!notified.has(id)) {
      notified.add(id);
      options.onExpired?.(id);
    }
  }
  const store = new SkillStore(join(state, "skills"));
  let opening: Promise<HostMcpControlPlane> | undefined;
  const plane = () => {
    opening ??= createHostMcpControlPlane({
      scope,
      ...(options.clock ? { clock: options.clock } : {}),
      stateDir: join(state, "extension-trust"),
      workspaceRoots: [source, join(state, "workspaces")],
      approvers: [
        {
          approver_id: "desktop-operator",
          owner_id: scope.owner_id,
          project_ids: [scope.project_id],
        },
      ],
    }).catch((error) => {
      opening = undefined;
      throw error;
    });
    return opening;
  };
  const context = (): RequestContext => ({
    schema_version: 1,
    scope,
    request_id: randomUUID(),
  });

  async function artifacts(entry: CatalogEntry) {
    return Promise.all(
      entry.assets.map(async ({ file, sha256 }) => {
        const bytes = await readFile(join(dir, file));
        if (hash(bytes) !== sha256)
          throw new Error("Bundled extension failed verification.");
        return { name: basename(file, ".md"), content: bytes.toString("utf8") };
      }),
    );
  }

  function config(entry: CatalogEntry): McpServerConfig {
    const artifact = entry.assets[0];
    if (!artifact || entry.kind !== "mcp")
      throw new Error("Missing MCP entrypoint.");
    const script = join(dir, artifact.file);
    return {
      schema_version: 1,
      id: entry.id,
      registered_at: new Date().toISOString(),
      transport: {
        type: "stdio",
        command: process.execPath,
        args: [
          "--no-env-file",
          script,
          ...entry.args,
          ...(entry.projectRootArg && openedRoot ? [source, openedRoot] : []),
        ],
        cwd: dir,
        entrypoint: script,
        env_allowlist: [],
      },
      permissions: [entry.tool, ...(entry.additionalTools ?? [])].map(
        (resource) => ({ capability: "tool.invoke", resource }),
      ),
      credential_bindings: [],
    };
  }

  async function registration(cp: HostMcpControlPlane, id: string) {
    const registered = await cp.registry.get(id);
    const { grants } = await cp.admin.inspect(context(), {
      kind: "mcp",
      integration_id: id,
    });
    const grant = grants.findLast((g) => g.state !== "superseded");
    return { registered, grant };
  }
  type Registration = Awaited<ReturnType<typeof registration>>;
  async function mcpStatus(
    cp: HostMcpControlPlane,
    entry: CatalogEntry,
    record?: Registration,
  ) {
    const { registered, grant } = record ?? (await registration(cp, entry.id));
    if (
      entry.kind === "mcp" &&
      entry.projectRootArg &&
      (!openedRoot || projectRootIdentity(source) !== openedRoot)
    )
      return "unavailable";
    if (
      !registered ||
      !isDeepStrictEqual(registered, {
        ...config(entry),
        registered_at: registered.registered_at,
      })
    )
      return "unavailable";
    if (grant?.state !== "approved") return "unavailable";
    if (
      Date.parse(grant.expires_at) <=
      (options.clock?.().getTime() ?? Date.now())
    )
      return "expired";
    try {
      await artifacts(entry);
      await verifyMcpConfig(registered, grant.evidence);
      return "installed";
    } catch {
      return "unavailable";
    }
  }

  async function status(): Promise<CatalogStatus> {
    const { revision, skills, ownership } = await catalogSkills(store);
    const removable = [...ownership.added];
    const result: CatalogStatus = {
      installed: [],
      expired: [],
      conflicts: [],
      removable,
    };
    for (const entry of CATALOG) {
      if (entry.kind === "mcp") {
        const cp = await plane();
        const record = await registration(cp, entry.id);
        if (record.registered) removable.push(entry.id);
        const state = await mcpStatus(cp, entry, record);
        if (state !== "unavailable") result[state].push(entry.id);
      } else if (
        (entry.kind !== "plugin" || ownership.added.includes(entry.id)) &&
        entry.assets.every((asset) =>
          skills.some(
            (skill) =>
              skill.name === basename(asset.file, ".md") &&
              skill.status !== "archived" &&
              hash(skill.content) === asset.sha256,
          ),
        )
      )
        result.installed.push(entry.id);
      else if (
        entry.assets.some((asset) =>
          skills.some(
            (s) =>
              s.name === basename(asset.file, ".md") &&
              s.status !== "archived" &&
              hash(s.content) !== asset.sha256,
          ),
        )
      )
        result.conflicts.push(entry.id);
    }
    if (result.conflicts.length) result.revision = revision;
    return result;
  }

  async function install(id: string, restoreRevision?: string) {
    const entry = findExtension(id);
    if (!entry) throw new Error("Not in the bundled catalog.");
    const contents = await artifacts(entry);
    if (entry.kind !== "mcp") {
      const { skills, revision, ownership } = await catalogSkills(store);
      const expectedRevision = restoreRevision ?? revision;
      const ops: Operation[] = [];
      for (const { name, content } of contents) {
        const existing = skills.find((skill) => skill.name === name);
        if (!existing) ops.push({ op: "create", name, content });
        else if (existing.status === "archived") {
          ops.push({ op: "restore", name });
          if (existing.content !== content)
            ops.push({ op: "update", name, content });
        } else if (existing.content !== content && restoreRevision) {
          ops.push({ op: "update", name, content });
        } else if (existing.content !== content)
          throw new Error(
            "A different skill already uses that name. Confirm restoration first.",
          );
      }
      if (ops.length || !ownership.added.includes(id)) {
        if (!ownership.added.includes(id)) ownership.added.push(id);
        for (const op of ops)
          if (op.op === "create" && !ownership.managed.includes(op.name))
            ownership.managed.push(op.name);
        await store.applyCatalogBatch(
          ops,
          {
            actor: "desktop-operator",
            source: `catalog:${id}@${entry.version}`,
            expectedRevision,
          },
          ownership,
        );
      }
      return;
    }
    const cp = await plane();
    if ((await mcpStatus(cp, entry)) === "installed") return;
    const ctx = context();
    if (entry.projectRootArg) requireProjectRoot(source, openedRoot);
    const server = config(entry);
    const evidence = await cp.probe.observeServer(ctx, server, {
      allowUnapprovedStdioProbe: true,
    });
    const review = await cp.admin.submitCandidate(ctx, {
      evidence,
      permissions: server.permissions,
      credential_bindings: [],
    });
    await cp.registry.upsert(server);
    await cp.admin.approve(ctx, {
      review_id: review.review_id,
      expected_revision: review.revision,
      proof: cp.signHostProof({
        review_id: review.review_id,
        review_revision: review.revision,
        binding_sha256: review.binding_sha256,
        scope,
        decision: "approve",
        expires_at: review.expires_at,
      }),
    });
    notified.delete(id);
  }

  function mcpRemoval(
    id: string,
    { registered, grant }: Registration,
  ): Removal {
    if (!registered) throw new Error("Server not registered.");
    return {
      id,
      revision: hash(
        JSON.stringify([id, registered, grant?.grant_id, grant?.revision]),
      ),
      archive: [],
      keep: [],
    };
  }
  async function previewRemoval(id: string): Promise<Removal> {
    const entry = findExtension(id);
    if (!entry) throw new Error("Not in the bundled catalog.");
    return entry.kind === "mcp"
      ? mcpRemoval(id, await registration(await plane(), id))
      : skillRemoval(entry, await catalogSkills(store));
  }
  async function remove(id: string, revision: string) {
    const entry = findExtension(id);
    if (!entry) throw new Error("Not in the bundled catalog.");
    if (entry.kind === "mcp") {
      const cp = await plane();
      const record = await registration(cp, id);
      if (mcpRemoval(id, record).revision !== revision)
        throw new Error("Approval changed.");
      const { grant } = record;
      if (
        grant?.state === "approved" &&
        Date.parse(grant.expires_at) >
          (options.clock?.().getTime() ?? Date.now())
      ) {
        await cp.admin.revoke(context(), {
          grant_id: grant.grant_id,
          expected_revision: grant.revision,
          proof: cp.signHostProof({
            scope,
            review_id: grant.review_id,
            review_revision: grant.revision,
            binding_sha256: grant.binding_sha256,
            decision: "revoke",
            expires_at: grant.expires_at,
          }),
        });
      }
      await cp.registry.remove(id);
      notified.delete(id);
    } else {
      const snapshot = await catalogSkills(store);
      const plan = skillRemoval(entry, snapshot);
      if (plan.revision !== revision) throw new Error("Skills changed.");
      await store.applyCatalogBatch(
        plan.archive.map((name) => ({ op: "archive", name })),
        {
          actor: "desktop-operator",
          source: `catalog-remove:${id}`,
          expectedRevision: revision,
        },
        {
          ...snapshot.ownership,
          added: snapshot.ownership.added.filter((owner) => owner !== id),
        },
      );
    }
  }

  // Trust revocation and deregistration are separate stores. Serialize desktop
  // MCP mutations across workbenches so a concurrent re-add cannot interleave.
  const mutate = (id: string, action: () => Promise<void>) =>
    findExtension(id)?.kind === "mcp"
      ? withDirectoryLock(join(state, "catalog-mutations"), action)
      : action();
  return {
    status,
    list: async () => (await status()).installed,
    install: (id: string, revision?: string) =>
      mutate(id, () => install(id, revision)),
    previewRemoval,
    remove: (id: string, revision: string) =>
      mutate(id, () => remove(id, revision)),
    async runtime(_cwd: string, taskScope: Scope) {
      if (!isDeepStrictEqual(scope, taskScope))
        throw new Error("Project scope mismatch.");
      const cp = await plane();
      const inner = cp.createLoader();
      const checkRoot = (id: string) => {
        const entry = findExtension(id);
        if (entry?.kind === "mcp" && entry.projectRootArg)
          requireProjectRoot(source, openedRoot);
      };
      const loader: TrustedMcpLoader = {
        ...inner,
        async admitServer(ctx, id, action, signal) {
          checkRoot(id);
          return inner.admitServer(ctx, id, action, signal);
        },
        async invokeTool(ctx, request) {
          checkRoot(request.server_id);
          try {
            return await inner.invokeTool(ctx, request);
          } catch (error) {
            if (
              error instanceof Error &&
              "code" in error &&
              error.code === "expired" &&
              (await cp.registry.get(request.server_id))
            )
              notifyExpired(request.server_id);
            throw error;
          }
        },
      };
      return {
        loader,
        async listServerIds() {
          const ids = [];
          for (const entry of CATALOG) {
            if (entry.kind !== "mcp") continue;
            const status = await mcpStatus(cp, entry);
            if (status === "installed") ids.push(entry.id);
            else if (status === "expired") notifyExpired(entry.id);
          }
          return ids;
        },
      };
    },
  };
}
