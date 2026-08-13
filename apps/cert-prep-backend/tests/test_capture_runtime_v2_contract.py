from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
import hashlib
import json
from uuid import UUID

import httpx
import pytest

from capture_contracts import (
    CaptureEventV2,
    CaptureOperationV2,
    RuntimeRequirementsV1,
    StreamingCaptureStatus,
)
from cert_prep_backend.domains.capture_workbench.client import (
    CaptureRuntimeClient,
    CaptureRuntimeProtocolError,
    CaptureUpload,
)
from cert_prep_backend.domains.capture_workbench.coordinator import (
    CertPrepCaptureCoordinator,
)
from cert_prep_backend.domains.capture_workbench.host_models import RuntimeReadyV1


TOKEN = "capture-sidecar-process-token-that-stays-in-backend"
NOW = datetime(2026, 8, 13, 4, 0, tzinfo=UTC)
SOURCE = b"ordered-v2-capture"
SOURCE_SHA256 = hashlib.sha256(SOURCE).hexdigest()


def test_v2_capture_lifecycle_is_checksum_bounded_ordered_and_authenticated() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        assert request.headers["Authorization"] == f"Bearer {TOKEN}"
        assert TOKEN not in str(request.url)
        if request.method == "GET" and request.url.path == "/v2/health/ready":
            return _json_response(request, _streaming_capabilities(max_chunk_bytes=8))
        if request.method == "POST" and request.url.path == "/v2/ingestions":
            assert json.loads(request.content) == {
                "protocolVersion": "2",
                "kind": "pdf",
                "mode": "file",
                "clientRequestId": "request-1",
                "fileName": "sample.pdf",
                "mediaType": "application/pdf",
                "totalBytes": len(SOURCE),
                "sourceSha256": SOURCE_SHA256,
            }
            return _json_response(request, _ingestion(received=0, next_chunk=0), status=201)
        if request.method == "PUT" and request.url.path.startswith(
            "/v2/ingestions/ingestion-1/chunks/"
        ):
            chunk_index = int(request.url.path.rsplit("/", 1)[1])
            offset = chunk_index * 8
            chunk = SOURCE[offset : offset + 8]
            assert request.content == chunk
            assert request.headers["Content-Range"] == (
                f"bytes {offset}-{offset + len(chunk) - 1}/{len(SOURCE)}"
            )
            assert request.headers["Digest"] == (
                f"sha-256={hashlib.sha256(chunk).hexdigest()}"
            )
            assert request.headers["X-Idempotency-Key"]
            received = offset + len(chunk)
            return _json_response(
                request,
                _ingestion(received=received, next_chunk=chunk_index + 1),
            )
        if (
            request.method == "POST"
            and request.url.path == "/v2/ingestions/ingestion-1/finalize"
        ):
            assert json.loads(request.content) == {
                "protocolVersion": "2",
                "totalBytes": len(SOURCE),
                "sha256": SOURCE_SHA256,
            }
            return _json_response(
                request,
                _ingestion(
                    received=len(SOURCE),
                    next_chunk=3,
                    status="ready",
                    finalized_sha256=SOURCE_SHA256,
                ),
            )
        if request.method == "POST" and request.url.path == "/v2/captures":
            assert json.loads(request.content) == {
                "protocolVersion": "2",
                "clientRequestId": "request-1",
                "ingestionId": "ingestion-1",
                "structuringMode": "host",
                "startPolicy": "eager",
            }
            return _json_response(request, _operation(), status=202)
        raise AssertionError(f"Unexpected request: {request.method} {request.url.path}")

    client = _client(handler)

    operation = client.start_capture(
        CaptureUpload("sample.pdf", SOURCE, "application/pdf"),
        source_kind="pdf",
        client_request_id="request-1",
    )

    assert operation.capture_id == "capture-1"
    assert operation.status is StreamingCaptureStatus.EXTRACTING
    assert [request.method for request in requests] == [
        "GET",
        "POST",
        "PUT",
        "PUT",
        "PUT",
        "POST",
        "POST",
    ]


