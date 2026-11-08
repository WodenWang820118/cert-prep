"""Use cases of the Source Library context, named after what the learner does with a source.

Importing a document runs its extraction (Capture Integration) and starts its question drafts
(Question Authoring) through ports, so this context does not depend on either.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
from collections.abc import Callable
from dataclasses import dataclass
from functools import partial
from pathlib import Path

from cert_prep_backend.platform.errors import (
    DocumentOperationConflictError,
    DocumentOperationStateError,
    DocumentProcessingCanceledError,
    InvalidSourceError,
    NotFoundError,
    OperationNotCancellableError,
    ProviderUnavailableError,
)
from cert_prep_backend.projects.application.ports import ProjectRepository
from cert_prep_backend.projects.application.use_cases import require_project
from cert_prep_backend.source_library.application.errors import (
    SourceExtractionFailed,
    SourceTextNotDetected,
    SourceTooLarge,
)
from cert_prep_backend.source_library.application.ports import (
    ChunkTranslator,
    DocumentOperationRepository,
    DocumentRepository,
    DocumentWork,
    ImportedDocumentDrafting,
    QueuedDocumentWork,
    SourceExtraction,
    SourceFileStore,
    SourceLimits,
    SourceUpload,
)
from cert_prep_backend.source_library.domain.document import (
    AUDIO_MEDIA_TYPES,
    AUDIO_SOURCE_UNAVAILABLE,
    DocumentChunk,
    MarkdownProjection,
    SourceDocument,
    edited_transcript_text,
    language_hint_or_auto,
    upload_size_limit,
)
from cert_prep_backend.source_library.domain.exceptions import SourceDocumentUnavailable
from cert_prep_backend.source_library.domain.operation import DocumentOperation
from cert_prep_backend.source_library.domain.statuses import DocumentOperationStatus

__all__ = [
    "cancel_operation",
    "cancel_processing",
    "edit_chunk",
    "export_markdown",
    "import_document",
    "list_chunks",
    "list_documents",
    "open_audio_source",
    "receive_upload",
    "record_draft_count",
    "record_import_draft_count",
    "recover_interrupted_work",
    "retry_document_processing",
    "translate_chunk",
    "translate_stale_chunks",
    "view_active_operation",
    "view_chunk",
    "view_document",
    "view_operation",
    "view_operation_progress",
]

logger = logging.getLogger(__name__)
_UPLOAD_READ_BYTES = 1024 * 1024
_UPLOAD_CANCELED = "Document upload was canceled before it started."
_OPERATION_IN_USE = "Document operation id is already in use."
_UPLOAD_REJECTED = "Document upload did not pass validation."
_SOURCE_REJECTED = "Source validation failed."
_UPLOAD_FAILED = "Document upload failed."
_PROCESSING_FAILED = "Document processing failed."
_WORKER_REFUSED = "Document worker could not accept processing."
_CANCEL_CLEANUP_FAILED = "Document processing was canceled but cleanup failed."
_NO_ACTIVE_OPERATION = "Active document operation was not found."


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


def record_draft_count(
    documents: DocumentRepository, project_id: str, document_id: str, count: int
) -> None:
    """Record the document's count of drafts after the learner had drafts written: a processing
    document stays processing, any other becomes ready."""

    document = documents.document(project_id, document_id)
    documents.record_exam_state(
        project_id, document_id, status=document.status_after_drafts(), exam_item_count=count
    )


def record_import_draft_count(
    documents: DocumentRepository, project_id: str, document_id: str, count: int
) -> None:
    """Record the document's count of drafts written after it was imported: ready when it has
    text and chunks, exam_failed otherwise, and still processing if it was."""

    document = documents.document(project_id, document_id)
    documents.record_exam_state(
        project_id,
        document_id,
        status=document.status_after_import_drafts(),
        exam_item_count=count,
    )


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


def view_chunk(
    documents: DocumentRepository, project_id: str, document_id: str, chunk_id: str
) -> DocumentChunk:
    """One chunk of a document, which another context cites as a draft's source."""
    return documents.chunk(project_id, document_id, chunk_id)


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



@dataclass(frozen=True, slots=True)
class OperationProgress:
    """An operation and the document it processes, as the operation's event stream shows them."""

    operation: DocumentOperation
    document: SourceDocument | None


