import { randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { MemoryEntry, RequestContext } from "@mars/contracts";
import { canonicalJson, RequestContextSchema } from "@mars/memory";
import type { Skill } from "@mars/skills";
import { VaultError } from "./errors";
import { renderNote, sha256, wikilink } from "./notes";
import {
  assertVaultDirectory,
  contains,
  encodeSegment,
  encodeSourcePath,
  resolveInside,
  VaultPathError,
} from "./paths";
import {
  type ExportReport,
  type ManifestNote,
  type NoteKind,
  VAULT_MANIFEST_FILE,
  VAULT_SCHEMA_VERSION,
  type VaultGraphArtifact,
  VaultGraphArtifactSchema,
  type VaultManifest,
  VaultManifestSchema,
} from "./schema";
import type { VaultStores } from "./stores";
import type { YamlValue } from "./yaml";

export interface ExportVaultOptions extends VaultStores {
  vaultDir: string;
  graph?: VaultGraphArtifact | readonly VaultGraphArtifact[];
  /** Host-private roots the vault may not overlap (the skills root is always included). */
  privateRoots?: readonly string[];
  now?: () => Date;
}

interface PlannedNote {
  path: string;
  kind: NoteKind;
  id: string;
  revision: number | string;
  frontmatter: { [key: string]: YamlValue };
  body: string;
  related: string[];
}

const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const stripMd = (path: string) => path.replace(/\.md$/, "");

export const factNotePath = (entryId: string) =>
  `facts/${encodeSegment(entryId)}.md`;
export const projectNotePath = (projectId: string) =>
  `projects/${encodeSegment(projectId)}.md`;
export const skillNotePath = (name: string) =>
  `skills/${encodeSegment(name)}.md`;
export const graphIndexPath = (workspaceId: string) =>
  `graph/${encodeSegment(workspaceId)}/index.md`;
export const graphCommunityPath = (workspaceId: string, id: number) =>
  `graph/${encodeSegment(workspaceId)}/communities/c${id}.md`;
export const graphFilePath = (workspaceId: string, sourceFile: string) =>
  `graph/${encodeSegment(workspaceId)}/files/${encodeSourcePath(sourceFile)}.md`;

/** Exact-token mentions: split on whitespace and punctuation that cannot appear in a skill name or path. */
export function mentionTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of text.split(/[\s`'"(),;:!?<>[\]{}|]+/)) {
    const token = raw.replace(/\.+$/, "");
    if (token.length > 0) tokens.add(token);
  }
  return tokens;
}

export async function readManifest(
  vaultDir: string,
): Promise<VaultManifest | undefined> {
  let text: string;
  try {
    text = await readFile(join(vaultDir, VAULT_MANIFEST_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new VaultError("corrupt_manifest", "not JSON");
  }
  const result = VaultManifestSchema.safeParse(parsed);
  if (!result.success)
    throw new VaultError("corrupt_manifest", result.error.issues[0]?.message);
  return result.data;
}

/**
 * Writes a note privately (0600, directories 0700) via a temporary sibling and
 * rename. The parent directory is resolved through symlinks and must still be
 * inside the real vault directory, and the target may not be a symlink, so a
 * planted link inside the vault cannot redirect the export elsewhere.
 */
async function writeAtomic(
  vaultDir: string,
  absolute: string,
  text: string,
): Promise<boolean> {
  await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
  const [realVault, realParent] = await Promise.all([
    realpath(vaultDir),
    realpath(dirname(absolute)),
  ]);
  if (realParent !== realVault && !contains(realVault, realParent))
    throw new VaultPathError(
      "path_escape",
      `${relative(vaultDir, absolute)} resolves outside the vault`,
    );
  try {
    if ((await lstat(absolute)).isSymbolicLink())
      throw new VaultPathError(
        "path_escape",
        `${relative(vaultDir, absolute)} is a symlink`,
      );
    if ((await readFile(absolute, "utf8")) === text) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = join(
    dirname(absolute),
    `.${basename(absolute)}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    await writeFile(temporary, text, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, absolute);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return true;
}

function factNote(
  entry: MemoryEntry,
  memoryRevision: number,
  related: string[],
): PlannedNote {
  const scope: { [key: string]: YamlValue } = {
    owner_id: entry.scope.owner_id,
    project_id: entry.scope.project_id,
  };
  if (entry.scope.workspace_id !== undefined)
    scope.workspace_id = entry.scope.workspace_id;
  return {
    path: factNotePath(entry.entry_id),
    kind: "memory_fact",
    id: entry.entry_id,
    revision: entry.revision,
    frontmatter: {
      mars_kind: "memory_fact",
      entry_id: entry.entry_id,
      revision: entry.revision,
      target: entry.target,
      scope,
      provenance: {
        source_event_ids: [...entry.source_event_ids],
        observed_at: entry.observed_at,
        verified_at: entry.verified_at,
        supersedes: entry.supersedes,
      },
      created: entry.observed_at,
      updated: entry.verified_at ?? entry.observed_at,
      exported_revision: memoryRevision,
      content_digest: sha256(entry.fact),
    },
    body: entry.fact,
    related,
  };
}

function skillNote(
  skill: Skill,
  versionId: string | null,
  skillsRevision: string,
  related: string[],
): PlannedNote {
  return {
    path: skillNotePath(skill.name),
    kind: "skill",
    id: skill.name,
    revision: skillsRevision,
    frontmatter: {
      mars_kind: "skill",
      name: skill.name,
      revision: skillsRevision,
      version_id: versionId,
      status: skill.status,
      pinned: skill.pinned,
      created: new Date(skill.createdAt).toISOString(),
      updated: new Date(skill.lastActivity).toISOString(),
      content_digest: sha256(skill.content),
    },
    body: skill.content,
    related,
  };
}

function derivedNote(
  path: string,
  kind: NoteKind,
  id: string,
  revision: number | string,
  frontmatter: { [key: string]: YamlValue },
  body: string,
  related: string[] = [],
): PlannedNote {
  return {
    path,
    kind,
    id,
    revision,
    frontmatter: {
      mars_kind: kind,
      ...frontmatter,
      revision,
      derived: true,
      rebuildable: true,
      content_digest: sha256(body),
    },
    body,
    related,
  };
}

function graphNotes(artifact: VaultGraphArtifact): {
  notes: PlannedNote[];
  files: Map<string, string>;
} {
  const ws = artifact.workspace.workspace_id;
  const revision = artifact.workspace.revision;
  const nodes = new Map(artifact.nodes.map((node) => [node.id, node]));
  const files = new Map<string, string>();
  for (const node of artifact.nodes)
    if (node.source_file !== null && !files.has(node.source_file))
      files.set(node.source_file, stripMd(graphFilePath(ws, node.source_file)));
  const sortedFiles = [...files.keys()].sort(byString);
  const communities = [...artifact.communities].sort((a, b) => a.id - b.id);
  const communityLink = (id: number) =>
    wikilink(
      stripMd(graphCommunityPath(ws, id)),
      communities.find((c) => c.id === id)?.label ?? `community ${id}`,
    );
  const fileLink = (path: string) =>
    wikilink(files.get(path) ?? stripMd(graphFilePath(ws, path)), path);
  const nodeFile = (id: string) => nodes.get(id)?.source_file ?? null;
  const nodeText = (id: string) => {
    const node = nodes.get(id);
    return node ? `\`${node.label}\` (${node.kind})` : `\`${id}\``;
  };
  const notes: PlannedNote[] = [];
  const indexBody = [
    `# Knowledge graph: ${ws} @ ${revision}`,
    "",
    `Derived from the \`@mars/knowledge-graph\` artifact \`${artifact.content_digest}\` built ${artifact.built_at}${artifact.complete ? "" : " (incomplete)"}. Rebuilt on every export; edits here are never imported.`,
    "",
    "## Communities",
    ...communities.map(
      (c) =>
        `- ${communityLink(c.id)} — ${c.members.length} member${c.members.length === 1 ? "" : "s"}${c.cohesion === null ? "" : `, cohesion ${c.cohesion}`}`,
    ),
    "",
    "## Files",
    ...sortedFiles.map((path) => `- ${fileLink(path)}`),
  ].join("\n");
  notes.push(
    derivedNote(
      graphIndexPath(ws),
      "graph_index",
      ws,
      revision,
      {
        workspace_id: ws,
        artifact_digest: artifact.content_digest,
        built_at: artifact.built_at,
        complete: artifact.complete,
      },
      indexBody,
    ),
  );
  for (const community of communities) {
    const members = [...community.members].sort(byString);
    const memberFiles = [
      ...new Set(members.flatMap((id) => nodeFile(id) ?? [])),
    ].sort(byString);
    const body = [
      `# Community c${community.id}${community.label ? `: ${community.label}` : ""}`,
      "",
      `Workspace ${ws} @ ${revision}. ${members.length} member${members.length === 1 ? "" : "s"}${community.cohesion === null ? "" : `, cohesion ${community.cohesion}`}.`,
      "",
      "## Members",
      ...members.map((id) => {
        const file = nodeFile(id);
        return `- ${nodeText(id)}${file ? ` — ${fileLink(file)}` : ""}`;
      }),
    ].join("\n");
    notes.push(
      derivedNote(
        graphCommunityPath(ws, community.id),
        "graph_community",
        `${ws}:c${community.id}`,
        revision,
        {
          workspace_id: ws,
          community_id: community.id,
          label: community.label,
          cohesion: community.cohesion,
        },
        body,
        memberFiles.map(fileLink),
      ),
    );
  }
  for (const path of sortedFiles) {
    const own = artifact.nodes
      .filter((node) => node.source_file === path)
      .sort((a, b) => byString(a.id, b.id));
    const ownIds = new Set(own.map((node) => node.id));
    const outgoing = artifact.edges
      .filter((edge) => ownIds.has(edge.source))
      .sort(
        (a, b) =>
          byString(a.source, b.source) ||
          byString(a.target, b.target) ||
          byString(a.relation, b.relation),
      );
    const incoming = artifact.edges
      .filter((edge) => ownIds.has(edge.target) && !ownIds.has(edge.source))
      .sort(
        (a, b) =>
          byString(a.source, b.source) ||
          byString(a.target, b.target) ||
          byString(a.relation, b.relation),
      );
    const communityIds = [
      ...new Set(own.flatMap((node) => node.community ?? [])),
    ].sort((a, b) => a - b);
    const linkedFiles = new Set<string>();
    const edgeLine = (edge: (typeof artifact.edges)[number]) => {
      const otherFile = nodeFile(
        ownIds.has(edge.source) ? edge.target : edge.source,
      );
      const link =
        otherFile && otherFile !== path ? ` — ${fileLink(otherFile)}` : "";
      if (otherFile && otherFile !== path) linkedFiles.add(otherFile);
      return `- ${nodeText(edge.source)} —${edge.relation}→ ${nodeText(edge.target)} [${edge.confidence}]${link}`;
    };
    const outgoingLines = outgoing.map(edgeLine);
    const incomingLines = incoming.map(edgeLine);
    const body = [
      `# ${path}`,
      "",
      `Workspace ${ws} @ ${revision}.`,
      "",
      "## Symbols",
      ...own.map(
        (node) =>
          `- \`${node.label}\` (${node.kind}${node.callable ? ", callable" : ""}${node.source_location ? `, ${node.source_location}` : ""})`,
      ),
      "",
      "## Outgoing edges",
      ...outgoingLines,
      "",
      "## Incoming edges",
      ...incomingLines,
      "",
      "## Communities",
      ...communityIds.map((id) => `- ${communityLink(id)}`),
    ].join("\n");
    notes.push(
      derivedNote(
        graphFilePath(ws, path),
        "graph_file",
        `${ws}:${path}`,
        revision,
        { workspace_id: ws, source_file: path, symbols: own.length },
        body,
        [
          ...[...linkedFiles].sort(byString).map(fileLink),
          ...communityIds.map(communityLink),
        ],
      ),
    );
  }
  return { notes, files };
}

/**
 * Writes the Obsidian-compatible mirror of curated memory, skills and the
 * optional knowledge graph into `vaultDir`. The stores are only read; the
 * vault owns nothing and is rebuilt from them on every call.
 */
export async function exportVault(
  ctx: RequestContext,
  options: ExportVaultOptions,
): Promise<ExportReport> {
  const context = RequestContextSchema.safeParse(ctx);
  if (!context.success) throw new VaultError("invalid_context");
  const vaultDir = resolve(options.vaultDir);
  assertVaultDirectory(vaultDir, [
    ...(options.privateRoots ?? []),
    options.skills.root,
  ]);
  const graphs = (
    options.graph === undefined
      ? []
      : Array.isArray(options.graph)
        ? options.graph
        : [options.graph as VaultGraphArtifact]
  ).map((artifact) => {
    const parsed = VaultGraphArtifactSchema.safeParse(artifact);
    if (!parsed.success)
      throw new VaultError("invalid_graph", parsed.error.issues[0]?.message);
    return parsed.data;
  });
  const seenWorkspaces = new Set<string>();
  for (const graph of graphs) {
    if (seenWorkspaces.has(graph.workspace.workspace_id))
      throw new VaultError("invalid_graph", "duplicate workspace_id");
    seenWorkspaces.add(graph.workspace.workspace_id);
  }
  graphs.sort((a, b) =>
    byString(a.workspace.workspace_id, b.workspace.workspace_id),
  );

  const previous = await readManifest(vaultDir);
  if (previous && canonicalJson(previous.scope) !== canonicalJson(ctx.scope))
    throw new VaultError(
      "scope_mismatch",
      "the vault was exported for a different owner/project/workspace; use another vault directory",
    );
  const snapshot = await options.memory.snapshot(ctx);
  const entries = snapshot.entries
    .filter((entry) => !entry.deleted)
    .sort((a, b) => byString(a.entry_id, b.entry_id));
  const skills = (await options.skills.list()).sort((a, b) =>
    byString(a.name, b.name),
  );
  const skillsRevision = await options.skills.getRevision();
  const versions = new Map<string, string | null>();
  for (const skill of skills)
    versions.set(
      skill.name,
      (await options.skills.listVersions(skill.name))[0]?.id ?? null,
    );

  const graphOutputs = graphs.map((artifact) => ({
    artifact,
    ...graphNotes(artifact),
  }));
  const graphFileLinks = graphOutputs.flatMap(({ files }) =>
    [...files.entries()].map(([path, target]) => ({ path, target })),
  );
  const skillNames = new Set(skills.map((skill) => skill.name));
  const projectIds = new Set<string>([ctx.scope.project_id]);
  for (const entry of entries) projectIds.add(entry.scope.project_id);
  const projectLink = (projectId: string) =>
    wikilink(stripMd(projectNotePath(projectId)), projectId);

  const notes: PlannedNote[] = [];
  const factsByProject = new Map<string, MemoryEntry[]>();
  for (const entry of entries) {
    const tokens = mentionTokens(entry.fact);
    const related = [projectLink(entry.scope.project_id)];
    for (const name of [...skillNames].sort(byString))
      if (tokens.has(name))
        related.push(wikilink(stripMd(skillNotePath(name)), name));
    for (const { path, target } of graphFileLinks.sort((a, b) =>
      byString(a.target, b.target),
    ))
      if (tokens.has(path)) related.push(wikilink(target, path));
    notes.push(factNote(entry, snapshot.revision, related));
    const list = factsByProject.get(entry.scope.project_id) ?? [];
    list.push(entry);
    factsByProject.set(entry.scope.project_id, list);
  }
  for (const skill of skills)
    notes.push(
      skillNote(skill, versions.get(skill.name) ?? null, skillsRevision, [
        projectLink(ctx.scope.project_id),
      ]),
    );
  for (const projectId of [...projectIds].sort(byString)) {
    const facts = factsByProject.get(projectId) ?? [];
    const own = projectId === ctx.scope.project_id;
    const sections = [
      `# Project ${projectId}`,
      "",
      own
        ? `Exporting scope: owner ${ctx.scope.owner_id}, project ${projectId}${ctx.scope.workspace_id ? `, workspace ${ctx.scope.workspace_id}` : ""}. MARS keeps no separate project-note store; this note is generated from the facts, skills and graph that reference the project.`
        : `Seen as the provenance project of profile facts visible to ${ctx.scope.project_id}.`,
      "",
      "## Facts",
      ...facts.map(
        (entry) =>
          `- ${wikilink(stripMd(factNotePath(entry.entry_id)), entry.fact)} (${entry.target})`,
      ),
    ];
    if (own) {
      sections.push(
        "",
        "## Skills",
        ...skills.map(
          (skill) =>
            `- ${wikilink(stripMd(skillNotePath(skill.name)), skill.name)} (${skill.status})`,
        ),
        "",
        "## Graph",
        ...graphOutputs.map(
          ({ artifact }) =>
            `- ${wikilink(stripMd(graphIndexPath(artifact.workspace.workspace_id)), `${artifact.workspace.workspace_id} @ ${artifact.workspace.revision}`)}`,
        ),
      );
    }
    notes.push(
      derivedNote(
        projectNotePath(projectId),
        "project",
        projectId,
        snapshot.revision,
        { project_id: projectId, owner_id: ctx.scope.owner_id },
        sections.join("\n"),
      ),
    );
  }
  for (const { notes: graph } of graphOutputs) notes.push(...graph);

  const paths = new Map<string, PlannedNote>();
  for (const note of notes) {
    const existing = paths.get(note.path);
    if (existing)
      throw new VaultPathError(
        "path_collision",
        `${existing.id} and ${note.id} both map to ${note.path}`,
      );
    paths.set(note.path, note);
  }

  let written = 0;
  let unchanged = 0;
  const manifestNotes: ManifestNote[] = [];
  const counts: Partial<Record<NoteKind, number>> = {};
  for (const note of [...notes].sort((a, b) => byString(a.path, b.path))) {
    const absolute = resolveInside(vaultDir, note.path);
    const text = renderNote(note);
    if (await writeAtomic(vaultDir, absolute, text)) written += 1;
    else unchanged += 1;
    counts[note.kind] = (counts[note.kind] ?? 0) + 1;
    manifestNotes.push({
      path: note.path,
      kind: note.kind,
      id: note.id,
      revision: note.revision,
      content_digest: sha256(note.body),
      file_digest: sha256(text),
    });
  }
  let removed = 0;
  let keptModified = 0;
  for (const stale of previous?.notes ?? []) {
    if (paths.has(stale.path)) continue;
    let absolute: string;
    try {
      absolute = resolveInside(vaultDir, stale.path);
    } catch {
      continue;
    }
    let current: string;
    try {
      current = await readFile(absolute, "utf8");
    } catch {
      continue;
    }
    // Only a byte-identical generated note is removed; any edit (body,
    // frontmatter or Related section) keeps the file and is reported.
    if (sha256(current) === stale.file_digest) {
      await rm(absolute, { force: true });
      removed += 1;
    } else keptModified += 1;
  }
  const exportedAt = (options.now?.() ?? new Date()).toISOString();
  const manifest: VaultManifest = {
    schema_version: VAULT_SCHEMA_VERSION,
    exported_at: exportedAt,
    scope: ctx.scope,
    memory_revision: snapshot.revision,
    skills_revision: skillsRevision,
    graph: graphs.map((artifact) => ({
      workspace_id: artifact.workspace.workspace_id,
      revision: artifact.workspace.revision,
      content_digest: artifact.content_digest,
    })),
    notes: manifestNotes,
  };
  await writeAtomic(
    vaultDir,
    join(vaultDir, VAULT_MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return {
    schema_version: VAULT_SCHEMA_VERSION,
    vault_dir: vaultDir,
    exported_at: exportedAt,
    scope: ctx.scope,
    memory_revision: snapshot.revision,
    skills_revision: skillsRevision,
    notes: counts,
    written,
    unchanged,
    removed,
    kept_modified: keptModified,
  };
}
