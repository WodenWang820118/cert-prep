"""HTTP behaviour of the project-scoped Capture Reviews routes.

These tests pin what a client observes from each route: authentication order, status codes,
error envelopes, host identity and the runtime calls a route makes or must not make.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from uuid import uuid4

from fastapi import FastAPI
from fastapi.routing import APIRoute, iter_route_contexts
from fastapi.testclient import TestClient
import pytest

from capture_runtime_client import CaptureOperation
from cert_prep_backend.bootstrap.app import create_app
from cert_prep_backend.capture_integration.infrastructure import review_sessions
from cert_prep_backend.capture_integration.infrastructure.client import (
    CaptureRuntimeError,
    CaptureRuntimeProtocolError,
)
from cert_prep_backend.platform.config import Settings
from cert_prep_backend.source_library.infrastructure import operations
from conftest import AUTH_TOKEN, minimal_audio, minimal_pdf
from source_test_helpers import _create_project
from test_capture_workbench_pipeline import (
    DeterministicCaptureRuntime,
    EchoCaptureProvider,
    _public_capture_document,
    _wait_for_capture_status,
)

HEADERS = {"Authorization": f"Bearer {AUTH_TOKEN}"}
PREFIX = "/projects/{project_id}/capture-reviews"
RUNTIME_ID = "capture-pipeline-1"
_UNAUTHORIZED = {"code": "unauthorized", "message": "Bearer token required."}
_SESSION_NOT_FOUND = {"code": "not_found", "message": "Capture review session not found."}

# Every route of the API in registration order, with a valid request body where one is required.
_REVIEW_ROUTES: list[tuple[str, str]] = [
    ("POST", ""),
    ("GET", "/{capture_id}"),
    ("GET", "/{capture_id}/ocr-summary"),
    ("GET", "/{capture_id}/events"),
    ("GET", "/{capture_id}/partial"),
    ("GET", "/{capture_id}/raw"),
    ("POST", "/{capture_id}/structure"),
    ("POST", "/{capture_id}/structure/commit"),
    ("POST", "/{capture_id}/structure/failure"),
    ("POST", "/{capture_id}/cancel"),
    ("GET", "/{capture_id}/result"),
    ("DELETE", "/{capture_id}"),
]


def _request_body(method: str, suffix: str) -> dict[str, object]:
    if (method, suffix) == ("POST", ""):
        return {"files": {"file": ("route.pdf", minimal_pdf("Route."), "application/pdf")}}
    if suffix.endswith("/structure"):
        return {
            "json": {
                "clientRequestId": "route-structure",
                "review": {"reviewVersion": 2, "edits": []},
            }
        }
    if suffix.endswith("/structure/commit"):
        candidate, _raw = _public_capture_document()
        return {
            "json": {
                "clientRequestId": "route-commit",
                "candidate": candidate.model_dump(mode="json", by_alias=True),
            }
        }
    if suffix.endswith("/structure/failure"):
        return {
            "json": {
                "clientRequestId": "route-failure",
                "code": "host_provider_failed",
                "message": "Provider failed.",
            }
        }
    return {}


class ScriptedCaptureRuntime(DeterministicCaptureRuntime):
    """Deterministic runtime whose reads and controls can be made to fail, recording calls."""

    def __init__(self) -> None:
        super().__init__()
        self.calls: list[tuple[str, str]] = []
        self.cancelled = False
        self.failure_reported = False
        self.malformed_operation = False
        self.partial_error: Exception | None = None
        self.raw_error: Exception | None = None
        self.result_error: Exception | None = None
        self.delete_error: Exception | None = None
        self.cancel_error: Exception | None = None
        self.report_error: Exception | None = None
        self.structure_error: Exception | None = None

    def calls_named(self, *names: str) -> list[tuple[str, str]]:
        return [call for call in self.calls if call[0] in names]

    def get_capture(self, capture_id: str) -> CaptureOperation:
        self.calls.append(("get_capture", capture_id))
        if self.cancelled:
            operation = self._operation(status="cancelled")
        elif self.failure_reported:
            operation = self._operation(status="failed")
        else:
            operation = super().get_capture(capture_id)
        if self.malformed_operation:
            # A runtime operation the host cannot re-project: model_copy does not validate.
            return operation.model_copy(update={"partial_revision": -1})
        return operation

    def get_partial(self, capture_id: str):
        self.calls.append(("get_partial", capture_id))
        if self.partial_error is not None:
            raise self.partial_error
        return super().get_partial(capture_id)

    def get_raw(self, capture_id: str):
        self.calls.append(("get_raw", capture_id))
        if self.raw_error is not None:
            raise self.raw_error
        return super().get_raw(capture_id)

    def get_result(self, capture_id: str):
        self.calls.append(("get_result", capture_id))
        if self.result_error is not None:
            raise self.result_error
        return super().get_result(capture_id)

    def open_structuring_session(self, capture_id: str, request: object, *, idempotency_key: str):
        if self.structure_error is not None:
            raise self.structure_error
        return super().open_structuring_session(
            capture_id, request, idempotency_key=idempotency_key
        )

    def report_structuring_failure(self, capture_id: str, **_kwargs) -> CaptureOperation:
        self.calls.append(("report_structuring_failure", capture_id))
        if self.report_error is not None:
            raise self.report_error
        self.failure_reported = True
        return self._operation(status="failed")

    def cancel_capture(self, capture_id: str, *_args, **_kwargs) -> CaptureOperation:
        self.calls.append(("cancel_capture", capture_id))
        if self.cancel_error is not None:
            raise self.cancel_error
        self.cancelled = True
        return self._operation(status="cancelled")

    def delete_capture(self, capture_id: str) -> None:
        self.calls.append(("delete_capture", capture_id))
        if self.delete_error is not None:
            raise self.delete_error
        super().delete_capture(capture_id)


class _RecordingProxy:
    """Delegates to a real app resource and records each attribute a request touches."""

    def __init__(self, target: object, touched: list[str], label: str) -> None:
        self._target = target
        self._touched = touched
        self._label = label

    def __getattr__(self, name: str) -> object:
        self._touched.append(f"{self._label}.{name}")
        return getattr(self._target, name)


_RECORDED_RESOURCES = (
    "capture_review_store",
    "capture_runtime",
    "capture_background_work",
    "capture_review_maintenance",
    "capture_review_workflow",
    "source_repository",
    "source_operation_repository",
    "source_file_store",
    "project_repository",
    "question_generation_work",
)


@contextmanager
def _recorded_resources(app: FastAPI) -> Iterator[list[str]]:
    touched: list[str] = []
    originals = {name: getattr(app.state, name) for name in _RECORDED_RESOURCES}
    for name, resource in originals.items():
        setattr(app.state, name, _RecordingProxy(resource, touched, name))
    try:
        yield touched
    finally:
        for name, resource in originals.items():
            setattr(app.state, name, resource)


def _app(tmp_path: Path, runtime: object | None, **settings: object) -> FastAPI:
    token = settings.pop("api_token", AUTH_TOKEN)
    return create_app(
        settings=Settings(data_dir=tmp_path, api_token=token, llm_provider="fake", **settings),
        llm_provider=EchoCaptureProvider(),
        capture_runtime_client=runtime,
        source_processing_async_jobs=False,
        background_question_jobs=False,
    )


def _url(project_id: str, capture_id: str, suffix: str = "/{capture_id}") -> str:
    return PREFIX.format(project_id=project_id) + suffix.format(capture_id=capture_id)


def _start_review(client: TestClient, headers: dict[str, str] = HEADERS) -> tuple[str, str, dict]:
    project_id = _create_project(client, headers)
    created = client.post(
        _url(project_id, "", ""),
        headers=headers,
        files={"file": ("review.pdf", minimal_pdf("Route review."), "application/pdf")},
    )
    assert created.status_code == 202, created.text
    capture = created.json()
    _wait_for_capture_status(
        client,
        project_id=project_id,
        capture_id=capture["captureId"],
        headers=headers,
        status_value="awaiting_structuring",
    )
    return project_id, capture["captureId"], capture


def _structure(client: TestClient, project_id: str, capture_id: str, request_id: str):
    return client.post(
        _url(project_id, capture_id, "/{capture_id}/structure"),
        headers=HEADERS,
        json={"clientRequestId": request_id, "review": {"reviewVersion": 2, "edits": []}},
    )


def _commit(client: TestClient, project_id: str, capture_id: str, request_id: str, candidate):
    return client.post(
        _url(project_id, capture_id, "/{capture_id}/structure/commit"),
        headers=HEADERS,
        json={"clientRequestId": request_id, "candidate": candidate},
    )


def _complete_review(client: TestClient, project_id: str, capture_id: str) -> dict:
    structured = _structure(client, project_id, capture_id, "complete-structure")
    assert structured.status_code == 200, structured.text
    committed = _commit(client, project_id, capture_id, "complete-commit", structured.json())
    assert committed.status_code == 202, committed.text
    _wait_for_capture_status(
        client,
        project_id=project_id,
        capture_id=capture_id,
        headers=HEADERS,
        status_value="completed",
    )
    return structured.json()


def _unbound_session(app: FastAPI, project_id: str) -> str:
    """A pending review session whose runtime capture has not started yet."""

    operation_id = str(uuid4())
    assert operations.claim_operation(
        app.state.database, project_id=project_id, operation_id=operation_id
    ).acquired
    source = operations.create_and_attach_source(
        app.state.database,
        project_id=project_id,
        operation_id=operation_id,
        filename="unbound.pdf",
        source_kind="pdf",
        sha256="a" * 64,
        language_hint="auto",
        storage_path="unbound.pdf",
        page_count=1,
    )
    return review_sessions.create(
        app.state.database,
        project_id=project_id,
        source_id=source.id,
        operation_id=operation_id,
    ).id


def _row_count(app: FastAPI, table: str) -> int:
    with app.state.database.connect() as connection:
        return int(connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])


def _error(status_code: int, message: str) -> dict[str, str]:
    code = {404: "not_found", 422: "validation_error", 503: "provider_unavailable"}.get(
        status_code, "request_error"
    )
    return {"code": code, "message": message}


def test_capture_review_routes_are_registered_in_order_under_one_prefix(tmp_path: Path) -> None:
    app = _app(tmp_path, ScriptedCaptureRuntime())
    registered = [
        (sorted(context.methods or ()), context.path_format, context.tags)
        for context in iter_route_contexts(app.routes)
        if isinstance(context.original_route, APIRoute)
        and (context.path_format or "").startswith(PREFIX)
    ]

    assert registered == [
        ([method], PREFIX + suffix, ["capture-reviews"]) for method, suffix in _REVIEW_ROUTES
    ]


@pytest.mark.parametrize(("method", "suffix"), _REVIEW_ROUTES)
@pytest.mark.parametrize("authorization", [None, "Bearer wrong-token"])
def test_capture_review_routes_require_bearer_before_side_effects(
    tmp_path: Path,
    method: str,
    suffix: str,
    authorization: str | None,
) -> None:
    runtime = ScriptedCaptureRuntime()
    app = _app(tmp_path, runtime)
    with TestClient(app) as client:
        project_id = _create_project(client, HEADERS)
        headers = {} if authorization is None else {"Authorization": authorization}
        with _recorded_resources(app) as touched:
            rejected = client.request(
                method,
                _url(project_id, "capture-1", suffix),
                headers={**headers, "X-Cert-Prep-Operation-Id": "unauthorized-operation"},
                **_request_body(method, suffix),
            )
            rejected_touches = list(touched)
            accepted = client.request(
                "GET", _url(project_id, "capture-1"), headers=HEADERS
            )

        assert rejected.status_code == 401
        assert rejected.json() == _UNAUTHORIZED
        assert rejected_touches == []
        # The recording is live: an authenticated read touches the review resources.
        assert accepted.status_code == 404
        assert touched
        assert runtime.calls == []
        assert _row_count(app, "source_operations") == 0
        assert _row_count(app, "capture_review_sessions") == 0


@pytest.mark.parametrize(
    ("method", "suffix"),
    [route for route in _REVIEW_ROUTES if route[1] != "/{capture_id}/ocr-summary"],
)
def test_review_routes_without_a_runtime_answer_503_before_reading_state(
    tmp_path: Path, method: str, suffix: str
) -> None:
    app = _app(tmp_path, None)
    assert app.state.capture_runtime_client is None
    with TestClient(app) as client:
        project_id = _create_project(client, HEADERS)
        with _recorded_resources(app) as touched:
            response = client.request(
                method,
                _url(project_id, "capture-1", suffix),
                headers=HEADERS,
                **_request_body(method, suffix),
            )
            touches = list(touched)

    assert response.status_code == 503
    assert response.json() == {
        "code": "capture_runtime_unavailable",
        "message": "Capture Runtime is not configured for this process.",
    }
    assert touches == []


def test_capture_reviews_are_isolated_between_apps(tmp_path: Path) -> None:
    runtime_a = ScriptedCaptureRuntime()
    runtime_b = ScriptedCaptureRuntime()
    small = minimal_pdf("Small source.")
    large = minimal_pdf("Large source. " * 400)
    app_a = _app(
        tmp_path / "a",
        runtime_a,
        api_token="token-a",
        max_page_source_upload_bytes=len(small) + 16,
    )
    app_b = _app(tmp_path / "b", runtime_b, api_token="token-b")
    headers_a = {"Authorization": "Bearer token-a"}
    headers_b = {"Authorization": "Bearer token-b"}
    assert len(large) > len(small) + 16
    with TestClient(app_a) as client_a, TestClient(app_b) as client_b:
        project_a = _create_project(client_a, headers_a)
        project_b = _create_project(client_b, headers_b)
        upload = "X-Cert-Prep-Operation-Id"
        created_b = client_b.post(
            _url(project_b, "", ""),
            headers={**headers_b, upload: "shared-operation"},
            files={"file": ("large.pdf", large, "application/pdf")},
        )
        created_a = client_a.post(
            _url(project_a, "", ""),
            headers={**headers_a, upload: "shared-operation"},
            files={"file": ("small.pdf", small, "application/pdf")},
        )
        too_large_for_a = client_a.post(
            _url(project_a, "", ""),
            headers={**headers_a, upload: "large-operation"},
            files={"file": ("large.pdf", large, "application/pdf")},
        )
        capture_a = created_a.json()["captureId"]
        capture_b = created_b.json()["captureId"]
        for client, headers, project_id, capture_id in (
            (client_a, headers_a, project_a, capture_a),
            (client_b, headers_b, project_b, capture_b),
        ):
            _wait_for_capture_status(
                client,
                project_id=project_id,
                capture_id=capture_id,
                headers=headers,
                status_value="awaiting_structuring",
            )
        a_with_b_token = client_a.get(_url(project_a, capture_a), headers=headers_b)
        b_with_a_token = client_b.get(_url(project_b, capture_b), headers=headers_a)
        b_capture_in_a = client_a.get(_url(project_a, capture_b), headers=headers_a)
        a_capture_in_b = client_b.get(_url(project_b, capture_a), headers=headers_b)
        # Read before shutdown, which cancels the reviews still active.
        with app_a.state.database.connect() as connection:
            rows_a = dict(connection.execute("SELECT id, status FROM source_operations").fetchall())
        with app_b.state.database.connect() as connection:
            rows_b = dict(connection.execute("SELECT id, status FROM source_operations").fetchall())

    assert created_a.status_code == 202
    assert created_b.status_code == 202
    assert capture_a != capture_b
    assert too_large_for_a.status_code == 422
    assert too_large_for_a.json()["code"] == "validation_error"
    assert a_with_b_token.status_code == b_with_a_token.status_code == 401
    assert b_capture_in_a.status_code == a_capture_in_b.status_code == 404
    assert b_capture_in_a.json() == a_capture_in_b.json() == _SESSION_NOT_FOUND
    assert len(runtime_a.created_request_ids) == 1
    assert len(runtime_b.created_request_ids) == 1
    assert rows_a == {"shared-operation": "running", "large-operation": "failed"}
    assert rows_b == {"shared-operation": "running"}


def test_review_upload_rejects_recordings_and_abandons_claim(tmp_path: Path) -> None:
    runtime = ScriptedCaptureRuntime()
    app = _app(tmp_path, runtime)
    with TestClient(app) as client:
        project_id = _create_project(client, HEADERS)
        recording = client.post(
            _url(project_id, "", ""),
            headers={**HEADERS, "X-Cert-Prep-Operation-Id": "recording-operation"},
            files={"file": ("lecture.wav", minimal_audio(".wav"), "audio/wav")},
        )
        empty_header = client.post(
            _url(project_id, "", ""),
            headers={**HEADERS, "X-Cert-Prep-Operation-Id": ""},
            files={"file": ("empty.pdf", minimal_pdf("Empty header."), "application/pdf")},
        )
        long_header = client.post(
            _url(project_id, "", ""),
            headers={**HEADERS, "X-Cert-Prep-Operation-Id": "o" * 129},
            files={"file": ("long.pdf", minimal_pdf("Long header."), "application/pdf")},
        )
        with app.state.database.connect() as connection:
            claimed = [
                tuple(row)
                for row in connection.execute(
                    "SELECT id, status, phase, source_id FROM source_operations"
                ).fetchall()
            ]

    assert recording.status_code == 422
    assert recording.json() == _error(422, "Capture review supports PDF and image sources only.")
    assert claimed == [("recording-operation", "failed", "failed", None)]
    assert _row_count(app, "capture_review_sessions") == 0
    assert runtime.created_request_ids == []
    for rejected in (empty_header, long_header):
        assert rejected.status_code == 422
        assert rejected.json()["code"] == "validation_error"
        assert rejected.json()["message"] == "Request validation failed."
        [error] = rejected.json()["details"]["errors"]
        assert error["loc"] == ["header", "X-Cert-Prep-Operation-Id"]


def test_partial_and_raw_map_http_failures(tmp_path: Path) -> None:
    runtime = ScriptedCaptureRuntime()
    app = _app(tmp_path, runtime)
    with TestClient(app) as client:
        project_id, capture_id, capture = _start_review(client)
        other_project = _create_project(client, HEADERS)
        unbound = _unbound_session(app, project_id)

        def read(project: str, capture_ref: str, view: str):
            return client.get(_url(project, capture_ref, "/{capture_id}/" + view), headers=HEADERS)

        missing = {view: read(project_id, "missing", view) for view in ("partial", "raw")}
        foreign = {view: read(other_project, capture_id, view) for view in ("partial", "raw")}
        not_bound = {view: read(project_id, unbound, view) for view in ("partial", "raw")}
        runtime.partial_error = RuntimeError("private partial diagnostic")
        runtime.raw_error = RuntimeError("private raw diagnostic")
        gateway = {view: read(project_id, capture_id, view) for view in ("partial", "raw")}
        runtime.partial_error = runtime.raw_error = None

        runtime.malformed_operation = True
        malformed_active = client.get(_url(project_id, capture_id), headers=HEADERS)
        runtime.malformed_operation = False

        cancelled = client.post(_url(project_id, capture_id, "/{capture_id}/cancel"), headers=HEADERS)
        closed = {view: read(project_id, capture_id, view) for view in ("partial", "raw")}
        runtime.malformed_operation = True
        durable_inactive = client.get(_url(project_id, capture_id), headers=HEADERS)

    for view in ("partial", "raw"):
        assert missing[view].status_code == 404
        assert missing[view].json() == _SESSION_NOT_FOUND
        assert foreign[view].status_code == 404
        assert foreign[view].json() == _SESSION_NOT_FOUND
        assert not_bound[view].status_code == 409
        assert not_bound[view].json() == _error(
            409, "OCR extraction has not reached review state."
        )
        assert closed[view].status_code == 409
        assert closed[view].json() == _error(409, "OCR review is no longer available.")
    assert gateway["partial"].status_code == gateway["raw"].status_code == 502
    assert gateway["partial"].json() == _error(
        502, "Capture Runtime partial extraction unavailable."
    )
    assert gateway["raw"].json() == _error(502, "Capture Runtime raw extraction unavailable.")
    assert malformed_active.status_code == 502
    assert malformed_active.json() == _error(502, "Capture Runtime status unavailable.")
    assert cancelled.status_code == 200
    assert durable_inactive.status_code == 200
    durable = durable_inactive.json()
    assert durable["status"] == "cancelled"
    assert durable["captureId"] == capture_id
    assert durable["sourceId"] == capture["sourceId"]
    # The durable projection, not the runtime operation (whose partial revision is 1).
    assert durable["partialRevision"] == 0
    assert durable["progress"] == 1


def test_structuring_http_conflicts_and_replays(tmp_path: Path) -> None:
    runtime = ScriptedCaptureRuntime()
    app = _app(tmp_path / "review", runtime)
    with TestClient(app) as client:
        project_id, capture_id, _capture = _start_review(client)
        runtime.structure_error = RuntimeError("private structuring diagnostic")
        preview_gateway = _structure(client, project_id, capture_id, "preview-gateway")
        runtime.structure_error = None
        candidate = _complete_review(client, project_id, capture_id)
        preview_closed = _structure(client, project_id, capture_id, "preview-closed")
        with _recorded_resources(app) as touched:
            replay = _commit(client, project_id, capture_id, "complete-commit", candidate)
            replay_touches = list(touched)
        status_after_replay = client.get(_url(project_id, capture_id), headers=HEADERS)
        divergent = _commit(client, project_id, capture_id, "another-commit", candidate)

    assert preview_gateway.status_code == 502
    assert preview_gateway.json() == _error(502, "Capture structuring failed.")
    assert preview_closed.status_code == 409
    assert preview_closed.json() == _error(409, "Capture review is no longer pending.")
    assert replay.status_code == 202
    assert replay.json() == status_after_replay.json()
    assert replay.json()["status"] == "completed"
    assert not any(touch.startswith("capture_background_work.") for touch in replay_touches)
    assert not any(touch.startswith("capture_review_workflow.claim") for touch in replay_touches)
    assert divergent.status_code == 409
    assert divergent.json() == _error(
        409, "Capture commit does not match the completed request."
    )

    class _RefusingWork:
        def submit(self, **_kwargs) -> None:
            raise RuntimeError("worker pool closed")

        def is_closed(self) -> bool:
            return True

    queue_runtime = ScriptedCaptureRuntime()
    queue_app = _app(tmp_path / "queue", queue_runtime)
    with TestClient(queue_app) as client:
        project_id, capture_id, _capture = _start_review(client)
        structured = _structure(client, project_id, capture_id, "queue-structure")
        background_work = queue_app.state.capture_background_work
        queue_app.state.capture_background_work = _RefusingWork()
        try:
            not_queued = _commit(client, project_id, capture_id, "queue-commit", structured.json())
        finally:
            queue_app.state.capture_background_work = background_work
        after = client.get(_url(project_id, capture_id), headers=HEADERS)

    assert structured.status_code == 200
    assert not_queued.status_code == 503
    assert not_queued.json() == _error(503, "Capture commit could not be queued.")
    assert after.json()["status"] == "failed"


def test_report_structuring_failure_projects_and_replays_host_failure(tmp_path: Path) -> None:
    runtime = ScriptedCaptureRuntime()
    app = _app(tmp_path, runtime)
    failure_body = {
        "clientRequestId": "structuring-failure",
        "code": "host_provider_failed",
        "message": "Provider failed.",
    }
    with TestClient(app) as client:
        project_id, capture_id, capture = _start_review(client)
        url = _url(project_id, capture_id, "/{capture_id}/structure/failure")
        runtime.report_error = RuntimeError("private report diagnostic")
        runtime.cancel_error = RuntimeError("private cancel diagnostic")
        gateway = client.post(url, headers=HEADERS, json=failure_body)
        runtime.report_error = runtime.cancel_error = None
        reports_before = len(runtime.calls_named("report_structuring_failure"))
        first = client.post(url, headers=HEADERS, json=failure_body)
        repeat = client.post(url, headers=HEADERS, json=failure_body)
        reports_after = len(runtime.calls_named("report_structuring_failure"))
        unbound = _unbound_session(app, project_id)
        conflict = client.post(
            _url(project_id, unbound, "/{capture_id}/structure/failure"),
            headers=HEADERS,
            json=failure_body,
        )

    assert gateway.status_code == 502
    assert gateway.json() == _error(502, "Capture structuring failure could not be confirmed.")
    durable_failure = {
        "code": "capture_review_failed",
        "message": "Capture host structuring failed.",
        "stage": "failed",
        "retryable": False,
    }
    assert first.status_code == 200
    assert first.json()["captureId"] == capture_id
    assert first.json()["sourceId"] == capture["sourceId"]
    assert first.json()["ingestionId"] == "ingestion-pipeline-1"
    assert first.json()["status"] == "failed"
    assert first.json()["error"] == durable_failure
    assert reports_after - reports_before == 1
    assert repeat.status_code == 200
    assert repeat.json()["captureId"] == capture_id
    assert repeat.json()["status"] == "failed"
    assert repeat.json()["error"] == durable_failure
    assert conflict.status_code == 409
    assert conflict.json() == _error(409, "Capture Runtime operation is not available.")


def test_delete_capture_cancels_active_then_discards_and_returns_empty_204(
    tmp_path: Path,
) -> None:
    runtime = ScriptedCaptureRuntime()
    app = _app(tmp_path / "delete", runtime)
    with TestClient(app) as client:
        project_id, capture_id, _capture = _start_review(client)
        runtime.calls.clear()
        active = client.delete(_url(project_id, capture_id), headers=HEADERS)
        active_calls = runtime.calls_named("cancel_capture", "delete_capture")
        runtime.calls.clear()
        terminal = client.delete(_url(project_id, capture_id), headers=HEADERS)
        terminal_calls = runtime.calls_named("cancel_capture", "delete_capture")
        runtime.delete_error = CaptureRuntimeError(
            status_code=500, code="internal_error", message="private delete diagnostic"
        )
        rejected = client.delete(_url(project_id, capture_id), headers=HEADERS)
        missing = client.delete(_url(project_id, "missing"), headers=HEADERS)

    assert active.status_code == 204
    assert active.content == b""
    assert active_calls == [("cancel_capture", RUNTIME_ID), ("delete_capture", RUNTIME_ID)]
    assert terminal.status_code == 204
    assert terminal.content == b""
    assert terminal_calls == [("delete_capture", RUNTIME_ID)]
    assert rejected.status_code == 502
    assert rejected.json() == _error(502, "Capture Runtime deletion could not be confirmed.")
    assert missing.status_code == 404
    assert missing.json() == _SESSION_NOT_FOUND

    cancel_runtime = ScriptedCaptureRuntime()
    cancel_app = _app(tmp_path / "cancel", cancel_runtime)
    with TestClient(cancel_app) as client:
        project_id, capture_id, capture = _start_review(client)
        cancel_runtime.calls.clear()
        cancelled = client.post(_url(project_id, capture_id, "/{capture_id}/cancel"), headers=HEADERS)
        cancel_calls = cancel_runtime.calls_named("cancel_capture", "delete_capture")

    assert cancelled.status_code == 200
    assert cancelled.json()["status"] == "cancelled"
    assert cancelled.json()["captureId"] == capture_id
    assert cancelled.json()["sourceId"] == capture["sourceId"]
    assert cancelled.json()["ingestionId"] == "ingestion-pipeline-1"
    assert cancel_calls == [("cancel_capture", RUNTIME_ID)]

    refusing_runtime = ScriptedCaptureRuntime()
    refusing_app = _app(tmp_path / "refusing", refusing_runtime)
    with TestClient(refusing_app) as client:
        project_id, capture_id, _capture = _start_review(client)
        refusing_runtime.calls.clear()
        refusing_runtime.cancel_error = RuntimeError("private cancel diagnostic")
        refused = client.delete(_url(project_id, capture_id), headers=HEADERS)
        refused_calls = refusing_runtime.calls_named("cancel_capture", "delete_capture")

    assert refused.status_code == 502
    assert refused.json() == _error(502, "Capture cancellation could not be confirmed.")
    assert refused_calls == [("cancel_capture", RUNTIME_ID)]


@pytest.mark.parametrize(
    ("error", "expected"),
    [
        (
            CaptureRuntimeProtocolError("private protocol diagnostic"),
            {
                "code": "capture_runtime_protocol_error",
                "message": "Capture Runtime result violated the v2 contract.",
            },
        ),
        (
            CaptureRuntimeError(
                status_code=500, code="internal_error", message="private result diagnostic"
            ),
            {
                "code": "capture_runtime_result_unavailable",
                "message": "Capture Runtime result unavailable.",
            },
        ),
        (
            RuntimeError("private transport diagnostic"),
            {
                "code": "capture_runtime_result_unavailable",
                "message": "Capture Runtime result unavailable.",
            },
        ),
    ],
)
def test_completed_capture_result_maps_runtime_read_failures_without_release(
    tmp_path: Path,
    error: Exception,
    expected: dict[str, str],
) -> None:
    runtime = ScriptedCaptureRuntime()
    app = _app(tmp_path, runtime)
    with TestClient(app) as client:
        project_id, capture_id, _capture = _start_review(client)
        _complete_review(client, project_id, capture_id)
        deleted_before = list(runtime.deleted)
        runtime.result_error = error
        failed = client.get(_url(project_id, capture_id, "/{capture_id}/result"), headers=HEADERS)
        deleted_after_failure = list(runtime.deleted)
        runtime.result_error = None
        released = client.get(_url(project_id, capture_id, "/{capture_id}/result"), headers=HEADERS)

    assert failed.status_code == 502
    assert failed.json() == expected
    assert "private" not in failed.text
    assert deleted_after_failure == deleted_before == []
    assert released.status_code == 200
    assert runtime.deleted == [RUNTIME_ID]