def view_operation_progress(
    operations: DocumentOperationRepository,
    documents: DocumentRepository,
    project_id: str,
    operation_id: str,
) -> OperationProgress:
    operation = operations.operation(project_id, operation_id)
    document = None
    if operation.document_id is not None:
        document = documents.document(project_id, str(operation.document_id))
    return OperationProgress(operation=operation, document=document)


def view_active_operation(
    operations: DocumentOperationRepository, project_id: str, document_id: str
) -> DocumentOperation:
    """The operation still queued, running or canceling for a document."""

    operation = operations.active_operation_of(project_id, document_id)
    if operation is None:
        raise NotFoundError(_NO_ACTIVE_OPERATION)
    return operation


async def receive_upload(upload: SourceUpload, max_bytes: int) -> bytes:
    """Read an uploaded file, refusing it as soon as it passes its size limit."""

    chunks: list[bytes] = []
    total_size = 0
    while chunk := await upload.read(_UPLOAD_READ_BYTES):
        total_size += len(chunk)
        if total_size > max_bytes:
            raise SourceTooLarge(f"Source file is too large; the limit is {max_bytes} bytes.")
        chunks.append(chunk)
    return b"".join(chunks)


@dataclass(frozen=True, slots=True)
class _SourceToExtract:
    """The source a processing run extracts: kept in memory when the run happens inside the
    request, read back from storage (and checked again) when it runs in the background."""

    kind: str
    canonical_suffix: str
    sha256: str
    file_name: str | None = None
    storage_path: str | None = None
    content: bytes | None = None


async def import_document(
    projects: ProjectRepository,
    documents: DocumentRepository,
    operations: DocumentOperationRepository,
    files: SourceFileStore,
    work: DocumentWork,
    extraction: SourceExtraction,
    drafting: ImportedDocumentDrafting,
    *,
    project_id: str,
    operation_id: str,
    upload: SourceUpload,
    filename: str | None,
    language_hint: str,
    limits: SourceLimits,
    in_background: bool,
) -> SourceDocument | DocumentOperation:
    """Import a PDF, image or recording without a capture review: claim the operation id,
    validate and store the file, attach its document, then extract its text and start its
    drafts, in the background or within the request.

    Once the id is claimed, a rejected or failed upload fails the operation; a cancellation,
    a conflict, or a missing project or document leaves it as it is.
    """

    claimed = False
    try:
        require_project(projects, project_id)
        operation, acquired = operations.claim(project_id, operation_id)
        if not acquired:
            if operation.is_canceling_or_canceled:
                raise DocumentProcessingCanceledError(_UPLOAD_CANCELED)
            raise DocumentOperationConflictError(_OPERATION_IN_USE)
        claimed = True
        content = await receive_upload(
            upload,
            upload_size_limit(
                filename,
                max_bytes=limits.max_upload_bytes,
                max_audio_bytes=limits.max_audio_upload_bytes,
            ),
        )
        prepared = await asyncio.to_thread(
            files.prepare,
            content,
            max_pdf_pages=limits.max_pdf_pages,
            max_image_pixels=limits.max_image_pixels,
            filename=filename,
        )
        operations.operation(project_id, operation_id).ensure_awaiting_upload()
        sha256, storage_path = await asyncio.to_thread(
            _store_source,
            files,
            project_id=project_id,
            content=content,
            canonical_suffix=prepared.canonical_suffix,
        )
        operations.operation(project_id, operation_id).ensure_awaiting_upload()
        document = documents.attach_document(
            project_id,
            operation_id,
            filename=filename or f"{sha256}{prepared.canonical_suffix}",
            sha256=sha256,
            language_hint=language_hint_or_auto(language_hint),
            storage_path=storage_path,
            page_count=prepared.page_count,
            source_kind="audio" if prepared.kind == "audio" else "document",
            duration_ms=prepared.duration_ms,
        )
        process = partial(
            _process_document,
            operations,
            documents,
            files,
            extraction,
            drafting,
            project_id=project_id,
            document_id=document.id,
            operation_id=operation_id,
        )
        if in_background:
            stored = _SourceToExtract(
                kind=prepared.kind,
                canonical_suffix=prepared.canonical_suffix,
                sha256=sha256,
                file_name=document.filename,
                storage_path=storage_path,
            )
            _queue_processing(
                operations,
                work,
                process,
                project_id=project_id,
                document_id=document.id,
                operation_id=operation_id,
                source=stored,
            )
            return documents.document(project_id, document.id)
        return process(
            source=_SourceToExtract(
                kind=prepared.kind,
                canonical_suffix=prepared.canonical_suffix,
                sha256=sha256,
                content=prepared.raw_bytes,
            )
        )
    except SourceTooLarge:
        if claimed:
            operations.fail(project_id, operation_id, error=_UPLOAD_REJECTED)
        raise
    except InvalidSourceError:
        if claimed:
            operations.fail(project_id, operation_id, error=_SOURCE_REJECTED)
        raise
    except ProviderUnavailableError as exc:
        if claimed:
            operations.fail(project_id, operation_id, error=str(exc))
        raise
    except (
        NotFoundError,
        DocumentProcessingCanceledError,
        DocumentOperationConflictError,
        OperationNotCancellableError,
        DocumentOperationStateError,
    ):
        raise
    except Exception:
        if claimed:
            operations.fail(project_id, operation_id, error=_UPLOAD_FAILED)
        raise


