"""What the Source Library use cases need from storage, stored files, translation and the
document worker pool."""

from __future__ import annotations

from pathlib import Path
from typing import Protocol

from cert_prep_backend.source_library.domain.document import (
    DocumentChunk,
    SourceDocument,
    SourceFile,
)
from cert_prep_backend.source_library.domain.operation import DocumentOperation


class DocumentRepository(Protocol):
    """Documents and chunks; NotFoundError when the project or document does not exist."""

    def documents_of(self, project_id: str) -> list[SourceDocument]: ...

    def document(self, project_id: str, document_id: str) -> SourceDocument: ...

    def source_file(self, project_id: str, document_id: str) -> SourceFile: ...

    def chunks_of(self, project_id: str, document_id: str) -> list[DocumentChunk]: ...

    def edit_chunk_text(
        self, project_id: str, document_id: str, chunk_id: str, text: str
    ) -> DocumentChunk:
        """Store a transcript chunk's new text as a new revision; its translation goes stale."""
        ...

    def recover_processing(self) -> int:
        """Settle documents an app restart left marked as processing."""
        ...


class DocumentOperationRepository(Protocol):
    """Operations; each transition is stored atomically, guarded by the state it came from."""

    def operation(self, project_id: str, operation_id: str) -> DocumentOperation: ...

    def cancel(self, project_id: str, operation_id: str) -> DocumentOperation:
        """Cancel or request cancellation; an unknown id is stored as canceled before it starts."""
        ...

    def cancel_processing_of(self, project_id: str, document_id: str) -> DocumentOperation:
        """Cancel the operation processing a document."""
        ...

    def recover_interrupted(self) -> int:
        """Acknowledge requested cancellations and fail work an app restart interrupted."""
        ...


class SourceFileStore(Protocol):
    def resolve(self, project_id: str, storage_path: str) -> Path:
        """The stored file; InvalidSourceError when it is missing or outside the project."""
        ...

    def sha256(self, source_path: Path) -> str: ...


class ChunkTranslator(Protocol):
    def translate_chunk(
        self, project_id: str, document_id: str, chunk_id: str
    ) -> DocumentChunk: ...

    def translate_stale_chunks(self, project_id: str, document_id: str) -> list[DocumentChunk]:
        """Translate every transcript chunk edited since its translation was made."""
        ...


class QueuedDocumentWork(Protocol):
    def cancel(self, operation_id: str) -> bool:
        """Drop the operation's work if it is still queued; True when its cancellation was stored."""
        ...
