"""Use cases of Capture Integration for a capture review, from upload through deletion."""

from __future__ import annotations

import hashlib
import logging
from pathlib import PurePath

from cert_prep_backend.capture_integration.application.errors import (
    CaptureAudioRejected,
    CaptureCommitNotQueued,
    CaptureExtractionCanceled,
    CaptureExtractionFailed,
    CaptureGatewayRejection,
    CaptureRequirementUnavailable,
    CaptureReviewConflict,
    CaptureRuntimeCallFailed,
)
from cert_prep_backend.capture_integration.application.messages import PDF_OCR_UNAVAILABLE_MESSAGE
from cert_prep_backend.capture_integration.application.ports import (
    CaptureBackgroundWork,
    CaptureDocuments,
    CaptureFileStore,
    CaptureOperations,
    CaptureQuestionDrafting,
    CaptureReviewEvents,
    CaptureReviewMaintenance,
    CaptureReviewStore,
    CaptureReviewWorkflow,
    CaptureRuntime,
)
from cert_prep_backend.capture_integration.application.results import (
    CaptureUploadClaim,
    QueuedCaptureCommit,
    ReportedStructuringFailure,
    StartedCaptureReview,
)
from cert_prep_backend.capture_integration.domain.review_session import (
    CaptureReviewSession,
    CaptureReviewStatus,
)
from cert_prep_backend.platform.errors import BackendError, ValidationError
from cert_prep_backend.projects.application.ports import ProjectRepository
from cert_prep_backend.projects.application.use_cases import require_project

__all__ = [
    "abandon_capture_upload",
    "cancel_capture_review",
    "claim_capture_upload",
    "commit_capture_review",
    "discard_capture_runtime",
    "expire_capture_reviews",
    "extract_capture_for_review",
    "publish_reviewed_capture",
    "recover_capture_reviews",
    "report_structuring_failure",
    "start_capture_review",
]

