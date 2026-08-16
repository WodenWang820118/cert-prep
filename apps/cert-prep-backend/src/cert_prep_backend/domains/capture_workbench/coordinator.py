"""Host-mode orchestration for Capture Runtime v2 streaming operations."""

from __future__ import annotations

from collections.abc import Callable, Iterator, Mapping
from dataclasses import dataclass
import json
from time import monotonic, sleep
from uuid import UUID, uuid5

import httpx
from pydantic import ValidationError

from capture_runtime_client import (
    CaptureDocument,
    CaptureEvent,
    CaptureOperation,
    CaptureRequirementId,
    CaptureSourceKind,
    PartialCapture,
    RawCapture,
    RuntimeRequirementStatus,
    RuntimeRequirement,
    StreamingCaptureStatus,
    StreamingEventType,
)
from cert_prep_backend.domains.capture_workbench.client import (
    CaptureRuntimeClient,
    CaptureRuntimeCompatibilityError,
    CaptureRuntimeProtocolError,
    CaptureStreamingResult,
    CaptureUpload,
)
from cert_prep_backend.domains.capture_workbench.review import reviewed_text_overrides
from cert_prep_backend.domains.capture_workbench.host_models import CaptureReview
from cert_prep_backend.domains.capture_workbench.runtime_policy import (
    LEGACY_CORE_ONLY_RUNTIME_VERSION,
)
from cert_prep_backend.domains.capture_workbench.structuring import (
    CaptureStructuringCanceledError,
    CaptureStructuringTimeoutError,
    CertPrepCaptureStructuringAdapter,
)


_IDEMPOTENCY_NAMESPACE = UUID("518ad006-a998-4b4b-b0fb-9be26b4447ac")
_MAX_EVENT_RECONNECTS = 32
PDF_OCR_UNAVAILABLE_MESSAGE = (
    "This PDF requires WindowsML OCR, which is unavailable in the installed "
    "Capture Runtime."
)
_SOURCE_REQUIREMENTS: dict[
    CaptureSourceKind,
    tuple[CaptureRequirementId, str],
] = {
    CaptureSourceKind.IMAGE: ("windowsml-ocr", "WindowsML OCR"),
    CaptureSourceKind.AUDIO: ("whisper-primary", "Whisper transcription"),
}
_PDF_OCR_REQUIREMENT: tuple[CaptureRequirementId, str] = (
    "windowsml-ocr",
    "WindowsML OCR",
)
_TERMINAL_STATUSES = {
    StreamingCaptureStatus.COMPLETED,
    StreamingCaptureStatus.FAILED,
    StreamingCaptureStatus.CANCELLED,
}
_TERMINAL_EVENTS = {
    StreamingEventType.COMPLETED,
    StreamingEventType.FAILED,
    StreamingEventType.CANCELLED,
}


class CaptureRuntimeJobError(RuntimeError):
    """The sidecar reached a terminal non-success state."""

    def __init__(self, operation: CaptureOperation) -> None:
        message = (
            operation.error.message
            if operation.error is not None
            else "Capture Runtime operation failed."
        )
        super().__init__(message)
        self.capture_id = operation.capture_id
        self.last_event_sequence = operation.last_event_sequence
        self.code = operation.error.code if operation.error is not None else "capture_failed"
        self.stage = (
            operation.error.stage
            if operation.error is not None and operation.error.stage is not None
            else operation.status.value
        )


class CaptureRuntimeCanceledError(RuntimeError):
    """The host operation was cancelled while Capture Runtime was active."""


class CaptureRuntimeRequirementUnavailableError(RuntimeError):
    """A source dependency is not ready, so no sidecar operation was admitted."""

    def __init__(
        self,
        *,
        source_kind: CaptureSourceKind,
        requirement_id: CaptureRequirementId,
        display_name: str,
        status: RuntimeRequirementStatus | None,
        detail: str | None,
    ) -> None:
        requirement_detail = (
            detail.strip()
            if detail is not None and detail.strip()
            else "The runtime requirement is unavailable."
        )
        super().__init__(f"{display_name} is unavailable. {requirement_detail}")
        self.source_kind = source_kind
        self.requirement_id = requirement_id
        self.status = status


class CaptureRuntimeTimeoutError(RuntimeError):
    """Capture Runtime did not reach the required state before the host deadline."""


