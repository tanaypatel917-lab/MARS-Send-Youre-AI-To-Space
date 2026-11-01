import { createTaskStore } from "@mars/tasks";
import { createResearchService, type ResearchWorker } from "../index";

interface FixtureInput {
  tasksRoot: string;
  researchRoot: string;
}

const fixture = JSON.parse(process.argv[2] ?? "{}") as FixtureInput;
let service: Awaited<ReturnType<typeof createResearchService>> | undefined;
let runCount = 0;
const keepAlive = setInterval(() => {}, 50);

const tasks = await createTaskStore({
  rootDir: fixture.tasksRoot,
  workspaceRoots: [],
});

const worker: ResearchWorker = {
  id: "cross-process-fixture",
  version: "1",
  async run(input, context) {
    runCount += 1;
    const url = `https://evidence.example/${input.request_id}`;
    const retrievedAt = new Date().toISOString();
    const evidence = await context.captureEvidence({
      url,
      retrieved_at: retrievedAt,
      media_type: "text/plain",
      data: new TextEncoder().encode("captured test evidence"),
    });
    const proposal = {
      finding_key: `finding-${input.request_id}`,
      claim: "The captured evidence is available.",
      recommendation: "Review the captured evidence.",
      confidence: "medium" as const,
      remaining_uncertainty: [],
      sources: [{ url, retrieved_at: retrievedAt, evidence }],
    };
    await context.publish(proposal);
    process.stdout.write(
      `${JSON.stringify({ kind: "ready", request_id: input.request_id })}\n`,
    );
    await new Promise<void>((resolve) => {
      if (context.signal.aborted) {
        resolve();
        return;
      }
      context.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    let code = "unknown";
    try {
      await context.publish(proposal);
    } catch (error) {
      code =
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        typeof (error as { code?: unknown }).code === "string"
          ? (error as { code: string }).code
          : "other";
    }
    process.stdout.write(
      `${JSON.stringify({ kind: "late-write", request_id: input.request_id, code })}\n`,
    );
    if (runCount === 3) {
      await service?.close({ drainMs: 0 });
      await tasks.close();
      clearInterval(keepAlive);
    }
  },
};

service = await createResearchService({
  rootDir: fixture.researchRoot,
  tasks,
  artifacts: tasks.artifacts,
  worker,
  maxConcurrency: 1,
  leaseMs: 150,
  pollMs: 10,
});
