from __future__ import annotations

from dataclasses import dataclass

from .statuses import PdfExtractionMethodValue, SourceDocumentStatus, SourceDocumentStatusValue


DocumentStatus = SourceDocumentStatusValue
ExtractionMethod = PdfExtractionMethodValue


@dataclass(frozen=True, slots=True)
class SourcePdf:
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
    page_count: int
    has_text: bool
    status: SourceDocumentStatus
    extraction_method: PdfExtractionMethodValue
    ocr_device: str | None
    ocr_fallback_reason: str | None
    ocr_duration_ms: int
    processed_page_count: int
    exam_item_count: int
    chunks_count: int
    created_at: str


@dataclass(frozen=True, slots=True)
class SourceDocumentChunk:
    id: str
    document_id: str
    page_number: int
    chunk_index: int
    text: str
    source_excerpt: str
    extraction_method: PdfExtractionMethodValue
    created_at: str
