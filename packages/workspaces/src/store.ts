import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  type FileHandle,
  lstat,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { ArtifactRefSchema } from "@mars/contracts";
import { z } from "zod";
import { IntegrityError, ProviderLockedError } from "./errors";

const checkpointRecordSchema = z
  .object({
    checkpoint_id: z.string().regex(/^cp_[a-f0-9]{32}$/),
    artifact: ArtifactRefSchema,
    revision: z.string().regex(/^\d+\.[a-f0-9]{16}$/),
    created_at: z.string().datetime({ offset: true }),
  })
  .strict();

const journalSchema = z
  .object({
    phase: z.literal("backed-up"),
    staging: z.string().regex(/^ws_[a-f0-9]{32}-[a-f0-9]{32}$/),
    backup: z.string().regex(/^ws_[a-f0-9]{32}-[a-f0-9]{32}$/),
    previous: z
      .object({
        counter: z.number().int().nonnegative(),
        revision: z.string().regex(/^\d+\.[a-f0-9]{16}$/),
        tree_digest: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    target: z
      .object({
        counter: z.number().int().nonnegative(),
        revision: z.string().regex(/^\d+\.[a-f0-9]{16}$/),
        tree_digest: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
  })
  .strict();

export const workspaceMetaSchema = z
  .object({
    schema_version: z.literal(1),
    workspace_id: z.string().regex(/^ws_[a-f0-9]{32}$/),
    provider: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,63}$/),
    owner_id: z.string().min(1),
    project_id: z.string().min(1),
    task_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
    counter: z.number().int().nonnegative(),
    revision: z.string().regex(/^\d+\.[a-f0-9]{16}$/),
    tree_digest: z.string().regex(/^[a-f0-9]{64}$/),
    created_at: z.string().datetime({ offset: true }),
    baseline_checkpoint_id: z.string().regex(/^cp_[a-f0-9]{32}$/),
    checkpoints: z.array(checkpointRecordSchema),
    blob_index: z
      .record(z.string().regex(/^[a-f0-9]{64}$/), ArtifactRefSchema)
      .optional(),
    skipped: z.array(
      z
        .object({
          path: z.string(),
          reason: z.enum([
            "symlink",
            "special",
            "ignored-secret",
            "unsupported-name",
          ]),
        })
        .strict(),
    ),
    exec_in_progress: z
      .object({
        run_id: z.string().regex(/^[A-Za-z0-9._-]+$/),
        started_at: z.string().datetime({ offset: true }),
      })
      .strict()
      .optional(),
    write_in_progress: z
      .object({
        started_at: z.string().datetime({ offset: true }),
      })
      .strict()
      .optional(),
    restore_journal: journalSchema.optional(),
  })
  .strict()
  .superRefine((meta, context) => {
    if (meta.revision !== `${meta.counter}.${meta.tree_digest.slice(0, 16)}`) {
      context.addIssue({
        code: "custom",
        message: "Metadata revision does not match its tree digest",
      });
    }
    const checkpointIds = new Set(
      meta.checkpoints.map((checkpoint) => checkpoint.checkpoint_id),
    );
    if (checkpointIds.size !== meta.checkpoints.length) {
      context.addIssue({
        code: "custom",
        message: "Workspace metadata contains duplicate checkpoints",
      });
    }
    if (!checkpointIds.has(meta.baseline_checkpoint_id)) {
      context.addIssue({
        code: "custom",
        message: "Workspace metadata has no baseline checkpoint",
      });
    }
    if (meta.restore_journal) {
      const journal = meta.restore_journal;
      const prefix = `${meta.workspace_id}-`;
      if (
        !journal.staging.startsWith(prefix) ||
        !journal.backup.startsWith(prefix)
      ) {
        context.addIssue({
          code: "custom",
          message: "Restore journal paths do not match the workspace",
        });
      }
      if (
        journal.previous.counter !== meta.counter ||
        journal.previous.revision !== meta.revision ||
        journal.previous.tree_digest !== meta.tree_digest ||
        journal.target.counter !== journal.previous.counter + 1 ||
        journal.target.revision !==
          `${journal.target.counter}.${journal.target.tree_digest.slice(0, 16)}`
      ) {
        context.addIssue({
          code: "custom",
          message: "Restore journal revisions are inconsistent",
        });
      }
    }
  });

export type WorkspaceMeta = z.infer<typeof workspaceMetaSchema>;
export type CheckpointRecord = z.infer<typeof checkpointRecordSchema>;

export async function acquireProviderLock(
  rootDir: string,
): Promise<() => Promise<void>> {
  const lockPath = join(rootDir, "provider.lock");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      const token = randomUUID();
      try {
        await handle.writeFile(`${process.pid} ${token}\n`);
        await handle.sync();
      } catch (error) {
        await unlink(lockPath).catch(() => undefined);
        throw error;
      } finally {
        await handle.close();
      }
      return async () => {
        const current = await readFile(lockPath, "utf8").catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return "";
            throw error;
          },
        );
        if (current.trim() === `${process.pid} ${token}`)
          await unlink(lockPath);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const content = await readFile(lockPath, "utf8").catch(() => "");
      const pid = Number(content.trim().split(/\s+/, 1)[0]);
      if (!Number.isSafeInteger(pid) || pid <= 0 || isProcessAlive(pid)) {
        throw new ProviderLockedError();
      }
      const recoveryPath = `${lockPath}.recovery`;
      let recoveryHandle: FileHandle;
      try {
        recoveryHandle = await open(recoveryPath, "wx", 0o600);
      } catch (recoveryError) {
        if ((recoveryError as NodeJS.ErrnoException).code === "EEXIST")
          throw new ProviderLockedError();
        throw recoveryError;
      }
      const token = randomUUID();
      let recoveryWritten = false;
      try {
        await recoveryHandle.writeFile(`${process.pid} ${token}\n`);
        await recoveryHandle.sync();
        recoveryWritten = true;
        const latest = await readFile(lockPath, "utf8");
        const latestPid = Number(latest.trim().split(/\s+/, 1)[0]);
        if (
          latest !== content ||
          !Number.isSafeInteger(latestPid) ||
          latestPid <= 0 ||
          isProcessAlive(latestPid)
        ) {
          throw new ProviderLockedError();
        }
        await unlink(lockPath);
      } finally {
        await recoveryHandle.close();
        const current = await readFile(recoveryPath, "utf8").catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return "";
            throw error;
          },
        );
        if (!recoveryWritten || current.trim() === `${process.pid} ${token}`) {
          await unlink(recoveryPath).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
          });
        }
      }
    }
  }
  throw new ProviderLockedError();
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function metaPath(rootDir: string, workspaceId: string): string {
  return join(rootDir, "meta", workspaceId, "workspace.json");
}

