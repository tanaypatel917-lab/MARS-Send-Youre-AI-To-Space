import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ArtifactRef,
  RequestContext,
  ResearchFinding,
  ResearchRequest,
  Task,
} from "@mars/contracts";
import { createTaskStore } from "@mars/tasks";
import {
  createResearchService,
  type DurableResearchService,
  type FindingProposal,
  RESEARCH_STORE_FORMAT_VERSION,
  type ResearchWorker,
  type ResearchWorkerContext,
  RetryableResearchError,
} from "./index";
import { canonicalRecord, sha256 } from "./store";

const roots: string[] = [];
const services: DurableResearchService[] = [];
const taskStores: Array<Awaited<ReturnType<typeof createTaskStore>>> = [];
const children: Array<ReturnType<typeof Bun.spawn>> = [];

const scope = {
  owner_id: "owner-1",
  project_id: "project-1",
  workspace_id: "workspace-1",
};

const context = (
  requestId = "request-1",
  taskScope: RequestContext["scope"] = scope,
): RequestContext => ({
  schema_version: 1,
  scope: taskScope,
  request_id: requestId,
});

const makeTask = (
  taskId = "task-1",
  taskScope: RequestContext["scope"] = scope,
): Task => ({
  schema_version: 1,
  task_id: taskId,
  session_id: "session-1",
  scope: taskScope,
  revision: 0,
  request: "Research task",
  acceptance_criteria: ["Evidence is reviewed"],
  budget: {
    max_tokens: 10_000,
    max_usd: 100,
    max_duration_ms: 60_000,
    max_depth: 4,
    max_concurrency: 4,
  },
  status: "pending",
  specialist_revision: null,
  artifacts: [],
});

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "mars-research-test-"));
  roots.push(root);
  return root;
}

function createV1ResearchDatabase(rootDir: string): Database {
  mkdirSync(rootDir, { recursive: true, mode: 0o700 });
  const db = new Database(path.join(rootDir, "research.sqlite"), {
    create: true,
    strict: true,
  });
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE requests (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_key TEXT NOT NULL,
      request_id TEXT NOT NULL,
      scope_json TEXT NOT NULL,
      idem_request_id TEXT NOT NULL,
      input_sha256 TEXT NOT NULL,
      record_json TEXT NOT NULL,
      record_sha256 TEXT NOT NULL,
      task_id TEXT NOT NULL,
      task_revision INTEGER NOT NULL,
      status TEXT NOT NULL,
      stale INTEGER NOT NULL,
      cancel_requested INTEGER NOT NULL,
      attempts INTEGER NOT NULL,
      max_attempts INTEGER NOT NULL,
      submitted_at TEXT NOT NULL,
      requested_deadline TEXT NOT NULL,
      deadline TEXT NOT NULL,
      available_at INTEGER NOT NULL,
      lease_owner TEXT,
      lease_token TEXT,
      lease_expires_at INTEGER,
      usage_json TEXT NOT NULL,
      error_code TEXT,
      worker_json TEXT,
      finished_at TEXT,
      stale_event_state TEXT NOT NULL,
      UNIQUE(scope_key, request_id),
      UNIQUE(scope_key, idem_request_id)
    );
    CREATE INDEX requests_claimable ON requests(status, available_at, seq);
    CREATE INDEX requests_scope_active ON requests(scope_key, status);
    CREATE TABLE findings (
      scope_key TEXT NOT NULL,
      request_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      finding_id TEXT NOT NULL,
      finding_key TEXT NOT NULL,
      record_json TEXT NOT NULL,
      record_sha256 TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      event_state TEXT NOT NULL,
      PRIMARY KEY(scope_key, request_id, seq),
      UNIQUE(scope_key, finding_id),
      UNIQUE(scope_key, request_id, finding_key),
      FOREIGN KEY(scope_key, request_id) REFERENCES requests(scope_key, request_id)
    );
    CREATE TABLE evidence (
      scope_key TEXT NOT NULL,
      request_id TEXT NOT NULL,
      artifact_id TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      media_type TEXT NOT NULL,
      byte_length INTEGER NOT NULL,
      url TEXT NOT NULL,
      retrieved_at TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      PRIMARY KEY(scope_key, request_id, artifact_id, url, retrieved_at),
      FOREIGN KEY(scope_key, request_id) REFERENCES requests(scope_key, request_id)
    );
  `);
  db.query(
    "INSERT INTO meta (key, value) VALUES ('format_version', '1')",
  ).run();
  return db;
}

function makeRequest(
  now: () => number,
  taskId = "task-1",
  overrides: Partial<ResearchRequest> = {},
): ResearchRequest {
  return {
    question: "Find relevant evidence",
    task_id: taskId,
    task_revision: 0,
    known_context: [],
    source_requirements: [],
    deadline: new Date(now() + 30_000).toISOString(),
    budget: {
      max_tokens: 1000,
      max_usd: 10,
      max_duration_ms: 20_000,
      max_depth: 2,
      max_concurrency: 2,
    },
    ...overrides,
  };
}

function proposal(
  evidence: ArtifactRef,
  url: string,
  retrievedAt: string,
  findingKey = "finding-1",
  claim = "Captured evidence supports this claim.",
): FindingProposal {
  return {
    finding_key: findingKey,
    claim,
    recommendation: "Review the evidence before acting.",
    confidence: "medium",
    remaining_uncertainty: [],
    sources: [{ url, retrieved_at: retrievedAt, evidence }],
  };
}

async function capture(
  workerContext: ResearchWorkerContext,
  now: () => number,
  suffix = "source-1",
): Promise<{ ref: ArtifactRef; url: string; retrievedAt: string }> {
  const url = `https://evidence.example/${suffix}`;
  const retrievedAt = new Date(now()).toISOString();
  const ref = await workerContext.captureEvidence({
    url,
    retrieved_at: retrievedAt,
    media_type: "text/plain",
    data: new TextEncoder().encode(`Evidence bytes for ${suffix}`),
  });
  return { ref, url, retrievedAt };
}

const publishingWorker = (now: () => number): ResearchWorker => ({
  id: "test-worker",
  version: "1",
  async run(input, workerContext) {
    const evidence = await capture(workerContext, now, input.request_id);
    await workerContext.publish(
      proposal(evidence.ref, evidence.url, evidence.retrievedAt),
    );
  },
});

async function setup(
  options: {
    worker?: ResearchWorker;
    task?: Task;
    taskScope?: RequestContext["scope"];
    now?: () => number;
    service?: Partial<Parameters<typeof createResearchService>[0]> & {
      __maxTimerMs?: number;
    };
  } = {},
) {
  const root = makeRoot();
  const tasks = await createTaskStore({
    rootDir: path.join(root, "tasks"),
    workspaceRoots: [],
  });
  taskStores.push(tasks);
  const now = options.now ?? Date.now;
  const task = options.task ?? makeTask("task-1", options.taskScope ?? scope);
  await tasks.create(context("create-task", task.scope), task);
  const service = await createResearchService({
    rootDir: path.join(root, "research"),
    tasks,
    artifacts: tasks.artifacts,
    worker: options.worker ?? publishingWorker(now),
    autoStart: true,
    leaseMs: 150,
    pollMs: 10,
    retryBackoffMs: 0,
    now,
    ...options.service,
  });
  services.push(service);
  return {
    root,
    tasks,
    task,
    service,
    now,
    researchRoot: path.join(root, "research"),
    taskRoot: path.join(root, "tasks"),
  };
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2500,
): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for research state");
}

async function request(
  service: DurableResearchService,
  now: () => number,
  requestId: string,
  overrides: Partial<ResearchRequest> = {},
  taskId = "task-1",
): Promise<string> {
  return service.submit(
    context(requestId),
    makeRequest(now, taskId, overrides),
  );
}

