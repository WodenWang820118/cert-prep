"""Host-mode orchestration for one Capture Runtime job.

The runtime owns extraction and final validation. Cert Prep contributes only its
existing structured-JSON provider and receives a result after the sidecar has
accepted the complete CaptureDocumentV1 candidate.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from time import monotonic, sleep
from uuid import UUID, uuid5

import httpx

from cert_prep_backend.domains.capture_workbench.client import (
    CaptureRuntimeClient,
    CaptureUpload,
)
from cert_prep_backend.domains.capture_workbench.contracts import (
    CaptureDocumentV1,
    CaptureJobStage,
    CaptureJobStatus,
    CaptureJobV1,
    CaptureSourceKind,
    RawCaptureV1,
)
from cert_prep_backend.domains.capture_workbench.structuring import (
    CaptureStructuringCanceledError,
    CaptureStructuringTimeoutError,
    CertPrepCaptureStructuringAdapter,
)


_IDEMPOTENCY_NAMESPACE = UUID("518ad006-a998-4b4b-b0fb-9be26b4447ac")


class CaptureRuntimeJobError(RuntimeError):
    """The sidecar reached a terminal non-success state."""

    def __init__(self, job: CaptureJobV1) -> None:
        message = job.error.message if job.error is not None else "Capture Runtime job failed."
        super().__init__(message)
        self.capture_id = job.capture_id
        self.code = job.error.code if job.error is not None else "capture_failed"
        self.stage = job.error.stage if job.error is not None else job.stage.value


class CaptureRuntimeCanceledError(RuntimeError):
    """The host operation was cancelled while Capture Runtime was active."""


class CaptureRuntimeTimeoutError(RuntimeError):
    """Capture Runtime did not reach the required state before the host deadline."""


class CaptureRuntimeStateUnknownError(RuntimeError):
    """The host could not confirm the sidecar's state after an ambiguous request."""

    def __init__(self, capture_id: str, message: str) -> None:
        super().__init__(message)
        self.capture_id = capture_id


@dataclass(frozen=True, slots=True)
class CaptureRunResult:
    capture_id: str
    raw: RawCaptureV1
    document: CaptureDocumentV1


