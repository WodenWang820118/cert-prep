"""Thin Cert Prep adapter over the published Capture Runtime v2 SDK.

The SDK owns discovery, hash negotiation, transport, retries, SSE parsing, and
wire decoding.  This module retains only Cert Prep's product-facing upload
shape and small collection wrappers used by the backend domain.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator, Mapping
from dataclasses import dataclass
import hashlib
import json
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
    RawCapture,
    RuntimeInstallation,
    RuntimeInstallations,
    RuntimeReady,
    RuntimeRequirements,
    RuntimeStreamingCapabilities,
    StructuringMode,
)


@dataclass(frozen=True, slots=True)
class CaptureUpload:
    """Cert Prep upload input; durable file ownership stays with the host."""

    file_name: str
    content: bytes | BinaryIO
    media_type: str = "application/octet-stream"


@dataclass(frozen=True, slots=True)
class CaptureStreamingResult:
    operation: CaptureOperationV2
    raw: RawCaptureV1
    result: CaptureDocumentV1


class _PreserveIngestionError(Exception):
    """The capture create outcome is unknown, so its ingestion must be retained."""

    def __init__(self, original: Exception) -> None:
        self.original = original


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

    def _capture_operation_response(
        self,
        response: httpx.Response,
        *,
        expected_capture_id: str,
    ) -> CaptureOperationV2:
        operation = self._model_response(response, CaptureOperationV2)
        if operation.capture_id != expected_capture_id:
            raise CaptureRuntimeProtocolError(
                "Capture Runtime operation response has an invalid capture identity"
            )
        return operation


@dataclass(frozen=True, slots=True)
class _SseFrame:
    event_id: str
    event_name: str
    data: str


class _SseParser:
    def __init__(self) -> None:
        self._line = bytearray()
        self._block: list[str] = []
        self._block_bytes = 0
        self._pending_carriage_return = False

    def push(self, chunk: bytes) -> tuple[_SseFrame, ...]:
        frames: list[_SseFrame] = []
        for byte in chunk:
            if self._pending_carriage_return:
                self._pending_carriage_return = False
                self._emit_line(frames)
                if byte == 0x0A:
                    continue
            if byte == 0x0D:
                self._pending_carriage_return = True
            elif byte == 0x0A:
                self._emit_line(frames)
            else:
                self._line.append(byte)
                if len(self._line) > _MAX_SSE_LINE_BYTES:
                    raise _invalid_event_stream()
        return tuple(frames)

    def finish(self) -> None:
        if self._pending_carriage_return:
            self._pending_carriage_return = False
            frames: list[_SseFrame] = []
            self._emit_line(frames)
            if frames:
                raise _invalid_event_stream()
        if self._line or self._block:
            raise _invalid_event_stream()

    def _emit_line(self, frames: list[_SseFrame]) -> None:
        try:
            line = bytes(self._line).decode("utf-8", errors="strict")
        except UnicodeDecodeError as error:
            raise _invalid_event_stream() from error
        self._line.clear()
        if not line:
            if self._block:
                frame = _parse_sse_block(self._block)
                if frame is not None:
                    frames.append(frame)
                self._block.clear()
                self._block_bytes = 0
            return
        if len(self._block) >= _MAX_SSE_FRAME_LINES:
            raise _invalid_event_stream()
        self._block.append(line)
        self._block_bytes += len(line.encode("utf-8"))
        if self._block_bytes > _MAX_SSE_FRAME_BYTES:
            raise _invalid_event_stream()


def _parse_sse_block(lines: list[str]) -> _SseFrame | None:
    event_id: str | None = None
    event_name: str | None = None
    data: list[str] = []
    data_bytes = 0
    for raw_line in lines:
        if raw_line.startswith(":"):
            continue
        field, separator, value = raw_line.partition(":")
        if separator and value.startswith(" "):
            value = value[1:]
        if field == "id":
            event_id = value
        elif field == "event":
            event_name = value
        elif field == "data":
            data.append(value)
            data_bytes += len(value.encode("utf-8"))
            if data_bytes > _MAX_SSE_PAYLOAD_BYTES:
                raise _invalid_event_stream()
    if not data:
        # SSE comments, retry hints, and metadata-only blocks are transport
        # activity but do not dispatch an event.
        return None
    if (
        event_id is None
        or not event_id
        or "\x00" in event_id
        or event_name is None
        or not event_name
    ):
        raise _invalid_event_stream()
    return _SseFrame(event_id=event_id, event_name=event_name, data="\n".join(data))


def _decode_event_frame(
    frame: _SseFrame,
    *,
    expected_capture_id: str,
) -> CaptureEventV2:
    try:
        event = CaptureEventV2.model_validate_json(frame.data)
    except (ValidationError, ValueError) as error:
        raise _invalid_event_stream() from error
    if (
        event.capture_id != expected_capture_id
        or event.event_id != f"{expected_capture_id}/{event.sequence}"
        or frame.event_id != str(event.sequence)
        or frame.event_name != event.event_type.value
    ):
        raise _invalid_event_stream()
    return event


def _invalid_event_stream() -> CaptureRuntimeProtocolError:
    return CaptureRuntimeProtocolError("Capture Runtime sent an invalid SSE event stream")


def _event_cursor(value: str | int | None) -> int | None:
    if value is None:
        return None
    text = str(value)
    if not re.fullmatch(r"-?\d+", text):
        raise CaptureRuntimeProtocolError("Capture Runtime event cursor is invalid")
    cursor = int(text)
    if cursor < -1:
        raise CaptureRuntimeProtocolError("Capture Runtime event cursor is invalid")
    return cursor


def _recoverable_create_error(error: Exception) -> bool:
    return (
        isinstance(error, (httpx.TransportError, CaptureRuntimeProtocolError))
        or isinstance(error, CaptureRuntimeError)
        and error.status_code >= 500
    )


def _upload_bytes(content: bytes | BinaryIO) -> bytes:
    if isinstance(content, bytes):
        return content
    value = content.read()
    if not isinstance(value, bytes):
        raise TypeError("Capture upload stream must return bytes")
    return value


def _validated_client_request_id(value: str) -> str:
    request_id = value.strip()
    if (
        not request_id
        or len(request_id) > 128
        or request_id in {".", ".."}
        or any(ord(character) < 0x20 or ord(character) == 0x7F for character in request_id)
        or any(character in "/\\?#" for character in request_id)
    ):
        raise ValueError("Capture client request id is invalid")
    return request_id


def _validated_runtime_id(value: str, *, label: str) -> str:
    if _RUNTIME_ID.fullmatch(value) is None:
        raise CaptureRuntimeProtocolError(f"Capture Runtime returned an invalid {label} id")
    return value


def _assert_empty_delete(response: httpx.Response) -> None:
    if response.status_code != 204 or response.content:
        raise CaptureRuntimeProtocolError(
            "Capture Runtime delete response must be an empty HTTP 204"
        )


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
