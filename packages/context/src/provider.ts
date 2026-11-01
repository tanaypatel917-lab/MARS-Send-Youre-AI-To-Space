import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import type { RequestContext } from "@mars/contracts";
import { ScopeSchema } from "@mars/contracts";
import {
  cloneMap,
  touchMap,
  touchWorkspace,
  type WorkspaceCache,
} from "./cache";
import {
  ContextCancelledError,
  ContextClosedError,
  ContextIoError,
  ContextLimitError,
  ContextPolicyError,
  ContextRevisionError,
} from "./errors";
import { inventory } from "./inventory";
import {
  validateContext,
  validateRelativePath,
  validateWorkspaceScope,
} from "./policy";
import { rankFiles } from "./rank";
import { packCandidates } from "./render";
import { conservativeTokenCounter } from "./tokens";
import {
  type AuthorizedWorkspaceRoot,
  type RepositoryMap,
  type RepositoryMapLimits,
  type RepositoryMapProvider,
  type RepositoryMapProviderOptions,
  type RepositoryMapRequest,
  RepositoryMapRequestSchema,
} from "./types";

export const DEFAULT_REPOSITORY_MAP_LIMITS: RepositoryMapLimits = Object.freeze(
  {
    maxFiles: 5_000,
    maxFileBytes: 512 * 1024,
    maxTotalBytes: 32 * 1024 * 1024,
    maxDepth: 32,
    maxPathBytes: 1024,
    maxDirectoryEntries: 100_000,
    maxSymbolsPerFile: 2_000,
    maxCandidates: 4_000,
    timeoutMs: 10_000,
  },
);

