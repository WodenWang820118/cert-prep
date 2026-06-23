"""Shared OCR provider contracts."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class OCRHealth:
    """Read-only health snapshot for a page-image OCR provider."""

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
    """Text and timing metadata extracted from one rendered PDF page image."""

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
        """Return OCR runtime availability without extracting page text."""
        pass

    def extract_page_text(self, image_png: bytes, page_number: int) -> OCRPageResult:
        """Extract OCR text from one rendered PDF page image."""
        pass


__all__ = ["OCRHealth", "OCRPageResult", "OCRProvider"]

