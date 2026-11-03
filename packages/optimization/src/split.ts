import { sha256 } from "./canonical";
import type { SplitPolicy } from "./schemas";

export interface TargetSplit {
  train: string[];
  validation: string[];
  final_holdout: string[];
}

/** Deterministic xorshift-style generator seeded from a string. */
function seededRandom(seed: string): () => number {
  const digest = sha256(seed);
  let a = Number.parseInt(digest.slice(0, 8), 16) >>> 0;
  let b = Number.parseInt(digest.slice(8, 16), 16) >>> 0;
  let c = Number.parseInt(digest.slice(16, 24), 16) >>> 0;
  let d = Number.parseInt(digest.slice(24, 32), 16) >>> 0;
  return () => {
    const t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    const r = (t + d) | 0;
    c = (c + r) | 0;
    return (r >>> 0) / 4294967296;
  };
}

/**
 * Splits instance ids into train / validation / final_holdout deterministically
 * from the policy seed. The final holdout always receives at least
 * `min_final_holdout` ids and never overlaps the other splits.
 */
export function splitInstances(
  instanceIds: readonly string[],
  policy: SplitPolicy,
): TargetSplit {
  const ids = [...new Set(instanceIds)].sort();
  if (ids.length < 3) throw new Error("split requires at least 3 instances");
  const random = seededRandom(`${policy.seed}\u0000${ids.join("\u0000")}`);
  for (let i = ids.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const left = ids[i] as string;
    ids[i] = ids[j] as string;
    ids[j] = left;
  }
  const holdoutCount = Math.max(
    policy.min_final_holdout,
    ids.length -
      Math.floor(ids.length * policy.train_fraction) -
      Math.floor(ids.length * policy.validation_fraction),
  );
  if (holdoutCount > ids.length - 2) {
    throw new Error(
      "split requires enough instances for the minimum final holdout plus train and validation",
    );
  }
  const remaining = ids.length - holdoutCount;
  const trainCount = Math.min(
    Math.max(
      1,
      Math.round(
        remaining *
          (policy.train_fraction /
            (policy.train_fraction + policy.validation_fraction)),
      ),
    ),
    remaining - 1,
  );
  const train = ids.slice(0, trainCount).sort();
  const validation = ids.slice(trainCount, remaining).sort();
  const final_holdout = ids.slice(remaining).sort();
  assertDisjoint({ train, validation, final_holdout });
  return { train, validation, final_holdout };
}

export function assertDisjoint(split: TargetSplit): void {
  const all = [...split.train, ...split.validation, ...split.final_holdout];
  if (new Set(all).size !== all.length) throw new Error("split parts overlap");
  if (
    !split.train.length ||
    !split.validation.length ||
    !split.final_holdout.length
  )
    throw new Error("every split part must be non-empty");
}
