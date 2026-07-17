from __future__ import annotations

from dataclasses import dataclass

from cert_prep_backend.domains.exam_content import ContentProfileValue

from .statuses import PdfExtractionMethodValue, SourceDocumentStatus, SourceDocumentStatusValue


DocumentStatus = SourceDocumentStatusValue
ExtractionMethod = PdfExtractionMethodValue


@dataclass(frozen=True, slots=True)
class SourceFile:
    filename: str
    sha256: str
    storage_path: str
    content: bytes | None = None


@dataclass(frozen=True, slots=True)
class ExtractedPage:
    page_number: int
    text: str
    source_excerpt: str
    extraction_method: PdfExtractionMethodValue
    raw_text: str = ""
    line_start: int | None = None
    line_end: int | None = None
    line_count: int = 0
    content_profile: ContentProfileValue = "unknown"


@dataclass(frozen=True, slots=True)
class PdfExtraction:
    page_count: int
    pages: tuple[ExtractedPage, ...]
    status: SourceDocumentStatus
    extraction_method: PdfExtractionMethodValue
    ocr_device: str | None
    ocr_fallback_reason: str | None
    ocr_duration_ms: int
    processed_page_count: int
    parse_wall_duration_ms: int = 0
    render_duration_ms: int = 0
    ocr_engine_duration_ms: int = 0
    ocr_worker_count: int = 0
    first_chunk_ms: int = 0

    @property
    def has_text(self) -> bool:
        return bool(self.pages)


PdfExtractionResult = PdfExtraction


@dataclass(frozen=True, slots=True)
class SourceDocument:
    id: str
    project_id: str
    filename: str
    sha256: str
    language_hint: str
    page_count: int
    has_text: bool
    status: SourceDocumentStatus
    extraction_method: PdfExtractionMethodValue
    ocr_device: str | None
    ocr_fallback_reason: str | None
    ocr_duration_ms: int
    processed_page_count: int
    parse_wall_duration_ms: int
    render_duration_ms: int
    ocr_engine_duration_ms: int
    ocr_worker_count: int
    first_chunk_ms: int
    exam_item_count: int
    content_profile: ContentProfileValue
    classification_detail: str
    chunks_count: int
    created_at: str
    updated_at: str


@dataclass(frozen=True, slots=True)
class SourceDocumentChunk:
    id: str
    document_id: str
    page_number: int
    chunk_index: int
    text: str
    raw_text: str
    line_start: int | None
    line_end: int | None
    line_count: int
    source_excerpt: str
    extraction_method: PdfExtractionMethodValue
    content_profile: ContentProfileValue
    created_at: str
