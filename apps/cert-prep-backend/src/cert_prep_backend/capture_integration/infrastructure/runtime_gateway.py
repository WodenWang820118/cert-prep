"""Capture Runtime calls the review use cases need, without the SDK types leaving this module."""

from __future__ import annotations

from collections.abc import Callable
from typing import NoReturn

from capture_runtime_client import StreamingCaptureStatus

from cert_prep_backend.capture_integration.application.errors import (
    CaptureExtractionCanceled,
    CaptureOcrMissing,
    CaptureOcrTransport,
    CaptureOcrUnavailable,
    CaptureResultMissing,
    CaptureResultProtocolError,
    CaptureResultUnavailable,
    CaptureRuntimeCallFailed,
)
from cert_prep_backend.capture_integration.application.results import (
    RuntimeCancellation,
    StructuringFailureNotice,
)
from cert_prep_backend.capture_integration.infrastructure.client import (
    CaptureRuntimeClient,
    CaptureRuntimeError,
    CaptureRuntimeProtocolError,
)
from cert_prep_backend.capture_integration.infrastructure.coordinator import (
    CaptureRuntimeCanceledError,
    CertPrepCaptureCoordinator,
)
from cert_prep_backend.capture_integration.infrastructure.review import reviewed_text_overrides

# Identity (`is`) and membership (`in`) stay distinct. A string equal to a status value
# is a member of the enum set and is not the enum member.
_CAPTURE_STATUSES = {
    "created": StreamingCaptureStatus.CREATED,
    "waiting_input": StreamingCaptureStatus.WAITING_INPUT,
    "extracting": StreamingCaptureStatus.EXTRACTING,
    "awaiting_structuring": StreamingCaptureStatus.AWAITING_STRUCTURING,
    "structuring": StreamingCaptureStatus.STRUCTURING,
    "completed": StreamingCaptureStatus.COMPLETED,
    "failed": StreamingCaptureStatus.FAILED,
    "cancelled": StreamingCaptureStatus.CANCELLED,
}


class CoordinatorCaptureRuntime:
    """The configured coordinator as the capture review runtime port."""

    def __init__(
        self,
        coordinator: CertPrepCaptureCoordinator,
        client: CaptureRuntimeClient,
    ) -> None:
        self._coordinator = coordinator
        self._client = client

    def report_structuring_failure(
        self,
        runtime_capture_id: str,
        *,
        operation_id: str,
        code: str,
        message: str,
    ) -> StructuringFailureNotice:
        operation = self._coordinator.report_structuring_failure(
            runtime_capture_id,
            operation_id=operation_id,
            code=code,
            message=message,
        )
        return StructuringFailureNotice(
            terminal_sequence=operation.last_event_sequence,
            runtime_operation=operation,
        )

    def cancel(self, runtime_capture_id: str) -> RuntimeCancellation:
        operation = self._coordinator.cancel(runtime_capture_id)
        return RuntimeCancellation(
            terminal_sequence=operation.last_event_sequence,
            runtime_operation=operation,
        )

    def delete(self, runtime_capture_id: str) -> None:
        try:
            self._coordinator.delete(runtime_capture_id)
        except CaptureRuntimeError as error:
            if error.status_code != 404:
                raise CaptureRuntimeCallFailed(str(error)) from error
        except Exception:
            return

    def read_operation(self, runtime_capture_id: str) -> object:
        return self._coordinator.get_capture(runtime_capture_id)

    def read_partial(self, runtime_capture_id: str) -> object:
        return self._coordinator.get_partial(runtime_capture_id)

    def read_raw(self, runtime_capture_id: str) -> object:
        return self._coordinator.get_raw(runtime_capture_id)

    def read_operation_for_ocr(self, runtime_capture_id: str) -> object:
        try:
            return self._client.get_capture(runtime_capture_id)
        except Exception as error:
            _raise_ocr_failure(error)

    def read_ocr_projection(self, runtime_capture_id: str) -> object:
        try:
            return self._client.get_ocr(runtime_capture_id)
        except Exception as error:
            _raise_ocr_failure(error)

    def fetch_result(self, runtime_capture_id: str) -> object:
        try:
            return self._coordinator.get_result(runtime_capture_id)
        except CaptureRuntimeProtocolError as error:
            raise CaptureResultProtocolError(
                "Capture Runtime result violated the v2 contract."
            ) from error
        except CaptureRuntimeError as error:
            if getattr(error, "status_code", None) == 404:
                raise CaptureResultMissing("Capture Runtime result is gone.") from error
            raise CaptureResultUnavailable("Capture Runtime result unavailable.") from error
        except Exception as error:
            raise CaptureResultUnavailable("Capture Runtime result unavailable.") from error

    def release_result(self, runtime_capture_id: str) -> None:
        try:
            self._coordinator.delete(runtime_capture_id)
        except Exception:
            return

    def validate_review(self, raw: object, review: object) -> None:
        reviewed_text_overrides(raw, review)

    def structure(
        self,
        *,
        operation_id: str,
        capture_id: str,
        review: object,
        should_cancel: Callable[[], bool],
    ) -> object:
        try:
            return self._coordinator.structure_capture(
                operation_id=operation_id,
                capture_id=capture_id,
                target_language=None,
                review=review,
                should_cancel=should_cancel,
            )
        except CaptureRuntimeCanceledError as error:
            raise CaptureExtractionCanceled() from error

    def status_is(self, operation: object, token: str) -> bool:
        return operation.status is _CAPTURE_STATUSES[token]

    def status_equals(self, operation: object, *tokens: str) -> bool:
        return operation.status in {_CAPTURE_STATUSES[token] for token in tokens}


def _raise_ocr_failure(error: BaseException) -> NoReturn:
    """Classify an OCR read the way the route used to, transport before not-found."""

    if isinstance(error, CaptureRuntimeError):
        if getattr(error, "category", None) == "transport":
            raise CaptureOcrTransport("Capture Runtime is unavailable.") from error
        if (
            getattr(error, "status_code", None) == 404
            and getattr(error, "code", None) == "capture_not_found"
        ):
            raise CaptureOcrMissing("Capture not found.") from error
    raise CaptureOcrUnavailable(
        "Capture Runtime OCR summary is unavailable."
    ) from error
