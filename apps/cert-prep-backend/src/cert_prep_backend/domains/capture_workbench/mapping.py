"""Deterministic adapters from CaptureDocumentV1 into Cert Prep persistence inputs."""

from __future__ import annotations

from dataclasses import dataclass

from cert_prep_contracts.transcription import TranscriptSegment

from cert_prep_backend.domains.capture_workbench.contracts import CaptureDocumentV1
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
    document: CaptureDocumentV1,
) -> PdfExtractionResult:
    pages: dict[int, list[tuple[str, str]]] = {}
    for block in document.blocks:
        if block.locator.kind != "page":
            raise ValueError("Document capture contains a non-page locator")
        pages.setdefault(block.locator.page, []).append(
            (block.source_text, block.target_text)
        )
    if not pages:
        raise ValueError("Document capture contains no page blocks")

    extracted_pages: list[ExtractedPage] = []
    extraction_method = _page_extraction_method(document)
    for page_number in sorted(pages):
        source_text = "\n".join(source for source, _target in pages[page_number])
        lines = line_metadata(source_text)
        classification = classify_exam_text(source_text)
        extracted_pages.append(
            ExtractedPage(
                page_number=page_number,
                text=source_text,
                raw_text=source_text,
                source_excerpt=source_text[:500],
                extraction_method=extraction_method,
                line_start=lines.line_start,
                line_end=lines.line_end,
                line_count=lines.line_count,
                content_profile=classification.content_profile,
            )
        )

    warnings = "; ".join(document.warnings) or None
    return PdfExtractionResult(
        page_count=max(pages),
        pages=tuple(extracted_pages),
        status="ready",
        extraction_method=extraction_method,
        ocr_device=document.extraction_engine.device,
        ocr_fallback_reason=warnings,
        ocr_duration_ms=0,
        processed_page_count=len(pages),
    )


def capture_document_to_audio_segments(
    document: CaptureDocumentV1,
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


def _page_extraction_method(document: CaptureDocumentV1) -> str:
    identity = (
        f"{document.extraction_engine.engine} {document.extraction_engine.model}"
    ).lower()
    if "embedded" in identity and "ocr" not in identity:
        return "embedded"
    return "windowsml_ocr"


__all__ = [
    "CaptureAudioSegment",
    "capture_document_to_audio_segments",
    "capture_document_to_pdf_extraction",
]
