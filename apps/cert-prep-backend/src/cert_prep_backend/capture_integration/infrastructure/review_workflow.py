"""Backend-owned pause and confirmation workflow for OCR review."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
import hashlib
import json
from typing import cast

from capture_runtime_client import (
    CaptureDocument,
    CaptureSourceKind,
)
from cert_prep_backend.capture_integration.domain.review_session import (
    CaptureReviewSession,
    CaptureReviewStatus,
)
from cert_prep_backend.capture_integration.application.errors import (
    CaptureExtractionCanceled,
    CaptureExtractionFailed,
    CaptureRequirementUnavailable,
)
from cert_prep_backend.capture_integration.infrastructure.coordinator import (
    CaptureRuntimeCanceledError,
    CaptureRuntimeJobError,
    CaptureRuntimeRequirementUnavailableError,
    CertPrepCaptureCoordinator,
)
from cert_prep_backend.capture_integration.application.ports import (
    BindCaptureReviewCommit,
    CaptureOperations,
    CapturePublication,
)
from cert_prep_backend.capture_integration.infrastructure.persistence import (
    publish_capture_document,
)
from cert_prep_backend.capture_integration.infrastructure import review_sessions
from cert_prep_backend.source_library.application import use_cases as source_library
from cert_prep_backend.source_library.application.ports import (
    DocumentOperationRepository,
    DocumentRepository,
)
from cert_prep_backend.source_library.domain.document import SourceDocument
from cert_prep_backend.platform.database import Database


@dataclass(frozen=True, slots=True)
class CaptureCommitClaim:
    session: CaptureReviewSession
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
    bind_commit: BindCaptureReviewCommit,
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
            bind_commit(connection).begin_commit(
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
    operations: CaptureOperations,
    documents: DocumentRepository,
    on_runtime_started: Callable[[str], None] | None = None,
) -> SourceDocument:
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
        operations.mark_review_pending(
            project_id=project_id,
            document_id=document_id,
            operation_id=operation_id,
        )
    except Exception:
        coordinator.cancel(operation.capture_id)
        raise
    return source_library.view_document(documents, project_id, document_id)


def commit_review_capture(
    db: Database,
    *,
    coordinator: CertPrepCaptureCoordinator,
    document_operations: DocumentOperationRepository,
    project_id: str,
    document_id: str,
    operation_id: str,
    session_id: str,
    candidate: CaptureDocument,
    should_cancel: Callable[[], bool],
    documents: DocumentRepository,
    publication: CapturePublication,
) -> SourceDocument:
    session = review_sessions.get(db, project_id=project_id, session_id=session_id)
    runtime_capture_id = session.runtime_capture_id
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
        source = source_library.view_document(documents, project_id, document_id)
        document = publish_capture_document(
            project_id=project_id,
            document_id=document_id,
            operation_id=operation_id,
            source_kind=source.source_kind,
            expected_sha256=source.sha256,
            document=capture.document,
            ocr_projection=capture.ocr_projection,
            publication=publication,
        )
        review_sessions.finish(
            db,
            project_id=project_id,
            session_id=session_id,
            status=CaptureReviewStatus.COMPLETED,
            terminal_sequence=capture.last_event_sequence,
        )
        return document
    except CaptureRuntimeCanceledError:
        review_sessions.finish(
            db,
            project_id=project_id,
            session_id=session_id,
            status=CaptureReviewStatus.CANCELED,
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
                status=CaptureReviewStatus.FAILED,
                terminal_sequence=terminal_sequence,
            )
        finally:
            # Source Library's operation repository also discards the document's
            # unfinished draft jobs, in the transaction that stops the run.
            document_operations.fail(
                project_id, operation_id, error="Capture review confirmation failed."
            )
        raise


def cleanup_active_review_sessions(
    db: Database,
    *,
    coordinator: CertPrepCaptureCoordinator | None,
    document_operations: DocumentOperationRepository,
) -> tuple[str, ...]:
    """Cancel pending sidecar jobs during startup/shutdown recovery."""

    return _cleanup_review_sessions(
        db,
        coordinator=coordinator,
        document_operations=document_operations,
        sessions=review_sessions.active(db),
    )


def cleanup_expired_review_sessions(
    db: Database,
    *,
    coordinator: CertPrepCaptureCoordinator | None,
    document_operations: DocumentOperationRepository,
) -> tuple[str, ...]:
    """Cancel review sessions whose thirty-minute confirmation window expired."""

    return _cleanup_review_sessions(
        db,
        coordinator=coordinator,
        document_operations=document_operations,
        sessions=review_sessions.expired(db),
    )


def _cleanup_review_sessions(
    db: Database,
    *,
    coordinator: CertPrepCaptureCoordinator | None,
    document_operations: DocumentOperationRepository,
    sessions: list[CaptureReviewSession],
) -> tuple[str, ...]:
    """Cancel the supplied durable sessions and their ephemeral runtime jobs."""

    cleaned: list[str] = []
    for session in sessions:
        runtime_capture_id = session.runtime_capture_id
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
            document_operations.cancel(session.project_id, session.operation_id)
            document_operations.acknowledge_cancellation(
                session.project_id, session.operation_id
            )
        except Exception:
            try:
                document_operations.fail(
                    session.project_id,
                    session.operation_id,
                    error="Capture review session was recovered after host shutdown.",
                )
            except Exception:
                pass
        try:
            review_sessions.finish(
                db,
                project_id=session.project_id,
                session_id=session.id,
                status=CaptureReviewStatus.CANCELED,
                terminal_sequence=terminal_sequence,
            )
        except Exception:
            pass
        cleaned.append(session.id)
    return tuple(cleaned)


class CaptureReviewWorkflowAdapter:
    """Claim, begin, and commit a runtime review, translating coordinator failures."""

    def __init__(
        self,
        db: Database,
        coordinator: CertPrepCaptureCoordinator | None,
        document_operations: DocumentOperationRepository,
        *,
        documents: DocumentRepository,
        publication: CapturePublication,
        bind_commit: BindCaptureReviewCommit,
        operations: CaptureOperations,
    ) -> None:
        self._db = db
        self._coordinator = coordinator
        self._document_operations = document_operations
        self._documents = documents
        self._publication = publication
        self._bind_commit = bind_commit
        self._operations = operations

    def begin_review(
        self,
        *,
        project_id: str,
        document_id: str,
        operation_id: str,
        session_id: str,
        file_name: str,
        content: bytes,
        media_type: str,
        source_kind: str,
        should_cancel: Callable[[], bool],
        on_runtime_started: Callable[[str], None],
    ) -> None:
        runtime_kind = CaptureSourceKind.PDF if source_kind == "pdf" else CaptureSourceKind.IMAGE
        try:
            begin_review_capture(
                self._db,
                coordinator=self._coordinator,
                project_id=project_id,
                document_id=document_id,
                operation_id=operation_id,
                session_id=session_id,
                file_name=file_name,
                content=content,
                media_type=media_type,
                source_kind=runtime_kind,
                should_cancel=should_cancel,
                on_runtime_started=on_runtime_started,
                operations=self._operations,
                documents=self._documents,
            )
        except CaptureRuntimeCanceledError as error:
            raise CaptureExtractionCanceled() from error
        except CaptureRuntimeRequirementUnavailableError as error:
            raise CaptureRequirementUnavailable(str(error)) from error
        except CaptureRuntimeJobError as error:
            raise CaptureExtractionFailed(error.code, error.last_event_sequence) from error
        except Exception as error:
            raise CaptureExtractionFailed(None, None) from error

    def digest(self, candidate: object) -> str:
        return candidate_digest(cast(CaptureDocument, candidate))

    def candidate_source_sha256(self, candidate: object) -> str:
        return cast(CaptureDocument, candidate).source.sha256

    def claim_commit(
        self,
        *,
        project_id: str,
        document_id: str,
        operation_id: str,
        session_id: str,
        candidate: object,
        client_request_id: str,
    ) -> tuple[CaptureReviewSession, bool]:
        claim = begin_capture_commit(
            self._db,
            project_id=project_id,
            document_id=document_id,
            operation_id=operation_id,
            session_id=session_id,
            candidate=cast(CaptureDocument, candidate),
            client_request_id=client_request_id,
            bind_commit=self._bind_commit,
        )
        return claim.session, claim.acquired

    def commit_review(
        self,
        *,
        project_id: str,
        document_id: str,
        operation_id: str,
        session_id: str,
        candidate: object,
        should_cancel: Callable[[], bool],
    ) -> SourceDocument:
        try:
            return commit_review_capture(
                self._db,
                coordinator=self._coordinator,
                document_operations=self._document_operations,
                project_id=project_id,
                document_id=document_id,
                operation_id=operation_id,
                session_id=session_id,
                candidate=cast(CaptureDocument, candidate),
                should_cancel=should_cancel,
                documents=self._documents,
                publication=self._publication,
            )
        except CaptureRuntimeCanceledError as error:
            raise CaptureExtractionCanceled() from error


class CaptureReviewMaintenanceAdapter:
    """Expire and recover review sessions through the existing cleanup functions."""

    def __init__(
        self,
        db: Database,
        coordinator: CertPrepCaptureCoordinator | None,
        document_operations: DocumentOperationRepository,
    ) -> None:
        self._db = db
        self._coordinator = coordinator
        self._document_operations = document_operations

    def expire(self) -> tuple[str, ...]:
        return cleanup_expired_review_sessions(
            self._db,
            coordinator=self._coordinator,
            document_operations=self._document_operations,
        )

    def recover(self) -> tuple[str, ...]:
        return cleanup_active_review_sessions(
            self._db,
            coordinator=self._coordinator,
            document_operations=self._document_operations,
        )


__all__ = [
    "CaptureCommitClaim",
    "CaptureReviewMaintenanceAdapter",
    "CaptureReviewWorkflowAdapter",
    "begin_capture_commit",
    "begin_review_capture",
    "candidate_digest",
    "cleanup_active_review_sessions",
    "cleanup_expired_review_sessions",
    "commit_review_capture",
]
