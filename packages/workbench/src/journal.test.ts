import { expect, test } from "bun:test";
import { mkdtemp, open, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JournalEntryIdsSchema } from "@mars/contracts";
import { projectJournal, readJournalFile } from "./journal";

test("journal separates reasoning, preserves untrusted text, hides private metadata and bounds ids", () => {
  expect(
    projectJournal(
      [
        {
          type: "message",
          id: "a",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "reason" },
              { type: "text", text: "<script>data</script>" },
            ],
            usage: { input: 3, output: 2 },
          },
        },
        { type: "custom", id: "binding", data: "private" },
      ],
      ["a", "binding", "foreign"],
      true,
    ),
  ).toEqual([
    {
      entry_id: "a",
      kind: "reasoning",
      text: "reason",
      usage: { input_tokens: 3, output_tokens: 2, cost_usd: 0 },
    },
    { entry_id: "a", kind: "assistant", text: "<script>data</script>" },
    { entry_id: "binding", kind: "not_found", text: "" },
    { entry_id: "foreign", kind: "not_found", text: "" },
  ]);
  expect(JournalEntryIdsSchema.safeParse(Array(101).fill("a")).success).toBe(
    false,
  );
});
test("journal reader rejects foreign sessions and symlink paths and never rewrites files", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-journal-"));
  try {
    const path = join(root, "session.jsonl");
    const text = `${JSON.stringify({ type: "title", v: 1 })}\n${JSON.stringify({ type: "session", id: "owned" })}\n${JSON.stringify({ type: "message", id: "entry", message: { role: "user", content: "data" } })}\n`;
    await writeFile(path, text);
    expect(
      projectJournal(
        await readJournalFile(root, path, "owned", ["entry"]),
        ["entry"],
        false,
      ),
    ).toEqual([{ entry_id: "entry", kind: "user", text: "data" }]);
    await expect(
      readJournalFile(root, path, "foreign", ["entry"]),
    ).rejects.toMatchObject({
      code: "not_found",
    });
    const link = join(root, "link.jsonl");
    await symlink(path, link);
    await expect(
      readJournalFile(root, link, "owned", ["entry"]),
    ).rejects.toMatchObject({
      code: "not_found",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("journal streams files larger than 32 MiB and retains only requested records across chunk boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-large-journal-"));
  try {
    const path = join(root, "session.jsonl");
    const file = await open(path, "w");
    const message = (id: string, content: string) =>
      `${JSON.stringify({ type: "message", id, message: { role: "assistant", content } })}\n`;
    const text = "untrusted 🪐".repeat(6000);
    try {
      await file.writeFile(
        `${JSON.stringify({ type: "session", id: "owned" })}\n${message("early", "first")}`,
      );
      const ignored = `${JSON.stringify({ type: "custom", id: "ignored", data: "x".repeat(64 * 1024) })}\n`;
      for (let i = 0; i < 513; i++) await file.writeFile(ignored);
      await file.writeFile(`${message("recent", text)}{"type":"message",`);
    } finally {
      await file.close();
    }
    const before = await stat(path);
    expect(before.size).toBeGreaterThan(32 * 1024 * 1024);
    const ids = ["recent", "early", "foreign"];
    const entries = await readJournalFile(root, path, "owned", ids);
    expect(entries).toHaveLength(2);
    expect(projectJournal(entries, ids, true)).toEqual([
      { entry_id: "recent", kind: "assistant", text },
      { entry_id: "early", kind: "assistant", text: "first" },
      { entry_id: "foreign", kind: "not_found", text: "" },
    ]);
    const after = await stat(path);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
