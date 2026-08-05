"""Backend-owned pause and confirmation workflow for OCR review."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
import hashlib
import json

from capture_contracts import (
    CaptureReviewV1,
    CaptureSourceKind,
)
from cert_prep_backend.domains.capture_workbench.coordinator import (
    CaptureRuntimeCanceledError,
    CertPrepCaptureCoordinator,
)
from cert_prep_backend.domains.capture_workbench.persistence import (
    publish_capture_document,
)
from cert_prep_backend.domains.capture_workbench import review_sessions
from cert_prep_backend.domains.source_documents import operations
from cert_prep_backend.domains.source_documents import repository as source_documents_repository
from cert_prep_backend.persistence.database import Database


@dataclass(frozen=True, slots=True)
class ReviewConfirmationClaim:
    session: dict
    acquired: bool


def review_digest(review: CaptureReviewV1) -> str:
    canonical = json.dumps(
        review.model_dump(mode="json", by_alias=True),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def begin_review_confirmation(
    db: Database,
    *,
    project_id: str,
    document_id: str,
    operation_id: str,
    session_id: str,
    review: CaptureReviewV1,
    client_request_id: str,
) -> ReviewConfirmationClaim:
    """Claim the review session and operation in one SQLite transaction."""

    with db.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        session, acquired = review_sessions.begin_confirm_in_connection(
            connection,
            project_id=project_id,
            session_id=session_id,
            review_revision=review.review_version,
            client_request_id=client_request_id,
            review_digest=review_digest(review),
        )
        if acquired:
            operations.begin_capture_review_commit_in_connection(
                connection,
                project_id=project_id,
                document_id=document_id,
                operation_id=operation_id,
            )
        return ReviewConfirmationClaim(session=session, acquired=acquired)


def begin_review_capture(
    db: Database,
    *,
    coordinator: CertPrepCaptureCoordinator,
    project_id: str,
    document_id: str,
    operation_id: str,
    session_id: str,
    file_name: str,
    content: bytes,
    media_type: str,
    source_kind: CaptureSourceKind,
    should_cancel: Callable[[], bool],
) -> dict:
    job = coordinator.begin_capture(
        operation_id=operation_id,
        file_name=file_name,
        content=content,
        media_type=media_type,
        source_kind=source_kind,
        target_language=None,
        should_cancel=should_cancel,
    )
    try:
        review_sessions.set_runtime_capture_id(
            db,
            project_id=project_id,
            session_id=session_id,
            runtime_capture_id=job.capture_id,
        )
        operations.mark_capture_review_pending(
            db,
            project_id=project_id,
            document_id=document_id,
            operation_id=operation_id,
        )
    except Exception:
        coordinator.cancel(job.capture_id)
        raise
    return source_documents_repository.get_document(db, project_id, document_id)


def confirm_review_capture(
    db: Database,
    *,
    coordinator: CertPrepCaptureCoordinator,
    project_id: str,
    document_id: str,
    operation_id: str,
    session_id: str,
    review: CaptureReviewV1,
    should_cancel: Callable[[], bool],
) -> dict:
    session = review_sessions.get(db, project_id=project_id, session_id=session_id)
    runtime_capture_id = session.get("runtime_capture_id")
    if not isinstance(runtime_capture_id, str) or not runtime_capture_id:
        raise RuntimeError("Capture Runtime has not reached the review state.")
    try:
        capture = coordinator.confirm_capture(
            operation_id=operation_id,
            capture_id=runtime_capture_id,
            target_language=None,
            review=review,
            should_cancel=should_cancel,
        )
        source = source_documents_repository.get_document(db, project_id, document_id)
        document = publish_capture_document(
            db,
            project_id=project_id,
            document_id=document_id,
            operation_id=operation_id,
            source_kind=source["source_kind"],
            expected_sha256=source["sha256"],
            document=capture.document,
            review=review,
        )
        review_sessions.finish(
            db,
            project_id=project_id,
            session_id=session_id,
            status=review_sessions.COMPLETED,
        )
        try:
            coordinator.delete(runtime_capture_id)
        except Exception:
            # Publication is already durable; the runtime retention policy is
            # the fallback cleanup path for an ambiguous delete response.
            pass
        return document
    except CaptureRuntimeCanceledError:
        review_sessions.finish(
            db,
            project_id=project_id,
            session_id=session_id,
            status=review_sessions.CANCELED,
        )
        raise
    except Exception:
        try:
            review_sessions.finish(
                db,
                project_id=project_id,
                session_id=session_id,
                status=review_sessions.FAILED,
            )
        finally:
            operations.finish_failed(
                db,
                project_id=project_id,
                operation_id=operation_id,
                error="Capture review confirmation failed.",
            )
        raise


def cleanup_active_review_sessions(
    db: Database,
    *,
    coordinator: CertPrepCaptureCoordinator | None,
) -> tuple[str, ...]:
    """Cancel pending sidecar jobs during startup/shutdown recovery."""

    return _cleanup_review_sessions(
        db,
        coordinator=coordinator,
        sessions=review_sessions.active(db),
    )


def cleanup_expired_review_sessions(
    db: Database,
    *,
    coordinator: CertPrepCaptureCoordinator | None,
) -> tuple[str, ...]:
    """Cancel review sessions whose thirty-minute confirmation window expired."""

    return _cleanup_review_sessions(
        db,
        coordinator=coordinator,
        sessions=review_sessions.expired(db),
    )


def _cleanup_review_sessions(
    db: Database,
    *,
    coordinator: CertPrepCaptureCoordinator | None,
    sessions: list[dict],
) -> tuple[str, ...]:
    """Cancel the supplied durable sessions and their ephemeral runtime jobs."""

    cleaned: list[str] = []
    for session in sessions:
        runtime_capture_id = session.get("runtime_capture_id")
        if coordinator is not None and runtime_capture_id:
            try:
                coordinator.cancel(runtime_capture_id)
            except Exception:
                # The runtime may already be gone; the durable host state still
                # must not remain reviewable after process recovery.
                pass
        try:
            operations.cancel_operation(
                db,
                project_id=session["project_id"],
                operation_id=session["operation_id"],
            )
            operations.acknowledge_cancellation(
                db,
                project_id=session["project_id"],
                operation_id=session["operation_id"],
            )
        except Exception:
            try:
                operations.finish_failed(
                    db,
                    project_id=session["project_id"],
                    operation_id=session["operation_id"],
                    error="Capture review session was recovered after host shutdown.",
                )
            except Exception:
                pass
        try:
            review_sessions.finish(
                db,
                project_id=session["project_id"],
                session_id=session["id"],
                status=review_sessions.CANCELED,
            )
        except Exception:
            pass
        cleaned.append(session["id"])
    return tuple(cleaned)


__all__ = [
    "ReviewConfirmationClaim",
    "begin_review_capture",
    "begin_review_confirmation",
    "cleanup_active_review_sessions",
    "cleanup_expired_review_sessions",
    "confirm_review_capture",
    "review_digest",
]
