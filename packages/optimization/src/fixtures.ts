import type {
  InstanceScore,
  PromptCandidate,
  PromptScoringBackend,
  RequestContext,
  ScoringRequest,
  ScoringResult,
} from "@mars/contracts";
import { canonicalJson, sha256 } from "./canonical";

/**
 * SIMULATED scoring for tests and dry runs. Scores are a deterministic
 * function of the candidate text and instance id; no model or benchmark runs.
 * Every result is marked `simulated: true` and the feedback says so.
 */
export interface FixtureScore {
  score: number;
  feedback?: string;
  error?: string | null;
  reward_valid?: boolean;
}

export interface FixtureScoringOptions {
  id?: string;
  score: (
    candidate: PromptCandidate,
    instanceId: string,
  ) => number | FixtureScore;
  cost_usd_per_instance?: number | null;
  runtime_ms_per_instance?: number;
}

export interface FixtureScoringBackend extends PromptScoringBackend {
  readonly id: string;
  readonly requests: ScoringRequest[];
}

export function hashUnit(...parts: string[]): number {
  const digest = sha256(parts.join("\u0000"));
  return Number.parseInt(digest.slice(0, 8), 16) / 0x1_0000_0000;
}

export function createFixtureScoringBackend(
  options: FixtureScoringOptions,
): FixtureScoringBackend {
  const requests: ScoringRequest[] = [];
  const costPer =
    options.cost_usd_per_instance === undefined
      ? 0
      : options.cost_usd_per_instance;
  const runtimePer = options.runtime_ms_per_instance ?? 1;
  return {
    id: options.id ?? "fixture-scoring",
    requests,
    async score(
      _context: RequestContext,
      request: ScoringRequest,
    ): Promise<ScoringResult> {
      requests.push(request);
      const scores: InstanceScore[] = request.instance_ids.map(
        (instance_id) => {
          const raw = options.score(request.candidate, instance_id);
          const detail: FixtureScore =
            typeof raw === "number" ? { score: raw } : raw;
          const score = Math.min(1, Math.max(0, detail.score));
          return {
            instance_id,
            score,
            reward_valid: detail.reward_valid ?? true,
            runtime_ms: runtimePer,
            cost_usd: costPer,
            error: detail.error ?? null,
            trajectory: null,
            feedback:
              detail.feedback ??
              `[simulated fixture feedback] instance ${instance_id} scored ${score.toFixed(3)}; no model or benchmark ran.`,
          };
        },
      );
      const mean =
        scores.reduce((sum, item) => sum + item.score, 0) /
        Math.max(1, scores.length);
      return {
        request_sha256: sha256(canonicalJson(request)),
        split: request.split,
        scores,
        mean_score: Math.min(1, Math.max(0, mean)),
        cost_usd: costPer === null ? null : costPer * scores.length,
        runtime_ms: runtimePer * scores.length,
        simulated: true,
      };
    },
  };
}

/** Rewards candidates whose components mention any keyword; otherwise a stable hash score. */
export function keywordScore(
  keywords: readonly string[],
  base = 0.25,
  bonus = 0.5,
): FixtureScoringOptions["score"] {
  return (candidate, instanceId) => {
    const text = Object.values(candidate.components).join("\n").toLowerCase();
    const hit = keywords.some((keyword) =>
      text.includes(keyword.toLowerCase()),
    );
    const jitter = hashUnit(instanceId) * 0.2;
    const score = base + jitter + (hit ? bonus : 0);
    return {
      score,
      feedback: hit
        ? `[simulated fixture feedback] instance ${instanceId}: the prompt mentions ${keywords.join("/")}, which this fixture rewards.`
        : `[simulated fixture feedback] instance ${instanceId}: the prompt never mentions ${keywords.join("/")}; the fixture scores it low.`,
    };
  };
}

/** Same score for every candidate: a run that can only produce `no_improvement`. */
export function constantScore(value: number): FixtureScoringOptions["score"] {
  return () => ({
    score: value,
    feedback: `[simulated fixture feedback] constant score ${value}; candidate text is ignored.`,
  });
}
