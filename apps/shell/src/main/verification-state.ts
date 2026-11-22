import { chmod, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";

const safeMountPath = /^[A-Za-z0-9._/-]+$/;

export async function verificationStateRoot(state: string, home: string) {
  if (safeMountPath.test(state)) return { state };
  const fallback = join(home, ".mars", "desktop-workbench");
  if (safeMountPath.test(fallback)) {
    try {
      await mkdir(fallback, { recursive: true, mode: 0o700 });
      await chmod(fallback, 0o700);
      const canonical = await realpath(fallback);
      if (safeMountPath.test(canonical)) return { state: canonical };
    } catch {
      // Keep the project usable without command execution.
    }
  }
  return {
    state,
    reason:
      "Verification needs a private workspace path without spaces or special characters. Choose a home directory without these characters and restart MARS.",
  };
}
