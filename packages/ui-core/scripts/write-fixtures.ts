/** Regenerates fixtures/events, fixtures/journal and fixtures/golden from src/testing.ts. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectTranscript } from "../src/projection";
import {
  EVENT_FIXTURES,
  EVENT_TYPES,
  FIXTURE_ROOT,
  FIXTURE_TASK_ID,
  fixtureEvents,
  fixtureTask,
  JOURNAL_ENTRIES,
  serializeEvents,
} from "../src/testing";

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
for (const dir of ["events", "journal", "golden"])
  mkdirSync(join(FIXTURE_ROOT, dir), { recursive: true });

const available = {
  status: "available" as const,
  entries: new Map(JOURNAL_ENTRIES.map((entry) => [entry.entry_id, entry])),
};
for (const type of EVENT_TYPES) {
  const events = fixtureEvents(EVENT_FIXTURES[type], {
    prefix: type.replace(".", "-"),
  });
  writeFileSync(
    join(FIXTURE_ROOT, "events", `${type}.jsonl`),
    serializeEvents(events),
  );
  writeFileSync(
    join(FIXTURE_ROOT, "golden", `${type}.json`),
    json(
      projectTranscript({ task: fixtureTask(), events, journal: available }),
    ),
  );
  if (type === "execution.observed")
    writeFileSync(
      join(FIXTURE_ROOT, "golden", `${type}.method-not-available.json`),
      json(
        projectTranscript({
          task: fixtureTask(),
          events,
          journal: { status: "unavailable" },
        }),
      ),
    );
}
const entryIds = ["entry-1", "entry-2", "entry-3", "entry-4"];
writeFileSync(
  join(FIXTURE_ROOT, "journal", "available.json"),
  json({
    request: { task_id: FIXTURE_TASK_ID, entry_ids: entryIds },
    status: 200,
    reply: { result: JOURNAL_ENTRIES },
  }),
);
writeFileSync(
  join(FIXTURE_ROOT, "journal", "method-not-available.json"),
  json({
    request: { task_id: FIXTURE_TASK_ID, entry_ids: entryIds },
    status: 400,
    reply: {
      error: { code: "invalid_request", message: "Invalid workbench request." },
    },
  }),
);
writeFileSync(
  join(FIXTURE_ROOT, "journal", "empty.json"),
  json({
    request: { task_id: FIXTURE_TASK_ID, entry_ids: ["entry-unknown"] },
    status: 200,
    reply: { result: [] },
  }),
);
console.log("fixtures written");
