"""The DocumentOperation aggregate: one cancellable import or processing run of a document.

An operation is queued while its file uploads, runs while the document is extracted,
transcribed or reviewed, and ends succeeded, failed or canceled. Cancellation is requested
while work is still cancellable and acknowledged when the work stops; once the result is
being committed it can no longer be canceled. Each transition returns the next state or
raises the error the API reports; storage applies it only if the operation has not moved.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Final, NoReturn

from cert_prep_backend.platform.errors import (
    DocumentOperationConflictError,
    DocumentOperationStateError,
    DocumentProcessingCanceledError,
    OperationNotCancellableError,
)
from cert_prep_backend.source_library.domain.statuses import (
    DocumentOperationPhase,
    DocumentOperationStatus,
)

Status = DocumentOperationStatus
Phase = DocumentOperationPhase

TERMINAL_STATUSES: Final = frozenset({Status.CANCELED, Status.SUCCEEDED, Status.FAILED})
CANCELLABLE_PROCESSING_PHASES: Final = frozenset(
    {Phase.PROCESSING, Phase.AWAITING_REVIEW, Phase.TRANSCRIBING, Phase.TRANSLATING}
)
RETRYABLE_DOCUMENT_STATUSES: Final = frozenset(
    {"canceled", "ocr_failed", "no_text_detected", "transcription_failed"}
)
_CANCELING_OR_CANCELED: Final = frozenset({Status.CANCEL_REQUESTED, Status.CANCELED})


@dataclass(frozen=True, slots=True)
class DocumentFailureState:
    """What a failed or canceled run leaves on a page document."""

    status: str
    extraction_method: str
    fallback_reason: str | None
    processed_page_count: int


@dataclass(frozen=True, slots=True)
class DocumentOperation:
    """An upload, extraction, transcription or retry of one document, with whether it can
    still be canceled."""

    id: str
    project_id: str
    document_id: str | None
    status: DocumentOperationStatus
    phase: DocumentOperationPhase
    cancellable: bool
    error: str | None
    created_at: str
    updated_at: str

    @classmethod
    def claim_upload(cls, *, operation_id: str, project_id: str, now: str) -> DocumentOperation:
        """A new upload, cancellable until its document is attached."""

        return cls(
            operation_id, project_id, None, Status.QUEUED, Phase.UPLOADING, True, None, now, now
        )

    @classmethod
    def canceled_before_start(
        cls, *, operation_id: str, project_id: str, now: str
    ) -> DocumentOperation:
        """A tombstone: cancellation arrived before any work claimed the id."""

        return cls(
            operation_id, project_id, None, Status.CANCELED, Phase.CANCELED, False, None, now, now
        )

    @classmethod
    def start_retry(
        cls, *, operation_id: str, project_id: str, document_id: str, now: str
    ) -> DocumentOperation:
        return cls(
            operation_id,
            project_id,
            document_id,
            Status.RUNNING,
            Phase.PROCESSING,
            True,
            None,
            now,
            now,
        )

    @property
    def is_terminal(self) -> bool:
        return self.status in TERMINAL_STATUSES

    @property
    def is_canceling_or_canceled(self) -> bool:
        return self.status in _CANCELING_OR_CANCELED

    def ensure_belongs_to(self, project_id: str) -> None:
        if self.project_id != project_id:
            raise DocumentOperationConflictError("Document operation id is already in use.")

    def cancel(self, now: str) -> DocumentOperation:
        """Request cancellation; a queued upload is canceled at once."""

        if self.is_terminal or self.status is Status.CANCEL_REQUESTED:
            return self
        if self.status is Status.QUEUED:
            return self._move(
                Status.CANCELED, Phase.CANCELED, cancellable=False, error=None, now=now
            )
        if (
            self.status is Status.RUNNING
            and self.phase in CANCELLABLE_PROCESSING_PHASES
            and self.cancellable
        ):
            return self._move(
                Status.CANCEL_REQUESTED,
                Phase.CANCELING,
                cancellable=False,
                error=self.error,
                now=now,
            )
        if self.status is Status.RUNNING and not self.cancellable:
            raise OperationNotCancellableError(
                "Document processing is committing and can no longer be canceled."
            )
        raise DocumentOperationStateError(
            f"Document operation cannot be canceled from {self.status}/{self.phase}."
        )

    def attach_document(self, document_id: str, now: str) -> DocumentOperation:
        """The uploaded file became a document; processing starts."""

        if self.is_canceling_or_canceled:
            raise DocumentProcessingCanceledError("Document upload was canceled.")
        if not (
            self.status is Status.QUEUED
            and self.phase is Phase.UPLOADING
            and self.cancellable
            and self.document_id is None
        ):
            raise DocumentOperationStateError(
                "Document operation was not exclusively claimed for upload."
            )
        moved = self._move(
            Status.RUNNING, Phase.PROCESSING, cancellable=True, error=self.error, now=now
        )
        return replace(moved, document_id=document_id)

    def enter_review(self, document_id: str, now: str) -> DocumentOperation:
        """A capture waits for the user's review, still cancellable."""

        if not self._is(document_id, Status.RUNNING, Phase.PROCESSING, cancellable=True):
            raise DocumentOperationStateError("Document operation could not enter capture review.")
        return self._move(
            Status.RUNNING, Phase.AWAITING_REVIEW, cancellable=True, error=self.error, now=now
        )

    def begin_review_confirmation(self, document_id: str, now: str) -> DocumentOperation:
        """The user confirmed the review; processing resumes."""

        if self.is_canceling_or_canceled:
            raise DocumentProcessingCanceledError("Document processing was canceled.")
        if not self._is(document_id, Status.RUNNING, Phase.AWAITING_REVIEW, cancellable=True):
            raise DocumentOperationStateError(
                "Capture review confirmation is already running or completed."
            )
        return self._move(
            Status.RUNNING, Phase.PROCESSING, cancellable=True, error=self.error, now=now
        )

    def already_published(self, document_id: str, *, results: str) -> bool:
        """Whether this document's results were already published; raises when they may not be."""

        self._ensure_owns(document_id)
        if self.status is Status.SUCCEEDED:
            return True
        if self.is_canceling_or_canceled:
            raise DocumentProcessingCanceledError("Document processing was canceled.")
        if self.is_terminal:
            raise DocumentOperationStateError(
                f"Terminal document operation cannot publish {results}."
            )
        return False

    def begin_commit(self, document_id: str, now: str) -> DocumentOperation:
        """Win the race against cancellation: from here the result is committed."""

        self._ensure_owns(document_id)
        if self.is_canceling_or_canceled:
            raise DocumentProcessingCanceledError("Document processing was canceled.")
        if not self._is(document_id, Status.RUNNING, Phase.PROCESSING, cancellable=True):
            raise DocumentOperationStateError(
                "Document operation was not in its cancellable processing phase."
            )
        return self._move(
            Status.RUNNING, Phase.COMMITTING, cancellable=False, error=self.error, now=now
        )

    def succeed(self, now: str) -> DocumentOperation:
        return self._move(Status.SUCCEEDED, Phase.COMPLETED, cancellable=False, error=None, now=now)

    def acknowledge_cancellation(self, now: str) -> DocumentOperation:
        if self.is_terminal:
            return self
        if self.status is not Status.CANCEL_REQUESTED:
            raise DocumentOperationStateError("Only a requested cancellation can be acknowledged.")
        return self._move(Status.CANCELED, Phase.CANCELED, cancellable=False, error=None, now=now)

    def fail(self, error: str, now: str) -> DocumentOperation:
        """Stop the run: canceled when cancellation was requested, failed otherwise."""

        if self.is_terminal:
            return self
        if self.status is Status.CANCEL_REQUESTED:
            return self._move(
                Status.CANCELED, Phase.CANCELED, cancellable=False, error=None, now=now
            )
        return self._move(Status.FAILED, Phase.FAILED, cancellable=False, error=error, now=now)

    def refuse_reuse_for_retry(self, project_id: str) -> NoReturn:
        """A retry needs a fresh id; a canceled id means the retry was canceled before it ran."""

        self.ensure_belongs_to(project_id)
        if self.is_canceling_or_canceled:
            raise DocumentProcessingCanceledError("Document retry was canceled before it started.")
        raise DocumentOperationConflictError("Document operation id is already in use.")

    def _is(self, document_id: str, status: Status, phase: Phase, *, cancellable: bool) -> bool:
        return (
            self.document_id == document_id
            and self.status is status
            and self.phase is phase
            and self.cancellable is cancellable
        )

    def _ensure_owns(self, document_id: str) -> None:
        if self.document_id != document_id:
            raise DocumentOperationStateError(
                "Document operation does not own the publication document."
            )

    def _move(
        self, status: Status, phase: Phase, *, cancellable: bool, error: str | None, now: str
    ) -> DocumentOperation:
        return replace(
            self, status=status, phase=phase, cancellable=cancellable, error=error, updated_at=now
        )


