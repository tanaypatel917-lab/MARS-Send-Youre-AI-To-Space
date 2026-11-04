import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import {
  JournalEntryIdsSchema,
  type JournalResult,
  JournalResultSchema,
  WorkbenchUsageSchema,
} from "@mars/contracts";
import { z } from "zod";
import { WorkbenchError } from "./server";

const MAX_RECORD_BYTES = 32 * 1024 * 1024;
const entrySchema = z
  .object({ id: z.string(), type: z.string() })
  .passthrough();
const messageSchema = z
  .object({
    role: z.string(),
    content: z.union([
      z.string(),
      z.array(
        z
          .object({
            type: z.string(),
            text: z.string().optional(),
            thinking: z.string().optional(),
          })
          .passthrough(),
      ),
    ]),
    usage: z
      .object({
        input: z.number().int().nonnegative(),
        output: z.number().int().nonnegative(),
        cacheRead: z.number().int().nonnegative().optional(),
        cacheWrite: z.number().int().nonnegative().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

/** Reads only the host-bound journal, without opening a runtime or rewriting upstream history. */
export async function readJournalFile(
  root: string,
  path: string,
  sessionId: string,
  requested: string[],
): Promise<unknown[]> {
  const wanted = new Set(JournalEntryIdsSchema.parse(requested));
  const canonicalRoot = await realpath(root);
  if (canonicalRoot !== root || ((await stat(root)).mode & 0o077) !== 0)
    throw new WorkbenchError("not_found");
  const canonical = await realpath(path);
  const rel = relative(canonicalRoot, canonical);
  if (
    !rel ||
    isAbsolute(rel) ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    canonical !== path
  )
    throw new WorkbenchError("not_found");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new WorkbenchError("not_found");
    const entries: unknown[] = [];
    let headerSeen = false;
    let titleSeen = false;
    let retainedBytes = 0;
    let lineBytes = 0;
    let parts: Buffer[] = [];
    const consume = (complete: boolean) => {
      const bytes = lineBytes;
      const line = Buffer.concat(parts, bytes).toString("utf8");
      parts = [];
      lineBytes = 0;
      if (!line.trim()) return;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        if (complete) throw new WorkbenchError("unavailable");
        return;
      }
      if (!headerSeen) {
        if (
          !titleSeen &&
          z
            .object({ type: z.literal("title") })
            .passthrough()
            .safeParse(entry).success
        ) {
          titleSeen = true;
          return;
        }
        if (
          !z
            .object({ type: z.literal("session"), id: z.literal(sessionId) })
            .passthrough()
            .safeParse(entry).success
        )
          throw new WorkbenchError("not_found");
        headerSeen = true;
        return;
      }
      if (
        typeof entry === "object" &&
        entry !== null &&
        "id" in entry &&
        typeof entry.id === "string" &&
        wanted.has(entry.id)
      ) {
        retainedBytes += bytes;
        if (retainedBytes > MAX_RECORD_BYTES)
          throw new WorkbenchError("too_large");
        entries.push(entry);
      }
    };
    const buffer = Buffer.alloc(64 * 1024);
    let position = 0;
    // Scan only the initial snapshot, so a running session cannot extend the read forever.
    while (position < info.size) {
      const { bytesRead } = await file.read(
        buffer,
        0,
        Math.min(buffer.length, info.size - position),
        position,
      );
      if (!bytesRead) break;
      position += bytesRead;
      let start = 0;
      while (start < bytesRead) {
        const newline = buffer.indexOf(10, start);
        const end =
          newline >= start && newline < bytesRead ? newline : bytesRead;
        lineBytes += end - start;
        if (lineBytes > MAX_RECORD_BYTES) throw new WorkbenchError("too_large");
        parts.push(Buffer.from(buffer.subarray(start, end)));
        if (end < bytesRead) consume(true);
        start = end + 1;
      }
    }
    if (lineBytes) consume(false);
    if (!headerSeen) throw new WorkbenchError("not_found");
    return entries;
  } finally {
    await file.close();
  }
}

/** All strings are untrusted data. Binding/budget/tool-call metadata is deliberately not projected. */
export function projectJournal(
  entries: unknown[],
  requested: string[],
  free: boolean,
): JournalResult {
  JournalEntryIdsSchema.parse(requested);
  const wanted = new Set(requested);
  const byId = new Map<string, JournalResult>();
  for (const raw of entries) {
    const parsed = entrySchema.safeParse(raw);
    if (!parsed.success || !wanted.has(parsed.data.id)) continue;
    const entry = parsed.data;
    const rows: JournalResult = [];
    if (entry.type === "message") {
      const message = messageSchema.safeParse(entry.message);
      if (!message.success) continue;
      const { role, content, usage } = message.data;
      const kind =
        role === "toolResult"
          ? "tool_result"
          : role === "assistant" || role === "user"
            ? role
            : null;
      if (!kind) continue;
      const blocks =
        typeof content === "string"
          ? [{ type: "text", text: content }]
          : content;
      const thinking = blocks
        .filter((block) => block.type === "thinking")
        .map((block) => block.thinking ?? "")
        .join("\n");
      const text = blocks
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("\n");
      if (thinking && role === "assistant")
        rows.push({ entry_id: entry.id, kind: "reasoning", text: thinking });
      if (text) rows.push({ entry_id: entry.id, kind, text });
      if (usage && rows[0])
        rows[0].usage = WorkbenchUsageSchema.parse({
          input_tokens:
            usage.input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0),
          output_tokens: usage.output,
          cost_usd: free ? 0 : null,
        });
    } else if (
      entry.type === "compaction" &&
      typeof entry.summary === "string"
    ) {
      rows.push({
        entry_id: entry.id,
        kind: "compaction",
        text: entry.summary,
      });
    }
    if (rows.some((row) => row.text.length > 128 * 1024))
      throw new WorkbenchError("too_large");
    if (rows.length) byId.set(entry.id, rows);
  }
  return JournalResultSchema.parse(
    [...new Set(requested)].flatMap(
      (entry_id) =>
        byId.get(entry_id) ?? [{ entry_id, kind: "not_found", text: "" }],
    ),
  );
}
