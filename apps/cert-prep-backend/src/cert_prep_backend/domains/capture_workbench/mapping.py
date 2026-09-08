"""Deterministic adapters from CaptureDocument into Cert Prep persistence inputs."""

from __future__ import annotations

from dataclasses import dataclass

from cert_prep_contracts.transcription import TranscriptSegment

from capture_runtime_client import (
    CaptureDocument,
    RawCapture,
)
from cert_prep_backend.domains.capture_workbench.host_models import CaptureReview
from cert_prep_backend.domains.capture_workbench.review import reviewed_text_overrides
from cert_prep_backend.domains.exam_content import classify_exam_text, line_metadata
from cert_prep_backend.domains.source_documents.models import (
    ExtractedPage,
    PdfExtractionResult,
)


@dataclass(frozen=True, slots=True)
class CaptureAudioSegment:
    transcript: TranscriptSegment
    target_text: str


def capture_document_to_pdf_extraction(
    document: CaptureDocument,
    *,
    review: CaptureReview | None = None,
    ocr_projection: object | None = None,
) -> PdfExtractionResult:
    overrides = (
        reviewed_text_overrides(
            RawCapture(
                schema_version=document.schema_version,
                diagnostic_only=True,
                source=document.source,
                segments=document.raw_segments,
                source_text=document.source_text,
                extraction_engine=document.extraction_engine,
                warnings=document.warnings,
                created_at=document.created_at,
            ),
            review,
        )
        if review is not None
        else {}
    )
    pages: dict[int, list[tuple[str, str]]] = {}
    for block in document.blocks:
        if block.locator.kind != "page":
            raise ValueError("Document capture contains a non-page locator")
        reviewed = overrides.get(block.source_segment_id, block.target_text)
        pages.setdefault(block.locator.page, []).append((block.source_text, reviewed))
    if not pages:
        raise ValueError("Document capture contains no page blocks")

    projection_pages = {
        getattr(page, "page"): page
        for page in (
            getattr(ocr_projection, "pages", [])
            if ocr_projection is not None
            else []
        )
    }
    extracted_pages: list[ExtractedPage] = []
    extraction_method = _ocr_only_extraction_method(document)
    for page_number in sorted(pages):
        projection_page = projection_pages.get(page_number)
        if ocr_projection is not None and projection_page is None:
            raise ValueError("Capture OCR projection is missing a persisted page")
        raw_text = "\n".join(source for source, _reviewed in pages[page_number])
        if projection_page is not None:
            raw_text = str(getattr(projection_page, "text", ""))
        source_text = "\n".join(reviewed for _source, reviewed in pages[page_number])
        lines = line_metadata(source_text)
        classification = classify_exam_text(source_text)
        extracted_pages.append(
            ExtractedPage(
                page_number=page_number,
                text=source_text,
                raw_text=raw_text,
                source_excerpt=source_text[:500],
                extraction_method=extraction_method,
                line_start=lines.line_start,
                line_end=lines.line_end,
                line_count=lines.line_count,
                content_profile=classification.content_profile,
            )
        )

    projection_warnings = (
        [str(value) for value in getattr(ocr_projection, "warnings", [])]
        if ocr_projection is not None
        else []
    )
    warnings = "; ".join((*document.warnings, *projection_warnings)) or None
    projection_provenance = (
        getattr(ocr_projection, "provenance", None)
        if ocr_projection is not None
        else None
    )
    ocr_device = (
        getattr(projection_provenance, "device", None)
        if projection_provenance is not None
        else document.extraction_engine.device
    )
    page_count = (
        int(getattr(ocr_projection, "page_count"))
        if ocr_projection is not None
        else max(pages)
    )
    return PdfExtractionResult(
        page_count=page_count,
        pages=tuple(extracted_pages),
        status="ready",
        extraction_method=extraction_method,
        ocr_device=ocr_device,
        ocr_fallback_reason=warnings,
        ocr_duration_ms=0,
        processed_page_count=page_count if ocr_projection is not None else len(pages),
    )


def capture_document_to_audio_segments(
    document: CaptureDocument,
) -> tuple[CaptureAudioSegment, ...]:
    segments: list[CaptureAudioSegment] = []
    for block in document.blocks:
        if block.locator.kind != "time":
            raise ValueError("Audio capture contains a non-time locator")
        segments.append(
            CaptureAudioSegment(
                transcript=TranscriptSegment(
                    start_ms=block.locator.start_ms,
                    end_ms=block.locator.end_ms,
                    text=block.source_text,
                ),
                target_text=block.target_text,
            )
        )
    if not segments:
        raise ValueError("Audio capture contains no transcript blocks")
    return tuple(segments)


def _ocr_only_extraction_method(document: CaptureDocument) -> str:
    engine = document.extraction_engine.engine.lower()
    identity = (
        f"{document.extraction_engine.engine} {document.extraction_engine.model}"
    ).lower()
    if "embedded" in identity or "mixed" in identity:
        raise ValueError(
            "Capture document extraction provenance violates the OCR-only contract."
        )
    if not any(marker in engine for marker in ("ocr", "windowsml", "paddle")):
        raise ValueError(
            "Capture document extraction provenance is not canonical OCR-only."
        )
    return "windowsml_ocr"


__all__ = [
    "CaptureAudioSegment",
    "capture_document_to_audio_segments",
    "capture_document_to_pdf_extraction",
]
