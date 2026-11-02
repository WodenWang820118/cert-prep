from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
import json
from pathlib import Path
from types import SimpleNamespace

from fastapi.testclient import TestClient
import pytest

from capture_runtime_client import CaptureEvent
from cert_prep_backend.api.app import create_app
from cert_prep_backend.capture_integration.api import capture_event_stream
from cert_prep_backend.capture_integration.application import use_cases as capture_reviews
from cert_prep_backend.capture_integration.application.results import CaptureStreamHold
from cert_prep_backend.capture_integration.domain.review_session import CaptureReviewStatus
from cert_prep_backend.platform.config import Settings
from conftest import AUTH_TOKEN, minimal_pdf
from document_test_helpers import _create_project
from test_capture_workbench_pipeline import (
    DurableTerminalReplayCaptureRuntime,
    EchoCaptureProvider,
    ReplayableEventCaptureRuntime,
)

NOW = datetime(2026, 7, 20, 5, 0, tzinfo=UTC)
CAPTURE_ID = "capture-1"
HEARTBEAT = ": cert-prep waiting for durable terminal state\n\n"


def _runtime_event(
    sequence: int, *, event_type: str = "checkpoint", stage: str = "ocr"
) -> CaptureEvent:
    return CaptureEvent.model_validate(
        {
            "protocolVersion": "2",
            "eventId": f"runtime/{sequence}",
            "sequence": sequence,
            "captureId": "runtime",
            "kind": "pdf",
            "eventType": event_type,
            "stage": stage,
            "progress": 0.5,
            "partialRevision": 1,
            "segments": [],
            "createdAt": NOW.isoformat(),
        }
    )


@dataclass
class _Session:
    runtime_capture_id: str | None = "runtime"
    active: bool = True
    status: CaptureReviewStatus = CaptureReviewStatus.COMPLETED
    last_event_sequence: int = 0

    @property
    def is_active(self) -> bool:
        return self.active


class _Runtime:
    """Replays fixed events and records whether the consumer closed the iterator."""

    def __init__(self, events: list[CaptureEvent]) -> None:
        self.events = events
        self.cursors: list[int | None] = []
        self.closed = False

    def iter_events(self, runtime_id: str, *, last_event_id: int | None):
        self.cursors.append(last_event_id)
        try:
            yield from self.events
        finally:
            self.closed = True

    def event_is_terminal(self, event: CaptureEvent) -> bool:
        return event.event_type.value in {"completed", "failed", "cancelled"}

    def event_awaits_structuring(self, event: CaptureEvent) -> bool:
        return False


def _stream(runtime: _Runtime, session: _Session, last_event_id: int | None = None):
    return capture_event_stream.host_event_stream(
        runtime=runtime,
        sessions=SimpleNamespace(get=lambda **kwargs: session),
        documents=object(),
        operations=object(),
        signal=object(),
        project_id="project-1",
        capture_id=CAPTURE_ID,
        session=session,
        document=SimpleNamespace(id="doc-1", updated_at=NOW),
        last_event_id=last_event_id,
    )


