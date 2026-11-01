import type { RequestContext, Task } from "@mars/contracts";
import type { RoutingDecision, RoutingRequest } from "@mars/specialists";
import { z } from "zod";
import type { Approvals } from "./protocol";

/** The only registry capability the workbench needs: evidence-gated routing. */
export interface SpecialistRouter {
  route(
    context: RequestContext,
    request: RoutingRequest,
  ): Promise<RoutingDecision>;
}

export interface WorkbenchSpecialists {
  router: SpecialistRouter;
  /** Task coverage key (\`area/kind\`) this workbench's tasks are evaluated under. */
  domain: string;
  complexity?: "light" | "medium" | "heavy";
  /** Paid specialists also require the model registry policy to allow paid routing. */
  paid_consent?: boolean;
}

export const FrozenRoutingSchema = z
  .object({
    decision_id: z.string().uuid(),
    outcome: z.enum([
      "specialist",
      "baseline",
      "unavailable",
      "override_rejected",
    ]),
    ref: z.string().min(1).nullable(),
    specialist_revision: z.string().min(1).nullable(),
    model_id: z.string().min(1).nullable(),
  })
  .strict();
export type FrozenRouting = z.infer<typeof FrozenRoutingSchema>;

export function routingRequest(
  task: Task,
  approvals: Approvals,
  specialists: Pick<
    WorkbenchSpecialists,
    "domain" | "complexity" | "paid_consent"
  >,
  minContextTokens: number,
): RoutingRequest {
  return {
    schema_version: 1,
    task_id: task.task_id,
    role: "worker",
    domain: specialists.domain,
    complexity: specialists.complexity ?? "medium",
    requires: {
      tools: Object.values(approvals).some(Boolean),
      vision: false,
      reasoning: false,
      min_context_tokens: minContextTokens,
    },
    budget: task.budget,
    paid_consent: specialists.paid_consent === true,
  };
}

/**
 * Routes one launch. A specialist is only selected when the registry holds
 * promoted, verified evidence for it; every other outcome leaves the model
 * choice to the ordinary registry default. The decision is persisted by the
 * caller so the session stays pinned to it across resume.
 */
export async function routeLaunch(
  context: RequestContext,
  task: Task,
  approvals: Approvals,
  specialists: WorkbenchSpecialists,
  minContextTokens: number,
): Promise<FrozenRouting> {
  const decision = await specialists.router.route(
    context,
    routingRequest(task, approvals, specialists, minContextTokens),
  );
  const selected =
    decision.outcome === "specialist" || decision.outcome === "baseline"
      ? decision.selected
      : null;
  return FrozenRoutingSchema.parse({
    decision_id: decision.decision_id,
    outcome: decision.outcome,
    ref: selected?.ref ?? null,
    specialist_revision:
      decision.outcome === "specialist" && selected ? selected.ref : null,
    model_id: selected?.model_id ?? null,
  });
}
