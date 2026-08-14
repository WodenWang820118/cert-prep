"""Synchronous backend-only client for the local Capture Runtime sidecar."""

from __future__ import annotations

from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
import re
from typing import Any, BinaryIO, TypeVar
from urllib.parse import quote, urlsplit
from uuid import UUID, uuid5

import httpx
from pydantic import BaseModel, ValidationError

from capture_contracts import (
    CAPTURE_DOCUMENT_SCHEMA_VERSION,
    CaptureDocumentV1,
    CaptureEventV2,
    CaptureOperationV2,
    CaptureRequirementId,
    CaptureSourceKind,
    ErrorEnvelopeV1,
    IngestionV2,
    PartialCaptureV2,
    RawCaptureV1,
    RuntimeInstallationV1,
    RuntimeInstallationsV1,
    RuntimeRequirementsV1,
    RuntimeStreamingCapabilitiesV2,
    StreamingEventType,
    StreamingIngestionStatus,
    StructuringMode,
)
from cert_prep_backend.domains.capture_workbench.host_models import RuntimeReadyV1
from cert_prep_backend.domains.capture_workbench.runtime_policy import (
    SUPPORTED_API_MAJOR,
    SUPPORTED_RUNTIME_MAJOR,
    SUPPORTED_RUNTIME_MINOR,
)


_VERSION = re.compile(
    r"^(?P<major>0|[1-9][0-9]*)\.(?P<minor>0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*))?(?:[-+].*)?$"
)
_RUNTIME_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_BEARER_VALUE = re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]+")
_IDEMPOTENCY_NAMESPACE = UUID("f96a7f52-9d59-4930-806a-07c7db80bcfa")
_CLIENT_CHUNK_BYTES = 1024 * 1024
_MAX_SSE_LINE_BYTES = 64 * 1024
_MAX_SSE_FRAME_LINES = 1024
_MAX_SSE_FRAME_BYTES = 8 * 1024 * 1024
_MAX_SSE_PAYLOAD_BYTES = 8 * 1024 * 1024
_TERMINAL_EVENT_TYPES = {
    StreamingEventType.COMPLETED,
    StreamingEventType.FAILED,
    StreamingEventType.CANCELLED,
}
_ModelT = TypeVar("_ModelT", bound=BaseModel)


class CaptureRuntimeError(RuntimeError):
    """Machine-readable sidecar error without credentials in its representation."""

    def __init__(
        self,
        *,
        status_code: int,
        code: str,
        message: str,
        details: dict[str, object] | None = None,
    ) -> None:
        super().__init__(f"Capture Runtime request failed ({code}): {message}")
        self.status_code = status_code
        self.code = code
        self.runtime_message = message
        self.details = details


class CaptureRuntimeProtocolError(RuntimeError):
    """The sidecar returned a response outside the pinned wire contract."""


class CaptureRuntimeCompatibilityError(RuntimeError):
    """The sidecar is healthy but incompatible with this host client."""


