from __future__ import annotations

from collections.abc import Callable, Sequence
import json
import os
from pathlib import Path
import socket
import subprocess
import time
from typing import Any

from cert_prep_backend.api.errors import ProviderUnavailableError
from cert_prep_backend.domains.mock_exams.fastflowlm_client import FastFlowLMClient
from cert_prep_backend.domains.mock_exams.fastflowlm_process import (
    terminate_fastflowlm_process_tree,
)
from cert_prep_contracts.llm import DEFAULT_LLM_PRIMARY_MODEL, ModelPullProgress


_ONBOARDING_HOST = "127.0.0.1"
_ONBOARDING_CONTEXT_TOKENS = 256
_ONBOARDING_MAX_TOKENS = 4
_SERVER_POLL_SECONDS = 0.5


class FastFlowLMModelOnboarding:
    """Prove the exact primary model works on a newly owned FastFlowLM server."""

    def __init__(
        self,
        *,
        model: str,
        executable_resolver: Callable[[], Path | None],
        command_timeout_seconds: float,
        server_start_timeout_seconds: float,
        command_runner: Callable[
            [Path, Sequence[str], float], subprocess.CompletedProcess[str]
        ]
        | None = None,
        port_allocator: Callable[[], int] | None = None,
        process_starter: Callable[[Path, str, int], Any] | None = None,
        client_factory: Callable[[str, float], FastFlowLMClient] | None = None,
        process_terminator: Callable[[Any], None] = terminate_fastflowlm_process_tree,
        monotonic: Callable[[], float] = time.monotonic,
        sleeper: Callable[[float], None] = time.sleep,
    ) -> None:
        self._model = model
        self._executable_resolver = executable_resolver
        self._command_timeout_seconds = max(1.0, command_timeout_seconds)
        self._server_start_timeout_seconds = max(0.1, server_start_timeout_seconds)
        self._command_runner = command_runner or run_fastflowlm_command
        self._port_allocator = port_allocator or allocate_loopback_port
        self._process_starter = process_starter or start_fastflowlm_onboarding_server
        self._client_factory = client_factory or _create_client
        self._process_terminator = process_terminator
        self._monotonic = monotonic
        self._sleeper = sleeper

    def prepare(self, progress: Callable[[ModelPullProgress], None]) -> None:
        """Validate the NPU stack and installed-model response before a pull."""

        self._require_primary_model()
        executable = self._require_executable()
        progress(ModelPullProgress(status="validating FastFlowLM NPU stack"))
        validation = self._run_json(executable, ("validate", "--json"))
        validate_fastflowlm_preflight(validation)
        progress(ModelPullProgress(status="checking installed FastFlowLM models"))
        installed = self._run_json(
            executable,
            ("list", "--filter", "installed", "--json"),
        )
        parse_installed_fastflowlm_models(installed)

    def verify(self, progress: Callable[[ModelPullProgress], None]) -> None:
        """Check and run the exact primary model on a dedicated loopback port."""

        self._require_primary_model()
        executable = self._require_executable()
        progress(ModelPullProgress(status=f"verifying installed {self._model}"))
        installed = self._run_json(
            executable,
            ("list", "--filter", "installed", "--json"),
        )
        if self._model not in parse_installed_fastflowlm_models(installed):
            raise ProviderUnavailableError(
                f"FastFlowLM did not report {self._model} as installed."
            )
        self._run(executable, ("check", self._model))

        port = self._port_allocator()
        progress(ModelPullProgress(status=f"testing {self._model} on an owned server"))
        try:
            process = self._process_starter(executable, self._model, port)
        except OSError as exc:
            raise ProviderUnavailableError(
                "FastFlowLM onboarding server could not be started."
            ) from exc
        try:
            client = self._client_factory(
                f"http://{_ONBOARDING_HOST}:{port}/v1",
                self._command_timeout_seconds,
            )
            self._wait_for_exact_model(process, client)
            content = self._owned_probe(
                process,
                lambda: client.chat_content(
                    self._model,
                    [{"role": "user", "content": "Reply with OK."}],
                    max_tokens=_ONBOARDING_MAX_TOKENS,
                    context_tokens=_ONBOARDING_CONTEXT_TOKENS,
                ),
            )
            if not isinstance(content, str) or not content.strip():
                raise ProviderUnavailableError(
                    "FastFlowLM onboarding completion returned empty content."
                )
        finally:
            self._process_terminator(process)
        progress(ModelPullProgress(status="FastFlowLM model onboarding verified"))

    def _run_json(self, executable: Path, arguments: Sequence[str]) -> dict[str, Any]:
        completed = self._run(executable, arguments)
        try:
            payload = json.loads(completed.stdout)
        except json.JSONDecodeError as exc:
            raise ProviderUnavailableError(
                "FastFlowLM CLI returned invalid JSON during onboarding."
            ) from exc
        if not isinstance(payload, dict):
            raise ProviderUnavailableError(
                "FastFlowLM CLI returned a non-object onboarding response."
            )
        return payload

    def _run(
        self,
        executable: Path,
        arguments: Sequence[str],
    ) -> subprocess.CompletedProcess[str]:
        try:
            completed = self._command_runner(
                executable,
                tuple(arguments),
                self._command_timeout_seconds,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise ProviderUnavailableError(
                f"FastFlowLM {' '.join(arguments)} failed: {exc}"
            ) from exc
        if completed.returncode != 0:
            detail = (completed.stderr or completed.stdout or "").strip()
            raise ProviderUnavailableError(
                detail or f"FastFlowLM {' '.join(arguments)} failed."
            )
        return completed

    def _wait_for_exact_model(self, process: Any, client: FastFlowLMClient) -> None:
        deadline = self._monotonic() + self._server_start_timeout_seconds
        last_error: BaseException | None = None
        while True:
            try:
                model_names = self._owned_probe(process, client.served_model_names)
                if model_names == {self._model}:
                    return
                last_error = ProviderUnavailableError(
                    "Owned FastFlowLM server did not expose only the pinned "
                    f"model {self._model}."
                )
            except ProviderUnavailableError as exc:
                if process.poll() is not None:
                    raise
                last_error = exc
            if self._monotonic() >= deadline:
                raise ProviderUnavailableError(
                    f"Owned FastFlowLM server did not become ready: {last_error}"
                ) from last_error
            self._sleeper(_SERVER_POLL_SECONDS)

    @staticmethod
    def _owned_probe(process: Any, probe: Callable[[], Any]) -> Any:
        _require_owned_process_alive(process)
        try:
            return probe()
        finally:
            _require_owned_process_alive(process)

    def _require_primary_model(self) -> None:
        if self._model != DEFAULT_LLM_PRIMARY_MODEL:
            raise ProviderUnavailableError(
                "FastFlowLM onboarding is restricted to the pinned primary model "
                f"{DEFAULT_LLM_PRIMARY_MODEL}."
            )

    def _require_executable(self) -> Path:
        executable = self._executable_resolver()
        if executable is None or not executable.is_absolute():
            raise ProviderUnavailableError("FastFlowLM is not installed in an allowlisted path.")
        return executable


def validate_fastflowlm_preflight(payload: dict[str, Any]) -> None:
    """Validate the observed v0.9.43 NPU-stack response without truthy coercion."""

    if (
        payload.get("object") != "npu_stack_validation"
        or payload.get("platform") != "windows"
        or payload.get("amd_device_found") is not True
        or payload.get("npu_driver_ok") is not True
        or payload.get("ready") is not True
    ):
        raise ProviderUnavailableError(
            "FastFlowLM NPU stack validation did not report a ready Windows XDNA2 stack."
        )


def parse_installed_fastflowlm_models(payload: dict[str, Any]) -> set[str]:
    """Return installed model tags from the observed v0.9.43 list schema."""

    items = payload.get("models")
    if not isinstance(items, list):
        raise ProviderUnavailableError(
            "FastFlowLM installed-model response has an invalid models field."
        )
    installed: set[str] = set()
    for item in items:
        if not isinstance(item, dict):
            raise ProviderUnavailableError(
                "FastFlowLM installed-model response contains an invalid entry."
            )
        model = item.get("model")
        is_installed = item.get("installed")
        if (
            not isinstance(model, str)
            or not model
            or model != model.strip()
            or not isinstance(is_installed, bool)
        ):
            raise ProviderUnavailableError(
                "FastFlowLM installed-model response contains invalid model metadata."
            )
        if is_installed:
            installed.add(model)
    return installed


def run_fastflowlm_command(
    executable: Path,
    arguments: Sequence[str],
    timeout_seconds: float,
) -> subprocess.CompletedProcess[str]:
    """Run a fixed FastFlowLM CLI command from the allowlisted executable."""

    return subprocess.run(
        [str(executable), *arguments],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout_seconds,
        cwd=executable.parent,
        stdin=subprocess.DEVNULL,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0,
    )


def allocate_loopback_port() -> int:
    """Ask Windows for an unused loopback port for the isolated onboarding server."""

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind((_ONBOARDING_HOST, 0))
        return int(listener.getsockname()[1])


def start_fastflowlm_onboarding_server(
    executable: Path,
    model: str,
    port: int,
) -> subprocess.Popen[bytes]:
    """Start one exact model on a dedicated, non-CORS loopback endpoint."""

    return subprocess.Popen(
        [
            str(executable),
            "serve",
            model,
            "--host",
            _ONBOARDING_HOST,
            "--port",
            str(port),
            "--quiet",
            "--cors",
            "0",
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        cwd=executable.parent,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0,
    )


def _create_client(base_url: str, timeout_seconds: float) -> FastFlowLMClient:
    return FastFlowLMClient(base_url=base_url, timeout_seconds=timeout_seconds)


def _require_owned_process_alive(process: Any) -> None:
    if process.poll() is not None:
        raise ProviderUnavailableError("Owned FastFlowLM onboarding server exited unexpectedly.")


__all__ = [
    "FastFlowLMModelOnboarding",
    "allocate_loopback_port",
    "parse_installed_fastflowlm_models",
    "run_fastflowlm_command",
    "start_fastflowlm_onboarding_server",
    "validate_fastflowlm_preflight",
]
