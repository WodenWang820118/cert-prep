"""Source Library as the source of drafts: a document's chunks, and its count of drafts."""

from __future__ import annotations

from cert_prep_backend.authoring.domain.models import SourceChunk, source_chunk_from_document_chunk
from cert_prep_backend.source_library.application import use_cases as source_library
from cert_prep_backend.source_library.application.ports import DocumentRepository


class SourceLibraryDraftSources:
    """Reads chunks through Source Library's use cases and records a document's draft count."""

    def __init__(self, documents: DocumentRepository) -> None:
        self._documents = documents

    def chunks_of(self, project_id: str, document_id: str) -> list[SourceChunk]:
        return [
            source_chunk_from_document_chunk(chunk)
            for chunk in source_library.list_chunks(self._documents, project_id, document_id)
        ]

    def chunk(self, project_id: str, document_id: str, chunk_id: str) -> SourceChunk:
        return source_chunk_from_document_chunk(
            source_library.view_chunk(self._documents, project_id, document_id, chunk_id)
        )

    def record_draft_count(self, project_id: str, document_id: str, count: int) -> None:
        source_library.record_draft_count(self._documents, project_id, document_id, count)

    def record_import_draft_count(self, project_id: str, document_id: str, count: int) -> None:
        source_library.record_import_draft_count(self._documents, project_id, document_id, count)
