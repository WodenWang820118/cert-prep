"""Source Library adapters for Capture Integration: operation transitions and publication.

Capture Integration defines the ports. These adapters call Source Library's infrastructure
and application use cases. Where a commit runs inside a transaction, the connection is passed
in so writes share that transaction.
"""

from __future__ import annotations

from collections.abc import Sequence
from sqlite3 import Connection

from cert_prep_contracts.transcription import TranscriptSegment

from cert_prep_backend.capture_integration.application.ports import (
    BindCaptureReviewCommit,
    CaptureOperations,
    CapturePublication,
    CaptureReviewCommit,
)
from cert_prep_backend.platform.database import Database
from cert_prep_backend.source_library.application.ports import DocumentOperationRepository
from cert_prep_backend.source_library.domain.document import PdfExtractionResult, SourceDocument
from cert_prep_backend.source_library.domain.operation import DocumentOperation
from cert_prep_backend.source_library.infrastructure import operations


class SourceLibraryCaptureReviewCommit:
    """Signals that a review session is committing, in the caller's transaction."""

    def __init__(self, connection: Connection) -> None:
        self._connection = connection

    def begin_commit(self, project_id: str, document_id: str, operation_id: str) -> None:
        operations.begin_capture_review_commit_in_connection(
            self._connection,
            project_id=project_id,
            document_id=document_id,
            operation_id=operation_id,
        )


def bind_capture_review_commit() -> BindCaptureReviewCommit:
    """Binds a review commit listener to the transaction's SQLite connection."""

    def bind(connection: Connection) -> CaptureReviewCommit:
        return SourceLibraryCaptureReviewCommit(connection)

    return bind


class SourceLibraryCapturePublication:
    """Source Library's atomic publication of capture results."""

    def __init__(self, db: Database) -> None:
        self._db = db

    def publish_audio_success(
        self,
        *,
        project_id: str,
        operation_id: str,
        document_id: str,
        segments: Sequence[tuple[TranscriptSegment, str]],
        model: str,
        device: str | None,
        warning: str | None,
    ) -> SourceDocument:
        return operations.publish_capture_audio_success(
            self._db,
            project_id=project_id,
            operation_id=operation_id,
            document_id=document_id,
            segments=segments,
            model=model,
            device=device,
            warning=warning,
        )

    def publish_success(
        self,
        *,
        project_id: str,
        operation_id: str,
        document_id: str,
        extraction: PdfExtractionResult,
    ) -> SourceDocument:
        return operations.publish_success(
            self._db,
            project_id=project_id,
            operation_id=operation_id,
            document_id=document_id,
            extraction=extraction,
        )


def capture_publication(db: Database) -> CapturePublication:
    return SourceLibraryCapturePublication(db)


class SourceLibraryCaptureOperations:
    """Adapts Source Library operations for Capture Integration."""

    def __init__(
        self, db: Database, operations_repository: DocumentOperationRepository
    ) -> None:
        self._db = db
        self._operations = operations_repository

    def claim_upload(self, project_id: str, operation_id: str) -> bool:
        return self._operations.claim(project_id, operation_id)[1]

    def fail(
        self, project_id: str, operation_id: str, *, error: str
    ) -> DocumentOperation:
        return self._operations.fail(project_id, operation_id, error=error)

    def cancel(self, project_id: str, operation_id: str) -> DocumentOperation:
        return self._operations.cancel(project_id, operation_id)

    def acknowledge_cancellation(
        self, project_id: str, operation_id: str
    ) -> DocumentOperation:
        return self._operations.acknowledge_cancellation(project_id, operation_id)

    def operation(self, project_id: str, operation_id: str) -> DocumentOperation:
        return self._operations.operation(project_id, operation_id)

    def mark_review_pending(
        self, project_id: str, document_id: str, operation_id: str
    ) -> DocumentOperation:
        return operations.mark_capture_review_pending(
            self._db,
            project_id=project_id,
            document_id=document_id,
            operation_id=operation_id,
        )


def capture_operations(
    db: Database, operations_repository: DocumentOperationRepository
) -> CaptureOperations:
    return SourceLibraryCaptureOperations(db, operations_repository)