@dataclass(frozen=True, slots=True)
class CaptureUpload:
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
    """Keep the process-scoped sidecar credential inside the Cert Prep backend."""

    def __init__(
        self,
        *,
        base_url: str,
        bearer_token: str,
        timeout_seconds: float = 30,
        client: httpx.Client | None = None,
    ) -> None:
        self._base_url = _validated_loopback_base_url(base_url)
        if not bearer_token.strip():
            raise ValueError("Capture Runtime bearer token must not be empty")
        self._bearer_token = bearer_token
        self._client = client or httpx.Client(
            timeout=timeout_seconds,
            follow_redirects=False,
        )
        self._owns_client = client is None

    def __repr__(self) -> str:
        return f"{type(self).__name__}(base_url={self._base_url!r})"

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def __enter__(self) -> CaptureRuntimeClient:
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()

    def handshake(self) -> RuntimeReadyV1:
        ready = self._model_response(
            self._request("GET", "/v1/health/ready"),
            RuntimeReadyV1,
        )
        _assert_compatible(ready)
        return ready

    def get_streaming_capabilities(self) -> RuntimeStreamingCapabilitiesV2:
        return self._model_response(
            self._request("GET", "/v2/health/ready"),
            RuntimeStreamingCapabilitiesV2,
        )

    def get_requirements(self) -> RuntimeRequirementsV1:
        return self._model_response(
            self._request("GET", "/v1/runtime/requirements"),
            RuntimeRequirementsV1,
        )

    def start_installation(
        self,
        requirement_id: CaptureRequirementId,
        *,
        idempotency_key: UUID,
    ) -> RuntimeInstallationV1:
        return self._model_response(
            self._request(
                "POST",
                "/v1/runtime/installations",
                headers={"X-Idempotency-Key": str(idempotency_key)},
                json={"requirementId": requirement_id, "consent": True},
            ),
            RuntimeInstallationV1,
        )

    def list_installations(self) -> RuntimeInstallationsV1:
        return self._model_response(
            self._request("GET", "/v1/runtime/installations"),
            RuntimeInstallationsV1,
        )

    def get_installation(self, installation_id: str) -> RuntimeInstallationV1:
        runtime_id = _validated_runtime_id(installation_id, label="installation")
        return self._model_response(
            self._request("GET", f"/v1/runtime/installations/{runtime_id}"),
            RuntimeInstallationV1,
        )

    def cancel_installation(self, installation_id: str) -> RuntimeInstallationV1:
        runtime_id = _validated_runtime_id(installation_id, label="installation")
        return self._model_response(
            self._request("POST", f"/v1/runtime/installations/{runtime_id}/cancel"),
            RuntimeInstallationV1,
        )

    def start_capture(
        self,
        upload: CaptureUpload,
        *,
        source_kind: CaptureSourceKind | str,
        client_request_id: str,
        target_language: str | None = None,
    ) -> CaptureOperationV2:
        """Open, upload, finalize, and start one v2 capture operation."""

        request_id = _validated_client_request_id(client_request_id)
        kind = CaptureSourceKind(source_kind)
        content = _upload_bytes(upload.content)
        if not content:
            raise ValueError("Capture upload must not be empty")
        file_name = upload.file_name.strip()
        media_type = upload.media_type.strip()
        if not file_name or len(file_name) > 255:
            raise ValueError("Capture upload filename must contain 1 to 255 characters")
        if not media_type:
            raise ValueError("Capture upload media type must not be empty")
        source_sha256 = hashlib.sha256(content).hexdigest()
        capabilities = self.get_streaming_capabilities()
        if kind not in capabilities.capture_kinds:
            raise CaptureRuntimeCompatibilityError(
                f"Capture Runtime streaming does not support {kind.value.upper()} capture."
            )
        chunk_bytes = min(_CLIENT_CHUNK_BYTES, capabilities.max_chunk_bytes)
        ingestion = self._open_ingestion(
            client_request_id=request_id,
            source_kind=kind,
            file_name=file_name,
            media_type=media_type,
            content_length=len(content),
            source_sha256=source_sha256,
        )
        self._assert_ingestion_identity(
            ingestion,
            source_kind=kind,
            file_name=file_name,
            media_type=media_type,
            content_length=len(content),
            source_sha256=source_sha256,
        )
        try:
            if ingestion.status is StreamingIngestionStatus.OPEN:
                ingestion = self._upload_chunks(
                    ingestion,
                    content,
                    chunk_bytes=chunk_bytes,
                    client_request_id=request_id,
                )
                ingestion = self._finalize_ingestion(
                    ingestion,
                    content_length=len(content),
                    source_sha256=source_sha256,
                )
            if ingestion.status is not StreamingIngestionStatus.READY:
                raise CaptureRuntimeProtocolError(
                    "Capture Runtime ingestion did not reach the ready state"
                )
            operation = self._start_capture_with_recovery(
                ingestion,
                client_request_id=request_id,
                source_kind=kind,
                target_language=target_language,
            )
        except _PreserveIngestionError as error:
            raise error.original from error
        except Exception:
            self._delete_ingestion_best_effort(ingestion.ingestion_id)
            raise
        self._assert_capture_identity(
            operation,
            ingestion=ingestion,
            source_kind=kind,
            source_sha256=source_sha256,
            file_name=file_name,
            media_type=media_type,
            content_length=len(content),
        )
        return operation

    def upload_path(
        self,
        path: Path,
        *,
        source_kind: CaptureSourceKind | str,
        client_request_id: str,
        media_type: str = "application/octet-stream",
        target_language: str | None = None,
    ) -> CaptureOperationV2:
        with path.open("rb") as stream:
            return self.start_capture(
                CaptureUpload(path.name, stream, media_type),
                source_kind=source_kind,
                client_request_id=client_request_id,
                target_language=target_language,
            )

    def get_capture(self, capture_id: str) -> CaptureOperationV2:
        runtime_id = _validated_runtime_id(capture_id, label="capture")
        return self._capture_operation_response(
            self._request("GET", f"/v2/captures/{runtime_id}"),
            expected_capture_id=runtime_id,
        )

    def capture_events(
        self,
        capture_id: str,
        *,
        last_event_id: str | int | None = None,
        on_activity: Callable[[], None] | None = None,
    ) -> Iterator[CaptureEventV2]:
        runtime_id = _validated_runtime_id(capture_id, label="capture")
        cursor = _event_cursor(last_event_id)
        headers = {"Accept": "text/event-stream"}
        if cursor is not None:
            headers["Last-Event-ID"] = str(cursor)
        with self._stream(
            "GET",
            f"/v2/captures/{runtime_id}/events",
            headers=headers,
        ) as response:
            content_type = response.headers.get("content-type", "").lower()
            if not content_type.startswith("text/event-stream"):
                raise _invalid_event_stream()
            parser = _SseParser()
            previous_sequence = cursor
            try:
                for chunk in response.iter_bytes():
                    if on_activity is not None:
                        on_activity()
                    for frame in parser.push(chunk):
                        event = _decode_event_frame(frame, expected_capture_id=runtime_id)
                        if previous_sequence is not None and event.sequence <= previous_sequence:
                            raise _invalid_event_stream()
                        previous_sequence = event.sequence
                        yield event
                        if event.event_type in _TERMINAL_EVENT_TYPES:
                            return
                parser.finish()
            except CaptureRuntimeProtocolError:
                raise
            except (UnicodeDecodeError, ValidationError, ValueError, json.JSONDecodeError) as error:
                raise _invalid_event_stream() from error

    def get_partial(self, capture_id: str) -> PartialCaptureV2:
        runtime_id = _validated_runtime_id(capture_id, label="capture")
        partial = self._model_response(
            self._request("GET", f"/v2/captures/{runtime_id}/partial"),
            PartialCaptureV2,
        )
        if partial.capture_id != runtime_id:
            raise CaptureRuntimeProtocolError(
                "Capture Runtime partial response has an invalid capture identity"
            )
        return partial

    def get_raw(self, capture_id: str) -> RawCaptureV1:
        partial = self.get_partial(capture_id)
        if partial.extraction_engine is None or not partial.segments:
            raise CaptureRuntimeProtocolError(
                "Capture Runtime partial response is not ready for host structuring"
            )
        return RawCaptureV1.model_validate(
            {
                "schemaVersion": CAPTURE_DOCUMENT_SCHEMA_VERSION,
                "diagnosticOnly": True,
                "source": partial.source.model_dump(mode="json", by_alias=True),
                "segments": [
                    segment.model_dump(mode="json", by_alias=True)
                    for segment in partial.segments
                ],
                "sourceText": partial.source_text,
                "extractionEngine": partial.extraction_engine.model_dump(
                    mode="json",
                    by_alias=True,
                ),
                "warnings": [],
                "createdAt": partial.updated_at,
            }
        )

    def get_result(self, capture_id: str) -> CaptureStreamingResult:
        runtime_id = _validated_runtime_id(capture_id, label="capture")
        response = self._request("GET", f"/v2/captures/{runtime_id}/result")
        try:
            payload = response.json()
            if not isinstance(payload, dict) or set(payload) != {"operation", "raw", "result"}:
                raise ValueError
            operation = CaptureOperationV2.model_validate(payload["operation"])
            raw = RawCaptureV1.model_validate(payload["raw"])
            result = CaptureDocumentV1.model_validate(payload["result"])
        except (ValidationError, ValueError, json.JSONDecodeError) as error:
            raise CaptureRuntimeProtocolError(
                "Capture Runtime returned an invalid streaming result"
            ) from error
        if operation.capture_id != runtime_id:
            raise CaptureRuntimeProtocolError(
                "Capture Runtime result response has an invalid capture identity"
            )
        if raw.source != result.source or (
            operation.source is not None and operation.source != raw.source
        ):
            raise CaptureRuntimeProtocolError(
                "Capture Runtime returned an invalid streaming result source identity"
            )
        return CaptureStreamingResult(operation=operation, raw=raw, result=result)

    def commit_structure(
        self,
        capture_id: str,
        candidate: str | bytes | Mapping[str, object],
        *,
        idempotency_key: UUID | str,
    ) -> CaptureOperationV2:
        runtime_id = _validated_runtime_id(capture_id, label="capture")
        headers = {
            "Content-Type": "application/json",
            "X-Idempotency-Key": str(idempotency_key),
        }
        if isinstance(candidate, Mapping):
            kwargs: dict[str, object] = {"json": dict(candidate)}
        else:
            kwargs = {
                "content": candidate.encode("utf-8")
                if isinstance(candidate, str)
                else candidate
            }
        return self._capture_operation_response(
            self._request(
                "POST",
                f"/v2/captures/{runtime_id}/structure/commit",
                headers=headers,
                **kwargs,
            ),
            expected_capture_id=runtime_id,
        )

    def report_structuring_failure(
        self,
        capture_id: str,
        *,
        code: str,
        message: str,
        idempotency_key: UUID | str,
    ) -> CaptureOperationV2:
        runtime_id = _validated_runtime_id(capture_id, label="capture")
        return self._capture_operation_response(
            self._request(
                "POST",
                f"/v2/captures/{runtime_id}/structure/failure",
                headers={"X-Idempotency-Key": str(idempotency_key)},
                json={"code": code, "message": message},
            ),
            expected_capture_id=runtime_id,
        )

    def cancel_capture(self, capture_id: str) -> CaptureOperationV2:
        runtime_id = _validated_runtime_id(capture_id, label="capture")
        return self._capture_operation_response(
            self._request("POST", f"/v2/captures/{runtime_id}/cancel"),
            expected_capture_id=runtime_id,
        )

    def delete_capture(self, capture_id: str) -> None:
        runtime_id = _validated_runtime_id(capture_id, label="capture")
        response = self._request("DELETE", f"/v2/captures/{runtime_id}")
        _assert_empty_delete(response)

    def _open_ingestion(
        self,
        *,
        client_request_id: str,
        source_kind: CaptureSourceKind,
        file_name: str,
        media_type: str,
        content_length: int,
        source_sha256: str,
    ) -> IngestionV2:
        request_body = {
            "protocolVersion": "2",
            "kind": source_kind.value,
            "mode": "file",
            "clientRequestId": client_request_id,
            "fileName": file_name,
            "mediaType": media_type,
            "totalBytes": content_length,
            "sourceSha256": source_sha256,
        }
        original: Exception | None = None
        try:
            return self._model_response(
                self._request("POST", "/v2/ingestions", json=request_body),
                IngestionV2,
            )
        except Exception as error:
            if not _recoverable_create_error(error):
                raise
            original = error
        try:
            recovered = self._model_response(
                self._request(
                    "GET",
                    "/v2/ingestions/by-client-request/"
                    f"{quote(client_request_id, safe='')}",
                ),
                IngestionV2,
            )
        except CaptureRuntimeError as lookup_error:
            if lookup_error.status_code == 404:
                raise original
            raise original from lookup_error
        except Exception as lookup_error:
            raise original from lookup_error
        return recovered

    def _upload_chunks(
        self,
        ingestion: IngestionV2,
        content: bytes,
        *,
        chunk_bytes: int,
        client_request_id: str,
    ) -> IngestionV2:
        if ingestion.next_offset > len(content):
            raise CaptureRuntimeProtocolError(
                "Capture Runtime ingestion resume offset exceeds the source"
            )
        expected_chunk = ingestion.next_offset // chunk_bytes
        if ingestion.next_offset % chunk_bytes != 0 or ingestion.next_chunk_index != expected_chunk:
            raise CaptureRuntimeProtocolError(
                "Capture Runtime ingestion resume checkpoint is not chunk aligned"
            )
        current = ingestion
        offset = current.next_offset
        chunk_index = current.next_chunk_index
        while offset < len(content):
            chunk = content[offset : offset + chunk_bytes]
            end = offset + len(chunk)
            headers = {
                "Content-Type": "application/octet-stream",
                "Content-Range": f"bytes {offset}-{end - 1}/{len(content)}",
                "Digest": f"sha-256={hashlib.sha256(chunk).hexdigest()}",
                "X-Idempotency-Key": str(
                    uuid5(
                        _IDEMPOTENCY_NAMESPACE,
                        f"{client_request_id}:chunk:{chunk_index}",
                    )
                ),
            }
            current = self._retry_model_request(
                "PUT",
                f"/v2/ingestions/{_validated_runtime_id(current.ingestion_id, label='ingestion')}"
                f"/chunks/{chunk_index}",
                IngestionV2,
                headers=headers,
                content=chunk,
            )
            if (
                current.ingestion_id != ingestion.ingestion_id
                or current.next_offset != end
                or current.next_chunk_index != chunk_index + 1
            ):
                raise CaptureRuntimeProtocolError(
                    "Capture Runtime returned an invalid ordered chunk checkpoint"
                )
            offset = end
            chunk_index += 1
        return current

    def _finalize_ingestion(
        self,
        ingestion: IngestionV2,
        *,
        content_length: int,
        source_sha256: str,
    ) -> IngestionV2:
        runtime_id = _validated_runtime_id(ingestion.ingestion_id, label="ingestion")
        finalized = self._retry_model_request(
            "POST",
            f"/v2/ingestions/{runtime_id}/finalize",
            IngestionV2,
            json={
                "protocolVersion": "2",
                "totalBytes": content_length,
                "sha256": source_sha256,
            },
        )
        if (
            finalized.ingestion_id != ingestion.ingestion_id
            or finalized.status is not StreamingIngestionStatus.READY
            or finalized.received_bytes != content_length
            or finalized.finalized_sha256 != source_sha256
        ):
            raise CaptureRuntimeProtocolError(
                "Capture Runtime returned an invalid finalized ingestion"
            )
        return finalized

    def _start_capture_with_recovery(
        self,
        ingestion: IngestionV2,
        *,
        client_request_id: str,
        source_kind: CaptureSourceKind,
        target_language: str | None,
    ) -> CaptureOperationV2:
        request_body: dict[str, object] = {
            "protocolVersion": "2",
            "clientRequestId": client_request_id,
            "ingestionId": ingestion.ingestion_id,
            "structuringMode": StructuringMode.HOST.value,
            "startPolicy": "eager",
        }
        if target_language is not None:
            request_body["targetLanguage"] = target_language
        original: Exception | None = None
        try:
            return self._model_response(
                self._request("POST", "/v2/captures", json=request_body),
                CaptureOperationV2,
            )
        except Exception as error:
            if not _recoverable_create_error(error):
                raise
            original = error
        try:
            recovered = self._model_response(
                self._request(
                    "GET",
                    "/v2/captures/by-client-request/"
                    f"{quote(client_request_id, safe='')}",
                ),
                CaptureOperationV2,
            )
        except CaptureRuntimeError as lookup_error:
            if lookup_error.status_code == 404:
                raise original
            raise _PreserveIngestionError(original) from lookup_error
        except Exception as lookup_error:
            raise _PreserveIngestionError(original) from lookup_error
        if recovered.ingestion_id != ingestion.ingestion_id or recovered.kind is not source_kind:
            raise _PreserveIngestionError(
                CaptureRuntimeProtocolError(
                    "Capture Runtime recovery returned a mismatched capture operation"
                )
            )
        return recovered

    def _retry_model_request(
        self,
        method: str,
        path: str,
        model_type: type[_ModelT],
        **kwargs: object,
    ) -> _ModelT:
        for attempt in range(3):
            try:
                return self._model_response(
                    self._request(method, path, **kwargs),
                    model_type,
                )
            except httpx.TransportError:
                if attempt == 2:
                    raise
        raise AssertionError("unreachable")

    def _assert_ingestion_identity(
        self,
        ingestion: IngestionV2,
        *,
        source_kind: CaptureSourceKind,
        file_name: str,
        media_type: str,
        content_length: int,
        source_sha256: str,
    ) -> None:
        _validated_runtime_id(ingestion.ingestion_id, label="ingestion")
        if (
            ingestion.kind is not source_kind
            or ingestion.file_name != file_name
            or ingestion.media_type != media_type
            or ingestion.total_bytes != content_length
            or ingestion.source_sha256 != source_sha256
            or ingestion.status
            not in {StreamingIngestionStatus.OPEN, StreamingIngestionStatus.READY}
        ):
            raise CaptureRuntimeProtocolError(
                "Capture Runtime ingestion identity does not match the upload"
            )

    @staticmethod
    def _assert_capture_identity(
        operation: CaptureOperationV2,
        *,
        ingestion: IngestionV2,
        source_kind: CaptureSourceKind,
        source_sha256: str,
        file_name: str,
        media_type: str,
        content_length: int,
    ) -> None:
        _validated_runtime_id(operation.capture_id, label="capture")
        source = operation.source
        if (
            operation.ingestion_id != ingestion.ingestion_id
            or operation.kind is not source_kind
            or source is None
            or source.sha256 != source_sha256
            or source.file_name != file_name
            or source.media_type != media_type
            or source.bytes != content_length
        ):
            raise CaptureRuntimeProtocolError(
                "Capture Runtime operation identity does not match the ingestion"
            )

    def _delete_ingestion_best_effort(self, ingestion_id: str) -> None:
        try:
            response = self._request(
                "DELETE",
                f"/v2/ingestions/{_validated_runtime_id(ingestion_id, label='ingestion')}",
            )
            _assert_empty_delete(response)
        except Exception:
            pass

    def _request(self, method: str, path: str, **kwargs: object) -> httpx.Response:
        request_headers = {
            "Accept": "application/json",
            "Authorization": f"Bearer {self._bearer_token}",
            **dict(kwargs.pop("headers", {})),
        }
        response = self._client.request(
            method,
            f"{self._base_url}{path}",
            headers=request_headers,
            follow_redirects=False,
            **kwargs,
        )
        if response.is_error:
            raise _runtime_error(response, secret=self._bearer_token)
        return response

    @contextmanager
    def _stream(
        self,
        method: str,
        path: str,
        *,
        headers: Mapping[str, str],
    ) -> Iterator[httpx.Response]:
        request_headers = {
            "Authorization": f"Bearer {self._bearer_token}",
            **dict(headers),
        }
        with self._client.stream(
            method,
            f"{self._base_url}{path}",
            headers=request_headers,
            follow_redirects=False,
        ) as response:
            if response.is_error:
                response.read()
                raise _runtime_error(response, secret=self._bearer_token)
            yield response

    @staticmethod
    def _model_response(
        response: httpx.Response,
        model_type: type[_ModelT],
    ) -> _ModelT:
        try:
            return model_type.model_validate_json(response.content)
        except (ValidationError, ValueError) as error:
            raise CaptureRuntimeProtocolError(
                f"Capture Runtime returned invalid {model_type.__name__}"
            ) from error

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


