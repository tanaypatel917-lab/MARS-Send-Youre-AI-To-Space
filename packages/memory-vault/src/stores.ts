import type { DurableMemoryStore } from "@mars/memory";
import type { SkillStore } from "@mars/skills";

/** The read and proposal surface the vault uses; `batch`/`applyBatch` are deliberately excluded. */
export type VaultMemoryStore = Pick<
  DurableMemoryStore,
  "snapshot" | "submitProposal" | "listProposals"
>;
export type VaultSkillStore = Pick<
  SkillStore,
  | "root"
  | "list"
  | "getRevision"
  | "listVersions"
  | "submitProposal"
  | "listProposals"
>;
export interface VaultStores {
  memory: VaultMemoryStore;
  skills: VaultSkillStore;
}
