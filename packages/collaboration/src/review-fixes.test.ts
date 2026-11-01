import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RequestContext, Scope, Task } from "@mars/contracts";
import { createCollaboration } from "./coordinator";
import { CollaborationError } from "./errors";
import {
  type ChildLaunch,
  type ChildOutcome,
  createChildRunner,
} from "./runner";
import type { CollaborationLimits } from "./schemas";

const scope: Scope = {
  owner_id: "owner",
  project_id: "project",
  workspace_id: "workspace",
};
const context: RequestContext = {
  schema_version: 1,
  scope,
  request_id: "request-1",
};
const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function task(): Task {
  return {
    schema_version: 1,
    task_id: "task-1",
    session_id: "session-task-1",
    scope,
    revision: 0,
    request: "Coordinate a bounded implementation.",
    acceptance_criteria: ["Return a result proposal."],
    budget: {
      max_tokens: 1000,
      max_usd: 0,
      max_duration_ms: 60_000,
      max_depth: 2,
      max_concurrency: 3,
    },
    status: "pending",
    specialist_revision: null,
    artifacts: [],
  };
}

async function fixture(
  options: { limits?: Partial<CollaborationLimits>; roomModelId?: string } = {},
) {
  const rootDir = await mkdtemp(join(tmpdir(), "mars-collaboration-review-"));
  cleanup.push(() => rm(rootDir, { recursive: true, force: true }));
  let now = 1_700_000_000_000;
  let id = 0;
  let token = 0;
  const collaboration = await createCollaboration({
    rootDir,
    hostPrivateRoots: [join(rootDir, "private")],
    now: () => now,
    randomId: () => `id-${++id}`,
    randomToken: () => `token-${++token}`,
    limits: { lease_ms: 300, ...options.limits },
  });
  cleanup.push(() => collaboration.close());
  const opened = await collaboration.host.openRoom(context, {
    task: task(),
    idempotency_key: "open-1",
    delegation_pool: { max_tokens: 800 },
    ...(options.roomModelId ? { model_id: options.roomModelId } : {}),
    authority: {
      approvals: { read: true, write: false, execute: false },
      allow_delegation: true,
      paid_consent: false,
    },
  });
  return {
    collaboration,
    rootDir,
    room: opened.room,
    coordinator: opened.coordinator,
    advance(milliseconds: number) {
      now += milliseconds;
    },
  };
}

function delegation(
  key: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    idempotency_key: key,
    role_label: "worker",
    instruction: `Implement one isolated change for ${key}.`,
    budget: {
      max_tokens: 100,
      max_duration_ms: 20_000,
      max_steps: 10,
      max_messages: 10,
    },
    ...overrides,
  };
}

