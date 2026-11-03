"""`MarsAgent` — a Harbor `BaseAgent` for the MARS Oh My Pi runtime.

Matched conditions with Harbor's `mini-swe-agent` adapter: the agent binary is
uploaded into the task container and executed there with the task instruction
only. The adapter never reads the task's tests, solution or final-holdout
material; Harbor hands it `instruction` and it hands back usage figures read
from the JSON summary the bundle writes.

Select with `-a mars_harbor_agent.agent:MarsAgent` and pass kwargs via `--ak`:

    bundle_dir=<host dir containing mars-agent + pi_natives.*.node>
    bundle_sha256=<sha256 of bundle_dir/mars-agent>
    candidate_path=<host JSON file with {"components": {...}}>  (optional)
    workdir=/app           trial_timeout_ms=1800000
    max_tokens=200000      max_usd=1.0      context_window=32000

Model connection comes from Harbor's `-m/--base-url/--api-key-name/--api-format`.
The API key VALUE is read from the named environment variable at run time and
placed only in the container process environment; it is never written to disk
or logs by this adapter.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shlex
from pathlib import Path, PurePosixPath
from typing import Any

from harbor.agents.agent_auth_resolution import ModelConnectionSpec
from harbor.agents.base import BaseAgent
from harbor.agents.capabilities import AgentCapabilities
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.model_api_format import ModelApiFormat

ADAPTER_VERSION = "0.1.0"
AGENT_NAME = "mars-oh-my-pi"
BUNDLE_BINARY = "mars-agent"
NATIVE_ADDON_GLOB = "pi_natives.*.node"
CONTAINER_AGENT_DIR = PurePosixPath("/opt/mars-agent")
CONTAINER_STATE_DIR = PurePosixPath("/tmp/mars-state")
CREDENTIAL_FILE = "credential"
USAGE_FILE = "mars-usage.json"
RESULT_FILE = "mars-result.json"
_ENV_NAME = re.compile(r"^[A-Z][A-Z0-9_]{0,127}$")
_WORKDIR = re.compile(r"^/[A-Za-z0-9._/-]*$")
_MAX_INSTRUCTION_BYTES = 256 * 1024


class MarsAgentConfigError(ValueError):
    """Raised when kwargs are missing or unsafe; Harbor records it as an agent error."""


def _coerce_int(name: str, value: Any, minimum: int = 1) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError) as error:
        raise MarsAgentConfigError(f"{name} must be an integer") from error
    if number < minimum:
        raise MarsAgentConfigError(f"{name} must be >= {minimum}")
    return number


def _coerce_float(name: str, value: Any) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError) as error:
        raise MarsAgentConfigError(f"{name} must be a number") from error
    if not number >= 0:
        raise MarsAgentConfigError(f"{name} must be >= 0")
    return number


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_candidate_components(path: Path) -> dict[str, str]:
    """Reads the prompt-candidate file written by the TypeScript side."""
    data = json.loads(path.read_text("utf-8"))
    components = data.get("components") if isinstance(data, dict) else None
    if not isinstance(components, dict) or not all(
        isinstance(key, str) and key and isinstance(value, str)
        for key, value in components.items()
    ):
        raise MarsAgentConfigError("candidate file must contain a string->string 'components' map")
    return dict(components)


class MarsAgent(BaseAgent):
    capabilities = AgentCapabilities(base_url=True)
    # Harbor validates `--base-url/--api-key-name/--api-format` against this
    # spec; the bundle speaks OpenAI chat completions only.
    MODEL_CONNECTION = ModelConnectionSpec(
        base_url_destination_names={"default": None},
        supported_api_formats=[ModelApiFormat.OPENAI_CHAT_COMPLETIONS],
    )

    def __init__(
        self,
        logs_dir: Path,
        model_name: str | None = None,
        *,
        bundle_dir: str | None = None,
        bundle_sha256: str | None = None,
        candidate_path: str | None = None,
        workdir: str = "/app",
        trial_timeout_ms: Any = 30 * 60 * 1000,
        max_tokens: Any = 200_000,
        max_usd: Any = 1.0,
        context_window: Any = 32_000,
        pricing_input_per_mtok_usd: Any = None,
        pricing_output_per_mtok_usd: Any = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(logs_dir, model_name, **kwargs)
        if not bundle_dir:
            raise MarsAgentConfigError("bundle_dir kwarg is required (--ak bundle_dir=<dir>)")
        if not bundle_sha256 or not re.fullmatch(r"[a-f0-9]{64}", bundle_sha256):
            raise MarsAgentConfigError("bundle_sha256 kwarg must be a 64-hex sha256")
        if not model_name:
            raise MarsAgentConfigError("a model name is required (-m)")
        if not _WORKDIR.fullmatch(workdir):
            raise MarsAgentConfigError("workdir must be an absolute POSIX path")
        self.bundle_dir = Path(bundle_dir)
        self.bundle_sha256 = bundle_sha256
        self.candidate_path = Path(candidate_path) if candidate_path else None
        self.workdir = PurePosixPath(workdir)
        self.trial_timeout_ms = _coerce_int("trial_timeout_ms", trial_timeout_ms, 1000)
        self.max_tokens = _coerce_int("max_tokens", max_tokens)
        self.max_usd = _coerce_float("max_usd", max_usd)
        self.context_window = _coerce_int("context_window", context_window, 1024)
        if (pricing_input_per_mtok_usd is None) != (pricing_output_per_mtok_usd is None):
            raise MarsAgentConfigError("pricing_input_per_mtok_usd and pricing_output_per_mtok_usd must be passed together")
        self.pricing: dict[str, float] | None = (
            None
            if pricing_input_per_mtok_usd is None
            else {
                "input_per_mtok_usd": _coerce_float("pricing_input_per_mtok_usd", pricing_input_per_mtok_usd),
                "output_per_mtok_usd": _coerce_float("pricing_output_per_mtok_usd", pricing_output_per_mtok_usd),
            }
        )
        self.components: dict[str, str] = (
            load_candidate_components(self.candidate_path) if self.candidate_path else {}
        )
        self.model_name = model_name

    @staticmethod
    def name() -> str:
        return AGENT_NAME

    def version(self) -> str | None:
        return ADAPTER_VERSION

    # -- provider plumbing -------------------------------------------------
    def _api_key_env(self) -> str:
        env_name = self._model_api_key_name or "MARS_EVAL_API_KEY"
        if not _ENV_NAME.fullmatch(env_name):
            raise MarsAgentConfigError("api key env var name is invalid")
        return env_name

    def _resolved_base_url(self) -> str:
        base_url = self._base_url
        if not isinstance(base_url, str) or not base_url.startswith(("http://", "https://")):
            raise MarsAgentConfigError("--base-url (http/https) is required for the MARS agent")
        return base_url

    def provider_config(self) -> dict[str, Any]:
        """Provider description handed to the bundle (no secret values)."""
        return {
            "schema": "mars.evaluation-agent-config/v1",
            "model_id": self.model_name,
            "base_url": self._resolved_base_url(),
            "api_key_env": self._api_key_env(),
            "api_format": str(self._model_api_format.value if self._model_api_format else "openai_chat_completions"),
            "context_window": self.context_window,
            "pricing": self.pricing,
            "max_tokens": self.max_tokens,
            "max_usd": self.max_usd,
            "timeout_ms": self.trial_timeout_ms,
            "workdir": str(self.workdir),
            "state_dir": str(CONTAINER_STATE_DIR),
            "components": self.components,
        }

    # -- Harbor lifecycle ----------------------------------------------------
    async def setup(self, environment: BaseEnvironment) -> None:
        binary = self.bundle_dir / BUNDLE_BINARY
        if not binary.is_file():
            raise MarsAgentConfigError(f"bundle binary missing: {binary}")
        actual = sha256_file(binary)
        if actual != self.bundle_sha256:
            raise MarsAgentConfigError("bundle sha256 mismatch; refusing to upload an unpinned agent")
        natives = sorted(self.bundle_dir.glob(NATIVE_ADDON_GLOB))
        if not natives:
            raise MarsAgentConfigError("bundle is missing the pi_natives addon")
        await environment.exec(f"mkdir -p {shlex.quote(str(CONTAINER_AGENT_DIR))} {shlex.quote(str(CONTAINER_STATE_DIR))}")
        await environment.upload_file(binary, str(CONTAINER_AGENT_DIR / BUNDLE_BINARY))
        for native in natives:
            await environment.upload_file(native, str(CONTAINER_AGENT_DIR / native.name))
        await environment.exec(f"chmod 0755 {shlex.quote(str(CONTAINER_AGENT_DIR / BUNDLE_BINARY))}")
        config_path = self.logs_dir / "mars-agent-config.json"
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        config_path.write_text(json.dumps(self.provider_config(), indent=2, sort_keys=True), "utf-8")
        await environment.upload_file(config_path, str(CONTAINER_STATE_DIR / "config.json"))

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        if len(instruction.encode("utf-8")) > _MAX_INSTRUCTION_BYTES:
            raise MarsAgentConfigError("instruction exceeds the adapter size limit")
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        instruction_path = self.logs_dir / "mars-instruction.txt"
        instruction_path.write_text(instruction, "utf-8")
        await environment.upload_file(instruction_path, str(CONTAINER_STATE_DIR / "instruction.txt"))

        env_name = self._api_key_env()
        env: dict[str, str] = {
            "MARS_AGENT_CONFIG": str(CONTAINER_STATE_DIR / "config.json"),
            "MARS_AGENT_INSTRUCTION": str(CONTAINER_STATE_DIR / "instruction.txt"),
            "MARS_AGENT_USAGE": str(CONTAINER_STATE_DIR / USAGE_FILE),
            "MARS_AGENT_RESULT": str(CONTAINER_STATE_DIR / RESULT_FILE),
            "HOME": str(CONTAINER_STATE_DIR),
            "MARS_HOME": str(CONTAINER_STATE_DIR / "home"),
        }
        key_value = os.environ.get(env_name)
        # The credential never reaches the bundle's environment: the shell
        # writes it to a 0600 file, unsets it and exec()s the bundle, which
        # reads and unlinks the file before any task command runs. Deleting a
        # variable inside the bundle would not scrub /proc/<pid>/environ.
        credential_path = CONTAINER_STATE_DIR / CREDENTIAL_FILE
        handover = ""
        if key_value:
            env[env_name] = key_value
            env["MARS_AGENT_CREDENTIAL"] = str(credential_path)
            handover = (
                f"umask 077 && printf '%s' \"${env_name}\" > {shlex.quote(str(credential_path))} && "
                f"unset {env_name} && "
            )
        timeout_sec = max(1, self.trial_timeout_ms // 1000)
        command = (
            f"cd {shlex.quote(str(self.workdir))} && "
            f"{handover}"
            f"exec {shlex.quote(str(CONTAINER_AGENT_DIR / BUNDLE_BINARY))} "
            f"> {shlex.quote(str(self.environment_logs_dir / 'mars-agent.stdout.txt'))} "
            f"2> {shlex.quote(str(self.environment_logs_dir / 'mars-agent.stderr.txt'))}"
        )
        result = await environment.exec(command, env=env, timeout_sec=timeout_sec)
        await self._collect(environment, context, result.return_code)

    async def _collect(self, environment: BaseEnvironment, context: AgentContext, return_code: int) -> None:
        usage_target = self.logs_dir / USAGE_FILE
        usage: dict[str, Any] | None = None
        try:
            await environment.download_file(str(CONTAINER_STATE_DIR / USAGE_FILE), usage_target)
            usage = json.loads(usage_target.read_text("utf-8"))
        except Exception as error:  # noqa: BLE001 - absence of usage is reported, not fatal
            self.logger.warning("MARS usage summary unavailable: %s", error)
        metadata: dict[str, Any] = {
            "adapter_version": ADAPTER_VERSION,
            "bundle_sha256": self.bundle_sha256,
            "return_code": return_code,
            "component_keys": sorted(self.components),
            "usage_available": usage is not None,
        }
        if isinstance(usage, dict):
            context.n_input_tokens = _nonneg_int(usage.get("input_tokens"))
            context.n_output_tokens = _nonneg_int(usage.get("output_tokens"))
            context.n_cache_tokens = _nonneg_int(usage.get("cache_tokens"))
            cost = usage.get("cost_usd")
            context.cost_usd = float(cost) if isinstance(cost, (int, float)) and cost >= 0 else None
            for key in ("status", "model_requests", "error", "elapsed_ms"):
                if key in usage:
                    metadata[key] = usage[key]
        context.metadata = metadata


def _nonneg_int(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = int(value)
    return number if number >= 0 else None
