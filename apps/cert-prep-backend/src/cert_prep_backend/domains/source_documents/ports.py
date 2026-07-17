from __future__ import annotations

from typing import Protocol

from .models import PdfExtraction, SourceDocument, SourceDocumentChunk, SourceFile
from .statuses import SourceDocumentStatus


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