def test_v2_uncertain_open_and_capture_create_recover_by_client_request() -> None:
    opens = 0
    starts = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal opens, starts
        if request.url.path == "/v2/health/ready":
            return _json_response(request, _streaming_capabilities(max_chunk_bytes=64))
        if request.method == "POST" and request.url.path == "/v2/ingestions":
            opens += 1
            raise httpx.ReadError("open response lost", request=request)
        if request.url.path == "/v2/ingestions/by-client-request/request-recovery":
            return _json_response(request, _ingestion(received=0, next_chunk=0))
        if request.method == "PUT":
            return _json_response(
                request,
                _ingestion(received=len(SOURCE), next_chunk=1),
            )
        if request.url.path.endswith("/finalize"):
            return _json_response(
                request,
                _ingestion(
                    received=len(SOURCE),
                    next_chunk=1,
                    status="ready",
                    finalized_sha256=SOURCE_SHA256,
                ),
            )
        if request.method == "POST" and request.url.path == "/v2/captures":
            starts += 1
            raise httpx.ReadError("capture response lost", request=request)
        if request.url.path == "/v2/captures/by-client-request/request-recovery":
            return _json_response(request, _operation())
        raise AssertionError(f"Unexpected request: {request.method} {request.url.path}")

    operation = _client(handler).start_capture(
        CaptureUpload("sample.pdf", SOURCE, "application/pdf"),
        source_kind="pdf",
        client_request_id="request-recovery",
    )

    assert operation.capture_id == "capture-1"
    assert opens == 1
    assert starts == 1


def test_v2_sse_requires_auth_replays_after_cursor_and_closes_on_terminal() -> None:
    event = _event(sequence=5, event_type="completed", stage="completed")
    body = (
        ": runtime heartbeat\r\n"
        "id: 5\r\n"
        "event: completed\r\n"
        f"data: {json.dumps(event, separators=(',', ':'))}\r\n"
        "\r\n"
    ).encode()

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v2/captures/capture-1/events"
        assert request.headers["Accept"] == "text/event-stream"
        assert request.headers["Authorization"] == f"Bearer {TOKEN}"
        assert request.headers["Last-Event-ID"] == "4"
        return httpx.Response(
            200,
            headers={"Content-Type": "text/event-stream; charset=utf-8"},
            stream=_ChunkStream([body[:17], body[17:61], body[61:]]),
            request=request,
        )

    events = list(_client(handler).capture_events("capture-1", last_event_id=4))

    assert [(event.sequence, event.event_type.value) for event in events] == [
        (5, "completed")
    ]


def test_v2_sse_ignores_standalone_heartbeats_as_transport_activity() -> None:
    event = _event(sequence=1, event_type="checkpoint", stage="extracting")
    chunks = [
        b": keep-alive\n\n",
        b"id: ignored\nevent: heartbeat\nretry: 1000\n\n",
        (
            "id: 1\n"
            "event: checkpoint\n"
            f"data: {json.dumps(event, separators=(',', ':'))}\n\n"
        ).encode(),
    ]
    activity: list[None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"Content-Type": "text/event-stream"},
            stream=_ChunkStream(chunks),
            request=request,
        )

    events = list(
        _client(handler).capture_events(
            "capture-1",
            on_activity=lambda: activity.append(None),
        )
    )

    assert [(item.sequence, item.event_type.value) for item in events] == [
        (1, "checkpoint")
    ]
    assert len(activity) == len(chunks)


def test_coordinator_replays_sse_after_disconnect_without_polling_or_cancelling() -> None:
    runtime = _ReconnectingRuntimeClient()
    started: list[str] = []
    coordinator = CertPrepCaptureCoordinator(
        client=runtime,
        structurer=object(),
        reconciliation_interval_seconds=0.01,
        timeout_seconds=30,
    )

    operation = coordinator.begin_capture(
        operation_id="operation-1",
        file_name="sample.pdf",
        content=SOURCE,
        media_type="application/pdf",
        source_kind="pdf",
        target_language=None,
        should_cancel=lambda: False,
        on_started=lambda value: started.append(value.capture_id),
    )

    assert operation.status is StreamingCaptureStatus.AWAITING_STRUCTURING
    assert runtime.event_cursors == [0, 1]
    assert runtime.snapshot_calls == 2
    assert runtime.cancel_calls == 0
    assert started == ["capture-1"]


@pytest.mark.parametrize(
    ("content_type", "body"),
    [
        ("application/json", b"{}"),
        ("text/event-stream", b"event: checkpoint\ndata: {}\n\n"),
        ("text/event-stream", b"id: 1\ndata: {}\n\n"),
        ("text/event-stream", b"id: 1\nevent: checkpoint\ndata\n\n"),
        ("text/event-stream", b"id: 1\nevent: checkpoint\ndata: {}"),
        ("text/event-stream", b"id: 1\nevent: checkpoint\ndata: \xff\n\n"),
    ],
)
def test_v2_sse_fails_closed_with_sanitized_protocol_errors(
    content_type: str,
    body: bytes,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"Content-Type": content_type},
            content=body,
            request=request,
        )

    with pytest.raises(CaptureRuntimeProtocolError) as raised:
        list(_client(handler).capture_events("capture-1"))

    assert TOKEN not in str(raised.value)
    assert body.decode("utf-8", errors="replace") not in str(raised.value)


