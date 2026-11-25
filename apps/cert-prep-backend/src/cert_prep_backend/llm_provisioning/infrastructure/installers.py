from __future__ import annotations

from collections.abc import Callable

from cert_prep_backend.llm_provisioning.application.ports import LLMInstaller

from cert_prep_backend.platform.errors import InstallerUnavailable
from cert_prep_backend.ai_providers.domain.provider import (
    ModelDownloadProvider,
    ModelOnboardingProvider,
    provider_capability,
)
from cert_prep_contracts.llm import ModelPullProgress
from cert_prep_contracts.llm_installation import (
    LLMInstallationStatus,
    LLMInstallProgress,
    LLMRequirementKind,
    LLMRequirementSnapshot,
)


class ConfiguredLLMInstallers:
    """Configured lanes, preserving enum order, override and selected-model behavior."""

    def __init__(
        self,
        defaults: list[LLMInstaller],
        preferred_model_kind: LLMRequirementKind,
        overrides: list[LLMInstaller] | None = None,
    ) -> None:
        self._installers = {installer.kind: installer for installer in (overrides or defaults)}
        self.selected_model_kind = (
            preferred_model_kind
            if preferred_model_kind in self._installers
            else next(
                (kind for kind in (LLMRequirementKind.OLLAMA_MODEL,) if kind in self._installers),
                preferred_model_kind,
            )
        )

    def ordered(self) -> list[LLMInstaller]:
        return [self._installers[kind] for kind in LLMRequirementKind if kind in self._installers]

    def get(self, kind: LLMRequirementKind) -> LLMInstaller | None:
        return self._installers.get(kind)


class LLMModelInstaller:
    """Installer and health snapshot for the configured reasoning model."""

    kind = LLMRequirementKind.OLLAMA_MODEL

    def __init__(self, provider: object) -> None:
        self._provider = provider
        self.provider = str(getattr(provider, "provider", "llm"))
        self.model = str(getattr(provider, "model", "configured model"))

    def requirement(self) -> LLMRequirementSnapshot:
        model_provider = provider_capability(self._provider, ModelDownloadProvider)
        if model_provider is None:
            return LLMRequirementSnapshot(
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
        return LLMRequirementSnapshot(
            kind=self.kind,
            label=f"{_provider_label(self.provider)} model",
            available=available,
            detail=detail,
            unavailable_reason=unavailable_reason,
            version=self.model,
        )

    def validate_installable(self) -> None:
        if provider_capability(self._provider, ModelDownloadProvider) is None:
            raise InstallerUnavailable(
                "Configured LLM provider does not support model downloads."
            )

    def install(self, progress: Callable[[LLMInstallProgress], None]) -> LLMInstallationStatus:
        model_provider = provider_capability(self._provider, ModelDownloadProvider)
        if model_provider is None:
            raise InstallerUnavailable(
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
            progress(LLMInstallProgress(item.status or "model download running", completed, total, "model_download", True))

        def record_onboarding(item: ModelPullProgress) -> None:
            progress(LLMInstallProgress(item.status or "model onboarding running", item.completed, item.total, "model_onboarding", True))

        def record_verification(item: ModelPullProgress) -> None:
            completed, total = capture(item)
            progress(LLMInstallProgress(item.status or "model verification running", completed, total, "committing", False))

        try:
            onboarding = provider_capability(self._provider, ModelOnboardingProvider)
            if onboarding is not None:
                progress(LLMInstallProgress("Preparing model onboarding.", phase="model_onboarding", cancellable=True))
                onboarding.prepare_model_onboarding(record_onboarding)
            progress(LLMInstallProgress("Downloading the selected model.", phase="model_download", cancellable=True))
            model_provider.pull_model(record_download)
            progress(LLMInstallProgress("Committing the selected model.", last_completed, last_total, "committing", False))
            if onboarding is not None:
                progress(LLMInstallProgress("Verifying model onboarding.", last_completed, last_total, "committing", False))
                onboarding.verify_model_onboarding(record_verification)
                progress(LLMInstallProgress("Model onboarding verified.", last_completed, last_total, "committing", False))
        except Exception as exc:
            raise InstallerUnavailable(f"{_provider_label(self.provider)} unavailable: {exc}") from exc
        return LLMInstallationStatus.SUCCEEDED


def _provider_label(provider: str) -> str:
    normalized = provider.strip().lower()
    if normalized == "ollama":
        return "Ollama"
    if normalized == "fake":
        return "Fake LLM"
    return provider.strip() or "LLM provider"
