import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { CatalogOwnership, SkillStore } from "@mars/skills";
import { type CatalogEntry, findExtension } from "./extension-catalog";
import type { Removal } from "./extension-wire";

export async function catalogSkills(store: SkillStore) {
  const snapshot = await store.catalogSnapshot();
  const ownership: CatalogOwnership = snapshot.ownership ?? {
    added: [],
    managed: [],
  };
  if (!snapshot.ownership) {
    // Old installs logged mutations, not a second Add that made no changes.
    // Give legacy members their own receipt rather than guess they are unused.
    const added = new Set<string>(),
      managed = new Set<string>();
    for (const { source, skill, op } of snapshot.legacy) {
      const entry = findExtension(
        source.slice("catalog:".length).split("@")[0],
      );
      if (
        !entry ||
        !skill ||
        !entry.assets.some((a) => basename(a.file, ".md") === skill)
      )
        continue;
      added.add(entry.id);
      added.add(skill);
      if (op === "create") managed.add(skill);
    }
    ownership.added = [...added];
    ownership.managed = [...managed];
  }
  return { ...snapshot, ownership };
}

export function skillRemoval(
  entry: CatalogEntry,
  snapshot: Awaited<ReturnType<typeof catalogSkills>>,
): Removal {
  const { skills, ownership, revision } = snapshot;
  if (!ownership.added.includes(entry.id))
    throw new Error("Extension is not separately installed.");
  const remaining = ownership.added
    .filter((id) => id !== entry.id)
    .flatMap((id) => findExtension(id)?.assets ?? []);
  const plan: Removal = { id: entry.id, revision, archive: [], keep: [] };
  for (const asset of entry.assets) {
    const name = basename(asset.file, ".md");
    const skill = skills.find(
      (s) => s.name === name && s.status !== "archived",
    );
    if (!skill) continue;
    const reason = skill.pinned
      ? "pinned"
      : createHash("sha256").update(skill.content).digest("hex") !==
          asset.sha256
        ? "customized"
        : remaining.some((a) => a.file === asset.file)
          ? "shared"
          : !ownership.managed.includes(name)
            ? "pre-existing"
            : undefined;
    if (reason) plan.keep.push({ name, reason });
    else plan.archive.push(name);
  }
  return plan;
}
