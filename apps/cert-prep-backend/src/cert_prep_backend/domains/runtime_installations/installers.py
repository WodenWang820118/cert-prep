from __future__ import annotations

from collections.abc import Callable
from tempfile import TemporaryDirectory
import shutil
from pathlib import Path

from cert_prep_backend.core.config import Settings
from cert_prep_backend.domains.mock_exams.ports import (
    ModelDownloadProvider,
    ModelOnboardingProvider,
    provider_capability,
)
from cert_prep_backend.domains.runtime_installations.archive import (
    extract_zip_safely,
    resolve_ocr_runtime_artifact,
    verify_file_hash,
)
from cert_prep_backend.domains.runtime_installations.manifest import (
    load_ocr_runtime_source_manifest,
    write_installed_ocr_manifest,
)
from cert_prep_backend.domains.runtime_installations.processes import run_ocr_runtime_command
from cert_prep_backend.domains.source_documents.ocr import OCRProvider
from cert_prep_backend.api.errors import ProviderUnavailableError
from cert_prep_contracts.runtime import (
    RuntimeInstallationStatus,
    RuntimeInstallProgress,
    RuntimeRequirementKind,
    RuntimeRequirementSnapshot,
)
from cert_prep_contracts.llm import ModelPullProgress
from cert_prep_transcription_whisper import (
    REQUIRED_MODELS,
    WhisperModelDownloadProgress,
    WhisperModelRuntime,
)


class LLMModelInstaller:
    """Installer and health snapshot for the configured reasoning model."""

    def __init__(self, provider: object) -> None:
        self._provider = provider
        self.provider = str(getattr(provider, "provider", "llm"))
        self.model = str(getattr(provider, "model", "configured model"))
        self.kind = RuntimeRequirementKind.OLLAMA_MODEL

    def requirement(self) -> RuntimeRequirementSnapshot:
        """Return model availability without starting a download."""

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
        unavailable_reason = getattr(health, "unavailable_reason", None)
        available = bool(getattr(health, "available", False))
        detail = str(getattr(health, "detail", "Model health is unavailable."))
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
        """Raise when the configured provider cannot pull models."""

        if provider_capability(self._provider, ModelDownloadProvider) is None:
            raise ProviderUnavailableError(
                "Configured LLM provider does not support model downloads."
            )

    def install(
        self, progress: Callable[[RuntimeInstallProgress], None]
    ) -> RuntimeInstallationStatus:
        """Pull the configured model through the provider's download API."""

        model_provider = provider_capability(self._provider, ModelDownloadProvider)
        if model_provider is None:
            raise ProviderUnavailableError(
                "Configured LLM provider does not support model downloads."
            )

        last_completed: int | None = None
        last_total: int | None = None

        def capture_model_progress(
            model_progress: ModelPullProgress,
        ) -> tuple[int | None, int | None]:
            nonlocal last_completed, last_total
            if model_progress.completed is not None:
                last_completed = model_progress.completed
            if model_progress.total is not None:
                last_total = model_progress.total
            return last_completed, last_total

        def record_model_progress(model_progress: ModelPullProgress) -> None:
            completed, total = capture_model_progress(model_progress)
            progress(
                RuntimeInstallProgress(
                    detail=model_progress.status or "model download running",
                    completed=completed,
                    total=total,
                    phase="model_download",
                    cancellable=True,
                )
            )

        def record_preparation_progress(model_progress: ModelPullProgress) -> None:
            progress(
                RuntimeInstallProgress(
                    detail=model_progress.status or "model onboarding preparation running",
                    completed=model_progress.completed,
                    total=model_progress.total,
                    phase="model_onboarding",
                    cancellable=True,
                )
            )

        def record_verification_progress(model_progress: ModelPullProgress) -> None:
            completed, total = capture_model_progress(model_progress)
            progress(
                RuntimeInstallProgress(
                    detail=model_progress.status or "model verification running",
                    completed=completed,
                    total=total,
                    phase="committing",
                    cancellable=False,
                )
            )

        try:
            onboarding_provider = provider_capability(
                self._provider,
                ModelOnboardingProvider,
            )
            if onboarding_provider is not None:
                progress(
                    RuntimeInstallProgress(
                        "Preparing model onboarding.",
                        phase="model_onboarding",
                        cancellable=True,
                    )
                )
                onboarding_provider.prepare_model_onboarding(
                    record_preparation_progress
                )
            progress(
                RuntimeInstallProgress(
                    "Downloading the selected model.",
                    phase="model_download",
                    cancellable=True,
                )
            )
            model_provider.pull_model(record_model_progress)
            progress(
                RuntimeInstallProgress(
                    "Committing the selected model.",
                    completed=last_completed,
                    total=last_total,
                    phase="committing",
                    cancellable=False,
                )
            )
            if onboarding_provider is not None:
                progress(
                    RuntimeInstallProgress(
                        "Verifying model onboarding.",
                        completed=last_completed,
                        total=last_total,
                        phase="committing",
                        cancellable=False,
                    )
                )
                onboarding_provider.verify_model_onboarding(
                    record_verification_progress
                )
                progress(
                    RuntimeInstallProgress(
                        "Model onboarding verified.",
                        completed=last_completed,
                        total=last_total,
                        phase="committing",
                        cancellable=False,
                    )
                )
        except Exception as exc:
            raise ProviderUnavailableError(
                f"{_provider_label(self.provider)} unavailable: {exc}"
            ) from exc
        return RuntimeInstallationStatus.SUCCEEDED


