"""Backend-owned pause and confirmation workflow for OCR review."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
import hashlib
import json

from capture_runtime_client import (
    CaptureDocument,
    CaptureSourceKind,
)
from cert_prep_backend.domains.capture_workbench.coordinator import (
    CaptureRuntimeCanceledError,
    CaptureRuntimeJobError,
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
class CaptureCommitClaim:
    session: dict
    acquired: bool


def candidate_digest(candidate: CaptureDocument) -> str:
    canonical = json.dumps(
        candidate.model_dump(mode="json", by_alias=True),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def begin_capture_commit(
    db: Database,
    *,
    project_id: str,
    document_id: str,
    operation_id: str,
    session_id: str,
    candidate: CaptureDocument,
    client_request_id: str,
) -> CaptureCommitClaim:
    """Claim the review session and operation in one SQLite transaction."""

    with db.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        session, acquired = review_sessions.begin_confirm_in_connection(
            connection,
            project_id=project_id,
            session_id=session_id,
            review_revision=1,
            client_request_id=client_request_id,
            review_digest=candidate_digest(candidate),
        )
        if acquired:
            operations.begin_capture_review_commit_in_connection(
                connection,
                project_id=project_id,
                document_id=document_id,
                operation_id=operation_id,
            )
        return CaptureCommitClaim(session=session, acquired=acquired)


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
    on_runtime_started: Callable[[str], None] | None = None,
) -> dict:
    def persist_runtime_id(operation) -> None:
        review_sessions.set_runtime_capture_id(
            db,
            project_id=project_id,
            session_id=session_id,
            runtime_capture_id=operation.capture_id,
        )
        if on_runtime_started is not None:
            on_runtime_started(operation.capture_id)

    operation = coordinator.begin_capture(
        operation_id=operation_id,
        file_name=file_name,
        content=content,
        media_type=media_type,
        source_kind=source_kind,
        target_language=None,
        should_cancel=should_cancel,
        on_started=persist_runtime_id,
    )
    try:
        review_sessions.observe_event_sequence(
            db,
            project_id=project_id,
            session_id=session_id,
            sequence=operation.last_event_sequence,
        )
        operations.mark_capture_review_pending(
            db,
            project_id=project_id,
            document_id=document_id,
            operation_id=operation_id,
        )
    except Exception:
        coordinator.cancel(operation.capture_id)
        raise
    return source_documents_repository.get_document(db, project_id, document_id)


def commit_review_capture(
    db: Database,
    *,
    coordinator: CertPrepCaptureCoordinator,
    project_id: str,
    document_id: str,
    operation_id: str,
    session_id: str,
    candidate: CaptureDocument,
    should_cancel: Callable[[], bool],
) -> dict:
    session = review_sessions.get(db, project_id=project_id, session_id=session_id)
    runtime_capture_id = session.get("runtime_capture_id")
    if not isinstance(runtime_capture_id, str) or not runtime_capture_id:
        raise RuntimeError("Capture Runtime has not reached the review state.")
    terminal_sequence: int | None = None
    try:
        capture = coordinator.commit_capture(
            operation_id=operation_id,
            capture_id=runtime_capture_id,
            candidate=candidate,
            should_cancel=should_cancel,
        )
        terminal_sequence = capture.last_event_sequence
        source = source_documents_repository.get_document(db, project_id, document_id)
        document = publish_capture_document(
            db,
            project_id=project_id,
            document_id=document_id,
            operation_id=operation_id,
            source_kind=source["source_kind"],
            expected_sha256=source["sha256"],
            document=capture.document,
        )
        review_sessions.finish(
            db,
            project_id=project_id,
            session_id=session_id,
            status=review_sessions.COMPLETED,
            terminal_sequence=capture.last_event_sequence,
        )
        return document
    except CaptureRuntimeCanceledError:
        review_sessions.finish(
            db,
            project_id=project_id,
            session_id=session_id,
            status=review_sessions.CANCELED,
        )
        raise
    except Exception as error:
        if isinstance(error, CaptureRuntimeJobError):
            terminal_sequence = error.last_event_sequence
        try:
            review_sessions.finish(
                db,
                project_id=project_id,
                session_id=session_id,
                status=review_sessions.FAILED,
                terminal_sequence=terminal_sequence,
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
        terminal_sequence: int | None = None
        if coordinator is not None and runtime_capture_id:
            try:
                operation = coordinator.cancel(runtime_capture_id)
                terminal_sequence = operation.last_event_sequence
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
                terminal_sequence=terminal_sequence,
            )
        except Exception:
            pass
        cleaned.append(session["id"])
    return tuple(cleaned)


__all__ = [
    "CaptureCommitClaim",
    "begin_capture_commit",
    "begin_review_capture",
    "candidate_digest",
    "cleanup_active_review_sessions",
    "cleanup_expired_review_sessions",
    "commit_review_capture",
]
