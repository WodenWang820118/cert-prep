"""Ollama profile installer that pulls a base model and creates a local profile."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import httpx
import ollama

from cert_prep_contracts.llm import ModelPullProgress
from cert_prep_contracts.llm_profiles import OllamaModelProfile
from cert_prep_contracts.runtime import (
    RuntimeInstallationStatus,
    RuntimeInstallProgress,
    RuntimeRequirementKind,
    RuntimeRequirementSnapshot,
)
from cert_prep_ollama.exceptions import ProviderUnavailableError
from cert_prep_ollama.modelfiles import parameters_from_profile
from cert_prep_ollama.models import extract_model_names, pull_progress
from cert_prep_ollama.server import (
    DEFAULT_OLLAMA_HOST,
    ensure_ollama_server_running,
    resolve_ollama_executable,
)


class OllamaProfileInstaller:
    """Installer and health snapshot for a selected cert-prep Ollama profile."""

    kind = RuntimeRequirementKind.OLLAMA_MODEL
    provider = "ollama"

    def __init__(
        self,
        profile: OllamaModelProfile,
        *,
        fallback_profiles: tuple[OllamaModelProfile, ...] = (),
        host: str = DEFAULT_OLLAMA_HOST,
        timeout_seconds: float = 120.0,
        runtime_install_timeout_seconds: float = 900.0,
        client: object | None = None,
        ensure_server: bool = True,
    ) -> None:
        self.profile = profile
        self.fallback_profiles = fallback_profiles
        self.profiles = (profile, *fallback_profiles)
        self.model = profile.local_model
        self.host = host
        self._runtime_install_timeout_seconds = runtime_install_timeout_seconds
        self._client = client or ollama.Client(host=host, timeout=timeout_seconds)
        self._ensure_server = ensure_server

    def requirement(self) -> RuntimeRequirementSnapshot:
        """Return selected profile availability without pulling or creating it."""

        try:
            model_names = self._installed_model_names()
        except ProviderUnavailableError as exc:
            return RuntimeRequirementSnapshot(
                kind=self.kind,
                label="Ollama profile model",
                available=False,
                detail=str(exc),
                unavailable_reason=exc.code,
                version=self.model,
            )
        missing_models = tuple(
            profile.local_model for profile in self.profiles if profile.local_model not in model_names
        )
        available = not missing_models
        return RuntimeRequirementSnapshot(
            kind=self.kind,
            label="Ollama profile models",
            available=available,
            detail=(
                "profile models available"
                if available
                else f"profile model {missing_models[0]} not found"
            ),
            unavailable_reason=None if available else "model_missing",
            version=self.model,
        )

    def validate_installable(self) -> None:
        """Raise when Ollama cannot be reached before installation starts."""

        self._installed_model_names()

    def install(
        self,
        progress: Callable[[RuntimeInstallProgress], None],
    ) -> RuntimeInstallationStatus:
        """Pull base models and create selected plus fallback local profiles."""

        self._prepare_server()
        pulled_base_models: set[str] = set()
        for profile in self.profiles:
            if profile.base_model not in pulled_base_models:
                progress(RuntimeInstallProgress(f"Pulling base model {profile.base_model}."))
                for update in self._client.pull(profile.base_model, stream=True):
                    _record_progress(progress, pull_progress(update))
                pulled_base_models.add(profile.base_model)

            progress(RuntimeInstallProgress(f"Creating profile model {profile.local_model}."))
            create = getattr(self._client, "create", None)
            if not callable(create):
                raise ProviderUnavailableError("Ollama client does not support model creation.")
            for update in create(
                model=profile.local_model,
                from_=profile.base_model,
                system=profile.system_prompt,
                parameters=parameters_from_profile(profile),
                stream=True,
            ):
                _record_progress(progress, _create_progress(update))

        model_names = self._installed_model_names()
        missing_models = [
            profile.local_model for profile in self.profiles if profile.local_model not in model_names
        ]
        if missing_models:
            raise ProviderUnavailableError(
                f"Ollama profile model was not registered: {missing_models[0]}",
                code="model_missing",
            )
        return RuntimeInstallationStatus.SUCCEEDED

    def _installed_model_names(self) -> set[str]:
        self._prepare_server()
        try:
            return extract_model_names(self._client.list())
        except _OLLAMA_UNAVAILABLE_EXCEPTIONS as exc:
            raise ProviderUnavailableError(f"Ollama unavailable: {exc}", code="ollama_not_running")
        except Exception as exc:
            raise ProviderUnavailableError(
                f"Ollama model list response was invalid: {exc}",
                code="ollama_response_invalid",
            ) from exc

    def _prepare_server(self) -> None:
        if not self._ensure_server:
            return
        executable = resolve_ollama_executable()
        if ensure_ollama_server_running(
            self.host,
            executable=executable,
            timeout_seconds=self._runtime_install_timeout_seconds,
        ):
            return
        if executable is None:
            raise ProviderUnavailableError("Ollama is not installed.", code="ollama_missing")
        raise ProviderUnavailableError(
            "Ollama local API did not become reachable.",
            code="ollama_not_running",
        )


def _record_progress(
    progress: Callable[[RuntimeInstallProgress], None],
    model_progress: ModelPullProgress,
) -> None:
    progress(
        RuntimeInstallProgress(
            detail=model_progress.status or "model installation running",
            completed=model_progress.completed,
            total=model_progress.total,
        )
    )


def _create_progress(response: Any) -> ModelPullProgress:
    status = getattr(response, "status", None)
    completed = getattr(response, "completed", None)
    total = getattr(response, "total", None)
    error = getattr(response, "error", None)
    if isinstance(response, dict):
        status = response.get("status", status)
        completed = response.get("completed", completed)
        total = response.get("total", total)
        error = response.get("error", error)
    if isinstance(error, str) and error.strip():
        raise ProviderUnavailableError(
            f"Ollama profile creation failed: {error.strip()}",
            code="ollama_create_failed",
        )
    return ModelPullProgress(
        status=status if isinstance(status, str) else "creating profile model",
        completed=completed if isinstance(completed, int) else None,
        total=total if isinstance(total, int) else None,
    )


_OLLAMA_UNAVAILABLE_EXCEPTIONS = (
    ConnectionError,
    TimeoutError,
    OSError,
    httpx.HTTPError,
    ollama.ResponseError,
)


__all__ = ["OllamaProfileInstaller"]
