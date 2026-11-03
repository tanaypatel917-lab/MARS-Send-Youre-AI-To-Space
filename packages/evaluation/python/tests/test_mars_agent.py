"""Offline tests for MarsAgent: a fake environment, no containers, no model calls."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest
from harbor.models.agent.context import AgentContext

from mars_harbor_agent.agent import (
    ADAPTER_VERSION,
    CONTAINER_STATE_DIR,
    USAGE_FILE,
    MarsAgent,
    MarsAgentConfigError,
)


class FakeEnvironment:
    def __init__(self, usage: dict | None = None, return_code: int = 0):
        self.uploads: list[tuple[str, str]] = []
        self.commands: list[dict] = []
        self.files: dict[str, bytes] = {}
        self.usage = usage
        self.return_code = return_code

    async def exec(self, command, cwd=None, env=None, timeout_sec=None, user=None):
        self.commands.append({"command": command, "env": dict(env or {}), "timeout_sec": timeout_sec})
        if self.usage is not None and command.startswith("cd "):
            self.files[str(CONTAINER_STATE_DIR / USAGE_FILE)] = json.dumps(self.usage).encode()

        class Result:
            stdout = ""
            stderr = ""
            return_code = self.return_code

        return Result()

    async def upload_file(self, source_path, target_path):
        self.uploads.append((Path(source_path).name, str(target_path)))
        self.files[str(target_path)] = Path(source_path).read_bytes()

    async def download_file(self, source_path, target_path):
        if source_path not in self.files:
            raise FileNotFoundError(source_path)
        Path(target_path).write_bytes(self.files[source_path])


@pytest.fixture
def bundle(tmp_path: Path):
    bundle_dir = tmp_path / "bundle"
    bundle_dir.mkdir()
    binary = bundle_dir / "mars-agent"
    binary.write_bytes(b"#!/bin/sh\necho fake bundle\n")
    (bundle_dir / "pi_natives.linux-x64-modern.node").write_bytes(b"\x7fELF fake")
    candidate = tmp_path / "candidate.json"
    candidate.write_text(json.dumps({"components": {"system_prompt": "You are candidate 3."}}))
    return {
        "bundle_dir": str(bundle_dir),
        "bundle_sha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
        "candidate_path": str(candidate),
    }


def make_agent(tmp_path: Path, bundle: dict, **overrides) -> MarsAgent:
    kwargs = dict(
        logs_dir=tmp_path / "logs",
        model_name="qwen3-coder:30b",
        base_url="http://host.docker.internal:11434/v1",
        model_api_key_name="MARS_EVAL_API_KEY",
        model_api_format="openai_chat_completions",
        trial_timeout_ms=120_000,
        **bundle,
    )
    kwargs.update(overrides)
    return MarsAgent(**kwargs)


def test_identity():
    assert MarsAgent.name() == "mars-oh-my-pi"


def test_setup_uploads_pinned_bundle_and_config_without_secrets(tmp_path, bundle, monkeypatch):
    monkeypatch.setenv("MARS_EVAL_API_KEY", "sk-not-real-secret")
    agent = make_agent(tmp_path, bundle)
    assert agent.version() == ADAPTER_VERSION
    env = FakeEnvironment()
    import asyncio

    asyncio.run(agent.setup(env))
    names = [name for name, _ in env.uploads]
    assert "mars-agent" in names and "pi_natives.linux-x64-modern.node" in names
    config = json.loads(env.files[str(CONTAINER_STATE_DIR / "config.json")])
    assert config["model_id"] == "qwen3-coder:30b"
    assert config["api_key_env"] == "MARS_EVAL_API_KEY"
    assert config["components"] == {"system_prompt": "You are candidate 3."}
    assert "sk-not-real-secret" not in json.dumps(config)
    assert "sk-not-real-secret" not in (tmp_path / "logs" / "mars-agent-config.json").read_text()


def test_setup_refuses_sha_mismatch(tmp_path, bundle):
    agent = make_agent(tmp_path, bundle, bundle_sha256="0" * 64)
    import asyncio

    with pytest.raises(MarsAgentConfigError, match="sha256 mismatch"):
        asyncio.run(agent.setup(FakeEnvironment()))


def test_run_passes_instruction_only_and_reports_usage(tmp_path, bundle, monkeypatch):
    monkeypatch.setenv("MARS_EVAL_API_KEY", "sk-not-real-secret")
    agent = make_agent(tmp_path, bundle)
    env = FakeEnvironment(
        usage={
            "input_tokens": 1200,
            "output_tokens": 340,
            "cache_tokens": 0,
            "cost_usd": 0.0,
            "status": "completed",
            "model_requests": 3,
            "elapsed_ms": 4500,
        }
    )
    context = AgentContext()
    import asyncio

    asyncio.run(agent.setup(env))
    asyncio.run(agent.run("Fix the regex in /app/filter.py so the tests pass.", env, context))
    run_cmd = [c for c in env.commands if c["command"].startswith("cd ")][0]
    assert run_cmd["timeout_sec"] == 120
    assert run_cmd["command"].startswith("cd /app && ")
    assert run_cmd["env"]["MARS_EVAL_API_KEY"] == "sk-not-real-secret"
    assert run_cmd["env"]["MARS_AGENT_CREDENTIAL"] == str(CONTAINER_STATE_DIR / "credential")
    # Credential handover: written to a 0600 file, unset, then exec so the
    # bundle's /proc/<pid>/environ never contains it.
    assert "sk-not-real-secret" not in run_cmd["command"]
    assert (
        f"umask 077 && printf '%s' \"$MARS_EVAL_API_KEY\" > {CONTAINER_STATE_DIR / 'credential'} && "
        "unset MARS_EVAL_API_KEY && exec /opt/mars-agent/mars-agent "
    ) in run_cmd["command"]
    assert "tests" not in run_cmd["command"]
    assert env.files[str(CONTAINER_STATE_DIR / "instruction.txt")] == b"Fix the regex in /app/filter.py so the tests pass."
    assert context.n_input_tokens == 1200
    assert context.n_output_tokens == 340
    assert context.n_cache_tokens == 0
    assert context.cost_usd == 0.0
    assert context.metadata["status"] == "completed"
    assert context.metadata["model_requests"] == 3
    assert context.metadata["usage_available"] is True
    assert context.metadata["adapter_version"] == ADAPTER_VERSION


def test_run_without_usage_summary_records_absence(tmp_path, bundle):
    agent = make_agent(tmp_path, bundle, candidate_path=None)
    env = FakeEnvironment(usage=None, return_code=137)
    context = AgentContext()
    import asyncio

    asyncio.run(agent.run("Do the task.", env, context))
    assert context.n_input_tokens is None
    assert context.cost_usd is None
    assert context.metadata["usage_available"] is False
    assert context.metadata["return_code"] == 137
    assert context.metadata["component_keys"] == []


def test_config_validation(tmp_path, bundle):
    with pytest.raises(MarsAgentConfigError, match="bundle_dir"):
        make_agent(tmp_path, {**bundle, "bundle_dir": None})
    with pytest.raises(MarsAgentConfigError, match="workdir"):
        make_agent(tmp_path, bundle, workdir="relative/path")
    with pytest.raises(MarsAgentConfigError, match="trial_timeout_ms"):
        make_agent(tmp_path, bundle, trial_timeout_ms="soon")
    with pytest.raises(MarsAgentConfigError, match="model name"):
        make_agent(tmp_path, bundle, model_name=None)


def test_pricing_passes_through_only_when_both_rates_are_given(tmp_path, bundle):
    agent = make_agent(tmp_path, bundle)
    assert agent.provider_config()["pricing"] is None
    paid = make_agent(
        tmp_path,
        bundle,
        pricing_input_per_mtok_usd="1.5",
        pricing_output_per_mtok_usd=2,
    )
    assert paid.provider_config()["pricing"] == {
        "input_per_mtok_usd": 1.5,
        "output_per_mtok_usd": 2.0,
    }
    with pytest.raises(MarsAgentConfigError, match="pricing_input_per_mtok_usd"):
        make_agent(tmp_path, bundle, pricing_input_per_mtok_usd=1.0)
    with pytest.raises(MarsAgentConfigError, match="pricing_output_per_mtok_usd"):
        make_agent(tmp_path, bundle, pricing_input_per_mtok_usd=1.0, pricing_output_per_mtok_usd="free")


def test_run_without_key_skips_credential_handover(tmp_path, bundle, monkeypatch):
    monkeypatch.delenv("MARS_EVAL_API_KEY", raising=False)
    agent = make_agent(tmp_path, bundle)
    env = FakeEnvironment(usage=None, return_code=0)
    import asyncio

    asyncio.run(agent.setup(env))
    asyncio.run(agent.run("Do the task.", env, AgentContext()))
    run_cmd = [c for c in env.commands if c["command"].startswith("cd ")][0]
    assert "MARS_EVAL_API_KEY" not in run_cmd["env"]
    assert "MARS_AGENT_CREDENTIAL" not in run_cmd["env"]
    assert "printf" not in run_cmd["command"]
    assert "&& exec /opt/mars-agent/mars-agent " in run_cmd["command"]
