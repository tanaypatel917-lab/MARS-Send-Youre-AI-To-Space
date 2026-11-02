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

export interface ReviewOpenerHost {
  folders(): readonly WorkspaceFolderInfo[];
  realpath: Realpath;
  showRange(
    fsPath: string,
    lineStart: number,
    lineEnd: number,
    title: string,
  ): Promise<void>;
}

export type ReviewOutcome = { ok: true } | { ok: false; reason: string };

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
  await host.showRange(
    resolved.fsPath,
    target.line_start,
    target.line_end,
    `MARS review: ${target.path}:${target.line_start}-${target.line_end} (${target.side} side of ${target.pr})`,
  );
  return { ok: true };
}