async function errorCode(operation: () => Promise<unknown>): Promise<string> {
  try {
    await operation();
  } catch (error) {
    return error !== null &&
      typeof error === "object" &&
      "code" in error &&
      typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : "other";
  }
  return "resolved";
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

async function firstFinding(
  service: DurableResearchService,
  contextInput: RequestContext,
  requestId: string,
) {
  const finding = (await service.readFindings(contextInput, requestId))[0];
  if (!finding) throw new Error("Expected a persisted research finding");
  return finding;
}

interface ChildOutput {
  kind: string;
  request_id: string;
  code?: string;
}

function childOutputReader(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const buffered: ChildOutput[] = [];
  const waiters: Array<{
    kind: string;
    requestId: string;
    resolve: (line: ChildOutput) => void;
  }> = [];
  const dispatch = (line: string) => {
    let parsed: ChildOutput;
    try {
      parsed = JSON.parse(line) as ChildOutput;
    } catch {
      return;
    }
    const index = waiters.findIndex(
      (waiter) =>
        waiter.kind === parsed.kind && waiter.requestId === parsed.request_id,
    );
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      waiter?.resolve(parsed);
    } else {
      buffered.push(parsed);
    }
  };
  void (async () => {
    let remainder = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      remainder += new TextDecoder().decode(value, { stream: true });
      const lines = remainder.split("\n");
      remainder = lines.pop() ?? "";
      for (const line of lines) {
        if (line.length > 0) dispatch(line);
      }
    }
  })();
  return {
    async next(kind: string, requestId: string): Promise<ChildOutput> {
      const index = buffered.findIndex(
        (line) => line.kind === kind && line.request_id === requestId,
      );
      if (index >= 0) return buffered.splice(index, 1)[0] as ChildOutput;
      return new Promise<ChildOutput>((resolve, reject) => {
        const waiter = { kind, requestId, resolve };
        waiters.push(waiter);
        const timer = setTimeout(() => {
          const waiterIndex = waiters.indexOf(waiter);
          if (waiterIndex >= 0) waiters.splice(waiterIndex, 1);
          reject(
            new Error(
              `Timed out waiting for child ${kind} output for ${requestId}`,
            ),
          );
        }, 2500);
        const originalResolve = waiter.resolve;
        waiter.resolve = (line) => {
          clearTimeout(timer);
          originalResolve(line);
        };
      });
    },
  };
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill();
  }
  await Promise.allSettled(
    services.splice(0).map((service) => service.close({ drainMs: 0 })),
  );
  await Promise.allSettled(taskStores.splice(0).map((store) => store.close()));
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("@mars/research durable control plane", () => {
  test("persists findings and identical stream order across reopen without rerunning", async () => {
    let calls = 0;
    const now = Date.now;
    const worker: ResearchWorker = {
      ...publishingWorker(now),
      async run(input, workerContext) {
        calls += 1;
        const evidence = await capture(
          workerContext,
          now,
          `${input.request_id}-a`,
        );
        await workerContext.publish(
          proposal(evidence.ref, evidence.url, evidence.retrievedAt, "first"),
        );
        await workerContext.publish(
          proposal(
            evidence.ref,
            evidence.url,
            evidence.retrievedAt,
            "second",
            "A second claim from the same capture.",
          ),
        );
      },
    };
    const env = await setup({ worker });
    const requestId = await request(env.service, now, "persist");
    await waitFor(
      async () =>
        (await env.service.inspect(context(), requestId)).status ===
        "completed",
    );
    const before = await env.service.readFindings(context(), requestId);
    expect(before).toHaveLength(2);
    expect(before.map((finding) => finding.claim)).toEqual([
      "Captured evidence supports this claim.",
      "A second claim from the same capture.",
    ]);
    await env.service.close();

    const reopened = await createResearchService({
      rootDir: env.researchRoot,
      tasks: env.tasks,
      artifacts: env.tasks.artifacts,
      worker,
      leaseMs: 150,
      pollMs: 10,
      now,
    });
    services.push(reopened);
    const job = await reopened.inspect(context(), requestId);
    const findings = await reopened.readFindings(context(), requestId);
    const stream = await collect(reopened.findings(context(), requestId));
    expect(job.status).toBe("completed");
    expect(findings).toEqual(before);
    expect(stream).toEqual(before);
    expect(calls).toBe(1);
  });

  test("validates strict requests, privacy, budgets, and idempotent submission", async () => {
    const env = await setup({ service: { autoStart: false } });
    const valid = makeRequest(env.now);
    const cases: Array<[string, Partial<ResearchRequest>]> = [
      ["extra", { extra: "nope" } as Partial<ResearchRequest>],
      ["empty question", { question: "  " }],
      ["bad timestamp", { deadline: "tomorrow" }],
      ["past deadline", { deadline: new Date(env.now() - 1).toISOString() }],
      ["too much budget", { budget: { ...valid.budget, max_tokens: 10_001 } }],
      ["private root", { question: `Read ${env.researchRoot}/private/data` }],
    ];
    for (const [index, [label, override]] of cases.entries()) {
      const code = await errorCode(() =>
        env.service.submit(context(`invalid-${index}`), {
          ...valid,
          ...override,
        }),
      );
      expect(code).toBe("invalid_input");
      expect(label.length).toBeGreaterThan(0);
    }
    const artifact = await env.tasks.artifacts.put(
      context("known-context"),
      new TextEncoder().encode("known"),
      "text/plain",
    );
    expect(
      await errorCode(() =>
        env.service.submit(context("duplicate-known"), {
          ...valid,
          known_context: [artifact, artifact],
        }),
      ),
    ).toBe("invalid_input");

    const stableRequest = makeRequest(env.now);
    const same = await env.service.submit(context("same"), stableRequest);
    expect(await env.service.submit(context("same"), stableRequest)).toBe(same);
    expect(
      await errorCode(() =>
        env.service.submit(context("same"), {
          ...stableRequest,
          question: "Different input",
        }),
      ),
    ).toBe("conflict");
    expect(await env.service.list(context())).toHaveLength(1);
    const rejected = await errorCode(() =>
      request(env.service, env.now, "private", {
        question: env.researchRoot,
      }),
    );
    expect(rejected).toBe("invalid_input");
    const message = await (async () => {
      try {
        await request(env.service, env.now, "private-message", {
          question: env.researchRoot,
        });
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      return "";
    })();
    expect(message).not.toContain(env.researchRoot);
  });

  test("checks task ownership and denies cross-scope access", async () => {
    const workerScope = {
      owner_id: "other-owner",
      project_id: "other-project",
      workspace_id: "other-workspace",
    };
    const worker: ResearchWorker = {
      id: "scope-worker",
      version: "1",
      async run(input, workerContext) {
        const evidence = await capture(
          workerContext,
          Date.now,
          input.request_id,
        );
        await workerContext.publish(
          proposal(evidence.ref, evidence.url, evidence.retrievedAt),
        );
      },
    };
    const env = await setup({ worker });
    const otherTask = makeTask("other-task", workerScope);
    await env.tasks.create(
      context("other-task-create", workerScope),
      otherTask,
    );
    const foreignArtifact = await env.tasks.artifacts.put(
      context("foreign-artifact", workerScope),
      new TextEncoder().encode("private to other scope"),
      "text/plain",
    );
    expect(
      await errorCode(() =>
        request(env.service, env.now, "other-task", {}, otherTask.task_id),
      ),
    ).toBe("not_found");
    expect(
      await errorCode(() =>
        request(env.service, env.now, "other-artifact", {
          known_context: [foreignArtifact],
        }),
      ),
    ).toBe("not_found");

    let readCode = "resolved";
    const readerWorker: ResearchWorker = {
      id: "reader-worker",
      version: "1",
      async run(input, workerContext) {
        readCode = await errorCode(() =>
          workerContext.readKnownContext(foreignArtifact),
        );
        const evidence = await capture(
          workerContext,
          env.now,
          input.request_id,
        );
        await workerContext.publish(
          proposal(evidence.ref, evidence.url, evidence.retrievedAt),
        );
      },
    };
    await env.service.close();
    const readerService = await createResearchService({
      rootDir: env.researchRoot,
      tasks: env.tasks,
      artifacts: env.tasks.artifacts,
      worker: readerWorker,
      leaseMs: 150,
      pollMs: 10,
      now: env.now,
    });
    services.push(readerService);
    const id = await request(readerService, env.now, "scope-private");
    await waitFor(
      async () =>
        (await readerService.inspect(context(), id)).status === "completed",
    );
    expect(readCode).toBe("not_found");

    const completed = await request(readerService, env.now, "scope-hidden");
    await waitFor(
      async () =>
        (await readerService.inspect(context(), completed)).status ===
        "completed",
    );
    const finding = await firstFinding(readerService, context(), completed);
    for (const operation of [
      () => readerService.inspect(context("other", workerScope), completed),
      () =>
        readerService.readFindings(context("other", workerScope), completed),
      () => readerService.cancel(context("other", workerScope), completed),
      () => readerService.markStale(context("other", workerScope), completed),
      () =>
        readerService.markUsed(
          context("other", workerScope),
          finding.finding_id,
          0,
        ),
      async () =>
        collect(
          readerService.findings(context("other", workerScope), completed),
        ),
    ]) {
      expect(await errorCode(operation)).toBe("not_found");
    }
  });

  test("enforces revisions, reconciliation, and used-finding semantics", async () => {
    const env = await setup();
    const task = env.task;
    expect(
      await errorCode(() =>
        request(env.service, env.now, "wrong-revision", {
          task_revision: task.revision + 1,
        }),
      ),
    ).toBe("stale_revision");
    const terminalTask = makeTask("terminal-task");
    await env.tasks.create(context("terminal-create"), terminalTask);
    const running = await env.tasks.update(
      context("terminal-running"),
      terminalTask.task_id,
      0,
      { status: "running" },
    );
    const completed = await env.tasks.update(
      context("terminal-complete"),
      terminalTask.task_id,
      running.revision,
      { status: "completed" },
    );
    expect(
      await errorCode(() =>
        request(
          env.service,
          env.now,
          "terminal-task",
          { task_revision: completed.revision },
          terminalTask.task_id,
        ),
      ),
    ).toBe("invalid_state");

    const id = await request(env.service, env.now, "used-before-stale");
    await waitFor(
      async () =>
        (await env.service.inspect(context(), id)).status === "completed",
    );
    const second = await request(env.service, env.now, "reconcile-stale");
    await waitFor(
      async () =>
        (await env.service.inspect(context(), second)).status === "completed",
    );
    const finding = await firstFinding(env.service, context(), id);
    const used = await env.service.markUsed(
      context("mark-used"),
      finding.finding_id,
      task.revision,
    );
    expect(used.status).toBe("used");
    await env.tasks.update(context("task-revision"), task.task_id, 0, {
      specialist_revision: "revision-1",
    });
    expect(
      await errorCode(() =>
        env.service.markUsed(
          context("mark-used-stale"),
          finding.finding_id,
          task.revision,
        ),
      ),
    ).toBe("stale_revision");
    expect((await env.service.readFindings(context(), id))[0]?.status).toBe(
      "used",
    );
    const result = await env.service.reconcileTask(
      context("reconcile"),
      task.task_id,
    );
    expect(result).toEqual({
      task_revision: 1,
      stale_request_ids: [second],
    });
    expect((await env.service.readFindings(context(), second))[0]?.status).toBe(
      "stale",
    );
    await env.service.markStale(context("stale-used"), id);
    expect((await env.service.readFindings(context(), id))[0]?.status).toBe(
      "used",
    );

    expect((await env.service.inspect(context(), second)).stale).toBe(true);
  });

  test("requires evidence captured for the same request and validates citations", async () => {
    const now = Date.now;
    const outcomes: string[] = [];
    let foreignRef: ArtifactRef | undefined;
    const worker: ResearchWorker = {
      id: "citation-worker",
      version: "1",
      async run(input, workerContext) {
        if (input.question === "foreign evidence") {
          const evidence = await capture(workerContext, now, "foreign");
          foreignRef = evidence.ref;
          await workerContext.publish(
            proposal(
              evidence.ref,
              evidence.url,
              evidence.retrievedAt,
              "foreign-own",
            ),
          );
          return;
        }
        const evidence = await capture(workerContext, now, "valid");
        const withCode = async (operation: () => Promise<unknown>) => {
          outcomes.push(await errorCode(operation));
        };
        await withCode(() =>
          workerContext.publish({
            finding_key: "empty-sources",
            claim: "No citation.",
            recommendation: "Do not rely on it.",
            confidence: "low",
            remaining_uncertainty: [],
            sources: [],
          }),
        );
        await withCode(() =>
          workerContext.publish(
            proposal(
              evidence.ref,
              evidence.url,
              new Date(now() + 60_000).toISOString(),
              "future-citation",
            ),
          ),
        );
        const known = input.known_context[0];
        if (known) {
          await withCode(() =>
            workerContext.publish(
              proposal(
                known,
                "https://evidence.example/known",
                evidence.retrievedAt,
              ),
            ),
          );
        }
        if (foreignRef) {
          await withCode(() =>
            workerContext.publish(
              proposal(
                foreignRef as ArtifactRef,
                "https://evidence.example/foreign",
                evidence.retrievedAt,
              ),
            ),
          );
        }
        await withCode(() =>
          workerContext.publish(
            proposal(
              evidence.ref,
              evidence.url,
              new Date(Date.parse(evidence.retrievedAt) + 1).toISOString(),
              "mismatched-citation",
            ),
          ),
        );
        for (const url of [
          "file:///private/file",
          "javascript:alert(1)",
          "ftp://evidence.example/file",
          "https://user:pass@evidence.example/file",
          "https://evidence.example/a\u00a0b",
        ]) {
          await withCode(() =>
            workerContext.captureEvidence({
              url,
              retrieved_at: evidence.retrievedAt,
              media_type: "text/plain",
              data: new TextEncoder().encode("not retrieved"),
            }),
          );
        }
        await withCode(() =>
          workerContext.captureEvidence({
            url: "https://evidence.example/empty",
            retrieved_at: evidence.retrievedAt,
            media_type: "text/plain",
            data: new Uint8Array(),
          }),
        );
        await withCode(() =>
          workerContext.captureEvidence({
            url: "https://evidence.example/future",
            retrieved_at: new Date(now() + 60_000).toISOString(),
            media_type: "text/plain",
            data: new TextEncoder().encode("future"),
          }),
        );
      },
    };
    const env = await setup({ worker });
    const knownContext = await env.tasks.artifacts.put(
      context("known-citation"),
      new TextEncoder().encode("known context"),
      "text/plain",
    );
    const foreign = await request(env.service, now, "foreign-evidence", {
      question: "foreign evidence",
    });
    await waitFor(
      async () =>
        (await env.service.inspect(context(), foreign)).status === "completed",
    );
    const current = await request(env.service, now, "citation-check", {
      question: "citation checks",
      known_context: [knownContext],
    });
    await waitFor(
      async () =>
        (await env.service.inspect(context(), current)).status === "completed",
    );
    expect(outcomes).toEqual([
      "citation_rejected",
      "citation_rejected",
      "citation_rejected",
      "citation_rejected",
      "citation_rejected",
      "citation_rejected",
      "citation_rejected",
      "citation_rejected",
      "citation_rejected",
      "citation_rejected",
      "citation_rejected",
      "citation_rejected",
    ]);
    expect(await env.service.readFindings(context(), current)).toEqual([]);
    expect(foreignRef).toBeDefined();
  });

  test("retries idempotent findings and preserves first-writer content", async () => {
    const observedKeys: string[][] = [];
    let firstProposal: FindingProposal | undefined;
    const worker: ResearchWorker = {
      id: "retry-worker",
      version: "1",
      async run(input, workerContext) {
        observedKeys.push(input.published_finding_keys);
        const evidence = await capture(
          workerContext,
          Date.now,
          input.request_id,
        );
        if (input.question === "conflicting retry") {
          await workerContext.publish(
            proposal(evidence.ref, evidence.url, evidence.retrievedAt, "same"),
          );
          await workerContext.publish(
            proposal(
              evidence.ref,
              evidence.url,
              evidence.retrievedAt,
              "same",
              "Different claim for the existing key.",
            ),
          );
          return;
        }
        const currentProposal = proposal(
          evidence.ref,
          evidence.url,
          evidence.retrievedAt,
          "first",
        );
        if (input.attempt === 1) firstProposal = currentProposal;
        const stableProposal = firstProposal ?? currentProposal;
        await workerContext.publish(stableProposal);
        if (input.attempt === 1) throw new RetryableResearchError("retry");
        await workerContext.publish({
          ...stableProposal,
          finding_key: "second",
          claim: "A second persisted finding.",
        });
      },
    };
    const env = await setup({
      worker,
      service: { maxAttempts: 2, retryBackoffMs: 0 },
    });
    const id = await request(env.service, env.now, "retry");
    await waitFor(
      async () =>
        (await env.service.inspect(context(), id)).status === "completed",
    );
    const job = await env.service.inspect(context(), id);
    expect(job.attempts).toBe(2);
    expect(await env.service.readFindings(context(), id)).toHaveLength(2);
    expect(observedKeys).toEqual([[], ["first"]]);

    const conflictId = await request(env.service, env.now, "retry-conflict", {
      question: "conflicting retry",
    });
    await waitFor(
      async () =>
        (await env.service.inspect(context(), conflictId)).status === "failed",
    );
    expect((await env.service.inspect(context(), conflictId)).error_code).toBe(
      "worker_failed",
    );

    const failing = await setup({
      worker: {
        id: "always-failing",
        version: "1",
        async run() {
          throw new Error("never persist worker error text");
        },
      },
      service: { maxAttempts: 2, retryBackoffMs: 0 },
    });
    const exhausted = await request(failing.service, failing.now, "exhausted");
    await waitFor(
      async () =>
        (await failing.service.inspect(context(), exhausted)).status ===
        "failed",
    );
    const exhaustedJob = await failing.service.inspect(context(), exhausted);
    expect(exhaustedJob.error_code).toBe("attempts_exhausted");
    expect(JSON.stringify(exhaustedJob)).not.toContain(
      "never persist worker error text",
    );
  });

  test("fails immediately when a worker rethrows a non-retryable research error", async () => {
    let runCount = 0;
    const worker: ResearchWorker = {
      id: "non-retryable-worker",
      version: "1",
      async run(input, workerContext) {
        runCount += 1;
        const evidence = await capture(
          workerContext,
          Date.now,
          input.request_id,
        );
        await workerContext.publish(
          proposal(evidence.ref, "javascript:alert(1)", evidence.retrievedAt),
        );
      },
    };
    const env = await setup({
      worker,
      service: { maxAttempts: 3, retryBackoffMs: 0 },
    });
    const id = await request(env.service, env.now, "non-retryable");
    await waitFor(
      async () =>
        (await env.service.inspect(context(), id)).status === "failed",
    );
    const job = await env.service.inspect(context(), id);
    expect(job.error_code).toBe("worker_failed");
    expect(job.attempts).toBe(1);
    expect(runCount).toBe(1);
  });

  test("denies expired lease writes and prevents an old owner overwriting a replacement", async () => {
    let nowMs = 1_700_000_000_000;
    const now = () => nowMs;
    let started!: (workerContext: ResearchWorkerContext) => void;
    let finishOld!: () => void;
    let oldProposal: FindingProposal | undefined;
    const entered = new Promise<ResearchWorkerContext>((resolve) => {
      started = resolve;
    });
    const releaseOld = new Promise<void>((resolve) => {
      finishOld = resolve;
    });
    const oldWorker: ResearchWorker = {
      id: "lease-owner-a",
      version: "1",
      async run(input, workerContext) {
        const evidence = await capture(workerContext, now, input.request_id);
        oldProposal = proposal(
          evidence.ref,
          evidence.url,
          evidence.retrievedAt,
          "old-late",
        );
        started(workerContext);
        await releaseOld;
      },
    };
    const env = await setup({
      worker: oldWorker,
      now,
      service: { autoStart: false, leaseMs: 150, pollMs: 10 },
    });
    const id = await request(env.service, now, "lease");
    await env.service.pump();
    const oldContext = await entered;
    nowMs += 151;
    expect(
      await errorCode(() => oldContext.publish(oldProposal as FindingProposal)),
    ).toBe("lease_lost");

    const newWorker: ResearchWorker = {
      id: "lease-owner-b",
      version: "1",
      async run(input, workerContext) {
        const evidence = await capture(workerContext, now, input.request_id);
        await workerContext.publish(
          proposal(evidence.ref, evidence.url, evidence.retrievedAt, "new"),
        );
      },
    };
    const second = await createResearchService({
      rootDir: env.researchRoot,
      tasks: env.tasks,
      artifacts: env.tasks.artifacts,
      worker: newWorker,
      autoStart: false,
      leaseMs: 150,
      pollMs: 10,
      now,
    });
    services.push(second);
    await second.pump();
    await waitFor(
      async () => (await second.inspect(context(), id)).status === "completed",
    );
    expect(
      await errorCode(() => oldContext.publish(oldProposal as FindingProposal)),
    ).toBe("lease_lost");
    finishOld();
    await waitFor(
      async () =>
        (await env.service.inspect(context(), id)).status === "completed",
    );
    const findings = await second.readFindings(context(), id);
    expect(findings.map((finding) => finding.claim)).toEqual([
      "Captured evidence supports this claim.",
    ]);
    expect((await second.inspect(context(), id)).attempts).toBe(2);
  });

  test("reschedules capped deadline timers until the stored deadline", async () => {
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const worker: ResearchWorker = {
      id: "capped-deadline-worker",
      version: "1",
      async run(_input, workerContext) {
        resolveStarted();
        await new Promise<void>((_resolve, reject) => {
          const onAbort = () => reject(new Error("deadline reached"));
          if (workerContext.signal.aborted) {
            onAbort();
          } else {
            workerContext.signal.addEventListener("abort", onAbort, {
              once: true,
            });
          }
        });
      },
    };
    const env = await setup({
      worker,
      service: {
        autoStart: false,
        maxAttempts: 1,
        __maxTimerMs: 10,
      },
    });
    const id = await request(env.service, env.now, "capped-deadline", {
      deadline: new Date(env.now() + 300).toISOString(),
    });
    await env.service.pump();
    await started;
    await new Promise((resolve) => setTimeout(resolve, 40));
    const beforeDeadline = await env.service.inspect(context(), id);
    expect(beforeDeadline.status).toBe("running");
    expect(Date.now()).toBeLessThan(Date.parse(beforeDeadline.deadline));

    await waitFor(
      async () =>
        (await env.service.inspect(context(), id)).status === "expired",
      1000,
    );
    expect((await env.service.inspect(context(), id)).error_code).toBe(
      "deadline_exceeded",
    );
  });

  test("expires deadlines across queued work and reports persisted late-write codes", async () => {
    let nowMs = 1_700_000_100_000;
    const now = () => nowMs;
    const clamped = await setup({
      now,
      service: { autoStart: false },
    });
    const longDeadline = await request(clamped.service, now, "clamped", {
      deadline: new Date(nowMs + 50_000).toISOString(),
      budget: {
        ...makeRequest(now).budget,
        max_duration_ms: 1_000,
      },
    });
    expect(
      Date.parse(
        (await clamped.service.inspect(context(), longDeadline)).deadline,
      ),
    ).toBe(nowMs + 1_000);
    const expirer = await createResearchService({
      rootDir: clamped.researchRoot,
      tasks: clamped.tasks,
      artifacts: clamped.tasks.artifacts,
      worker: publishingWorker(now),
      autoStart: false,
      leaseMs: 150,
      pollMs: 10,
      now,
    });
    services.push(expirer);
    nowMs += 1_001;
    await expirer.pump();
    expect(
      (await clamped.service.inspect(context(), longDeadline)).status,
    ).toBe("expired");
    expect(
      (await clamped.service.inspect(context(), longDeadline)).error_code,
    ).toBe("deadline_exceeded");

    let entered!: (value: {
      context: ResearchWorkerContext;
      proposal: FindingProposal;
    }) => void;
    let late!: (code: string) => void;
    const started = new Promise<{
      context: ResearchWorkerContext;
      proposal: FindingProposal;
    }>((resolve) => {
      entered = resolve;
    });
    const lateWrite = new Promise<string>((resolve) => {
      late = resolve;
    });
    const worker: ResearchWorker = {
      id: "deadline-worker",
      version: "1",
      async run(input, workerContext) {
        const evidence = await capture(workerContext, now, input.request_id);
        const finding = proposal(
          evidence.ref,
          evidence.url,
          evidence.retrievedAt,
        );
        entered({ context: workerContext, proposal: finding });
        await new Promise<void>((resolve) => {
          if (workerContext.signal.aborted) {
            resolve();
            return;
          }
          workerContext.signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        late(await errorCode(() => workerContext.publish(finding)));
      },
    };
    const running = await setup({
      worker,
      now,
      service: { autoStart: true, leaseMs: 150, pollMs: 10 },
    });
    const id = await request(running.service, now, "deadline", {
      deadline: new Date(nowMs + 500).toISOString(),
      budget: { ...makeRequest(now).budget, max_duration_ms: 5_000 },
    });
    await started;
    nowMs += 501;
    await running.service.pump();
    await waitFor(
      async () =>
        (await running.service.inspect(context(), id)).status === "expired",
    );
    expect(await lateWrite).toBe("deadline_exceeded");
    expect((await running.service.inspect(context(), id)).error_code).toBe(
      "deadline_exceeded",
    );
    expect(await collect(running.service.findings(context(), id))).toEqual([]);
  });

  test("cancels running and queued requests idempotently", async () => {
    let entered!: (value: {
      context: ResearchWorkerContext;
      proposal: FindingProposal;
    }) => void;
    let late!: (code: string) => void;
    const started = new Promise<{
      context: ResearchWorkerContext;
      proposal: FindingProposal;
    }>((resolve) => {
      entered = resolve;
    });
    const lateWrite = new Promise<string>((resolve) => {
      late = resolve;
    });
    const worker: ResearchWorker = {
      id: "cancel-worker",
      version: "1",
      async run(input, workerContext) {
        const evidence = await capture(
          workerContext,
          Date.now,
          input.request_id,
        );
        const finding = proposal(
          evidence.ref,
          evidence.url,
          evidence.retrievedAt,
        );
        entered({ context: workerContext, proposal: finding });
        await new Promise<void>((resolve) => {
          if (workerContext.signal.aborted) {
            resolve();
            return;
          }
          workerContext.signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        late(await errorCode(() => workerContext.publish(finding)));
      },
    };
    const env = await setup({ worker });
    const id = await request(env.service, env.now, "running-cancel");
    await started;
    await env.service.cancel(context("cancel"), id);
    await env.service.cancel(context("cancel-again"), id);
    expect((await env.service.inspect(context(), id)).status).toBe("cancelled");
    expect(await lateWrite).toBe("cancelled");
    expect(await collect(env.service.findings(context(), id))).toEqual([]);

    let queuedRuns = 0;
    const queuedEnv = await setup({
      worker: {
        id: "queued-cancel-worker",
        version: "1",
        async run() {
          queuedRuns += 1;
        },
      },
      service: { autoStart: false },
    });
    const queuedId = await request(
      queuedEnv.service,
      queuedEnv.now,
      "queued-cancel",
    );
    await queuedEnv.service.cancel(context("cancel-queued"), queuedId);
    await queuedEnv.service.pump();
    expect((await queuedEnv.service.inspect(context(), queuedId)).status).toBe(
      "cancelled",
    );
    expect(queuedRuns).toBe(0);
  });

  test("enforces local concurrency and per-scope backpressure", async () => {
    let running = 0;
    let maxRunning = 0;
    const now = Date.now;
    const worker: ResearchWorker = {
      id: "concurrency-worker",
      version: "1",
      async run(input, workerContext) {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((resolve) => setTimeout(resolve, 15));
        const evidence = await capture(workerContext, now, input.request_id);
        await workerContext.publish(
          proposal(evidence.ref, evidence.url, evidence.retrievedAt),
        );
        running -= 1;
      },
    };
    const env = await setup({
      worker,
      service: { maxConcurrency: 2, maxActivePerScope: 10 },
    });
    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      ids.push(await request(env.service, now, `concurrent-${index}`));
    }
    await waitFor(async () => {
      const jobs = await Promise.all(
        ids.map((id) => env.service.inspect(context(), id)),
      );
      return jobs.every((job) => job.status === "completed");
    });
    expect(maxRunning).toBe(2);

    const backpressure = await setup({
      service: {
        autoStart: false,
        maxActivePerScope: 3,
        maxActiveTotal: 10,
      },
    });
    for (let index = 0; index < 3; index += 1) {
      await request(backpressure.service, backpressure.now, `active-${index}`);
    }
    expect(
      await errorCode(() =>
        request(backpressure.service, backpressure.now, "active-overflow"),
      ),
    ).toBe("backpressure");
    const secondScope = {
      owner_id: "other-owner",
      project_id: "other-project",
      workspace_id: "other-workspace",
    };
    const otherTask = makeTask("other-scope-task", secondScope);
    await backpressure.tasks.create(
      context("create-other", secondScope),
      otherTask,
    );
    const otherId = await backpressure.service.submit(
      context("other-scope-request", secondScope),
      makeRequest(backpressure.now, otherTask.task_id),
    );
    expect(
      (
        await backpressure.service.inspect(
          context("other-scope-inspect", secondScope),
          otherId,
        )
      ).status,
    ).toBe("queued");
  });

  test("autoStart false only claims queued work on an explicit pump", async () => {
    let runCount = 0;
    const now = Date.now;
    const worker: ResearchWorker = {
      id: "manual-pump-worker",
      version: "1",
      async run(input, workerContext) {
        runCount += 1;
        const evidence = await capture(workerContext, now, input.request_id);
        await workerContext.publish(
          proposal(evidence.ref, evidence.url, evidence.retrievedAt),
        );
      },
    };
    const env = await setup({
      worker,
      service: { autoStart: false, maxConcurrency: 1 },
    });
    const first = await request(env.service, now, "manual-first");
    const second = await request(env.service, now, "manual-second");
    expect((await env.service.inspect(context(), first)).status).toBe("queued");
    expect((await env.service.inspect(context(), second)).status).toBe(
      "queued",
    );

    await env.service.pump();
    await waitFor(
      async () =>
        (await env.service.inspect(context(), first)).status === "completed",
    );
    expect(runCount).toBe(1);
    expect((await env.service.inspect(context(), second)).status).toBe(
      "queued",
    );

    await env.service.pump();
    await waitFor(
      async () =>
        (await env.service.inspect(context(), second)).status === "completed",
    );
    expect(runCount).toBe(2);
  });

  test("drains or requeues workers on shutdown and closes streams", async () => {
    let finished = false;
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const fastWorker: ResearchWorker = {
      id: "drain-worker",
      version: "1",
      async run(input, workerContext) {
        resolveStarted();
        await new Promise((resolve) => setTimeout(resolve, 15));
        const evidence = await capture(
          workerContext,
          Date.now,
          input.request_id,
        );
        await workerContext.publish(
          proposal(evidence.ref, evidence.url, evidence.retrievedAt),
        );
        finished = true;
      },
    };
    const fast = await setup({ worker: fastWorker });
    const drainedId = await request(fast.service, fast.now, "drain");
    await started;
    await fast.service.close({ drainMs: 200 });
    expect(finished).toBe(true);
    const drained = await createResearchService({
      rootDir: fast.researchRoot,
      tasks: fast.tasks,
      artifacts: fast.tasks.artifacts,
      worker: fastWorker,
      autoStart: false,
      now: fast.now,
    });
    services.push(drained);
    expect((await drained.inspect(context(), drainedId)).status).toBe(
      "completed",
    );

    const neverWorker: ResearchWorker = {
      id: "shutdown-worker",
      version: "1",
      async run() {
        await new Promise<void>(() => {});
      },
    };
    const interrupted = await setup({
      worker: neverWorker,
      service: { autoStart: true },
    });
    const interruptedId = await request(
      interrupted.service,
      interrupted.now,
      "shutdown",
    );
    const iterator = interrupted.service
      .findings(context("pending-stream"), interruptedId)
      [Symbol.asyncIterator]();
    const pendingNext = iterator.next();
    await waitFor(async () => {
      const jobs = await interrupted.service.list(context());
      return jobs[0]?.status === "running";
    });
    await interrupted.service.close({ drainMs: 0 });
    expect(await pendingNext).toEqual({ done: true, value: undefined });
    expect(
      await errorCode(() =>
        interrupted.service.inspect(context(), interruptedId),
      ),
    ).toBe("closed");
    await interrupted.service.close();

    const resumed = await createResearchService({
      rootDir: interrupted.researchRoot,
      tasks: interrupted.tasks,
      artifacts: interrupted.tasks.artifacts,
      worker: publishingWorker(interrupted.now),
      leaseMs: 150,
      pollMs: 10,
      now: interrupted.now,
    });
    services.push(resumed);
    await waitFor(
      async () =>
        (await resumed.inspect(context(), interruptedId)).status ===
        "completed",
    );
    expect((await resumed.inspect(context(), interruptedId)).attempts).toBe(2);
  });

  test("persists reported budget failures and marks unreported usage honestly", async () => {
    const budgetWorker: ResearchWorker = {
      id: "budget-worker",
      version: "1",
      async run(_input, workerContext) {
        await workerContext.reportUsage({
          input_tokens: 2,
          output_tokens: 1,
          cost_usd: 0.25,
        });
      },
    };
    const env = await setup({
      worker: budgetWorker,
      service: { maxAttempts: 1 },
    });
    const id = await request(env.service, env.now, "over-budget", {
      budget: { ...makeRequest(env.now).budget, max_tokens: 2 },
    });
    await waitFor(
      async () =>
        (await env.service.inspect(context(), id)).status === "failed",
    );
    const failed = await env.service.inspect(context(), id);
    expect(failed.error_code).toBe("budget_exceeded");
    expect(failed.usage).toEqual({
      input_tokens: 2,
      output_tokens: 1,
      cost_usd: 0.25,
      reported: true,
    });
    expect(failed.enforcement.tokens).toBe("reported_usage_only");
    expect(failed.enforcement.usd).toBe("reported_usage_only");

    const noReport = await setup({
      worker: {
        id: "no-usage-worker",
        version: "1",
        async run() {},
      },
    });
    const unreportedId = await request(
      noReport.service,
      noReport.now,
      "no-report",
    );
    await waitFor(
      async () =>
        (await noReport.service.inspect(context(), unreportedId)).status ===
        "completed",
    );
    expect(
      (await noReport.service.inspect(context(), unreportedId)).usage,
    ).toMatchObject({ reported: false, cost_usd: null });
  });

  test("retries the event outbox without exposing finding content", async () => {
    let store: Awaited<ReturnType<typeof createTaskStore>> | undefined;
    let failedOnce = false;
    const eventSink = {
      async appendEvent(
        eventContext: RequestContext,
        taskId: string,
        input: Parameters<
          Awaited<ReturnType<typeof createTaskStore>>["appendEvent"]
        >[2],
      ) {
        if (!failedOnce) {
          failedOnce = true;
          throw new Error("Do not persist sink errors");
        }
        return store?.appendEvent(eventContext, taskId, input);
      },
    };
    const env = await setup({
      service: {
        events: eventSink,
      },
    });
    store = env.tasks;
    const id = await request(env.service, env.now, "outbox");
    await waitFor(
      async () =>
        (await env.service.inspect(context(), id)).status === "completed",
    );
    await env.service.pump();
    const initial = await collect(
      env.tasks.events(context(), env.task.task_id),
    );
    const proposed = initial.filter(
      (event) => event.event_type === "research.proposed",
    );
    expect(proposed).toHaveLength(1);
    expect(JSON.stringify(proposed[0]?.payload)).not.toContain(
      "Captured evidence supports this claim.",
    );
    expect(JSON.stringify(proposed[0]?.payload)).not.toContain(env.root);
    await env.service.markStale(context("outbox-stale"), id);
    const afterStale = await collect(
      env.tasks.events(context(), env.task.task_id),
    );
    expect(
      afterStale.filter((event) => event.event_type === "research.stale"),
    ).toHaveLength(1);
    expect(JSON.stringify(afterStale.at(-1)?.payload)).not.toContain(env.root);
  });

  test("migrates v1 outbox rows and rejects unsupported store versions", async () => {
    const root = makeRoot();
    const tasks = await createTaskStore({
      rootDir: path.join(root, "tasks"),
      workspaceRoots: [],
    });
    taskStores.push(tasks);
    const task = makeTask();
    await tasks.create(context("create-v1-task"), task);
    const researchRoot = path.join(root, "research");
    const db = createV1ResearchDatabase(researchRoot);
    const now = Date.now();
    const scopeJson = canonicalRecord(scope).record_json;
    const scopeKey = sha256(scopeJson);
    const legacyWorkerJson = canonicalRecord({
      id: "legacy-worker",
      version: "1",
    }).record_json;
    const insertRequest = db.query(
      `INSERT INTO requests
       (scope_key, request_id, scope_json, idem_request_id, input_sha256,
        record_json, record_sha256, task_id, task_revision, status, stale,
        cancel_requested, attempts, max_attempts, submitted_at,
        requested_deadline, deadline, available_at, lease_owner, lease_token,
        lease_expires_at, usage_json, error_code, worker_json, finished_at,
        stale_event_state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 3, ?, ?, ?, ?,
               NULL, NULL, NULL, ?, NULL, ?, ?, ?)`,
    );
    const insertFinding = db.query(
      `INSERT INTO findings
       (scope_key, request_id, seq, finding_id, finding_key, record_json,
        record_sha256, status, attempt, event_state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    );
    const seedRequest = (
      requestId: string,
      stale: boolean,
      workerJson: string | null,
    ) => {
      const requestValue = makeRequest(Date.now, task.task_id);
      const requestRecord = canonicalRecord(requestValue);
      const submittedAt = new Date(now).toISOString();
      insertRequest.run(
        scopeKey,
        requestId,
        scopeJson,
        `context-${requestId}`,
        sha256(requestId),
        requestRecord.record_json,
        requestRecord.record_sha256,
        task.task_id,
        0,
        "completed",
        stale ? 1 : 0,
        submittedAt,
        requestValue.deadline,
        requestValue.deadline,
        now,
        JSON.stringify({
          input_tokens: 0,
          output_tokens: 0,
          cost_usd: null,
          reported: false,
        }),
        workerJson,
        submittedAt,
        stale ? "pending" : "none",
      );
    };
    const seedFinding = (
      requestId: string,
      seq: number,
      status: ResearchFinding["status"],
      eventState: string,
    ) => {
      const findingId = `rf_${requestId}_${seq}`;
      const finding: ResearchFinding = {
        finding_id: findingId,
        request_id: requestId,
        task_revision: 0,
        claim: `Legacy finding ${seq}`,
        sources: [],
        recommendation: "Review the finding.",
        confidence: "medium",
        remaining_uncertainty: [],
        status,
      };
      const record = canonicalRecord(finding);
      insertFinding.run(
        scopeKey,
        requestId,
        seq,
        findingId,
        `legacy-${seq}`,
        record.record_json,
        record.record_sha256,
        status,
        eventState,
      );
      return findingId;
    };
    const proposedRequestId = "rr_legacy_proposed";
    const staleRequestId = "rr_legacy_stale";
    seedRequest(proposedRequestId, false, legacyWorkerJson);
    seedRequest(staleRequestId, true, null);
    const proposedFindingId = seedFinding(
      proposedRequestId,
      1,
      "proposed",
      "pending",
    );
    const staleFindingIds = [
      seedFinding(staleRequestId, 1, "stale", "none"),
      seedFinding(staleRequestId, 2, "stale", "none"),
    ];
    db.close();

    const worker: ResearchWorker = {
      id: "new-worker",
      version: "2",
      async run(input, workerContext) {
        const evidence = await capture(
          workerContext,
          Date.now,
          input.request_id,
        );
        await workerContext.publish(
          proposal(evidence.ref, evidence.url, evidence.retrievedAt),
        );
      },
    };
    const service = await createResearchService({
      rootDir: researchRoot,
      tasks,
      artifacts: tasks.artifacts,
      events: tasks,
      worker,
      autoStart: false,
    });
    services.push(service);
    expect(RESEARCH_STORE_FORMAT_VERSION).toBe(2);
    await service.pump();

    let events = await collect(tasks.events(context(), task.task_id));
    const proposed = events.filter(
      (event) => event.event_type === "research.proposed",
    );
    const stale = events.filter(
      (event) => event.event_type === "research.stale",
    );
    expect(proposed).toHaveLength(1);
    expect(stale).toHaveLength(1);
    const proposedEvent = proposed[0];
    const staleEvent = stale[0];
    if (!proposedEvent || !staleEvent) {
      throw new Error("Expected migrated task events");
    }
    const proposedPayload = JSON.parse(
      new TextDecoder().decode(
        await tasks.artifacts.get(
          context("read-migrated-proposed-payload"),
          proposedEvent.payload,
        ),
      ),
    ) as Record<string, unknown>;
    const stalePayload = JSON.parse(
      new TextDecoder().decode(
        await tasks.artifacts.get(
          context("read-migrated-stale-payload"),
          staleEvent.payload,
        ),
      ),
    ) as Record<string, unknown>;
    expect(proposed[0]?.versions).toContainEqual({
      component: "@mars/research",
      revision: "1",
    });
    expect(proposed[0]?.versions).toContainEqual({
      component: "worker:legacy-worker",
      revision: "1",
    });
    expect(proposedPayload).toMatchObject({
      request_id: proposedRequestId,
      finding_id: proposedFindingId,
    });
    expect(stale[0]?.versions).toContainEqual({
      component: "@mars/research",
      revision: "1",
    });
    expect(stale[0]?.versions).toContainEqual({
      component: "worker:none",
      revision: "0",
    });
    expect(stalePayload).toEqual({
      request_id: staleRequestId,
      task_revision: 0,
      stale_finding_ids: staleFindingIds,
    });

    const newRequestId = await request(service, Date.now, "after-v1-migration");
    await service.pump();
    await waitFor(
      async () =>
        (await service.inspect(context("after-v1-migration"), newRequestId))
          .status === "completed",
    );
    await service.pump();
    events = await collect(tasks.events(context(), task.task_id));
    const newProposed = events.find(
      (event) =>
        event.event_type === "research.proposed" &&
        event.versions.some(
          (version) => version.component === "worker:new-worker",
        ),
    );
    expect(newProposed?.versions).toContainEqual({
      component: "@mars/research",
      revision: "2",
    });
    expect(newProposed?.versions).toContainEqual({
      component: "worker:new-worker",
      revision: "2",
    });

    const migratedDb = new Database(path.join(researchRoot, "research.sqlite"));
    const formatVersion = migratedDb
      .query("SELECT value FROM meta WHERE key = 'format_version'")
      .get() as { value: string };
    migratedDb.close();
    expect(formatVersion.value).toBe("2");

    const versionThreeRoot = path.join(makeRoot(), "research-v3");
    mkdirSync(versionThreeRoot, { recursive: true, mode: 0o700 });
    const versionThreeDb = new Database(
      path.join(versionThreeRoot, "research.sqlite"),
      { create: true, strict: true },
    );
    versionThreeDb.exec(
      "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    versionThreeDb
      .query("INSERT INTO meta (key, value) VALUES ('format_version', '3')")
      .run();
    versionThreeDb.close();
    expect(
      await errorCode(() =>
        createResearchService({
          rootDir: versionThreeRoot,
          tasks,
          artifacts: tasks.artifacts,
          worker,
          autoStart: false,
        }),
      ),
    ).toBe("corrupt_record");
  });

  test("replays the persisted proposed and stale event inputs after append crashes", async () => {
    let taskStore: Awaited<ReturnType<typeof createTaskStore>> | undefined;
    const worker = (version: string): ResearchWorker => ({
      id: "outbox-versioned-worker",
      version,
      async run(input, workerContext) {
        const evidence = await capture(
          workerContext,
          Date.now,
          input.request_id,
        );
        await workerContext.publish(
          proposal(evidence.ref, evidence.url, evidence.retrievedAt),
        );
      },
    });
    const failingSink = (
      eventType: "research.proposed" | "research.stale",
      onAppend: () => void,
    ) => ({
      async appendEvent(
        eventContext: RequestContext,
        taskId: string,
        input: Parameters<
          Awaited<ReturnType<typeof createTaskStore>>["appendEvent"]
        >[2],
      ) {
        if (!taskStore) throw new Error("Task store is not ready");
        const event = await taskStore.appendEvent(eventContext, taskId, input);
        if (input.event_type === eventType) {
          onAppend();
          throw new Error("Simulated crash after task event append");
        }
        return event;
      },
    });
    let proposedAppended!: () => void;
    const proposedAppend = new Promise<void>((resolve) => {
      proposedAppended = resolve;
    });
    const env = await setup({
      worker: worker("1"),
      service: {
        autoStart: false,
        events: failingSink("research.proposed", proposedAppended),
      },
    });
    taskStore = env.tasks;
    const id = await request(env.service, env.now, "outbox-stable");
    await env.service.pump();
    await proposedAppend;
    await waitFor(
      async () =>
        (await env.service.inspect(context(), id)).status === "completed",
    );
    await env.service.close();

    const proposedReplay = await createResearchService({
      rootDir: env.researchRoot,
      tasks: env.tasks,
      artifacts: env.tasks.artifacts,
      events: env.tasks,
      worker: worker("2"),
      autoStart: false,
      now: env.now,
    });
    services.push(proposedReplay);
    await proposedReplay.pump();
    const proposedEvents = (
      await collect(env.tasks.events(context(), env.task.task_id))
    ).filter((event) => event.event_type === "research.proposed");
    expect(proposedEvents).toHaveLength(1);
    expect(proposedEvents[0]?.versions).toContainEqual({
      component: "worker:outbox-versioned-worker",
      revision: "1",
    });
    await proposedReplay.close();

    let staleAppended!: () => void;
    const staleAppend = new Promise<void>((resolve) => {
      staleAppended = resolve;
    });
    const staleReplay = await createResearchService({
      rootDir: env.researchRoot,
      tasks: env.tasks,
      artifacts: env.tasks.artifacts,
      events: failingSink("research.stale", staleAppended),
      worker: worker("2"),
      autoStart: false,
      now: env.now,
    });
    services.push(staleReplay);
    await staleReplay.markStale(context("outbox-stable-stale"), id);
    await staleAppend;
    await staleReplay.close();

    const finalReplay = await createResearchService({
      rootDir: env.researchRoot,
      tasks: env.tasks,
      artifacts: env.tasks.artifacts,
      events: env.tasks,
      worker: worker("2"),
      autoStart: false,
      now: env.now,
    });
    services.push(finalReplay);
    await finalReplay.pump();
    const events = await collect(env.tasks.events(context(), env.task.task_id));
    const staleEvents = events.filter(
      (event) => event.event_type === "research.stale",
    );
    expect(staleEvents).toHaveLength(1);
    expect(staleEvents[0]?.versions).toContainEqual({
      component: "worker:outbox-versioned-worker",
      revision: "1",
    });
  });

  test("close leaves a blocked outbox event pending for safe replay", async () => {
    let taskStore: Awaited<ReturnType<typeof createTaskStore>> | undefined;
    let appendStarted!: () => void;
    let releaseAppend!: () => void;
    const appendStartedPromise = new Promise<void>((resolve) => {
      appendStarted = resolve;
    });
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const eventSink = {
      async appendEvent(
        eventContext: RequestContext,
        taskId: string,
        input: Parameters<
          Awaited<ReturnType<typeof createTaskStore>>["appendEvent"]
        >[2],
      ) {
        appendStarted();
        await appendGate;
        if (!taskStore) throw new Error("Task store is not ready");
        return taskStore.appendEvent(eventContext, taskId, input);
      },
    };
    const env = await setup({
      service: { autoStart: false, events: eventSink },
    });
    taskStore = env.tasks;
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);
    try {
      const id = await request(env.service, env.now, "close-outbox");
      await env.service.pump();
      await appendStartedPromise;
      const close = env.service.close({ drainMs: 500 });
      releaseAppend();
      await close;
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).toEqual([]);

      const db = new Database(path.join(env.researchRoot, "research.sqlite"));
      const outbox = db
        .query(
          "SELECT event_state FROM findings WHERE request_id = ? ORDER BY seq",
        )
        .get(id) as { event_state: string } | null;
      db.close();
      expect(outbox?.event_state).toBe("pending");

      const replay = await createResearchService({
        rootDir: env.researchRoot,
        tasks: env.tasks,
        artifacts: env.tasks.artifacts,
        events: env.tasks,
        worker: publishingWorker(env.now),
        autoStart: false,
        now: env.now,
      });
      services.push(replay);
      await replay.pump();
      const events = (
        await collect(env.tasks.events(context(), env.task.task_id))
      ).filter((event) => event.event_type === "research.proposed");
      expect(events).toHaveLength(1);
    } finally {
      releaseAppend();
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  test("repeats a coalesced flush after later findings are published", async () => {
    let taskStore: Awaited<ReturnType<typeof createTaskStore>> | undefined;
    let firstAppendStarted!: () => void;
    let releaseFirstAppend!: () => void;
    const firstAppendStartedPromise = new Promise<void>((resolve) => {
      firstAppendStarted = resolve;
    });
    const firstAppendGate = new Promise<void>((resolve) => {
      releaseFirstAppend = resolve;
    });
    let appendBlocked = false;
    const eventSink = {
      async appendEvent(
        eventContext: RequestContext,
        taskId: string,
        input: Parameters<
          Awaited<ReturnType<typeof createTaskStore>>["appendEvent"]
        >[2],
      ) {
        if (!appendBlocked && input.event_type === "research.proposed") {
          appendBlocked = true;
          firstAppendStarted();
          await firstAppendGate;
        }
        if (!taskStore) throw new Error("Task store is not ready");
        return taskStore.appendEvent(eventContext, taskId, input);
      },
    };
    const worker: ResearchWorker = {
      id: "coalescing-worker",
      version: "1",
      async run(input, workerContext) {
        if (input.question === "Second concurrent finding") {
          await firstAppendStartedPromise;
        }
        const evidence = await capture(
          workerContext,
          Date.now,
          input.request_id,
        );
        await workerContext.publish(
          proposal(
            evidence.ref,
            evidence.url,
            evidence.retrievedAt,
            `finding-${input.request_id}`,
          ),
        );
      },
    };
    const env = await setup({
      worker,
      service: {
        autoStart: false,
        maxConcurrency: 2,
        events: eventSink,
      },
    });
    taskStore = env.tasks;
    const firstId = await request(env.service, env.now, "flush-first", {
      question: "First concurrent finding",
    });
    const secondId = await request(env.service, env.now, "flush-second", {
      question: "Second concurrent finding",
    });

    try {
      await env.service.pump();
      await firstAppendStartedPromise;
      await waitFor(
        async () =>
          (await env.service.inspect(context("flush-second"), secondId))
            .status === "completed",
      );
      const laterPump = env.service.pump();
      releaseFirstAppend();
      await laterPump;

      const events = (
        await collect(env.tasks.events(context(), env.task.task_id))
      ).filter((event) => event.event_type === "research.proposed");
      expect(events).toHaveLength(2);
      const db = new Database(path.join(env.researchRoot, "research.sqlite"));
      const pendingCount = db
        .query(
          "SELECT COUNT(*) AS count FROM findings WHERE event_state = 'pending'",
        )
        .get() as { count: number };
      db.close();
      expect(pendingCount.count).toBe(0);
      expect(
        await env.service.inspect(context("flush-first"), firstId),
      ).toMatchObject({ status: "completed" });
    } finally {
      releaseFirstAppend();
    }
  });

  test("hardens store paths, avoids exposing them, and rejects corrupt records", async () => {
    let workerInput: Record<string, unknown> | undefined;
    const worker: ResearchWorker = {
      id: "privacy-worker",
      version: "1",
      async run(input, workerContext) {
        workerInput = input as unknown as Record<string, unknown>;
        const evidence = await capture(
          workerContext,
          Date.now,
          input.request_id,
        );
        await workerContext.publish(
          proposal(evidence.ref, evidence.url, evidence.retrievedAt),
        );
      },
    };
    const env = await setup({ worker });
    const id = await request(env.service, env.now, "privacy");
    await waitFor(
      async () =>
        (await env.service.inspect(context(), id)).status === "completed",
    );
    const job = await env.service.inspect(context(), id);
    const findings = await env.service.readFindings(context(), id);
    expect(
      JSON.stringify([job, await env.service.list(context()), findings]),
    ).not.toContain(env.root);
    expect(workerInput).not.toHaveProperty("scope");
    expect(lstatSync(env.researchRoot).mode & 0o777).toBe(0o700);
    expect(
      lstatSync(path.join(env.researchRoot, "research.sqlite")).mode & 0o777,
    ).toBe(0o600);
    chmodSync(env.researchRoot, 0o777);
    await env.service.close();
    const modeCheck = await createResearchService({
      rootDir: env.researchRoot,
      tasks: env.tasks,
      artifacts: env.tasks.artifacts,
      worker,
      autoStart: false,
      now: env.now,
    });
    services.push(modeCheck);
    expect(lstatSync(env.researchRoot).mode & 0o777).toBe(0o700);

    const privateRoot = path.join(env.root, "host-private");
    mkdirSync(privateRoot);
    expect(
      await errorCode(() =>
        createResearchService({
          rootDir: path.join(privateRoot, "store"),
          hostPrivateRoots: [privateRoot],
          tasks: env.tasks,
          artifacts: env.tasks.artifacts,
          worker,
        }),
      ),
    ).toBe("unsafe_path");
    const target = path.join(env.root, "symlink-target");
    mkdirSync(target);
    const link = path.join(env.root, "research-link");
    symlinkSync(target, link);
    expect(
      await errorCode(() =>
        createResearchService({
          rootDir: link,
          tasks: env.tasks,
          artifacts: env.tasks.artifacts,
          worker,
        }),
      ),
    ).toBe("unsafe_path");
    const foreign = path.join(env.root, "foreign");
    mkdirSync(foreign);
    writeFileSync(path.join(foreign, "unrelated"), "data");
    expect(
      await errorCode(() =>
        createResearchService({
          rootDir: foreign,
          tasks: env.tasks,
          artifacts: env.tasks.artifacts,
          worker,
        }),
      ),
    ).toBe("unsafe_path");

    await modeCheck.close();
    const db = new Database(path.join(env.researchRoot, "research.sqlite"));
    db.query("UPDATE findings SET record_json = ?").run("{}");
    db.close();
    const reopened = await createResearchService({
      rootDir: env.researchRoot,
      tasks: env.tasks,
      artifacts: env.tasks.artifacts,
      worker,
      autoStart: false,
      now: env.now,
    });
    services.push(reopened);
    expect(await errorCode(() => reopened.readFindings(context(), id))).toBe(
      "corrupt_record",
    );
  });

  test("contains no network fetch path in package source", () => {
    const files: string[] = [];
    const visit = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(fullPath);
        else if (entry.isFile() && fullPath.endsWith(".ts"))
          files.push(fullPath);
      }
    };
    visit(import.meta.dir);
    for (const file of files) {
      expect(readFileSync(file, "utf8")).not.toMatch(/\bfetch\s*\(/);
    }
  });

  test("propagates cancellation, staleness, and deadline expiry across Bun processes", async () => {
    const env = await setup({
      service: { autoStart: false, leaseMs: 150, pollMs: 10 },
    });
    const childPath = path.join(
      import.meta.dir,
      "test-fixtures",
      "cross-process-worker.ts",
    );
    const child = Bun.spawn(
      [
        process.execPath,
        childPath,
        JSON.stringify({
          tasksRoot: env.taskRoot,
          researchRoot: env.researchRoot,
        }),
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    children.push(child);
    if (!child.stdout || !child.stderr) {
      throw new Error("Cross-process fixture pipes were not created");
    }
    const output = childOutputReader(child.stdout);
    const stderr = new Response(child.stderr).text();
    const nextOutput = async (
      kind: string,
      requestId: string,
    ): Promise<ChildOutput> => {
      try {
        return await output.next(kind, requestId);
      } catch (error) {
        if (child.exitCode === null) child.kill();
        throw new Error(
          `${String(error)} (child exit ${child.exitCode}): ${await stderr}`,
        );
      }
    };

    const cancelledId = await request(env.service, env.now, "cross-cancel");
    await nextOutput("ready", cancelledId);
    await env.service.cancel(context("cancel-cross"), cancelledId);
    expect((await env.service.inspect(context(), cancelledId)).status).toBe(
      "cancelled",
    );
    expect(await env.service.readFindings(context(), cancelledId)).toHaveLength(
      1,
    );
    const cancelledWrite = await nextOutput("late-write", cancelledId);
    expect(cancelledWrite.code).toBe("cancelled");

    const staleId = await request(env.service, env.now, "cross-stale");
    await nextOutput("ready", staleId);
    await env.service.markStale(context("stale-cross"), staleId);
    expect((await env.service.inspect(context(), staleId)).status).toBe(
      "cancelled",
    );
    expect(
      (await env.service.readFindings(context(), staleId))[0]?.status,
    ).toBe("stale");
    expect((await nextOutput("late-write", staleId)).code).toBe("cancelled");

    const deadline = Date.now() + 500;
    const deadlineId = await request(env.service, env.now, "cross-deadline", {
      deadline: new Date(deadline).toISOString(),
      budget: {
        ...makeRequest(env.now).budget,
        max_duration_ms: 5_000,
      },
    });
    await nextOutput("ready", deadlineId);
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await env.service.pump();
    expect((await env.service.inspect(context(), deadlineId)).status).toBe(
      "expired",
    );
    expect((await nextOutput("late-write", deadlineId)).code).toBe(
      "deadline_exceeded",
    );
    const exitCode = await Promise.race([
      child.exited,
      new Promise<number>((resolve) => setTimeout(() => resolve(-1), 1000)),
    ]);
    if (exitCode === -1) {
      child.kill();
      throw new Error(`Cross-process fixture did not exit: ${await stderr}`);
    }
    expect(exitCode).toBe(0);
  });
});
