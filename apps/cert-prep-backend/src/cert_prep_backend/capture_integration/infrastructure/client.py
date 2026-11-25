"""Thin Cert Prep adapter over the published Capture Runtime v2 SDK.

The SDK owns discovery, hash negotiation, transport, retries, SSE parsing, and
wire decoding.  This module retains only Cert Prep's product-facing upload
shape and small collection wrappers used by the backend domain.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator, Mapping
from dataclasses import dataclass
from threading import Lock
from typing import BinaryIO
from uuid import UUID

import httpx

from capture_runtime_client import (
    CaptureEvent,
    CaptureOperation,
    CaptureRuntimeClient as SdkCaptureRuntimeClient,
    CaptureRuntimeCompatibilityError,
    CaptureRuntimeError,
    CaptureRuntimeProtocolError,
    CaptureSourceKind,
    CaptureResult,
    CaptureUpload as SdkCaptureUpload,
    HttpRuntimeTransport,
    PartialCapture,
    OpenStructuringSession,
    RawCapture,
    RuntimeInstallation,
    RuntimeInstallations,
    RuntimeRequirements,
    StructuringBatch,
    StructuringSession,
    StructuringMode,
    SubmitStructuringBatch,
)
from cert_prep_backend.capture_integration.infrastructure.host_models import RuntimeReady


_TERMINAL_INSTALLATION_STATUSES = frozenset(
    {"completed", "failed", "cancelled", "manual_action_required"}
)


@dataclass(frozen=True, slots=True)
class CaptureUpload:
    """Cert Prep upload input; durable file ownership stays with the host."""

    file_name: str
    content: bytes | BinaryIO
    media_type: str = "application/octet-stream"
    pdf_page_numbers: tuple[int, ...] | None = None
    # Audio only: the language spoken in the recording; None keeps Capture's Chinese default.
    spoken_language: str | None = None


class CaptureRuntimeClient:
    """Backend-only product adapter; all protocol behavior belongs to the SDK."""

    def __init__(
        self,
        *,
        base_url: str,
        bearer_token: str,
        timeout_seconds: float = 30,
        client: httpx.Client | None = None,
    ) -> None:
        transport = HttpRuntimeTransport(
            base_url=base_url,
            bearer_token=bearer_token,
            timeout_seconds=timeout_seconds,
            client=client,
        )
        self._sdk = SdkCaptureRuntimeClient(
            transport=transport,
            timeout_seconds=timeout_seconds,
        )
        # The candidate discovery guard is instance-scoped and rejects
        # overlapping negotiations. Keep the SDK's discovery state machine
        # single-flight when concurrent host requests negotiate readiness.
        self._discovery_lock = Lock()

    def __repr__(self) -> str:
        return f"{type(self).__name__}(sdk={type(self._sdk).__name__})"

    def close(self) -> None:
        self._sdk.close()

    def __enter__(self) -> CaptureRuntimeClient:
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()

    def handshake(self) -> RuntimeReady:
        """Negotiate the exact allowlisted contract before returning readiness."""

        with self._discovery_lock:
            ready = self._sdk.discover().ready
        return ready

    def get_requirements(self) -> RuntimeRequirements:
        return self._sdk.get_requirements()

    def start_installation(
        self,
        requirement_id: str,
        *,
        idempotency_key: UUID | str,
    ) -> RuntimeInstallation:
        return self._sdk.start_installation(
            requirement_id,
            idempotency_key=idempotency_key,
        )

    def invalidate_discovery_cache(self) -> None:
        """Drop the cached discovery so the next handshake reads the runtime again."""

        with self._discovery_lock:
            _invalidate_sdk_discovery_cache(self._sdk)

    def list_installations(self) -> RuntimeInstallations:
        installations = RuntimeInstallations(items=self._sdk.list_installations())
        if any(
            _installation_status_value(installation) in _TERMINAL_INSTALLATION_STATUSES
            for installation in installations.items
        ):
            self.invalidate_discovery_cache()
        return installations

    def get_installation(self, installation_id: str) -> RuntimeInstallation:
        installation = self._sdk.get_installation(installation_id)
        if _installation_status_value(installation) in _TERMINAL_INSTALLATION_STATUSES:
            # The candidate SDK caches the first discovery result. A cold
            # runtime reports no OCR compute before text-recognition is installed,
            # so the installation poll must invalidate that result before the
            # UI's post-install readiness check negotiates again.
            with self._discovery_lock:
                _invalidate_sdk_discovery_cache(self._sdk)
        return installation

    def cancel_installation(self, installation_id: str) -> RuntimeInstallation:
        return self._sdk.cancel_installation(installation_id)

    def start_capture(
        self,
        upload: CaptureUpload,
        *,
        source_kind: CaptureSourceKind | str,
        client_request_id: str,
        target_language: str | None = None,
    ) -> CaptureOperation:
        content = _upload_bytes(upload.content)
        if not content:
            raise ValueError("Capture upload must not be empty")
        file_name = upload.file_name.strip()
        if not file_name or len(file_name) > 255:
            raise ValueError("Capture upload filename must contain 1 to 255 characters")
        media_type = upload.media_type.strip()
        if not media_type:
            raise ValueError("Capture upload media type must not be empty")
        kind = CaptureSourceKind(source_kind)
        if upload.pdf_page_numbers is not None:
            _assert_pdf_page_scope(kind, upload.pdf_page_numbers)
        sdk_upload = SdkCaptureUpload(
            file_name=file_name,
            content=content,
            source_kind=kind,
            media_type=media_type,
            structuring_mode=StructuringMode.HOST,
            target_language=target_language,
            spoken_language=upload.spoken_language,
            pdf_page_numbers=upload.pdf_page_numbers,
        )
        return self._sdk.start_capture(
            sdk_upload,
            client_request_id=client_request_id,
        )

    def get_capture(self, capture_id: str) -> CaptureOperation:
        return self._sdk.get_capture(capture_id)

    def capture_events(
        self,
        capture_id: str,
        *,
        last_event_id: str | int | None = None,
        max_reconnects: int | None = None,
        on_activity: Callable[[], None] | None = None,
    ) -> Iterator[CaptureEvent]:
        return self._sdk.capture_events(
            capture_id,
            last_event_id=last_event_id,
            max_reconnects=2 if max_reconnects is None else max_reconnects,
            on_activity=on_activity,
        )

    def get_partial(self, capture_id: str) -> PartialCapture:
        return self._sdk.get_partial(capture_id)

    def get_raw(self, capture_id: str) -> RawCapture:
        return self._sdk.get_raw(capture_id)

    def get_ocr(self, capture_id: str) -> object:
        """Return the runtime-owned OCR page projection."""

        return self._sdk.get_ocr(capture_id)

    def get_result(self, capture_id: str) -> CaptureResult:
        return self._sdk.get_result(capture_id)

    def open_structuring_session(
        self,
        capture_id: str,
        request: OpenStructuringSession | Mapping[str, object],
        *,
        idempotency_key: UUID | str,
    ) -> StructuringSession:
        """Open or replay an authenticated typed pull-structuring session."""

        return self._sdk.open_structuring_session(
            capture_id,
            request,
            idempotency_key=idempotency_key,
        )

    def get_structuring_session(self, capture_id: str) -> StructuringSession:
        return self._sdk.get_structuring_session(capture_id)

    def get_structuring_batch(self, capture_id: str, batch_index: int) -> StructuringBatch:
        return self._sdk.get_structuring_batch(capture_id, batch_index)

    def submit_structuring_batch(
        self,
        capture_id: str,
        batch_index: int,
        submission: SubmitStructuringBatch | Mapping[str, object],
        *,
        idempotency_key: UUID | str,
    ) -> StructuringSession:
        return self._sdk.submit_structuring_batch(
            capture_id,
            batch_index,
            submission,
            idempotency_key=idempotency_key,
        )

    def report_structuring_failure(
        self,
        capture_id: str,
        *,
        code: str,
        message: str,
        idempotency_key: UUID | str,
    ) -> CaptureOperation:
        return self._sdk.report_structuring_failure(
            capture_id,
            code=code,
            message=message,
            idempotency_key=idempotency_key,
        )

    def cancel_capture(self, capture_id: str) -> CaptureOperation:
        return self._sdk.cancel_capture(capture_id)

    def delete_capture(self, capture_id: str) -> None:
        self._sdk.delete_capture(capture_id)


def _upload_bytes(content: bytes | BinaryIO) -> bytes:
    if isinstance(content, bytes):
        return content
    value = content.read()
    if not isinstance(value, bytes):
        raise TypeError("Capture upload stream must return bytes")
    return value


def _assert_pdf_page_scope(
    source_kind: CaptureSourceKind,
    page_numbers: tuple[int, ...],
) -> None:
    if source_kind is not CaptureSourceKind.PDF:
        raise ValueError("PDF page scope is only valid for PDF captures.")
    if (
        not page_numbers
        or len(page_numbers) > 500
        or any(isinstance(page, bool) or not isinstance(page, int) for page in page_numbers)
        or page_numbers != tuple(range(1, len(page_numbers) + 1))
    ):
        raise ValueError("PDF page numbers must be a non-empty ordered prefix from page one.")


__all__ = [
    "CaptureRuntimeClient",
    "CaptureRuntimeCompatibilityError",
    "CaptureRuntimeError",
    "CaptureRuntimeProtocolError",
    "CaptureResult",
    "CaptureUpload",
]


def _installation_status_value(installation: RuntimeInstallation) -> object:
    status = getattr(installation, "status", None)
    return getattr(status, "value", status)


def _invalidate_sdk_discovery_cache(sdk: object) -> None:
    """Refresh the SDK's cached discovery after runtime state changes.

    The candidate exposes this state privately and has no public refresh
    operation. Keep the compatibility seam narrow and a no-op for the pinned
    rollback client if it does not carry the cache attribute.
    """

    if hasattr(sdk, "_discovery"):
        setattr(sdk, "_discovery", None)