async def retry_document_processing(
    documents: DocumentRepository,
    operations: DocumentOperationRepository,
    files: SourceFileStore,
    work: DocumentWork,
    extraction: SourceExtraction,
    drafting: ImportedDocumentDrafting,
    *,
    project_id: str,
    document_id: str,
    operation_id: str,
    limits: SourceLimits,
    in_background: bool,
) -> DocumentOperation:
    """Process a document again from its stored source, under a new operation id.

    InvalidSourceError when the stored source is missing or was changed."""

    document = documents.document(project_id, document_id)
    source_file = documents.source_file(project_id, document_id)
    source_path = await asyncio.to_thread(
        files.verified_path, project_id, source_file.storage_path, source_file.sha256
    )
    canonical_suffix = source_path.suffix.lower()
    if in_background:
        source = _SourceToExtract(
            kind=(
                "audio"
                if document.source_kind == "audio"
                else "pdf" if canonical_suffix == ".pdf" else "image"
            ),
            canonical_suffix=canonical_suffix,
            sha256=source_file.sha256,
            file_name=source_file.filename,
            storage_path=str(source_path),
        )
    else:
        content = await asyncio.to_thread(
            files.verified_content, project_id, source_file.storage_path, source_file.sha256
        )
        prepared = await asyncio.to_thread(
            files.prepare,
            content,
            max_pdf_pages=limits.max_pdf_pages,
            max_image_pixels=limits.max_image_pixels,
            filename=source_file.filename,
        )
        source = _SourceToExtract(
            kind=prepared.kind,
            canonical_suffix=prepared.canonical_suffix,
            sha256=source_file.sha256,
            content=prepared.raw_bytes,
        )
    operations.start_retry(project_id, document_id, operation_id)
    process = partial(
        _process_document,
        operations,
        documents,
        files,
        extraction,
        drafting,
        project_id=project_id,
        document_id=document_id,
        operation_id=operation_id,
    )
    if in_background:
        _queue_processing(
            operations,
            work,
            process,
            project_id=project_id,
            document_id=document_id,
            operation_id=operation_id,
            source=source,
        )
    else:
        process(source=source)
    return operations.operation(project_id, operation_id)


def _store_source(
    files: SourceFileStore, *, project_id: str, content: bytes, canonical_suffix: str
) -> tuple[str, str]:
    sha256 = hashlib.sha256(content).hexdigest()
    return sha256, files.store(
        project_id=project_id,
        sha256=sha256,
        content=content,
        canonical_suffix=canonical_suffix,
    )


def _queue_processing(
    operations: DocumentOperationRepository,
    work: DocumentWork,
    process: Callable[..., object],
    *,
    project_id: str,
    document_id: str,
    operation_id: str,
    source: _SourceToExtract,
) -> None:
    """Hand processing to the worker pool. A cancellation that arrived while it was queued
    is acknowledged here when the pool no longer holds the work."""

    try:
        work.submit(
            operation_id=operation_id,
            run=partial(process, source=source, shutdown_requested=work.is_closed),
            cancel_queued=partial(
                _cancel_queued_processing,
                operations,
                project_id=project_id,
                operation_id=operation_id,
            ),
        )
    except Exception:
        operations.fail(project_id, operation_id, error=_WORKER_REFUSED)
        raise
    operation = operations.operation(project_id, operation_id)
    if (
        operation.document_id == document_id
        and operation.status == DocumentOperationStatus.RUNNING
    ):
        return
    if (
        work.cancel(operation_id) is False
        and operation.status == DocumentOperationStatus.CANCEL_REQUESTED
    ):
        operations.acknowledge_cancellation(project_id, operation_id)