class CaptureRuntimeStateUnknownError(RuntimeError):
    """The host could not confirm the sidecar state after an ambiguous request."""

    def __init__(self, capture_id: str, message: str) -> None:
        super().__init__(message)
        self.capture_id = capture_id


@dataclass(frozen=True, slots=True)
class CaptureRunResult:
    capture_id: str
    last_event_sequence: int
    raw: RawCapture
    document: CaptureDocument


class CertPrepCaptureCoordinator:
    """Drive extraction via replayable SSE and host structuring synchronously."""

    def __init__(
        self,
        *,
        client: CaptureRuntimeClient,
        structurer: CertPrepCaptureStructuringAdapter,
        reconciliation_interval_seconds: float = 0.1,
        timeout_seconds: float = 900,
        clock: Callable[[], float] = monotonic,
        sleeper: Callable[[float], None] = sleep,
    ) -> None:
        if reconciliation_interval_seconds <= 0:
            raise ValueError("Capture Runtime reconciliation interval must be positive")
        if timeout_seconds <= 0:
            raise ValueError("Capture Runtime timeout must be positive")
        self._client = client
        self._structurer = structurer
        self._reconciliation_interval_seconds = reconciliation_interval_seconds
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
        source_kind: CaptureSourceKind | str,
        target_language: str | None,
        should_cancel: Callable[[], bool],
    ) -> CaptureRunResult:
        operation = self.begin_capture(
            operation_id=operation_id,
            file_name=file_name,
            content=content,
            media_type=media_type,
            source_kind=source_kind,
            target_language=target_language,
            should_cancel=should_cancel,
        )
        return self.confirm_capture(
            operation_id=operation_id,
            capture_id=operation.capture_id,
            target_language=target_language,
            review=None,
            should_cancel=should_cancel,
        )

    def begin_capture(
        self,
        *,
        operation_id: str,
        file_name: str,
        content: bytes,
        media_type: str,
        source_kind: CaptureSourceKind | str,
        target_language: str | None,
        should_cancel: Callable[[], bool],
        on_started: Callable[[CaptureOperation], None] | None = None,
    ) -> CaptureOperation:
        kind = CaptureSourceKind(source_kind)
        ready = self._client.handshake()
        capture_kinds = ready.capabilities.get("captureKinds", [])
        if not isinstance(capture_kinds, list) or kind.value not in capture_kinds:
            raise CaptureRuntimeCompatibilityError(
                f"Capture Runtime does not support {kind.value.upper()} capture."
            )
        self._assert_source_requirement_ready(kind)
        if should_cancel():
            raise CaptureRuntimeCanceledError("Document processing was cancelled.")
        operation = self._client.start_capture(
            CaptureUpload(file_name=file_name, content=content, media_type=media_type),
            source_kind=kind,
            client_request_id=operation_id,
            target_language=target_language,
        )
        if on_started is not None:
            on_started(operation)
        deadline = self._clock() + self._timeout_seconds
        try:
            return self._wait_for_structuring(
                operation,
                deadline=deadline,
                should_cancel=should_cancel,
            )
        except CaptureRuntimeJobError as error:
            self._raise_if_pdf_ocr_is_unavailable(
                kind,
                error,
                runtime_version=ready.runtime_version,
            )
            raise

    def structure_capture(
        self,
        *,
        operation_id: str,
        capture_id: str,
        target_language: str | None,
        review: CaptureReview | None,
        should_cancel: Callable[[], bool],
    ) -> CaptureDocument:
        deadline = self._clock() + self._timeout_seconds
        raw = self._client.get_raw(capture_id)
        if review is not None:
            reviewed_text_overrides(raw, review)
        try:
            structure_kwargs: dict[str, object] = {
                "target_language": target_language,
                "should_cancel": should_cancel,
                "deadline": deadline,
                "monotonic_clock": self._clock,
            }
            if isinstance(self._structurer, CertPrepCaptureStructuringAdapter):
                structure_kwargs.update(
                    {
                        "capture_id": capture_id,
                        "operation_id": operation_id,
                        "review_overrides": (
                            reviewed_text_overrides(raw, review) if review is not None else None
                        ),
                    }
                )
            candidate = self._structurer.structure(raw, **structure_kwargs)
            document = _capture_document(candidate)
            if review is None:
                return document
            overrides = reviewed_text_overrides(raw, review)
            if not overrides:
                return document
            payload = document.model_dump(mode="json", by_alias=True)
            blocks = payload["blocks"]
            if not isinstance(blocks, list):
                raise CaptureRuntimeProtocolError(
                    "Host structuring candidate has an invalid block projection"
                )
            for block in blocks:
                if not isinstance(block, dict):
                    raise CaptureRuntimeProtocolError(
                        "Host structuring candidate has an invalid block projection"
                    )
                source_segment_id = block.get("sourceSegmentId")
                if isinstance(source_segment_id, str) and source_segment_id in overrides:
                    block["targetText"] = overrides[source_segment_id]
            payload["targetText"] = "\n".join(
                str(block["targetText"])
                for block in blocks
                if isinstance(block, dict)
            )
            return CaptureDocument.model_validate(payload)
        except CaptureStructuringCanceledError as error:
            self._cancel(capture_id)
            raise CaptureRuntimeCanceledError("Document processing was cancelled.") from error
        except CaptureStructuringTimeoutError as error:
            self._cancel(capture_id)
            raise CaptureRuntimeTimeoutError("Capture Runtime operation timed out.") from error
        except Exception:
            raise

    def commit_capture(
        self,
        *,
        operation_id: str,
        capture_id: str,
        candidate: CaptureDocument | str | bytes | Mapping[str, object],
        should_cancel: Callable[[], bool],
    ) -> CaptureRunResult:
        deadline = self._clock() + self._timeout_seconds
        document = _capture_document(candidate)
        if should_cancel():
            self._cancel(capture_id)
            raise CaptureRuntimeCanceledError("Document processing was cancelled.")
        if self._supports_pull_sessions():
            operation = self._client.get_capture(capture_id)
            if operation.status is StreamingCaptureStatus.COMPLETED:
                # Pull-session submission has already caused the runtime to
                # validate, reconstruct, and complete the base document.  A
                # Cert Prep review may then change only targetText for local
                # persistence; never bypass the runtime's raw/provenance
                # boundary when accepting that overlay.
                result = self._client.get_result(capture_id)
                _assert_review_overlay(document, result.result)
                return CaptureRunResult(
                    capture_id=capture_id,
                    last_event_sequence=result.operation.last_event_sequence,
                    raw=result.raw,
                    document=document,
                )
        operation = self._commit_structure(
            capture_id,
            document.model_dump(mode="json", by_alias=True),
            idempotency_key=_idempotency_key(operation_id, "structure"),
            deadline=deadline,
            should_cancel=should_cancel,
        )
        self._wait_for_completion(
            operation,
            deadline=deadline,
            should_cancel=should_cancel,
        )
        result = self._client.get_result(capture_id)
        if result.operation.status is not StreamingCaptureStatus.COMPLETED:
            raise CaptureRuntimeProtocolError(
                "Capture Runtime result is not attached to a completed operation"
            )
        return CaptureRunResult(
            capture_id=capture_id,
            last_event_sequence=result.operation.last_event_sequence,
            raw=result.raw,
            document=result.result,
        )

    def _supports_pull_sessions(self) -> bool:
        return all(
            callable(getattr(self._client, method, None))
            for method in (
                "open_structuring_session",
                "pull_structuring_batch",
                "submit_structuring_batch",
                "get_capture",
                "get_result",
            )
        )

    def confirm_capture(
        self,
        *,
        operation_id: str,
        capture_id: str,
        target_language: str | None,
        review: CaptureReview | None,
        should_cancel: Callable[[], bool],
    ) -> CaptureRunResult:
        try:
            candidate = self.structure_capture(
                operation_id=operation_id,
                capture_id=capture_id,
                target_language=target_language,
                review=review,
                should_cancel=should_cancel,
            )
        except (CaptureRuntimeCanceledError, CaptureRuntimeTimeoutError):
            raise
        except Exception:
            self._report_structuring_failure(capture_id, operation_id=operation_id)
            raise
        return self.commit_capture(
            operation_id=operation_id,
            capture_id=capture_id,
            candidate=candidate,
            should_cancel=should_cancel,
        )

    def delete(self, capture_id: str) -> None:
        """Delete an ephemeral operation after durable host persistence."""

        self._client.delete_capture(capture_id)

    def get_capture(self, capture_id: str) -> CaptureOperation:
        return self._client.get_capture(capture_id)

    def capture_events(
        self,
        capture_id: str,
        *,
        last_event_id: str | int | None = None,
    ) -> Iterator[CaptureEvent]:
        return self._client.capture_events(capture_id, last_event_id=last_event_id)

    def get_partial(self, capture_id: str) -> PartialCapture:
        return self._client.get_partial(capture_id)

    def get_raw(self, capture_id: str) -> RawCapture:
        return self._client.get_raw(capture_id)

    def get_result(self, capture_id: str) -> CaptureStreamingResult:
        return self._client.get_result(capture_id)

    def cancel(self, capture_id: str) -> CaptureOperation:
        return self._cancel_and_confirm(capture_id)

    def report_structuring_failure(
        self,
        capture_id: str,
        *,
        operation_id: str,
        code: str = "host_provider_failed",
        message: str = "Cert Prep's configured structuring provider failed.",
    ) -> CaptureOperation:
        return self._report_structuring_failure(
            capture_id,
            operation_id=operation_id,
            code=code,
            message=message,
        )

    def _assert_source_requirement_ready(self, source_kind: CaptureSourceKind) -> None:
        policy = _SOURCE_REQUIREMENTS.get(source_kind)
        if policy is None:
            return
        requirement_id, display_name = policy
        requirement = self._runtime_requirement(requirement_id)
        if requirement is not None and requirement.status is RuntimeRequirementStatus.READY:
            return
        raise CaptureRuntimeRequirementUnavailableError(
            source_kind=source_kind,
            requirement_id=requirement_id,
            display_name=display_name,
            status=requirement.status if requirement is not None else None,
            detail=requirement.detail if requirement is not None else None,
        )

    def _raise_if_pdf_ocr_is_unavailable(
        self,
        source_kind: CaptureSourceKind,
        error: CaptureRuntimeJobError,
        *,
        runtime_version: str,
    ) -> None:
        if source_kind is not CaptureSourceKind.PDF:
            return
        if error.code == "extraction_failed" and runtime_version != LEGACY_CORE_ONLY_RUNTIME_VERSION:
            return
        if error.code not in {"extraction_failed", "requirement_unavailable"}:
            return
        requirement_id, display_name = _PDF_OCR_REQUIREMENT
        try:
            requirement = self._runtime_requirement(requirement_id)
        except Exception:
            return
        if requirement is None or requirement.status is RuntimeRequirementStatus.READY:
            return
        raise CaptureRuntimeRequirementUnavailableError(
            source_kind=source_kind,
            requirement_id=requirement_id,
            display_name=display_name,
            status=requirement.status,
            detail=requirement.detail,
        ) from error

    def _runtime_requirement(
        self,
        requirement_id: CaptureRequirementId,
    ) -> RuntimeRequirement | None:
        matches = [
            item
            for item in self._client.get_requirements().items
            if item.requirement_id == requirement_id
        ]
        return matches[0] if len(matches) == 1 else None

    def _wait_for_structuring(
        self,
        operation: CaptureOperation,
        *,
        deadline: float,
        should_cancel: Callable[[], bool],
    ) -> CaptureOperation:
        operation = self._wait_for_status(
            operation,
            stop_statuses={
                StreamingCaptureStatus.AWAITING_STRUCTURING,
                *_TERMINAL_STATUSES,
            },
            deadline=deadline,
            should_cancel=should_cancel,
        )
        if operation.status is StreamingCaptureStatus.COMPLETED:
            raise CaptureRuntimeJobError(operation)
        self._raise_for_terminal(operation)
        return operation

    def _wait_for_completion(
        self,
        operation: CaptureOperation,
        *,
        deadline: float,
        should_cancel: Callable[[], bool],
    ) -> CaptureOperation:
        operation = self._wait_for_status(
            operation,
            stop_statuses=_TERMINAL_STATUSES,
            deadline=deadline,
            should_cancel=should_cancel,
        )
        self._raise_for_terminal(operation)
        if operation.status is not StreamingCaptureStatus.COMPLETED:
            raise CaptureRuntimeStateUnknownError(
                operation.capture_id,
                "Capture Runtime did not confirm a completed operation.",
            )
        return operation

    def _wait_for_status(
        self,
        operation: CaptureOperation,
        *,
        stop_statuses: set[StreamingCaptureStatus],
        deadline: float,
        should_cancel: Callable[[], bool],
    ) -> CaptureOperation:
        reconnects = 0
        current = operation
        while current.status not in stop_statuses:
            self._checkpoint(
                current.capture_id,
                deadline=deadline,
                should_cancel=should_cancel,
            )
            last_sequence = current.last_event_sequence
            try:
                for event in self._client.capture_events(
                    current.capture_id,
                    last_event_id=last_sequence,
                    on_activity=lambda: self._checkpoint(
                        current.capture_id,
                        deadline=deadline,
                        should_cancel=should_cancel,
                    ),
                ):
                    last_sequence = event.sequence
                    if (
                        event.event_type is StreamingEventType.RESYNC_REQUIRED
                        or event.event_type in _TERMINAL_EVENTS
                        or event.stage == StreamingCaptureStatus.AWAITING_STRUCTURING.value
                    ):
                        break
            except httpx.TransportError:
                # A listener disconnect is recovered from the durable event log;
                # it never implies runtime job cancellation.
                pass
            current = self._snapshot_after_stream(
                current.capture_id,
                observed_sequence=last_sequence,
            )
            if current.status in stop_statuses:
                return current
            reconnects += 1
            if reconnects > _MAX_EVENT_RECONNECTS:
                raise CaptureRuntimeStateUnknownError(
                    current.capture_id,
                    "Capture Runtime event replay exceeded the reconnect limit.",
                )
            self._checkpoint(
                current.capture_id,
                deadline=deadline,
                should_cancel=should_cancel,
            )
            self._sleeper(self._reconciliation_interval_seconds)
        return current

    def _snapshot_after_stream(
        self,
        capture_id: str,
        *,
        observed_sequence: int,
    ) -> CaptureOperation:
        try:
            snapshot = self._client.get_capture(capture_id)
        except Exception as error:
            raise CaptureRuntimeStateUnknownError(
                capture_id,
                "Capture Runtime event stream ended and its snapshot was unavailable.",
            ) from error
        if snapshot.last_event_sequence < observed_sequence:
            raise CaptureRuntimeProtocolError(
                "Capture Runtime snapshot regressed behind the observed event sequence"
            )
        return snapshot

    def _checkpoint(
        self,
        capture_id: str,
        *,
        deadline: float,
        should_cancel: Callable[[], bool],
    ) -> None:
        if should_cancel():
            self._cancel(capture_id)
            raise CaptureRuntimeCanceledError("Document processing was cancelled.")
        if self._clock() >= deadline:
            self._cancel(capture_id)
            raise CaptureRuntimeTimeoutError("Capture Runtime operation timed out.")

    def _commit_structure(
        self,
        capture_id: str,
        candidate: Mapping[str, object],
        *,
        idempotency_key: UUID,
        deadline: float,
        should_cancel: Callable[[], bool],
    ) -> CaptureOperation:
        while True:
            try:
                return self._client.commit_structure(
                    capture_id,
                    candidate,
                    idempotency_key=idempotency_key,
                )
            except httpx.TransportError as error:
                operation = self._get_capture_for_reconciliation(
                    capture_id,
                    action="a structured-result commit response was lost",
                )
                if self._is_terminal(operation):
                    return operation
                if not self._is_awaiting_structuring(operation):
                    raise CaptureRuntimeStateUnknownError(
                        capture_id,
                        "Capture Runtime structured-result commit outcome could not be "
                        "confirmed from the current operation state.",
                    ) from error
                self._checkpoint(
                    capture_id,
                    deadline=deadline,
                    should_cancel=should_cancel,
                )
                self._sleeper(self._reconciliation_interval_seconds)

    def _report_structuring_failure(
        self,
        capture_id: str,
        *,
        operation_id: str,
        code: str = "host_provider_failed",
        message: str = "Cert Prep's configured structuring provider failed.",
    ) -> CaptureOperation:
        try:
            operation = self._client.report_structuring_failure(
                capture_id,
                code=code,
                message=message,
                idempotency_key=_idempotency_key(operation_id, "structure-failure"),
            )
        except Exception:
            operation = self._get_capture_for_reconciliation(
                capture_id,
                action="a host-provider failure report was not confirmed",
            )
        if operation is None:
            operation = self._get_capture_for_reconciliation(
                capture_id,
                action="a host-provider failure report returned no operation",
            )
        if self._is_terminal(operation):
            return operation
        if self._is_awaiting_structuring(operation):
            return self._cancel_and_confirm(capture_id)
        raise CaptureRuntimeStateUnknownError(
            capture_id,
            "Capture Runtime host-provider failure did not produce a confirmed terminal state.",
        )

    def _cancel(self, capture_id: str) -> None:
        self._cancel_and_confirm(capture_id)

    def _cancel_and_confirm(self, capture_id: str) -> CaptureOperation:
        cancelled: CaptureOperation | None = None
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
    ) -> CaptureOperation:
        try:
            return self._client.get_capture(capture_id)
        except Exception as error:
            raise CaptureRuntimeStateUnknownError(
                capture_id,
                f"Capture Runtime {action}; the current operation state could not be confirmed.",
            ) from error

    @staticmethod
    def _is_terminal(operation: CaptureOperation) -> bool:
        return operation.status in _TERMINAL_STATUSES

    @staticmethod
    def _is_awaiting_structuring(operation: CaptureOperation) -> bool:
        return operation.status is StreamingCaptureStatus.AWAITING_STRUCTURING

    @staticmethod
    def _raise_for_terminal(operation: CaptureOperation) -> None:
        if operation.status is StreamingCaptureStatus.CANCELLED:
            raise CaptureRuntimeCanceledError("Capture Runtime operation was cancelled.")
        if operation.status is StreamingCaptureStatus.FAILED:
            raise CaptureRuntimeJobError(operation)


