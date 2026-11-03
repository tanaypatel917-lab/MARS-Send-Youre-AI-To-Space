import type { RequestContext } from "@mars/contracts";
import { type ScannedNote, scanVault } from "./scan";
import {
  type NoteCounts,
  type StatusReport,
  VAULT_SCHEMA_VERSION,
  VAULT_SOURCE,
} from "./schema";
import type { VaultStores } from "./stores";

export interface VaultStatusOptions extends VaultStores {
  vaultDir: string;
  source?: string;
  privateRoots?: readonly string[];
}

const emptyCounts = (): NoteCounts => ({
  unchanged: 0,
  modified: 0,
  added: 0,
  deleted: 0,
  derived: 0,
  invalid: 0,
});

function count(notes: ScannedNote[]): NoteCounts {
  const counts = emptyCounts();
  for (const note of notes) {
    if (note.derived) {
      counts.derived += 1;
      continue;
    }
    counts[note.state] += 1;
  }
  return counts;
}

/** Read-only comparison of the vault against the stores; proposes nothing. */
export async function vaultStatus(
  ctx: RequestContext,
  options: VaultStatusOptions,
): Promise<StatusReport> {
  const source = options.source ?? VAULT_SOURCE;
  const scan = await scanVault(ctx, options);
  const memoryNotes = scan.notes.filter((n) => n.kind === "memory_fact");
  const skillNotes = scan.notes.filter((n) => n.kind === "skill");
  const derivedNotes = scan.notes.filter((n) => n.derived);
  const memoryPending = (
    await options.memory.listProposals(ctx, "pending")
  ).filter((p) => p.source === source).length;
  const skillsPending = (await options.skills.listProposals()).filter(
    (p) => p.status === "pending" && p.source === source,
  ).length;
  return {
    schema_version: VAULT_SCHEMA_VERSION,
    vault_dir: scan.vaultDir,
    scope: ctx.scope,
    exported_at: scan.manifest.exported_at,
    memory: {
      exported_revision: scan.manifest.memory_revision,
      current_revision: scan.memoryRevision,
      stale_export: scan.memoryStale,
      notes: count(memoryNotes),
      pending_vault_proposals: memoryPending,
    },
    skills: {
      exported_revision: scan.manifest.skills_revision,
      current_revision: scan.skillsRevision,
      stale_export: scan.skillsStale,
      notes: count(skillNotes),
      pending_vault_proposals: skillsPending,
    },
    derived: count(derivedNotes),
    untracked: scan.untracked,
  };
}
