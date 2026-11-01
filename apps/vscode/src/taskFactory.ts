import {
  type Budget,
  BudgetSchema,
  SCHEMA_VERSION,
  type Scope,
  type Task,
  TaskSchema,
} from "@mars/contracts";

export interface NewTaskInput {
  request: string;
  acceptance_criteria: readonly string[];
  budget: Budget;
}

export const MAX_REQUEST_CHARS = 20_000;
export const MAX_CRITERIA = 50;

export type BuildResult =
  | { ok: true; task: Task }
  | { ok: false; reason: string };

/**
 * Builds a pending revision-0 task. The user must supply the request, at least
 * one acceptance criterion and every budget limit explicitly; nothing is
 * defaulted on their behalf.
 */
export function buildPendingTask(
  input: NewTaskInput,
  scope: Scope,
  newId: () => string,
): BuildResult {
  const request = input.request.trim();
  if (!request) return { ok: false, reason: "Describe the task request." };
  if (request.length > MAX_REQUEST_CHARS)
    return { ok: false, reason: "Task request is too long." };
  const criteria = input.acceptance_criteria
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (criteria.length === 0)
    return { ok: false, reason: "Add at least one acceptance criterion." };
  if (criteria.length > MAX_CRITERIA)
    return { ok: false, reason: "Too many acceptance criteria." };
  const budget = BudgetSchema.safeParse(input.budget);
  if (!budget.success)
    return {
      ok: false,
      reason:
        "Budget needs positive token, duration and concurrency limits, a non-negative USD limit and depth.",
    };
  const task = TaskSchema.safeParse({
    schema_version: SCHEMA_VERSION,
    task_id: `task-${newId()}`,
    session_id: `session-${newId()}`,
    scope,
    revision: 0,
    request,
    acceptance_criteria: criteria,
    budget: budget.data,
    status: "pending",
    specialist_revision: null,
    artifacts: [],
  });
  if (!task.success) return { ok: false, reason: "Task is invalid." };
  return { ok: true, task: task.data };
}