def _capture_document(
    candidate: CaptureDocument | str | bytes | Mapping[str, object],
) -> CaptureDocument:
    try:
        if isinstance(candidate, CaptureDocument):
            return candidate
        if isinstance(candidate, Mapping):
            return CaptureDocument.model_validate(dict(candidate))
        return CaptureDocument.model_validate_json(candidate)
    except (ValidationError, ValueError, json.JSONDecodeError) as error:
        raise CaptureRuntimeProtocolError(
            "Host structuring candidate does not satisfy CaptureDocument"
        ) from error


def _assert_review_overlay(candidate: CaptureDocument, runtime_document: CaptureDocument) -> None:
    """Allow only host review text changes after a completed pull session."""

    candidate_payload = candidate.model_dump(mode="json", by_alias=True)
    runtime_payload = runtime_document.model_dump(mode="json", by_alias=True)
    candidate_blocks = candidate_payload.get("blocks")
    runtime_blocks = runtime_payload.get("blocks")
    if not isinstance(candidate_blocks, list) or not isinstance(runtime_blocks, list):
        raise CaptureRuntimeProtocolError("Capture Runtime result has an invalid block projection")
    if len(candidate_blocks) != len(runtime_blocks):
        raise CaptureRuntimeProtocolError("Capture review changed the runtime block count")
    for candidate_block, runtime_block in zip(candidate_blocks, runtime_blocks, strict=True):
        if not isinstance(candidate_block, dict) or not isinstance(runtime_block, dict):
            raise CaptureRuntimeProtocolError("Capture review changed the runtime block shape")
        candidate_without_text = {
            key: value for key, value in candidate_block.items() if key != "targetText"
        }
        runtime_without_text = {
            key: value for key, value in runtime_block.items() if key != "targetText"
        }
        if candidate_without_text != runtime_without_text:
            raise CaptureRuntimeProtocolError(
                "Capture review changed runtime provenance or semantic block identity"
            )
    candidate_payload.pop("blocks", None)
    runtime_payload.pop("blocks", None)
    # The document-level targetText is a derived projection of block text and
    # may change with a host review overlay just like each block targetText.
    candidate_payload.pop("targetText", None)
    runtime_payload.pop("targetText", None)
    if candidate_payload != runtime_payload:
        raise CaptureRuntimeProtocolError(
            "Capture review changed runtime source or document provenance"
        )


def _idempotency_key(operation_id: str, stage: str) -> UUID:
    return uuid5(_IDEMPOTENCY_NAMESPACE, f"{operation_id}:{stage}")


__all__ = [
    "CaptureRunResult",
    "CaptureRuntimeCanceledError",
    "CaptureRuntimeJobError",
    "CaptureRuntimeRequirementUnavailableError",
    "CaptureRuntimeStateUnknownError",
    "CaptureRuntimeTimeoutError",
    "CertPrepCaptureCoordinator",
    "PDF_OCR_UNAVAILABLE_MESSAGE",
]