class CertPrepCaptureCoordinator:
    """Drive extraction, host structuring, and runtime validation synchronously."""

    def __init__(
        self,
        *,
        client: CaptureRuntimeClient,
        structurer: CertPrepCaptureStructuringAdapter,
        poll_interval_seconds: float = 0.1,
        timeout_seconds: float = 900,
        clock: Callable[[], float] = monotonic,
        sleeper: Callable[[float], None] = sleep,
    ) -> None:
        if poll_interval_seconds <= 0:
            raise ValueError("Capture Runtime poll interval must be positive")
        if timeout_seconds <= 0:
            raise ValueError("Capture Runtime timeout must be positive")
        self._client = client
        self._structurer = structurer
        self._poll_interval_seconds = poll_interval_seconds
        self._timeout_seconds = timeout_seconds
        self._clock = clock
        self._sleeper = sleeper

    def capture(
        self,
        *,
        operation_id: str,
        file_name: str,
        content: bytes,
        media_type: str,
        source_kind: CaptureSourceKind,
        target_language: str | None,
        should_cancel: Callable[[], bool],
    ) -> CaptureRunResult:
        self._client.handshake()
        if should_cancel():
            raise CaptureRuntimeCanceledError("Document processing was cancelled.")

        job = self._client.create_capture(
            CaptureUpload(file_name=file_name, content=content, media_type=media_type),
            source_kind=source_kind,
            idempotency_key=_idempotency_key(operation_id, "capture"),
            target_language=target_language,
        )
        deadline = self._clock() + self._timeout_seconds
        job = self._wait_for_structuring(job, deadline=deadline, should_cancel=should_cancel)
        raw = self._client.get_raw(job.capture_id)

        try:
            candidate = self._structurer.structure(
                raw,
                target_language=target_language,
                should_cancel=should_cancel,
                deadline=deadline,
                monotonic_clock=self._clock,
            )
        except CaptureStructuringCanceledError as error:
            self._cancel(job.capture_id)
            raise CaptureRuntimeCanceledError("Document processing was cancelled.") from error
        except CaptureStructuringTimeoutError as error:
            self._cancel(job.capture_id)
            raise CaptureRuntimeTimeoutError("Capture Runtime job timed out.") from error
        except Exception:
            self._report_structuring_failure(job.capture_id)
            raise

        if should_cancel():
            self._cancel(job.capture_id)
            raise CaptureRuntimeCanceledError("Document processing was cancelled.")

        commit_idempotency_key = _idempotency_key(operation_id, "structure")
        job = self._commit_structure(
            job.capture_id,
            candidate,
            idempotency_key=commit_idempotency_key,
            deadline=deadline,
            should_cancel=should_cancel,
        )
        job = self._wait_for_completion(job, deadline=deadline, should_cancel=should_cancel)
        return CaptureRunResult(
            capture_id=job.capture_id,
            raw=raw,
            document=self._client.get_result(job.capture_id),
        )

    def delete(self, capture_id: str) -> None:
        """Delete a job only after the host has atomically persisted its result."""

        self._client.delete_capture(capture_id)

    def _wait_for_structuring(
        self,
        job: CaptureJobV1,
        *,
        deadline: float,
        should_cancel: Callable[[], bool],
    ) -> CaptureJobV1:
        while job.stage not in {
            CaptureJobStage.AWAITING_STRUCTURING,
            CaptureJobStage.COMPLETED,
            CaptureJobStage.FAILED,
            CaptureJobStage.CANCELLED,
        }:
            job = self._next(job, deadline=deadline, should_cancel=should_cancel)
        if job.stage is CaptureJobStage.COMPLETED:
            raise CaptureRuntimeJobError(job)
        self._raise_for_terminal(job)
        return job

    def _wait_for_completion(
        self,
        job: CaptureJobV1,
        *,
        deadline: float,
        should_cancel: Callable[[], bool],
    ) -> CaptureJobV1:
        while job.status not in {
            CaptureJobStatus.COMPLETED,
            CaptureJobStatus.FAILED,
            CaptureJobStatus.CANCELLED,
        }:
            job = self._next(job, deadline=deadline, should_cancel=should_cancel)
        self._raise_for_terminal(job)
        return job

    def _next(
        self,
        job: CaptureJobV1,
        *,
        deadline: float,
        should_cancel: Callable[[], bool],
    ) -> CaptureJobV1:
        if should_cancel():
            self._cancel(job.capture_id)
            raise CaptureRuntimeCanceledError("Document processing was cancelled.")
        if self._clock() >= deadline:
            self._cancel(job.capture_id)
            raise CaptureRuntimeTimeoutError("Capture Runtime job timed out.")
        self._sleeper(self._poll_interval_seconds)
        return self._client.get_capture(job.capture_id)

    def _commit_structure(
        self,
        capture_id: str,
        candidate: str | bytes | dict[str, object],
        *,
        idempotency_key: UUID,
        deadline: float,
        should_cancel: Callable[[], bool],
    ) -> CaptureJobV1:
        while True:
            try:
                return self._client.commit_structure(
                    capture_id,
                    candidate,
                    idempotency_key=idempotency_key,
                )
            except httpx.TransportError as error:
                job = self._get_capture_for_reconciliation(
                    capture_id,
                    action="a structured-result commit response was lost",
                )
                if self._is_terminal(job):
                    return job
                if not self._is_awaiting_structuring(job):
                    raise CaptureRuntimeStateUnknownError(
                        capture_id,
                        "Capture Runtime structured-result commit outcome could not be "
                        "confirmed from the current job state.",
                    ) from error
                if should_cancel():
                    self._cancel(capture_id)
                    raise CaptureRuntimeCanceledError(
                        "Document processing was cancelled."
                    ) from error
                if self._clock() >= deadline:
                    self._cancel(capture_id)
                    raise CaptureRuntimeTimeoutError("Capture Runtime job timed out.") from error
                self._sleeper(self._poll_interval_seconds)

    def _report_structuring_failure(self, capture_id: str) -> CaptureJobV1:
        try:
            job = self._client.report_structuring_failure(
                capture_id,
                code="host_provider_failed",
                message="Cert Prep's configured structuring provider failed.",
            )
        except Exception:
            job = self._get_capture_for_reconciliation(
                capture_id,
                action="a host-provider failure report was not confirmed",
            )

        if self._is_terminal(job):
            return job
        if self._is_awaiting_structuring(job):
            return self._cancel_and_confirm(capture_id)
        raise CaptureRuntimeStateUnknownError(
            capture_id,
            "Capture Runtime host-provider failure did not produce a confirmed terminal state.",
        )

    def _cancel(self, capture_id: str) -> None:
        self._cancel_and_confirm(capture_id)

    def _cancel_and_confirm(self, capture_id: str) -> CaptureJobV1:
        cancelled: CaptureJobV1 | None = None
        cancel_error: Exception | None = None
        try:
            cancelled = self._client.cancel_capture(capture_id)
        except Exception as error:
            cancel_error = error

        try:
            confirmed = self._client.get_capture(capture_id)
        except Exception as error:
            if cancelled is not None and self._is_terminal(cancelled):
                return cancelled
            raise CaptureRuntimeStateUnknownError(
                capture_id,
                "Capture Runtime cancellation response and terminal state could not be confirmed.",
            ) from error

        if self._is_terminal(confirmed):
            return confirmed
        raise CaptureRuntimeStateUnknownError(
            capture_id,
            "Capture Runtime cancellation did not produce a confirmed terminal state.",
        ) from cancel_error

    def _get_capture_for_reconciliation(
        self,
        capture_id: str,
        *,
        action: str,
    ) -> CaptureJobV1:
        try:
            return self._client.get_capture(capture_id)
        except Exception as error:
            raise CaptureRuntimeStateUnknownError(
                capture_id,
                f"Capture Runtime {action}; the current job state could not be confirmed.",
            ) from error

    @staticmethod
    def _is_terminal(job: CaptureJobV1) -> bool:
        return job.status in {
            CaptureJobStatus.COMPLETED,
            CaptureJobStatus.FAILED,
            CaptureJobStatus.CANCELLED,
        }

    @staticmethod
    def _is_awaiting_structuring(job: CaptureJobV1) -> bool:
        return (
            job.status is CaptureJobStatus.RUNNING
            and job.stage is CaptureJobStage.AWAITING_STRUCTURING
        )

    @staticmethod
    def _raise_for_terminal(job: CaptureJobV1) -> None:
        if job.status is CaptureJobStatus.CANCELLED:
            raise CaptureRuntimeCanceledError("Capture Runtime job was cancelled.")
        if job.status is CaptureJobStatus.FAILED:
            raise CaptureRuntimeJobError(job)


def _idempotency_key(operation_id: str, stage: str) -> UUID:
    return uuid5(_IDEMPOTENCY_NAMESPACE, f"{operation_id}:{stage}")


__all__ = [
    "CaptureRunResult",
    "CaptureRuntimeCanceledError",
    "CaptureRuntimeJobError",
    "CaptureRuntimeStateUnknownError",
    "CaptureRuntimeTimeoutError",
    "CertPrepCaptureCoordinator",
]