async function expectCode(
  operation: () => unknown | Promise<unknown>,
  code: string,
): Promise<void> {
  let error: unknown;
  try {
    await operation();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(CollaborationError);
  expect(error).toMatchObject({ code });
}

const sha = "a".repeat(64);

test("child artifacts pass the publishable filter before they reach results", async () => {
  const f = await fixture();
  const child = await f.collaboration.agents.delegate(
    context,
    f.coordinator,
    delegation("artifact-child"),
  );
  const claim = await f.collaboration.host.jobs.claim("runner-a");
  if (!claim) throw new Error("Child was not claimed");
  await f.collaboration.host.jobs.finalize(
    claim.job_id,
    "runner-a",
    claim.lease_epoch,
    {
      status: "completed",
      summary: "Artifacts attached.",
      artifacts: [
        {
          artifact_id: "safe-artifact",
          sha256: sha,
          media_type: "text/plain",
          byte_length: 3,
        },
        {
          artifact_id: join(f.rootDir, "private", "journal.jsonl"),
          sha256: sha,
          media_type: "text/plain",
          byte_length: 3,
        },
        {
          artifact_id: "sk-abcdefghijklmnopqrstuvwxyz0123456789",
          sha256: sha,
          media_type: "text/plain",
          byte_length: 3,
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1, usd: 0, steps: 1 },
    },
  );
  const { results } = await f.collaboration.agents.results(
    context,
    f.coordinator,
  );
  expect(results).toHaveLength(1);
  expect(results[0]?.child_agent_id).toBe(child.agent_id);
  expect(results[0]?.artifacts.map((a) => a.artifact_id)).toEqual([
    "safe-artifact",
  ]);
  expect(results[0]?.unsafe_artifacts).toBe(2);
  expect(JSON.stringify(results)).not.toContain(f.rootDir);
  expect(JSON.stringify(results)).not.toContain(
    "sk-abcdefghijklmnopqrstuvwxyz0123456789",
  );
});

test("a drained room still lets the parent list and review proposals", async () => {
  const f = await fixture();
  const child = await f.collaboration.agents.delegate(
    context,
    f.coordinator,
    delegation("drain-child"),
  );
  await f.collaboration.host.closeRoom(context, f.room.room_id, "drain");
  const claim = await f.collaboration.host.jobs.claim("runner-a");
  if (!claim) throw new Error("Draining room did not hand out queued work");
  await f.collaboration.host.jobs.finalize(
    claim.job_id,
    "runner-a",
    claim.lease_epoch,
    {
      status: "completed",
      summary: "Done before close.",
      artifacts: [],
      usage: { input_tokens: 4, output_tokens: 1, usd: 0, steps: 1 },
    },
  );
  expect(
    (await f.collaboration.host.inspectRoom(context, f.room.room_id)).status,
  ).toBe("closed");
  const { results } = await f.collaboration.agents.results(
    context,
    f.coordinator,
  );
  expect(results.map((r) => r.child_agent_id)).toEqual([child.agent_id]);
  const reviewed = await f.collaboration.agents.reviewResult(
    context,
    f.coordinator,
    results[0]?.result_id ?? "",
    { decision: "accept", expected_task_revision: 0 },
  );
  expect(reviewed.status).toBe("accepted");
  await expectCode(
    () =>
      f.collaboration.agents.send(context, f.coordinator, {
        idempotency_key: "after-close",
        recipients: [child.agent_id],
        kind: "notice",
        body: "No new messages after close.",
      }),
    "closed",
  );
  await expectCode(
    () =>
      f.collaboration.agents.delegate(
        context,
        f.coordinator,
        delegation("after-close"),
      ),
    "closed",
  );
});

test("rejected sends keep their counters after the transaction rolls back", async () => {
  const f = await fixture({
    limits: { max_inbox_backlog: 1, max_pair_messages: 1 },
  });
  const child = await f.collaboration.agents.delegate(
    context,
    f.coordinator,
    delegation("counter-child"),
  );
  await f.collaboration.agents.send(context, f.coordinator, {
    idempotency_key: "first",
    recipients: [child.agent_id],
    kind: "notice",
    body: "First message fills the inbox.",
  });
  await expectCode(
    () =>
      f.collaboration.agents.send(context, f.coordinator, {
        idempotency_key: "second",
        recipients: [child.agent_id],
        kind: "notice",
        body: "Second message is rejected.",
      }),
    "loop_limit",
  );
  const stats = await f.collaboration.host.stats(context, f.room.room_id);
  expect(stats.rejected_loop).toBe(1);
  expect(stats.messages_sent).toBe(1);
});

test("inbox backpressure rejections are counted", async () => {
  const f = await fixture({ limits: { max_inbox_backlog: 1 } });
  const child = await f.collaboration.agents.delegate(
    context,
    f.coordinator,
    delegation("backlog-child"),
  );
  await f.collaboration.agents.send(context, f.coordinator, {
    idempotency_key: "first",
    recipients: [child.agent_id],
    kind: "notice",
    body: "First message fills the inbox.",
  });
  await expectCode(
    () =>
      f.collaboration.agents.send(context, f.coordinator, {
        idempotency_key: "second",
        recipients: [child.agent_id],
        kind: "notice",
        body: "Second message is rejected.",
      }),
    "backpressure",
  );
  const stats = await f.collaboration.host.stats(context, f.room.room_id);
  expect(stats.rejected_backpressure).toBe(1);
});

test("a finished parent keeps its running grandchild's reservation and cancels it", async () => {
  const f = await fixture();
  const parent = await f.collaboration.agents.delegate(
    context,
    f.coordinator,
    delegation("hold-parent", {
      may_delegate: true,
      budget: {
        max_tokens: 100,
        max_duration_ms: 10_000,
        max_steps: 5,
        max_messages: 5,
        delegation_pool_tokens: 20,
      },
    }),
  );
  if (!parent.capability) throw new Error("Parent capability missing");
  const grandchild = await f.collaboration.agents.delegate(
    context,
    parent.capability,
    delegation("hold-grandchild", {
      budget: {
        max_tokens: 20,
        max_duration_ms: 10_000,
        max_steps: 5,
        max_messages: 5,
      },
    }),
  );
  const running = new Map<string, (outcome: ChildOutcome) => void>();
  const runner = createChildRunner({
    collaboration: f.collaboration,
    runnerId: "hold-runner",
    adapter: {
      async start(launch) {
        let finish!: (outcome: ChildOutcome) => void;
        const outcome = new Promise<ChildOutcome>((resolve) => {
          finish = resolve;
        });
        running.set(launch.agent_id, finish);
        return {
          session_ref: `private-${launch.agent_id}`,
          base_revision: null,
          outcome,
          async cancel() {},
        };
      },
    },
  });
  expect(await runner.tick()).toBe(2);
  running.get(parent.agent_id)?.({
    status: "completed",
    summary: "Parent finished first.",
    artifacts: [],
    usage: { input_tokens: 80, output_tokens: 0, usd: 0, steps: 1 },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  let stats = await f.collaboration.host.stats(context, f.room.room_id);
  expect(stats.tokens.input).toBe(80);
  expect(stats.reserved.tokens).toBe(20);
  await expectCode(
    () =>
      f.collaboration.agents.delegate(
        context,
        f.coordinator,
        delegation("over-pool", {
          budget: {
            max_tokens: 701,
            max_duration_ms: 10_000,
            max_steps: 5,
            max_messages: 5,
          },
        }),
      ),
    "budget_exceeded",
  );
  const members = await f.collaboration.agents.members(context, f.coordinator);
  expect(
    members.members.find((m) => m.agent_id === grandchild.agent_id)?.status,
  ).toBe("cancelled");
  running.get(grandchild.agent_id)?.({
    status: "completed",
    summary: "Orphaned grandchild result.",
    artifacts: [],
    usage: { input_tokens: 5, output_tokens: 0, usd: 0, steps: 1 },
  });
  await runner.idle();
  stats = await f.collaboration.host.stats(context, f.room.room_id);
  expect(stats.tokens.input).toBe(85);
  expect(stats.reserved.tokens).toBe(0);
  expect(stats.discarded_results).toBe(1);
  const fits = await f.collaboration.agents.delegate(
    context,
    f.coordinator,
    delegation("fits-pool", {
      budget: {
        max_tokens: 700,
        max_duration_ms: 10_000,
        max_steps: 5,
        max_messages: 5,
      },
    }),
  );
  expect(fits.capability).not.toBeNull();
});

test("retries keep the cumulative step limit and the model bound to the journal", async () => {
  const f = await fixture({ roomModelId: "m-room" });
  await f.collaboration.agents.delegate(
    context,
    f.coordinator,
    delegation("retry-child", {
      budget: {
        max_tokens: 100,
        max_duration_ms: 20_000,
        max_steps: 5,
        max_messages: 5,
      },
    }),
  );
  const launches: ChildLaunch[] = [];
  const policyModels = ["free/alpha", "free/beta"];
  let policyCalls = 0;
  let finishFirst: ((outcome: ChildOutcome) => void) | undefined;
  const makeRunner = (runnerId: string, outcome: ChildOutcome | null) =>
    createChildRunner({
      collaboration: f.collaboration,
      runnerId,
      heartbeatMs: 20,
      modelPolicy: async () => ({
        model_id: policyModels[policyCalls++] ?? null,
        reason: "test",
      }),
      adapter: {
        async reconcile() {
          return { input_tokens: 10, output_tokens: 0, usd: 0, steps: 4 };
        },
        async start(launch, hooks) {
          launches.push(launch);
          await hooks.onProgress({
            steps: 0,
            usage: null,
            session_ref: join(f.rootDir, "private", "journal.jsonl"),
          });
          return {
            session_ref: join(f.rootDir, "private", "journal.jsonl"),
            base_revision: null,
            outcome: outcome
              ? Promise.resolve(outcome)
              : new Promise<ChildOutcome>((resolve) => {
                  finishFirst = resolve;
                }),
            async cancel() {},
          };
        },
      },
    });
  const first = makeRunner("runner-old", null);
  expect(await first.tick()).toBe(1);
  expect(launches[0]?.model_id).toBe("free/alpha");
  expect(launches[0]?.max_steps).toBe(5);
  f.advance(301);
  const second = makeRunner("runner-new", {
    status: "completed",
    summary: "Finished on retry.",
    artifacts: [],
    usage: { input_tokens: 12, output_tokens: 0, usd: 0, steps: 1 },
  });
  expect(await second.recover()).toEqual({
    examined: 1,
    requeued: 1,
    failed_closed: 0,
  });
  expect(await second.tick()).toBe(1);
  await second.idle();
  expect(launches).toHaveLength(2);
  expect(launches[1]?.max_steps).toBe(1);
  expect(launches[1]?.model_id).toBe("free/alpha");
  expect(policyCalls).toBe(1);
  const stats = await f.collaboration.host.stats(context, f.room.room_id);
  expect(stats.steps).toBe(5);
  expect(stats.tokens.input).toBe(12);
  expect(stats.children_completed).toBe(1);
  finishFirst?.({
    status: "completed",
    summary: "Late result from the fenced runner.",
    artifacts: [],
    usage: { input_tokens: 99, output_tokens: 0, usd: 0, steps: 9 },
  });
  await first.idle();
  expect(
    (await f.collaboration.host.stats(context, f.room.room_id)).tokens.input,
  ).toBe(12);
});

test("a retry with no remaining steps fails before the adapter starts", async () => {
  const f = await fixture();
  await f.collaboration.agents.delegate(
    context,
    f.coordinator,
    delegation("steps-child", {
      budget: {
        max_tokens: 100,
        max_duration_ms: 20_000,
        max_steps: 2,
        max_messages: 5,
      },
    }),
  );
  const claim = await f.collaboration.host.jobs.claim("runner-old");
  if (!claim) throw new Error("Child was not claimed");
  await f.collaboration.host.jobs.heartbeat(
    claim.job_id,
    "runner-old",
    claim.lease_epoch,
    {
      steps: 2,
      usage: null,
      session_ref: join(f.rootDir, "private", "journal.jsonl"),
    },
  );
  f.advance(301);
  let started = 0;
  const runner = createChildRunner({
    collaboration: f.collaboration,
    runnerId: "runner-new",
    adapter: {
      async reconcile() {
        return { input_tokens: 3, output_tokens: 0, usd: 0, steps: 2 };
      },
      async start() {
        started += 1;
        throw new Error("must not start");
      },
    },
  });
  await runner.recover();
  await runner.tick();
  await runner.idle();
  expect(started).toBe(0);
  const stats = await f.collaboration.host.stats(context, f.room.room_id);
  expect(stats.children_failed).toBe(1);
  expect(stats.reserved.tokens).toBe(0);
});

test("reopening a store created before unsafe_artifacts migrates the results table", async () => {
  const f = await fixture();
  await f.collaboration.agents.delegate(
    context,
    f.coordinator,
    delegation("legacy-child"),
  );
  const claim = await f.collaboration.host.jobs.claim("runner-a");
  if (!claim) throw new Error("Child was not claimed");
  await f.collaboration.host.jobs.finalize(
    claim.job_id,
    "runner-a",
    claim.lease_epoch,
    {
      status: "completed",
      summary: "Legacy result.",
      artifacts: [],
      usage: { input_tokens: 1, output_tokens: 0, usd: 0, steps: 1 },
    },
  );
  const legacy = new Database(join(f.rootDir, "collaboration.sqlite"));
  legacy.exec("ALTER TABLE results DROP COLUMN unsafe_artifacts");
  expect(
    legacy
      .query<{ name: string }, []>("PRAGMA table_info(results)")
      .all()
      .some((column) => column.name === "unsafe_artifacts"),
  ).toBe(false);
  legacy.close();
  const reopened = await createCollaboration({
    rootDir: f.rootDir,
    hostPrivateRoots: [join(f.rootDir, "private")],
  });
  cleanup.push(() => reopened.close());
  const { results } = await reopened.agents.results(context, f.coordinator);
  expect(results).toHaveLength(1);
  expect(results[0]?.unsafe_artifacts).toBe(0);
  const again = await createCollaboration({
    rootDir: f.rootDir,
    hostPrivateRoots: [join(f.rootDir, "private")],
  });
  cleanup.push(() => again.close());
  expect(
    (await again.agents.results(context, f.coordinator)).results,
  ).toHaveLength(1);
});
