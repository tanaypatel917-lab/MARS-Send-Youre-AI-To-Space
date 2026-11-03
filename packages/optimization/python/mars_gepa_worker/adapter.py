"""GEPAAdapter whose evaluate() is brokered to the host's PromptScoringBackend."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any

from .protocol import Broker, ProtocolError
from .scrub import bounded, evidence, scrub_secrets

Candidate = dict[str, str]


@dataclass(frozen=True)
class Trace:
    instance_id: str
    split: str
    summary: str
    score: float
    reward_valid: bool
    error: str | None
    feedback: str


def candidate_id(components: Candidate) -> str:
    canonical = json.dumps(components, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return "cand-" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:24]


class BrokeredAdapter:
    """evaluate() -> host `score` request; make_reflective_dataset -> bounded untrusted records."""

    def __init__(
        self,
        broker: Broker,
        *,
        repeats: int,
        budget: dict[str, Any],
        created_at: str,
        max_feedback_chars: int,
        max_records_per_component: int,
    ) -> None:
        self._broker = broker
        self._repeats = repeats
        self._budget = budget
        self._created_at = created_at
        self._max_feedback_chars = max_feedback_chars
        self._max_records = max_records_per_component
        self.metric_calls = 0

    propose_new_texts = None

    def _requests(self, candidate: Candidate, batch: list[dict[str, Any]]) -> list[dict[str, Any]]:
        by_split: dict[str, list[str]] = {}
        for item in batch:
            split = item["split"]
            if split not in ("train", "validation"):
                raise ProtocolError(f"instance {item.get('instance_id')!r} has forbidden split {split!r}")
            by_split.setdefault(split, []).append(item["instance_id"])
        return [
            {
                "type": "score",
                "request": {
                    "candidate": {
                        "candidate_id": candidate_id(candidate),
                        "components": dict(candidate),
                        "parent_candidate_id": None,
                        "created_at": self._created_at,
                    },
                    "split": split,
                    "instance_ids": ids,
                    "repeats": self._repeats,
                    "budget": self._budget,
                },
            }
            for split, ids in sorted(by_split.items())
        ]

    def batch_evaluate(self, items: list[tuple[Candidate, list[dict[str, Any]]]]) -> list[Any]:
        from gepa import EvaluationBatch

        plan: list[list[dict[str, Any]]] = [self._requests(candidate, batch) for candidate, batch in items]
        flat = [request for requests in plan for request in requests]
        replies = iter(self._broker.request_many(flat, "score_result"))
        batches: list[Any] = []
        for (candidate, batch), requests in zip(items, plan, strict=True):
            scores_by_id: dict[str, dict[str, Any]] = {}
            for _request in requests:
                result = next(replies)["result"]
                for score in result["scores"]:
                    scores_by_id[score["instance_id"]] = score
            traces: list[Trace] = []
            for item in batch:
                score = scores_by_id.get(item["instance_id"])
                if score is None:
                    raise ProtocolError(f"host returned no score for {item['instance_id']!r}")
                traces.append(
                    Trace(
                        instance_id=item["instance_id"],
                        split=item["split"],
                        summary=item.get("summary", ""),
                        score=float(score["score"]),
                        reward_valid=bool(score.get("reward_valid", True)),
                        error=score.get("error"),
                        feedback=str(score.get("feedback", "")),
                    )
                )
            self.metric_calls += len(batch)
            batches.append(
                EvaluationBatch(
                    outputs=[{"instance_id": trace.instance_id, "score": trace.score} for trace in traces],
                    scores=[trace.score for trace in traces],
                    trajectories=traces,
                    num_metric_calls=len(batch),
                )
            )
        return batches

    def evaluate(self, batch: list[dict[str, Any]], candidate: Candidate, capture_traces: bool = False) -> Any:
        result = self.batch_evaluate([(candidate, batch)])[0]
        if not capture_traces:
            result.trajectories = None
        return result

    def make_reflective_dataset(
        self,
        candidate: Candidate,
        eval_batch: Any,
        components_to_update: list[str],
    ) -> dict[str, list[dict[str, Any]]]:
        traces: list[Trace] = list(eval_batch.trajectories or [])
        # Lowest scores first so failures drive the reflection; ties stay deterministic.
        traces.sort(key=lambda trace: (trace.score, trace.instance_id))
        dataset: dict[str, list[dict[str, Any]]] = {}
        for component in components_to_update:
            text = candidate.get(component, "")
            records: list[dict[str, Any]] = []
            for trace in traces[: self._max_records]:
                feedback_parts = [f"score {trace.score:.3f} of 1.000"]
                if not trace.reward_valid:
                    feedback_parts.append("reward marked invalid by the scorer")
                if trace.error:
                    feedback_parts.append(
                        "error: " + bounded(scrub_secrets(trace.error), self._max_feedback_chars // 2)
                    )
                records.append(
                    {
                        "Inputs": {
                            "instance_id": trace.instance_id,
                            "split": trace.split,
                            "instance_summary": evidence(trace.summary, self._max_feedback_chars // 2),
                            "component_excerpt": bounded(scrub_secrets(text), 400),
                        },
                        "Generated Outputs": evidence(trace.feedback, self._max_feedback_chars),
                        "Feedback": "; ".join(feedback_parts),
                        "score": trace.score,
                    }
                )
            dataset[component] = records
        return dataset
