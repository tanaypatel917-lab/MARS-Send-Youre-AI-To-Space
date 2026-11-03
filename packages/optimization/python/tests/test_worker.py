"""Offline tests for the GEPA worker: fake host streams, no models, no network."""

from __future__ import annotations

import hashlib
import io
import json
from collections import deque
from typing import Any, Callable

import pytest

from mars_gepa_worker.adapter import BrokeredAdapter, Trace, candidate_id
from mars_gepa_worker.protocol import Broker, Channel, ProtocolError
from mars_gepa_worker.scrub import TRUNCATION_MARKER, UNTRUSTED_LABEL
from mars_gepa_worker.worker import EXIT_ABORTED, EXIT_GEPA_ERROR, EXIT_OK, EXIT_PIN_MISMATCH, EXIT_PROTOCOL, installed_versions, run

Handler = Callable[[dict[str, Any]], dict[str, Any] | None]

BUDGET = {"max_tokens": 100000, "max_usd": 1.0, "max_duration_ms": 60000, "max_depth": 1, "max_concurrency": 2}
KEYWORD = "double-check"


class HostStreams:
    """Acts as the worker's stdin and stdout; replies are computed synchronously."""

    def __init__(self, handler: Handler, first: list[dict[str, Any]]) -> None:
        self.handler = handler
        self.replies: deque[dict[str, Any]] = deque(first)
        self.outgoing: list[dict[str, Any]] = []
        self._buffer = ""

    def write(self, text: str) -> int:
        self._buffer += text
        while "\n" in self._buffer:
            line, self._buffer = self._buffer.split("\n", 1)
            message = json.loads(line)
            self.outgoing.append(message)
            reply = self.handler(message)
            if reply is not None:
                self.replies.append(reply)
        return len(text)

    def flush(self) -> None:
        return None

    def readline(self) -> str:
        if self.replies:
            return json.dumps(self.replies.popleft()) + "\n"
        return ""

    def messages(self, kind: str) -> list[dict[str, Any]]:
        return [message for message in self.outgoing if message.get("type") == kind]


def instances(prefix: str, split: str, count: int) -> list[dict[str, Any]]:
    return [{"instance_id": f"{prefix}-{index}", "split": split, "summary": f"task {prefix} {index}"} for index in range(count)]


def start_message(**overrides: Any) -> dict[str, Any]:
    gepa_version, python_version = installed_versions()
    message = {
        "type": "start",
        "expected": {"gepa_version": gepa_version, "python_version_prefix": python_version.rsplit(".", 1)[0]},
        "seed_candidate": {"system_prompt": "Answer the task."},
        "train": instances("train", "train", 3),
        "validation": instances("val", "validation", 2),
        "max_metric_calls": 12,
        "reflection_minibatch_size": 2,
        "seed": 0,
        "repeats": 1,
        "budget": BUDGET,
        "max_feedback_chars": 400,
        "max_records_per_component": 4,
    }
    message.update(overrides)
    return message


def score_result(request: dict[str, Any], score_for: Callable[[str], float]) -> dict[str, Any]:
    scores = [
        {
            "instance_id": instance_id,
            "score": score_for(instance_id),
            "reward_valid": True,
            "runtime_ms": 1,
            "cost_usd": 0.0,
            "error": None,
            "trajectory": None,
            "feedback": f"[simulated] {instance_id}",
        }
        for instance_id in request["instance_ids"]
    ]
    return {
        "request_sha256": hashlib.sha256(json.dumps(request, sort_keys=True).encode()).hexdigest(),
        "split": request["split"],
        "scores": scores,
        "mean_score": sum(item["score"] for item in scores) / len(scores),
        "cost_usd": 0.0,
        "runtime_ms": len(scores),
        "simulated": True,
    }


def keyword_host(message: dict[str, Any]) -> dict[str, Any] | None:
    if message["type"] == "score":
        request = message["request"]
        hit = KEYWORD in request["candidate"]["components"]["system_prompt"]
        return {"type": "score_result", "id": message["id"], "result": score_result(request, lambda _id: 0.9 if hit else 0.3)}
    if message["type"] == "reflect":
        return {"type": "reflect_result", "id": message["id"], "text": f"```\nAnswer the task. Always {KEYWORD} your work.\n```"}
    return None


def test_pin_mismatch_refuses_before_importing_gepa() -> None:
    host = HostStreams(lambda _m: None, [start_message(expected={"gepa_version": "9.9.9", "python_version_prefix": "3.12"})])
    assert run(host, host, io.StringIO()) == EXIT_PIN_MISMATCH
    assert host.messages("ready") == []
    [error] = host.messages("error")
    assert error["code"] == "pin_mismatch"
    assert "9.9.9" in error["message"]


def test_bad_start_is_a_protocol_error() -> None:
    host = HostStreams(lambda _m: None, [{"type": "nope"}])
    assert run(host, host, io.StringIO()) == EXIT_PROTOCOL
    [error] = host.messages("error")
    assert error["code"] == "protocol_error"


def test_holdout_split_in_start_is_rejected() -> None:
    bad = start_message(validation=instances("val", "final_holdout", 2))
    host = HostStreams(lambda _m: None, [bad])
    assert run(host, host, io.StringIO()) == EXIT_PROTOCOL


