import { ScopeSchema } from "@mars/contracts";
import { z } from "zod";

export const VAULT_SCHEMA_VERSION = 1;
export const VAULT_MANIFEST_FILE = ".mars-vault.json";
export const VAULT_SOURCE = "memory-vault";

export const NoteKindSchema = z.enum([
  "memory_fact",
  "project",
  "skill",
  "graph_index",
  "graph_community",
  "graph_file",
]);
export type NoteKind = z.infer<typeof NoteKindSchema>;
export const DERIVED_KINDS: ReadonlySet<NoteKind> = new Set<NoteKind>([
  "project",
  "graph_index",
  "graph_community",
  "graph_file",
]);

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const notePath = z.string().min(1).max(4096);

export const ManifestNoteSchema = z
  .object({
    path: notePath,
    kind: NoteKindSchema,
    id: z.string().min(1),
    revision: z.union([z.number().int().nonnegative(), z.string().min(1)]),
    content_digest: digest,
    /** Whole-file digest; absent in manifests written before it was recorded. */
    file_digest: digest.optional(),
  })
  .strict();
export type ManifestNote = z.infer<typeof ManifestNoteSchema>;

export const ManifestGraphSchema = z
  .object({
    workspace_id: z.string().min(1),
    revision: z.string().min(1),
    content_digest: digest,
  })
  .strict();

export const VaultManifestSchema = z
  .object({
    schema_version: z.literal(VAULT_SCHEMA_VERSION),
    exported_at: z.string().datetime(),
    scope: ScopeSchema,
    memory_revision: z.number().int().nonnegative(),
    skills_revision: z.string().min(1),
    graph: z.array(ManifestGraphSchema),
    notes: z.array(ManifestNoteSchema),
  })
  .strict();
export type VaultManifest = z.infer<typeof VaultManifestSchema>;

/**
 * The fields of a `KnowledgeGraphArtifact` (packages/knowledge-graph/src/schema.ts)
 * that the vault renders. Extra fields pass through untouched; the artifact
 * itself is validated by its producer, not here.
 */
export const VaultGraphArtifactSchema = z
  .object({
    schema_version: z.literal(1),
    workspace: z
      .object({ workspace_id: z.string().min(1), revision: z.string().min(1) })
      .passthrough(),
    built_at: z.string().datetime(),
    content_digest: digest,
    complete: z.boolean(),
    nodes: z.array(
      z
        .object({
          id: z.string().min(1),
          label: z.string().min(1),
          kind: z.enum(["file", "symbol", "other"]),
          source_file: z.string().min(1).nullable(),
          source_location: z.string().nullable(),
          community: z.number().int().nonnegative().nullable(),
          callable: z.boolean(),
        })
        .passthrough(),
    ),
    edges: z.array(
      z
        .object({
          source: z.string().min(1),
          target: z.string().min(1),
          relation: z.string().min(1),
          confidence: z.enum(["EXTRACTED", "INFERRED", "AMBIGUOUS"]),
          source_file: z.string().nullable(),
          source_location: z.string().nullable(),
        })
        .passthrough(),
    ),
    communities: z.array(
      z
        .object({
          id: z.number().int().nonnegative(),
          label: z.string().nullable(),
          cohesion: z.number().nullable(),
          members: z.array(z.string().min(1)),
        })
        .passthrough(),
    ),
  })
  .passthrough();
export type VaultGraphArtifact = z.infer<typeof VaultGraphArtifactSchema>;

export const ExportReportSchema = z
  .object({
    schema_version: z.literal(VAULT_SCHEMA_VERSION),
    vault_dir: z.string(),
    exported_at: z.string().datetime(),
    scope: ScopeSchema,
    memory_revision: z.number().int().nonnegative(),
    skills_revision: z.string().min(1),
    notes: z.record(NoteKindSchema, z.number().int().nonnegative()),
    written: z.number().int().nonnegative(),
    unchanged: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
    kept_modified: z.number().int().nonnegative(),
  })
  .strict();
export type ExportReport = z.infer<typeof ExportReportSchema>;

export const ImportActionSchema = z.enum([
  "unchanged",
  "proposed",
  "already_proposed",
  "refused",
  "ignored_derived",
  "deleted",
  "stale_export",
  "invalid",
  "failed",
]);
export type ImportAction = z.infer<typeof ImportActionSchema>;

export const ImportOperationSchema = z.enum([
  "patch",
  "add",
  "remove",
  "update",
  "create",
  "archive",
]);
export type ImportOperation = z.infer<typeof ImportOperationSchema>;

export const ImportItemSchema = z
  .object({
    path: notePath,
    kind: NoteKindSchema.nullable(),
    id: z.string().nullable(),
    action: ImportActionSchema,
    operation: ImportOperationSchema.nullable(),
    store: z.enum(["memory", "skills"]).nullable(),
    proposal_id: z.string().nullable(),
    reason: z.string().nullable(),
  })
  .strict();
export type ImportItem = z.infer<typeof ImportItemSchema>;

export const StoreStateSchema = z
  .object({
    exported_revision: z.union([z.number().int().nonnegative(), z.string()]),
    current_revision: z.union([z.number().int().nonnegative(), z.string()]),
    stale_export: z.boolean(),
  })
  .strict();
export type StoreState = z.infer<typeof StoreStateSchema>;

export const ImportReportSchema = z
  .object({
    schema_version: z.literal(VAULT_SCHEMA_VERSION),
    vault_dir: z.string(),
    scope: ScopeSchema,
    source: z.string().min(1),
    strict: z.boolean(),
    allow_remove: z.boolean(),
    memory: StoreStateSchema,
    skills: StoreStateSchema,
    items: z.array(ImportItemSchema),
    summary: z.record(ImportActionSchema, z.number().int().nonnegative()),
    proposals: z
      .object({
        memory: z.array(z.string()),
        skills: z.array(z.string()),
      })
      .strict(),
  })
  .strict();
export type ImportReport = z.infer<typeof ImportReportSchema>;

export const NoteCountsSchema = z
  .object({
    unchanged: z.number().int().nonnegative(),
    modified: z.number().int().nonnegative(),
    added: z.number().int().nonnegative(),
    deleted: z.number().int().nonnegative(),
    derived: z.number().int().nonnegative(),
    invalid: z.number().int().nonnegative(),
  })
  .strict();
export type NoteCounts = z.infer<typeof NoteCountsSchema>;

export const StatusReportSchema = z
  .object({
    schema_version: z.literal(VAULT_SCHEMA_VERSION),
    vault_dir: z.string(),
    scope: ScopeSchema,
    exported_at: z.string().datetime().nullable(),
    memory: StoreStateSchema.extend({
      notes: NoteCountsSchema,
      pending_vault_proposals: z.number().int().nonnegative(),
    }).strict(),
    skills: StoreStateSchema.extend({
      notes: NoteCountsSchema,
      pending_vault_proposals: z.number().int().nonnegative(),
    }).strict(),
    derived: NoteCountsSchema,
    untracked: z.number().int().nonnegative(),
  })
  .strict();
export type StatusReport = z.infer<typeof StatusReportSchema>;
