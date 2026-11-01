import { z } from "zod";

export interface JournalMessage {
  session_id: string;
  entry_id: string;
  parent_id: string | null;
  timestamp: string;
  seq: number;
  role: "user" | "assistant" | "toolResult";
  text: string;
}

export interface JournalInput {
  session_id: string;
  entries: readonly unknown[];
  includeToolResults?: boolean;
}

export class JournalCompatibilityError extends Error {}

const header = z.object({
  type: z.literal("session"),
  version: z.literal(3),
  id: z.string().min(1),
});
const message = z.object({
  type: z.literal("message"),
  id: z.string().min(1),
  parentId: z.string().min(1).nullable(),
  timestamp: z.string().datetime({ offset: true }),
  message: z.object({
    role: z.string(),
    content: z.union([z.string(), z.array(z.unknown())]),
  }),
});

/** Pure adapter: receives already-loaded records, never accesses a journal file. */
export function parseJournal(
  input: JournalInput,
  privateRoots: readonly string[] = [],
): JournalMessage[] {
  const parsed = header.safeParse(input.entries[0]);
  if (!parsed.success || parsed.data.id !== input.session_id)
    throw new JournalCompatibilityError("Incompatible journal");
  const result: JournalMessage[] = [];
  const ids = new Set<string>();
  for (const [seq, record] of input.entries.entries()) {
    if (
      !record ||
      typeof record !== "object" ||
      !("type" in record) ||
      record.type !== "message"
    )
      continue;
    const parsedMessage = message.safeParse(record);
    if (!parsedMessage.success)
      throw new JournalCompatibilityError("Malformed message");
    const entry = parsedMessage.data;
    if (ids.has(entry.id))
      throw new JournalCompatibilityError("Duplicate message");
    ids.add(entry.id);
    const role = entry.message.role;
    if (
      role !== "user" &&
      role !== "assistant" &&
      !(role === "toolResult" && input.includeToolResults)
    )
      continue;
    let text =
      typeof entry.message.content === "string"
        ? entry.message.content
        : entry.message.content
            .flatMap((part) => {
              if (
                !part ||
                typeof part !== "object" ||
                !("type" in part) ||
                part.type !== "text"
              )
                return [];
              if (!("text" in part) || typeof part.text !== "string")
                throw new JournalCompatibilityError("Malformed text part");
              return [part.text];
            })
            .join("\n");
    for (const root of [...privateRoots]
      .filter(Boolean)
      .sort((a, b) => b.length - a.length))
      text = text.split(root).join("<private-path>");
    result.push({
      session_id: input.session_id,
      entry_id: entry.id,
      parent_id: entry.parentId,
      timestamp: entry.timestamp,
      seq,
      role,
      text,
    });
  }
  return result;
}
