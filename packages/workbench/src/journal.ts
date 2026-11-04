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

const MAX_JOURNAL_BYTES = 32 * 1024 * 1024;
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
): Promise<unknown[]> {
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
    if (info.size > MAX_JOURNAL_BYTES) throw new WorkbenchError("too_large");
    const buffer = Buffer.alloc(info.size);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const part = await file.read(
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        bytesRead,
      );
      if (!part.bytesRead) break;
      bytesRead += part.bytesRead;
    }
    const entries: unknown[] = [];
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line?.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        if (i !== lines.length - 1) throw new WorkbenchError("unavailable");
      }
    }
    const header = z
      .object({ type: z.literal("session"), id: z.literal(sessionId) })
      .passthrough()
      .safeParse(
        z
          .object({ type: z.literal("title") })
          .passthrough()
          .safeParse(entries[0]).success
          ? entries[1]
          : entries[0],
      );
    if (!header.success) throw new WorkbenchError("not_found");
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
