import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RequestContext, Task } from "@mars/contracts";
import {
  type ChildOutcome,
  createChildRunner,
  createCollaboration,
} from "./index";

const scope = {
  owner_id: "coordination-demo",
  project_id: "demo",
  workspace_id: "demo-workspace",
};
const context: RequestContext = {
  schema_version: 1,
  scope,
  request_id: "coordination-demo",
};
const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

test("deterministic coordination demo (not a quality measurement)", async () => {
  const outputSpies = [
    spyOn(console, "log").mockImplementation(() => {}),
    spyOn(console, "info").mockImplementation(() => {}),
    spyOn(console, "warn").mockImplementation(() => {}),
    spyOn(console, "error").mockImplementation(() => {}),
  ];
  cleanup.push(async () => {
    for (const outputSpy of outputSpies) outputSpy.mockRestore();
  });
  const rootDir = await mkdtemp(join(tmpdir(), "mars-collaboration-demo-"));
  cleanup.push(() => rm(rootDir, { recursive: true, force: true }));
  const collaboration = await createCollaboration({
    rootDir,
    hostPrivateRoots: [join(rootDir, "private")],
  });
  cleanup.push(() => collaboration.close());
  const task: Task = {
    schema_version: 1,
    task_id: "coordination-demo-task",
    session_id: "coordination-demo-session",
    scope,
    revision: 0,
    request: "Implement a small feature and review its coordination.",
    acceptance_criteria: ["Return concise result proposals."],
    budget: {
      max_tokens: 1000,
      max_usd: 0,
      max_duration_ms: 60_000,
      max_depth: 1,
      max_concurrency: 3,
    },
    status: "pending",
    specialist_revision: null,
    artifacts: [],
  };
  const { room, coordinator } = await collaboration.host.openRoom(context, {
    task,
    idempotency_key: "demo-open",
    delegation_pool: { max_tokens: 600 },
    authority: {
      approvals: { read: true, write: true, execute: false },
      allow_delegation: true,
      paid_consent: false,
    },
  });
  const worker = await collaboration.agents.delegate(context, coordinator, {
    idempotency_key: "demo-worker",
    role_label: "worker",
    instruction: "Implement src/feature.ts.",
    approvals: { read: true, write: true, execute: false },
    write_paths: ["src/feature.ts"],
    budget: {
      max_tokens: 100,
      max_duration_ms: 30_000,
      max_steps: 10,
      max_messages: 10,
    },
  });
  const reviewer = await collaboration.agents.delegate(context, coordinator, {
    idempotency_key: "demo-reviewer",
    role_label: "reviewer",
    instruction: "Review the worker's proposal.",
    approvals: { read: true, write: false, execute: false },
    workspace: "read_only",
    peers: [worker.agent_id],
    budget: {
      max_tokens: 100,
      max_duration_ms: 30_000,
      max_steps: 10,
      max_messages: 10,
    },
  });
  const workerCapability = worker.capability;
  const reviewerCapability = reviewer.capability;
  if (!workerCapability || !reviewerCapability)
    throw new Error("Demo members did not receive capabilities");

  const running: {
    role: string;
    finish: (outcome: ChildOutcome) => void;
  }[] = [];
  const runner = createChildRunner({
    collaboration,
    runnerId: "demo-runner",
    adapter: {
      async start(launch) {
        let finish!: (outcome: ChildOutcome) => void;
        const outcome = new Promise<ChildOutcome>((resolve) => {
          finish = resolve;
        });
        running.push({ role: launch.role_label, finish });
        return {
          session_ref: `private-${launch.role_label}`,
          base_revision: "demo-base",
          outcome,
          async cancel() {},
        };
      },
    },
  });
  expect(await runner.tick()).toBe(2);
  expect(running.map(({ role }) => role)).toEqual(["worker", "reviewer"]);

  const question = await collaboration.agents.send(
    context,
    reviewerCapability,
    {
      idempotency_key: "demo-question",
      recipients: [worker.agent_id],
      kind: "request",
      body: "Which behavior does the feature cover?",
    },
  );
  const workerInbox = await collaboration.agents.inbox(
    context,
    workerCapability,
  );
  expect(workerInbox.messages.map(({ body }) => body)).toEqual([
    "Which behavior does the feature cover?",
  ]);
  const answer = await collaboration.agents.send(context, workerCapability, {
    idempotency_key: "demo-answer",
    recipients: [reviewer.agent_id],
    kind: "reply",
    in_reply_to: question.message_id,
    body: "It handles the requested feature path.",
  });
  const reviewerInbox = await collaboration.agents.inbox(
    context,
    reviewerCapability,
  );
  expect(reviewerInbox.messages.map(({ body }) => body)).toEqual([
    "It handles the requested feature path.",
  ]);
  await collaboration.agents.ack(context, reviewerCapability, [
    answer.message_id,
  ]);
  await collaboration.agents.ack(context, workerCapability, [
    question.message_id,
  ]);

  const workerRun = running.find(({ role }) => role === "worker");
  const reviewerRun = running.find(({ role }) => role === "reviewer");
  if (!workerRun || !reviewerRun)
    throw new Error("Both demo runs were not started");
  workerRun.finish({
    status: "completed",
    summary: "Implemented the feature.",
    artifacts: [],
    usage: { input_tokens: 10, output_tokens: 10, usd: 0, steps: 1 },
  });
  reviewerRun.finish({
    status: "completed",
    summary: "Reviewed the proposed feature.",
    artifacts: [],
    usage: { input_tokens: 8, output_tokens: 4, usd: 0, steps: 1 },
  });
  await runner.idle();

  const results = await collaboration.agents.results(context, coordinator);
  for (const child of [worker, reviewer]) {
    const proposal = results.results.find(
      ({ child_agent_id }) => child_agent_id === child.agent_id,
    );
    if (!proposal) throw new Error("Demo child did not produce a proposal");
    await collaboration.agents.reviewResult(
      context,
      coordinator,
      proposal.result_id,
      {
        decision: "accept",
        expected_task_revision: room.task_revision,
        current_base_revision: "demo-base",
      },
    );
  }

  const stats = await collaboration.host.stats(context, room.room_id);
  expect(stats).toEqual({
    messages_sent: 2,
    deliveries: 2,
    redeliveries: 0,
    acked: 2,
    expired: 0,
    rejected_backpressure: 0,
    rejected_loop: 0,
    rejected_forbidden: 0,
    replayed_sends: 0,
    delegations: 2,
    replayed_delegations: 0,
    children_completed: 2,
    children_failed: 0,
    children_cancelled: 0,
    children_expired: 0,
    discarded_results: 0,
    usage_unaccounted: 0,
    over_budget: 0,
    results_accepted: 2,
    results_rejected: 0,
    results_stale: 0,
    tokens: { input: 18, output: 14 },
    usd: 0,
    steps: 2,
    reserved: { tokens: 0, usd: 0 },
  });
  const messages = [
    {
      seq: question.seq,
      sender: "reviewer",
      recipient: "worker",
      kind: question.kind,
    },
    {
      seq: answer.seq,
      sender: "worker",
      recipient: "reviewer",
      kind: answer.kind,
    },
  ].map(({ seq, sender, recipient, kind }) => [seq, sender, recipient, kind]);
  expect(messages).toEqual([
    [3, "reviewer", "worker", "request"],
    [4, "worker", "reviewer", "reply"],
  ]);
  const members = await collaboration.agents.members(context, coordinator);
  const usage = Object.fromEntries(
    members.members.map(({ role_label, usage: memberUsage }) => [
      role_label,
      {
        input_tokens: memberUsage.input_tokens,
        output_tokens: memberUsage.output_tokens,
        steps: memberUsage.steps,
      },
    ]),
  );
  expect(usage).toEqual({
    worker: { input_tokens: 10, output_tokens: 10, steps: 1 },
    reviewer: { input_tokens: 8, output_tokens: 4, steps: 1 },
  });
  for (const outputSpy of outputSpies) expect(outputSpy).not.toHaveBeenCalled();
});
