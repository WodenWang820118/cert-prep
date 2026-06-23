"""Ollama runtime and model installers."""

from __future__ import annotations

from collections.abc import Callable
import os
import shutil
import subprocess

from cert_prep_ollama.exceptions import ProviderUnavailableError
from cert_prep_ollama.models import (
    DEFAULT_OLLAMA_MODEL,
    ModelPullProgress,
    RuntimeInstallProgress,
    RuntimeInstallationStatus,
    RuntimeRequirementKind,
    RuntimeRequirementSnapshot,
)
from cert_prep_ollama.server import ensure_ollama_server_running, resolve_ollama_executable


class OllamaRuntimeInstaller:
    """Installer and health snapshot for the Ollama executable runtime."""

    kind = RuntimeRequirementKind.OLLAMA
    provider = "ollama"
    model = ""

    def __init__(
        self,
        ollama_host: str = "http://127.0.0.1:11434",
        runtime_install_timeout_seconds: float = 900.0,
    ) -> None:
        self._ollama_host = ollama_host
        self._timeout = runtime_install_timeout_seconds

    def requirement(self) -> RuntimeRequirementSnapshot:
        """Return whether the Ollama executable can be resolved locally."""

        executable = resolve_ollama_executable()
        if executable is None:
            return RuntimeRequirementSnapshot(
                kind=self.kind,
                label="Ollama",
                available=False,
                detail="Ollama is not installed.",
                unavailable_reason="ollama_missing",
            )
        return RuntimeRequirementSnapshot(
            kind=self.kind,
            label="Ollama",
            available=True,
            detail="Ollama is installed.",
            unavailable_reason=None,
            installed_path=str(executable),
        )

    def install(
        self, progress: Callable[[RuntimeInstallProgress], None]
    ) -> RuntimeInstallationStatus:
        """Run the official Ollama Windows installer script."""

        progress(RuntimeInstallProgress("Starting the Ollama Windows installer."))
        if os.name != "nt":
            raise ProviderUnavailableError(
                "Ollama installer automation is only configured for Windows."
            )

        command = ollama_windows_install_command()
        completed = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=max(60, int(self._timeout)),
        )
        if completed.returncode != 0:
            output = (completed.stderr or completed.stdout or "").strip()
            raise ProviderUnavailableError(output or "Ollama installer failed.")
        executable = resolve_ollama_executable()
        if executable is None:
            return RuntimeInstallationStatus.WAITING_FOR_USER
        progress(RuntimeInstallProgress("Starting the Ollama local API."))
        if not ensure_ollama_server_running(
            self._ollama_host,
            executable=executable,
        ):
            raise ProviderUnavailableError(
                "Ollama was installed, but the local API did not become reachable."
            )
        return RuntimeInstallationStatus.SUCCEEDED


class OllamaModelInstaller:
    """Installer and health snapshot for the configured Ollama model."""

    kind = RuntimeRequirementKind.OLLAMA_MODEL
    provider = "ollama"

    def __init__(self, provider: object) -> None:
        self._provider = provider
        self.model = str(getattr(provider, "model", DEFAULT_OLLAMA_MODEL))
        self.provider = str(getattr(provider, "provider", "ollama"))

    def requirement(self) -> RuntimeRequirementSnapshot:
        """Return model availability without starting a download."""

        if not callable(getattr(self._provider, "pull_model", None)):
            return RuntimeRequirementSnapshot(
                kind=self.kind,
                label="Ollama model",
                available=False,
                detail="Configured LLM provider does not support model downloads.",
                unavailable_reason="unsupported_provider",
                version=self.model,
            )
        health = self._provider.health() if hasattr(self._provider, "health") else None
        unavailable_reason = getattr(health, "unavailable_reason", None)
        available = bool(getattr(health, "available", False))
        detail = str(getattr(health, "detail", "Model health is unavailable."))
        if not available and unavailable_reason is None and "model" in detail.lower():
            unavailable_reason = "model_missing"
        return RuntimeRequirementSnapshot(
            kind=self.kind,
            label="Ollama model",
            available=available,
            detail=detail,
            unavailable_reason=unavailable_reason,
            version=self.model,
        )

    def validate_installable(self) -> None:
        """Raise when the configured provider cannot pull models."""

        if not callable(getattr(self._provider, "pull_model", None)):
            raise ProviderUnavailableError(
                "Configured LLM provider does not support model downloads."
            )

    def install(
        self, progress: Callable[[RuntimeInstallProgress], None]
    ) -> RuntimeInstallationStatus:
        """Pull the configured model through the provider's download API."""

        pull = getattr(self._provider, "pull_model", None)
        if not callable(pull):
            raise ProviderUnavailableError(
                "Configured LLM provider does not support model downloads."
            )

        def record_model_progress(model_progress: ModelPullProgress) -> None:
            progress(
                RuntimeInstallProgress(
                    detail=model_progress.status or "model download running",
                    completed=model_progress.completed,
                    total=model_progress.total,
                )
            )

        try:
            pull(record_model_progress)
        except Exception as exc:
            raise ProviderUnavailableError(f"Ollama unavailable: {exc}") from exc
        return RuntimeInstallationStatus.SUCCEEDED


def ollama_windows_install_command() -> list[str]:
    """Return the preferred explicit user-triggered Ollama installer command."""

    winget = shutil.which("winget")
    if winget:
        return [
            winget,
            "install",
            "--id",
            "Ollama.Ollama",
            "-e",
            "--silent",
            "--accept-package-agreements",
            "--accept-source-agreements",
        ]
    return [
        "powershell.exe",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "irm https://ollama.com/install.ps1 | iex",
    ]
