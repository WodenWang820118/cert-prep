from __future__ import annotations

import platform

from exam_prep_backend.config import Settings
from exam_prep_backend.exceptions import ProviderUnavailableError
from exam_prep_backend.domains.source_documents.ocr_contracts import (
    OCRHealth,
    OCRPageResult,
    OCRProvider,
)


class FakeOCRProvider:
    """Deterministic OCR provider used when OCR is not configured."""

    provider = "fake"
    engine = "none"
    page_workers = 1

    def health(self) -> OCRHealth:
        return OCRHealth(
            provider=self.provider,
            engine=self.engine,
            available=True,
            detail="deterministic local fake OCR provider",
            python_version=platform.python_version(),
            paddle_version=None,
            paddleocr_version=None,
            selected_device=None,
            cuda_available=False,
            gpu_count=0,
            model_cache_dir=None,
            fallback_reason=None,
            unavailable_reason=None,
        )

    def extract_page_text(self, image_png: bytes, page_number: int) -> OCRPageResult:
        return OCRPageResult(
            text="",
            extraction_method="none",
            device=None,
            fallback_reason=None,
            duration_ms=0,
        )


def ocr_provider_from_settings(settings: Settings) -> OCRProvider:
    """Build the configured OCR provider without importing optional stacks eagerly."""

    if settings.ocr_provider == "paddle":
        if settings.ocr_runtime_mode == "external":
            from exam_prep_backend.domains.source_documents.adapters.external_paddle import (
                ExternalPaddleOCRProvider,
            )

            return ExternalPaddleOCRProvider(settings=settings)
        from exam_prep_backend.domains.source_documents.adapters.paddle import PaddleOCRProvider

        return PaddleOCRProvider(
            device=settings.ocr_device,
            page_workers=settings.ocr_page_workers,
        )
    if settings.ocr_provider == "ollama":
        from exam_prep_backend.domains.source_documents.adapters.ollama import OllamaOCRProvider

        return OllamaOCRProvider(
            host=settings.ollama_host,
            model=settings.ollama_model,
            timeout_seconds=settings.ollama_timeout_seconds,
        )
    if settings.ocr_provider == "windowsml":
        if settings.ocr_runtime_mode == "external":
            from exam_prep_backend.domains.source_documents.adapters.external_windowsml import (
                ExternalWindowsMLOCRProvider,
            )

            return ExternalWindowsMLOCRProvider(settings=settings)
        raise ProviderUnavailableError(
            "WindowsML provider requires external runtime mode and does not support inprocess."
        )
    return FakeOCRProvider()
