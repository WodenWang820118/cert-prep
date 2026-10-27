"""Use cases of Capture Integration for starting a review and finishing its extraction.

Commit, structuring failure, cancel, and delete stay in the router until the next step.
"""

from __future__ import annotations

import hashlib
import logging
from pathlib import PurePath

from cert_prep_backend.capture_integration.application.errors import (
    CaptureAudioRejected,
    CaptureExtractionCanceled,
    CaptureExtractionFailed,
    CaptureRequirementUnavailable,
)
from cert_prep_backend.capture_integration.application.messages import PDF_OCR_UNAVAILABLE_MESSAGE
from cert_prep_backend.capture_integration.application.ports import (
    CaptureBackgroundWork,
    CaptureDocuments,
    CaptureFileStore,
    CaptureOperations,
    CaptureReviewEvents,
    CaptureReviewMaintenance,
    CaptureReviewStore,
    CaptureReviewWorkflow,
)
from cert_prep_backend.capture_integration.application.results import (
    CaptureUploadClaim,
    StartedCaptureReview,
)
from cert_prep_backend.capture_integration.domain.review_session import CaptureReviewStatus
from cert_prep_backend.projects.application.ports import ProjectRepository
from cert_prep_backend.projects.application.use_cases import require_project

__all__ = [
    "abandon_capture_upload",
    "claim_capture_upload",
    "expire_capture_reviews",
    "extract_capture_for_review",
    "finish_canceled_capture",
    "recover_capture_reviews",
    "start_capture_review",
]

logger = logging.getLogger(__name__)
_CREATION_FAILED = "Capture review creation failed."
_EXTRACTION_FAILED = "Capture Runtime extraction failed."


def claim_capture_upload(
    projects: ProjectRepository,
    operations: CaptureOperations,
    *,
    project_id: str,
    operation_id: str,
) -> CaptureUploadClaim:
    """Claim an upload id. A reused id is returned; a missing project is NotFoundError."""

    require_project(projects, project_id)
    acquired = operations.claim_upload(project_id, operation_id)
    return CaptureUploadClaim(acquired=acquired, operation_id=operation_id)


def start_capture_review(
    sessions: CaptureReviewStore,
    documents: CaptureDocuments,
    operations: CaptureOperations,
    files: CaptureFileStore,
    workflow: CaptureReviewWorkflow,
    work: CaptureBackgroundWork,
    events: CaptureReviewEvents,
    *,
    project_id: str,
    operation_id: str,
    filename: str | None,
    content: bytes,
    max_pdf_pages: int,
    max_image_pixels: int,
) -> StartedCaptureReview:
    """Prepare, store, and queue extraction. Failures of this sequence abandon the upload."""

    session_id: str | None = None
    try:
        prepared = files.prepare(
            content,
            max_pdf_pages=max_pdf_pages,
            max_image_pixels=max_image_pixels,
            filename=filename,
        )
        if prepared.kind == "audio":
            raise CaptureAudioRejected("Capture review supports PDF and image sources only.")
        digest = hashlib.sha256(content).hexdigest()
        storage_path = files.store(
            project_id=project_id,
            sha256=digest,
            content=content,
            canonical_suffix=prepared.canonical_suffix,
        )
        document = documents.attach_document(
            project_id,
            operation_id,
            filename=filename or f"{digest}{prepared.canonical_suffix}",
            sha256=digest,
            language_hint="auto",
            storage_path=storage_path,
            page_count=prepared.page_count,
        )
        session = sessions.create(
            project_id=project_id,
            document_id=document.id,
            operation_id=operation_id,
        )
        session_id = session.id

        def run(document_id: str = document.id, review_session_id: str = session.id) -> None:
            extract_capture_for_review(
                documents,
                operations,
                files,
                sessions,
                workflow,
                work,
                events,
                project_id=project_id,
                document_id=document_id,
                operation_id=operation_id,
                session_id=review_session_id,
            )

        def cancel_queued(review_session_id: str = session.id) -> None:
            _cancel_queued_capture(
                sessions,
                operations,
                events,
                project_id=project_id,
                operation_id=operation_id,
                session_id=review_session_id,
            )

        work.submit(operation_id=operation_id, run=run, cancel_queued=cancel_queued)
    except Exception:
        abandon_capture_upload(
            sessions,
            operations,
            events,
            project_id=project_id,
            operation_id=operation_id,
            session_id=session_id,
        )
        raise
    return StartedCaptureReview(
        session=session,
        document=document,
        content_length=len(content),
        canonical_suffix=prepared.canonical_suffix,
    )


def abandon_capture_upload(
    sessions: CaptureReviewStore,
    operations: CaptureOperations,
    events: CaptureReviewEvents,
    *,
    project_id: str,
    operation_id: str,
    session_id: str | None,
) -> None:
    """Mark the upload failed. A missing session is left unwritten. Write errors are logged."""

    try:
        operations.fail(project_id, operation_id, error=_CREATION_FAILED)
    except Exception:
        logger.exception(
            "Could not mark capture operation as failed",
            extra={"operation_id": operation_id},
        )
    if session_id is None:
        return
    try:
        sessions.finish(
            project_id=project_id,
            session_id=session_id,
            status=CaptureReviewStatus.FAILED,
        )
        events.publish_terminal(project_id, session_id, CaptureReviewStatus.FAILED)
    except Exception:
        logger.exception(
            "Could not mark capture review session as failed",
            extra={"session_id": session_id},
        )


