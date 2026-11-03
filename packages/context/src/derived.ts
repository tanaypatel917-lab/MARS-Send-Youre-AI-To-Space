import { createHash } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/**
 * Host-private store for derived, rebuildable artifacts (code knowledge
 * graphs, future indexes) that sit next to the repository map. It owns no
 * memory: every entry is a cache keyed by scope and workspace that can be
 * deleted and rebuilt from the workspace at any time. SQLite stores stay the
 * only owners of history and search.
 */

export interface DerivedArtifactKey {
  owner_id: string;
  project_id: string;
  workspace_id: string;
  kind: string;
}

export interface DerivedArtifactEntry<T> {
  key: DerivedArtifactKey;
  revision: string;
  stored_at: string;
  value: T;
}

export interface DerivedArtifactStore {
  readonly rootDir: string;
  read<T>(
    key: DerivedArtifactKey,
    schema: z.ZodType<T>,
  ): Promise<DerivedArtifactEntry<T> | null>;
  write<T>(
    key: DerivedArtifactKey,
    revision: string,
    value: T,
    schema: z.ZodType<T>,
  ): Promise<DerivedArtifactEntry<T>>;
  remove(key: DerivedArtifactKey): Promise<boolean>;
  list(kind?: string): Promise<DerivedArtifactKey[]>;
}

const KEY_PART = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

const envelopeSchema = z
  .object({
    schema_version: z.literal(1),
    key: z
      .object({
        owner_id: z.string().min(1),
        project_id: z.string().min(1),
        workspace_id: z.string().min(1),
        kind: z.string().min(1),
      })
      .strict(),
    revision: z.string().min(1),
    stored_at: z.string().datetime(),
    value: z.unknown(),
  })
  .strict();

function fileName(key: DerivedArtifactKey): string {
  for (const part of [key.owner_id, key.project_id, key.workspace_id, key.kind])
    if (!KEY_PART.test(part))
      throw new Error("derived artifact key contains unsupported characters");
  const digest = createHash("sha256")
    .update([key.owner_id, key.project_id, key.workspace_id].join("\u0000"))
    .digest("hex")
    .slice(0, 32);
  return `${key.kind}.${digest}.json`;
}

export function createDerivedArtifactStore(options: {
  rootDir: string;
}): DerivedArtifactStore {
  const rootDir = options.rootDir;
  const ensure = () => mkdir(rootDir, { recursive: true, mode: 0o700 });
  return {
    rootDir,
    async read(key, schema) {
      let raw: string;
      try {
        raw = await readFile(join(rootDir, fileName(key)), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
      const envelope = envelopeSchema.safeParse(JSON.parse(raw));
      if (!envelope.success) return null;
      const matches =
        envelope.data.key.owner_id === key.owner_id &&
        envelope.data.key.project_id === key.project_id &&
        envelope.data.key.workspace_id === key.workspace_id &&
        envelope.data.key.kind === key.kind;
      if (!matches) return null;
      const value = schema.safeParse(envelope.data.value);
      if (!value.success) return null;
      return {
        key: envelope.data.key,
        revision: envelope.data.revision,
        stored_at: envelope.data.stored_at,
        value: value.data,
      };
    },
    async write(key, revision, value, schema) {
      await ensure();
      const entry: DerivedArtifactEntry<typeof value> = {
        key: { ...key },
        revision,
        stored_at: new Date().toISOString(),
        value: schema.parse(value),
      };
      const target = join(rootDir, fileName(key));
      const temp = `${target}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify({ schema_version: 1, ...entry }), {
        mode: 0o600,
      });
      await rename(temp, target);
      return entry;
    },
    async remove(key) {
      try {
        await rm(join(rootDir, fileName(key)));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    },
    async list(kind) {
      let names: string[];
      try {
        names = await readdir(rootDir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      const keys: DerivedArtifactKey[] = [];
      for (const name of names.sort()) {
        if (!name.endsWith(".json")) continue;
        if (kind && !name.startsWith(`${kind}.`)) continue;
        try {
          const parsed = envelopeSchema.safeParse(
            JSON.parse(await readFile(join(rootDir, name), "utf8")),
          );
          if (parsed.success) keys.push(parsed.data.key);
        } catch {}
      }
      return keys;
    },
  };
}
