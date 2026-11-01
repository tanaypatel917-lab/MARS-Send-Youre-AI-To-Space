import type { RequestContext, WorkspaceRef } from "@mars/contracts";
import { ScopeSchema } from "@mars/contracts";
import { ContextPolicyError } from "./errors";
import type { RepositoryMapLimits } from "./types";

const dependencySegments = new Set([
  "node_modules",
  "bower_components",
  "vendor",
  ".venv",
  "venv",
  ".yarn",
  ".pnpm-store",
  "site-packages",
  "jspm_packages",
]);
const privateSegments = new Set([
  ".git",
  ".hg",
  ".svn",
  ".mars",
  ".omp",
  ".devin",
  ".cache",
  ".idea",
  ".vscode",
]);
const ignoredSegments = new Set([
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".turbo",
  ".parcel-cache",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".tox",
  ".gradle",
  ".terraform",
  "target",
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

export function validateContext(context: RequestContext): void {
  try {
    if (
      context?.schema_version !== 1 ||
      typeof context.request_id !== "string" ||
      context.request_id.length === 0 ||
      !ScopeSchema.safeParse(context.scope).success
    ) {
      throw new Error("invalid");
    }
  } catch {
    throw new ContextPolicyError("Invalid request context");
  }
}

export function validateWorkspaceScope(
  context: RequestContext,
  workspace: WorkspaceRef,
): void {
  if (
    context.scope.workspace_id !== undefined &&
    context.scope.workspace_id !== workspace.workspace_id
  ) {
    throw new ContextPolicyError("Workspace is outside the request scope");
  }
}

export function validateRelativePath(
  value: string,
  limits: RepositoryMapLimits,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /^[A-Za-z]:/.test(value) ||
    hasUnsupportedPathCharacters(value)
  ) {
    throw new ContextPolicyError("Invalid relative path");
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    ) ||
    Buffer.byteLength(value, "utf8") > limits.maxPathBytes ||
    segments.length > limits.maxDepth
  ) {
    throw new ContextPolicyError("Invalid relative path");
  }
  return segments.join("/");
}

export function classifyPath(
  path: string,
): "dependency" | "private_state" | "ignored" | "secret" | undefined {
  const segments = path.split("/").map((part) => part.toLowerCase());
  const basename = segments.at(-1) ?? "";
  if (segments.some((part) => dependencySegments.has(part)))
    return "dependency";
  if (
    segments.some(
      (part) =>
        privateSegments.has(part) ||
        part.startsWith(".aider") ||
        part === ".aider.tags.cache.v3" ||
        part === ".aider.tags.cache.v4",
    )
  ) {
    return "private_state";
  }
  if (segments.some((part) => ignoredSegments.has(part))) return "ignored";
  if (
    segments.some((part) =>
      [".ssh", ".aws", ".gnupg", ".docker", ".kube", ".azure"].includes(part),
    ) ||
    segments.some(
      (part, index) => part === ".config" && segments[index + 1] === "gcloud",
    ) ||
    segments.slice(0, -1).some((part) => isSecretName(part, false)) ||
    isSecretName(basename, true)
  ) {
    return "secret";
  }
  return undefined;
}

export function isSupportedLanguage(path: string): boolean {
  return /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|py)$/i.test(path);
}

export function isGeneratedName(path: string): boolean {
  return /\.(?:min\.js|min\.mjs|bundle\.js|chunk\.js|map)$/i.test(path);
}

export function hasUnsupportedPathCharacters(value: string): boolean {
  for (const character of value) {
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
    secretExtensions.has(name.slice(name.lastIndexOf("."))) ||
    ["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"].some((prefix) =>
      name.startsWith(prefix),
    )
  ) {
    return true;
  }
  if (name === ".env" || name.startsWith(".env.")) {
    return !(
      allowExamples &&
      [".env.example", ".env.sample", ".env.template"].includes(name)
    );
  }
  return false;
}
