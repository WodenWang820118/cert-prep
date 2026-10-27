"""The Capture Review Session aggregate: one learner's confirmation of a capture.

A session stays pending while Capture Runtime extracts text, moves to confirming while the
learner's candidate is committed, and then ends completed, canceled, or failed. Each
transition returns the next state, the same object when nothing changes, or raises.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from enum import StrEnum

__all__ = [
    "ACTIVE_CAPTURE_REVIEW_STATUSES",
    "TERMINAL_CAPTURE_REVIEW_STATUSES",
    "CaptureReviewEnding",
    "CaptureReviewSession",
    "CaptureReviewStatus",
    "CaptureReviewTransitionError",
    "event_sequence",
]


class CaptureReviewStatus(StrEnum):
    """Where a capture review session is in its confirmation."""

    PENDING = "pending"
    CONFIRMING = "confirming"
    COMPLETED = "completed"
    CANCELED = "canceled"
    FAILED = "failed"


ACTIVE_CAPTURE_REVIEW_STATUSES = frozenset(
    {
        CaptureReviewStatus.PENDING,
        CaptureReviewStatus.CONFIRMING,
    }
)
TERMINAL_CAPTURE_REVIEW_STATUSES = frozenset(
    {
        CaptureReviewStatus.COMPLETED,
        CaptureReviewStatus.CANCELED,
        CaptureReviewStatus.FAILED,
    }
)


class CaptureReviewTransitionError(RuntimeError):
    """A capture review session cannot make the requested change."""


def event_sequence(sequence: object) -> int:
    """A capture event sequence is a non-negative integer and not a boolean."""

    if isinstance(sequence, bool) or not isinstance(sequence, int) or sequence < 0:
        raise ValueError("Capture event sequence must be a non-negative integer.")
    return sequence


@dataclass(frozen=True, slots=True)
class CaptureReviewEnding:
    """The terminal status a session is asked to reach, and the ending event when known."""

    status: CaptureReviewStatus
    terminal_sequence: int | None = None

    def __post_init__(self) -> None:
        """Keep a terminal status, and a positive event sequence when one is given."""

        status = self.status
        if status not in TERMINAL_CAPTURE_REVIEW_STATUSES:
            raise ValueError(f"Unsupported capture review terminal status: {status}")
        object.__setattr__(self, "status", CaptureReviewStatus(status))
        sequence = self.terminal_sequence
        if sequence is not None and (
            not isinstance(sequence, int) or isinstance(sequence, bool) or sequence < 1
        ):
            raise ValueError("Terminal capture event sequence must be a positive integer.")


@dataclass(frozen=True, slots=True)
class CaptureReviewSession:
    """One durable review of a capture, from extraction through the learner's confirmation."""

    id: str
    project_id: str
    document_id: str
    operation_id: str
    runtime_capture_id: str | None
    status: CaptureReviewStatus
    review_revision: int
    expires_at: str
    created_at: str
    updated_at: str
    confirm_request_id: str | None
    confirm_review_digest: str | None
    last_event_sequence: int

    @property
    def is_active(self) -> bool:
        """Whether the learner can still confirm or cancel this capture."""

        return self.status in ACTIVE_CAPTURE_REVIEW_STATUSES

    @property
    def is_terminal(self) -> bool:
        """Whether the session has completed, been canceled, or failed."""

        return self.status in TERMINAL_CAPTURE_REVIEW_STATUSES

    def with_runtime_capture(self, runtime_capture_id: str, *, now: str) -> CaptureReviewSession:
        """Record the runtime capture. Only a pending session can take one."""

        if self.status != CaptureReviewStatus.PENDING:
            raise CaptureReviewTransitionError("Capture review session is no longer pending.")
        return replace(self, runtime_capture_id=runtime_capture_id, updated_at=now)

    def claim_confirmation(
        self,
        *,
        review_revision: int,
        client_request_id: str | None,
        review_digest: str | None,
        now: str,
    ) -> tuple[CaptureReviewSession, bool]:
        """Claim a pending session, or recognize the same claim already in progress.

        A confirming session returns itself when this request repeats its revision or its
        review data. Reusing a client request id with different review data is rejected.
        """

        if self.status == CaptureReviewStatus.CONFIRMING:
            if client_request_id is None and self.review_revision == review_revision:
                return self, False
            if (
                self.confirm_request_id == client_request_id
                and self.confirm_review_digest == review_digest
            ):
                return self, False
            if self.confirm_request_id == client_request_id:
                raise CaptureReviewTransitionError(
                    "The same client request id was reused with different review data."
                )
            raise CaptureReviewTransitionError(
                "Capture review session is not pending confirmation."
            )
        if self.status != CaptureReviewStatus.PENDING:
            raise CaptureReviewTransitionError(
                "Capture review session is not pending confirmation."
            )
        return (
            replace(
                self,
                status=CaptureReviewStatus.CONFIRMING,
                review_revision=review_revision,
                confirm_request_id=client_request_id,
                confirm_review_digest=review_digest,
                updated_at=now,
            ),
            True,
        )

    def finished(self, ending: CaptureReviewEnding, *, now: str) -> CaptureReviewSession:
        """End an active session, or move a terminal session's event sequence forward.

        A terminal session keeps its status and its updated time. An active session takes
        the ending status and a sequence at least as high as the one it already observed.
        """

        if self.is_terminal:
            if (
                ending.terminal_sequence is not None
                and ending.terminal_sequence > self.last_event_sequence
            ):
                return replace(self, last_event_sequence=ending.terminal_sequence)
            return self
        final_sequence = (
            self.last_event_sequence + 1
            if ending.terminal_sequence is None
            else max(self.last_event_sequence, ending.terminal_sequence)
        )
        return replace(
            self,
            status=ending.status,
            last_event_sequence=final_sequence,
            updated_at=now,
        )
