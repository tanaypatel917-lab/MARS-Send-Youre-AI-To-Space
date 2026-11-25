import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isInsideOrEqual } from "@mars/contracts/path-containment";
import { projectRootIdentity } from "../runtime/project-root";

export const PROJECT_VERIFICATION_IMAGE =
  "oven/bun@sha256:5148f6742ac31fac28e6eab391ab1f11f6dfc0c8512c7a3679b374ec470f5982";

const scriptNames = ["test", "lint", "typecheck"] as const;
const manifestLimit = 64 * 1024;
const digest = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

function approvalDirectory(root: string, source: string, identity: string) {
  if (isInsideOrEqual(source, root) || isInsideOrEqual(root, source))
    throw new Error("Project verification must be stored outside the project.");
  return join(root, digest(JSON.stringify([source, identity])));
}

async function readPackage(source: string): Promise<Buffer> {
  const file = await open(
    join(source, "package.json"),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (!(await file.stat()).isFile()) throw new Error("Not a regular file");
    const bytes = Buffer.alloc(manifestLimit + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(
        bytes,
        length,
        bytes.length - length,
      );
      if (!bytesRead) return bytes.subarray(0, length);
      length += bytesRead;
    }
    throw new Error("Package manifest exceeds the size limit");
  } finally {
    await file.close();
  }
}

export async function suggestProjectChecks(source: string) {
  const identity = projectRootIdentity(source);
  if (!identity) return undefined;
  try {
    const manifest = await readPackage(source);
    const scripts: unknown = JSON.parse(manifest.toString("utf8"))?.scripts;
    if (!scripts || typeof scripts !== "object" || Array.isArray(scripts))
      return undefined;
    const getScript = (name: string): unknown =>
      Object.getOwnPropertyDescriptor(scripts, name)?.value;
    const checks = scriptNames.flatMap((name) => {
      const command = getScript(name);
      if (typeof command !== "string" || !command.trim()) return [];
      const steps = [`pre${name}`, name, `post${name}`].flatMap((step) => {
        const value = getScript(step);
        return typeof value === "string" && value
          ? [{ name: step, command: value }]
          : [];
      });
      return steps.every(
        ({ command }) => command.length <= 1000 && !command.includes("\0"),
      )
        ? [{ name, steps }]
        : [];
    });
    if (checks.length && projectRootIdentity(source) === identity)
      return { identity, manifest, checks };
  } catch {
    return undefined;
  }
}

export async function projectChecksFile(root: string, source: string) {
  const identity = projectRootIdentity(source);
  if (!identity) return undefined;
  try {
    const path = join(approvalDirectory(root, source, identity), "checks.json");
    if ((await stat(path)).isFile()) return path;
  } catch {
    return undefined;
  }
}

export async function saveProjectChecks(
  root: string,
  source: string,
  proposal: NonNullable<Awaited<ReturnType<typeof suggestProjectChecks>>>,
  selected: ReadonlySet<string>,
) {
  const checks = proposal.checks.filter(({ name }) => selected.has(name));
  if (!checks.length || projectRootIdentity(source) !== proposal.identity)
    throw new Error(
      "Project verification requires approved checks in the same folder.",
    );
  const directory = approvalDirectory(root, source, proposal.identity);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const snapshot = `package-${digest(proposal.manifest)}.json`;
  const writePrivate = async (name: string, bytes: string | Buffer) => {
    const temp = join(directory, randomUUID());
    try {
      await writeFile(temp, bytes, { flag: "wx", mode: 0o600 });
      await rename(temp, join(directory, name));
    } finally {
      await rm(temp, { force: true });
    }
  };
  await writePrivate(snapshot, proposal.manifest);
  await writePrivate(
    "checks.json",
    JSON.stringify({
      schema_version: 1,
      checks: checks.map(({ name }) => ({
        id: `project-${name}`,
        label: `Project script: ${name}`,
        description:
          "Uses the approved package.json; project test code can change with the candidate.",
        argv: ["bun", "run", "--no-env-file", "--no-install", name],
        protected_files: [{ path: "package.json", source: snapshot }],
      })),
    }),
  );
}

export async function removeProjectChecks(root: string, source: string) {
  const path = await projectChecksFile(root, source);
  if (path) await rm(path);
}