def ensure_retry_allowed(*, has_active_operation: bool, document_status: str) -> None:
    """A document may be extracted again only after a retryable outcome and with no work running."""

    if has_active_operation:
        raise DocumentOperationConflictError("Document already has an active processing operation.")
    if document_status not in RETRYABLE_DOCUMENT_STATUSES:
        raise DocumentOperationStateError("Document is not eligible for extraction retry.")


def failure_state(
    stopped: DocumentOperation,
    *,
    document_status: str | None,
    extraction_method: str | None,
    page_count: int,
) -> DocumentFailureState:
    """What a page document shows once its run has stopped as failed or canceled."""

    if stopped.status is Status.CANCELED:
        return DocumentFailureState("canceled", "none", None, 0)
    return DocumentFailureState(
        status=document_status or "ocr_failed",
        extraction_method=extraction_method or "ocr_failed",
        fallback_reason=stopped.error,
        processed_page_count=page_count if document_status == "no_text_detected" else 0,
    )


def processing_to_cancel(
    *,
    active: DocumentOperation | None,
    document_status: str,
    last_canceled: DocumentOperation | None,
) -> DocumentOperation:
    """The operation a request to cancel a document's processing is about."""

    if active is not None:
        return active
    if document_status == "canceled":
        if last_canceled is not None:
            return last_canceled
        raise DocumentOperationStateError("Canceled document has no owning document operation.")
    if document_status in {"processing", "cancel_requested"}:
        raise DocumentOperationStateError("Processing document has no active document operation.")
    raise OperationNotCancellableError("Document does not have active extraction to cancel.")