@pytest.fixture(autouse=True)
def _fake_application_layer(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(capture_reviews, "note_capture_event", lambda *a, **k: _Session())
    monkeypatch.setattr(capture_reviews, "capture_source_kind", lambda *a, **k: "pdf")


def test_stream_replays_runtime_events_with_host_identity_and_exact_frames() -> None:
    runtime = _Runtime([_runtime_event(3), _runtime_event(4, stage="structuring")])

    frames = list(_stream(runtime, _Session(), last_event_id=2))

    assert runtime.cursors == [2]
    assert len(frames) == 2
    for sequence, frame in zip((3, 4), frames, strict=True):
        head, data = frame.split("data: ", 1)
        assert head == f"id: {sequence}\nevent: checkpoint\n"
        assert data.endswith("}\n\n")
        # Compact separators: the wire format has no spaces after "," or ":".
        assert (
            data == json.dumps(json.loads(data), ensure_ascii=False, separators=(",", ":")) + "\n\n"
        )
        payload = json.loads(data)
        assert payload["captureId"] == CAPTURE_ID
        assert payload["eventId"] == f"{CAPTURE_ID}/{sequence}"
        assert payload["sequence"] == sequence


def test_stream_emits_wait_comments_then_terminal_frame_last_and_closes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runtime = _Runtime(
        [
            _runtime_event(1),
            _runtime_event(2, event_type="completed", stage="completed"),
            _runtime_event(3),
        ]
    )
    holds = iter(
        [
            CaptureStreamHold(session=_Session(), waiting=True),
            CaptureStreamHold(session=_Session(), waiting=True),
            CaptureStreamHold(session=_Session(active=False, last_event_sequence=2), waiting=False),
        ]
    )
    seen_holds: list[str] = []

    def hold(*args, hold: str, **kwargs) -> CaptureStreamHold:
        seen_holds.append(hold)
        return next(holds)

    monkeypatch.setattr(capture_reviews, "hold_capture_stream", hold)

    frames = list(_stream(runtime, _Session()))

    assert seen_holds == ["terminal"] * 3
    assert frames[0].startswith("id: 1\nevent: checkpoint")
    assert frames[1:3] == [HEARTBEAT, HEARTBEAT]
    assert frames[3].startswith("id: 2\nevent: completed\ndata: ")
    terminal = json.loads(frames[3].split("data: ", 1)[1])
    assert terminal["eventId"] == f"{CAPTURE_ID}/2"
    assert terminal["stage"] == "completed"
    # The event after the terminal one is never emitted: the stream closed.
    assert len(frames) == 4


def test_stream_waits_for_runtime_identity_with_comment_frames(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runtime = _Runtime([_runtime_event(1)])
    holds = iter(
        [
            CaptureStreamHold(session=_Session(runtime_capture_id=None), waiting=True),
            CaptureStreamHold(session=_Session(), waiting=False),
        ]
    )
    monkeypatch.setattr(capture_reviews, "hold_capture_stream", lambda *a, **k: next(holds))

    frames = list(_stream(runtime, _Session(runtime_capture_id=None)))

    assert frames[0] == ": cert-prep waiting for runtime identity\n\n"
    assert frames[1].startswith("id: 1\nevent: checkpoint")
    assert len(frames) == 2


def test_stream_stops_and_releases_runtime_iterator_when_client_disconnects() -> None:
    runtime = _Runtime([_runtime_event(1), _runtime_event(2), _runtime_event(3)])
    stream = _stream(runtime, _Session())

    assert next(stream).startswith("id: 1\n")
    stream.close()

    assert runtime.closed
    assert list(stream) == []


def test_stream_replays_durable_terminal_after_cursor_and_skips_when_cursor_reached() -> None:
    class _Gone(_Runtime):
        def iter_events(self, runtime_id: str, *, last_event_id: int | None):
            return iter(())

    finished = _Session(runtime_capture_id=None, active=False, last_event_sequence=6)

    replay = list(_stream(_Gone([]), finished, last_event_id=5))
    assert len(replay) == 1
    assert replay[0].startswith("id: 6\nevent: completed\ndata: ")
    assert list(_stream(_Gone([]), finished, last_event_id=6)) == []


def _client(tmp_path: Path, runtime) -> TestClient:
    settings = Settings(data_dir=tmp_path, api_token=AUTH_TOKEN, llm_provider="fake")
    return TestClient(
        create_app(
            settings=settings,
            llm_provider=EchoCaptureProvider(),
            capture_runtime_client=runtime,
            document_processing_async_jobs=False,
            streaming_draft_generation_async_jobs=False,
        )
    )


def _create_capture(client: TestClient, headers: dict[str, str]) -> tuple[str, str]:
    project_id = _create_project(client, headers)
    created = client.post(
        f"/projects/{project_id}/capture-workbench/captures",
        headers=headers,
        files={"file": ("c.pdf", minimal_pdf("Cursor."), "application/pdf")},
    )
    return project_id, created.json()["captureId"]


def test_invalid_cursor_is_rejected_with_422_body_before_runtime_is_read(
    tmp_path: Path,
) -> None:
    runtime = ReplayableEventCaptureRuntime()
    with _client(tmp_path, runtime) as client:
        headers = {"Authorization": f"Bearer {AUTH_TOKEN}"}
        project_id, capture_id = _create_capture(client, headers)

        response = client.get(
            f"/projects/{project_id}/capture-workbench/captures/{capture_id}/events",
            headers={**headers, "Last-Event-ID": "-2"},
        )

        assert response.status_code == 422
        assert response.json() == {
            "code": "validation_error",
            "message": "Last-Event-ID must be a decimal integer greater than or equal to -1.",
        }
        assert runtime.event_cursors == []


def test_http_replay_returns_exact_single_frame_with_streaming_headers(
    tmp_path: Path,
) -> None:
    runtime = DurableTerminalReplayCaptureRuntime()
    with _client(tmp_path, runtime) as client:
        headers = {"Authorization": f"Bearer {AUTH_TOKEN}"}
        project_id, capture_id = _create_capture(client, headers)

        response = client.get(
            f"/projects/{project_id}/capture-workbench/captures/{capture_id}/events",
            headers={**headers, "Last-Event-ID": "4"},
        )

        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        assert response.headers["cache-control"] == "no-store"
        assert response.headers["x-accel-buffering"] == "no"
        frames = [frame for frame in response.text.split("\n\n") if frame]
        assert len(frames) == 1
        assert frames[0].startswith("id: 5\nevent: checkpoint\ndata: ")
        assert json.loads(frames[0].split("data: ", 1)[1])["eventId"] == f"{capture_id}/5"
