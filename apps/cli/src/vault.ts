import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { RequestContext } from "@mars/contracts";
import { createMemoryStore } from "@mars/memory";
import {
  type ExportReport,
  exportVault,
  type ImportReport,
  importVault,
  type StatusReport,
  VaultError,
  type VaultGraphArtifact,
  VaultGraphArtifactSchema,
  VaultPathError,
  vaultStatus,
} from "@mars/memory-vault";
import { SkillStore } from "@mars/skills";

export const VAULT_USAGE = [
  "Usage: mars vault <export|import|status> --vault DIR [--state PRIVATE_DIR] [--source DIR] [--owner ID] [--project ID] [--workspace ID] [--graph ARTIFACT.json]... [--actor ID] [--allow-remove] [--strict] [--json]",
  "  export  mirror curated memory, skills and optional knowledge-graph artifacts into an Obsidian-compatible vault",
  "  import  turn vault edits into pending proposals (never writes to the memory or skill stores)",
  "  status  compare the vault manifest with the current store revisions",
  "  Defaults match mars serve: --owner local, --project project-<sha256(source)>, --state ~/.mars/workbench/<project>.",
].join("\n");

export class VaultUsageError extends Error {}

const SOURCE = "memory-vault";

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new VaultUsageError(
      `Missing required option --${name}.\n${VAULT_USAGE}`,
    );
  return value;
}

async function readGraph(file: string): Promise<VaultGraphArtifact> {
  const source = Bun.file(file);
  if (!(await source.exists()))
    throw new VaultUsageError(`Cannot read graph artifact "${file}".`);
  const parsed = VaultGraphArtifactSchema.safeParse(await source.json());
  if (!parsed.success)
    throw new VaultUsageError(
      `Graph artifact "${file}" does not match the knowledge-graph schema: ${parsed.error.issues[0]?.message ?? "invalid"}.`,
    );
  return parsed.data;
}

function storeLine(name: string, state: ImportReport["memory"]): string {
  return `${name}: exported revision ${state.exported_revision}, current ${state.current_revision}${state.stale_export ? " (stale_export)" : ""}`;
}

export function renderExport(report: ExportReport): string {
  const kinds = Object.entries(report.notes)
    .map(([kind, count]) => `${kind}=${count}`)
    .join(" ");
  return [
    `Exported vault ${report.vault_dir}`,
    `memory revision ${report.memory_revision}, skills revision ${report.skills_revision.slice(0, 16)}`,
    `notes: ${kinds || "none"}`,
    `written ${report.written}, unchanged ${report.unchanged}, removed ${report.removed}, kept modified ${report.kept_modified}`,
  ].join("\n");
}

export function renderImport(report: ImportReport): string {
  const lines = [
    `Imported vault ${report.vault_dir}${report.strict ? " (strict)" : ""}${report.allow_remove ? " (removals allowed)" : ""}`,
    storeLine("memory", report.memory),
    storeLine("skills", report.skills),
  ];
  for (const item of report.items) {
    if (item.action === "unchanged") continue;
    const detail = [
      item.operation ? `${item.store ?? ""} ${item.operation}`.trim() : null,
      item.proposal_id ? `proposal ${item.proposal_id}` : null,
      item.reason,
    ]
      .filter((part): part is string => part !== null)
      .join("; ");
    lines.push(
      `  ${item.action.padEnd(16)} ${item.path}${detail ? ` — ${detail}` : ""}`,
    );
  }
  const summary = Object.entries(report.summary)
    .map(([action, count]) => `${action}=${count}`)
    .join(" ");
  lines.push(`summary: ${summary || "nothing to do"}`);
  lines.push(
    `pending proposals created: memory ${report.proposals.memory.length}, skills ${report.proposals.skills.length}; accept or reject them through the memory and skills proposal APIs.`,
  );
  return lines.join("\n");
}

export function renderStatus(report: StatusReport): string {
  const counts = (c: StatusReport["derived"]) =>
    `unchanged ${c.unchanged}, modified ${c.modified}, added ${c.added}, deleted ${c.deleted}, derived ${c.derived}, invalid ${c.invalid}`;
  return [
    `Vault ${report.vault_dir} (exported ${report.exported_at ?? "never"})`,
    `${storeLine("memory", report.memory)}; notes: ${counts(report.memory.notes)}; pending vault proposals ${report.memory.pending_vault_proposals}`,
    `${storeLine("skills", report.skills)}; notes: ${counts(report.skills.notes)}; pending vault proposals ${report.skills.pending_vault_proposals}`,
    `derived notes (projects, graph): ${counts(report.derived)}`,
    `untracked files left alone: ${report.untracked}`,
  ].join("\n");
}

export async function runVault(args: string[]): Promise<void> {
  const subcommand = args[0];
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    console.log(VAULT_USAGE);
    return;
  }
  if (
    subcommand !== "export" &&
    subcommand !== "import" &&
    subcommand !== "status"
  )
    throw new VaultUsageError(
      `Unknown vault command "${subcommand}".\n${VAULT_USAGE}`,
    );
  const { values } = parseArgs({
    args: args.slice(1),
    strict: true,
    allowPositionals: false,
    options: {
      vault: { type: "string" },
      state: { type: "string" },
      source: { type: "string" },
      owner: { type: "string" },
      project: { type: "string" },
      workspace: { type: "string" },
      graph: { type: "string", multiple: true },
      actor: { type: "string" },
      "allow-remove": { type: "boolean" },
      strict: { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(VAULT_USAGE);
    return;
  }
  const source = await realpath(resolve(values.source ?? process.cwd()));
  const project =
    values.project ??
    `project-${createHash("sha256").update(source).digest("hex").slice(0, 24)}`;
  const state = resolve(
    values.state ?? join(homedir(), ".mars", "workbench", project),
  );
  const vaultDir = resolve(requiredString(values.vault, "vault"));
  const memoryRoot = join(state, "memory");
  const skillsRoot = join(state, "skills");
  const ctx: RequestContext = {
    schema_version: 1,
    scope: {
      owner_id: values.owner ?? "local",
      project_id: project,
      ...(values.workspace ? { workspace_id: values.workspace } : {}),
    },
    request_id: `vault-${subcommand}-${Date.now().toString(36)}`,
  };
  const graph = await Promise.all((values.graph ?? []).map(readGraph));
  const memory = createMemoryStore({
    rootDir: memoryRoot,
    hostPrivateRoots: [source, state, memoryRoot, skillsRoot],
  });
  const skills = new SkillStore(skillsRoot);
  const common = { vaultDir, memory, skills, privateRoots: [state] };
  try {
    if (subcommand === "export") {
      const report = await exportVault(ctx, { ...common, graph });
      console.log(
        values.json ? JSON.stringify(report, null, 2) : renderExport(report),
      );
    } else if (subcommand === "import") {
      const report = await importVault(ctx, {
        ...common,
        actor: values.actor ?? ctx.scope.owner_id,
        source: SOURCE,
        allowRemove: values["allow-remove"] === true,
        strict: values.strict === true,
      });
      console.log(
        values.json ? JSON.stringify(report, null, 2) : renderImport(report),
      );
    } else {
      const report = await vaultStatus(ctx, { ...common, source: SOURCE });
      console.log(
        values.json ? JSON.stringify(report, null, 2) : renderStatus(report),
      );
    }
  } catch (error) {
    if (error instanceof VaultError || error instanceof VaultPathError)
      throw new VaultUsageError(error.message);
    throw error;
  } finally {
    await memory.close();
  }
}