logger = logging.getLogger(__name__)
_CREATION_FAILED = "Capture review creation failed."
_EXTRACTION_FAILED = "Capture Runtime extraction failed."
_COMMIT_NOT_QUEUED = "Capture commit could not be queued."
_COMMIT_MISMATCH = "Capture commit does not match the completed request."
_REVIEW_NOT_PENDING = "Capture review is no longer pending."
_CANDIDATE_MISMATCH = "Capture candidate source does not match."
_STRUCTURING_FAILED = "Capture host structuring failed."
_RUNTIME_UNAVAILABLE = "Capture Runtime operation is not available."
_STRUCTURING_GATEWAY = "Capture structuring failure could not be confirmed."
_CANCEL_GATEWAY = "Capture cancellation could not be confirmed."
_DELETE_GATEWAY = "Capture Runtime deletion could not be confirmed."


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
        _finish_canceled_capture(
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


def _finish_canceled_capture(
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


def commit_capture_review(
    sessions: CaptureReviewStore,
    documents: CaptureDocuments,
    operations: CaptureOperations,
    workflow: CaptureReviewWorkflow,
    work: CaptureBackgroundWork,
    events: CaptureReviewEvents,
    drafts: CaptureQuestionDrafting,
    *,
    project_id: str,
    session_id: str,
    candidate: object,
    client_request_id: str,
) -> QueuedCaptureCommit:
    """Load the review, claim it, and queue publication. A completed match replays."""

    session = _load_capture_session(sessions, project_id=project_id, session_id=session_id)
    if session.status == CaptureReviewStatus.COMPLETED:
        stored_request_id = session.confirm_request_id
        if stored_request_id and (
            stored_request_id != client_request_id
            or session.confirm_review_digest != workflow.digest(candidate)
        ):
            raise CaptureReviewConflict(_COMMIT_MISMATCH)
        return QueuedCaptureCommit(
            replay_completed=True,
            document=None,
            last_event_sequence=session.last_event_sequence,
        )
    if not session.is_active:
        raise CaptureReviewConflict(_REVIEW_NOT_PENDING)
    document = documents.document(project_id, session.document_id)
    if workflow.candidate_source_sha256(candidate) != document.sha256:
        raise ValidationError(_CANDIDATE_MISMATCH)
    try:
        claimed, acquired = workflow.claim_commit(
            project_id=project_id,
            document_id=session.document_id,
            operation_id=session.operation_id,
            session_id=session_id,
            candidate=candidate,
            client_request_id=client_request_id,
        )
    except (BackendError, RuntimeError) as error:
        raise CaptureReviewConflict(str(error)) from error
    if acquired:
        document_id = session.document_id
        operation_id = session.operation_id

        def run(
            queued_document_id: str = document_id,
            queued_operation_id: str = operation_id,
            queued_session_id: str = session_id,
        ) -> None:
            publish_reviewed_capture(
                sessions,
                operations,
                workflow,
                work,
                events,
                drafts,
                project_id=project_id,
                document_id=queued_document_id,
                operation_id=queued_operation_id,
                session_id=queued_session_id,
                candidate=candidate,
            )

        def cancel_queued(
            queued_operation_id: str = operation_id,
            queued_session_id: str = session_id,
        ) -> None:
            _cancel_queued_capture(
                sessions,
                operations,
                events,
                project_id=project_id,
                operation_id=queued_operation_id,
                session_id=queued_session_id,
            )

        try:
            work.submit(operation_id=operation_id, run=run, cancel_queued=cancel_queued)
        except Exception as error:
            operations.fail(project_id, operation_id, error=_COMMIT_NOT_QUEUED)
            sessions.finish(
                project_id=project_id,
                session_id=session_id,
                status=CaptureReviewStatus.FAILED,
            )
            raise CaptureCommitNotQueued(_COMMIT_NOT_QUEUED) from error
    return QueuedCaptureCommit(
        replay_completed=False,
        document=document,
        last_event_sequence=claimed.last_event_sequence,
    )


def publish_reviewed_capture(
    sessions: CaptureReviewStore,
    operations: CaptureOperations,
    workflow: CaptureReviewWorkflow,
    work: CaptureBackgroundWork,
    events: CaptureReviewEvents,
    drafts: CaptureQuestionDrafting,
    *,
    project_id: str,
    document_id: str,
    operation_id: str,
    session_id: str,
    candidate: object,
) -> None:
    """Publish a claimed review. A cancel is finished again, then listeners are woken."""

    try:
        document = workflow.commit_review(
            project_id=project_id,
            document_id=document_id,
            operation_id=operation_id,
            session_id=session_id,
            candidate=candidate,
            should_cancel=lambda: (
                work.is_closed()
                or not _operation_is_running(operations, project_id, operation_id)
            ),
        )
        if document.chunks_count > 0:
            drafts.enqueue_document(project_id, document_id)
    except CaptureExtractionCanceled:
        _finish_canceled_capture(
            sessions,
            operations,
            events,
            project_id=project_id,
            operation_id=operation_id,
            session_id=session_id,
        )
    finally:
        try:
            session = sessions.get(project_id=project_id, session_id=session_id)
        except Exception:
            pass
        else:
            if not session.is_active:
                events.publish_terminal(project_id, session_id, session.status)


def report_structuring_failure(
    sessions: CaptureReviewStore,
    operations: CaptureOperations,
    runtime: CaptureRuntime,
    *,
    project_id: str,
    session_id: str,
    client_request_id: str | None,
    code: str,
    message: str,
) -> ReportedStructuringFailure:
    """Record a host structuring failure, or replay when the session is no longer active."""

    session = _load_capture_session(sessions, project_id=project_id, session_id=session_id)
    if not session.is_active:
        return ReportedStructuringFailure(
            replay=True,
            document_id=session.document_id,
            runtime_operation=None,
        )
    runtime_id = session.runtime_capture_id
    if not runtime_id:
        raise CaptureReviewConflict(_RUNTIME_UNAVAILABLE)
    try:
        notice = runtime.report_structuring_failure(
            runtime_id,
            operation_id=client_request_id or session.operation_id,
            code=code,
            message=message,
        )
        operations.fail(project_id, session.operation_id, error=_STRUCTURING_FAILED)
        sessions.finish(
            project_id=project_id,
            session_id=session_id,
            status=CaptureReviewStatus.FAILED,
            terminal_sequence=notice.terminal_sequence,
        )
    except Exception as error:
        raise CaptureGatewayRejection(_STRUCTURING_GATEWAY) from error
    return ReportedStructuringFailure(
        replay=False,
        document_id=session.document_id,
        runtime_operation=notice.runtime_operation,
    )


def cancel_capture_review(
    sessions: CaptureReviewStore,
    operations: CaptureOperations,
    runtime: CaptureRuntime,
    events: CaptureReviewEvents,
    *,
    project_id: str,
    session_id: str,
) -> None:
    """Cancel an active review. An inactive session is left unchanged."""

    session = _load_capture_session(sessions, project_id=project_id, session_id=session_id)
    if not session.is_active:
        return
    try:
        operations.cancel(project_id, session.operation_id)
        terminal_sequence: int | None = None
        runtime_id = session.runtime_capture_id
        if runtime_id:
            cancellation = runtime.cancel(runtime_id)
            terminal_sequence = cancellation.terminal_sequence
        operations.acknowledge_cancellation(project_id, session.operation_id)
        sessions.finish(
            project_id=project_id,
            session_id=session_id,
            status=CaptureReviewStatus.CANCELED,
            terminal_sequence=terminal_sequence,
        )
        events.publish_terminal(project_id, session_id, CaptureReviewStatus.CANCELED)
    except Exception as error:
        raise CaptureGatewayRejection(_CANCEL_GATEWAY) from error


def discard_capture_runtime(
    runtime: CaptureRuntime, *, runtime_capture_id: str | None
) -> None:
    """Delete the ephemeral runtime capture. A missing id does nothing."""

    if not runtime_capture_id:
        return
    try:
        runtime.delete(runtime_capture_id)
    except CaptureRuntimeCallFailed as error:
        raise CaptureGatewayRejection(_DELETE_GATEWAY) from error


def expire_capture_reviews(maintenance: CaptureReviewMaintenance) -> tuple[str, ...]:
    """Cancel review sessions whose confirmation window has expired."""

    return maintenance.expire()


def recover_capture_reviews(maintenance: CaptureReviewMaintenance) -> tuple[str, ...]:
    """Cancel review sessions still active when the process starts or stops."""

    return maintenance.recover()


def _load_capture_session(
    sessions: CaptureReviewStore, *, project_id: str, session_id: str
) -> CaptureReviewSession:
    return sessions.get(project_id=project_id, session_id=session_id)


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
