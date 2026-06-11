from __future__ import annotations

from typing import Protocol

from .models import PdfExtraction, SourceDocument, SourceDocumentChunk, SourcePdf
from .statuses import SourceDocumentStatus


class PdfTextExtractor(Protocol):
    """Extracts text and OCR metadata from a source PDF without storing it."""

    def extract(self, source_pdf: SourcePdf) -> PdfExtraction:
        ...


class SourceDocumentRepository(Protocol):
    """Persists source-document snapshots and exposes citation chunks."""

    def add_extracted_document(
        self,
        *,
        project_id: str,
        source_pdf: SourcePdf,
        extraction: PdfExtraction,
    ) -> SourceDocument:
        ...

    def get(self, *, project_id: str, document_id: str) -> SourceDocument:
        ...

    def list_chunks(self, *, project_id: str, document_id: str) -> tuple[SourceDocumentChunk, ...]:
        ...

    def update_exam_state(
        self,
        *,
        project_id: str,
        document_id: str,
        status: SourceDocumentStatus,
        exam_item_count: int,
    ) -> SourceDocument:
        ...