def _validated_loopback_base_url(value: str) -> str:
    parsed = urlsplit(value)
    if (
        parsed.scheme != "http"
        or parsed.hostname != "127.0.0.1"
        or parsed.port is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or parsed.path not in {"", "/"}
    ):
        raise ValueError(
            "Capture Runtime URL must be an HTTP 127.0.0.1 authority with an explicit port"
        )
    return f"http://127.0.0.1:{parsed.port}"


def _runtime_error(response: httpx.Response, *, secret: str) -> CaptureRuntimeError:
    try:
        envelope = ErrorEnvelopeV1.model_validate_json(response.content)
    except (ValidationError, ValueError):
        return CaptureRuntimeError(
            status_code=response.status_code,
            code="invalid_error_response",
            message="Capture Runtime returned an invalid error envelope.",
        )
    message = _sanitized_text(envelope.error.message, secret=secret)
    details = _sanitized_value(envelope.error.details, secret=secret)
    return CaptureRuntimeError(
        status_code=response.status_code,
        code=envelope.error.code,
        message=message,
        details=details if isinstance(details, dict) else None,
    )


def _sanitized_text(value: str, *, secret: str) -> str:
    sanitized = value.replace(secret, "[redacted]") if secret else value
    sanitized = _BEARER_VALUE.sub("Bearer [redacted]", sanitized)
    return sanitized[:500]


