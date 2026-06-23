from __future__ import annotations

from collections.abc import Callable
import os
from tempfile import TemporaryDirectory
import shutil
import subprocess
from pathlib import Path

from exam_prep_backend.config import DEFAULT_OLLAMA_MODEL, Settings
from exam_prep_backend.domains.mock_exams.ports import ModelPullProgress
from exam_prep_backend.domains.runtime_installations.archive import (
    extract_zip_safely,
    resolve_ocr_runtime_artifact,
    verify_file_hash,
)
from exam_prep_backend.domains.runtime_installations.manifest import (
    load_ocr_runtime_source_manifest,
    write_installed_ocr_manifest,
)
from exam_prep_backend.domains.runtime_installations.models import (
    RuntimeInstallationStatus,
    RuntimeInstallProgress,
    RuntimeRequirementKind,
    RuntimeRequirementSnapshot,
)
from exam_prep_backend.domains.runtime_installations.ollama import (
    ensure_ollama_server_running,
    resolve_ollama_executable,
)
from exam_prep_backend.domains.runtime_installations.processes import run_ocr_runtime_command
from exam_prep_backend.domains.source_documents.ocr import OCRProvider
from exam_prep_backend.errors import ProviderUnavailableError


class OllamaRuntimeInstaller:
    """Installer and health snapshot for the Ollama executable runtime."""

    kind = RuntimeRequirementKind.OLLAMA
    provider = "ollama"
    model = ""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings

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

    def install(self, progress: Callable[[RuntimeInstallProgress], None]) -> RuntimeInstallationStatus:
        """Run the official Ollama Windows installer script."""

        progress(RuntimeInstallProgress("Starting the Ollama Windows installer."))
        if os.name != "nt":
            raise ProviderUnavailableError("Ollama installer automation is only configured for Windows.")

        command = ollama_windows_install_command()
        completed = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=max(60, int(self._settings.runtime_install_timeout_seconds)),
        )
        if completed.returncode != 0:
            output = (completed.stderr or completed.stdout or "").strip()
            raise ProviderUnavailableError(output or "Ollama installer failed.")
        executable = resolve_ollama_executable()
        if executable is None:
            return RuntimeInstallationStatus.WAITING_FOR_USER
        progress(RuntimeInstallProgress("Starting the Ollama local API."))
        if not ensure_ollama_server_running(
            self._settings.ollama_host,
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

    def install(self, progress: Callable[[RuntimeInstallProgress], None]) -> RuntimeInstallationStatus:
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

    def install(self, progress: Callable[[RuntimeInstallProgress], None]) -> RuntimeInstallationStatus:
        """Verify, extract, self-test, and install the packaged PaddleOCR runtime."""

        manifest = load_ocr_runtime_source_manifest(self._settings)
        artifact = resolve_ocr_runtime_artifact(manifest)
        progress(RuntimeInstallProgress("Verifying PaddleOCR runtime artifact.", total=manifest.bytes))
        verify_file_hash(artifact, manifest.sha256, expected_bytes=manifest.bytes)

        runtime_dir = self._settings.resolved_ocr_runtime_dir
        runtime_dir.parent.mkdir(parents=True, exist_ok=True)
        with TemporaryDirectory(dir=runtime_dir.parent) as temp_name:
            temp_dir = Path(temp_name)
            progress(RuntimeInstallProgress("Extracting PaddleOCR runtime artifact."))
            extract_zip_safely(artifact, temp_dir)
            entrypoint = temp_dir / manifest.entrypoint
            if not entrypoint.is_file():
                raise ProviderUnavailableError(
                    f"OCR runtime entrypoint was not found: {manifest.entrypoint}"
                )
            progress(RuntimeInstallProgress("Running PaddleOCR runtime self-test."))
            run_ocr_runtime_command(entrypoint, ["--ocr-self-test", "--device", "auto"])
            if runtime_dir.exists():
                shutil.rmtree(runtime_dir)
            shutil.move(str(temp_dir), runtime_dir)
        write_installed_ocr_manifest(runtime_dir, manifest)
        return RuntimeInstallationStatus.SUCCEEDED

class DirectMLOcrRuntimeInstaller:
    """Installer and health snapshot for the packaged AMD DirectML OCR runtime."""

    kind = RuntimeRequirementKind.DIRECTML_OCR
    provider = "directml"
    model = "pp-ocrv6-medium-directml"

    def __init__(self, settings: Settings, provider: OCRProvider) -> None:
        self._settings = settings
        self._provider = provider

    def requirement(self) -> RuntimeRequirementSnapshot:
        """Return AMD DirectML OCR runtime availability from the provider health check."""

        health = self._provider.health()
        return RuntimeRequirementSnapshot(
            kind=self.kind,
            label="AMD DirectML OCR runtime",
            available=health.available,
            detail=health.detail,
            unavailable_reason=health.unavailable_reason,
            version=health.paddleocr_version,
            installed_path=health.model_cache_dir,
        )

    def install(self, progress: Callable[[RuntimeInstallProgress], None]) -> RuntimeInstallationStatus:
        """Verify, extract, self-test, and install the packaged DirectML OCR runtime."""

        manifest = load_ocr_runtime_source_manifest(
            self._settings,
            kind=RuntimeRequirementKind.DIRECTML_OCR,
        )
        artifact = resolve_ocr_runtime_artifact(manifest)
        progress(
            RuntimeInstallProgress(
                "Verifying AMD DirectML OCR runtime artifact.",
                total=manifest.bytes,
            )
        )
        verify_file_hash(artifact, manifest.sha256, expected_bytes=manifest.bytes)

        runtime_dir = self._settings.resolved_directml_ocr_runtime_dir
        runtime_dir.parent.mkdir(parents=True, exist_ok=True)
        with TemporaryDirectory(dir=runtime_dir.parent) as temp_name:
            temp_dir = Path(temp_name)
            progress(RuntimeInstallProgress("Extracting AMD DirectML OCR runtime artifact."))
            extract_zip_safely(artifact, temp_dir)
            entrypoint = temp_dir / manifest.entrypoint
            if not entrypoint.is_file():
                raise ProviderUnavailableError(
                    f"OCR runtime entrypoint was not found: {manifest.entrypoint}"
                )
            progress(RuntimeInstallProgress("Running AMD DirectML OCR runtime self-test."))
            run_ocr_runtime_command(
                entrypoint,
                [
                    "--provider",
                    "directml",
                    "--model-dir",
                    str(temp_dir),
                    "--directml-device-id",
                    str(self._settings.ocr_directml_device_id),
                    "--ocr-self-test",
                ],
            )
            if runtime_dir.exists():
                shutil.rmtree(runtime_dir)
            shutil.move(str(temp_dir), runtime_dir)
        write_installed_ocr_manifest(runtime_dir, manifest)
        return RuntimeInstallationStatus.SUCCEEDED


class AmdNpuOcrRuntimeInstaller:
    """Installer and health snapshot for the packaged AMD NPU OCR runtime."""

    kind = RuntimeRequirementKind.AMD_NPU_OCR
    provider = "amd_npu"
    model = "pp-ocrv6-medium-amd-npu"

    def __init__(self, settings: Settings, provider: OCRProvider) -> None:
        self._settings = settings
        self._provider = provider

    def requirement(self) -> RuntimeRequirementSnapshot:
        """Return AMD NPU OCR runtime availability from the provider health check."""

        health = self._provider.health()
        return RuntimeRequirementSnapshot(
            kind=self.kind,
            label="AMD NPU OCR runtime",
            available=health.available,
            detail=health.detail,
            unavailable_reason=health.unavailable_reason,
            version=health.paddleocr_version,
            installed_path=health.model_cache_dir,
        )

    def install(self, progress: Callable[[RuntimeInstallProgress], None]) -> RuntimeInstallationStatus:
        """Verify, extract, self-test, and install the packaged AMD NPU OCR runtime."""

        manifest = load_ocr_runtime_source_manifest(
            self._settings,
            kind=RuntimeRequirementKind.AMD_NPU_OCR,
        )
        artifact = resolve_ocr_runtime_artifact(manifest)
        progress(
            RuntimeInstallProgress(
                "Verifying AMD NPU OCR runtime artifact.",
                total=manifest.bytes,
            )
        )
        verify_file_hash(artifact, manifest.sha256, expected_bytes=manifest.bytes)

        runtime_dir = self._settings.resolved_amd_npu_ocr_runtime_dir
        runtime_dir.parent.mkdir(parents=True, exist_ok=True)
        with TemporaryDirectory(dir=runtime_dir.parent) as temp_name:
            temp_dir = Path(temp_name)
            progress(RuntimeInstallProgress("Extracting AMD NPU OCR runtime artifact."))
            extract_zip_safely(artifact, temp_dir)
            entrypoint = temp_dir / manifest.entrypoint
            if not entrypoint.is_file():
                raise ProviderUnavailableError(
                    f"OCR runtime entrypoint was not found: {manifest.entrypoint}"
                )
            progress(RuntimeInstallProgress("Running AMD NPU OCR runtime self-test."))
            run_ocr_runtime_command(
                entrypoint,
                [
                    "--provider",
                    "amd_npu",
                    "--model-dir",
                    str(temp_dir),
                    "--directml-device-id",
                    str(self._settings.ocr_directml_device_id),
                    "--amd-npu-device-id",
                    self._settings.ocr_amd_npu_device_id,
                    "--amd-npu-policy",
                    self._settings.ocr_amd_npu_policy,
                    "--ensure-ready",
                    "--ocr-self-test",
                ],
            )
            if runtime_dir.exists():
                shutil.rmtree(runtime_dir)
            shutil.move(str(temp_dir), runtime_dir)
        write_installed_ocr_manifest(runtime_dir, manifest)
        return RuntimeInstallationStatus.SUCCEEDED
