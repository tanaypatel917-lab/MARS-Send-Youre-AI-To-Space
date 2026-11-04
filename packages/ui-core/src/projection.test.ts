import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pendingJournalIds, projectTranscript } from "./projection";
import {
  EVENT_TYPES,
  FIXTURE_ROOT,
  fixtureTask,
  generateLargeTask,
  loadEventFixture,
  loadJournalFixture,
} from "./testing";
import { JournalReplySchema } from "./types";

const golden = (name: string) =>
  JSON.parse(
    readFileSync(join(FIXTURE_ROOT, "golden", `${name}.json`), "utf8"),
  );

function journalFrom(name: string) {
  const fixture = loadJournalFixture(name);
  if ("error" in fixture.reply) return { status: "unavailable" as const };
  const entries = JournalReplySchema.parse(fixture.reply.result);
  return {
    status: "available" as const,
    entries: new Map(entries.map((e) => [e.entry_id, e])),
  };
}

describe("projectTranscript (criterion 1)", () => {
  for (const type of EVENT_TYPES)
    test(`${type} matches golden`, () => {
      const projection = projectTranscript({
        task: fixtureTask(),
        events: loadEventFixture(type),
        journal: journalFrom("available"),
      });
      expect(projection).toEqual(golden(type));
    });

  test("method not available degrades to turn markers", () => {
    const projection = projectTranscript({
      task: fixtureTask(),
      events: loadEventFixture("execution.observed"),
      journal: journalFrom("method-not-available"),
    });
    expect(projection).toEqual(
      golden("execution.observed.method-not-available"),
    );
    expect(projection.entries.filter((e) => e.kind === "turn")).toHaveLength(4);
    expect(
      projection.entries.some(
        (e) => e.kind === "assistant" || e.kind === "thinking",
      ),
    ).toBe(false);
    expect(projection.journal).toBe("unavailable");
  });

  test("not_found and non-text journal rows fall back to turn markers", () => {
    const events = loadEventFixture("execution.observed");
    const ids = pendingJournalIds(events, new Set());
    expect(ids.length).toBeGreaterThan(0);
    for (const kind of ["not_found", "tool_result", "compaction"] as const) {
      const projection = projectTranscript({
        task: fixtureTask(),
        events,
        journal: {
          status: "available",
          entries: new Map(
            ids.map((entry_id) => [entry_id, { entry_id, kind, text: "" }]),
          ),
        },
      });
      expect(projection.entries.filter((e) => e.kind === "turn")).toHaveLength(
        4,
      );
    }
  });

  test("journal reply resolves thinking and assistant text; unmatched ids stay turns", () => {
    const projection = projectTranscript({
      task: fixtureTask(),
      events: loadEventFixture("execution.observed"),
      journal: journalFrom("available"),
    });
    expect(projection.entries.map((e) => e.kind)).toEqual([
      "user",
      "thinking",
      "assistant",
      "turn",
      "assistant",
    ]);
  });

  test("empty journal reply keeps turn markers", () => {
    const projection = projectTranscript({
      events: loadEventFixture("execution.observed"),
      journal: journalFrom("empty"),
    });
    expect(projection.entries.every((e) => e.kind === "turn")).toBe(true);
  });

  test("10,000-event task trims to 2,000 rendered entries with a load-earlier row", () => {
    const events = generateLargeTask(10_000);
    expect(events).toHaveLength(10_000);
    const projection = projectTranscript({
      task: fixtureTask("running"),
      events,
    });
    expect(projection.entries).toHaveLength(2_000);
    expect(projection.entries[0]).toEqual({
      kind: "earlier",
      id: "earlier",
      count: projection.trimmed,
    });
    expect(projection.trimmed).toBeGreaterThan(0);
    expect(projection.last_event_id).toBe(
      events.at(-1)?.event.event_id ?? null,
    );
  });

  test("fixture files are what the generator writes", () => {
    const events = loadEventFixture("tool.completed");
    expect(events.length).toBeGreaterThan(10);
    for (const { event } of events) expect(event.task_id).toBe("task-fixture");
  });

  test("completed is never shown as verified", () => {
    const projection = projectTranscript({
      task: fixtureTask(),
      events: loadEventFixture("task.updated")
        .slice(0, 1)
        .map((e) => ({ ...e, payload: { status: "completed" } })),
    });
    const text = JSON.stringify(projection.entries);
    expect(text).toContain("verification is reported separately");
    expect(text).not.toMatch(/\bverified\b/);
  });
});

describe("10,000-event fixture", () => {
  test("generateLargeTask(10000) reproduces the pinned bytes", async () => {
    const { createHash } = await import("node:crypto");
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { FIXTURE_ROOT, generateLargeTask, serializeEvents } = await import(
      "./testing"
    );
    const manifest = JSON.parse(
      readFileSync(join(FIXTURE_ROOT, "events", "10k-task.json"), "utf8"),
    );
    const jsonl = serializeEvents(generateLargeTask(10_000));
    expect(createHash("sha256").update(jsonl).digest("hex")).toBe(
      manifest.jsonl_sha256,
    );
  });
});