def _cancel_queued_processing(
    operations: DocumentOperationRepository, *, project_id: str, operation_id: str
) -> None:
    operation = operations.operation(project_id, operation_id)
    if operation.is_terminal:
        return
    if operation.status != DocumentOperationStatus.CANCEL_REQUESTED:
        operation = operations.cancel(project_id, operation_id)
    if operation.status == DocumentOperationStatus.CANCEL_REQUESTED:
        operations.acknowledge_cancellation(project_id, operation_id)


def _process_document(
    operations: DocumentOperationRepository,
    documents: DocumentRepository,
    files: SourceFileStore,
    extraction: SourceExtraction,
    drafting: ImportedDocumentDrafting,
    *,
    project_id: str,
    document_id: str,
    operation_id: str,
    source: _SourceToExtract,
    shutdown_requested: Callable[[], bool] = lambda: False,
) -> SourceDocument | DocumentOperation:
    """Extract a document's text and start its drafts; settle the operation when it stops.

    A canceled run is acknowledged. When extraction finds no text, the failed operation is
    returned and the document keeps the no_text_detected status. Other failures fail the
    operation and propagate."""

    try:
        return _extract_and_draft(
            operations,
            documents,
            files,
            extraction,
            drafting,
            project_id=project_id,
            document_id=document_id,
            operation_id=operation_id,
            source=source,
            shutdown_requested=shutdown_requested,
        )
    except DocumentProcessingCanceledError:
        try:
            if shutdown_requested():
                operations.cancel(project_id, operation_id)
            operations.acknowledge_cancellation(project_id, operation_id)
        except (DocumentOperationStateError, OperationNotCancellableError):
            operations.fail(project_id, operation_id, error=_CANCEL_CLEANUP_FAILED)
        return documents.document(project_id, document_id)
    except ProviderUnavailableError as exc:
        operations.fail(project_id, operation_id, error=str(exc))
        raise
    except SourceTextNotDetected as exc:
        return operations.fail(
            project_id,
            operation_id,
            error=str(exc),
            document_status="no_text_detected",
            extraction_method="none",
        )
    except SourceExtractionFailed as exc:
        operations.fail(project_id, operation_id, error=str(exc))
        raise
    except Exception:
        logger.exception(
            "Document processing failed",
            extra={"project_id": project_id, "document_id": document_id},
        )
        operations.fail(project_id, operation_id, error=_PROCESSING_FAILED)
        raise


def _extract_and_draft(
    operations: DocumentOperationRepository,
    documents: DocumentRepository,
    files: SourceFileStore,
    extraction: SourceExtraction,
    drafting: ImportedDocumentDrafting,
    *,
    project_id: str,
    document_id: str,
    operation_id: str,
    source: _SourceToExtract,
    shutdown_requested: Callable[[], bool],
) -> SourceDocument:
    document = documents.document(project_id, document_id)
    if source.content is None:
        assert source.storage_path is not None
        content = files.verified_content(project_id, source.storage_path, source.sha256)
        sha256 = source.sha256
    else:
        content = source.content
        sha256 = hashlib.sha256(content).hexdigest()
    file_name = source.file_name if source.file_name is not None else document.filename

    def should_cancel() -> bool:
        if shutdown_requested():
            return True
        return not operations.operation(project_id, operation_id).is_processing(document_id)

    try:
        document = extraction.extract(
            project_id=project_id,
            document_id=document_id,
            operation_id=operation_id,
            file_name=str(file_name),
            content=content,
            canonical_suffix=source.canonical_suffix,
            source_kind=source.kind,
            sha256=sha256,
            language_hint=document.language_hint,
            should_cancel=should_cancel,
        )
    finally:
        del content
    if document.chunks_count > 0:
        drafting.draft_questions(project_id, document_id)
        document = documents.document(project_id, document_id)
    return document
