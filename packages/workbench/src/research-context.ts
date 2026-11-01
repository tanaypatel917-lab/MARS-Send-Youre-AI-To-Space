import type { RequestContext, ResearchFinding, Task } from "@mars/contracts";
import type { RuntimeResearch } from "@mars/execution";
import type { DurableResearchService } from "@mars/research";

/** The parent-owned research service surface the workbench uses. */
export type WorkbenchResearch = Pick<
  DurableResearchService,
  "submit" | "readFindings" | "inspect" | "reconcileTask"
>;

/** Default research deadline after submission, bounded by the task's max duration. */
export const RESEARCH_DEADLINE_MS = 10 * 60 * 1000;
const MAX_RENDERED_FINDINGS = 20;
const MAX_FIELD_CHARS = 2048;

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

/**
 * Binds the session's research tools to the parent-owned service host-side.
 * Requests are scoped to the task and its current durable revision and never
 * exceed the task budget; the model only ever sees rendered untrusted text.
 */
export function researchTools(
  service: WorkbenchResearch,
  context: () => RequestContext,
  currentTask: () => Promise<Task>,
  now: () => number = Date.now,
): RuntimeResearch {
  return {
    async submit(input) {
      const task = await currentTask();
      const deadline = new Date(
        now() + Math.min(RESEARCH_DEADLINE_MS, task.budget.max_duration_ms),
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
      const job = await service.inspect(context(), requestId);
      const findings = await service.readFindings(context(), requestId);
      const header = `Research request ${job.request_id}: ${job.status}${job.stale ? " (stale: the task changed since it was asked)" : ""}, ${job.finding_count} finding(s).`;
      if (findings.length === 0) return header;
      return [
        header,
        ...findings.slice(0, MAX_RENDERED_FINDINGS).map(renderUntrustedFinding),
        findings.length > MAX_RENDERED_FINDINGS
          ? `${findings.length - MAX_RENDERED_FINDINGS} more finding(s) not shown.`
          : "",
      ]
        .filter(Boolean)
        .join("\n\n");
    },
  };
}
