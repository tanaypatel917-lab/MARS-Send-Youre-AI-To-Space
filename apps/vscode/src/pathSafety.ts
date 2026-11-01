import { isAbsolute, join, relative, sep } from "node:path";

export type PathCheck =
  | { ok: true; segments: string[] }
  | { ok: false; reason: string };

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const WINDOWS_RESERVED = /[<>:"|?*]/;

/**
 * Validates a server-supplied, workspace-relative POSIX path. Anything that
 * could escape the workspace or be interpreted as a URI/command is rejected.
 */
export function checkRelativePath(path: string): PathCheck {
  if (path.length === 0 || path.length > 1024)
    return { ok: false, reason: "Path is empty or too long." };
  if (
    Array.from(path).some(
      (char) => char.charCodeAt(0) < 0x20 || char === "\u007f",
    )
  )
    return { ok: false, reason: "Path contains control characters." };
  if (path.includes("\\"))
    return { ok: false, reason: "Path must use forward slashes." };
  if (SCHEME.test(path))
    return { ok: false, reason: "Path must not be a URI or drive path." };
  if (path.startsWith("/") || path.startsWith("~"))
    return { ok: false, reason: "Path must be workspace-relative." };
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..")
      return { ok: false, reason: "Path has an empty, '.' or '..' segment." };
    if (WINDOWS_RESERVED.test(segment))
      return { ok: false, reason: "Path contains reserved characters." };
    if (segment.toLowerCase() === ".git")
      return { ok: false, reason: "Paths inside .git are not opened." };
  }
  return { ok: true, segments };
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return (
    rel !== "" &&
    rel !== ".." &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel)
  );
}

export type Realpath = (path: string) => Promise<string>;

export type ResolvedPath =
  | { ok: true; fsPath: string; exists: boolean }
  | { ok: false; reason: string };

/**
 * Resolves validated segments under `root`, following symlinks for the
 * deepest existing ancestor so a link cannot point outside the workspace.
 */
export async function resolveInsideRoot(
  root: string,
  segments: readonly string[],
  realpath: Realpath,
): Promise<ResolvedPath> {
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    return { ok: false, reason: "Workspace folder is not accessible." };
  }
  const target = join(realRoot, ...segments);
  if (!inside(realRoot, target))
    return { ok: false, reason: "Path escapes the workspace." };
  for (let depth = segments.length; depth >= 0; depth--) {
    const probe = join(realRoot, ...segments.slice(0, depth));
    let real: string;
    try {
      real = await realpath(probe);
    } catch {
      continue;
    }
    if (depth > 0 && !inside(realRoot, real))
      return { ok: false, reason: "Path resolves outside the workspace." };
    if (depth === 0 && real !== realRoot)
      return { ok: false, reason: "Workspace folder changed." };
    return depth === segments.length
      ? { ok: true, fsPath: real, exists: true }
      : { ok: true, fsPath: target, exists: false };
  }
  return { ok: false, reason: "Workspace folder is not accessible." };
}
