import { applyParsed, parsePatch } from "./patch";
import {
  checkRelativePath,
  type Realpath,
  resolveInsideRoot,
} from "./pathSafety";
import type { DescribeResult, DiffFile } from "./protocol";

export interface WorkspaceFolderInfo {
  name: string;
  fsPath: string;
}

export type DiffSide =
  | { kind: "file"; fsPath: string }
  | { kind: "text"; text: string; label: string };

export interface DiffOpenerHost {
  folders(): readonly WorkspaceFolderInfo[];
  realpath: Realpath;
  readText(fsPath: string): Promise<string>;
  showDiff(left: DiffSide, right: DiffSide, title: string): Promise<void>;
  showPatch(patch: string, title: string): Promise<void>;
}

/**
 * How a native diff was built. `task-only` sides come entirely from the patch;
 * `local-before` means the local file is the untouched baseline (isolated task
 * workspace) and the task version was derived by applying the patch forward;
 * `local-after` means the local file already contains the change.
 */
export type DiffBasis = "task-only" | "local-before" | "local-after";

export type OpenOutcome =
  | { mode: "diff"; basis: DiffBasis }
  | { mode: "patch"; reason: string }
  | { mode: "rejected"; reason: string };

const MAX_LOCAL_CHARS = 8 * 1024 * 1024;

/**
 * Picks the open workspace folder the server describes. A diff is opened
 * against local files only when exactly one folder matches the server's
 * workspace label.
 */
export function matchWorkspaceFolder(
  folders: readonly WorkspaceFolderInfo[],
  server: DescribeResult,
): WorkspaceFolderInfo | { reason: string } {
  const matches = folders.filter(
    (folder) => folder.name === server.workspaceLabel,
  );
  if (matches.length === 1 && matches[0]) return matches[0];
  if (matches.length > 1)
    return { reason: "Several open folders match the server workspace." };
  return {
    reason: `No open workspace folder is named "${server.workspaceLabel}".`,
  };
}

/**
 * Opens a read-only native diff for one server-reported file. The task's edits
 * live in a private copy, so the local checkout normally holds BEFORE: the
 * patch is applied forward to derive the task's AFTER into a virtual buffer.
 * Added and deleted files are derived from the patch alone. A local file that
 * already matches AFTER is shown against a reconstructed BEFORE. Anything else
 * falls back to the read-only patch; unsafe paths and binary or malformed
 * patches are refused. Nothing is ever written to disk.
 */
export async function openFileDiff(
  host: DiffOpenerHost,
  server: DescribeResult,
  file: DiffFile,
): Promise<OpenOutcome> {
  const check = checkRelativePath(file.path);
  if (!check.ok) return { mode: "rejected", reason: check.reason };
  const parsed = parsePatch(file.patch);
  if (!parsed.ok) return { mode: "rejected", reason: parsed.reason };
  const title = `MARS: ${file.path} (${file.status})`;
  const name = check.segments.at(-1) ?? "file";
  const side = (role: string, text: string): DiffSide => ({
    kind: "text",
    text,
    label: `${role}-${name}`,
  });
  const fallback = async (reason: string): Promise<OpenOutcome> => {
    await host.showPatch(file.patch, title);
    return { mode: "patch", reason };
  };
  const show = async (
    left: DiffSide,
    right: DiffSide,
    basis: DiffBasis,
  ): Promise<OpenOutcome> => {
    await host.showDiff(left, right, title);
    return { mode: "diff", basis };
  };

  if (file.status === "added") {
    const content = applyParsed("", parsed.patch);
    if (content === null)
      return fallback("Patch is not a pure added-file patch.");
    return show(side("empty", ""), side("task", content), "task-only");
  }
  if (file.status === "deleted") {
    const original = applyParsed("", parsed.patch, true);
    if (original === null)
      return fallback("Patch is not a pure deleted-file patch.");
    return show(side("before", original), side("deleted", ""), "task-only");
  }

  const folder = matchWorkspaceFolder(host.folders(), server);
  if ("reason" in folder) return fallback(folder.reason);
  const resolved = await resolveInsideRoot(
    folder.fsPath,
    check.segments,
    host.realpath,
  );
  if (!resolved.ok) return { mode: "rejected", reason: resolved.reason };
  if (!resolved.exists)
    return fallback("The local baseline file is not present.");
  let local: string;
  try {
    local = await host.readText(resolved.fsPath);
  } catch {
    return fallback("The local file could not be read.");
  }
  if (local.length > MAX_LOCAL_CHARS || local.includes("\u0000"))
    return fallback("The local file is too large or not text.");
  const after = applyParsed(local, parsed.patch);
  if (after !== null)
    return show(side("local", local), side("task", after), "local-before");
  const before = applyParsed(local, parsed.patch, true);
  if (before !== null)
    return show(
      side("before", before),
      { kind: "file", fsPath: resolved.fsPath },
      "local-after",
    );
  return fallback(
    "The local file matches neither side of the patch (it may have local edits).",
  );
}
