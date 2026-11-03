import { isAbsolute, relative, resolve, sep } from "node:path";

const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const KEEP = /[A-Za-z0-9._-]/;
const MAX_SEGMENT = 128;

function percentEncode(char: string): string {
  return Array.from(new TextEncoder().encode(char))
    .map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`)
    .join("");
}

/**
 * Maps an id, name or path component to one safe file-name segment. Safe
 * inputs pass through unchanged; anything else is percent-encoded per code
 * point (including `%` itself, so decoding is unambiguous), a leading `.` or
 * `-` is encoded so no segment is hidden or looks like an option, and
 * overlong results are truncated with a digest suffix.
 */
export function encodeSegment(value: string): string {
  if (value.length === 0) throw new VaultPathError("empty_segment");
  if (SAFE.test(value) && value !== "." && value !== "..") return value;
  let out = "";
  let index = 0;
  for (const char of value) {
    out +=
      KEEP.test(char) && !(index === 0 && (char === "." || char === "-"))
        ? char
        : percentEncode(char);
    index += 1;
  }
  if (out.length > MAX_SEGMENT) {
    const digest = new Bun.CryptoHasher("sha256")
      .update(value)
      .digest("hex")
      .slice(0, 16);
    out = `${out.slice(0, MAX_SEGMENT - 17)}-${digest}`;
  }
  return out;
}

/**
 * Workspace-relative source path → one segment (`/` and `\` become `__`).
 * Runs of two or more underscores inside a component are percent-encoded so
 * `a/b` and `a__b` never collide.
 */
export function encodeSourcePath(path: string): string {
  return path
    .split(/[\\/]+/)
    .filter((part) => part.length > 0)
    .map((part) =>
      encodeSegment(part).replace(/_{2,}/g, (run) => "%5F".repeat(run.length)),
    )
    .join("__");
}

export class VaultPathError extends Error {
  constructor(
    readonly code:
      | "empty_segment"
      | "path_escape"
      | "private_root"
      | "path_collision",
    detail?: string,
  ) {
    super(
      detail ? `memory-vault: ${code}: ${detail}` : `memory-vault: ${code}`,
    );
    this.name = "VaultPathError";
  }
}

export function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return (
    path === "" ||
    (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`))
  );
}

/**
 * Validates a vault-relative note path (forward slashes, no empty, `.` or
 * `..` segments, no absolute or drive prefix) and returns its absolute
 * location, which must stay inside `vaultDir`.
 */
export function resolveInside(vaultDir: string, notePath: string): string {
  if (
    notePath.length === 0 ||
    notePath.includes("\\") ||
    notePath.includes("\0") ||
    notePath.startsWith("/") ||
    /^[A-Za-z]:/.test(notePath) ||
    notePath
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  )
    throw new VaultPathError("path_escape", notePath);
  const absolute = resolve(vaultDir, notePath);
  if (!contains(vaultDir, absolute) || absolute === vaultDir)
    throw new VaultPathError("path_escape", notePath);
  return absolute;
}

/** Refuses a vault directory that overlaps any host-private root. */
export function assertVaultDirectory(
  vaultDir: string,
  privateRoots: readonly string[],
): void {
  for (const root of privateRoots) {
    const resolved = resolve(root);
    if (contains(resolved, vaultDir) || contains(vaultDir, resolved))
      throw new VaultPathError("private_root");
  }
}
