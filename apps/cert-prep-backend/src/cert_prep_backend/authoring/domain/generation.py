"""The Draft Generation aggregate: background work that turns source chunks into question drafts.

A draft generation job writes the drafts of one source chunk after a document is imported; a
manual draft operation writes drafts for a whole document when the learner asks. Both can be
canceled until they start committing, and a cancellation that was requested wins over any
other ending.

Each transition returns the next state (the same object when nothing changes) or raises; the
storage writes the next state only while the record is still in the state it was decided from.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, replace
from enum import StrEnum
from typing import Any

__all__ = [
    "JOB_RETRYABLE_STATUSES",
    "JOB_TERMINAL_STATUSES",
    "OPERATION_TERMINAL_STATUSES",
    "DraftGenerationJob",
    "DraftGenerationJobStatus",
    "DraftJobCanceledError",
    "DraftJobNotCancellableError",
    "ManualDraftOperation",
    "ManualDraftOperationStatus",
]


class DraftGenerationJobStatus(StrEnum):
    PENDING = "pending"
    RUNNING = "running"
    CANCEL_REQUESTED = "cancel_requested"
    CANCELED = "canceled"
    SUCCEEDED = "succeeded"
    SKIPPED_PROVIDER_UNAVAILABLE = "skipped_provider_unavailable"
    SKIPPED_MISSING_MODEL = "skipped_missing_model"
    FAILED = "failed"


class ManualDraftOperationStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    CANCEL_REQUESTED = "cancel_requested"
    CANCELED = "canceled"
    SUCCEEDED = "succeeded"
    FAILED = "failed"


JOB_TERMINAL_STATUSES = frozenset(
    {
        DraftGenerationJobStatus.SUCCEEDED,
        DraftGenerationJobStatus.SKIPPED_PROVIDER_UNAVAILABLE,
        DraftGenerationJobStatus.SKIPPED_MISSING_MODEL,
        DraftGenerationJobStatus.FAILED,
        DraftGenerationJobStatus.CANCELED,
    }
)
# A job that ended without drafts runs again once its blocker (model, provider) is gone.
JOB_RETRYABLE_STATUSES = frozenset(
    {
        DraftGenerationJobStatus.SKIPPED_PROVIDER_UNAVAILABLE,
        DraftGenerationJobStatus.SKIPPED_MISSING_MODEL,
        DraftGenerationJobStatus.FAILED,
        DraftGenerationJobStatus.CANCELED,
    }
)
OPERATION_TERMINAL_STATUSES = frozenset(
    {
        ManualDraftOperationStatus.CANCELED,
        ManualDraftOperationStatus.SUCCEEDED,
        ManualDraftOperationStatus.FAILED,
    }
)

_Job = DraftGenerationJobStatus
_Operation = ManualDraftOperationStatus


class DraftJobCanceledError(RuntimeError):
    """Raised when cancellation wins before a draft job commit begins."""


class DraftJobNotCancellableError(RuntimeError):
    """Raised after a draft job has entered its atomic commit phase."""


@dataclass(frozen=True, slots=True)
class DraftGenerationJob:
    """Generating the drafts of one source chunk, once per chunk and strategy."""

    id: str
    project_id: str
    document_id: str
    chunk_id: str
    page_number: int
    strategy: str
    status: DraftGenerationJobStatus
    provider: str
    model: str
    effective_provider: str | None
    effective_model: str | None
    fallback_reason: str | None
    phase: str
    cancellable: bool
    generated_count: int
    retry_count: int
    last_error: str | None
    created_at: str
    updated_at: str

    @property
    def is_terminal(self) -> bool:
        return self.status in JOB_TERMINAL_STATUSES

    def should_run(self) -> bool:
        return self.status is _Job.PENDING

    def start(self, now: str) -> DraftGenerationJob:
        """A pending job starts generating; any other job stays as it is."""

        if self.status is not _Job.PENDING:
            return self
        return replace(
            self,
            status=_Job.RUNNING,
            phase="generating",
            cancellable=True,
            generated_count=0,
            last_error=None,
            updated_at=now,
        )

    def cancel(self, now: str) -> DraftGenerationJob:
        """A pending job is canceled at once; a running one is asked to stop."""

        if self.is_terminal or self.status is _Job.CANCEL_REQUESTED:
            return self
        if not self.cancellable:
            raise DraftJobNotCancellableError(
                "Draft generation is committing and can no longer be canceled."
            )
        if self.status is _Job.PENDING:
            return replace(
                self,
                status=_Job.CANCELED,
                phase="canceled",
                cancellable=False,
                last_error=None,
                updated_at=now,
            )
        return replace(
            self,
            status=_Job.CANCEL_REQUESTED,
            phase="canceling",
            cancellable=False,
            last_error=None,
            updated_at=now,
        )

    def begin_commit(self, now: str) -> DraftGenerationJob:
        """Win the race against cancellation: from here the drafts are committed."""

        if self.status is _Job.RUNNING and self.cancellable:
            return replace(self, phase="committing", cancellable=False, updated_at=now)
        if self.status in {_Job.CANCEL_REQUESTED, _Job.CANCELED}:
            raise DraftJobCanceledError("Draft generation was canceled.")
        if self.is_terminal:
            return self
        raise DraftJobNotCancellableError("Draft generation is not in a cancellable running phase.")

    def acknowledge_cancellation(self, now: str) -> DraftGenerationJob:
        return self._stop(_Job.CANCELED, last_error=None, now=now)

    def skip_for_missing_model(self, detail: str, now: str) -> DraftGenerationJob:
        return self._stop(_Job.SKIPPED_MISSING_MODEL, last_error=detail, now=now)

    def skip_for_unavailable_provider(self, detail: str, now: str) -> DraftGenerationJob:
        return self._stop(_Job.SKIPPED_PROVIDER_UNAVAILABLE, last_error=detail, now=now)

    def fail(self, detail: str, now: str) -> DraftGenerationJob:
        return self._stop(_Job.FAILED, last_error=detail, now=now)

    def _stop(
        self, status: DraftGenerationJobStatus, *, last_error: str | None, now: str
    ) -> DraftGenerationJob:
        """End the job without drafts; a requested cancellation wins, and a failure counts."""

        if self.is_terminal:
            return self
        if self.status is _Job.CANCEL_REQUESTED:
            status, last_error = _Job.CANCELED, None
        return replace(
            self,
            status=status,
            phase=_stopped_phase(status),
            cancellable=False,
            generated_count=0,
            last_error=last_error,
            retry_count=self.retry_count + 1 if status is _Job.FAILED else self.retry_count,
            updated_at=now,
        )


@dataclass(frozen=True, slots=True)
class ManualDraftOperation:
    """Generating drafts for a whole document when the learner asks; one at a time."""

    id: str
    project_id: str
    document_id: str
    limit: int
    strategy: str
    status: ManualDraftOperationStatus
    phase: str
    cancellable: bool
    provider: str
    model: str
    effective_provider: str | None
    effective_model: str | None
    fallback_reason: str | None
    generated_count: int
    unavailable_blocks: tuple[Mapping[str, Any], ...]
    error: str | None
    created_at: str
    updated_at: str
    commit_started_at: str | None

    @classmethod
    def queue(
        cls,
        *,
        operation_id: str,
        project_id: str,
        document_id: str,
        limit: int,
        strategy: str,
        provider: str,
        model: str,
        now: str,
    ) -> ManualDraftOperation:
        """A new operation waits in the queue and can still be canceled."""

        return cls(
            id=operation_id,
            project_id=project_id,
            document_id=document_id,
            limit=limit,
            strategy=strategy,
            status=_Operation.QUEUED,
            phase="queued",
            cancellable=True,
            provider=provider,
            model=model,
            effective_provider=None,
            effective_model=None,
            fallback_reason=None,
            generated_count=0,
            unavailable_blocks=(),
            error=None,
            created_at=now,
            updated_at=now,
            commit_started_at=None,
        )

    @property
    def is_terminal(self) -> bool:
        return self.status in OPERATION_TERMINAL_STATUSES

    def start(self, now: str) -> ManualDraftOperation:
        """A queued operation starts generating; any other operation stays as it is."""

        if self.status is not _Operation.QUEUED:
            return self
        return replace(
            self,
            status=_Operation.RUNNING,
            phase="generating",
            cancellable=True,
            error=None,
            commit_started_at=None,
            updated_at=now,
        )

    def begin_commit(self, now: str) -> ManualDraftOperation:
        """Win the race against cancellation; committing again keeps its first start time."""

        if self.status is _Operation.RUNNING and self.cancellable:
            return replace(
                self,
                phase="committing",
                cancellable=False,
                commit_started_at=(
                    self.commit_started_at if self.commit_started_at is not None else now
                ),
                updated_at=now,
            )
        if self.status in {_Operation.CANCEL_REQUESTED, _Operation.CANCELED}:
            raise DraftJobCanceledError("Manual draft generation was canceled.")
        if self.is_terminal or self._is_committing:
            return self
        raise DraftJobNotCancellableError(
            "Manual draft generation is not in a cancellable running phase."
        )

    def cancel(self, now: str) -> ManualDraftOperation:
        """A queued operation is canceled at once; a running one is asked to stop."""

        if self.status is _Operation.SUCCEEDED and self.commit_started_at is not None:
            raise DraftJobNotCancellableError(
                "Manual draft generation committed and can no longer be canceled."
            )
        if self.is_terminal or self.status is _Operation.CANCEL_REQUESTED:
            return self
        if not self.cancellable:
            raise DraftJobNotCancellableError(
                "Manual draft generation is committing and can no longer be canceled."
            )
        if self.status is _Operation.QUEUED:
            return replace(
                self,
                status=_Operation.CANCELED,
                phase="canceled",
                cancellable=False,
                error=None,
                updated_at=now,
            )
        return replace(
            self,
            status=_Operation.CANCEL_REQUESTED,
            phase="canceling",
            cancellable=False,
            error=None,
            updated_at=now,
        )

    def acknowledge_cancellation(self, now: str) -> ManualDraftOperation:
        return self._finish(_Operation.CANCELED, "canceled", error=None, now=now)

    def fail(self, detail: str, now: str) -> ManualDraftOperation:
        return self._finish(_Operation.FAILED, "failed", error=detail, now=now)

    @property
    def _is_committing(self) -> bool:
        return (
            self.status is _Operation.RUNNING
            and self.phase == "committing"
            and not self.cancellable
            and self.commit_started_at is not None
        )

    def _finish(
        self, status: ManualDraftOperationStatus, phase: str, *, error: str | None, now: str
    ) -> ManualDraftOperation:
        """End the operation; a requested cancellation wins."""

        if self.is_terminal:
            return self
        if self.status is _Operation.CANCEL_REQUESTED:
            status, phase, error = _Operation.CANCELED, "canceled", None
        return replace(self, status=status, phase=phase, cancellable=False, error=error, updated_at=now)


def _stopped_phase(status: DraftGenerationJobStatus) -> str:
    if status is _Job.SUCCEEDED:
        return "completed"
    if status is _Job.CANCELED:
        return "canceled"
    return "failed"
