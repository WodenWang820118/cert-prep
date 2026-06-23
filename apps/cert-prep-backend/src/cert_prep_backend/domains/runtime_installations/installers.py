from __future__ import annotations

from collections.abc import Callable
from tempfile import TemporaryDirectory
import shutil
from pathlib import Path

from cert_prep_backend.core.config import Settings
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
        artifact = resolve_ocr_runtime_artifact(manifest)
        progress(
            RuntimeInstallProgress("Verifying PaddleOCR runtime artifact.", total=manifest.bytes)
        )
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
        artifact = resolve_ocr_runtime_artifact(manifest)
        progress(
            RuntimeInstallProgress(
                "Verifying WindowsML OCR runtime artifact.",
                total=manifest.bytes,
            )
        )
        verify_file_hash(artifact, manifest.sha256, expected_bytes=manifest.bytes)

        runtime_dir = self._settings.resolved_windowsml_ocr_runtime_dir
        runtime_dir.parent.mkdir(parents=True, exist_ok=True)
        with TemporaryDirectory(dir=runtime_dir.parent) as temp_name:
            temp_dir = Path(temp_name)
            progress(RuntimeInstallProgress("Extracting WindowsML OCR runtime artifact."))
            extract_zip_safely(artifact, temp_dir)
            entrypoint = temp_dir / manifest.entrypoint
            if not entrypoint.is_file():
                raise ProviderUnavailableError(
                    f"OCR runtime entrypoint was not found: {manifest.entrypoint}"
                )
            progress(RuntimeInstallProgress("Running WindowsML OCR runtime self-test."))
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
            if runtime_dir.exists():
                shutil.rmtree(runtime_dir)
            shutil.move(str(temp_dir), runtime_dir)
        write_installed_ocr_manifest(runtime_dir, manifest)
        return RuntimeInstallationStatus.SUCCEEDED
