import type { RequestContext, WorkspaceRef } from "@mars/contracts";
import { z } from "zod";

export interface AuthorizedWorkspaceRoot {
  root: string;
  revision: string;
}

export type WorkspaceRootResolver = (
  context: RequestContext,
  workspace: WorkspaceRef,
) => Promise<AuthorizedWorkspaceRoot>;

export interface RepositoryMapLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxDepth: number;
  maxPathBytes: number;
  maxDirectoryEntries: number;
  maxSymbolsPerFile: number;
  maxCandidates: number;
  timeoutMs: number;
}

export interface TokenCounter {
  id: string;
  count(text: string): number;
}

export interface RepositoryMapProviderOptions {
  resolveRoot: WorkspaceRootResolver;
  limits?: Partial<RepositoryMapLimits>;
  tokenCounter?: TokenCounter;
  maxCachedWorkspaces?: number;
  maxCachedMapsPerWorkspace?: number;
  now?: () => number;
}

export const WorkspaceRefSchema = z
  .object({
    workspace_id: z.string().min(1),
    provider: z.string().min(1),
    revision: z.string().min(1),
  })
  .strict();

export const RepositoryMapRequestSchema = z
  .object({
    workspace: WorkspaceRefSchema,
    query: z.string().max(4096).optional(),
    mentioned_files: z.array(z.string()).max(256).optional(),
    mentioned_symbols: z.array(z.string().min(1).max(256)).max(256).optional(),
    max_output_tokens: z.number().int().min(1).max(65_536),
  })
  .strict();

export type RepositoryMapRequest = z.infer<typeof RepositoryMapRequestSchema>;

export type SymbolKind =
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "function"
  | "method"
  | "property"
  | "variable"
  | "namespace";

export interface RepositoryMapSymbol {
  name: string;
  kind: SymbolKind;
  line: number;
  signature: string;
  rank: number;
}

export interface RepositoryMapFile {
  path: string;
  rank: number;
  symbols: RepositoryMapSymbol[];
}

export type SkippedReason =
  | "ignored"
  | "gitignored"
  | "secret"
  | "private_state"
  | "dependency"
  | "generated"
  | "binary"
  | "too_large"
  | "symlink"
  | "invalid_name"
  | "limit";

export interface RepositoryMap {
  schema_version: 1;
  workspace: { workspace_id: string; revision: string };
  content_digest: string;
  token_policy: string;
  max_output_tokens: number;
  token_count: number;
  text: string;
  files: RepositoryMapFile[];
  truncated: boolean;
  complete: boolean;
  stats: {
    files_inventoried: number;
    files_parsed: number;
    files_reused: number;
    map_cache_hit: boolean;
    skipped: Record<SkippedReason, number>;
    unmatched_mentions: number;
    candidates: number;
    selected_symbols: number;
  };
}

export interface RepositoryMapProvider {
  map(
    context: RequestContext,
    request: RepositoryMapRequest,
    options?: { signal?: AbortSignal },
  ): Promise<RepositoryMap>;
  invalidate(
    context: RequestContext,
    workspace: Pick<WorkspaceRef, "workspace_id">,
    paths?: readonly string[],
  ): Promise<void>;
  close(): Promise<void>;
}

export interface Definition {
  name: string;
  kind: SymbolKind;
  line: number;
  signature: string;
  depth: number;
}

export interface ExtractedFile {
  defs: Definition[];
  refs: Map<string, number>;
  droppedSymbols?: number;
}

export interface InventoryFile extends ExtractedFile {
  path: string;
  sha256: string;
  text: string;
  size: number;
}

export interface RankedCandidates {
  candidates: Array<
    | { type: "symbol"; path: string; definition: Definition; rank: number }
    | { type: "file"; path: string; rank: number }
  >;
  fileRanks: Map<string, number>;
  truncated: boolean;
}
