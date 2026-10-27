"""Use cases of the Source Library context, named after what the learner does with a source.

Importing and retrying a document still run in routers.documents, where they drive Capture
Review and draft generation too; they move here when step C6 takes the capture rules out of
the router.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from cert_prep_backend.platform.errors import InvalidSourceError
from cert_prep_backend.source_library.application.ports import (
    ChunkTranslator,
    DocumentOperationRepository,
    DocumentRepository,
    QueuedDocumentWork,
    SourceFileStore,
)
from cert_prep_backend.source_library.domain.document import (
    AUDIO_MEDIA_TYPES,
    AUDIO_SOURCE_UNAVAILABLE,
    DocumentChunk,
    MarkdownProjection,
    SourceDocument,
    edited_transcript_text,
)
from cert_prep_backend.source_library.domain.exceptions import SourceDocumentUnavailable
from cert_prep_backend.source_library.domain.operation import DocumentOperation

__all__ = [
    "cancel_operation",
    "cancel_processing",
    "edit_chunk",
    "export_markdown",
    "list_chunks",
    "list_documents",
    "open_audio_source",
    "recover_interrupted_work",
    "translate_chunk",
    "translate_stale_chunks",
    "view_document",
    "view_operation",
]


@dataclass(frozen=True, slots=True)
class AudioSource:
    """A stored recording that passed its integrity check, ready to be played."""

    path: Path
    media_type: str
    filename: str


def list_documents(documents: DocumentRepository, project_id: str) -> list[SourceDocument]:
    return documents.documents_of(project_id)


def view_document(
    documents: DocumentRepository, project_id: str, document_id: str
) -> SourceDocument:
    return documents.document(project_id, document_id)


def export_markdown(
    documents: DocumentRepository, project_id: str, document_id: str
) -> MarkdownProjection:
    document = documents.document(project_id, document_id)
    document.ensure_markdown_exportable()
    return MarkdownProjection(document, tuple(documents.chunks_of(project_id, document_id)))


def open_audio_source(
    documents: DocumentRepository,
    files: SourceFileStore,
    project_id: str,
    document_id: str,
) -> AudioSource:
    documents.document(project_id, document_id).ensure_playable()
    source_file = documents.source_file(project_id, document_id)
    try:
        path = files.resolve(project_id, source_file.storage_path)
        media_type = AUDIO_MEDIA_TYPES.get(path.suffix.lower())
        intact = media_type is not None and files.sha256(path) == source_file.sha256
    except InvalidSourceError as exc:
        raise SourceDocumentUnavailable(
            AUDIO_SOURCE_UNAVAILABLE, "The stored audio source is unavailable."
        ) from exc
    if not intact:
        raise SourceDocumentUnavailable(
            AUDIO_SOURCE_UNAVAILABLE, "The stored audio source failed integrity verification."
        )
    return AudioSource(path=path, media_type=media_type, filename=source_file.filename)


def view_operation(
    operations: DocumentOperationRepository, project_id: str, operation_id: str
) -> DocumentOperation:
    return operations.operation(project_id, operation_id)


def cancel_operation(
    operations: DocumentOperationRepository,
    queued_work: QueuedDocumentWork,
    project_id: str,
    operation_id: str,
) -> DocumentOperation:
    """Cancel an import or processing run; work still waiting in the queue stops at once."""

    operation = operations.cancel(project_id, operation_id)
    if queued_work.cancel(operation_id):
        return operations.operation(project_id, operation_id)
    return operation


def cancel_processing(
    operations: DocumentOperationRepository,
    queued_work: QueuedDocumentWork,
    project_id: str,
    document_id: str,
) -> DocumentOperation:
    """Cancel whatever is processing a document."""

    operation = operations.cancel_processing_of(project_id, document_id)
    if queued_work.cancel(operation.id):
        return operations.operation(project_id, operation.id)
    return operation


def list_chunks(
    documents: DocumentRepository, project_id: str, document_id: str
) -> list[DocumentChunk]:
    return documents.chunks_of(project_id, document_id)


def edit_chunk(
    documents: DocumentRepository,
    project_id: str,
    document_id: str,
    chunk_id: str,
    text: str,
) -> DocumentChunk:
    """Correct a transcript chunk; its translation becomes stale."""

    return documents.edit_chunk_text(
        project_id, document_id, chunk_id, edited_transcript_text(text)
    )


def translate_chunk(
    translator: ChunkTranslator, project_id: str, document_id: str, chunk_id: str
) -> DocumentChunk:
    return translator.translate_chunk(project_id, document_id, chunk_id)


def translate_stale_chunks(
    translator: ChunkTranslator, project_id: str, document_id: str
) -> list[DocumentChunk]:
    return translator.translate_stale_chunks(project_id, document_id)


def recover_interrupted_work(
    operations: DocumentOperationRepository, documents: DocumentRepository
) -> None:
    """After an app restart, settle the operations and documents it interrupted."""

    operations.recover_interrupted()
    documents.recover_processing()
