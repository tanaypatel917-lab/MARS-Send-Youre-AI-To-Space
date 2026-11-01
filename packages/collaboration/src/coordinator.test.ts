import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RequestContext, Task } from "@mars/contracts";
import {
  assertPublishable,
  type ChildOutcome,
  type ChildRuntimeAdapter,
  CollaborationError,
  createChildRunner,
  createCollaboration,
} from "./index";

const scope = {
  owner_id: "collaboration-test",
  project_id: "coordinator",
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

function task(taskId = "task-1"): Task {
  return {
    schema_version: 1,
    task_id: taskId,
    session_id: `session-${taskId}`,
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

async function fixture(options: { leaseMs?: number } = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), "mars-collaboration-test-"));
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
    limits: { lease_ms: options.leaseMs ?? 300 },
  });
  cleanup.push(() => collaboration.close());
  const opened = await collaboration.host.openRoom(context, {
    task: task(),
    idempotency_key: "open-1",
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
    instruction: "Implement one isolated change.",
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

test("directed delivery, idempotency, redelivery, acknowledgement and capability fencing", async () => {
  const f = await fixture();
  const child = await f.collaboration.agents.delegate(
    context,
    f.coordinator,
    delegation("child-1"),
  );
  const childCapability = child.capability;
  if (!childCapability) throw new Error("Child capability was not issued");
  const replay = await f.collaboration.agents.delegate(
    context,
    f.coordinator,
    delegation("child-1"),
  );
  expect(replay.agent_id).toBe(child.agent_id);
  expect(replay.capability).toBeNull();
  expect(replay.replayed).toBe(true);

  const sent = await f.collaboration.agents.send(context, f.coordinator, {
    idempotency_key: "message-1",
    recipients: [child.agent_id],
    kind: "request",
    body: "Please return a concise status.",
  });
  const sentReplay = await f.collaboration.agents.send(context, f.coordinator, {
    idempotency_key: "message-1",
    recipients: [child.agent_id],
    kind: "request",
    body: "Please return a concise status.",
  });
  expect(sentReplay).toMatchObject({ seq: sent.seq, replayed: true });

  const firstInbox = await f.collaboration.agents.inbox(
    context,
    childCapability,
  );
  const secondInbox = await f.collaboration.agents.inbox(
    context,
    childCapability,
  );
  expect(firstInbox.messages[0]).toMatchObject({
    sender: { agent_id: f.coordinator.agent_id, role_label: "coordinator" },
    trust: "untrusted",
    authority: "none",
    delivered_count: 1,
  });
  expect(secondInbox.messages[0]?.delivered_count).toBe(2);
  expect(
    await f.collaboration.agents.ack(context, childCapability, [
      sent.message_id,
    ]),
  ).toEqual({ acknowledged: 1 });
  expect(
    (await f.collaboration.agents.inbox(context, childCapability)).messages,
  ).toHaveLength(0);
  expect(
    (await f.collaboration.host.stats(context, f.room.room_id)).replayed_sends,
  ).toBe(1);

  await expectCode(
    () =>
      f.collaboration.agents.send(context, childCapability, {
        idempotency_key: "spoof",
        recipients: [f.coordinator.agent_id],
        kind: "notice",
        body: "Not allowed to choose a sender.",
        from: f.coordinator.agent_id,
      }),
    "invalid_input",
  );
  await expectCode(
    () =>
      f.collaboration.agents.inbox(context, {
        ...childCapability,
        agent_id: f.coordinator.agent_id,
      }),
    "forbidden",
  );
  await expectCode(
    () =>
      f.collaboration.agents.inbox(
        { ...context, scope: { ...scope, owner_id: "other-owner" } },
        childCapability,
      ),
    "forbidden",
  );
});

test("delegation is idempotent and narrows parent authority and reserved budget", async () => {
  const f = await fixture();
  const worker = await f.collaboration.agents.delegate(
    context,
    f.coordinator,
    delegation("worker", {
      budget: {
        max_tokens: 600,
        max_duration_ms: 20_000,
        max_steps: 10,
        max_messages: 10,
      },
    }),
  );
  await expectCode(
    () =>
      f.collaboration.agents.delegate(
        context,
        f.coordinator,
        delegation("over-budget", {
          budget: {
            max_tokens: 500,
            max_duration_ms: 20_000,
            max_steps: 10,
            max_messages: 10,
          },
        }),
      ),
    "budget_exceeded",
  );
  await expectCode(
    () =>
      f.collaboration.agents.delegate(
        context,
        f.coordinator,
        delegation("extra-write", {
          approvals: { write: true },
          write_paths: ["src/new-file.ts"],
        }),
      ),
    "forbidden",
  );
  await expectCode(
    () =>
      f.collaboration.agents.delegate(
        context,
        f.coordinator,
        delegation("worker", {
          instruction: "Different request under the same key.",
          budget: {
            max_tokens: 600,
            max_duration_ms: 20_000,
            max_steps: 10,
            max_messages: 10,
          },
        }),
      ),
    "conflict",
  );
  expect(worker.capability).not.toBeNull();
  expect(worker.budget.deadline).toBeLessThanOrEqual(f.room.deadline);
  expect(
    (await f.collaboration.host.stats(context, f.room.room_id)).reserved,
  ).toEqual({ tokens: 600, usd: 0 });
});

test("runner finalizes proposals, accounts usage, and keeps journal references private", async () => {
  const f = await fixture();
  await f.collaboration.agents.delegate(
    context,
    f.coordinator,
    delegation("runner-child"),
  );
  const outcome: ChildOutcome = {
    status: "completed",
    summary: "Implemented the isolated change.",
    artifacts: [],
    usage: { input_tokens: 12, output_tokens: 5, usd: 0, steps: 1 },
  };
  let starts = 0;
  const adapter: ChildRuntimeAdapter = {
    async start(launch) {
      starts += 1;
      expect(launch.session_ref).toBeNull();
      return {
        session_ref: join(f.rootDir, "private", "journal.jsonl"),
        base_revision: "base-1",
        outcome: Promise.resolve(outcome),
        async cancel() {},
      };
    },
  };
  const runner = createChildRunner({
    collaboration: f.collaboration,
    adapter,
    runnerId: "runner-1",
    heartbeatMs: 20,
  });
  expect(await runner.tick()).toBe(1);
  await runner.idle();
  expect(starts).toBe(1);

  const children = await f.collaboration.agents.children(
    context,
    f.coordinator,
  );
  expect(children.children[0]?.state).toBe("completed");
  const proposals = await f.collaboration.agents.results(
    context,
    f.coordinator,
  );
  expect(proposals.results[0]).toMatchObject({
    status: "proposed",
    outcome: "completed",
    summary: outcome.summary,
    base_revision: "base-1",
    usage: outcome.usage,
  });
  const visible = JSON.stringify({
    room: await f.collaboration.host.inspectRoom(context, f.room.room_id),
    children,
    proposals,
  });
  expect(visible).not.toContain(f.rootDir);
  expect(visible).not.toContain("journal.jsonl");

  const proposal = proposals.results[0];
  if (!proposal) throw new Error("Completed child did not produce a result");
  const reviewed = await f.collaboration.agents.reviewResult(
    context,
    f.coordinator,
    proposal.result_id,
    {
      decision: "accept",
      expected_task_revision: 0,
      current_base_revision: "base-1",
    },
  );
  expect(reviewed.status).toBe("accepted");
  const stats = await f.collaboration.host.stats(context, f.room.room_id);
  expect(stats.tokens).toEqual({ input: 12, output: 5 });
  expect(stats.steps).toBe(1);
  expect(stats.children_completed).toBe(1);
  expect(stats.results_accepted).toBe(1);
});

test("expired leases reconcile cumulative usage and fence the previous owner", async () => {
  const f = await fixture({ leaseMs: 300 });
  const child = await f.collaboration.agents.delegate(
    context,
    f.coordinator,
    delegation("recover-child"),
  );
  const claim = await f.collaboration.host.jobs.claim("runner-old");
  if (!claim) throw new Error("Runner did not claim the queued child");
  await f.collaboration.host.jobs.heartbeat(
    claim.job_id,
    "runner-old",
    claim.lease_epoch,
    {
      steps: 1,
      usage: null,
      session_ref: join(f.rootDir, "private", "journal.jsonl"),
      base_revision: "base-1",
    },
  );
  f.advance(301);
  const recoveredUsage = {
    input_tokens: 5,
    output_tokens: 2,
    usd: 0,
    steps: 1,
  };
  const resumed: string[] = [];
  const runner = createChildRunner({
    collaboration: f.collaboration,
    runnerId: "runner-new",
    adapter: {
      async reconcile(sessionRef) {
        expect(sessionRef).toContain("journal.jsonl");
        return recoveredUsage;
      },
      async start(launch) {
        const sessionRef = launch.session_ref;
        if (!sessionRef)
          throw new Error("Recovery did not provide a journal reference");
        resumed.push(sessionRef);
        return {
          session_ref: sessionRef,
          base_revision: "base-1",
          outcome: Promise.resolve({
            status: "completed",
            summary: "Resumed and finished.",
            artifacts: [],
            usage: { input_tokens: 9, output_tokens: 3, usd: 0, steps: 2 },
          }),
          async cancel() {},
        };
      },
    },
    heartbeatMs: 20,
  });
  expect(await runner.recover()).toEqual({
    examined: 1,
    requeued: 1,
    failed_closed: 0,
  });
  await expectCode(
    () =>
      f.collaboration.host.jobs.finalize(
        claim.job_id,
        "runner-old",
        claim.lease_epoch,
        {
          status: "completed",
          summary: "Late result.",
          artifacts: [],
          usage: recoveredUsage,
        },
      ),
    "lease_lost",
  );
  expect(await runner.tick()).toBe(1);
  await runner.idle();
  expect(resumed).toHaveLength(1);
  expect(resumed[0]).toContain("journal.jsonl");
  expect(
    (await f.collaboration.host.stats(context, f.room.room_id)).tokens,
  ).toEqual({
    input: 9,
    output: 3,
  });
  expect(
    (
      await f.collaboration.agents.children(context, f.coordinator)
    ).children.map((member) => member.agent_id),
  ).toContain(child.agent_id);
});

test("content checks reject private roots and secret-like values at boundaries", async () => {
  const f = await fixture();
  expect(() =>
    assertPublishable("/a/private-backup/file.txt", ["/a/private"], "/root"),
  ).not.toThrow();
  expect(() =>
    assertPublishable("/a/private/file.txt", ["/a/private"], "/root"),
  ).toThrow();
  await expectCode(
    () =>
      f.collaboration.agents.delegate(
        context,
        f.coordinator,
        delegation("private-path", {
          instruction: `Read ${f.rootDir}/private/file.txt.`,
        }),
      ),
    "unsafe_content",
  );
  const child = await f.collaboration.agents.delegate(
    context,
    f.coordinator,
    delegation("path-boundary", {
      instruction: "Edit /a/private-backup/file.txt only.",
    }),
  );
  expect(child.agent_id).toBeTruthy();
  await expectCode(
    () =>
      f.collaboration.agents.send(context, f.coordinator, {
        idempotency_key: "secret",
        recipients: [child.agent_id],
        kind: "notice",
        body: "Credential is sk-123456789012345678901234",
      }),
    "unsafe_content",
  );
});

test("room concurrency queues excess children until a running slot is released", async () => {
  const f = await fixture();
  for (const key of ["parallel-1", "parallel-2", "parallel-3"])
    await f.collaboration.agents.delegate(
      context,
      f.coordinator,
      delegation(key),
    );
  const releases: (() => void)[] = [];
  const runner = createChildRunner({
    collaboration: f.collaboration,
    runnerId: "parallel-runner",
    heartbeatMs: 20,
    adapter: {
      async start() {
        let resolve!: (outcome: ChildOutcome) => void;
        const outcome = new Promise<ChildOutcome>((yes) => {
          resolve = yes;
        });
        releases.push(() =>
          resolve({
            status: "completed",
            summary: "Done.",
            artifacts: [],
            usage: { input_tokens: 1, output_tokens: 1, usd: 0, steps: 1 },
          }),
        );
        return {
          session_ref: "private-session-ref",
          base_revision: null,
          outcome,
          async cancel() {},
        };
      },
    },
  });
  expect(await runner.tick()).toBe(2);
  expect(releases).toHaveLength(2);
  expect(await runner.tick()).toBe(0);
  const releaseFirst = releases[0];
  const releaseSecond = releases[1];
  if (!releaseFirst || !releaseSecond)
    throw new Error("Two children were not started concurrently");
  releaseFirst();
  releaseSecond();
  await runner.idle();
  expect(await runner.tick()).toBe(1);
  const releaseThird = releases[2];
  if (!releaseThird) throw new Error("The queued child did not start");
  releaseThird();
  await runner.idle();
  expect(
    (await f.collaboration.host.stats(context, f.room.room_id))
      .children_completed,
  ).toBe(3);
});

test("runner shutdown cancels local work and accounts the reported usage", async () => {
  const f = await fixture();
  const child = await f.collaboration.agents.delegate(
    context,
    f.coordinator,
    delegation("shutdown-child"),
  );
  let finish!: (outcome: ChildOutcome) => void;
  const runner = createChildRunner({
    collaboration: f.collaboration,
    runnerId: "shutdown-runner",
    heartbeatMs: 20,
    adapter: {
      async start() {
        const outcome = new Promise<ChildOutcome>((resolve) => {
          finish = resolve;
        });
        return {
          session_ref: "private-session-ref",
          base_revision: null,
          outcome,
          async cancel() {
            finish({
              status: "cancelled",
              summary: "Stopped.",
              artifacts: [],
              usage: { input_tokens: 4, output_tokens: 2, usd: 0, steps: 1 },
            });
          },
        };
      },
    },
  });
  expect(await runner.tick()).toBe(1);
  await runner.shutdown();
  expect(
    (await f.collaboration.agents.children(context, f.coordinator)).children[0]
      ?.state,
  ).toBe("cancelled");
  const stats = await f.collaboration.host.stats(context, f.room.room_id);
  expect(stats.children_cancelled).toBe(1);
  expect(stats.tokens).toEqual({ input: 4, output: 2 });
  expect(child.agent_id).toBeTruthy();
});

test("queued cancellation releases its reservation and expires descendants", async () => {
  const f = await fixture();
  const child = await f.collaboration.agents.delegate(
    context,
    f.coordinator,
    delegation("cancel-queued"),
  );
  await f.collaboration.agents.cancelChild(
    context,
    f.coordinator,
    child.agent_id,
  );
  expect(
    (await f.collaboration.agents.children(context, f.coordinator)).children[0]
      ?.state,
  ).toBe("cancelled");
  expect(
    (await f.collaboration.host.stats(context, f.room.room_id)).reserved,
  ).toEqual({ tokens: 0, usd: 0 });
});

test("recovery without a readable journal fails closed and consumes the reservation", async () => {
  const f = await fixture();
  await f.collaboration.agents.delegate(
    context,
    f.coordinator,
    delegation("unreadable-journal"),
  );
  expect(
    await f.collaboration.host.jobs.claim("crashed-runner"),
  ).not.toBeNull();
  f.advance(301);
  const runner = createChildRunner({
    collaboration: f.collaboration,
    runnerId: "recovery-runner",
    adapter: {
      async start() {
        throw new Error("Not started");
      },
      async reconcile() {
        return null;
      },
    },
  });
  expect(await runner.recover()).toEqual({
    examined: 1,
    requeued: 0,
    failed_closed: 1,
  });
  const stats = await f.collaboration.host.stats(context, f.room.room_id);
  expect(stats.usage_unaccounted).toBe(1);
  expect(stats.tokens).toEqual({ input: 100, output: 0 });
  expect(stats.reserved).toEqual({ tokens: 0, usd: 0 });
});

test("a room reopens with its messages and capability rotation invalidates the old token", async () => {
  const f = await fixture();
  const child = await f.collaboration.agents.delegate(
    context,
    f.coordinator,
    delegation("persist-child"),
  );
  const childCapability = child.capability;
  if (!childCapability) throw new Error("Child capability was not issued");
  await f.collaboration.agents.send(context, f.coordinator, {
    idempotency_key: "persist-message",
    recipients: [child.agent_id],
    kind: "request",
    body: "Persist this coordination envelope.",
  });
  await f.collaboration.close();
  const reopened = await createCollaboration({
    rootDir: f.rootDir,
    hostPrivateRoots: [join(f.rootDir, "private")],
    now: () => 1_700_000_000_000,
  });
  cleanup.push(() => reopened.close());
  const rotated = await reopened.host.issueCapability(
    context,
    f.room.room_id,
    child.agent_id,
  );
  await expectCode(
    () => reopened.agents.inbox(context, childCapability),
    "forbidden",
  );
  const inbox = await reopened.agents.inbox(context, rotated);
  expect(inbox.messages.map((message) => message.body)).toEqual([
    "Persist this coordination envelope.",
  ]);
  expect(inbox.messages[0]?.seq).toBeGreaterThan(0);
});
