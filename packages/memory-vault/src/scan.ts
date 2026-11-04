import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { RequestContext } from "@mars/contracts";
import { canonicalJson, RequestContextSchema } from "@mars/memory";
import { VaultError } from "./errors";
import { readManifest, skillNotePath } from "./export";
import { type ParsedNote, parseNote, sha256 } from "./notes";
import {
  assertVaultDirectory,
  contains,
  resolveInside,
  VaultPathError,
} from "./paths";
import {
  DERIVED_KINDS,
  type ManifestNote,
  type NoteKind,
  NoteKindSchema,
  type VaultManifest,
} from "./schema";
import type { VaultStores } from "./stores";

export type ScanState =
  | "unchanged"
  | "modified"
  | "deleted"
  | "added"
  | "invalid";

export interface ScannedNote {
  path: string;
  kind: NoteKind | null;
  id: string | null;
  state: ScanState;
  derived: boolean;
  tracked: ManifestNote | null;
  note: ParsedNote | null;
  reason: string | null;
}

export interface VaultScan {
  vaultDir: string;
  manifest: VaultManifest;
  memoryRevision: number;
  skillsRevision: string;
  memoryStale: boolean;
  skillsStale: boolean;
  notes: ScannedNote[];
  /** Markdown files inside facts/ or skills/ that the vault neither tracks nor recognises. */
  untracked: number;
}

const CANDIDATE_DIRS = ["facts", "skills"] as const;

async function listMarkdown(dir: string, prefix: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return names
    .filter((name) => name.endsWith(".md") && !name.startsWith("."))
    .sort()
    .map((name) => `${prefix}/${name}`);
}

/**
 * Reads a note without ever following a link out of the vault: a symlinked
 * note (or a note in a symlinked directory) could pull private files into a
 * proposal. Throws VaultPathError for links, ENOENT for a missing file.
 */
async function readNoteInside(
  vaultDir: string,
  absolute: string,
  path: string,
): Promise<string> {
  if ((await lstat(absolute)).isSymbolicLink())
    throw new VaultPathError("path_escape", `${path} is a symlink`);
  const [realVault, realParent] = await Promise.all([
    realpath(vaultDir),
    realpath(dirname(absolute)),
  ]);
  if (realParent !== realVault && !contains(realVault, realParent))
    throw new VaultPathError(
      "path_escape",
      `${path} resolves outside the vault`,
    );
  return readFile(absolute, "utf8");
}

function kindOf(note: ParsedNote): NoteKind | null {
  const parsed = NoteKindSchema.safeParse(note.frontmatter.mars_kind);
  return parsed.success ? parsed.data : null;
}

/**
 * Reads the manifest and every tracked note, classifies each against its
 * exported `content_digest`, and discovers new fact/skill notes. Pure read:
 * no store is mutated and nothing is proposed here.
 */
export async function scanVault(
  ctx: RequestContext,
  options: VaultStores & { vaultDir: string; privateRoots?: readonly string[] },
): Promise<VaultScan> {
  if (!RequestContextSchema.safeParse(ctx).success)
    throw new VaultError("invalid_context");
  const vaultDir = resolve(options.vaultDir);
  await assertVaultDirectory(vaultDir, [
    ...(options.privateRoots ?? []),
    options.skills.root,
  ]);
  const manifest = await readManifest(vaultDir);
  if (!manifest) throw new VaultError("no_manifest");
  if (canonicalJson(manifest.scope) !== canonicalJson(ctx.scope))
    throw new VaultError(
      "scope_mismatch",
      "the vault was exported for a different owner/project/workspace",
    );
  const snapshot = await options.memory.snapshot(ctx);
  const skillsRevision = await options.skills.getRevision();
  const notes: ScannedNote[] = [];
  const trackedPaths = new Set<string>();
  for (const tracked of [...manifest.notes].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  )) {
    trackedPaths.add(tracked.path);
    const derived = DERIVED_KINDS.has(tracked.kind);
    const base = {
      path: tracked.path,
      kind: tracked.kind,
      id: tracked.id,
      derived,
      tracked,
    };
    let absolute: string;
    try {
      absolute = resolveInside(vaultDir, tracked.path);
    } catch (error) {
      notes.push({
        ...base,
        state: "invalid",
        note: null,
        reason: error instanceof Error ? error.message : "path_escape",
      });
      continue;
    }
    let text: string;
    try {
      text = await readNoteInside(vaultDir, absolute, tracked.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        notes.push({ ...base, state: "deleted", note: null, reason: null });
        continue;
      }
      if (error instanceof VaultPathError) {
        notes.push({
          ...base,
          state: "invalid",
          note: null,
          reason: error.message,
        });
        continue;
      }
      throw error;
    }
    let note: ParsedNote;
    try {
      note = parseNote(text);
    } catch (error) {
      notes.push({
        ...base,
        state: "invalid",
        note: null,
        reason: error instanceof Error ? error.message : "unparseable note",
      });
      continue;
    }
    if (note.frontmatter.mars_kind !== tracked.kind) {
      notes.push({
        ...base,
        state: "invalid",
        note: null,
        reason: `mars_kind ${String(note.frontmatter.mars_kind)} does not match the exported kind ${tracked.kind}`,
      });
      continue;
    }
    notes.push({
      ...base,
      state:
        sha256(note.body) === tracked.content_digest ? "unchanged" : "modified",
      note,
      reason: null,
    });
  }
  let untracked = 0;
  for (const dir of CANDIDATE_DIRS) {
    for (const path of await listMarkdown(join(vaultDir, dir), dir)) {
      if (trackedPaths.has(path)) continue;
      const expected: NoteKind = dir === "facts" ? "memory_fact" : "skill";
      let text: string;
      try {
        text = await readNoteInside(
          vaultDir,
          resolveInside(vaultDir, path),
          path,
        );
      } catch (error) {
        if (error instanceof VaultPathError) {
          notes.push({
            path,
            kind: expected,
            id: null,
            state: "invalid",
            derived: false,
            tracked: null,
            note: null,
            reason: error.message,
          });
          continue;
        }
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      let note: ParsedNote;
      try {
        note = parseNote(text);
      } catch {
        untracked += 1;
        continue;
      }
      const kind = kindOf(note);
      if (kind !== expected) {
        untracked += 1;
        continue;
      }
      const idField = kind === "memory_fact" ? "entry_id" : "name";
      const id = note.frontmatter[idField];
      const base = { path, kind, derived: false, tracked: null, note };
      if (kind === "memory_fact" && id !== undefined && id !== null) {
        notes.push({
          ...base,
          id: String(id),
          state: "invalid",
          reason:
            "untracked fact note carries an entry_id; remove it to propose a new fact or re-export to track it",
        });
        continue;
      }
      if (
        kind === "skill" &&
        typeof id === "string" &&
        skillNotePath(id) !== path
      ) {
        // The proposed skill is named by its frontmatter; a file that does
        // not match would leave an orphan note once the skill is exported.
        notes.push({
          ...base,
          id,
          state: "invalid",
          reason: `skill name ${id} does not match the file name; rename the note to ${skillNotePath(id)} or drop the name field`,
        });
        continue;
      }
      notes.push({
        ...base,
        id: typeof id === "string" ? id : null,
        state: "added",
        reason: null,
      });
    }
  }
  return {
    vaultDir,
    manifest,
    memoryRevision: snapshot.revision,
    skillsRevision,
    memoryStale: snapshot.revision !== manifest.memory_revision,
    skillsStale: skillsRevision !== manifest.skills_revision,
    notes,
    untracked,
  };
}
