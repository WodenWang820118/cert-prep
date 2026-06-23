from __future__ import annotations

from dataclasses import asdict, dataclass
from pathlib import Path
from time import perf_counter
from typing import Any

from cert_prep_backend.config import Settings
from cert_prep_backend.domains.source_documents.ocr import (
    OCRProvider,
    ocr_provider_from_settings,
)
from cert_prep_backend.domains.source_documents.pdf_extraction import render_pdf_page_png


@dataclass(frozen=True)
class OCRBenchmarkResult:
    pdf_path: str
    page_number: int
    render_scale: float
    render_ms: int
    image_bytes: int
    provider: str
    engine: str
    device: str | None
    extraction_method: str
    fallback_reason: str | None
    cold_ocr_ms: int
    warm_ocr_ms: int
    chars: int
    chars_per_second: float
    pages_per_minute: float
    text_preview: str
    anchors_present: dict[str, bool]


def benchmark_pdf_page(
    settings: Settings,
    *,
    pdf_path: Path,
    page_number: int = 3,
    anchors: list[str] | None = None,
    provider: OCRProvider | None = None,
) -> dict[str, Any]:
    pdf_bytes = pdf_path.read_bytes()
    render_started_at = perf_counter()
    image_png = render_pdf_page_png(
        pdf_bytes,
        page_index=page_number - 1,
        scale=settings.ocr_render_scale,
    )
    render_ms = _elapsed_ms(render_started_at)

    ocr_provider = provider or ocr_provider_from_settings(settings)
    cold = ocr_provider.extract_page_text(image_png, page_number)
    warm = ocr_provider.extract_page_text(image_png, page_number)
    text = warm.text
    warm_seconds = max(warm.duration_ms / 1000, 0.001)
    result = OCRBenchmarkResult(
        pdf_path=str(pdf_path),
        page_number=page_number,
        render_scale=settings.ocr_render_scale,
        render_ms=render_ms,
        image_bytes=len(image_png),
        provider=ocr_provider.provider,
        engine=ocr_provider.engine,
        device=warm.device,
        extraction_method=warm.extraction_method,
        fallback_reason=warm.fallback_reason,
        cold_ocr_ms=cold.duration_ms,
        warm_ocr_ms=warm.duration_ms,
        chars=len(text),
        chars_per_second=round(len(text) / warm_seconds, 2),
        pages_per_minute=round(60 / warm_seconds, 2),
        text_preview=text[:500],
        anchors_present={anchor: anchor in text for anchor in anchors or []},
    )
    return asdict(result)


def _elapsed_ms(started_at: float) -> int:
    return max(0, round((perf_counter() - started_at) * 1000))
