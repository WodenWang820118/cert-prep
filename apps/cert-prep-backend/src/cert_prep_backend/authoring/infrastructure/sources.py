"""Source Library as the source of drafts: a document's chunks, and its count of drafts."""

from __future__ import annotations

from cert_prep_backend.authoring.domain.models import SourceChunk, source_chunk_from_document_chunk
from cert_prep_backend.platform.database import Database
from cert_prep_backend.source_library.application import use_cases as source_library
from cert_prep_backend.source_library.application.ports import DocumentRepository
from cert_prep_backend.source_library.infrastructure import repository as source_documents_repository


class SourceLibraryDraftSources:
    """Reads chunks through Source Library's use cases and records a document's draft count."""

    def __init__(self, documents: DocumentRepository, db: Database) -> None:
        self._documents = documents
        self._db = db

    def chunks_of(self, project_id: str, document_id: str) -> list[SourceChunk]:
        return [
            source_chunk_from_document_chunk(chunk)
            for chunk in source_library.list_chunks(self._documents, project_id, document_id)
        ]

    def record_draft_count(self, project_id: str, document_id: str, count: int) -> None:
        # The document's exam state belongs to Source Library, which gets a use case for it
        # when step C5 settles table ownership; until then this writes it directly.
        document = source_library.view_document(self._documents, project_id, document_id)
        source_documents_repository.update_exam_state(
            self._db,
            project_id=project_id,
            document_id=document_id,
            status="processing" if document.status == "processing" else "ready",
            exam_item_count=count,
        )