def _sanitized_value(value: Any, *, secret: str) -> Any:
    if isinstance(value, str):
        return _sanitized_text(value, secret=secret)
    if isinstance(value, list):
        return [_sanitized_value(item, secret=secret) for item in value]
    if isinstance(value, dict):
        return {
            str(key)[:128]: _sanitized_value(item, secret=secret)
            for key, item in value.items()
        }
    if isinstance(value, (bool, int, float)) or value is None:
        return value
    return "[redacted]"


def _major(version: str, *, label: str) -> int:
    match = _VERSION.fullmatch(version)
    if match is None:
        raise CaptureRuntimeCompatibilityError(f"{label} version is not semantic: {version!r}")
    return int(match.group("major"))


def _minor(version: str, *, label: str) -> int:
    match = _VERSION.fullmatch(version)
    if match is None:
        raise CaptureRuntimeCompatibilityError(f"{label} version is not semantic: {version!r}")
    return int(match.group("minor"))


def _assert_compatible(ready: RuntimeReadyV1) -> None:
    failures: list[str] = []
    if not ready.ready:
        failures.append("runtime is not ready")
    if _major(ready.api_version, label="API") != SUPPORTED_API_MAJOR:
        failures.append(f"API major {ready.api_version} is unsupported")
    if _major(ready.runtime_version, label="runtime") != SUPPORTED_RUNTIME_MAJOR:
        failures.append(f"runtime major {ready.runtime_version} is unsupported")
    elif _minor(ready.runtime_version, label="runtime") != SUPPORTED_RUNTIME_MINOR:
        failures.append(
            f"runtime minor {ready.runtime_version} is incompatible with "
            f"0.{SUPPORTED_RUNTIME_MINOR}.x"
        )
    if ready.capture_document_schema_version != CAPTURE_DOCUMENT_SCHEMA_VERSION:
        failures.append(
            "CaptureDocument schema "
            f"{ready.capture_document_schema_version} is unsupported"
        )
    if StructuringMode.HOST not in ready.capabilities.structuring_modes:
        failures.append("host structuring mode is unavailable")
    if failures:
        raise CaptureRuntimeCompatibilityError("; ".join(failures))


__all__ = [
    "CaptureRuntimeClient",
    "CaptureRuntimeCompatibilityError",
    "CaptureRuntimeError",
    "CaptureRuntimeProtocolError",
    "CaptureStreamingResult",
    "CaptureUpload",
]
