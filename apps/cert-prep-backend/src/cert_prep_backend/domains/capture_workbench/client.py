"""Thin Cert Prep adapter over the published Capture Runtime v2 SDK.

The SDK owns discovery, hash negotiation, transport, retries, SSE parsing, and
wire decoding.  This module retains only Cert Prep's product-facing upload
shape and small collection wrappers used by the backend domain.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO
from uuid import UUID

import httpx

from capture_runtime_client import (
    CaptureDocument,
    CaptureEvent,
    CaptureOperation,
    CaptureRuntimeClient as SdkCaptureRuntimeClient,
    CaptureRuntimeCompatibilityError,
    CaptureRuntimeError,
    CaptureRuntimeProtocolError,
    CaptureSourceKind,
    CaptureStreamingResult,
    CaptureUpload as SdkCaptureUpload,
    HttpRuntimeTransport,
    PartialCapture,
    OpenStructuringSession,
    RawCapture,
    RuntimeInstallation,
    RuntimeInstallations,
    RuntimeReady,
    RuntimeRequirements,
    RuntimeStreamingCapabilities,
    StructuringBatch,
    StructuringSession,
    StructuringMode,
    SubmitStructuringBatch,
)


@dataclass(frozen=True, slots=True)
class CaptureUpload:
    """Cert Prep upload input; durable file ownership stays with the host."""

    file_name: str
    content: bytes | BinaryIO
    media_type: str = "application/octet-stream"


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

        return self._sdk.discover().ready

    def get_streaming_capabilities(self) -> RuntimeStreamingCapabilities:
        discovery = self._sdk.discover()
        if discovery.streaming is None:
            raise CaptureRuntimeCompatibilityError(
                "Capture Runtime does not advertise streaming capabilities."
            )
        return discovery.streaming

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

    def list_installations(self) -> RuntimeInstallations:
        return RuntimeInstallations(items=self._sdk.list_installations())

    def get_installation(self, installation_id: str) -> RuntimeInstallation:
        return self._sdk.get_installation(installation_id)

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
        return self._sdk.start_capture(
            SdkCaptureUpload(
                file_name=file_name,
                content=content,
                source_kind=CaptureSourceKind(source_kind),
                media_type=media_type,
                structuring_mode=StructuringMode.HOST,
                target_language=target_language,
            ),
            client_request_id=client_request_id,
        )

    def upload_path(
        self,
        path: Path,
        *,
        source_kind: CaptureSourceKind | str,
        client_request_id: str,
        media_type: str = "application/octet-stream",
        target_language: str | None = None,
    ) -> CaptureOperation:
        return self.start_capture(
            CaptureUpload(path.name, path.read_bytes(), media_type),
            source_kind=source_kind,
            client_request_id=client_request_id,
            target_language=target_language,
        )

    def get_capture(self, capture_id: str) -> CaptureOperation:
        return self._sdk.get_capture(capture_id)

    def capture_events(
        self,
        capture_id: str,
        *,
        last_event_id: str | int | None = None,
        on_activity: Callable[[], None] | None = None,
    ) -> Iterator[CaptureEvent]:
        return self._sdk.capture_events(
            capture_id,
            last_event_id=last_event_id,
            max_reconnects=0,
            on_activity=on_activity,
        )

    def get_partial(self, capture_id: str) -> PartialCapture:
        return self._sdk.get_partial(capture_id)

    def get_raw(self, capture_id: str) -> RawCapture:
        return self._sdk.get_raw(capture_id)

    def get_result(self, capture_id: str) -> CaptureStreamingResult:
        return self._sdk.get_result(capture_id)

    def open_structuring_session(
        self,
        capture_id: str,
        request: OpenStructuringSession | Mapping[str, object],
        *,
        idempotency_key: UUID | str | None = None,
    ) -> StructuringSession:
        """Open or replay an authenticated typed pull-structuring session."""

        return self._sdk.open_structuring_session(
            capture_id,
            request,
            idempotency_key=idempotency_key,
        )

    def get_structuring_session(self, capture_id: str) -> StructuringSession:
        return self._sdk.get_structuring_session(capture_id)

    def pull_structuring_batch(self, capture_id: str, batch_index: int) -> StructuringBatch:
        return self._sdk.pull_structuring_batch(capture_id, batch_index)

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

    def commit_structure(
        self,
        capture_id: str,
        candidate: str | bytes | Mapping[str, object] | CaptureDocument,
        *,
        idempotency_key: UUID | str,
    ) -> CaptureOperation:
        return self._sdk.commit_structure(
            capture_id,
            candidate,
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


__all__ = [
    "CaptureRuntimeClient",
    "CaptureRuntimeCompatibilityError",
    "CaptureRuntimeError",
    "CaptureRuntimeProtocolError",
    "CaptureStreamingResult",
    "CaptureUpload",
]
