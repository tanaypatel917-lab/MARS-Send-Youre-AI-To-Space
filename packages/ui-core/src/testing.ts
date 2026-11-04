import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EventEnvelope } from "@mars/contracts";
import type { ProjectionEvent, ProjectionTask } from "./projection";
import type { JournalEntry } from "./types";

/** Fixture builders and loaders for tests; not imported by client code. */
export const FIXTURE_ROOT = join(import.meta.dir, "..", "fixtures");
export const FIXTURE_SCOPE = {
  owner_id: "local",
  project_id: "project-fixture",
};
export const FIXTURE_TASK_ID = "task-fixture";
export const FIXTURE_SESSION_ID = "session-fixture";
const EPOCH = Date.parse("2026-11-04T12:00:00.000Z");

export const EVENT_TYPES = [
  "task.created",
  "task.updated",
  "execution.observed",
  "tool.completed",
  "research.proposed",
  "research.stale",
  "memory.revised",
  "skill.revised",
  "evaluation.completed",
  "training.updated",
  "promotion.decided",
] as const satisfies readonly EventEnvelope["event_type"][];
export type FixtureEventType = (typeof EVENT_TYPES)[number];

export interface FixtureEventSpec {
  type: FixtureEventType;
  producer?: string;
  payload: unknown;
  usage?: EventEnvelope["usage"];
}

export function fixtureEvents(
  specs: readonly FixtureEventSpec[],
  options: { taskId?: string; prefix?: string; start?: number } = {},
): ProjectionEvent[] {
  const taskId = options.taskId ?? FIXTURE_TASK_ID;
  const prefix = options.prefix ?? "evt";
  const start = options.start ?? 0;
  return specs.map((spec, index) => {
    const n = start + index;
    const bytes = JSON.stringify(spec.payload);
    const event: EventEnvelope = {
      schema_version: 1,
      event_id: `${prefix}-${String(n).padStart(5, "0")}`,
      scope: FIXTURE_SCOPE,
      session_id: FIXTURE_SESSION_ID,
      task_id: taskId,
      occurred_at: new Date(EPOCH + n * 1000).toISOString(),
      event_type: spec.type,
      parent_event_id: null,
      run_id: "run-fixture",
      producer: spec.producer ?? "@mars/workbench",
      versions: [{ component: "@mars/workbench", revision: "0.0.1" }],
      payload: {
        artifact_id: `artifact-${prefix}-${n}`,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        media_type: "application/json",
        byte_length: Buffer.byteLength(bytes),
      },
      source_event_ids: [],
      access: "project",
      ...(spec.usage ? { usage: spec.usage } : {}),
    };
    return { event, payload: spec.payload };
  });
}

export function fixtureTask(
  status = "completed",
  request = "Add a --json flag to mars render and document it",
): ProjectionTask {
  return { task_id: FIXTURE_TASK_ID, request, status };
}

const observed = (
  entry: string,
  kind: string,
  summary?: string,
): FixtureEventSpec => ({
  type: "execution.observed",
  producer: "@mars/execution",
  payload: {
    upstream: {
      runtime: "oh-my-pi",
      package_version: "18.14.0",
      session_id: "omp-session-fixture",
      entry_ids: [entry],
    },
    kind,
    ...(summary ? { summary } : {}),
  },
});

const longOutput = Array.from(
  { length: 18 },
  (_, i) => `line ${i + 1}: src/render.ts matched \`--json\``,
).join("\n");
const fortyLinePatch = [
  "--- a/apps/cli/src/render.ts",
  "+++ b/apps/cli/src/render.ts",
  "@@ -1,30 +1,52 @@",
  ...Array.from({ length: 44 }, (_, i) =>
    i % 3 === 0 ? `-old line ${i}` : `+new line ${i} with --json handling`,
  ),
].join("\n");

