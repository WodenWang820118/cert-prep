from __future__ import annotations

from collections.abc import Callable

from cert_prep_backend.api.errors import ProviderUnavailableError
from cert_prep_backend.domains.mock_exams.ports import (
    ModelDownloadProvider,
    ModelOnboardingProvider,
    provider_capability,
)
from cert_prep_contracts.llm import ModelPullProgress
from cert_prep_contracts.runtime import (
    RuntimeInstallationStatus,
    RuntimeInstallProgress,
    RuntimeRequirementKind,
    RuntimeRequirementSnapshot,
)


class LLMModelInstaller:
    """Installer and health snapshot for the configured reasoning model."""

    kind = RuntimeRequirementKind.OLLAMA_MODEL

    def __init__(self, provider: object) -> None:
        self._provider = provider
        self.provider = str(getattr(provider, "provider", "llm"))
        self.model = str(getattr(provider, "model", "configured model"))

    def requirement(self) -> RuntimeRequirementSnapshot:
        model_provider = provider_capability(self._provider, ModelDownloadProvider)
        if model_provider is None:
            return RuntimeRequirementSnapshot(
                kind=self.kind,
                label="Reasoning model",
                available=False,
                detail="Configured LLM provider does not support model downloads.",
                unavailable_reason="unsupported_provider",
                version=self.model,
            )
        health = self._provider.health() if hasattr(self._provider, "health") else None
        detail = str(getattr(health, "detail", "Model health is unavailable."))
        unavailable_reason = getattr(health, "unavailable_reason", None)
        available = bool(getattr(health, "available", False))
        if not available and unavailable_reason is None and "model" in detail.lower():
            unavailable_reason = "model_missing"
        return RuntimeRequirementSnapshot(
            kind=self.kind,
            label=f"{_provider_label(self.provider)} model",
            available=available,
            detail=detail,
            unavailable_reason=unavailable_reason,
            version=self.model,
        )

    def validate_installable(self) -> None:
        if provider_capability(self._provider, ModelDownloadProvider) is None:
            raise ProviderUnavailableError(
                "Configured LLM provider does not support model downloads."
            )

    def install(self, progress: Callable[[RuntimeInstallProgress], None]) -> RuntimeInstallationStatus:
        model_provider = provider_capability(self._provider, ModelDownloadProvider)
        if model_provider is None:
            raise ProviderUnavailableError(
                "Configured LLM provider does not support model downloads."
            )
        last_completed: int | None = None
        last_total: int | None = None

        def capture(item: ModelPullProgress) -> tuple[int | None, int | None]:
            nonlocal last_completed, last_total
            if item.completed is not None:
                last_completed = item.completed
            if item.total is not None:
                last_total = item.total
            return last_completed, last_total

        def record_download(item: ModelPullProgress) -> None:
            completed, total = capture(item)
            progress(RuntimeInstallProgress(item.status or "model download running", completed, total, "model_download", True))

        def record_onboarding(item: ModelPullProgress) -> None:
            progress(RuntimeInstallProgress(item.status or "model onboarding running", item.completed, item.total, "model_onboarding", True))

        def record_verification(item: ModelPullProgress) -> None:
            completed, total = capture(item)
            progress(RuntimeInstallProgress(item.status or "model verification running", completed, total, "committing", False))

        try:
            onboarding = provider_capability(self._provider, ModelOnboardingProvider)
            if onboarding is not None:
                progress(RuntimeInstallProgress("Preparing model onboarding.", phase="model_onboarding", cancellable=True))
                onboarding.prepare_model_onboarding(record_onboarding)
            progress(RuntimeInstallProgress("Downloading the selected model.", phase="model_download", cancellable=True))
            model_provider.pull_model(record_download)
            progress(RuntimeInstallProgress("Committing the selected model.", last_completed, last_total, "committing", False))
            if onboarding is not None:
                progress(RuntimeInstallProgress("Verifying model onboarding.", last_completed, last_total, "committing", False))
                onboarding.verify_model_onboarding(record_verification)
                progress(RuntimeInstallProgress("Model onboarding verified.", last_completed, last_total, "committing", False))
        except Exception as exc:
            raise ProviderUnavailableError(f"{_provider_label(self.provider)} unavailable: {exc}") from exc
        return RuntimeInstallationStatus.SUCCEEDED


def _provider_label(provider: str) -> str:
    normalized = provider.strip().lower()
    if normalized == "ollama":
        return "Ollama"
    if normalized == "fake":
        return "Fake LLM"
    return provider.strip() or "LLM provider"