class WhisperModelInstaller:
    """Inventory and consent-gated acquisition for the ASR/fallback model bundle."""

    kind = RuntimeRequirementKind.WHISPER_MODELS
    provider = "faster-whisper"
    model = " + ".join(REQUIRED_MODELS)

    def __init__(self, runtime: WhisperModelRuntime) -> None:
        self._runtime = runtime

    def requirement(self) -> RuntimeRequirementSnapshot:
        """Return local-only availability for both required Whisper models."""

        inventory = self._runtime.inventory()
        if inventory.available:
            detail = "Whisper large-v3-turbo and CPU small fallback are ready."
        else:
            missing = ", ".join(inventory.missing_models)
            detail = f"Whisper speech models require download: {missing}."
        return RuntimeRequirementSnapshot(
            kind=self.kind,
            label="Whisper speech models",
            available=inventory.available,
            detail=detail,
            unavailable_reason=None if inventory.available else "whisper_models_missing",
            version=self.model,
            bytes=inventory.bytes if inventory.available else None,
            installed_path=(
                inventory.installed_paths[0]
                if inventory.available and inventory.installed_paths
                else None
            ),
        )

    def install(
        self, progress: Callable[[RuntimeInstallProgress], None]
    ) -> RuntimeInstallationStatus:
        """Download the model bundle through the shared installation job owner."""

        def record(item: WhisperModelDownloadProgress) -> None:
            progress(
                RuntimeInstallProgress(
                    detail=item.detail,
                    completed=item.completed,
                    total=item.total,
                    phase=item.phase,
                    cancellable=item.cancellable,
                )
            )

        self._runtime.download(record)
        return RuntimeInstallationStatus.SUCCEEDED

    def cancel(self) -> None:
        """Request cancellation at the runtime's next download checkpoint."""

        self._runtime.cancel()


class PaddleOcrRuntimeInstaller:
    """Installer and health snapshot for the packaged PaddleOCR runtime."""

    kind = RuntimeRequirementKind.PADDLE_OCR
    provider = "paddle"
    model = "paddleocr"

    def __init__(self, settings: Settings, provider: OCRProvider) -> None:
        self._settings = settings
        self._provider = provider

    def requirement(self) -> RuntimeRequirementSnapshot:
        """Return PaddleOCR runtime availability from the OCR provider health check."""

        health = self._provider.health()
        return RuntimeRequirementSnapshot(
            kind=self.kind,
            label="PaddleOCR runtime",
            available=health.available,
            detail=health.detail,
            unavailable_reason=health.unavailable_reason,
            version=health.paddleocr_version,
            installed_path=health.model_cache_dir,
        )

    def install(
        self, progress: Callable[[RuntimeInstallProgress], None]
    ) -> RuntimeInstallationStatus:
        """Verify, extract, self-test, and install the packaged PaddleOCR runtime."""

        manifest = load_ocr_runtime_source_manifest(self._settings)
        progress(
            RuntimeInstallProgress(
                "Resolving PaddleOCR runtime artifact.",
                total=manifest.bytes,
                phase="downloading",
                cancellable=True,
            )
        )
        artifact = resolve_ocr_runtime_artifact(
            manifest,
            on_progress=lambda completed: progress(
                RuntimeInstallProgress(
                    "Downloading PaddleOCR runtime artifact.",
                    completed=completed,
                    total=manifest.bytes,
                    phase="downloading",
                    cancellable=True,
                )
            ),
        )
        progress(
            RuntimeInstallProgress(
                "Verifying PaddleOCR runtime artifact.",
                total=manifest.bytes,
                phase="verifying",
                cancellable=True,
            )
        )
        verify_file_hash(artifact, manifest.sha256, expected_bytes=manifest.bytes)

        runtime_dir = self._settings.resolved_ocr_runtime_dir
        runtime_dir.parent.mkdir(parents=True, exist_ok=True)
        with TemporaryDirectory(dir=runtime_dir.parent) as temp_name:
            temp_dir = Path(temp_name)
            progress(
                RuntimeInstallProgress(
                    "Extracting PaddleOCR runtime artifact.",
                    phase="extracting",
                    cancellable=True,
                )
            )
            extract_zip_safely(artifact, temp_dir)
            entrypoint = temp_dir / manifest.entrypoint
            if not entrypoint.is_file():
                raise ProviderUnavailableError(
                    f"OCR runtime entrypoint was not found: {manifest.entrypoint}"
                )
            progress(
                RuntimeInstallProgress(
                    "Running PaddleOCR runtime self-test.",
                    phase="self_test",
                    cancellable=True,
                )
            )
            run_ocr_runtime_command(entrypoint, ["--ocr-self-test", "--device", "auto"])
            progress(
                RuntimeInstallProgress(
                    "Committing PaddleOCR runtime.",
                    phase="committing",
                    cancellable=False,
                )
            )
            if runtime_dir.exists():
                shutil.rmtree(runtime_dir)
            shutil.move(str(temp_dir), runtime_dir)
        write_installed_ocr_manifest(runtime_dir, manifest)
        return RuntimeInstallationStatus.SUCCEEDED


