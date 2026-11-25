"""Use cases of the Source Library context, named after what the learner does with a source.

Importing a source runs its extraction (Capture Integration) and starts its questions
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

from cert_prep_contracts.sources import SourceKind

from cert_prep_backend.platform.errors import (
    CaptureRequirementUnavailable,
    CaptureRuntimeUnavailable,
    SourceOperationConflictError,
    SourceOperationStateError,
    SourceProcessingCanceledError,
    InvalidSourceError,
    NotFoundError,
    OperationNotCancellableError,
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
    SourceOperationRepository,
    SourceRepository,
    SourceWork,
    ImportedQuestionGeneration,
    QueuedSourceWork,
    SourceExtraction,
    SourceFileStore,
    SourceLimits,
    SourceUpload,
)
from cert_prep_backend.source_library.domain.source import (
    AUDIO_MEDIA_TYPES,
    AUDIO_SOURCE_UNAVAILABLE,
    SourceChunk,
    MarkdownProjection,
    Source,
    edited_transcript_text,
    language_hint_or_auto,
    upload_size_limit,
)
from cert_prep_backend.source_library.domain.exceptions import SourceUnavailable
from cert_prep_backend.source_library.domain.operation import SourceOperation
from cert_prep_backend.source_library.domain.statuses import SourceOperationStatus

__all__ = [
    "cancel_operation",
    "cancel_processing",
    "edit_chunk",
    "export_markdown",
    "import_source",
    "list_chunks",
    "list_sources",
    "open_audio_source",
    "receive_upload",
    "record_question_count",
    "record_import_question_count",
    "record_authored_question_count",
    "recover_interrupted_work",
    "retry_source_processing",
    "translate_chunk",
    "translate_stale_chunks",
    "view_active_operation",
    "view_chunk",
    "view_source",
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


def list_sources(sources: SourceRepository, project_id: str) -> list[Source]:
    return sources.sources_of(project_id)


def view_source(
    sources: SourceRepository, project_id: str, source_id: str
) -> Source:
    return sources.source(project_id, source_id)


def record_question_count(
    sources: SourceRepository, project_id: str, source_id: str, count: int
) -> None:
    """Record the source's count of questions after the learner had questions written: a processing
    source stays processing, any other becomes ready."""

    source = sources.source(project_id, source_id)
    sources.record_question_count(
        project_id, source_id, status=source.status_after_questions(), question_count=count
    )


def record_import_question_count(
    sources: SourceRepository, project_id: str, source_id: str, count: int
) -> None:
    """Record the source's count of questions written after it was imported: ready when it has
    text and chunks, no_text_detected otherwise, and still processing if it was."""

    source = sources.source(project_id, source_id)
    sources.record_question_count(
        project_id,
        source_id,
        status=source.status_after_import_questions(),
        question_count=count,
    )


def record_authored_question_count(
    sources: SourceRepository, project_id: str, source_id: str, count: int
) -> None:
    """Store the count only; status, failure message and `updated_at` stay.

    The count is every question the source has, which the caller counted.
    """

    sources.source(project_id, source_id)
    sources.record_authored_question_count(project_id, source_id, question_count=count)


def export_markdown(
    sources: SourceRepository, project_id: str, source_id: str
) -> MarkdownProjection:
    source = sources.source(project_id, source_id)
    source.ensure_markdown_exportable()
    return MarkdownProjection(source, tuple(sources.chunks_of(project_id, source_id)))


def open_audio_source(
    sources: SourceRepository,
    files: SourceFileStore,
    project_id: str,
    source_id: str,
) -> AudioSource:
    sources.source(project_id, source_id).ensure_playable()
    source_file = sources.source_file(project_id, source_id)
    try:
        path = files.resolve(project_id, source_file.storage_path)
        media_type = AUDIO_MEDIA_TYPES.get(path.suffix.lower())
        intact = media_type is not None and files.sha256(path) == source_file.sha256
    except InvalidSourceError as exc:
        raise SourceUnavailable(
            AUDIO_SOURCE_UNAVAILABLE, "The stored audio source is unavailable."
        ) from exc
    if not intact:
        raise SourceUnavailable(
            AUDIO_SOURCE_UNAVAILABLE, "The stored audio source failed integrity verification."
        )
    return AudioSource(path=path, media_type=media_type, filename=source_file.filename)


def view_operation(
    operations: SourceOperationRepository, project_id: str, operation_id: str
) -> SourceOperation:
    return operations.operation(project_id, operation_id)


def cancel_operation(
    operations: SourceOperationRepository,
    queued_work: QueuedSourceWork,
    project_id: str,
    operation_id: str,
) -> SourceOperation:
    """Cancel an import or processing run; work still waiting in the queue stops at once."""

    operation = operations.cancel(project_id, operation_id)
    if queued_work.cancel(operation_id):
        return operations.operation(project_id, operation_id)
    return operation


def cancel_processing(
    operations: SourceOperationRepository,
    queued_work: QueuedSourceWork,
    project_id: str,
    source_id: str,
) -> SourceOperation:
    """Cancel whatever is processing a source."""

    operation = operations.cancel_processing_of(project_id, source_id)
    if queued_work.cancel(operation.id):
        return operations.operation(project_id, operation.id)
    return operation


def list_chunks(
    sources: SourceRepository, project_id: str, source_id: str
) -> list[SourceChunk]:
    return sources.chunks_of(project_id, source_id)


def view_chunk(
    sources: SourceRepository, project_id: str, source_id: str, chunk_id: str
) -> SourceChunk:
    """One chunk of a source, which another context cites as a question's source."""
    return sources.chunk(project_id, source_id, chunk_id)


