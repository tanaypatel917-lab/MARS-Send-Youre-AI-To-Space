import { chmod, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type AssistantSession,
  AssistantSessionSchema,
} from "../shared/assistant";

const schema =
  "CREATE TABLE IF NOT EXISTS chats (seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, data TEXT NOT NULL)";

function list(db: DatabaseSync): AssistantSession[] {
  return db
    .prepare("SELECT data FROM chats ORDER BY seq DESC")
    .all()
    .map((row) => AssistantSessionSchema.parse(JSON.parse(String(row.data))));
}

export async function readHistory(path: string): Promise<AssistantSession[]> {
  try {
    await (await open(path, "r")).close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  // A read can require a write to roll back a hot journal after a crash.
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout=2000");
    // A second instance may have just created the database for its first send.
    if (
      !db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='chats'",
        )
        .get()
    )
      return [];
    return list(db);
  } finally {
    db.close();
  }
}

/** Commit one complete turn only if its input history is still current. */
export async function saveTurn(
  path: string,
  updated: AssistantSession,
  previousLength: number,
  signal?: AbortSignal,
) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  await (await open(path, "a", 0o600)).close();
  signal?.throwIfAborted();
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout=2000; BEGIN IMMEDIATE");
    db.exec(schema);
    const fresh = list(db);
    const previous = fresh.find((chat) => chat.id === updated.id);
    if (
      (previous?.messages.length ?? 0) !== previousLength ||
      (!previous && fresh.length >= 50)
    ) {
      return null;
    }
    db.prepare("INSERT OR REPLACE INTO chats (id, data) VALUES (?, ?)").run(
      updated.id,
      JSON.stringify(updated),
    );
    db.exec("COMMIT");
    return [updated, ...fresh.filter((chat) => chat.id !== updated.id)];
  } finally {
    db.close(); // also rolls back an uncommitted transaction
  }
}
