from __future__ import annotations

from cert_prep_backend.platform.database import Database
from cert_prep_backend.source_library.domain.document import (
    DocumentChunk,
    SourceDocument,
    SourceFile,
)
from cert_prep_backend.source_library.domain.operation import DocumentOperation
from cert_prep_backend.source_library.infrastructure import operations
from cert_prep_backend.source_library.infrastructure.chunks import (
    get_chunk,
    get_source_chunks,
    list_chunks,
    update_chunk_text,
    update_chunk_translation,
)
from cert_prep_backend.source_library.infrastructure.documents import (
    get_document,
    get_source_file,
    list_documents,
    update_exam_state,
)
from cert_prep_backend.source_library.infrastructure.progress import (
    record_extraction_progress,
    recover_processing_documents,
)
from cert_prep_backend.source_library.infrastructure.records import ensure_document_exists



class SqliteDocumentRepository:
    """Source documents and their chunks."""

    def __init__(self, db: Database) -> None:
        self._db = db

    def documents_of(self, project_id: str) -> list[SourceDocument]:
        return list_documents(self._db, project_id)

    def document(self, project_id: str, document_id: str) -> SourceDocument:
        return get_document(self._db, project_id, document_id)

    def source_file(self, project_id: str, document_id: str) -> SourceFile:
        return get_source_file(self._db, project_id, document_id)

    def chunks_of(self, project_id: str, document_id: str) -> list[DocumentChunk]:
        return list_chunks(self._db, project_id, document_id)

    def edit_chunk_text(
        self, project_id: str, document_id: str, chunk_id: str, text: str
    ) -> DocumentChunk:
        return update_chunk_text(self._db, project_id, document_id, chunk_id, text)

    def recover_processing(self) -> int:
        return recover_processing_documents(self._db)


class SqliteDocumentOperationRepository:
    """Document operations. Each transition is one transaction that stores what the
    DocumentOperation decided, guarded by the state it decided from."""

    def __init__(self, db: Database) -> None:
        self._db = db

    def operation(self, project_id: str, operation_id: str) -> DocumentOperation:
        return operations.get_operation(self._db, project_id=project_id, operation_id=operation_id)

    def cancel(self, project_id: str, operation_id: str) -> DocumentOperation:
        return operations.cancel_operation(
            self._db, project_id=project_id, operation_id=operation_id
        )

    def cancel_processing_of(self, project_id: str, document_id: str) -> DocumentOperation:
        return operations.cancel_document_processing(
            self._db, project_id=project_id, document_id=document_id
        )

    def recover_interrupted(self) -> int:
        return operations.recover_operations(self._db)


__all__ = [
    "SqliteDocumentOperationRepository",
    "SqliteDocumentRepository",
    "ensure_document_exists",
    "get_chunk",
    "get_document",
    "get_source_file",
    "get_source_chunks",
    "list_chunks",
    "list_documents",
    "record_extraction_progress",
    "recover_processing_documents",
    "update_exam_state",
    "update_chunk_translation",
]
