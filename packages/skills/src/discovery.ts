/**
 * Skill-folder discovery for a trusted project checkout. Loads
 * `skills/<name>/SKILL.md` (plus the vendored `skills/vendor/<vendor>/<name>/SKILL.md`
 * layout used by this repository), `.claude/skills/<name>/SKILL.md`,
 * `.codex/skills/<name>/SKILL.md` and `.agents/skills/<name>/SKILL.md`.
 *
 * Only the file layout and frontmatter keys follow the Claude Code / Codex CLI
 * conventions; no upstream source is used. Discovery is read-only, offline,
 * bounded (skill count and bytes per file) and never executes anything.
 */
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SkillRecord } from "@mars/contracts";
import type {
  DiscoveredSkill,
  SkillDiscoveryResult,
  SkillSource,
} from "./conventions-types";
import { parseFrontmatter } from "./frontmatter";

export interface SkillDiscoveryOptions {
  /** Absolute path of the trusted checkout. */
  root: string;
  /** Maximum number of skills loaded; later files are recorded as skipped. */
  maxSkills?: number;
  /** Maximum size of one SKILL.md in bytes; larger files are skipped. */
  maxContentBytes?: number;
}

export interface SkillDiscoveryWarning {
  path: string;
  message: string;
}

/** `SkillDiscoveryResult` plus non-fatal findings (for example a frontmatter name that differs from its folder). */
export interface SkillDiscoveryReport extends SkillDiscoveryResult {
  warnings: SkillDiscoveryWarning[];
}

export const DEFAULT_MAX_SKILLS = 256;
export const DEFAULT_MAX_SKILL_BYTES = 64 * 1024;
export const SKILL_FILE = "SKILL.md";
export const SKILL_SOURCES: readonly SkillSource[] = [
  "skills",
  ".claude/skills",
  ".codex/skills",
  ".agents/skills",
];
/** Same rule as the lifecycle store. */
export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const RESERVED_NAMES = new Set(["constructor", "prototype", "__proto__"]);

export function isValidSkillName(name: string): boolean {
  return SKILL_NAME_PATTERN.test(name) && !RESERVED_NAMES.has(name);
}

const posix = (...parts: string[]) => parts.join("/");

async function entryKind(
  path: string,
): Promise<"file" | "directory" | "symlink" | "other" | null> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) return "symlink";
    if (stats.isDirectory()) return "directory";
    if (stats.isFile()) return "file";
    return "other";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function sortedEntries(path: string): Promise<string[]> {
  try {
    return (await readdir(path)).sort();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw error;
  }
}

/** Candidate skill folders for one source: `[relative folder, folder name]`, deterministic. */
async function candidateFolders(
  root: string,
  source: SkillSource,
): Promise<Array<{ relative: string; folder: string }>> {
  const out: Array<{ relative: string; folder: string }> = [];
  const base = join(root, ...source.split("/"));
  if ((await entryKind(base)) !== "directory") return out;
  for (const name of await sortedEntries(base)) {
    if (name.startsWith(".")) continue;
    const kind = await entryKind(join(base, name));
    if (kind !== "directory") continue;
    out.push({ relative: posix(source, name), folder: name });
  }
  if (source === "skills") {
    const vendor = join(base, "vendor");
    if ((await entryKind(vendor)) === "directory")
      for (const vendorName of await sortedEntries(vendor)) {
        if (vendorName.startsWith(".")) continue;
        const vendorDir = join(vendor, vendorName);
        if ((await entryKind(vendorDir)) !== "directory") continue;
        for (const name of await sortedEntries(vendorDir)) {
          if (name.startsWith(".")) continue;
          if ((await entryKind(join(vendorDir, name))) !== "directory")
            continue;
          out.push({
            relative: posix(source, "vendor", vendorName, name),
            folder: name,
          });
        }
      }
  }
  return out;
}

export async function discoverSkills(
  options: SkillDiscoveryOptions,
): Promise<SkillDiscoveryReport> {
  const root = resolve(options.root);
  const maxSkills = options.maxSkills ?? DEFAULT_MAX_SKILLS;
  const maxBytes = options.maxContentBytes ?? DEFAULT_MAX_SKILL_BYTES;
  if (!Number.isInteger(maxSkills) || maxSkills < 0)
    throw new RangeError("maxSkills must be a non-negative integer");
  if (!Number.isInteger(maxBytes) || maxBytes < 1)
    throw new RangeError("maxContentBytes must be a positive integer");
  const report: SkillDiscoveryReport = {
    skills: [],
    shadowed: [],
    skipped: [],
    warnings: [],
  };
  const byName = new Map<string, DiscoveredSkill>();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  for (const source of SKILL_SOURCES) {
    for (const { relative, folder } of await candidateFolders(root, source)) {
      const path = posix(relative, SKILL_FILE);
      const absolute = join(root, ...relative.split("/"), SKILL_FILE);
      const kind = await entryKind(absolute);
      if (kind === null) continue;
      if (kind !== "file") {
        report.skipped.push({ path, reason: kind });
        continue;
      }
      if (report.skills.length >= maxSkills) {
        report.skipped.push({ path, reason: "limit" });
        continue;
      }
      const stats = await lstat(absolute);
      if (stats.size > maxBytes) {
        report.skipped.push({ path, reason: "oversize" });
        continue;
      }
      let content: string;
      try {
        content = decoder.decode(await readFile(absolute));
      } catch {
        report.skipped.push({ path, reason: "encoding" });
        continue;
      }
      const frontmatter = parseFrontmatter(content);
      if (!frontmatter) {
        report.skipped.push({ path, reason: "frontmatter" });
        continue;
      }
      const name = frontmatter.name?.trim() ?? "";
      const description = frontmatter.description?.trim() ?? "";
      if (!name || !description) {
        report.skipped.push({ path, reason: "missing-name-or-description" });
        continue;
      }
      if (!isValidSkillName(name)) {
        report.skipped.push({ path, reason: "invalid-name" });
        continue;
      }
      if (name !== folder)
        report.warnings.push({
          path,
          message: `frontmatter name "${name}" differs from folder "${folder}"`,
        });
      const existing = byName.get(name);
      if (existing) {
        report.shadowed.push({ name, path, shadowed_by: existing.path });
        continue;
      }
      const skill: DiscoveredSkill = {
        name,
        description,
        path,
        source,
        content,
        bytes: stats.size,
        frontmatter: { ...frontmatter },
      };
      byName.set(name, skill);
      report.skills.push(skill);
    }
  }
  return report;
}

/**
 * Adapts discovered skills to the lifecycle `SkillRecord` shape so the host can
 * freeze them like store skills. Repository skills are always `active`,
 * unpinned, with epoch timestamps and no usage history.
 */
export function toSkillRecords(
  discovered: readonly DiscoveredSkill[] | SkillDiscoveryResult,
): SkillRecord[] {
  const skills: readonly DiscoveredSkill[] =
    "skills" in discovered ? discovered.skills : discovered;
  return skills.map((skill) => ({
    name: skill.name,
    content: skill.content,
    status: "active",
    pinned: false,
    createdAt: 0,
    lastActivity: 0,
    useCount: 0,
  }));
}
