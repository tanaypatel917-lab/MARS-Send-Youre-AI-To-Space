import { randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function reclaim(lock: string) {
  try {
    const files = await readdir(lock);
    const name = files[0];
    if (files.length !== 1 || !name || !/^[\da-f-]+\.json$/.test(name)) return;
    const ownerFile = join(lock, name);
    const owner = JSON.parse(await readFile(ownerFile, "utf8")) as {
      pid: number;
      hostname: string;
    };
    if (
      owner.hostname !== hostname() ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0 ||
      alive(owner.pid)
    )
      return;
    // Only the process that unlinks this unique owner file may remove the directory.
    // A competing reclaimer cannot unlink a successor's differently named owner.
    await unlink(ownerFile);
    await rmdir(lock);
  } catch (error) {
    if (
      error instanceof SyntaxError ||
      ["ENOENT", "ENOTEMPTY"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    )
      return;
    throw error;
  }
}

export async function withDirectoryLock<T>(
  root: string,
  action: () => Promise<T>,
): Promise<T> {
  await mkdir(root, { recursive: true });
  const lock = join(root, ".writer.lock");
  const ownerFile = join(lock, `${randomUUID()}.json`);
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await reclaim(lock);
      if (Date.now() >= deadline)
        throw Object.assign(
          new Error("Writer lock timed out; owner is live, remote, or unknown"),
          { code: "locked" },
        );
      await delay(10 + Math.random() * 20);
    }
  }
  try {
    await writeFile(
      ownerFile,
      JSON.stringify({ pid: process.pid, hostname: hostname() }),
      { flag: "wx", mode: 0o600 },
    );
    return await action();
  } finally {
    await unlink(ownerFile).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    await rmdir(lock);
  }
}
