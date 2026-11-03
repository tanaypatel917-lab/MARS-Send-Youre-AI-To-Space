import { readFile, unlink } from "node:fs/promises";

/**
 * Removes a credential from a process environment and returns its value.
 *
 * Deleting from `process.env` does not scrub `/proc/<pid>/environ` (the kernel
 * serves the environment block the process was started with), so the Harbor
 * adapter hands the credential over through a file instead; this fallback only
 * covers direct launches of the bundle.
 */
export function claimCredential(
  env: Record<string, string | undefined>,
  name: string,
): string | undefined {
  const value = env[name];
  delete env[name];
  return value;
}

/**
 * Reads a credential handed over as a file and deletes the file, so neither
 * the bundle's environment nor the filesystem keeps it once the runtime holds
 * its own copy. Task commands only run after this has completed.
 */
export async function claimCredentialFile(
  path: string,
): Promise<string | undefined> {
  let value: string;
  try {
    value = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  await unlink(path);
  const trimmed = value.replace(/\r?\n$/, "");
  return trimmed.length === 0 ? undefined : trimmed;
}
