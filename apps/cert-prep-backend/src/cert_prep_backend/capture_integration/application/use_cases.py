"""Use cases of Capture Integration for a capture review, from upload through deletion."""

from __future__ import annotations

import hashlib
import logging
from pathlib import PurePath
from typing import Literal

from cert_prep_backend.capture_integration.application.errors import (
    CaptureAudioRejected,
    CaptureCommitNotQueued,
    CaptureExtractionCanceled,
    CaptureExtractionFailed,
    CaptureGatewayRejection,
    CaptureOcrClosed,
    CaptureOcrMissing,
    CaptureOcrNotReady,
    CaptureOcrUnavailable,
    CaptureRequirementUnavailable,
    CaptureResultMissing,
    CaptureReviewConflict,
    CaptureReviewInputRejected,
    CaptureRuntimeCallFailed,
    CaptureSourceMissing,
)
from cert_prep_backend.capture_integration.application.messages import PDF_OCR_UNAVAILABLE_MESSAGE
from cert_prep_backend.capture_integration.application.ocr_summary import (
    CaptureOcrSummaryRead,
    build_ocr_summary,
)
from cert_prep_backend.capture_integration.application.ports import (
    CaptureBackgroundWork,
    CaptureDocuments,
    CaptureEventSignal,
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
    CaptureResultView,
    CaptureStreamHold,
    CaptureUploadClaim,
    QueuedCaptureCommit,
    ReportedStructuringFailure,
    StartedCaptureReview,
    StoredCapture,
    ViewedCapture,
)
from cert_prep_backend.capture_integration.domain.review_session import (
    CaptureReviewSession,
    CaptureReviewStatus,
)
from cert_prep_backend.platform.errors import BackendError, NotFoundError, ValidationError
from cert_prep_backend.projects.application.ports import ProjectRepository
from cert_prep_backend.projects.application.use_cases import require_project
from cert_prep_backend.source_library.domain.document import SourceDocument

