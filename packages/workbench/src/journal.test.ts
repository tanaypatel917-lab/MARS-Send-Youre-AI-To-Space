import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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
        await readJournalFile(root, path, "owned"),
        ["entry"],
        false,
      ),
    ).toEqual([{ entry_id: "entry", kind: "user", text: "data" }]);
    await expect(readJournalFile(root, path, "foreign")).rejects.toMatchObject({
      code: "not_found",
    });
    const link = join(root, "link.jsonl");
    await symlink(path, link);
    await expect(readJournalFile(root, link, "owned")).rejects.toMatchObject({
      code: "not_found",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
