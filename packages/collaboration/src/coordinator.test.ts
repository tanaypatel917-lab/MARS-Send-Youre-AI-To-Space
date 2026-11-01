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
  type CollaborationLimits,
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

async function fixture(
  options: { leaseMs?: number; limits?: Partial<CollaborationLimits> } = {},
) {
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
    limits: {
      ...options.limits,
      lease_ms: options.leaseMs ?? options.limits?.lease_ms ?? 300,
    },
  });
  cleanup.push(() => collaboration.close());
  const opened = await collaboration.host.openRoom(context, {
    task: task(),
    idempotency_key: "open-1",
    delegation_pool: { max_tokens: 800 },
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
  const depthRoom = await f.collaboration.host.openRoom(context, {
    task: {
      ...task("depth-boundary"),
      budget: { ...task().budget, max_depth: 1 },
    },
    idempotency_key: "depth-boundary",
    delegation_pool: { max_tokens: 100 },
    authority: {
      approvals: { read: true, write: false, execute: false },
      allow_delegation: true,
      paid_consent: false,
    },
  });
  await expectCode(
    () =>
      f.collaboration.agents.delegate(
        context,
        depthRoom.coordinator,
        delegation("depth-limited-child", {
          may_delegate: true,
          budget: {
            max_tokens: 100,
            max_duration_ms: 10_000,
            max_steps: 2,
            max_messages: 2,
            delegation_pool_tokens: 10,
          },
        }),
      ),
    "limit_exceeded",
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

test("runtime and delegation pools keep a nested subtree inside its envelope", async () => {
  const f = await fixture();
  expect(f.room.coordinator_runtime_budget.max_tokens).toBe(200);
  const worker = await f.collaboration.agents.delegate(
    context,
    f.coordinator,
    delegation("pooled-worker", {
      may_delegate: true,
      budget: {
        max_tokens: 100,
        max_duration_ms: 20_000,
        max_steps: 10,
        max_messages: 10,
        delegation_pool_tokens: 20,
      },
    }),
  );
  const workerCapability = worker.capability;
  if (!workerCapability) throw new Error("Worker capability was not issued");
  const started: {
    role: string;
    budget: number;
    finish: (outcome: ChildOutcome) => void;
  }[] = [];
  const runner = createChildRunner({
    collaboration: f.collaboration,
    runnerId: "pool-runner",
    adapter: {
      async start(launch) {
        let finish!: (outcome: ChildOutcome) => void;
        const outcome = new Promise<ChildOutcome>((resolve) => {
          finish = resolve;
        });
        started.push({
          role: launch.role_label,
          budget: launch.budget.max_tokens,
          finish,
        });
        return {
          session_ref: `private-${launch.role_label}`,
          base_revision: null,
          outcome,
          async cancel() {},
        };
      },
    },
  });
  expect(await runner.tick()).toBe(1);
  expect(started[0]).toMatchObject({ role: "worker", budget: 80 });
  await expectCode(
    () =>
      f.collaboration.agents.delegate(
        context,
        workerCapability,
        delegation("too-large-grandchild", {
          budget: {
            max_tokens: 21,
            max_duration_ms: 10_000,
            max_steps: 5,
            max_messages: 2,
          },
        }),
      ),
    "budget_exceeded",
  );
  await f.collaboration.agents.delegate(
    context,
    workerCapability,
    delegation("grandchild", {
      budget: {
        max_tokens: 20,
        max_duration_ms: 10_000,
        max_steps: 5,
        max_messages: 2,
      },
    }),
  );
  expect(await runner.tick()).toBe(1);
  expect(started[1]).toMatchObject({ role: "worker", budget: 20 });
  const workerRun = started[0];
  const grandchildRun = started[1];
  if (!workerRun || !grandchildRun)
    throw new Error("Expected both nested jobs to start");
  workerRun.finish({
    status: "completed",
    summary: "Worker used its runtime allocation.",
    artifacts: [],
    usage: { input_tokens: 80, output_tokens: 0, usd: 0, steps: 1 },
  });
  grandchildRun.finish({
    status: "completed",
    summary: "Grandchild used its reservation.",
    artifacts: [],
    usage: { input_tokens: 20, output_tokens: 0, usd: 0, steps: 1 },
  });
  await runner.idle();
  const stats = await f.collaboration.host.stats(context, f.room.room_id);
  expect(
    stats.tokens.input + stats.tokens.output + stats.reserved.tokens,
  ).toBeLessThanOrEqual(800);
  const members = await f.collaboration.agents.members(context, f.coordinator);
  for (const member of members.members) {
    expect(
      member.usage.input_tokens +
        member.usage.output_tokens +
        member.reserved.tokens,
    ).toBeLessThanOrEqual(member.budget.max_tokens);
    expect(member.usage.usd + member.reserved.usd).toBeLessThanOrEqual(
      member.budget.max_usd,
    );
  }
  const persistedWorker = members.members.find(
    (member) => member.agent_id === worker.agent_id,
  );
  expect(persistedWorker?.usage.input_tokens).toBe(100);
  expect(persistedWorker?.pool).toEqual({ tokens: 20, usd: 0 });
  expect(stats.tokens.input).toBe(100);
});

test("delegation pools validate bounds, consent, and idempotency digests", async () => {
  const f = await fixture();
  const zeroPool = await f.collaboration.host.openRoom(context, {
    task: task("zero-pool"),
    idempotency_key: "zero-pool",
    authority: {
      approvals: { read: true, write: false, execute: false },
      allow_delegation: true,
      paid_consent: false,
    },
  });
  expect(zeroPool.room.coordinator_runtime_budget.max_tokens).toBe(1000);
  await expectCode(
    () =>
      f.collaboration.agents.delegate(
        context,
        zeroPool.coordinator,
        delegation("zero-pool-child"),
      ),
    "single_agent",
  );
  await expectCode(
    () =>
      f.collaboration.host.openRoom(context, {
        task: task(),
        idempotency_key: "open-1",
        delegation_pool: { max_tokens: 700 },
        authority: {
          approvals: { read: true, write: false, execute: false },
          allow_delegation: true,
          paid_consent: false,
        },
      }),
    "conflict",
  );
  await expectCode(
    () =>
      f.collaboration.host.openRoom(context, {
        task: task("too-large-root-pool"),
        idempotency_key: "too-large-root-pool",
        delegation_pool: { max_tokens: 1000 },
        authority: {
          approvals: { read: true, write: false, execute: false },
          allow_delegation: true,
          paid_consent: false,
        },
      }),
    "invalid_input",
  );
  const paidBudgetTask: Task = {
    ...task("paid-pool"),
    budget: { ...task().budget, max_usd: 10 },
  };
  await expectCode(
    () =>
      f.collaboration.host.openRoom(context, {
        task: paidBudgetTask,
        idempotency_key: "too-large-usd-pool",
        delegation_pool: { max_tokens: 10, max_usd: 11 },
        authority: {
          approvals: { read: true, write: false, execute: false },
          allow_delegation: true,
          paid_consent: true,
        },
      }),
    "invalid_input",
  );
  await expectCode(
    () =>
      f.collaboration.host.openRoom(context, {
        task: paidBudgetTask,
        idempotency_key: "paid-pool",
        delegation_pool: { max_tokens: 10, max_usd: 1 },
        authority: {
          approvals: { read: true, write: false, execute: false },
          allow_delegation: true,
          paid_consent: false,
        },
      }),
    "forbidden",
  );
  const pooledChildInput = delegation("pooled-child", {
    may_delegate: true,
    budget: {
      max_tokens: 100,
      max_duration_ms: 10_000,
      max_steps: 5,
      max_messages: 5,
      delegation_pool_tokens: 10,
    },
  });
  const pooledChild = await f.collaboration.agents.delegate(
    context,
    f.coordinator,
    pooledChildInput,
  );
  expect(
    (await f.collaboration.agents.members(context, f.coordinator)).members.find(
      ({ agent_id }) => agent_id === pooledChild.agent_id,
    )?.pool,
  ).toEqual({ tokens: 10, usd: 0 });
  expect(
    (
      await f.collaboration.agents.delegate(
        context,
        f.coordinator,
        pooledChildInput,
      )
    ).replayed,
  ).toBe(true);
  await expectCode(
    () =>
      f.collaboration.agents.delegate(
        context,
        f.coordinator,
        delegation("pooled-child", {
          may_delegate: true,
          budget: {
            max_tokens: 100,
            max_duration_ms: 10_000,
            max_steps: 5,
            max_messages: 5,
            delegation_pool_tokens: 11,
          },
        }),
      ),
    "conflict",
  );
  await expectCode(
    () =>
      f.collaboration.agents.delegate(
        context,
        f.coordinator,
        delegation("pool-needs-delegate-authority", {
          budget: {
            max_tokens: 100,
            max_duration_ms: 10_000,
            max_steps: 5,
            max_messages: 5,
            delegation_pool_tokens: 1,
          },
        }),
      ),
    "forbidden",
  );
  await expectCode(
    () =>
      f.collaboration.host.reviseTask(context, f.room.room_id, {
        ...task(),
        revision: 1,
        budget: { ...task().budget, max_tokens: 800 },
      }),
    "invalid_input",
  );
});

test("closed rooms reject revision and repeated close", async () => {
  const f = await fixture();
  await f.collaboration.host.closeRoom(context, f.room.room_id, "cancel");
  await expectCode(
    () => f.collaboration.host.closeRoom(context, f.room.room_id, "drain"),
    "closed",
  );
  await expectCode(
    () =>
      f.collaboration.host.reviseTask(context, f.room.room_id, {
        ...task(),
        revision: 1,
      }),
    "closed",
  );
});

test("revision fences capabilities and proposals and checks the workspace base", async () => {
  const f = await fixture();
  await f.collaboration.agents.delegate(
    context,
    f.coordinator,
    delegation("pre-revision-result"),
  );
  const initialRunner = createChildRunner({
    collaboration: f.collaboration,
    runnerId: "pre-revision-runner",
    adapter: {
      async start() {
        return {
          session_ref: "private-pre-revision",
          base_revision: "base-before",
          outcome: Promise.resolve({
            status: "completed",
            summary: "Proposal from the old revision.",
            artifacts: [],
            usage: { input_tokens: 2, output_tokens: 1, usd: 0, steps: 1 },
          }),
          async cancel() {},
        };
      },
    },
  });
  expect(await initialRunner.tick()).toBe(1);
  await initialRunner.idle();
  const preRevision = await f.collaboration.agents.results(
    context,
    f.coordinator,
  );
  const oldProposal = preRevision.results[0];
  if (!oldProposal) throw new Error("Old-revision proposal was not created");

  const activeChild = await f.collaboration.agents.delegate(
    context,
    f.coordinator,
    delegation("running-at-revision"),
  );
  const oldChildCapability = activeChild.capability;
  if (!oldChildCapability)
    throw new Error("Revision child did not receive a capability");
  let finish!: (outcome: ChildOutcome) => void;
  const runningRunner = createChildRunner({
    collaboration: f.collaboration,
    runnerId: "running-revision-runner",
    adapter: {
      async start() {
        const outcome = new Promise<ChildOutcome>((resolve) => {
          finish = resolve;
        });
        return {
          session_ref: "private-running-revision",
          base_revision: "base-before",
          outcome,
          async cancel() {},
        };
      },
    },
  });
  expect(await runningRunner.tick()).toBe(1);
  const revisedTask: Task = {
    ...task(),
    revision: 1,
    request: "Coordinate the revised bounded implementation.",
    budget: { ...task().budget, max_tokens: 900 },
  };
  const revised = await f.collaboration.host.reviseTask(
    context,
    f.room.room_id,
    revisedTask,
  );
  expect(revised.room.coordinator_runtime_budget.max_tokens).toBe(100);
  await expectCode(
    () => f.collaboration.agents.children(context, f.coordinator),
    "stale_revision",
  );
  await expectCode(
    () => f.collaboration.agents.inbox(context, oldChildCapability),
    "stale_revision",
  );
  finish({
    status: "completed",
    summary: "Late result from the old revision.",
    artifacts: [],
    usage: { input_tokens: 3, output_tokens: 1, usd: 0, steps: 1 },
  });
  await runningRunner.idle();
  await expectCode(
    () =>
      f.collaboration.agents.reviewResult(
        context,
        revised.coordinator,
        oldProposal.result_id,
        {
          decision: "accept",
          expected_task_revision: 1,
          current_base_revision: "base-before",
        },
      ),
    "stale_revision",
  );
  const resultsAfterRevision = await f.collaboration.agents.results(
    context,
    revised.coordinator,
  );
  expect(
    resultsAfterRevision.results.some(
      ({ result_id }) => result_id === oldProposal.result_id,
    ),
  ).toBe(true);

  const currentChild = await f.collaboration.agents.delegate(
    context,
    revised.coordinator,
    delegation("current-revision-result"),
  );
  const currentRunner = createChildRunner({
    collaboration: f.collaboration,
    runnerId: "current-revision-runner",
    adapter: {
      async start() {
        return {
          session_ref: "private-current-session",
          base_revision: "base-current",
          outcome: Promise.resolve({
            status: "completed",
            summary: "Current-revision proposal.",
            artifacts: [],
            usage: { input_tokens: 1, output_tokens: 1, usd: 0, steps: 1 },
          }),
          async cancel() {},
        };
      },
    },
  });
  expect(await currentRunner.tick()).toBe(1);
  await currentRunner.idle();
  const currentResults = await f.collaboration.agents.results(
    context,
    revised.coordinator,
  );
  const currentProposal = currentResults.results.find(
    ({ child_agent_id }) => child_agent_id === currentChild.agent_id,
  );
  if (!currentProposal)
    throw new Error("Current-revision proposal was not created");
  const nonParent = await f.collaboration.agents.delegate(
    context,
    revised.coordinator,
    delegation("non-parent-reviewer"),
  );
  const nonParentCapability = nonParent.capability;
  if (!nonParentCapability)
    throw new Error("Reviewer did not receive a capability");
  await expectCode(
    () =>
      f.collaboration.agents.reviewResult(
        context,
        nonParentCapability,
        currentProposal.result_id,
        {
          decision: "accept",
          expected_task_revision: 1,
          current_base_revision: "base-current",
        },
      ),
    "forbidden",
  );
  await expectCode(
    () =>
      f.collaboration.agents.reviewResult(
        context,
        revised.coordinator,
        currentProposal.result_id,
        {
          decision: "accept",
          expected_task_revision: 1,
          current_base_revision: "moved-base",
        },
      ),
    "stale_base",
  );
  expect(
    (
      await f.collaboration.agents.results(context, revised.coordinator)
    ).results.find(({ result_id }) => result_id === currentProposal.result_id)
      ?.status,
  ).toBe("proposed");
  const accepted = await f.collaboration.agents.reviewResult(
    context,
    revised.coordinator,
    currentProposal.result_id,
    {
      decision: "accept",
      expected_task_revision: 1,
      current_base_revision: "base-current",
    },
  );
  expect(accepted.status).toBe("accepted");
  await expectCode(
    () =>
      f.collaboration.agents.reviewResult(
        context,
        revised.coordinator,
        currentProposal.result_id,
        {
          decision: "accept",
          expected_task_revision: 1,
          current_base_revision: "base-current",
        },
      ),
    "conflict",
  );
  const stats = await f.collaboration.host.stats(context, f.room.room_id);
  expect(stats.discarded_results).toBe(1);
  expect(stats.results_stale).toBe(1);
});

test("peer allowlists authorize directed replies but not sibling access", async () => {
  const f = await fixture({ limits: { max_recipients: 1 } });
  const worker = await f.collaboration.agents.delegate(
    context,
    f.coordinator,
    delegation("peer-worker"),
  );
  const reviewer = await f.collaboration.agents.delegate(
    context,
    f.coordinator,
    delegation("peer-reviewer", {
      role_label: "reviewer",
      peers: [worker.agent_id],
    }),
  );
  const workerCapability = worker.capability;
  const reviewerCapability = reviewer.capability;
  if (!workerCapability || !reviewerCapability)
    throw new Error("Peer members did not receive capabilities");
  await expectCode(
    () =>
      f.collaboration.agents.send(context, workerCapability, {
        idempotency_key: "worker-notice",
        recipients: [reviewer.agent_id],
        kind: "notice",
        body: "A worker cannot initiate a peer message.",
      }),
    "forbidden",
  );
  await expectCode(
    () =>
      f.collaboration.agents.send(context, workerCapability, {
        idempotency_key: "worker-request",
        recipients: [reviewer.agent_id],
        kind: "request",
        body: "A worker cannot initiate a peer request.",
      }),
    "forbidden",
  );
  const request = await f.collaboration.agents.send(
    context,
    reviewerCapability,
    {
      idempotency_key: "reviewer-request",
      recipients: [worker.agent_id],
      kind: "request",
      body: "Please clarify the result.",
    },
  );
  await expectCode(
    () =>
      f.collaboration.agents.inbox(context, {
        ...workerCapability,
        agent_id: reviewer.agent_id,
      }),
    "forbidden",
  );
  const workerInbox = await f.collaboration.agents.inbox(
    context,
    workerCapability,
  );
  expect(workerInbox.messages[0]?.message_id).toBe(request.message_id);
  expect(
    (await f.collaboration.agents.inbox(context, reviewerCapability)).messages,
  ).toHaveLength(0);
  await expectCode(
    () =>
      f.collaboration.agents.send(context, workerCapability, {
        idempotency_key: "reply-to-unreceived",
        recipients: [reviewer.agent_id],
        kind: "reply",
        in_reply_to: `${request.message_id}-other`,
        body: "This was not delivered to the sender.",
      }),
    "forbidden",
  );
  const reply = await f.collaboration.agents.send(context, workerCapability, {
    idempotency_key: "peer-reply",
    recipients: [reviewer.agent_id],
    kind: "reply",
    in_reply_to: request.message_id,
    body: "The result handles the requested behavior.",
  });
  expect(
    (
      await f.collaboration.agents.inbox(context, reviewerCapability)
    ).messages.map(({ message_id }) => message_id),
  ).toContain(reply.message_id);
  await f.collaboration.agents.ack(context, workerCapability, [
    request.message_id,
  ]);
  await expectCode(
    () =>
      f.collaboration.agents.send(context, f.coordinator, {
        idempotency_key: "duplicate-recipients",
        recipients: [worker.agent_id, worker.agent_id],
        kind: "notice",
        body: "Duplicate target.",
      }),
    "invalid_input",
  );
  await expectCode(
    () =>
      f.collaboration.agents.send(context, f.coordinator, {
        idempotency_key: "too-many-recipients",
        recipients: [worker.agent_id, reviewer.agent_id],
        kind: "notice",
        body: "Too many targets.",
      }),
    "invalid_input",
  );
  await expectCode(
    () =>
      f.collaboration.agents.send(context, workerCapability, {
        idempotency_key: "self-recipient",
        recipients: [worker.agent_id],
        kind: "notice",
        body: "Self-target.",
      }),
    "invalid_input",
  );
  await expectCode(
    () =>
      f.collaboration.agents.delegate(
        context,
        f.coordinator,
        delegation("outside-peer", { peers: ["not-in-this-room"] }),
      ),
    "forbidden",
  );
  const delegatingParent = await f.collaboration.agents.delegate(
    context,
    f.coordinator,
    delegation("peer-parent", {
      may_delegate: true,
      budget: {
        max_tokens: 100,
        max_duration_ms: 10_000,
        max_steps: 5,
        max_messages: 5,
        delegation_pool_tokens: 50,
      },
    }),
  );
  const delegatingParentCapability = delegatingParent.capability;
  if (!delegatingParentCapability)
    throw new Error("Delegating parent has no capability");
  await expectCode(
    () =>
      f.collaboration.agents.delegate(
        context,
        delegatingParentCapability,
        delegation("peer-outside-subtree", {
          peers: [worker.agent_id],
          budget: {
            max_tokens: 50,
            max_duration_ms: 10_000,
            max_steps: 5,
            max_messages: 5,
          },
        }),
      ),
    "forbidden",
  );
});

test("room and task scopes fence capabilities, results, children, and cursors", async () => {
  const f = await fixture();
  const openedB = await f.collaboration.host.openRoom(context, {
    task: task("task-b"),
    idempotency_key: "open-b",
    delegation_pool: { max_tokens: 800 },
    authority: {
      approvals: { read: true, write: false, execute: false },
      allow_delegation: true,
      paid_consent: false,
    },
  });
  const childB = await f.collaboration.agents.delegate(
    context,
    openedB.coordinator,
    delegation("child-b"),
  );
  const runnerB = createChildRunner({
    collaboration: f.collaboration,
    runnerId: "room-b-runner",
    adapter: {
      async start() {
        return {
          session_ref: "private-room-b",
          base_revision: "base-b",
          outcome: Promise.resolve({
            status: "completed",
            summary: "Room B proposal.",
            artifacts: [],
            usage: { input_tokens: 1, output_tokens: 1, usd: 0, steps: 1 },
          }),
          async cancel() {},
        };
      },
    },
  });
  expect(await runnerB.tick()).toBe(1);
  await runnerB.idle();
  const resultsB = await f.collaboration.agents.results(
    context,
    openedB.coordinator,
  );
  const resultB = resultsB.results[0];
  if (!resultB) throw new Error("Room B proposal was not created");
  await expectCode(
    () =>
      f.collaboration.agents.reviewResult(
        context,
        f.coordinator,
        resultB.result_id,
        {
          decision: "accept",
          expected_task_revision: 0,
          current_base_revision: "base-b",
        },
      ),
    "forbidden",
  );
  await expectCode(
    () =>
      f.collaboration.agents.send(context, f.coordinator, {
        idempotency_key: "cross-room-send",
        recipients: [childB.agent_id],
        kind: "notice",
        body: "Cross-room access.",
      }),
    "forbidden",
  );
  await expectCode(
    () =>
      f.collaboration.agents.cancelChild(
        context,
        f.coordinator,
        childB.agent_id,
      ),
    "forbidden",
  );
  const foreignCursor = Buffer.from(
    JSON.stringify({
      r: openedB.room.room_id,
      a: f.coordinator.agent_id,
      s: 1,
    }),
  ).toString("base64url");
  await expectCode(
    () =>
      f.collaboration.agents.inbox(context, f.coordinator, {
        cursor: foreignCursor,
      }),
    "unknown_cursor",
  );
  await expectCode(
    () =>
      f.collaboration.host.openRoom(context, {
        task: task(),
        idempotency_key: "different-key-same-task",
        delegation_pool: { max_tokens: 800 },
        authority: {
          approvals: { read: true, write: false, execute: false },
          allow_delegation: true,
          paid_consent: false,
        },
      }),
    "conflict",
  );
  await expectCode(
    () =>
      f.collaboration.host.openRoom(context, {
        task: {
          ...task("mismatched-scope"),
          scope: { ...scope, owner_id: "other" },
        },
        idempotency_key: "mismatched-scope",
        authority: {
          approvals: { read: true, write: false, execute: false },
          allow_delegation: true,
          paid_consent: false,
        },
      }),
    "forbidden",
  );
  const otherScope = {
    owner_id: "other-owner",
    project_id: "other-project",
    workspace_id: "other-workspace",
  };
  const otherContext = { ...context, scope: otherScope };
  const otherRoom = await f.collaboration.host.openRoom(otherContext, {
    task: { ...task("task-1"), scope: otherScope },
    idempotency_key: "different-scope",
    authority: {
      approvals: { read: true, write: false, execute: false },
      allow_delegation: false,
      paid_consent: false,
    },
  });
  expect(otherRoom.room.scope).toEqual(otherScope);
});

test("inherited limits reject excess authority, depth, children, and write claims", async () => {
  const f = await fixture();
  const child = await f.collaboration.agents.delegate(
    context,
    f.coordinator,
    delegation("non-delegating-parent"),
  );
  const childCapability = child.capability;
  if (!childCapability) throw new Error("Child capability was not issued");
  await expectCode(
    () =>
      f.collaboration.agents.delegate(
        context,
        childCapability,
        delegation("unauthorized-grandchild", { may_delegate: true }),
      ),
    "forbidden",
  );
  await f.collaboration.agents.cancelChild(
    context,
    f.coordinator,
    child.agent_id,
  );
  await expectCode(
    () =>
      f.collaboration.agents.delegate(
        context,
        f.coordinator,
        delegation("recursive-child", {
          instruction: "Coordinate a bounded implementation.",
        }),
      ),
    "recursive_delegation",
  );
  await expectCode(
    () =>
      f.collaboration.host
        .openRoom(context, {
          task: {
            ...task("no-delegation"),
            budget: { ...task().budget, max_depth: 0 },
          },
          idempotency_key: "no-delegation",
          delegation_pool: { max_tokens: 10 },
          authority: {
            approvals: { read: true, write: false, execute: false },
            allow_delegation: true,
            paid_consent: false,
          },
        })
        .then(({ room, coordinator }) => {
          expect(room.coordinator_runtime_budget.max_tokens).toBe(990);
          return f.collaboration.agents.delegate(
            context,
            coordinator,
            delegation("depth-zero"),
          );
        }),
    "single_agent",
  );
  await expectCode(
    () =>
      f.collaboration.host
        .openRoom(context, {
          task: task("not-allowed"),
          idempotency_key: "not-allowed",
          delegation_pool: { max_tokens: 10 },
          authority: {
            approvals: { read: true, write: false, execute: false },
            allow_delegation: false,
            paid_consent: false,
          },
        })
        .then(({ coordinator }) =>
          f.collaboration.agents.delegate(
            context,
            coordinator,
            delegation("single-agent"),
          ),
        ),
    "single_agent",
  );
  const writesRoom = await f.collaboration.host.openRoom(context, {
    task: task("write-authority"),
    idempotency_key: "write-authority",
    delegation_pool: { max_tokens: 800 },
    authority: {
      approvals: { read: true, write: true, execute: false },
      allow_delegation: true,
      paid_consent: false,
    },
    limits: { max_children_per_agent: 4, max_total_children: 4 },
  });
  const writer = await f.collaboration.agents.delegate(
    context,
    writesRoom.coordinator,
    delegation("writer", {
      approvals: { read: true, write: true, execute: false },
      write_paths: ["src"],
    }),
  );
  await expectCode(
    () =>
      f.collaboration.agents.delegate(
        context,
        writesRoom.coordinator,
        delegation("overlapping-writer", {
          approvals: { read: true, write: true, execute: false },
          write_paths: ["src/feature.ts"],
        }),
      ),
    "write_conflict",
  );
  const childLimitRoom = await f.collaboration.host.openRoom(context, {
    task: task("child-limit"),
    idempotency_key: "child-limit",
    delegation_pool: { max_tokens: 800 },
    authority: {
      approvals: { read: true, write: false, execute: false },
      allow_delegation: true,
      paid_consent: false,
    },
    limits: { max_children_per_agent: 1 },
  });
  const oneChild = await f.collaboration.agents.delegate(
    context,
    childLimitRoom.coordinator,
    delegation("one-child"),
  );
  await f.collaboration.agents.cancelChild(
    context,
    childLimitRoom.coordinator,
    oneChild.agent_id,
  );
  await expectCode(
    () =>
      f.collaboration.agents.delegate(
        context,
        childLimitRoom.coordinator,
        delegation("second-child"),
      ),
    "limit_exceeded",
  );
  const totalLimitRoom = await f.collaboration.host.openRoom(context, {
    task: task("total-limit"),
    idempotency_key: "total-limit",
    delegation_pool: { max_tokens: 800 },
    authority: {
      approvals: { read: true, write: false, execute: false },
      allow_delegation: true,
      paid_consent: false,
    },
    limits: { max_total_children: 1 },
  });
  const firstTotalChild = await f.collaboration.agents.delegate(
    context,
    totalLimitRoom.coordinator,
    delegation("first-total-child"),
  );
  await f.collaboration.agents.cancelChild(
    context,
    totalLimitRoom.coordinator,
    firstTotalChild.agent_id,
  );
  await expectCode(
    () =>
      f.collaboration.agents.delegate(
        context,
        totalLimitRoom.coordinator,
        delegation("second-total-child"),
      ),
    "limit_exceeded",
  );
  const runner = createChildRunner({
    collaboration: f.collaboration,
    runnerId: "write-runner",
    adapter: {
      async start() {
        return {
          session_ref: "private-write-journal",
          base_revision: null,
          outcome: Promise.resolve({
            status: "completed",
            summary: "Finished.",
            artifacts: [],
            usage: { input_tokens: 1, output_tokens: 0, usd: 0, steps: 1 },
          }),
          async cancel() {},
        };
      },
    },
  });
  expect(await runner.tick()).toBe(1);
  await runner.idle();
  const laterWriter = await f.collaboration.agents.delegate(
    context,
    writesRoom.coordinator,
    delegation("later-writer", {
      approvals: { read: true, write: true, execute: false },
      write_paths: ["src/feature.ts"],
    }),
  );
  expect(laterWriter.agent_id).not.toBe(writer.agent_id);
  await expectCode(
    () =>
      f.collaboration.agents.delegate(
        context,
        writesRoom.coordinator,
        delegation("read-only-writer", {
          approvals: { read: true, write: true, execute: false },
          workspace: "read_only",
          write_paths: ["src/other.ts"],
        }),
      ),
    "invalid_input",
  );
  await expectCode(
    () =>
      f.collaboration.agents.delegate(
        context,
        writesRoom.coordinator,
        delegation("usd-without-paid-models", {
          budget: {
            max_tokens: 100,
            max_usd: 1,
            max_duration_ms: 10_000,
            max_steps: 2,
            max_messages: 2,
          },
        }),
      ),
    "forbidden",
  );
  await expectCode(
    () =>
      f.collaboration.agents.delegate(
        context,
        writesRoom.coordinator,
        delegation("paid-models-without-consent", {
          paid_models: true,
          budget: {
            max_tokens: 100,
            max_usd: 1,
            max_duration_ms: 10_000,
            max_steps: 2,
            max_messages: 2,
          },
        }),
      ),
    "forbidden",
  );
});

test("two runners sharing a database claim and start a queued job only once", async () => {
  const f = await fixture();
  const delegated = await f.collaboration.agents.delegate(
    context,
    f.coordinator,
    delegation("shared-runner-job"),
  );
  const replay = await f.collaboration.agents.delegate(
    context,
    f.coordinator,
    delegation("shared-runner-job"),
  );
  expect(replay.agent_id).toBe(delegated.agent_id);
  expect(replay.replayed).toBe(true);
  const second = await createCollaboration({
    rootDir: f.rootDir,
    hostPrivateRoots: [join(f.rootDir, "private")],
    now: () => 1_700_000_000_000,
  });
  cleanup.push(() => second.close());
  let starts = 0;
  const adapter: ChildRuntimeAdapter = {
    async start() {
      starts += 1;
      return {
        session_ref: "private-shared-runner",
        base_revision: null,
        outcome: Promise.resolve({
          status: "completed",
          summary: "Started once.",
          artifacts: [],
          usage: { input_tokens: 1, output_tokens: 0, usd: 0, steps: 1 },
        }),
        async cancel() {},
      };
    },
  };
  const firstRunner = createChildRunner({
    collaboration: f.collaboration,
    adapter,
    runnerId: "shared-runner-1",
  });
  const secondRunner = createChildRunner({
    collaboration: second,
    adapter,
    runnerId: "shared-runner-2",
  });
  await Promise.all([firstRunner.tick(), secondRunner.tick()]);
  await Promise.all([firstRunner.idle(), secondRunner.idle()]);
  expect(starts).toBe(1);
});

test("backpressure is atomic, acknowledgements free backlog, and TTL expires deliveries", async () => {
  const f = await fixture({ limits: { max_inbox_backlog: 1 } });
  const first = await f.collaboration.agents.delegate(
    context,
    f.coordinator,
    delegation("backpressure-first"),
  );
  const second = await f.collaboration.agents.delegate(
    context,
    f.coordinator,
    delegation("backpressure-second"),
  );
  const firstCapability = first.capability;
  const secondCapability = second.capability;
  if (!firstCapability || !secondCapability)
    throw new Error("Backpressure children did not receive capabilities");
  const initial = await f.collaboration.agents.send(context, f.coordinator, {
    idempotency_key: "backpressure-initial",
    recipients: [first.agent_id],
    kind: "request",
    body: "First delivery.",
  });
  await expectCode(
    () =>
      f.collaboration.agents.send(context, f.coordinator, {
        idempotency_key: "backpressure-atomic",
        recipients: [first.agent_id, second.agent_id],
        kind: "request",
        body: "This multi-recipient message must be atomic.",
      }),
    "backpressure",
  );
  expect(
    (await f.collaboration.agents.inbox(context, secondCapability)).messages,
  ).toHaveLength(0);
  await f.collaboration.agents.inbox(context, firstCapability);
  await f.collaboration.agents.ack(context, firstCapability, [
    initial.message_id,
  ]);
  const multi = await f.collaboration.agents.send(context, f.coordinator, {
    idempotency_key: "backpressure-atomic",
    recipients: [first.agent_id, second.agent_id],
    kind: "request",
    body: "This multi-recipient message must be atomic.",
  });
  expect(
    (await f.collaboration.agents.inbox(context, firstCapability)).messages,
  ).toHaveLength(1);
  expect(
    (await f.collaboration.agents.inbox(context, secondCapability)).messages,
  ).toHaveLength(1);
  await f.collaboration.agents.ack(context, firstCapability, [
    multi.message_id,
  ]);
  await f.collaboration.agents.ack(context, secondCapability, [
    multi.message_id,
  ]);
  const expiring = await f.collaboration.agents.send(context, f.coordinator, {
    idempotency_key: "expiring-message",
    recipients: [second.agent_id],
    kind: "request",
    body: "This delivery expires.",
    ttl_ms: 100,
  });
  f.advance(101);
  expect(
    (await f.collaboration.agents.inbox(context, secondCapability)).messages,
  ).toHaveLength(0);
  expect(
    (await f.collaboration.host.stats(context, f.room.room_id)).expired,
  ).toBe(1);
  await expectCode(
    () =>
      f.collaboration.agents.send(context, f.coordinator, {
        idempotency_key: "expiring-message",
        recipients: [second.agent_id],
        kind: "request",
        body: "Changed content.",
        ttl_ms: 100,
      }),
    "conflict",
  );
  expect(expiring.message_id).toBeTruthy();
});

test("inbox pagination preserves sequence order and rejects tampered cursors", async () => {
  const f = await fixture();
  const child = await f.collaboration.agents.delegate(
    context,
    f.coordinator,
    delegation("pagination-child"),
  );
  const capability = child.capability;
  if (!capability) throw new Error("Pagination child has no capability");
  for (let index = 0; index < 5; index += 1) {
    await f.collaboration.agents.send(context, f.coordinator, {
      idempotency_key: `page-${index}`,
      recipients: [child.agent_id],
      kind: "request",
      body: `Message ${index + 1}`,
    });
  }
  const firstPage = await f.collaboration.agents.inbox(context, capability, {
    limit: 2,
  });
  const firstSeq = firstPage.messages[0]?.seq;
  if (firstSeq === undefined)
    throw new Error("The first pagination page is empty");
  expect(firstPage.messages.map(({ seq }) => seq)).toEqual([
    firstSeq,
    firstSeq + 1,
  ]);
  if (!firstPage.next_cursor)
    throw new Error("Pagination cursor was not issued");
  await expectCode(
    () =>
      f.collaboration.agents.inbox(context, capability, {
        cursor: "tampered-cursor",
        limit: 2,
      }),
    "unknown_cursor",
  );
  const secondPage = await f.collaboration.agents.inbox(context, capability, {
    cursor: firstPage.next_cursor,
    limit: 2,
  });
  const thirdPage = await f.collaboration.agents.inbox(context, capability, {
    cursor: secondPage.next_cursor,
    limit: 2,
  });
  expect(
    [...firstPage.messages, ...secondPage.messages, ...thirdPage.messages].map(
      ({ seq }) => seq,
    ),
  ).toEqual([firstSeq, firstSeq + 1, firstSeq + 2, firstSeq + 3, firstSeq + 4]);
  expect(thirdPage.next_cursor).toBeNull();
});

test("reply-hop and sender-recipient pair caps reject message loops", async () => {
  const hopFixture = await fixture({ limits: { max_reply_hops: 2 } });
  const hopChild = await hopFixture.collaboration.agents.delegate(
    context,
    hopFixture.coordinator,
    delegation("hop-child"),
  );
  const hopCapability = hopChild.capability;
  if (!hopCapability) throw new Error("Hop child has no capability");
  const rootRequest = await hopFixture.collaboration.agents.send(
    context,
    hopFixture.coordinator,
    {
      idempotency_key: "hop-request",
      recipients: [hopChild.agent_id],
      kind: "request",
      body: "Start the reply chain.",
    },
  );
  await hopFixture.collaboration.agents.inbox(context, hopCapability);
  const childReply = await hopFixture.collaboration.agents.send(
    context,
    hopCapability,
    {
      idempotency_key: "hop-reply-1",
      recipients: [hopFixture.coordinator.agent_id],
      kind: "reply",
      in_reply_to: rootRequest.message_id,
      body: "First reply.",
    },
  );
  await hopFixture.collaboration.agents.inbox(context, hopFixture.coordinator);
  const rootReply = await hopFixture.collaboration.agents.send(
    context,
    hopFixture.coordinator,
    {
      idempotency_key: "hop-reply-2",
      recipients: [hopChild.agent_id],
      kind: "reply",
      in_reply_to: childReply.message_id,
      body: "Second reply.",
    },
  );
  await hopFixture.collaboration.agents.inbox(context, hopCapability);
  await expectCode(
    () =>
      hopFixture.collaboration.agents.send(context, hopCapability, {
        idempotency_key: "hop-reply-3",
        recipients: [hopFixture.coordinator.agent_id],
        kind: "reply",
        in_reply_to: rootReply.message_id,
        body: "This exceeds the reply-hop cap.",
      }),
    "loop_limit",
  );

  const pairFixture = await fixture({ limits: { max_pair_messages: 2 } });
  const pairChild = await pairFixture.collaboration.agents.delegate(
    context,
    pairFixture.coordinator,
    delegation("pair-child"),
  );
  const pairCapability = pairChild.capability;
  if (!pairCapability) throw new Error("Pair child has no capability");
  const pairRequest = await pairFixture.collaboration.agents.send(
    context,
    pairFixture.coordinator,
    {
      idempotency_key: "pair-request",
      recipients: [pairChild.agent_id],
      kind: "request",
      body: "Start the pair chain.",
    },
  );
  await pairFixture.collaboration.agents.inbox(context, pairCapability);
  const pairReply = await pairFixture.collaboration.agents.send(
    context,
    pairCapability,
    {
      idempotency_key: "pair-reply",
      recipients: [pairFixture.coordinator.agent_id],
      kind: "reply",
      in_reply_to: pairRequest.message_id,
      body: "The second pair delivery.",
    },
  );
  await pairFixture.collaboration.agents.send(
    context,
    pairFixture.coordinator,
    {
      idempotency_key: "pair-root-reply",
      recipients: [pairChild.agent_id],
      kind: "reply",
      in_reply_to: pairReply.message_id,
      body: "The second delivery from the coordinator.",
    },
  );
  await pairFixture.collaboration.agents.inbox(
    context,
    pairFixture.coordinator,
  );
  await expectCode(
    () =>
      pairFixture.collaboration.agents.send(context, pairFixture.coordinator, {
        idempotency_key: "pair-overflow",
        recipients: [pairChild.agent_id],
        kind: "reply",
        in_reply_to: pairReply.message_id,
        body: "This exceeds the pair cap.",
      }),
    "loop_limit",
  );
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

test("pre-run forbidden and invalid-input failures charge zero usage", async () => {
  for (const code of ["forbidden", "invalid_input"] as const) {
    const f = await fixture();
    await f.collaboration.agents.delegate(
      context,
      f.coordinator,
      delegation(`zero-usage-${code}`),
    );
    const runner = createChildRunner({
      collaboration: f.collaboration,
      runnerId: `zero-usage-${code}`,
      adapter: {
        async start() {
          throw new CollaborationError(code, "Pre-run failure.");
        },
      },
    });
    expect(await runner.tick()).toBe(1);
    await runner.idle();
    const stats = await f.collaboration.host.stats(context, f.room.room_id);
    expect(stats.tokens).toEqual({ input: 0, output: 0 });
    expect(stats.usd).toBe(0);
    expect(stats.reserved).toEqual({ tokens: 0, usd: 0 });
  }
});

test("runtime caps stop exhausted starts and finalize token or step overruns", async () => {
  const f = await fixture({ leaseMs: 300 });
  await f.collaboration.agents.delegate(
    context,
    f.coordinator,
    delegation("exhausted-runtime", {
      may_delegate: true,
      budget: {
        max_tokens: 100,
        max_duration_ms: 10_000,
        max_steps: 2,
        max_messages: 5,
        delegation_pool_tokens: 20,
      },
    }),
  );
  const claim = await f.collaboration.host.jobs.claim("exhausted-old-runner");
  if (!claim) throw new Error("Exhausted job was not claimed");
  await f.collaboration.host.jobs.heartbeat(
    claim.job_id,
    "exhausted-old-runner",
    claim.lease_epoch,
    {
      steps: 1,
      usage: { input_tokens: 80, output_tokens: 0, usd: 0, steps: 1 },
      session_ref: "private-exhausted-session",
    },
  );
  f.advance(301);
  let starts = 0;
  const exhaustedRunner = createChildRunner({
    collaboration: f.collaboration,
    runnerId: "exhausted-new-runner",
    adapter: {
      async reconcile() {
        return { input_tokens: 80, output_tokens: 0, usd: 0, steps: 1 };
      },
      async start() {
        starts += 1;
        throw new Error("An exhausted runtime must not start.");
      },
    },
  });
  expect(await exhaustedRunner.recover()).toEqual({
    examined: 1,
    requeued: 1,
    failed_closed: 0,
  });
  expect(await exhaustedRunner.tick()).toBe(1);
  await exhaustedRunner.idle();
  expect(starts).toBe(0);
  const exhaustedStats = await f.collaboration.host.stats(
    context,
    f.room.room_id,
  );
  expect(exhaustedStats.tokens).toEqual({ input: 80, output: 0 });
  expect(exhaustedStats.reserved).toEqual({ tokens: 0, usd: 0 });

  const overrunFixture = await fixture();
  for (const [role, budget] of [
    [
      "token-overrun",
      {
        max_tokens: 100,
        max_duration_ms: 10_000,
        max_steps: 5,
        max_messages: 5,
        delegation_pool_tokens: 20,
      },
    ],
    [
      "step-overrun",
      {
        max_tokens: 100,
        max_duration_ms: 10_000,
        max_steps: 1,
        max_messages: 5,
      },
    ],
  ] as const) {
    await overrunFixture.collaboration.agents.delegate(
      context,
      overrunFixture.coordinator,
      delegation(role, {
        role_label: role,
        may_delegate: role === "token-overrun",
        budget,
      }),
    );
  }
  const overrunRunner = createChildRunner({
    collaboration: overrunFixture.collaboration,
    runnerId: "overrun-runner",
    adapter: {
      async start(launch) {
        return {
          session_ref: `private-overrun-${launch.role_label}`,
          base_revision: null,
          outcome: Promise.resolve({
            status: "completed",
            summary: "Reported usage.",
            artifacts: [],
            usage:
              launch.role_label === "token-overrun"
                ? {
                    input_tokens: 81,
                    output_tokens: 0,
                    usd: 0,
                    steps: 1,
                  }
                : {
                    input_tokens: 1,
                    output_tokens: 0,
                    usd: 0,
                    steps: 2,
                  },
          }),
          async cancel() {},
        };
      },
    },
  });
  expect(await overrunRunner.tick()).toBe(2);
  await overrunRunner.idle();
  const overrunStats = await overrunFixture.collaboration.host.stats(
    context,
    overrunFixture.room.room_id,
  );
  expect(overrunStats.over_budget).toBe(2);
  expect(overrunStats.children_failed).toBe(2);
});

test("public views, delegated results, and errors omit state paths and journal references", async () => {
  const f = await fixture();
  const delegated = await f.collaboration.agents.delegate(
    context,
    f.coordinator,
    delegation("privacy-child"),
  );
  const capability = delegated.capability;
  if (!capability) throw new Error("Privacy child has no capability");
  const message = await f.collaboration.agents.send(context, f.coordinator, {
    idempotency_key: "privacy-message",
    recipients: [delegated.agent_id],
    kind: "request",
    body: "Return a safe proposal.",
  });
  const inbox = await f.collaboration.agents.inbox(context, capability);
  const sessionRef = join(f.rootDir, "private", "journal.jsonl");
  const runner = createChildRunner({
    collaboration: f.collaboration,
    runnerId: "privacy-runner",
    adapter: {
      async start() {
        return {
          session_ref: sessionRef,
          base_revision: "privacy-base",
          outcome: Promise.resolve({
            status: "completed",
            summary: "A safe proposal.",
            artifacts: [],
            usage: { input_tokens: 1, output_tokens: 1, usd: 0, steps: 1 },
          }),
          async cancel() {},
        };
      },
    },
  });
  expect(await runner.tick()).toBe(1);
  await runner.idle();
  const views = {
    room: await f.collaboration.host.inspectRoom(context, f.room.room_id),
    stats: await f.collaboration.host.stats(context, f.room.room_id),
    members: await f.collaboration.agents.members(context, f.coordinator),
    children: await f.collaboration.agents.children(context, f.coordinator),
    inbox,
    results: await f.collaboration.agents.results(context, f.coordinator),
  };
  let errorMessage = "";
  try {
    await f.collaboration.agents.send(context, capability, {
      idempotency_key: "privacy-error",
      recipients: [f.coordinator.agent_id],
      kind: "reply",
      in_reply_to: "not-delivered",
      body: "This request is forbidden.",
    });
  } catch (error) {
    if (error instanceof Error) errorMessage = error.message;
  }
  const serialized = JSON.stringify({
    views,
    delegated,
    message,
    errorMessage,
  });
  expect(serialized).not.toContain(f.rootDir);
  expect(serialized).not.toContain(join(f.rootDir, "private"));
  expect(serialized).not.toContain(sessionRef);
  expect(serialized).not.toContain("session_ref");
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

test("running cancellation cascades, discards late outcomes, and charges usage", async () => {
  const f = await fixture();
  const parent = await f.collaboration.agents.delegate(
    context,
    f.coordinator,
    delegation("cascade-parent", {
      may_delegate: true,
      budget: {
        max_tokens: 50,
        max_duration_ms: 10_000,
        max_steps: 5,
        max_messages: 5,
        delegation_pool_tokens: 20,
      },
    }),
  );
  const parentCapability = parent.capability;
  if (!parentCapability) throw new Error("Parent capability was not issued");
  const grandchild = await f.collaboration.agents.delegate(
    context,
    parentCapability,
    delegation("cascade-grandchild", {
      budget: {
        max_tokens: 20,
        max_duration_ms: 10_000,
        max_steps: 5,
        max_messages: 5,
      },
    }),
  );
  const sibling = await f.collaboration.agents.delegate(
    context,
    f.coordinator,
    delegation("cascade-sibling"),
  );
  const siblingCapability = sibling.capability;
  if (!siblingCapability) throw new Error("Sibling capability was not issued");
  const running: {
    role: string;
    finish: (outcome: ChildOutcome) => void;
  }[] = [];
  const runner = createChildRunner({
    collaboration: f.collaboration,
    runnerId: "cascade-runner",
    adapter: {
      async start(launch) {
        let finish!: (outcome: ChildOutcome) => void;
        const outcome = new Promise<ChildOutcome>((resolve) => {
          finish = resolve;
        });
        running.push({ role: launch.role_label, finish });
        return {
          session_ref: `private-${launch.role_label}`,
          base_revision: null,
          outcome,
          async cancel() {},
        };
      },
    },
  });
  expect(await runner.tick()).toBe(2);
  await expectCode(
    () =>
      f.collaboration.agents.cancelChild(
        context,
        siblingCapability,
        parent.agent_id,
      ),
    "forbidden",
  );
  await f.collaboration.agents.cancelChild(
    context,
    f.coordinator,
    parent.agent_id,
  );
  await expectCode(
    () =>
      f.collaboration.agents.send(context, f.coordinator, {
        idempotency_key: "cancelled-recipient",
        recipients: [parent.agent_id],
        kind: "notice",
        body: "A cancelled member cannot receive new messages.",
      }),
    "forbidden",
  );
  const parentRunAlt = running[0];
  const grandchildRunAlt = running[1];
  if (!parentRunAlt || !grandchildRunAlt)
    throw new Error("Both subtree jobs did not start");
  parentRunAlt.finish({
    status: "completed",
    summary: "Late parent result.",
    artifacts: [],
    usage: { input_tokens: 3, output_tokens: 0, usd: 0, steps: 1 },
  });
  grandchildRunAlt.finish({
    status: "completed",
    summary: "Late grandchild result.",
    artifacts: [],
    usage: { input_tokens: 2, output_tokens: 0, usd: 0, steps: 1 },
  });
  await runner.idle();
  const members = await f.collaboration.agents.members(context, f.coordinator);
  expect(
    members.members
      .filter(({ agent_id }) =>
        [parent.agent_id, grandchild.agent_id].includes(agent_id),
      )
      .map(({ status }) => status),
  ).toEqual(["cancelled", "cancelled"]);
  const stats = await f.collaboration.host.stats(context, f.room.room_id);
  expect(stats.discarded_results).toBe(2);
  expect(stats.tokens).toEqual({ input: 5, output: 0 });
  expect(stats.tokens.input + stats.reserved.tokens).toBeLessThanOrEqual(800);
});

test("drain admits existing queued work and cancel mode stops descendants", async () => {
  const f = await fixture();
  for (let index = 0; index < 3; index += 1) {
    await f.collaboration.agents.delegate(
      context,
      f.coordinator,
      delegation(`drain-child-${index}`),
    );
  }
  const releases: (() => void)[] = [];
  const runner = createChildRunner({
    collaboration: f.collaboration,
    runnerId: "drain-runner",
    adapter: {
      async start() {
        let finish!: () => void;
        const outcome = new Promise<ChildOutcome>((resolve) => {
          finish = () =>
            resolve({
              status: "completed",
              summary: "Drained work completed.",
              artifacts: [],
              usage: { input_tokens: 1, output_tokens: 0, usd: 0, steps: 1 },
            });
        });
        releases.push(finish);
        return {
          session_ref: "private-drain-session",
          base_revision: null,
          outcome,
          async cancel() {},
        };
      },
    },
  });
  expect(await runner.tick()).toBe(2);
  expect(
    (await f.collaboration.host.closeRoom(context, f.room.room_id, "drain"))
      .status,
  ).toBe("draining");
  await expectCode(
    () =>
      f.collaboration.agents.delegate(
        context,
        f.coordinator,
        delegation("after-drain"),
      ),
    "closed",
  );
  await expectCode(
    () =>
      f.collaboration.agents.send(context, f.coordinator, {
        idempotency_key: "after-drain",
        recipients: [],
        kind: "notice",
        body: "No new messages.",
      }),
    "closed",
  );
  const first = releases[0];
  const second = releases[1];
  if (!first || !second) throw new Error("Running drain jobs were not started");
  first();
  second();
  await runner.idle();
  expect(
    (await f.collaboration.host.inspectRoom(context, f.room.room_id)).status,
  ).toBe("draining");
  expect(await runner.tick()).toBe(1);
  const third = releases[2];
  if (!third) throw new Error("Queued drain job did not start");
  third();
  await runner.idle();
  expect(
    (await f.collaboration.host.inspectRoom(context, f.room.room_id)).status,
  ).toBe("closed");

  const cancelledFixture = await fixture();
  const child = await cancelledFixture.collaboration.agents.delegate(
    context,
    cancelledFixture.coordinator,
    delegation("close-cancel-child"),
  );
  await cancelledFixture.collaboration.host.closeRoom(
    context,
    cancelledFixture.room.room_id,
    "cancel",
  );
  expect(
    (
      await cancelledFixture.collaboration.host.inspectRoom(
        context,
        cancelledFixture.room.room_id,
      )
    ).status,
  ).toBe("closed");
  expect(
    (
      await cancelledFixture.collaboration.host.stats(
        context,
        cancelledFixture.room.room_id,
      )
    ).reserved,
  ).toEqual({ tokens: 0, usd: 0 });
  expect(child.agent_id).toBeTruthy();
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

test("fresh processes preserve envelopes, results, sequence, and claimable jobs", async () => {
  const f = await fixture();
  const completed = await f.collaboration.agents.delegate(
    context,
    f.coordinator,
    delegation("persist-completed"),
  );
  const completedRunner = createChildRunner({
    collaboration: f.collaboration,
    runnerId: "persist-completed-runner",
    adapter: {
      async start() {
        return {
          session_ref: "private-persisted-session",
          base_revision: "persisted-base",
          outcome: Promise.resolve({
            status: "completed",
            summary: "Persisted proposal.",
            artifacts: [],
            usage: { input_tokens: 2, output_tokens: 1, usd: 0, steps: 1 },
          }),
          async cancel() {},
        };
      },
    },
  });
  expect(await completedRunner.tick()).toBe(1);
  await completedRunner.idle();
  const pending = await f.collaboration.agents.delegate(
    context,
    f.coordinator,
    delegation("persist-pending"),
  );
  const oldCapability = pending.capability;
  if (!oldCapability) throw new Error("Pending child has no capability");
  const firstMessage = await f.collaboration.agents.send(
    context,
    f.coordinator,
    {
      idempotency_key: "persist-message-one",
      recipients: [pending.agent_id],
      kind: "request",
      body: "Persist this coordination envelope.",
    },
  );
  const secondMessage = await f.collaboration.agents.send(
    context,
    f.coordinator,
    {
      idempotency_key: "persist-message-two",
      recipients: [pending.agent_id],
      kind: "notice",
      body: "Persist a second sequence.",
    },
  );
  expect(firstMessage.seq).toBeGreaterThan(0);
  expect(secondMessage.seq).toBeGreaterThan(firstMessage.seq);
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
    pending.agent_id,
  );
  await expectCode(
    () => reopened.agents.inbox(context, oldCapability),
    "forbidden",
  );
  const inbox = await reopened.agents.inbox(context, rotated);
  expect(inbox.messages.map((message) => message.body)).toEqual([
    "Persist this coordination envelope.",
    "Persist a second sequence.",
  ]);
  expect(inbox.messages.map((message) => message.seq)).toEqual([
    firstMessage.seq,
    secondMessage.seq,
  ]);
  const next = await reopened.agents.send(context, f.coordinator, {
    idempotency_key: "persist-message-three",
    recipients: [pending.agent_id],
    kind: "notice",
    body: "The next sequence survives a process restart.",
  });
  expect(next.seq).toBeGreaterThan(
    Math.max(...inbox.messages.map(({ seq }) => seq)),
  );
  expect(
    (await reopened.agents.members(context, f.coordinator)).members.map(
      ({ agent_id }) => agent_id,
    ),
  ).toContain(completed.agent_id);
  const persistedResults = await reopened.agents.results(
    context,
    f.coordinator,
  );
  expect(
    persistedResults.results.some(
      ({ child_agent_id, summary }) =>
        child_agent_id === completed.agent_id &&
        summary === "Persisted proposal.",
    ),
  ).toBe(true);
  expect(
    (await reopened.host.stats(context, f.room.room_id)).children_completed,
  ).toBe(1);
  let starts = 0;
  const pendingRunner = createChildRunner({
    collaboration: reopened,
    runnerId: "persist-reopened-runner",
    adapter: {
      async start() {
        starts += 1;
        return {
          session_ref: "private-pending-session",
          base_revision: null,
          outcome: Promise.resolve({
            status: "completed",
            summary: "Recovered queued proposal.",
            artifacts: [],
            usage: { input_tokens: 1, output_tokens: 0, usd: 0, steps: 1 },
          }),
          async cancel() {},
        };
      },
    },
  });
  expect(await pendingRunner.tick()).toBe(1);
  await pendingRunner.idle();
  expect(starts).toBe(1);
});