def _provider_label(provider: str) -> str:
    normalized = provider.strip().lower()
    if normalized == "ollama":
        return "Ollama"
    if normalized == "fake":
        return "Fake LLM"
    return provider.strip() or "LLM provider"


class WindowsMLOcrRuntimeInstaller:
    """Installer and health snapshot for the packaged WindowsML OCR runtime."""

    kind = RuntimeRequirementKind.WINDOWSML_OCR
    provider = "windowsml"
    model = "pp-ocrv6-medium-windowsml"

    def __init__(self, settings: Settings, provider: OCRProvider) -> None:
        self._settings = settings
        self._provider = provider

    def requirement(self) -> RuntimeRequirementSnapshot:
        """Return WindowsML OCR runtime availability from the provider health check."""

        health = self._provider.health()
        return RuntimeRequirementSnapshot(
            kind=self.kind,
            label="WindowsML OCR runtime",
            available=health.available,
            detail=health.detail,
            unavailable_reason=health.unavailable_reason,
            version=health.paddleocr_version,
            installed_path=health.model_cache_dir,
        )

    def install(
        self, progress: Callable[[RuntimeInstallProgress], None]
    ) -> RuntimeInstallationStatus:
        """Verify, extract, self-test, and install the packaged WindowsML OCR runtime."""

        manifest = load_ocr_runtime_source_manifest(
            self._settings,
            kind=RuntimeRequirementKind.WINDOWSML_OCR,
        )
        progress(
            RuntimeInstallProgress(
                "Resolving WindowsML OCR runtime artifact.",
                total=manifest.bytes,
                phase="downloading",
                cancellable=True,
            )
        )
        artifact = resolve_ocr_runtime_artifact(
            manifest,
            on_progress=lambda completed: progress(
                RuntimeInstallProgress(
                    "Downloading WindowsML OCR runtime artifact.",
                    completed=completed,
                    total=manifest.bytes,
                    phase="downloading",
                    cancellable=True,
                )
            ),
        )
        progress(
            RuntimeInstallProgress(
                "Verifying WindowsML OCR runtime artifact.",
                total=manifest.bytes,
                phase="verifying",
                cancellable=True,
            )
        )
        verify_file_hash(artifact, manifest.sha256, expected_bytes=manifest.bytes)

        runtime_dir = self._settings.resolved_windowsml_ocr_runtime_dir
        runtime_dir.parent.mkdir(parents=True, exist_ok=True)
        with TemporaryDirectory(dir=runtime_dir.parent) as temp_name:
            temp_dir = Path(temp_name)
            progress(
                RuntimeInstallProgress(
                    "Extracting WindowsML OCR runtime artifact.",
                    phase="extracting",
                    cancellable=True,
                )
            )
            extract_zip_safely(artifact, temp_dir)
            entrypoint = temp_dir / manifest.entrypoint
            if not entrypoint.is_file():
                raise ProviderUnavailableError(
                    f"OCR runtime entrypoint was not found: {manifest.entrypoint}"
                )
            progress(
                RuntimeInstallProgress(
                    "Running WindowsML OCR runtime self-test.",
                    phase="self_test",
                    cancellable=True,
                )
            )
            run_ocr_runtime_command(
                entrypoint,
                [
                    "--provider",
                    "windowsml",
                    "--model-dir",
                    str(temp_dir),
                    "--windowsml-device-id",
                    str(self._settings.ocr_windowsml_device_id),
                    "--ocr-self-test",
                ],
            )
            progress(
                RuntimeInstallProgress(
                    "Committing WindowsML OCR runtime.",
                    phase="committing",
                    cancellable=False,
                )
            )
            if runtime_dir.exists():
                shutil.rmtree(runtime_dir)
            shutil.move(str(temp_dir), runtime_dir)
        write_installed_ocr_manifest(runtime_dir, manifest)
        return RuntimeInstallationStatus.SUCCEEDED