def edit_chunk(
    sources: SourceRepository,
    project_id: str,
    source_id: str,
    chunk_id: str,
    text: str,
) -> SourceChunk:
    """Correct a transcript chunk; its translation becomes stale."""

    return sources.edit_chunk_text(
        project_id, source_id, chunk_id, edited_transcript_text(text)
    )


def translate_chunk(
    translator: ChunkTranslator, project_id: str, source_id: str, chunk_id: str
) -> SourceChunk:
    return translator.translate_chunk(project_id, source_id, chunk_id)


def translate_stale_chunks(
    translator: ChunkTranslator, project_id: str, source_id: str
) -> list[SourceChunk]:
    return translator.translate_stale_chunks(project_id, source_id)


def recover_interrupted_work(
    operations: SourceOperationRepository, sources: SourceRepository
) -> None:
    """After an app restart, settle the operations and sources it interrupted."""

    operations.recover_interrupted()
    sources.recover_processing()



@dataclass(frozen=True, slots=True)
class OperationProgress:
    """An operation and the source it processes, as the operation's event stream shows them."""

    operation: SourceOperation
    source: Source | None


def view_operation_progress(
    operations: SourceOperationRepository,
    sources: SourceRepository,
    project_id: str,
    operation_id: str,
) -> OperationProgress:
    operation = operations.operation(project_id, operation_id)
    source = None
    if operation.source_id is not None:
        source = sources.source(project_id, str(operation.source_id))
    return OperationProgress(operation=operation, source=source)


def view_active_operation(
    operations: SourceOperationRepository, project_id: str, source_id: str
) -> SourceOperation:
    """The operation still queued, running or canceling for a source."""

    operation = operations.active_operation_of(project_id, source_id)
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

    kind: SourceKind
    canonical_suffix: str
    sha256: str
    file_name: str | None = None
    storage_path: str | None = None
    content: bytes | None = None


