import { reconstructOriginal, removedText } from "./patch";
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

export type OpenOutcome =
  | { mode: "diff" }
  | { mode: "patch"; reason: string }
  | { mode: "rejected"; reason: string };

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
 * Opens a native diff for one server-reported file. Paths are validated and
 * resolved inside the matched workspace folder; if that is not possible the
 * patch is shown read-only instead, and unsafe paths are refused entirely.
 */
export async function openFileDiff(
  host: DiffOpenerHost,
  server: DescribeResult,
  file: DiffFile,
): Promise<OpenOutcome> {
  const check = checkRelativePath(file.path);
  if (!check.ok) return { mode: "rejected", reason: check.reason };
  const title = `MARS: ${file.path} (${file.status})`;
  const fallback = async (reason: string): Promise<OpenOutcome> => {
    await host.showPatch(file.patch, title);
    return { mode: "patch", reason };
  };
  const folder = matchWorkspaceFolder(host.folders(), server);
  if ("reason" in folder) return fallback(folder.reason);
  const resolved = await resolveInsideRoot(
    folder.fsPath,
    check.segments,
    host.realpath,
  );
  if (!resolved.ok) return { mode: "rejected", reason: resolved.reason };
  const empty = { kind: "text", text: "", label: "empty" } as const;

  if (file.status === "deleted") {
    const original = removedText(file.patch);
    if (original === null) return fallback("Patch could not be parsed.");
    await host.showDiff(
      { kind: "text", text: original, label: "before" },
      empty,
      title,
    );
    return { mode: "diff" };
  }
  if (!resolved.exists)
    return fallback("File is not present in the workspace.");
  const right = { kind: "file", fsPath: resolved.fsPath } as const;
  if (file.status === "added") {
    await host.showDiff(empty, right, title);
    return { mode: "diff" };
  }
  let current: string;
  try {
    current = await host.readText(resolved.fsPath);
  } catch {
    return fallback("File could not be read.");
  }
  const original = reconstructOriginal(current, file.patch);
  if (original === null)
    return fallback("The file changed since the patch was produced.");
  await host.showDiff(
    { kind: "text", text: original, label: "before" },
    right,
    title,
  );
  return { mode: "diff" };
}