@pytest.mark.parametrize(
    ("operation_source", "section", "field", "value"),
    [
        (True, "raw", "fileName", "different.pdf"),
        (True, "result", "mediaType", "image/png"),
        (False, "result", "fileName", "different.pdf"),
    ],
)
def test_v2_result_requires_one_exact_source_identity(
    operation_source: bool,
    section: str,
    field: str,
    value: object,
) -> None:
    payload = _streaming_result()
    if not operation_source:
        payload["operation"]["source"] = None
    payload[section]["source"][field] = value

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v2/captures/capture-1/result"
        return _json_response(request, payload)

    with pytest.raises(CaptureRuntimeProtocolError, match="invalid streaming result"):
        _client(handler).get_result("capture-1")


@pytest.mark.parametrize(
    "operation_name",
    ["snapshot", "commit", "failure", "cancel"],
)
def test_v2_operation_responses_require_the_requested_capture_identity(
    operation_name: str,
) -> None:
    payload = _operation()
    payload["captureId"] = "capture-other"

    def handler(request: httpx.Request) -> httpx.Response:
        return _json_response(request, payload)

    client = _client(handler)
    with pytest.raises(CaptureRuntimeProtocolError, match="capture identity"):
        if operation_name == "snapshot":
            client.get_capture("capture-1")
        elif operation_name == "commit":
            client.commit_structure(
                "capture-1",
                {"schemaVersion": "1"},
                idempotency_key=UUID(int=1),
            )
        elif operation_name == "failure":
            client.report_structuring_failure(
                "capture-1",
                code="host_failed",
                message="Host structuring failed.",
                idempotency_key=UUID(int=2),
            )
        else:
            client.cancel_capture("capture-1")


class _ChunkStream(httpx.SyncByteStream):
    def __init__(self, chunks: list[bytes]) -> None:
        self._chunks = chunks

    def __iter__(self) -> Iterator[bytes]:
        yield from self._chunks


class _ReconnectingRuntimeClient:
    def __init__(self) -> None:
        self.event_cursors: list[int | str | None] = []
        self.snapshot_calls = 0
        self.cancel_calls = 0

    def handshake(self) -> RuntimeReadyV1:
        return RuntimeReadyV1.model_validate(
            {
                "ready": True,
                "service": "capture-runtime",
                "apiVersion": "1.0",
                "runtimeVersion": "0.3.11",
                "captureDocumentSchemaVersion": "1",
                "capabilities": {
                    "captureKinds": ["pdf", "image", "audio"],
                    "structuringModes": ["host"],
                    "supportsCancellation": True,
                    "supportsRawDiagnostics": True,
                    "maxUploadBytes": 50_000_000,
                },
            }
        )

    def get_requirements(self) -> RuntimeRequirementsV1:
        return RuntimeRequirementsV1(items=[])

    def start_capture(self, *_args, **_kwargs) -> CaptureOperationV2:
        return CaptureOperationV2.model_validate(_operation())

    def capture_events(
        self,
        _capture_id: str,
        *,
        last_event_id: int | str | None,
        on_activity=None,
    ) -> Iterator[CaptureEventV2]:
        self.event_cursors.append(last_event_id)
        if on_activity is not None:
            on_activity()
        if len(self.event_cursors) == 1:
            yield CaptureEventV2.model_validate(
                _event(sequence=1, event_type="checkpoint", stage="extracting")
            )
            return
        yield CaptureEventV2.model_validate(
            _event(
                sequence=2,
                event_type="checkpoint",
                stage="awaiting_structuring",
            )
        )

    def get_capture(self, _capture_id: str) -> CaptureOperationV2:
        self.snapshot_calls += 1
        status = "extracting" if self.snapshot_calls == 1 else "awaiting_structuring"
        payload = _operation()
        payload["status"] = status
        payload["lastEventSequence"] = self.snapshot_calls
        payload["progress"] = 0.5 if status == "extracting" else 0.75
        return CaptureOperationV2.model_validate(payload)

    def cancel_capture(self, _capture_id: str) -> CaptureOperationV2:
        self.cancel_calls += 1
        raise AssertionError("A disconnected event listener must not cancel the runtime job")


