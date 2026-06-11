from __future__ import annotations

from dataclasses import dataclass
import platform
from typing import Protocol

from exam_prep_backend.config import Settings


@dataclass(frozen=True)
class OCRHealth:
    provider: str
    engine: str
    available: bool
    detail: str
    python_version: str
    paddle_version: str | None
    paddleocr_version: str | None
    selected_device: str | None
    cuda_available: bool
    gpu_count: int
    model_cache_dir: str | None
    fallback_reason: str | None
    unavailable_reason: str | None = None


@dataclass(frozen=True)
class OCRPageResult:
    text: str
    extraction_method: str
    device: str | None
    fallback_reason: str | None
    duration_ms: int


class OCRProvider(Protocol):
    """Boundary for page-image OCR providers used by document ingestion."""

    provider: str
    engine: str

    def health(self) -> OCRHealth:
        pass

    def extract_page_text(self, image_png: bytes, page_number: int) -> OCRPageResult:
        pass


class FakeOCRProvider:
    provider = "fake"
    engine = "none"

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

        return PaddleOCRProvider(device=settings.ocr_device)
    if settings.ocr_provider == "ollama":
        from exam_prep_backend.domains.source_documents.adapters.ollama import OllamaOCRProvider

        return OllamaOCRProvider(
            host=settings.ollama_host,
            model=settings.ollama_model,
            timeout_seconds=settings.ollama_timeout_seconds,
        )
    return FakeOCRProvider()
