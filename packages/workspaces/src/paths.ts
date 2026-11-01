import { lstat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { WorkspacePolicyError } from "./errors";
import type { WorkspaceLimits } from "./tree";

const ignoredNames = new Set([
  ".git",
  ".hg",
  ".svn",
  ".mars",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".tox",
  ".gradle",
  ".terraform",
]);
const secretNames = new Set([
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".git-credentials",
  ".htpasswd",
]);
const secretExtensions = new Set([
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".keystore",
  ".jks",
]);
const privateKeyPrefixes = ["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"];

export function isIgnored(
  path: string,
  extraIgnores: readonly string[] = [],
): boolean {
  return path.split("/").some((segment) => {
    if (ignoredNames.has(segment)) return true;
    return extraIgnores.some((pattern) =>
      pattern.includes("*")
        ? new RegExp(
            `^${pattern.split("*").map(escapeRegex).join(".*")}$`,
          ).test(segment)
        : pattern === segment,
    );
  });
}

export function isSecret(path: string): boolean {
  const segments = path.split("/");
  const basename = segments.at(-1) ?? "";
  if (
    segments.some((segment) =>
      [".ssh", ".aws", ".gnupg", ".docker", ".kube", ".azure"].includes(
        segment,
      ),
    )
  ) {
    return true;
  }
  if (
    segments.some(
      (segment, index) =>
        segment === ".config" && segments[index + 1] === "gcloud",
    )
  ) {
    return true;
  }
  if (segments.slice(0, -1).some((segment) => isSecretName(segment, false)))
    return true;
  return isSecretName(basename, true);
}

export function hasUnsupportedPathCharacters(path: string): boolean {
  for (const character of path) {
    const code = character.codePointAt(0);
    if (
      code !== undefined &&
      (code <= 0x1f ||
        (code >= 0x7f && code <= 0x9f) ||
        code === 0x2028 ||
        code === 0x2029)
    ) {
      return true;
    }
  }
  return false;
}

function isSecretName(name: string, allowExamples: boolean): boolean {
  if (
    secretNames.has(name) ||
    privateKeyPrefixes.some((prefix) => name.startsWith(prefix))
  ) {
    return true;
  }
  if (name === ".env" || name.startsWith(".env.")) {
    return !(
      allowExamples &&
      [".env.example", ".env.sample", ".env.template"].includes(name)
    );
  }
  const extension = name.slice(name.lastIndexOf(".")).toLowerCase();
  return secretExtensions.has(extension);
}

export function validateRelativePath(
  path: string,
  limits: WorkspaceLimits,
  extraIgnores: readonly string[] = [],
): string {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    hasUnsupportedPathCharacters(path) ||
    path.includes("\\") ||
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path)
  ) {
    throw new WorkspacePolicyError("Invalid relative workspace path");
  }
  const segments = path.split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw new WorkspacePolicyError("Invalid relative workspace path");
  }
  if (
    Buffer.byteLength(path, "utf8") > limits.maxPathBytes ||
    segments.length > limits.maxDepth
  ) {
    throw new WorkspacePolicyError("Workspace path exceeds policy limits");
  }
  if (isIgnored(path, extraIgnores) || isSecret(path)) {
    throw new WorkspacePolicyError("Workspace path is ignored or secret");
  }
  return segments.join("/");
}

export async function resolveSafePath(
  root: string,
  relativePath: string,
): Promise<string> {
  const segments = relativePath.split("/");
  let current = root;
  for (let i = 0; i < segments.length; i += 1) {
    current = join(current, segments[i]!);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink())
        throw new WorkspacePolicyError("Symlink paths are not allowed");
      if (i < segments.length - 1 && !stat.isDirectory()) {
        throw new WorkspacePolicyError(
          "A workspace path parent is not a directory",
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
  if (!isAbsolute(current))
    throw new WorkspacePolicyError("Invalid workspace path");
  return current;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
