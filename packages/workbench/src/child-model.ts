import { selectExecutionModel } from "@mars/execution";
import type { FrozenRouting } from "./specialist-routing";

type Registry = Parameters<typeof selectExecutionModel>[0];

export interface ChildModelChoice {
  model_id: string;
  reason: string;
  /** Reviewer children only: whether the model differs from every excluded one. */
  independent: boolean | null;
}

function eligible(registry: Registry, id: string) {
  try {
    const model = selectExecutionModel(registry, id, true);
    return model.pricing.free === true && model.capabilities.tools
      ? model
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Picks a child's model from the routed specialist (free + tool-capable only)
 * and the registry's free defaults. A reviewer never grades its own author's
 * work when any other eligible model exists: models in `excluded` (the
 * coordinator's and the task's earlier children's) are skipped first and the
 * outcome is recorded so the task timeline shows whether the review was
 * independent.
 */
export function chooseChildModel(
  registry: Registry,
  routing: FrozenRouting | null,
  excluded: ReadonlySet<string>,
  reviewer: boolean,
): ChildModelChoice {
  const specialist =
    routing?.outcome === "specialist" && routing.model_id
      ? routing.model_id
      : null;
  const candidates = [
    ...(specialist ? [specialist] : []),
    ...(registry.routes.default ?? []),
  ].filter((id, index, all) => all.indexOf(id) === index);
  const describe = (id: string) =>
    id === specialist && routing
      ? "specialist " + routing.decision_id
      : "workbench free default" +
        (routing ? " (" + routing.outcome + ")" : "");
  if (reviewer) {
    for (const id of candidates)
      if (!excluded.has(id) && eligible(registry, id))
        return {
          model_id: id,
          reason: describe(id) + "; independent reviewer",
          independent: true,
        };
  }
  for (const id of candidates)
    if (eligible(registry, id))
      return {
        model_id: id,
        reason: reviewer
          ? describe(id) + "; reviewer not independent (no other free model)"
          : describe(id),
        independent: reviewer ? false : null,
      };
  const fallback = selectExecutionModel(registry, undefined, true);
  return {
    model_id: fallback.id,
    reason: reviewer
      ? "workbench free default; reviewer not independent (no other free model)"
      : "workbench free default",
    independent: reviewer ? false : null,
  };
}

export function isReviewerRole(roleLabel: string): boolean {
  // Any label mentioning review (reviewer, code-review, peerreviewer) is a
  // reviewer; a false negative would silently skip the independence rule.
  return /review/i.test(roleLabel);
}