async def import_source(
    projects: ProjectRepository,
    sources: SourceRepository,
    operations: SourceOperationRepository,
    files: SourceFileStore,
    work: SourceWork,
    extraction: SourceExtraction,
    question_generation: ImportedQuestionGeneration,
    *,
    project_id: str,
    operation_id: str,
    upload: SourceUpload,
    filename: str | None,
    language_hint: str,
    limits: SourceLimits,
    in_background: bool,
) -> Source:
    """Import a PDF, image or recording without a capture review: claim the operation id,
    validate and store the file, attach its source, then extract its text and start its
    questions, in the background or within the request. Returns the source; one whose
    extraction found no text has the no_text_detected status and its failed operation.

    Once the id is claimed, a rejected or failed upload fails the operation; a cancellation,
    a conflict, or a missing project or source leaves it as it is.
    """

    claimed = False
    try:
        require_project(projects, project_id)
        operation, acquired = operations.claim(project_id, operation_id)
        if not acquired:
            if operation.is_canceling_or_canceled:
                raise SourceProcessingCanceledError(_UPLOAD_CANCELED)
            raise SourceOperationConflictError(_OPERATION_IN_USE)
        claimed = True
        content = await receive_upload(
            upload,
            upload_size_limit(
                filename,
                max_page_source_bytes=limits.max_page_source_upload_bytes,
                max_recording_bytes=limits.max_recording_upload_bytes,
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
        source = sources.attach_source(
            project_id,
            operation_id,
            filename=filename or f"{sha256}{prepared.canonical_suffix}",
            sha256=sha256,
            language_hint=language_hint_or_auto(language_hint),
            storage_path=storage_path,
            page_count=prepared.page_count,
            source_kind=prepared.kind,
            duration_ms=prepared.duration_ms,
        )
        process = partial(
            _process_source,
            operations,
            sources,
            files,
            extraction,
            question_generation,
            project_id=project_id,
            source_id=source.id,
            operation_id=operation_id,
        )
        if in_background:
            stored = _SourceToExtract(
                kind=prepared.kind,
                canonical_suffix=prepared.canonical_suffix,
                sha256=sha256,
                file_name=source.filename,
                storage_path=storage_path,
            )
            _queue_processing(
                operations,
                work,
                process,
                project_id=project_id,
                source_id=source.id,
                operation_id=operation_id,
                source=stored,
            )
            return sources.source(project_id, source.id)
        processed = process(
            source=_SourceToExtract(
                kind=prepared.kind,
                canonical_suffix=prepared.canonical_suffix,
                sha256=sha256,
                content=prepared.raw_bytes,
            )
        )
        if isinstance(processed, Source):
            return processed
        # Extraction found no text: the operation failed and the source records it.
        return sources.source(project_id, source.id)
    except SourceTooLarge:
        if claimed:
            operations.fail(project_id, operation_id, error=_UPLOAD_REJECTED)
        raise
    except InvalidSourceError:
        if claimed:
            operations.fail(project_id, operation_id, error=_SOURCE_REJECTED)
        raise
    except CaptureRequirementUnavailable as exc:
        if claimed:
            operations.fail(project_id, operation_id, error=str(exc))
        raise
    except (
        NotFoundError,
        SourceProcessingCanceledError,
        SourceOperationConflictError,
        OperationNotCancellableError,
        SourceOperationStateError,
    ):
        raise
    except Exception:
        if claimed:
            operations.fail(project_id, operation_id, error=_UPLOAD_FAILED)
        raise


async def retry_source_processing(
    sources: SourceRepository,
    operations: SourceOperationRepository,
    files: SourceFileStore,
    work: SourceWork,
    extraction: SourceExtraction,
    question_generation: ImportedQuestionGeneration,
    *,
    project_id: str,
    source_id: str,
    operation_id: str,
    limits: SourceLimits,
    in_background: bool,
) -> SourceOperation:
    """Process a source again from its stored file, under a new operation id.

    InvalidSourceError when the stored file is missing or was changed."""

    imported_source = sources.source(project_id, source_id)
    source_file = sources.source_file(project_id, source_id)
    source_path = await asyncio.to_thread(
        files.verified_path, project_id, source_file.storage_path, source_file.sha256
    )
    canonical_suffix = source_path.suffix.lower()
    if in_background:
        source = _SourceToExtract(
            kind=imported_source.source_kind,
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
            kind=imported_source.source_kind,
            canonical_suffix=prepared.canonical_suffix,
            sha256=source_file.sha256,
            content=prepared.raw_bytes,
        )
    operations.start_retry(project_id, source_id, operation_id)
    process = partial(
        _process_source,
        operations,
        sources,
        files,
        extraction,
        question_generation,
        project_id=project_id,
        source_id=source_id,
        operation_id=operation_id,
    )
    if in_background:
        _queue_processing(
            operations,
            work,
            process,
            project_id=project_id,
            source_id=source_id,
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
    operations: SourceOperationRepository,
    work: SourceWork,
    process: Callable[..., object],
    *,
    project_id: str,
    source_id: str,
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
        operation.source_id == source_id
        and operation.status == SourceOperationStatus.RUNNING
    ):
        return
    if (
        work.cancel(operation_id) is False
        and operation.status == SourceOperationStatus.CANCEL_REQUESTED
    ):
        operations.acknowledge_cancellation(project_id, operation_id)


def _cancel_queued_processing(
    operations: SourceOperationRepository, *, project_id: str, operation_id: str
) -> None:
    operation = operations.operation(project_id, operation_id)
    if operation.is_terminal:
        return
    if operation.status != SourceOperationStatus.CANCEL_REQUESTED:
        operation = operations.cancel(project_id, operation_id)
    if operation.status == SourceOperationStatus.CANCEL_REQUESTED:
        operations.acknowledge_cancellation(project_id, operation_id)


def _process_source(
    operations: SourceOperationRepository,
    sources: SourceRepository,
    files: SourceFileStore,
    extraction: SourceExtraction,
    question_generation: ImportedQuestionGeneration,
    *,
    project_id: str,
    source_id: str,
    operation_id: str,
    source: _SourceToExtract,
    shutdown_requested: Callable[[], bool] = lambda: False,
) -> Source | SourceOperation:
    """Extract a source's text and start its questions; settle the operation when it stops.

    A canceled run is acknowledged. When extraction finds no text, the failed operation is
    returned and the source keeps the no_text_detected status. Other failures fail the
    operation and propagate."""

    try:
        return _extract_and_generate_questions(
            operations,
            sources,
            files,
            extraction,
            question_generation,
            project_id=project_id,
            source_id=source_id,
            operation_id=operation_id,
            source=source,
            shutdown_requested=shutdown_requested,
        )
    except SourceProcessingCanceledError:
        try:
            if shutdown_requested():
                operations.cancel(project_id, operation_id)
            operations.acknowledge_cancellation(project_id, operation_id)
        except (SourceOperationStateError, OperationNotCancellableError):
            operations.fail(project_id, operation_id, error=_CANCEL_CLEANUP_FAILED)
        return sources.source(project_id, source_id)
    except CaptureRequirementUnavailable as exc:
        operations.fail(project_id, operation_id, error=str(exc))
        raise
    except CaptureRuntimeUnavailable:
        # An expected outage, not a defect: no traceback. The operation keeps the generic
        # Cert-owned text it stored for this case before the error had its own type; the API
        # reports capture_runtime_unavailable.
        logger.warning(
            "Capture Runtime is unavailable for document processing",
            extra={"project_id": project_id, "source_id": source_id},
        )
        operations.fail(project_id, operation_id, error=_PROCESSING_FAILED)
        raise
    except SourceTextNotDetected as exc:
        return operations.fail(
            project_id,
            operation_id,
            error=str(exc),
            source_status="no_text_detected",
            extraction_method="none",
        )
    except SourceExtractionFailed as exc:
        operations.fail(project_id, operation_id, error=str(exc))
        raise
    except Exception:
        logger.exception(
            "Document processing failed",
            extra={"project_id": project_id, "source_id": source_id},
        )
        operations.fail(project_id, operation_id, error=_PROCESSING_FAILED)
        raise


def _extract_and_generate_questions(
    operations: SourceOperationRepository,
    sources: SourceRepository,
    files: SourceFileStore,
    extraction: SourceExtraction,
    question_generation: ImportedQuestionGeneration,
    *,
    project_id: str,
    source_id: str,
    operation_id: str,
    source: _SourceToExtract,
    shutdown_requested: Callable[[], bool],
) -> Source:
    imported_source = sources.source(project_id, source_id)
    if source.content is None:
        assert source.storage_path is not None
        content = files.verified_content(project_id, source.storage_path, source.sha256)
        sha256 = source.sha256
    else:
        content = source.content
        sha256 = hashlib.sha256(content).hexdigest()
    file_name = (
        source.file_name if source.file_name is not None else imported_source.filename
    )

    def should_cancel() -> bool:
        if shutdown_requested():
            return True
        return not operations.operation(project_id, operation_id).is_processing(source_id)

    try:
        imported_source = extraction.extract(
            project_id=project_id,
            source_id=source_id,
            operation_id=operation_id,
            file_name=str(file_name),
            content=content,
            canonical_suffix=source.canonical_suffix,
            source_kind=source.kind,
            sha256=sha256,
            language_hint=imported_source.language_hint,
            should_cancel=should_cancel,
        )
    finally:
        del content
    if imported_source.chunks_count > 0:
        question_generation.start_question_generation(project_id, source_id)
        imported_source = sources.source(project_id, source_id)
    return imported_source
