"""Capture Runtime calls the review use cases need, without the SDK types leaving this module."""

from __future__ import annotations

from cert_prep_backend.capture_integration.application.errors import CaptureRuntimeCallFailed
from cert_prep_backend.capture_integration.application.results import (
    RuntimeCancellation,
    StructuringFailureNotice,
)
from cert_prep_backend.capture_integration.infrastructure.client import CaptureRuntimeError
from cert_prep_backend.capture_integration.infrastructure.coordinator import (
    CertPrepCaptureCoordinator,
)


class CoordinatorCaptureRuntime:
    """The configured coordinator as the capture review runtime port."""

    def __init__(self, coordinator: CertPrepCaptureCoordinator) -> None:
        self._coordinator = coordinator

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