export function createRepositoryMapProvider(
  options: RepositoryMapProviderOptions,
): RepositoryMapProvider {
  const limits = { ...DEFAULT_REPOSITORY_MAP_LIMITS, ...options.limits };
  const tokenCounter = options.tokenCounter ?? conservativeTokenCounter;
  const maxCachedWorkspaces = options.maxCachedWorkspaces ?? 32;
  const maxCachedMaps = options.maxCachedMapsPerWorkspace ?? 16;
  const now = options.now ?? (() => performance.now());
  const workspaces = new Map<string, WorkspaceCache>();
  const locks = new Map<string, Promise<void>>();
  let closed = false;

  const lock = async <T>(key: string, action: () => Promise<T>): Promise<T> => {
    const previous = locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    locks.set(key, queued);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (locks.get(key) === queued) locks.delete(key);
    }
  };

  const assertOpen = () => {
    if (closed) throw new ContextClosedError();
  };

  const map = async (
    context: RequestContext,
    rawRequest: unknown,
    callOptions: { signal?: AbortSignal } = {},
  ): Promise<RepositoryMap> => {
    assertOpen();
    validateContext(context);
    let request: RepositoryMapRequest;
    try {
      request = RepositoryMapRequestSchema.parse(rawRequest);
    } catch {
      throw new ContextPolicyError("Invalid repository map request");
    }
    validateWorkspaceScope(context, request.workspace);
    const mentionedFiles = [
      ...new Set(
        (request.mentioned_files ?? []).map((path) =>
          validateRelativePath(path, limits),
        ),
      ),
    ].sort(compare);
    const mentionedSymbols = [...new Set(request.mentioned_symbols ?? [])].sort(
      compare,
    );
    const normalizedRequest = {
      query: request.query ?? "",
      mentioned_files: mentionedFiles,
      mentioned_symbols: mentionedSymbols,
      max_output_tokens: request.max_output_tokens,
    };
    const baseKey = scopeKey(context, request.workspace.workspace_id);
    return lock(baseKey, async () => {
      assertOpen();
      const started = now();
      const check = () => {
        if (callOptions.signal?.aborted) throw new ContextCancelledError();
        if (now() - started > limits.timeoutMs) throw new ContextLimitError();
      };
      check();
      let authorized: AuthorizedWorkspaceRoot;
      try {
        authorized = await options.resolveRoot(context, request.workspace);
      } catch {
        throw new ContextPolicyError("Workspace is not authorized");
      }
      if (
        !authorized ||
        typeof authorized.root !== "string" ||
        typeof authorized.revision !== "string"
      ) {
        throw new ContextPolicyError("Workspace is not authorized");
      }
      if (authorized.revision !== request.workspace.revision) {
        throw new ContextRevisionError();
      }
      let root: string;
      try {
        root = await realpath(authorized.root);
        if (!(await stat(root)).isDirectory()) {
          throw new Error("not a directory");
        }
      } catch {
        throw new ContextIoError();
      }
      check();
      const rootHash = createHash("sha256").update(root).digest("hex");
      const key = `${baseKey}\0${rootHash}`;
      for (const [otherKey, entry] of workspaces) {
        if (entry.scopeKey === baseKey && otherKey !== key)
          workspaces.delete(otherKey);
      }
      let workspaceCache = workspaces.get(key);
      if (workspaceCache && workspaceCache.rootHash !== rootHash) {
        workspaces.delete(key);
        workspaceCache = undefined;
      }
      if (!workspaceCache) {
        workspaceCache = {
          scopeKey: baseKey,
          rootHash,
          files: new Map(),
          maps: new Map(),
        };
      }
      const result = await inventory({
        root,
        limits,
        previous: workspaceCache.files,
        ...(callOptions.signal ? { signal: callOptions.signal } : {}),
        check,
      });
      check();
      const currentFiles = result.cacheEntries;
      const normalizedMentions = new Set(mentionedSymbols);
      for (const symbol of mentionedSymbols)
        normalizedMentions.add(symbol.toLowerCase());
      const queryTerms = (
        request.query?.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []
      ).filter((term) => term.length >= 3);
      for (const file of result.files) {
        for (const definition of file.defs) {
          if (
            queryTerms.some(
              (term) => term.toLowerCase() === definition.name.toLowerCase(),
            )
          ) {
            normalizedMentions.add(definition.name);
          }
        }
      }
      const presentFiles = new Set(result.files.map((file) => file.path));
      const unmatched = mentionedFiles.filter(
        (path) => !presentFiles.has(path),
      ).length;
      const rank = rankFiles(
        result.files,
        new Set(mentionedFiles.filter((path) => presentFiles.has(path))),
        normalizedMentions,
        request.query ?? "",
        limits.maxCandidates,
        check,
      );
      const packed = packCandidates(
        rank.candidates,
        request.max_output_tokens,
        tokenCounter,
      );
      check();
      const mapKey = createHash("sha256")
        .update(
          JSON.stringify([
            result.digest,
            tokenCounter.id,
            limits,
            normalizedRequest,
            request.workspace.revision,
          ]),
        )
        .digest("hex");
      const cachedMap = workspaceCache.maps.get(mapKey);
      if (cachedMap) {
        workspaceCache.files = currentFiles;
        touchWorkspace(workspaces, key, workspaceCache, maxCachedWorkspaces);
        touchMap(workspaceCache.maps, mapKey, cachedMap, maxCachedMaps);
        const cloned = cloneMap(cachedMap);
        cloned.stats.map_cache_hit = true;
        cloned.stats.files_parsed = 0;
        cloned.stats.files_reused = result.files.length;
        return cloned;
      }
      const baseMap: RepositoryMap = {
        schema_version: 1,
        workspace: {
          workspace_id: request.workspace.workspace_id,
          revision: request.workspace.revision,
        },
        content_digest: result.digest,
        token_policy: tokenCounter.id,
        max_output_tokens: request.max_output_tokens,
        token_count: packed.token_count,
        text: packed.text,
        files: packed.files,
        truncated: packed.truncated || rank.truncated,
        complete: result.complete,
        stats: {
          files_inventoried: result.files.length,
          files_parsed: result.files_parsed,
          files_reused: result.files_reused,
          map_cache_hit: false,
          skipped: result.skipped,
          unmatched_mentions: unmatched,
          candidates: packed.candidates,
          selected_symbols: packed.selected_symbols,
        },
      };
      workspaceCache.files = currentFiles;
      touchMap(workspaceCache.maps, mapKey, baseMap, maxCachedMaps);
      touchWorkspace(workspaces, key, workspaceCache, maxCachedWorkspaces);
      return cloneMap(baseMap);
    });
  };

  const invalidate: RepositoryMapProvider["invalidate"] = async (
    context,
    workspace,
    paths,
  ) => {
    assertOpen();
    validateContext(context);
    if (
      !workspace ||
      typeof workspace.workspace_id !== "string" ||
      !workspace.workspace_id
    ) {
      throw new ContextPolicyError("Invalid workspace");
    }
    if (
      context.scope.workspace_id !== undefined &&
      context.scope.workspace_id !== workspace.workspace_id
    ) {
      throw new ContextPolicyError("Workspace is outside the request scope");
    }
    const baseKey = scopeKey(context, workspace.workspace_id);
    return lock(baseKey, async () => {
      assertOpen();
      const entries = [...workspaces].filter(
        ([, value]) => value.scopeKey === baseKey,
      );
      if (paths === undefined) {
        for (const [key] of entries) workspaces.delete(key);
        return;
      }
      const normalized = paths.map((path) =>
        validateRelativePath(path, limits),
      );
      for (const [, entry] of entries) {
        for (const path of normalized) {
          for (const cachedPath of entry.files.keys()) {
            if (cachedPath === path || cachedPath.startsWith(`${path}/`)) {
              entry.files.delete(cachedPath);
            }
          }
        }
        entry.maps.clear();
      }
    });
  };

  const close = async () => {
    closed = true;
    await Promise.allSettled([...locks.values()]);
    workspaces.clear();
    locks.clear();
  };

  return { map, invalidate, close };
}

function scopeKey(context: RequestContext, workspaceId: string): string {
  const scope = ScopeSchema.parse(context.scope);
  return JSON.stringify([scope.owner_id, scope.project_id, workspaceId]);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
