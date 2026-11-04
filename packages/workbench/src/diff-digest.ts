import { createHash } from "node:crypto";
import type { DiffResult } from "./protocol";

/**
 * SHA-256 (lowercase hex) of a canonical serialization of a `tasks.diff`
 * result, so a verification verdict can be pinned to the exact patch it was
 * recorded against and compared byte-for-byte later.
 *
 * Canonical form: files sorted by `path` (UTF-16 code unit order, which is
 * byte order for the ASCII paths the provider emits; duplicate paths are
 * rejected), every `patch` LF-normalised (`\r\n` and lone `\r` become `\n`),
 * then `JSON.stringify({ files: [[path, status, patch], ...] })` with no
 * whitespace. Anything else about the diff (file order, CRLF line endings) is
 * not part of the digest; any other byte change is.
 */
export function diffDigest(diff: DiffResult): string {
  const seen = new Set<string>();
  const files = [...diff.files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((file) => {
      if (seen.has(file.path))
        throw new Error("diffDigest: duplicate path in diff");
      seen.add(file.path);
      return [file.path, file.status, file.patch.replace(/\r\n?/g, "\n")];
    });
  return createHash("sha256").update(JSON.stringify({ files })).digest("hex");
}
