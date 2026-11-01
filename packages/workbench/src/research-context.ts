import type { RequestContext, ResearchFinding, Task } from "@mars/contracts";
import type { RuntimeResearch } from "@mars/execution";
import type { DurableResearchService } from "@mars/research";

/** The parent-owned research service surface the workbench uses. */
export type WorkbenchResearch = Pick<
  DurableResearchService,
  | "submit"
  | "readFindings"
  | "inspect"
  | "reconcileTask"
  | "list"
  | "markStale"
  | "cancel"
>;

/** Default research deadline after submission, bounded by the task's max duration. */
export const RESEARCH_DEADLINE_MS = 10 * 60 * 1000;
const MAX_RENDERED_FINDINGS = 20;
const MAX_FIELD_CHARS = 2048;
/** Keeps the rendered findings inside the runtime's 128 KiB tool-output bound. */
const MAX_OUTPUT_CHARS = 96 * 1024;

function clip(value: string): string {
  return value.length > MAX_FIELD_CHARS
    ? `${value.slice(0, MAX_FIELD_CHARS)}…`
    : value;
}

/** Renders a finding as clearly untrusted, cited evidence. */
export function renderUntrustedFinding(finding: ResearchFinding): string {
  return [
    `[untrusted research finding ${finding.finding_id} · ${finding.status} · confidence ${finding.confidence}]`,
    `Claim: ${clip(finding.claim)}`,
    `Recommendation: ${clip(finding.recommendation)}`,
    ...finding.remaining_uncertainty
      .slice(0, 8)
      .map((item) => `Uncertainty: ${clip(item)}`),
    ...finding.sources.map(
      (source) => `Source: ${source.url} (retrieved ${source.retrieved_at})`,
    ),
  ].join("\n");
}

/** Supersedes every research request of a task after its instructions change. */
export async function staleTaskResearch(
  service: WorkbenchResearch,
  context: RequestContext,
  taskId: string,
): Promise<void> {
  const jobs = await service.list(context, { task_id: taskId });
  for (const job of jobs) {
    if (job.task_id !== taskId || job.stale) continue;
    await service.markStale(context, job.request_id).catch(() => undefined);
    if (!TERMINAL_RESEARCH.has(job.status))
      await service.cancel(context, job.request_id).catch(() => undefined);
  }
}
const TERMINAL_RESEARCH = new Set([
  "completed",
  "failed",
  "cancelled",
  "expired",
]);

/**
 * Binds the session's research tools to the parent-owned service host-side.
 * Requests are scoped to the task and its current durable revision and never
 * exceed the task budget; the model only ever sees rendered untrusted text.
 */
export function researchTools(
  service: WorkbenchResearch,
  context: () => RequestContext,
  currentTask: () => Promise<Task>,
  taskDeadline: () => number,
  now: () => number = Date.now,
): RuntimeResearch {
  return {
    async submit(input) {
      const task = await currentTask();
      const remaining = taskDeadline() - now();
      if (remaining <= 0)
        throw new Error(
          "The task deadline has passed; research cannot be queued.",
        );
      const deadline = new Date(
        now() + Math.min(RESEARCH_DEADLINE_MS, remaining),
      ).toISOString();
      const requestId = await service.submit(context(), {
        question: input.question,
        task_id: task.task_id,
        task_revision: task.revision,
        known_context: [],
        source_requirements: input.source_requirements ?? [],
        deadline,
        budget: task.budget,
      });
      return `Queued research request ${requestId} (deadline ${deadline}). Read its findings later with mars_findings.`;
    },
    async findings(requestId) {
      const task = await currentTask();
      const job = await service.inspect(context(), requestId);
      if (job.task_id !== task.task_id)
        throw new Error("Unknown research request for this task.");
      const findings = await service.readFindings(context(), requestId);
      const header = `Research request ${job.request_id}: ${job.status}${job.stale ? " (stale: the task changed since it was asked)" : ""}, ${job.finding_count} finding(s).`;
      if (findings.length === 0) return header;
      const rendered: string[] = [];
      let size = header.length;
      for (const finding of findings.slice(0, MAX_RENDERED_FINDINGS)) {
        const text = renderUntrustedFinding(finding);
        if (size + text.length + 2 > MAX_OUTPUT_CHARS) break;
        rendered.push(text);
        size += text.length + 2;
      }
      const omitted = findings.length - rendered.length;
      return [
        header,
        ...rendered,
        omitted > 0 ? String(omitted) + " more finding(s) not shown." : "",
      ]
        .filter(Boolean)
        .join("\n\n");
    },
  };
}
