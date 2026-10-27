from __future__ import annotations

from typing import Protocol

from cert_prep_backend.source_library.domain.models import PdfExtraction, SourceDocument, DocumentChunk, SourceFile
from cert_prep_backend.source_library.domain.statuses import SourceDocumentStatus


class SourceTextExtractor(Protocol):
    """Extracts text and OCR metadata from a source file without storing it."""

    def extract(self, source_file: SourceFile) -> PdfExtraction:
        ...


class SourceDocumentRepository(Protocol):
    """Persists source-document snapshots and exposes citation chunks."""

    def add_extracted_document(
        self,
        *,
        project_id: str,
        source_file: SourceFile,
        extraction: PdfExtraction,
    ) -> SourceDocument:
        ...

    def get(self, *, project_id: str, document_id: str) -> SourceDocument:
        ...

    def list_chunks(self, *, project_id: str, document_id: str) -> tuple[DocumentChunk, ...]:
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
