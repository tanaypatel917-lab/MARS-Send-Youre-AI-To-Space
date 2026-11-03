import { matchWorkspaceFolder, type WorkspaceFolderInfo } from "./diffOpener";
import { type Realpath, resolveInsideRoot } from "./pathSafety";
import type { DescribeResult } from "./protocol";

export interface ReviewTarget {
  path: string;
  segments: readonly string[];
  line_start: number;
  line_end: number;
  side: "left" | "right";
  pr: string;
}

export interface LocalFileInfo {
  kind: "file" | "directory" | "other";
  /** Line count of a text file; 0 for anything else. */
  lines: number;
}

export interface ReviewOpenerHost {
  folders(): readonly WorkspaceFolderInfo[];
  realpath: Realpath;
  inspect(fsPath: string): Promise<LocalFileInfo>;
  showRange(
    fsPath: string,
    lineStart: number,
    lineEnd: number,
    title: string,
  ): Promise<void>;
}

export type ReviewOutcome =
  | { ok: true; note?: string }
  | { ok: false; reason: string };

/**
 * Opens the local file a `mars://review` link names and selects its line
 * range. The link is a model proposal: the path must already have passed
 * `checkRelativePath`, is resolved only inside the single matching workspace
 * folder, and the PR URL is shown in the title but never fetched.
 */
export async function openReviewTarget(
  host: ReviewOpenerHost,
  server: DescribeResult,
  target: ReviewTarget,
): Promise<ReviewOutcome> {
  const folder = matchWorkspaceFolder(host.folders(), server);
  if ("reason" in folder) return { ok: false, reason: folder.reason };
  const resolved = await resolveInsideRoot(
    folder.fsPath,
    target.segments,
    host.realpath,
  );
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  if (!resolved.exists)
    return { ok: false, reason: "The file does not exist locally." };
  let info: LocalFileInfo;
  try {
    info = await host.inspect(resolved.fsPath);
  } catch {
    return { ok: false, reason: "The local file could not be read." };
  }
  if (info.kind === "directory")
    return { ok: false, reason: "The path is a directory, not a file." };
  if (info.kind !== "file")
    return { ok: false, reason: "The path is not a regular file." };
  if (target.line_start > info.lines)
    return {
      ok: false,
      reason: `The local file has ${info.lines} lines; the link names ${target.line_start}-${target.line_end}.`,
    };
  const lineEnd = Math.min(target.line_end, info.lines);
  try {
    await host.showRange(
      resolved.fsPath,
      target.line_start,
      lineEnd,
      `MARS review: ${target.path}:${target.line_start}-${target.line_end} (${target.side} side of ${target.pr})`,
    );
  } catch {
    return { ok: false, reason: "The editor could not open the file." };
  }
  return lineEnd === target.line_end
    ? { ok: true }
    : {
        ok: true,
        note: `the local file ends at line ${info.lines}, so lines ${lineEnd + 1}-${target.line_end} were not selected`,
      };
}
