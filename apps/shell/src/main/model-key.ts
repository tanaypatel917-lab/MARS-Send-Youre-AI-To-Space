import { lstat } from "node:fs/promises";

/** A stored key can be removed even if this login cannot decrypt it. */
export async function hasRemovableKey(
  path: string,
  sessionKey?: string,
): Promise<boolean> {
  if (sessionKey) return true;
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}
