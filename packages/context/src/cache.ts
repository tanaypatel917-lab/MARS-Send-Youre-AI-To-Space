import type { ExtractedFile, RepositoryMap } from "./types";

export interface ParseCacheEntry extends ExtractedFile {
  sha256: string;
  extractorVersion: string;
}

export interface WorkspaceCache {
  scopeKey: string;
  rootHash: string;
  files: Map<string, ParseCacheEntry>;
  maps: Map<string, RepositoryMap>;
}

export function touchMap(
  maps: Map<string, RepositoryMap>,
  key: string,
  value: RepositoryMap,
  limit: number,
): void {
  maps.delete(key);
  maps.set(key, value);
  while (maps.size > limit) {
    const oldest = maps.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    maps.delete(oldest);
  }
}

export function touchWorkspace(
  workspaces: Map<string, WorkspaceCache>,
  key: string,
  value: WorkspaceCache,
  limit: number,
): void {
  workspaces.delete(key);
  workspaces.set(key, value);
  while (workspaces.size > limit) {
    const oldest = workspaces.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    workspaces.delete(oldest);
  }
}

export function cloneMap(map: RepositoryMap): RepositoryMap {
  return {
    ...map,
    workspace: { ...map.workspace },
    files: map.files.map((file) => ({
      ...file,
      symbols: file.symbols.map((symbol) => ({ ...symbol })),
    })),
    stats: {
      ...map.stats,
      skipped: { ...map.stats.skipped },
    },
  };
}
