from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class OCRHealth:
    """Read-only health snapshot for the WindowsML OCR runtime."""

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
    """Text and timing metadata extracted from one page image."""

    text: str
    extraction_method: str
    device: str | None
    fallback_reason: str | None
    duration_ms: int
