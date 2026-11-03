import { resolve } from "node:path";
import { z } from "zod";

export const ROOT = resolve(import.meta.dir, "..");
const commit = z.string().regex(/^[a-f0-9]{40}$/);
const nonempty = z.string().min(1);
const SourceSchema = z
  .object({ path: nonempty, url: z.string().url(), purpose: nonempty })
  .strict();
export const ManifestSchema = z
  .object({
    schema_version: z.literal(1),
    audited_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    scope: nonempty,
    master_specification: z
      .object({ path: nonempty, sha256: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict(),
    runtime_artifacts: z
      .array(
        z
          .object({
            package: nonempty,
            version: z.string().regex(/^\d+\.\d+\.\d+$/),
            integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]{86}==$/),
            release_source_revision: commit,
            source_equivalence: z.literal("not-attested"),
          })
          .strict(),
      )
      .min(1),
    components: z
      .array(
        z
          .object({
            id: nonempty,
            group: nonempty,
            repository_url: z
              .string()
              .regex(/^https:\/\/github\.com\/[^/]+\/[^/]+$/),
            revision: commit,
            version_note: nonempty,
            license: z
              .object({
                spdx: nonempty,
                path: nonempty,
                url: z.string().url(),
                additional_notices: z.array(z.unknown()),
                notes: z.union([nonempty, z.array(z.unknown()).min(1)]),
              })
              .strict(),
            sources: z.array(SourceSchema).min(1),
            background_references: z.array(
              z.object({ url: z.string().url(), notes: nonempty }).strict(),
            ),
            runtime_requirements: z.union([nonempty, z.array(nonempty).min(1)]),
            integration_owner: nonempty,
            target_milestone: nonempty,
            adaptation_decision: nonempty,
            dependencies: z.array(nonempty).min(1),
            acceptance_plan: z.union([
              nonempty,
              z.array(z.unknown()).min(1),
              z
                .record(z.unknown())
                .refine((record) => Object.keys(record).length > 0),
            ]),
            audit_checks: z
              .record(z.unknown())
              .refine((record) => Object.keys(record).length > 0),
            risks: z.array(nonempty).min(1),
            integration_status: z.enum([
              "initialization-only",
              "journal-probe-only",
              "workbench-context-only",
              "host-bound-tools",
              "not-integrated",
            ]),
          })
          .strict(),
      )
      .min(1),
    group_findings: z
      .array(
        z
          .object({
            group: nonempty,
            findings: z.unknown(),
            blockers: z.unknown(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export type SourceManifest = z.infer<typeof ManifestSchema>;
export const REQUIRED_COMPONENTS = [
  "omp-execution-sdk",
  "omp-session-journal",
  "cline-presentation-ide-boundary",
  "cline-checkpoint-patterns",
  "hermes-memory-core",
  "hermes-background-review",
  "hermes-curator",
  "hermes-memory-providers",
  "openclaw-skill-workshop",
  "openclaw-self-learning-scheduler",
  "openclaw-memory-retrieval-consolidation",
  "openclaw-gateway",
  "harbor",
  "mini-swe-agent",
  "dspy",
  "gepa",
  "aider-repomap",
  "browser-use",
  "openhands-workspace",
  "dgm",
  "trl",
  "peft",
  "agent-lightning",
  "vllm",
  "watch-skill",
  "graphify",
] as const;

export function validateManifest(input: unknown): SourceManifest {
  const manifest = ManifestSchema.parse(input);
  const ids = new Set<string>();
  const repositories = new Map<string, string>();
  for (const component of manifest.components) {
    if (ids.has(component.id))
      throw new Error(`Duplicate component: ${component.id}`);
    ids.add(component.id);
    const previous = repositories.get(component.repository_url);
    if (previous && previous !== component.revision)
      throw new Error(`Conflicting repository pins: ${component.id}`);
    repositories.set(component.repository_url, component.revision);
    for (const source of [...component.sources, component.license]) {
      const expected = `${component.repository_url}/blob/${component.revision}/${source.path}`;
      if (source.url !== expected)
        throw new Error(
          `Unpinned source URL: ${component.id} / ${source.path}`,
        );
      if (source.path.split("/").some((part) => part === ".." || part === ""))
        throw new Error("Invalid source path");
    }
  }
  for (const id of REQUIRED_COMPONENTS) {
    if (!ids.has(id)) throw new Error(`Missing required component: ${id}`);
  }
  const packages = new Set<string>();
  for (const artifact of manifest.runtime_artifacts) {
    if (packages.has(artifact.package))
      throw new Error(`Duplicate runtime artifact: ${artifact.package}`);
    packages.add(artifact.package);
  }
  return manifest;
}

export async function checkSources(root = ROOT): Promise<SourceManifest> {
  const manifest = validateManifest(
    await Bun.file(resolve(root, "sources/manifest.json")).json(),
  );
  const master = await Bun.file(
    resolve(root, manifest.master_specification.path),
  ).arrayBuffer();
  const digest = new Bun.CryptoHasher("sha256").update(master).digest("hex");
  if (digest !== manifest.master_specification.sha256)
    throw new Error("Master specification hash changed");
  const executionPackage = await Bun.file(
    resolve(root, "packages/execution/package.json"),
  ).json();
  const lockfile = z
    .object({ packages: z.record(z.unknown()) })
    .parse(Bun.JSON5.parse(await Bun.file(resolve(root, "bun.lock")).text()));
  for (const artifact of manifest.runtime_artifacts) {
    if (executionPackage.dependencies[artifact.package] !== artifact.version) {
      throw new Error(`Runtime artifact version drift: ${artifact.package}`);
    }
    const installed = await Bun.file(
      resolve(
        root,
        "packages/execution/node_modules",
        artifact.package,
        "package.json",
      ),
    ).json();
    if (installed.version !== artifact.version)
      throw new Error(`Installed version drift: ${artifact.package}`);
    const entry = z
      .array(z.unknown())
      .parse(lockfile.packages[artifact.package]);
    if (
      entry[0] !== `${artifact.package}@${artifact.version}` ||
      entry[3] !== artifact.integrity
    ) {
      throw new Error(
        `Missing artifact identity/integrity in lockfile: ${artifact.package}`,
      );
    }
  }
  return manifest;
}

if (import.meta.main) {
  try {
    const manifest = await checkSources();
    console.log(
      `Validated ${manifest.components.length} source entries, pinned URLs, master-spec hash and runtime artifact pins (offline).`,
    );
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Source validation failed",
    );
    process.exitCode = 1;
  }
}