def extract_capture_for_review(
    documents: CaptureDocuments,
    operations: CaptureOperations,
    files: CaptureFileStore,
    sessions: CaptureReviewStore,
    workflow: CaptureReviewWorkflow,
    work: CaptureBackgroundWork,
    events: CaptureReviewEvents,
    *,
    project_id: str,
    document_id: str,
    operation_id: str,
    session_id: str,
) -> None:
    """Run queued extraction. The document is loaded before runtime errors are translated."""

    document = documents.document(project_id, document_id)
    source_file = documents.source_file(project_id, document_id)
    suffix = PurePath(source_file.storage_path).suffix
    source_kind = _source_kind(source_file.filename, suffix)
    try:
        workflow.begin_review(
            project_id=project_id,
            document_id=document_id,
            operation_id=operation_id,
            session_id=session_id,
            file_name=document.filename,
            content=files.read_bytes(source_file.storage_path),
            media_type=_media_type(document.filename, suffix),
            source_kind=source_kind,
            should_cancel=lambda: (
                work.is_closed() or not _operation_is_running(operations, project_id, operation_id)
            ),
            on_runtime_started=lambda runtime_id: events.publish_runtime(
                project_id, session_id, runtime_id
            ),
        )
    except CaptureExtractionCanceled:
        finish_canceled_capture(
            sessions,
            operations,
            events,
            project_id=project_id,
            operation_id=operation_id,
            session_id=session_id,
        )
    except CaptureRequirementUnavailable as error:
        _fail_capture_begin(
            sessions,
            operations,
            events,
            project_id=project_id,
            operation_id=operation_id,
            session_id=session_id,
            error=PDF_OCR_UNAVAILABLE_MESSAGE if source_kind == "pdf" else str(error),
        )
    except CaptureExtractionFailed as error:
        _fail_capture_begin(
            sessions,
            operations,
            events,
            project_id=project_id,
            operation_id=operation_id,
            session_id=session_id,
            error=(
                PDF_OCR_UNAVAILABLE_MESSAGE
                if source_kind == "pdf" and error.code == "requirement_unavailable"
                else _EXTRACTION_FAILED
            ),
            terminal_sequence=error.terminal_sequence,
        )
    except Exception:
        _fail_capture_begin(
            sessions,
            operations,
            events,
            project_id=project_id,
            operation_id=operation_id,
            session_id=session_id,
            error=_EXTRACTION_FAILED,
        )
    else:
        events.publish_review_ready(project_id, session_id)


def finish_canceled_capture(
    sessions: CaptureReviewStore,
    operations: CaptureOperations,
    events: CaptureReviewEvents,
    *,
    project_id: str,
    operation_id: str,
    session_id: str,
) -> None:
    """Acknowledge cancellation, then finish the session even when that acknowledgement fails."""

    try:
        operations.acknowledge_cancellation(project_id, operation_id)
    finally:
        sessions.finish(
            project_id=project_id,
            session_id=session_id,
            status=CaptureReviewStatus.CANCELED,
        )
        events.publish_terminal(project_id, session_id, CaptureReviewStatus.CANCELED)


def expire_capture_reviews(maintenance: CaptureReviewMaintenance) -> tuple[str, ...]:
    """Cancel review sessions whose confirmation window has expired."""

    return maintenance.expire()


def recover_capture_reviews(maintenance: CaptureReviewMaintenance) -> tuple[str, ...]:
    """Cancel review sessions still active when the process starts or stops."""

    return maintenance.recover()


def _fail_capture_begin(
    sessions: CaptureReviewStore,
    operations: CaptureOperations,
    events: CaptureReviewEvents,
    *,
    project_id: str,
    operation_id: str,
    session_id: str,
    error: str,
    terminal_sequence: int | None = None,
) -> None:
    sessions.finish(
        project_id=project_id,
        session_id=session_id,
        status=CaptureReviewStatus.FAILED,
        terminal_sequence=terminal_sequence,
    )
    operations.fail(project_id, operation_id, error=error)
    events.publish_terminal(project_id, session_id, CaptureReviewStatus.FAILED)


def _cancel_queued_capture(
    sessions: CaptureReviewStore,
    operations: CaptureOperations,
    events: CaptureReviewEvents,
    *,
    project_id: str,
    operation_id: str,
    session_id: str,
) -> None:
    try:
        operations.cancel(project_id, operation_id)
        operations.acknowledge_cancellation(project_id, operation_id)
    finally:
        try:
            sessions.finish(
                project_id=project_id,
                session_id=session_id,
                status=CaptureReviewStatus.CANCELED,
            )
            events.publish_terminal(project_id, session_id, CaptureReviewStatus.CANCELED)
        except Exception:
            pass


def _operation_is_running(
    operations: CaptureOperations, project_id: str, operation_id: str
) -> bool:
    try:
        return operations.operation(project_id, operation_id).status == "running"
    except Exception:
        return False


def _source_kind(filename: str, canonical_suffix: str | None) -> str:
    suffix = (canonical_suffix or PurePath(filename).suffix).lower()
    return "pdf" if suffix == ".pdf" else "image"


def _media_type(filename: str, canonical_suffix: str | None = None) -> str:
    suffix = (canonical_suffix or PurePath(filename).suffix).lower()
    return {
        ".pdf": "application/pdf",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
    }.get(suffix, "application/octet-stream")
