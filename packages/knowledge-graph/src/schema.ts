import { z } from "zod";

/** The graphify release the sandboxed runner accepts (`graphify --version`). */
export const GRAPHIFY_VERSION = "0.9.101";
export const GRAPHIFY_REVISION = "ab26b1ec1da995743ef5a165a07b0d45ad3314c8";
export const KNOWLEDGE_GRAPH_PACKAGE_VERSION = "0.0.1";
export const KNOWLEDGE_GRAPH_PRODUCER = "@mars/knowledge-graph";

export const GRAPH_LIMITS = {
  max_nodes: 50_000,
  max_edges: 200_000,
  max_communities: 5_000,
  max_id_length: 512,
  max_label_length: 512,
  max_path_length: 1_024,
  max_relation_length: 64,
} as const;

const identifier = z.string().min(1).max(GRAPH_LIMITS.max_id_length);
const label = z.string().min(1).max(GRAPH_LIMITS.max_label_length);
const relativePath = z
  .string()
  .min(1)
  .max(GRAPH_LIMITS.max_path_length)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !/^[A-Za-z]:[\\/]/.test(value) &&
      !value.split(/[\\/]/).includes(".."),
    "source_file must be a relative path inside the workspace",
  );

export const GraphNodeSchema = z
  .object({
    id: identifier,
    label,
    kind: z.enum(["file", "symbol", "other"]),
    source_file: relativePath.nullable(),
    source_location: z.string().max(64).nullable(),
    community: z.number().int().nonnegative().nullable(),
    callable: z.boolean(),
  })
  .strict();
export type GraphNode = z.infer<typeof GraphNodeSchema>;

export const GraphEdgeSchema = z
  .object({
    source: identifier,
    target: identifier,
    relation: z.string().min(1).max(GRAPH_LIMITS.max_relation_length),
    confidence: z.enum(["EXTRACTED", "INFERRED", "AMBIGUOUS"]),
    source_file: relativePath.nullable(),
    source_location: z.string().max(64).nullable(),
  })
  .strict();
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;

export const GraphCommunitySchema = z
  .object({
    id: z.number().int().nonnegative(),
    label: label.nullable(),
    cohesion: z.number().min(0).max(1).nullable(),
    members: z.array(identifier).max(GRAPH_LIMITS.max_nodes),
  })
  .strict();
export type GraphCommunity = z.infer<typeof GraphCommunitySchema>;

/**
 * A derived, rebuildable code knowledge graph of one workspace revision.
 * It owns no memory: SQLite stores and the workspace stay authoritative and
 * the artifact is discarded and rebuilt whenever the revision moves.
 */
export const KnowledgeGraphArtifactSchema = z
  .object({
    schema_version: z.literal(1),
    producer: z
      .object({
        name: z.literal("graphify"),
        version: z.string().min(1).max(64),
        wrapper: z.literal(KNOWLEDGE_GRAPH_PRODUCER),
        wrapper_version: z.string().min(1).max(64),
      })
      .strict(),
    workspace: z
      .object({
        workspace_id: z.string().min(1),
        revision: z.string().min(1),
      })
      .strict(),
    built_at: z.string().datetime(),
    /** SHA-256 of the canonical nodes/edges/communities; same inputs give the same digest. */
    content_digest: z.string().regex(/^[a-f0-9]{64}$/),
    complete: z.boolean(),
    nodes: z.array(GraphNodeSchema).max(GRAPH_LIMITS.max_nodes),
    edges: z.array(GraphEdgeSchema).max(GRAPH_LIMITS.max_edges),
    communities: z
      .array(GraphCommunitySchema)
      .max(GRAPH_LIMITS.max_communities),
    stats: z
      .object({
        files: z.number().int().nonnegative(),
        nodes: z.number().int().nonnegative(),
        edges: z.number().int().nonnegative(),
        communities: z.number().int().nonnegative(),
        dropped_nodes: z.number().int().nonnegative(),
        dropped_edges: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
export type KnowledgeGraphArtifact = z.infer<
  typeof KnowledgeGraphArtifactSchema
>;

/** `graphify --version` and import probe result; cached by the service. */
export const GraphDoctorSchema = z
  .object({
    available: z.boolean(),
    version: z.string().nullable(),
    reason: z.string().nullable(),
    checked_at: z.string().datetime(),
  })
  .strict();
export type GraphDoctor = z.infer<typeof GraphDoctorSchema>;

/** Durable record of a build attempt; stored as a `tool.completed` task event by the host. */
export const GraphBuildRecordSchema = z
  .object({
    schema_version: z.literal(1),
    operation: z.literal("graph.build"),
    status: z.enum(["built", "unavailable", "failed", "stale", "refused"]),
    workspace_id: z.string().min(1),
    revision: z.string().min(1),
    content_digest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    graphify_version: z.string().nullable(),
    /** process_env: argv/env/cwd confinement only (no kernel sandbox); os_wrapper: operator-supplied wrapper prefix. */
    isolation: z.enum(["process_env", "os_wrapper"]),
    stats: KnowledgeGraphArtifactSchema.shape.stats.nullable(),
    limitations: z.array(z.string().max(512)).max(32),
    summary: z.string().max(2048),
    recorded_at: z.string().datetime(),
  })
  .strict();
export type GraphBuildRecord = z.infer<typeof GraphBuildRecordSchema>;