__all__ = [
    "abandon_capture_upload",
    "cancel_capture_review",
    "claim_capture_upload",
    "commit_capture_review",
    "discard_capture_runtime",
    "expire_capture_reviews",
    "extract_capture_for_review",
    "hold_capture_stream",
    "load_completed_capture",
    "note_capture_event",
    "preview_capture_structure",
    "publish_reviewed_capture",
    "read_runtime_result",
    "recover_capture_reviews",
    "release_capture_result",
    "report_structuring_failure",
    "start_capture_review",
    "view_capture",
    "view_ocr_summary",
    "view_partial_capture",
    "view_raw_capture",
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
_STATUS_UNAVAILABLE = "Capture Runtime status unavailable."
_OCR_REVIEW_UNAVAILABLE = "OCR review is no longer available."
_EXTRACTION_NOT_READY = "OCR extraction has not reached review state."
_REVIEW_CANCELLED = "Capture review was cancelled."
_STRUCTURE_FAILED = "Capture structuring failed."
_EXPECTED_TERMINAL = {
    CaptureReviewStatus.COMPLETED: "completed",
    CaptureReviewStatus.CANCELED: "cancelled",
    CaptureReviewStatus.FAILED: "failed",
}
_REVIEW_NOT_COMPLETE = "Capture review is not complete."
_OCR_MISSING = "Capture not found."
_OCR_CLOSED = "Capture review is closed."
_OCR_NOT_READY = "OCR summary is not ready."
_OCR_UNAVAILABLE = "Capture Runtime OCR summary is unavailable."
_OCR_CLOSED_STATUSES = frozenset(
    {
        CaptureReviewStatus.CONFIRMING,
        CaptureReviewStatus.COMPLETED,
        CaptureReviewStatus.CANCELED,
    }
)
_OCR_OPEN_STATUSES = frozenset(
    {
        CaptureReviewStatus.PENDING,
        CaptureReviewStatus.FAILED,
    }
)
_OCR_EARLY_STATUSES = frozenset({"created", "waiting_input", "extracting"})
_OCR_PUBLISHED_STATUSES = frozenset({"awaiting_structuring", "failed"})


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


def view_capture(
    sessions: CaptureReviewStore,
    documents: CaptureDocuments,
    operations: CaptureOperations,
    runtime: CaptureRuntime,
    *,
    project_id: str,
    session_id: str,
) -> ViewedCapture:
    """Choose the runtime operation to show, or the stored session when it stays hidden."""

    session = sessions.get(project_id=project_id, session_id=session_id)
    document = documents.document(project_id, session.document_id)
    if session.status == CaptureReviewStatus.CONFIRMING:
        # Runtime commit can become terminal before the durable document and
        # review session have been published atomically. The host operation is
        # still structuring throughout that window.
        return _stored_capture_view(session, document)
    if not session.runtime_capture_id:
        return _stored_capture_view(session, document)
    try:
        operation = runtime.read_operation(session.runtime_capture_id)
        session = sessions.observe(
            project_id=project_id,
            session_id=session_id,
            sequence=operation.last_event_sequence,
        )
    except Exception:
        if session.is_active:
            raise CaptureGatewayRejection(_STATUS_UNAVAILABLE) from None
        return _stored_capture_view(session, document)
    if session.is_active and runtime.status_equals(
        operation, "completed", "failed", "cancelled"
    ):
        return _stored_capture_view(session, document)
    expected = _EXPECTED_TERMINAL.get(session.status)
    if expected is None or runtime.status_is(operation, expected):
        report_extracting = runtime.status_is(
            operation, "awaiting_structuring"
        ) and not capture_review_ready(operations, session)
        return ViewedCapture(
            session=session,
            document=document,
            runtime_operation=operation,
            report_extracting=report_extracting,
        )
    return _stored_capture_view(session, document)


def view_partial_capture(
    sessions: CaptureReviewStore,
    runtime: CaptureRuntime,
    *,
    project_id: str,
    session_id: str,
) -> object:
    """Return the runtime partial extraction while the review is still pending."""

    _review, runtime_id = _pending_runtime_review(
        sessions,
        project_id=project_id,
        session_id=session_id,
        closed=_OCR_REVIEW_UNAVAILABLE,
    )
    return runtime.read_partial(runtime_id)


def view_raw_capture(
    sessions: CaptureReviewStore,
    runtime: CaptureRuntime,
    *,
    project_id: str,
    session_id: str,
) -> object:
    """Return the runtime raw extraction while the review is still pending."""

    _review, runtime_id = _pending_runtime_review(
        sessions,
        project_id=project_id,
        session_id=session_id,
        closed=_OCR_REVIEW_UNAVAILABLE,
    )
    return runtime.read_raw(runtime_id)


def preview_capture_structure(
    sessions: CaptureReviewStore,
    operations: CaptureOperations,
    runtime: CaptureRuntime,
    *,
    project_id: str,
    session_id: str,
    review: object,
) -> object:
    """Check a review edit and ask the runtime to structure it. The session is not written."""

    session, runtime_id = _pending_runtime_review(
        sessions,
        project_id=project_id,
        session_id=session_id,
        closed=_REVIEW_NOT_PENDING,
    )
    raw = runtime.read_raw(runtime_id)
    try:
        runtime.validate_review(raw, review)
    except ValueError as error:
        raise CaptureReviewInputRejected(str(error)) from error
    try:
        return runtime.structure(
            operation_id=session.operation_id,
            capture_id=runtime_id,
            review=review,
            should_cancel=lambda: not _operation_is_running(
                operations, project_id, session.operation_id
            ),
        )
    except CaptureExtractionCanceled as error:
        raise CaptureReviewConflict(_REVIEW_CANCELLED) from error
    except Exception as error:
        raise CaptureGatewayRejection(_STRUCTURE_FAILED) from error


def capture_review_ready(operations: CaptureOperations, session: CaptureReviewSession) -> bool:
    """Whether the host operation can take a review. A failed read is not ready."""

    if session.status != CaptureReviewStatus.PENDING:
        return True
    try:
        operation = operations.operation(session.project_id, session.operation_id)
    except Exception:
        return False
    return operation.phase == "awaiting_review"


def view_ocr_summary(
    sessions: CaptureReviewStore,
    runtime: CaptureRuntime,
    *,
    project_id: str,
    session_id: str,
) -> CaptureOcrSummaryRead:
    """Return stable OCR evidence while the review can still show it. This read does not expire."""

    session = _ocr_session(sessions, project_id=project_id, session_id=session_id)
    runtime_capture_id = session.runtime_capture_id
    if not isinstance(runtime_capture_id, str) or not runtime_capture_id:
        if session.status == CaptureReviewStatus.PENDING:
            raise CaptureOcrNotReady(_OCR_NOT_READY)
        raise CaptureOcrUnavailable(_OCR_UNAVAILABLE)
    operation = runtime.read_operation_for_ocr(runtime_capture_id)
    try:
        operation_status = _runtime_status_value(operation)
    except Exception:
        raise CaptureOcrUnavailable(_OCR_UNAVAILABLE) from None
    if (
        session.status == CaptureReviewStatus.PENDING
        and operation_status in _OCR_EARLY_STATUSES
    ):
        raise CaptureOcrNotReady(_OCR_NOT_READY)
    if operation_status not in _OCR_PUBLISHED_STATUSES:
        raise CaptureOcrUnavailable(_OCR_UNAVAILABLE)
    if session.status == CaptureReviewStatus.FAILED and operation_status != "failed":
        raise CaptureOcrUnavailable(_OCR_UNAVAILABLE)
    projection = runtime.read_ocr_projection(runtime_capture_id)
    try:
        summary = build_ocr_summary(
            host_capture_id=session_id,
            runtime_capture_id=runtime_capture_id,
            operation=operation,
            projection=projection,
        )
    except Exception:
        raise CaptureOcrUnavailable(_OCR_UNAVAILABLE) from None
    final_session = _ocr_session(sessions, project_id=project_id, session_id=session_id)
    if final_session.runtime_capture_id != runtime_capture_id:
        raise CaptureOcrUnavailable(_OCR_UNAVAILABLE)
    if final_session.status == CaptureReviewStatus.FAILED and summary.status != "failed":
        raise CaptureOcrUnavailable(_OCR_UNAVAILABLE)
    return summary


def load_completed_capture(
    sessions: CaptureReviewStore,
    documents: CaptureDocuments,
    files: CaptureFileStore,
    *,
    project_id: str,
    session_id: str,
) -> StoredCapture:
    """Load a completed review's document and chunks, and stat its source once."""

    session = sessions.get(project_id=project_id, session_id=session_id)
    if session.status != CaptureReviewStatus.COMPLETED:
        raise CaptureReviewConflict(_REVIEW_NOT_COMPLETE)
    document = documents.document(project_id, session.document_id)
    chunks = documents.chunks_of(project_id, session.document_id)
    try:
        content_length, media_type = capture_source_display(
            documents,
            files,
            project_id=project_id,
            document_id=document.id,
        )
    except NotFoundError as error:
        # A document without its source row was never a 404 here; it stays a server error.
        raise CaptureSourceMissing(str(error)) from error
    return StoredCapture(
        session=session,
        document=document,
        chunks=chunks,
        content_length=content_length,
        media_type=media_type,
    )


def read_runtime_result(
    sessions: CaptureReviewStore,
    runtime: CaptureRuntime,
    *,
    project_id: str,
    session_id: str,
    runtime_capture_id: str,
) -> CaptureResultView | None:
    """Read a runtime result and advance its sequence. A missing result is left stored."""

    try:
        result = runtime.fetch_result(runtime_capture_id)
    except CaptureResultMissing:
        return None
    sessions.observe(
        project_id=project_id,
        session_id=session_id,
        sequence=result.operation.last_event_sequence,
    )
    return CaptureResultView(operation=result.operation, raw=result.raw)


def release_capture_result(runtime: CaptureRuntime, *, runtime_capture_id: str) -> None:
    """Delete the runtime job after the result model exists. A failure is still a result."""

    try:
        runtime.release_result(runtime_capture_id)
    except Exception:
        return


def capture_source_display(
    documents: CaptureDocuments,
    files: CaptureFileStore,
    *,
    project_id: str,
    document_id: str,
) -> tuple[int, str]:
    """The source size and media type, with each helper's own fallback.

    Media type is resolved first, matching the stored document projection. A missing
    source raises from the size lookup after the media lookup has already fallen back.
    """

    media_type = _capture_source_media_type(
        documents, project_id=project_id, document_id=document_id
    )
    content_length = _capture_source_bytes(
        documents,
        files,
        project_id=project_id,
        document_id=document_id,
    )
    return content_length, media_type


def note_capture_event(
    sessions: CaptureReviewStore,
    *,
    project_id: str,
    session_id: str,
    sequence: int,
) -> CaptureReviewSession:
    """Record a streamed event's sequence before the router holds or emits it."""

    return sessions.observe(
        project_id=project_id,
        session_id=session_id,
        sequence=sequence,
    )


def hold_capture_stream(
    sessions: CaptureReviewStore,
    operations: CaptureOperations,
    signal: CaptureEventSignal,
    *,
    project_id: str,
    session_id: str,
    hold: Literal["identity", "terminal", "review"],
    timeout_seconds: float,
) -> CaptureStreamHold:
    """One reload of a stream hold. waiting is true only after a wait that still applies."""

    observed = signal.revision()
    session = sessions.get(project_id=project_id, session_id=session_id)
    if not _stream_still_holding(operations, session, hold):
        return CaptureStreamHold(session=session, waiting=False)
    signal.wait_for_change(observed, timeout_seconds=timeout_seconds)
    session = sessions.get(project_id=project_id, session_id=session_id)
    return CaptureStreamHold(
        session=session,
        waiting=_stream_still_holding(operations, session, hold),
    )


def capture_source_kind(
    documents: CaptureDocuments, *, project_id: str, document_id: str
) -> str:
    """pdf or image from the stored suffix. A missing source propagates."""

    source_file = documents.source_file(project_id, document_id)
    return _source_kind(source_file.filename, PurePath(source_file.storage_path).suffix)


def _stream_still_holding(
    operations: CaptureOperations,
    session: CaptureReviewSession,
    hold: Literal["identity", "terminal", "review"],
) -> bool:
    if hold == "identity":
        return not session.runtime_capture_id and session.is_active
    if hold == "terminal":
        return session.is_active
    if hold == "review":
        return session.is_active and not capture_review_ready(operations, session)
    raise ValueError(f"Unsupported capture stream hold: {hold}")


def _stored_capture_view(
    session: CaptureReviewSession, document: SourceDocument
) -> ViewedCapture:
    return ViewedCapture(
        session=session,
        document=document,
        runtime_operation=None,
        report_extracting=False,
    )


def _pending_runtime_review(
    sessions: CaptureReviewStore,
    *,
    project_id: str,
    session_id: str,
    closed: str,
) -> tuple[CaptureReviewSession, str]:
    session = sessions.get(project_id=project_id, session_id=session_id)
    if session.status != CaptureReviewStatus.PENDING:
        raise CaptureReviewConflict(closed)
    runtime_id = session.runtime_capture_id
    if not runtime_id:
        raise CaptureReviewConflict(_EXTRACTION_NOT_READY)
    return session, runtime_id


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


def _ocr_session(
    sessions: CaptureReviewStore, *, project_id: str, session_id: str
) -> CaptureReviewSession:
    try:
        session = sessions.get(project_id=project_id, session_id=session_id)
    except NotFoundError:
        raise CaptureOcrMissing(_OCR_MISSING) from None
    if session.status in _OCR_CLOSED_STATUSES:
        raise CaptureOcrClosed(_OCR_CLOSED)
    if session.status not in _OCR_OPEN_STATUSES:
        raise CaptureOcrUnavailable(_OCR_UNAVAILABLE)
    return session


def _runtime_status_value(operation: object) -> str:
    value = getattr(operation, "status")
    candidate = getattr(value, "value", value)
    if not isinstance(candidate, str):
        raise TypeError("Runtime status must be a string enum.")
    return candidate


def _capture_source_bytes(
    documents: CaptureDocuments,
    files: CaptureFileStore,
    *,
    project_id: str,
    document_id: str,
) -> int:
    try:
        source_file = documents.source_file(project_id, document_id)
        return files.byte_size(source_file.storage_path)
    except (OSError, KeyError):
        return 1


def _capture_source_media_type(
    documents: CaptureDocuments, *, project_id: str, document_id: str
) -> str:
    try:
        source_file = documents.source_file(project_id, document_id)
        return _media_type(source_file.filename, PurePath(source_file.storage_path).suffix)
    except (OSError, KeyError, NotFoundError):
        return "application/octet-stream"