/** One fixture per §2.1 event type; payload shapes follow the host producers (or §8.3 where none exists yet). */
export const EVENT_FIXTURES: Record<FixtureEventType, FixtureEventSpec[]> = {
  "task.created": [
    { type: "task.created", payload: { operation: "task.created" } },
  ],
  "task.updated": [
    { type: "task.updated", payload: { status: "running" } },
    {
      type: "task.updated",
      payload: { instruction: "Also update the README example." },
    },
    {
      type: "task.updated",
      payload: {
        status: "paused",
        reason: "model_unavailable",
        model_id: "omniroute/openrouter/free-x",
      },
    },
    {
      type: "task.updated",
      payload: { status: "paused", reason: "budget_exhausted", max_usd: 0.5 },
    },
    {
      type: "task.updated",
      payload: {
        status: "failed",
        reason: "runtime_error",
        detail: "Oh My Pi session ended with an error.",
      },
    },
  ],
  "execution.observed": [
    observed("entry-1", "message_end"),
    observed("entry-2", "message_end"),
    observed("entry-3", "tool_execution_end", "mars_read"),
    observed("entry-4", "message_end"),
  ],
  "tool.completed": [
    {
      type: "tool.completed",
      payload: {
        tool: "mars_read",
        path: "apps/cli/src/render.ts",
        status: "ok",
        output: 'import { parseArgs } from "node:util";',
      },
    },
    {
      type: "tool.completed",
      payload: {
        tool: "mars_grep",
        primary: "--json",
        status: "ok",
        output: longOutput,
      },
    },
    {
      type: "tool.completed",
      payload: {
        tool: "mars_read",
        path: "documentation/OUTPUT_FORMAT.md",
        status: "ok",
        output: "# MARS Output Format",
      },
    },
    {
      type: "tool.completed",
      payload: {
        tool: "mars_exec",
        command: "bun test apps/cli",
        status: "error",
        output: `${longOutput}\nerror: 1 test failed`,
      },
    },
    {
      type: "tool.completed",
      payload: {
        operation: "hook.completed",
        event: "pre-tool",
        tool: "mars_exec",
        results: [
          {
            command: "./scripts/lint",
            exit_code: 2,
            blocked: true,
            reason: "lint must pass before exec",
            stdout: "",
            stderr: "src/render.ts:3 unused import",
          },
        ],
      },
    },
    {
      type: "tool.completed",
      payload: {
        tool: "mars_apply_patch",
        status: "ok",
        files: [
          {
            path: "apps/cli/src/render.ts",
            status: "modified",
            patch: fortyLinePatch,
          },
          {
            path: "documentation/CLI.md",
            status: "added",
            patch: "+# CLI\n+mars render --json",
          },
        ],
      },
    },
    {
      type: "tool.completed",
      payload: {
        operation: "child.result",
        child_task_id: "task-child-2",
        child_agent_id: "agent-2",
        role_label: "worker-2",
        task_revision: 1,
        attempt: 1,
        status: "running",
        model_id: "omniroute/openrouter/free-x",
        routing: { tier: "free" },
        tool_calls: 3,
      },
      usage: { input_tokens: 1200, output_tokens: 300, cost_usd: null },
    },
    {
      type: "tool.completed",
      producer: "@mars/watch",
      payload: {
        schema_version: 1,
        operation: "watch.evidence",
        kind: "verify",
        tool: "mars_verify",
        verdict: "pass",
        assurance: "deterministic_local",
        verified: true,
        advisory: false,
        files: ["evidence/render-json.txt", "evidence/screenshot-1.png"],
        limitations: [],
        summary: "bun test apps/cli passed (12 tests)",
        cli_version: null,
        recorded_at: "2026-11-04T12:00:30.000Z",
      },
    },
    {
      type: "tool.completed",
      producer: "@mars/watch",
      payload: {
        schema_version: 1,
        operation: "watch.evidence",
        kind: "verify",
        tool: "mars_verify",
        verdict: "fail",
        assurance: "deterministic_local",
        verified: false,
        advisory: false,
        files: ["evidence/lint.txt"],
        limitations: ["lint only"],
        summary: "biome reported 1 error",
        cli_version: null,
        recorded_at: "2026-11-04T12:00:31.000Z",
      },
    },
    {
      type: "tool.completed",
      producer: "@mars/knowledge-graph",
      payload: {
        schema_version: 1,
        operation: "graph.build",
        status: "ready",
        workspace_id: "ws-1",
        revision: "r12",
        isolation: "process_env",
        summary: "graph built: 412 nodes, 1,280 edges",
        limitations: [],
        stats: null,
        recorded_at: "2026-11-04T12:00:32.000Z",
      },
    },
    {
      type: "tool.completed",
      producer: "@mars/knowledge-graph",
      payload: {
        operation: "graph.query",
        status: "ready",
        revision: "r12",
        answer: "render.ts is imported by main.ts and serve.ts",
      },
    },
    {
      type: "tool.completed",
      payload: {
        operation: "conventions.applied",
        status: "ok",
        summary: "AGENTS.md (trusted), 2 commands",
      },
    },
    {
      type: "tool.completed",
      payload: {
        operation: "runtime.result",
        status: "completed",
        steering_event_ids: [],
      },
      usage: { input_tokens: 2100, output_tokens: 640, cost_usd: 0 },
    },
  ],
  "research.proposed": [
    {
      type: "research.proposed",
      producer: "mars-research",
      payload: {
        request_id: "research-1",
        finding_id: "finding-1",
        task_revision: 1,
        confidence: 0.82,
        source_count: 2,
        claim: "Bun's parseArgs supports boolean flags",
        source: "https://bun.sh/docs/api/utils",
        used: true,
        excerpt: "parseArgs({ options: { json: { type: 'boolean' } } })",
      },
    },
    {
      type: "research.proposed",
      producer: "mars-research",
      payload: {
        request_id: "research-1",
        finding_id: "finding-2",
        task_revision: 1,
        confidence: 0.4,
        source_count: 1,
        claim: "Node 18 lacks util.parseArgs",
        source: "https://nodejs.org/api/util.html",
        used: false,
        excerpt: "Added in: v18.3.0",
      },
    },
  ],
  "research.stale": [
    {
      type: "research.proposed",
      producer: "mars-research",
      payload: {
        request_id: "research-1",
        finding_id: "finding-2",
        task_revision: 1,
        confidence: 0.4,
        source_count: 1,
        claim: "Node 18 lacks util.parseArgs",
        source: "https://nodejs.org/api/util.html",
        used: false,
      },
    },
    {
      type: "research.stale",
      producer: "mars-research",
      payload: {
        request_id: "research-1",
        task_revision: 2,
        stale_finding_ids: ["finding-2"],
      },
    },
  ],
  "memory.revised": [
    {
      type: "memory.revised",
      producer: "@mars/memory",
      payload: {
        kind: "memory",
        scope: "project",
        revision: "mem-r3",
        before: "Use npm for scripts.",
        after: "Use bun for scripts; npm is not installed.",
      },
    },
  ],
  "skill.revised": [
    {
      type: "skill.revised",
      producer: "@mars/skills",
      payload: {
        kind: "skill",
        scope: "project",
        revision: "skill-r2",
        before: "Run tests with bun test.",
        after: "Run tests with bun test apps packages scripts.",
      },
    },
  ],
  "evaluation.completed": [
    {
      type: "evaluation.completed",
      producer: "@mars/optimization",
      payload: {
        name: "render-json-eval",
        score: 0.91,
        summary: "11 of 12 cases pass",
      },
    },
  ],
  "training.updated": [
    {
      type: "training.updated",
      producer: "@mars/optimization",
      payload: { status: "candidate ready", summary: "GEPA round 3" },
    },
  ],
  "promotion.decided": [
    {
      type: "promotion.decided",
      producer: "@mars/optimization",
      payload: {
        kind: "gepa",
        scope: "project",
        revision: "prompt-r4",
        before: "Answer briefly.",
        after: "Answer briefly; cite files.",
        decision: "pending",
      },
    },
  ],
};