export function workspacePath(rootDir: string, workspaceId: string): string {
  return join(rootDir, "workspaces", workspaceId, "tree");
}

export async function loadMeta(
  rootDir: string,
  workspaceId: string,
): Promise<WorkspaceMeta> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(metaPath(rootDir, workspaceId), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      try {
        const directory = await lstat(join(rootDir, "meta", workspaceId));
        if (directory.isDirectory() && !directory.isSymbolicLink()) {
          throw new IntegrityError("workspace state lost", { cause: error });
        }
        throw new IntegrityError("workspace state lost", { cause: error });
      } catch (directoryError) {
        if (directoryError instanceof IntegrityError) throw directoryError;
        if ((directoryError as NodeJS.ErrnoException).code === "ENOENT") {
          throw error;
        }
        throw new IntegrityError("workspace state lost", {
          cause: directoryError,
        });
      }
    }
    throw new IntegrityError("workspace state lost", {
      cause: error,
    });
  }
  const result = workspaceMetaSchema.safeParse(parsed);
  if (!result.success)
    throw new IntegrityError("workspace state lost", {
      cause: result.error,
    });
  return result.data;
}

export async function saveMeta(
  rootDir: string,
  meta: WorkspaceMeta,
): Promise<void> {
  const parsed = workspaceMetaSchema.safeParse(meta);
  if (!parsed.success)
    throw new IntegrityError("Refusing to persist invalid workspace metadata", {
      cause: parsed.error,
    });
  const directory = join(rootDir, "meta", meta.workspace_id);
  const target = join(directory, "workspace.json");
  const temporary = join(directory, `.workspace-${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(parsed.data)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  const fileHandle = await open(temporary, constants.O_RDONLY);
  try {
    await fileHandle.sync();
  } finally {
    await fileHandle.close();
  }
  await rename(temporary, target);
  const dirHandle = await open(directory, constants.O_RDONLY);
  try {
    await dirHandle.sync();
  } finally {
    await dirHandle.close();
  }
}

export async function listMetas(rootDir: string): Promise<WorkspaceMeta[]> {
  const base = join(rootDir, "meta");
  const result: WorkspaceMeta[] = [];
  for (const entry of await readdir(base, { withFileTypes: true })) {
    if (!/^ws_[a-f0-9]{32}$/.test(entry.name)) continue;
    if (!entry.isDirectory()) throw new IntegrityError("workspace state lost");
    result.push(await loadMeta(rootDir, entry.name));
  }
  return result;
}

export async function removeWorkspaceFiles(
  rootDir: string,
  workspaceId: string,
): Promise<void> {
  await Promise.all([
    rm(join(rootDir, "workspaces", workspaceId), {
      recursive: true,
      force: true,
    }),
    rm(join(rootDir, "meta", workspaceId), { recursive: true, force: true }),
  ]);
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function removeIfExists(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

export function revision(counter: number, digest: string): string {
  return `${counter}.${digest.slice(0, 16)}`;
}
