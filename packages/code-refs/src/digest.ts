import type { Locator } from "./schemas";

export type ReferenceIdentity = Pick<
  Locator,
  "repo_id" | "commit_sha" | "path" | "line_start" | "line_end"
>;

/**
 * SHA-256 (hex) of `repo_id\ncommit_sha\npath\nline_start\nline_end`, with
 * an absent bound encoded as the empty string. Stable across processes, so
 * the chat side can use it as an immutable reference id.
 */
export function referenceDigest(ref: ReferenceIdentity): string {
  const material = [
    ref.repo_id,
    ref.commit_sha,
    ref.path,
    ref.line_start === null ? "" : String(ref.line_start),
    ref.line_end === null ? "" : String(ref.line_end),
  ].join("\n");
  return new Bun.CryptoHasher("sha256").update(material).digest("hex");
}

export function isSameReference(
  a: ReferenceIdentity,
  b: ReferenceIdentity,
): boolean {
  return (
    a.repo_id === b.repo_id &&
    a.commit_sha === b.commit_sha &&
    a.path === b.path &&
    a.line_start === b.line_start &&
    a.line_end === b.line_end
  );
}