/** Journal text for the `execution.observed` fixture's entry ids. */
export const JOURNAL_ENTRIES: JournalEntry[] = [
  {
    entry_id: "entry-1",
    kind: "reasoning",
    text: "The flag belongs in parseArgs; the renderer already has a JSON path.",
    usage: { input_tokens: 400, output_tokens: 120, cost_usd: null },
  },
  {
    entry_id: "entry-2",
    kind: "assistant",
    text: "I'll add `--json` to `mars render`.\n\n- parse the flag\n- print `processOutput` as JSON\n\nRun: `bun test apps/cli`",
  },
  {
    entry_id: "entry-4",
    kind: "assistant",
    text: "Done. `mars render --json` prints the processed document. Nothing is executed.",
  },
];

/** A deterministic task with `count` events cycling through every card type. */
export function generateLargeTask(count = 10_000): ProjectionEvent[] {
  const cycle = Object.values(EVENT_FIXTURES).flat();
  const specs: FixtureEventSpec[] = [];
  for (let i = 0; i < count; i++) {
    const base = cycle[i % cycle.length] as FixtureEventSpec;
    specs.push(
      base.type === "execution.observed"
        ? observed(`entry-large-${i}`, "message_end")
        : base,
    );
  }
  return fixtureEvents(specs, { prefix: "big" });
}

export function eventFixturePath(name: string): string {
  return join(FIXTURE_ROOT, "events", `${name}.jsonl`);
}

export function loadEventFixture(name: string): ProjectionEvent[] {
  return readFileSync(eventFixturePath(name), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ProjectionEvent);
}

export function serializeEvents(events: readonly ProjectionEvent[]): string {
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

export interface JournalFixture {
  request: { task_id: string; entry_ids: string[] };
  status: number;
  reply:
    | { result: JournalEntry[] }
    | { error: { code: string; message: string } };
}

export function loadJournalFixture(name: string): JournalFixture {
  return JSON.parse(
    readFileSync(join(FIXTURE_ROOT, "journal", `${name}.json`), "utf8"),
  ) as JournalFixture;
}