def test_full_run_is_brokered_and_improves_with_real_gepa() -> None:
    pytest.importorskip("gepa")
    host = HostStreams(keyword_host, [start_message()])
    stderr = io.StringIO()
    assert run(host, host, stderr) == EXIT_OK
    [ready] = host.messages("ready")
    assert ready["gepa_version"] == installed_versions()[0]
    [done] = host.messages("done")
    result = done["result"]
    assert len(result["candidates"]) >= 2
    assert KEYWORD in result["candidates"][result["best_idx"]]["system_prompt"]
    assert result["val_aggregate_scores"][result["best_idx"]] > result["val_aggregate_scores"][0]
    allowed = {item["instance_id"] for item in start_message()["train"] + start_message()["validation"]}
    scores = host.messages("score")
    assert scores
    for message in scores:
        request = message["request"]
        assert request["split"] in ("train", "validation")
        assert set(request["instance_ids"]) <= allowed
        assert request["candidate"]["candidate_id"] == candidate_id(request["candidate"]["components"])
        assert request["budget"] == BUDGET
    assert host.messages("reflect")
    candidates = host.messages("candidate")
    assert candidates[0]["candidate_idx"] == 0 and candidates[0]["parent_idx"] is None
    assert any(c["parent_idx"] == 0 for c in candidates[1:])
    assert all(message["type"] in {"ready", "score", "reflect", "candidate", "log", "done"} for message in host.outgoing)


def test_host_abort_stops_quietly() -> None:
    pytest.importorskip("gepa")

    def aborting(message: dict[str, Any]) -> dict[str, Any] | None:
        if message["type"] == "score":
            return {"type": "abort", "id": message["id"], "message": "budget exceeded"}
        return None

    host = HostStreams(aborting, [start_message()])
    assert run(host, host, io.StringIO()) == EXIT_ABORTED
    assert host.messages("error") == []
    assert host.messages("done") == []


def test_gepa_exception_is_reported() -> None:
    pytest.importorskip("gepa")

    def broken(message: dict[str, Any]) -> dict[str, Any] | None:
        if message["type"] == "score":
            request = message["request"]
            result = score_result(request, lambda _id: 0.5)
            result["scores"] = []  # host violated the contract: no scores for the batch
            return {"type": "score_result", "id": message["id"], "result": result}
        return None

    host = HostStreams(broken, [start_message()])
    code = run(host, host, io.StringIO())
    assert code in (EXIT_PROTOCOL, EXIT_GEPA_ERROR)
    [error] = host.messages("error")
    assert error["code"] in ("protocol_error", "gepa_error")


class _NoBroker(Broker):
    def __init__(self) -> None:
        super().__init__(Channel(io.StringIO(), io.StringIO()))


def _adapter() -> BrokeredAdapter:
    return BrokeredAdapter(
        _NoBroker(), repeats=1, budget=BUDGET, created_at="2026-01-01T00:00:00.000Z", max_feedback_chars=200, max_records_per_component=2
    )


def test_reflective_dataset_is_bounded_labelled_and_scrubbed() -> None:
    pytest.importorskip("gepa")
    from gepa import EvaluationBatch

    traces = [
        Trace("i-1", "train", "summary one", 0.9, True, None, "fine"),
        Trace("i-2", "train", "summary two", 0.1, False, "Traceback: api_key=supersecretvalue99 leaked", "x" * 5000),
        Trace("i-3", "train", "summary three", 0.5, True, None, "Authorization: Bearer abcdefghijklmnop"),
    ]
    batch = EvaluationBatch(outputs=[{} for _ in traces], scores=[t.score for t in traces], trajectories=traces)
    dataset = _adapter().make_reflective_dataset({"system_prompt": "p" * 1000}, batch, ["system_prompt"])
    records = dataset["system_prompt"]
    assert len(records) == 2  # bounded by max_records_per_component
    assert [r["Inputs"]["instance_id"] for r in records] == ["i-2", "i-3"]  # lowest scores first
    worst = records[0]
    assert worst["Generated Outputs"].startswith(UNTRUSTED_LABEL)
    assert worst["Generated Outputs"].endswith(TRUNCATION_MARKER)
    assert len(worst["Generated Outputs"]) <= len(UNTRUSTED_LABEL) + 1 + 200
    assert "supersecretvalue99" not in json.dumps(dataset)
    assert "abcdefghijklmnop" not in json.dumps(dataset)
    assert "[redacted]" in worst["Feedback"]
    assert "reward marked invalid" in worst["Feedback"]
    assert worst["Inputs"]["component_excerpt"].endswith(TRUNCATION_MARKER)


def test_adapter_rejects_forbidden_split() -> None:
    with pytest.raises(ProtocolError):
        _adapter()._requests({"system_prompt": "p"}, [{"instance_id": "h-1", "split": "final_holdout"}])


def test_broker_matches_replies_by_id() -> None:
    reader = io.StringIO(json.dumps({"type": "pong", "id": 1}) + "\n" + json.dumps({"type": "pong", "id": 0}) + "\n")
    writer = io.StringIO()
    broker = Broker(Channel(reader, writer))
    replies = broker.request_many([{"type": "ping", "n": 0}, {"type": "ping", "n": 1}], "pong")
    assert [reply["id"] for reply in replies] == [0, 1]
    sent = [json.loads(line) for line in writer.getvalue().splitlines()]
    assert [m["id"] for m in sent] == [0, 1]
    with pytest.raises(ProtocolError):
        Broker(Channel(io.StringIO(""), io.StringIO())).request({"type": "ping"}, "pong")
