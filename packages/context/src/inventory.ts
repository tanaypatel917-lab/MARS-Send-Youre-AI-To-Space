import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ParseCacheEntry } from "./cache";
import { ContextCancelledError, ContextIoError } from "./errors";
import { extractPython, PYTHON_EXTRACTOR_VERSION } from "./extract-python";
import { extractTypeScript, TS_EXTRACTOR_VERSION } from "./extract-ts";
import { type GitignoreRule, isGitignored, parseGitignore } from "./gitignore";
import {
  classifyPath,
  isGeneratedName,
  isSupportedLanguage,
  validateRelativePath,
} from "./policy";
import type {
  ExtractedFile,
  InventoryFile,
  RepositoryMapLimits,
  SkippedReason,
} from "./types";

export interface InventoryResult {
  files: InventoryFile[];
  digest: string;
  complete: boolean;
  skipped: Record<SkippedReason, number>;
  files_parsed: number;
  files_reused: number;
  cacheEntries: Map<string, ParseCacheEntry>;
}

export interface InventoryOptions {
  root: string;
  limits: RepositoryMapLimits;
  previous: ReadonlyMap<string, ParseCacheEntry>;
  signal?: AbortSignal;
  check: () => void;
}

const reasons: SkippedReason[] = [
  "ignored",
  "gitignored",
  "secret",
  "private_state",
  "dependency",
  "generated",
  "binary",
  "too_large",
  "symlink",
  "invalid_name",
  "limit",
];
export async function inventory(
  options: InventoryOptions,
): Promise<InventoryResult> {
  const files: InventoryFile[] = [];
  const skipped = Object.fromEntries(
    reasons.map((reason) => [reason, 0]),
  ) as Record<SkippedReason, number>;
  const cacheEntries = new Map<string, ParseCacheEntry>();
  let totalBytes = 0;
  let entriesVisited = 0;
  let complete = true;
  let filesParsed = 0;
  let filesReused = 0;

  const skip = (reason: SkippedReason) => {
    skipped[reason] += 1;
  };
  const skipCount = (reason: SkippedReason, count: number) => {
    skipped[reason] += count;
  };
  const check = () => {
    if (options.signal?.aborted) throw new ContextCancelledError();
    options.check();
  };
  const stopForLimit = () => {
    complete = false;
    skip("limit");
    return true;
  };

  const walk = async (
    absoluteDirectory: string,
    relativeDirectory: string,
    inheritedRules: readonly {
      prefix: string;
      rules: readonly GitignoreRule[];
    }[],
  ): Promise<void> => {
    check();
    const rules = [...inheritedRules];
    const ignorePath = join(absoluteDirectory, ".gitignore");
    try {
      const stat = await lstat(ignorePath);
      if (stat.isFile() && !stat.isSymbolicLink()) {
        if (stat.size > options.limits.maxFileBytes) {
          skip("too_large");
        } else if (totalBytes + stat.size > options.limits.maxTotalBytes) {
          stopForLimit();
          return;
        } else {
          const contents = await readNoFollow(ignorePath);
          totalBytes += contents.length;
          rules.push({
            prefix: relativeDirectory,
            rules: parseGitignore(contents.toString("utf8")),
          });
        }
      }
    } catch (error) {
      if (!isMissing(error)) throw asIoError(error);
    }

    let names: string[];
    try {
      names = await readdir(absoluteDirectory);
    } catch (error) {
      if (isMissing(error)) return;
      throw asIoError(error);
    }
    names.sort(compare);
    for (const name of names) {
      check();
      entriesVisited += 1;
      if (entriesVisited > options.limits.maxDirectoryEntries) {
        stopForLimit();
        return;
      }
      const relative = relativeDirectory
        ? `${relativeDirectory}/${name}`
        : name;
      const absolute = join(absoluteDirectory, name);
      try {
        validateRelativePath(relative, options.limits);
      } catch {
        skip("invalid_name");
        continue;
      }
      let stat: Awaited<ReturnType<typeof lstat>>;
      try {
        stat = await lstat(absolute);
      } catch (error) {
        if (isMissing(error)) continue;
        throw asIoError(error);
      }
      if (stat.isSymbolicLink()) {
        skip("symlink");
        continue;
      }
      if (!stat.isDirectory() && !stat.isFile()) continue;
      if (isGitignored(relative, stat.isDirectory(), rules)) {
        skip("gitignored");
        continue;
      }
      const policyReason = classifyPath(relative);
      if (policyReason) {
        skip(policyReason);
        continue;
      }
      if (stat.isDirectory()) {
        await walk(absolute, relative, rules);
        if (!complete) return;
        continue;
      }
      if (name === ".gitignore" || !isSupportedLanguage(relative)) continue;
      if (isGeneratedName(relative)) {
        skip("generated");
        continue;
      }
      if (stat.size > options.limits.maxFileBytes) {
        skip("too_large");
        continue;
      }
      if (files.length >= options.limits.maxFiles) {
        stopForLimit();
        return;
      }
      if (totalBytes + stat.size > options.limits.maxTotalBytes) {
        stopForLimit();
        return;
      }
      let bytes: Buffer;
      try {
        bytes = await readNoFollow(absolute);
      } catch (error) {
        if (isMissing(error)) continue;
        if (isSymlinkRace(error)) {
          skip("symlink");
          continue;
        }
        throw asIoError(error);
      }
      totalBytes += bytes.length;
      if (bytes.subarray(0, 8192).includes(0)) {
        skip("binary");
        continue;
      }
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        skip("binary");
        continue;
      }
      if (
        text.slice(0, 1024).includes("@generated") ||
        text.slice(0, 1024).includes("DO NOT EDIT") ||
        text.split(/\r?\n/).some((line) => line.length > 2000) ||
        (text.length > 0 &&
          text.length / Math.max(1, text.split(/\r?\n/).length) > 300)
      ) {
        skip("generated");
        continue;
      }
      if (text.includes("-----BEGIN") && text.includes("PRIVATE KEY-----")) {
        skip("secret");
        continue;
      }
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const extractorVersion = relative.toLowerCase().endsWith(".py")
        ? PYTHON_EXTRACTOR_VERSION
        : TS_EXTRACTOR_VERSION;
      const previous = options.previous.get(relative);
      let parsed: ExtractedFile;
      if (
        previous &&
        previous.sha256 === sha256 &&
        previous.extractorVersion === extractorVersion
      ) {
        parsed = previous;
        filesReused += 1;
      } else {
        parsed = relative.toLowerCase().endsWith(".py")
          ? extractPython(text, options.limits.maxSymbolsPerFile)
          : extractTypeScript(relative, text, options.limits.maxSymbolsPerFile);
        filesParsed += 1;
      }
      const entry: ParseCacheEntry = {
        sha256,
        extractorVersion,
        defs: parsed.defs,
        refs: parsed.refs,
        droppedSymbols: parsed.droppedSymbols ?? 0,
      };
      cacheEntries.set(relative, entry);
      files.push({
        path: relative,
        sha256,
        text,
        size: bytes.length,
        defs: entry.defs,
        refs: entry.refs,
      });
      if (parsed.droppedSymbols) {
        skipCount("limit", parsed.droppedSymbols);
      }
    }
  };

  await walk(options.root, "", []);
  files.sort((left, right) => compare(left.path, right.path));
  const digest = createHash("sha256")
    .update(files.map((file) => `${file.path}\0${file.sha256}\n`).join(""))
    .digest("hex");
  return {
    files,
    digest,
    complete,
    skipped,
    files_parsed: filesParsed,
    files_reused: filesReused,
    cacheEntries,
  };
}

async function readNoFollow(path: string): Promise<Buffer> {
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isSymlinkRace(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ELOOP" || code === "EMLINK";
}

function asIoError(_error: unknown): ContextIoError {
  return new ContextIoError();
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