def _client(handler) -> CaptureRuntimeClient:
    return CaptureRuntimeClient(
        base_url="http://127.0.0.1:43123",
        bearer_token=TOKEN,
        client=httpx.Client(transport=httpx.MockTransport(handler)),
    )


def _json_response(
    request: httpx.Request,
    payload: dict[str, object],
    *,
    status: int = 200,
) -> httpx.Response:
    return httpx.Response(status, json=payload, request=request)


def _streaming_capabilities(*, max_chunk_bytes: int) -> dict[str, object]:
    return {
        "protocolVersion": "2",
        "captureKinds": ["pdf", "image", "audio"],
        "supportsProgressiveAudio": True,
        "maxChunkBytes": max_chunk_bytes,
        "checkpointIntervalMs": 250,
        "heartbeatIntervalMs": 1_000,
        "stallTimeoutMs": 30_000,
    }


def _ingestion(
    *,
    received: int,
    next_chunk: int,
    status: str = "open",
    finalized_sha256: str | None = None,
) -> dict[str, object]:
    return {
        "protocolVersion": "2",
        "kind": "pdf",
        "ingestionId": "ingestion-1",
        "status": status,
        "fileName": "sample.pdf",
        "mediaType": "application/pdf",
        "totalBytes": len(SOURCE),
        "receivedBytes": received,
        "contiguousBytes": received,
        "nextChunkIndex": next_chunk,
        "nextOffset": received,
        "sourceSha256": SOURCE_SHA256,
        "finalizedSha256": finalized_sha256,
        "expiresAt": (NOW + timedelta(minutes=30)).isoformat(),
    }


def _operation() -> dict[str, object]:
    return {
        "protocolVersion": "2",
        "captureId": "capture-1",
        "ingestionId": "ingestion-1",
        "kind": "pdf",
        "status": "extracting",
        "progress": 0.1,
        "partialRevision": 0,
        "lastEventSequence": 0,
        "source": {
            "sha256": SOURCE_SHA256,
            "fileName": "sample.pdf",
            "mediaType": "application/pdf",
            "bytes": len(SOURCE),
        },
        "error": None,
        "createdAt": NOW.isoformat(),
        "updatedAt": NOW.isoformat(),
        "completedAt": None,
    }


def _event(*, sequence: int, event_type: str, stage: str) -> dict[str, object]:
    return {
        "protocolVersion": "2",
        "eventId": f"capture-1/{sequence}",
        "sequence": sequence,
        "captureId": "capture-1",
        "kind": "pdf",
        "eventType": event_type,
        "stage": stage,
        "progress": 1,
        "segments": [],
        "createdAt": NOW.isoformat(),
    }


def _streaming_result() -> dict[str, object]:
    operation = _operation()
    operation.update(
        {
            "status": "completed",
            "progress": 1,
            "lastEventSequence": 1,
            "updatedAt": NOW.isoformat(),
            "completedAt": NOW.isoformat(),
        }
    )
    source = dict(operation["source"])
    segment = {
        "segmentId": "segment-1",
        "order": 0,
        "locator": {"kind": "page", "page": 1},
        "text": "Captured source text",
    }
    extraction_engine = {
        "engine": "windowsml-ocr",
        "model": "capture-runtime@0.3.11",
        "digest": f"sha256:{'a' * 64}",
        "device": "WindowsML",
    }
    raw = {
        "schemaVersion": "1",
        "diagnosticOnly": True,
        "source": dict(source),
        "segments": [dict(segment)],
        "sourceText": segment["text"],
        "extractionEngine": dict(extraction_engine),
        "warnings": [],
        "createdAt": NOW.isoformat(),
    }
    result = {
        "schemaVersion": "1",
        "source": dict(source),
        "rawSegments": [dict(segment)],
        "blocks": [
            {
                "blockId": "block-1",
                "order": 0,
                "type": "paragraph",
                "sourceSegmentId": segment["segmentId"],
                "locator": dict(segment["locator"]),
                "sourceText": segment["text"],
                "targetText": segment["text"],
            }
        ],
        "sourceText": segment["text"],
        "targetText": segment["text"],
        "extractionEngine": dict(extraction_engine),
        "structuringEngine": {
            "engine": "host",
            "model": "host",
            "digest": f"sha256:{'b' * 64}",
        },
        "warnings": [],
        "createdAt": NOW.isoformat(),
        "completedAt": NOW.isoformat(),
    }
    return {"operation": operation, "raw": raw, "result": result}
