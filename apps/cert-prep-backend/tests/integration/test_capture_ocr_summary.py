from __future__ import annotations

import sqlite3
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from cert_prep_backend.api.app import create_app
from cert_prep_backend.core.config import Settings
from cert_prep_backend.domains.capture_workbench import review_sessions
from cert_prep_backend.domains.capture_workbench.client import CaptureRuntimeError
from cert_prep_backend.domains.projects import repository as projects_repository
from cert_prep_backend.domains.projects.schemas import ProjectCreate
from cert_prep_backend.domains.source_documents import operations


TOKEN = "ocr-summary-token"
AUTH_HEADERS = {"Authorization": f"Bearer {TOKEN}"}
FORBIDDEN_KEYS = {
    "raw",
    "text",
    "polygon",
    "filename",
    "path",
    "runtimeid",
    "token",
    "warning",
    "message",
    "stage",
}


def test_authenticated_completed_summary_is_read_only_and_privacy_safe(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runtime = RecordingOcrRuntime()
    app, provider = _app(tmp_path, runtime)
    project_id = _create_project(app)
    capture_id = _create_capture_session(app, project_id=project_id)
    session_reads = _record_session_reads(monkeypatch)
    monitor = sqlite3.connect(app.state.database.path)
    client = TestClient(app)
    try:
        before = _data_version(monitor)
        response = client.get(_url(project_id, capture_id), headers=AUTH_HEADERS)
        after = _data_version(monitor)
    finally:
        client.close()
        monitor.close()

    assert response.status_code == 200
    payload = response.json()
    assert payload["captureId"] == capture_id
    assert payload["projectionSchemaVersion"] == 3
    assert payload["pages"][0]["normalizedCharCount"] == 5
    assert payload["pages"][0]["boxCount"] == 2
    assert runtime.calls == [
        ("get_capture", "runtime-capture-id"),
        ("get_ocr", "runtime-capture-id"),
    ]
    assert session_reads == [(project_id, capture_id), (project_id, capture_id)]
    assert provider.calls == []
    assert after == before
    assert not (_recursive_keys(payload) & FORBIDDEN_KEYS)
    assert "private-source.pdf" not in str(payload)
    assert "Bearer private-token" not in str(payload)


@pytest.mark.parametrize(
    "session_status",
    [review_sessions.PENDING, review_sessions.FAILED],
)
def test_failed_runtime_pair_returns_redacted_typed_evidence(
    tmp_path: Path,
    session_status: str,
) -> None:
    runtime = RecordingOcrRuntime(
        operation_status="failed",
        projection=_failed_projection(),
    )
    app, _provider = _app(tmp_path, runtime)
    project_id = _create_project(app)
    capture_id = _create_capture_session(
        app,
        project_id=project_id,
        session_status=session_status,
    )
    client = TestClient(app)
    try:
        response = client.get(_url(project_id, capture_id), headers=AUTH_HEADERS)
    finally:
        client.close()

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "failed"
    assert payload["failure"] == {"code": "worker_timeout", "retryable": True}
    assert payload["provenance"]["status"] == "unavailable"
    assert "private worker diagnostic" not in str(payload)
    assert "ocr-worker" not in str(payload)


def test_failed_durable_session_rejects_a_nonfailed_runtime_pair(tmp_path: Path) -> None:
    runtime = RecordingOcrRuntime()
    app, _provider = _app(tmp_path, runtime)
    project_id = _create_project(app)
    capture_id = _create_capture_session(
        app,
        project_id=project_id,
        session_status=review_sessions.FAILED,
    )
    client = TestClient(app)
    try:
        response = client.get(_url(project_id, capture_id), headers=AUTH_HEADERS)
    finally:
        client.close()

    assert response.status_code == 502
    assert runtime.calls == [("get_capture", "runtime-capture-id")]


@pytest.mark.parametrize(
    "session_status",
    [
        review_sessions.CONFIRMING,
        review_sessions.COMPLETED,
        review_sessions.CANCELED,
    ],
)
def test_closed_capture_states_return_gone_without_runtime_reads(
    tmp_path: Path,
    session_status: str,
) -> None:
    runtime = RecordingOcrRuntime()
    app, _provider = _app(tmp_path, runtime)
    project_id = _create_project(app)
    capture_id = _create_capture_session(
        app,
        project_id=project_id,
        session_status=session_status,
    )
    client = TestClient(app)
    try:
        response = client.get(_url(project_id, capture_id), headers=AUTH_HEADERS)
    finally:
        client.close()

    assert response.status_code == 410
    assert response.json() == {
        "code": "capture_closed",
        "message": "Capture review is closed.",
    }
    assert runtime.calls == []


@pytest.mark.parametrize("operation_status", ["created", "waiting_input", "extracting"])
def test_early_pending_runtime_states_return_conflict_without_projection_read(
    tmp_path: Path,
    operation_status: str,
) -> None:
    runtime = RecordingOcrRuntime(operation_status=operation_status)
    app, _provider = _app(tmp_path, runtime)
    project_id = _create_project(app)
    capture_id = _create_capture_session(app, project_id=project_id)
    client = TestClient(app)
    try:
        response = client.get(_url(project_id, capture_id), headers=AUTH_HEADERS)
    finally:
        client.close()

    assert response.status_code == 409
    assert response.json() == {
        "code": "ocr_summary_not_ready",
        "message": "OCR summary is not ready.",
    }
    assert runtime.calls == [("get_capture", "runtime-capture-id")]


def test_pending_session_without_runtime_identity_returns_conflict(tmp_path: Path) -> None:
    runtime = RecordingOcrRuntime()
    app, _provider = _app(tmp_path, runtime)
    project_id = _create_project(app)
    capture_id = _create_capture_session(
        app,
        project_id=project_id,
        runtime_capture_id=None,
    )
    client = TestClient(app)
    try:
        response = client.get(_url(project_id, capture_id), headers=AUTH_HEADERS)
    finally:
        client.close()

    assert response.status_code == 409
    assert runtime.calls == []


def test_absent_deleted_and_cross_project_captures_share_one_404_envelope(
    tmp_path: Path,
) -> None:
    runtime = RecordingOcrRuntime()
    app, _provider = _app(tmp_path, runtime)
    owner_project_id = _create_project(app, "Owner")
    other_project_id = _create_project(app, "Other")
    capture_id = _create_capture_session(app, project_id=owner_project_id)
    deleted_capture_id = _create_capture_session(app, project_id=owner_project_id)
    with app.state.database.connect() as connection:
        connection.execute(
            "DELETE FROM capture_review_sessions WHERE project_id = ? AND id = ?",
            (owner_project_id, deleted_capture_id),
        )
    client = TestClient(app)
    try:
        responses = [
            client.get(_url(owner_project_id, "absent"), headers=AUTH_HEADERS),
            client.get(_url(owner_project_id, deleted_capture_id), headers=AUTH_HEADERS),
            client.get(_url(other_project_id, capture_id), headers=AUTH_HEADERS),
        ]
    finally:
        client.close()

    for response in responses:
        assert response.status_code == 404
        assert response.json() == {
            "code": "not_found",
            "message": "Capture not found.",
        }
    assert runtime.calls == []


@pytest.mark.parametrize("failing_call", ["get_capture", "get_ocr"])
def test_deleted_runtime_capture_uses_the_same_generic_404(
    tmp_path: Path,
    failing_call: str,
) -> None:
    runtime = RecordingOcrRuntime(
        error_call=failing_call,
        error=_runtime_error(
            status_code=404,
            category="remote",
            code="capture_not_found",
        ),
    )
    app, _provider = _app(tmp_path, runtime)
    project_id = _create_project(app)
    capture_id = _create_capture_session(app, project_id=project_id)
    client = TestClient(app)
    try:
        response = client.get(_url(project_id, capture_id), headers=AUTH_HEADERS)
    finally:
        client.close()

    assert response.status_code == 404
    assert response.json() == {
        "code": "not_found",
        "message": "Capture not found.",
    }


def test_missing_stable_projection_is_sanitized_bad_gateway(tmp_path: Path) -> None:
    runtime = RecordingOcrRuntime(
        error_call="get_ocr",
        error=_runtime_error(
            status_code=409,
            category="remote",
            code="ocr_unavailable",
        ),
    )
    app, _provider = _app(tmp_path, runtime)
    project_id = _create_project(app)
    capture_id = _create_capture_session(app, project_id=project_id)
    client = TestClient(app)
    try:
        response = client.get(_url(project_id, capture_id), headers=AUTH_HEADERS)
    finally:
        client.close()

    assert response.status_code == 502
    assert response.json() == {
        "code": "capture_runtime_ocr_unavailable",
        "message": "Capture Runtime OCR summary is unavailable.",
    }


@pytest.mark.parametrize(
    "category",
    ["authentication", "compatibility", "protocol", "remote"],
)
def test_runtime_contract_and_projection_errors_are_sanitized_bad_gateway(
    tmp_path: Path,
    category: str,
) -> None:
    runtime = RecordingOcrRuntime(
        error_call="get_ocr",
        error=_runtime_error(status_code=409, category=category),
    )
    app, _provider = _app(tmp_path, runtime)
    project_id = _create_project(app)
    capture_id = _create_capture_session(app, project_id=project_id)
    client = TestClient(app)
    try:
        response = client.get(_url(project_id, capture_id), headers=AUTH_HEADERS)
    finally:
        client.close()

    assert response.status_code == 502
    assert response.json() == {
        "code": "capture_runtime_ocr_unavailable",
        "message": "Capture Runtime OCR summary is unavailable.",
    }
    assert "private-token" not in response.text
    assert "private runtime diagnostic" not in response.text


def test_transport_error_returns_sanitized_service_unavailable(tmp_path: Path) -> None:
    runtime = RecordingOcrRuntime(
        error_call="get_capture",
        error=_runtime_error(status_code=0, category="transport"),
    )
    app, _provider = _app(tmp_path, runtime)
    project_id = _create_project(app)
    capture_id = _create_capture_session(app, project_id=project_id)
    client = TestClient(app)
    try:
        response = client.get(_url(project_id, capture_id), headers=AUTH_HEADERS)
    finally:
        client.close()

    assert response.status_code == 503
    assert response.json() == {
        "code": "capture_runtime_unavailable",
        "message": "Capture Runtime is unavailable.",
    }


def test_projection_identity_drift_is_sanitized_bad_gateway(tmp_path: Path) -> None:
    projection = _completed_projection()
    projection.schema_version = "2"
    runtime = RecordingOcrRuntime(projection=projection)
    app, _provider = _app(tmp_path, runtime)
    project_id = _create_project(app)
    capture_id = _create_capture_session(app, project_id=project_id)
    client = TestClient(app)
    try:
        response = client.get(_url(project_id, capture_id), headers=AUTH_HEADERS)
    finally:
        client.close()

    assert response.status_code == 502
    assert response.json()["code"] == "capture_runtime_ocr_unavailable"


def test_final_project_scoped_read_closes_a_remote_race(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runtime = RecordingOcrRuntime()
    app, _provider = _app(tmp_path, runtime)
    project_id = _create_project(app)
    capture_id = _create_capture_session(app, project_id=project_id)
    original_get = review_sessions.get
    calls = 0

    def racing_get(*args, **kwargs):
        nonlocal calls
        calls += 1
        session = original_get(*args, **kwargs)
        if calls == 2:
            return {**session, "status": review_sessions.COMPLETED}
        return session

    monkeypatch.setattr(review_sessions, "get", racing_get)
    client = TestClient(app)
    try:
        response = client.get(_url(project_id, capture_id), headers=AUTH_HEADERS)
    finally:
        client.close()

    assert response.status_code == 410
    assert calls == 2
    assert runtime.calls == [
        ("get_capture", "runtime-capture-id"),
        ("get_ocr", "runtime-capture-id"),
    ]


def test_route_authentication_runs_before_durable_or_runtime_reads(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runtime = RecordingOcrRuntime()
    app, _provider = _app(tmp_path, runtime)
    project_id = _create_project(app)
    capture_id = _create_capture_session(app, project_id=project_id)
    session_reads = _record_session_reads(monkeypatch)
    client = TestClient(app)
    try:
        response = client.get(_url(project_id, capture_id))
    finally:
        client.close()

    assert response.status_code == 401
    assert session_reads == []
    assert runtime.calls == []


class RecordingOcrRuntime:
    def __init__(
        self,
        *,
        operation_status: str = "awaiting_structuring",
        projection: SimpleNamespace | None = None,
        error_call: str | None = None,
        error: CaptureRuntimeError | None = None,
    ) -> None:
        self.calls: list[tuple[str, str]] = []
        self.operation_status = operation_status
        self.projection = projection or _completed_projection()
        self.error_call = error_call
        self.error = error

    def get_capture(self, capture_id: str) -> SimpleNamespace:
        self.calls.append(("get_capture", capture_id))
        self._raise_if_configured("get_capture")
        return SimpleNamespace(
            capture_id=capture_id,
            status=_enum(self.operation_status),
            source=_source(),
        )

    def get_ocr(self, capture_id: str) -> SimpleNamespace:
        self.calls.append(("get_ocr", capture_id))
        self._raise_if_configured("get_ocr")
        return self.projection

    def _raise_if_configured(self, call: str) -> None:
        if self.error_call == call and self.error is not None:
            raise self.error

    def get_raw(self, _capture_id: str) -> object:
        raise AssertionError("OCR summary route must not read raw capture data.")

    def get_partial(self, _capture_id: str) -> object:
        raise AssertionError("OCR summary route must not read partial capture data.")

    def get_result(self, _capture_id: str) -> object:
        raise AssertionError("OCR summary route must not read a structured result.")

    def structure_capture(self, *_args, **_kwargs) -> object:
        raise AssertionError("OCR summary route must not structure a capture.")

    def commit_capture(self, *_args, **_kwargs) -> object:
        raise AssertionError("OCR summary route must not commit a capture.")


class ForbiddenProvider:
    provider = "forbidden"
    model = "forbidden"

    def __init__(self) -> None:
        self.calls: list[str] = []

    def health(self) -> object:
        self.calls.append("health")
        raise AssertionError("OCR summary route must not inspect the provider.")

    def generate_drafts(self, *_args, **_kwargs) -> list[object]:
        self.calls.append("generate_drafts")
        raise AssertionError("OCR summary route must not generate drafts.")

    def generate_structured_json(self, *_args, **_kwargs) -> str:
        self.calls.append("generate_structured_json")
        raise AssertionError("OCR summary route must not invoke structuring.")


def _app(tmp_path: Path, runtime: RecordingOcrRuntime):
    provider = ForbiddenProvider()
    app = create_app(
        Settings(data_dir=tmp_path, api_token=TOKEN, llm_provider="fake"),
        llm_provider=provider,
        capture_runtime_client=runtime,
        document_processing_async_jobs=False,
        runtime_installation_async_jobs=False,
        streaming_draft_generation_async_jobs=False,
    )
    provider.calls.clear()
    runtime.calls.clear()
    return app, provider


def _create_project(app, name: str = "OCR Summary") -> str:
    return projects_repository.create_project(
        app.state.database,
        ProjectCreate(name=name),
    )["id"]


def _create_capture_session(
    app,
    *,
    project_id: str,
    session_status: str = review_sessions.PENDING,
    runtime_capture_id: str | None = "runtime-capture-id",
) -> str:
    operation_id = str(uuid4())
    claim = operations.claim_operation(
        app.state.database,
        project_id=project_id,
        operation_id=operation_id,
    )
    assert claim.acquired
    document = operations.create_and_attach_document(
        app.state.database,
        project_id=project_id,
        operation_id=operation_id,
        filename="private-source.pdf",
        sha256="a" * 64,
        language_hint="auto",
        storage_path="C:/private/private-source.pdf",
        page_count=1,
    )
    session = review_sessions.create(
        app.state.database,
        project_id=project_id,
        document_id=document["id"],
        operation_id=operation_id,
    )
    if runtime_capture_id is not None:
        review_sessions.set_runtime_capture_id(
            app.state.database,
            project_id=project_id,
            session_id=session["id"],
            runtime_capture_id=runtime_capture_id,
        )
    if session_status != review_sessions.PENDING:
        with app.state.database.connect() as connection:
            connection.execute(
                "UPDATE capture_review_sessions SET status = ? WHERE project_id = ? AND id = ?",
                (session_status, project_id, session["id"]),
            )
    return session["id"]


def _record_session_reads(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, str]]:
    original_get = review_sessions.get
    calls: list[tuple[str, str]] = []

    def recording_get(db, *, project_id: str, session_id: str):
        calls.append((project_id, session_id))
        return original_get(db, project_id=project_id, session_id=session_id)

    monkeypatch.setattr(review_sessions, "get", recording_get)
    return calls


def _completed_projection() -> SimpleNamespace:
    provenance = _resolved_provenance()
    return SimpleNamespace(
        api_version="2.0",
        schema_version="3",
        capture_id="runtime-capture-id",
        status=_enum("completed"),
        source=_source(),
        pages=[
            SimpleNamespace(
                page=1,
                status=_enum("recognized"),
                text="\uff21\uff22\uff23\u00a0\r\n\U0001f600",
                boxes=[
                    SimpleNamespace(text="private box text", polygon=[(0, 0)] * 4),
                    SimpleNamespace(text="Bearer private-token", polygon=[(1, 1)] * 4),
                ],
                confidence=0.875,
                provenance=provenance,
                failure=None,
            )
        ],
        page_count=1,
        runtime_version="0.4.2",
        contract_sha256="d" * 64,
        provenance=provenance,
        failure=None,
    )


def _failed_projection() -> SimpleNamespace:
    failure = SimpleNamespace(
        code="worker_timeout",
        message="private worker diagnostic",
        stage="ocr-worker",
        retryable=True,
    )
    provenance = SimpleNamespace(
        status=_enum("unavailable"),
        profile_id="profile-1",
        profile_spec_sha256="c" * 64,
        reason=_enum("worker_timeout"),
    )
    return SimpleNamespace(
        api_version="2.0",
        schema_version="3",
        capture_id="runtime-capture-id",
        status=_enum("failed"),
        source=None,
        pages=[],
        page_count=0,
        runtime_version="0.4.2",
        contract_sha256="d" * 64,
        provenance=provenance,
        failure=failure,
    )


def _resolved_provenance() -> SimpleNamespace:
    return SimpleNamespace(
        status=_enum("resolved"),
        engine="windowsml-ocr",
        model="capture-ocr-model",
        model_digest="sha256:" + "b" * 64,
        device="directml:0",
        profile_id="profile-1",
        profile_spec_sha256="c" * 64,
    )


def _source() -> SimpleNamespace:
    return SimpleNamespace(
        sha256="a" * 64,
        file_name="private-source.pdf",
        media_type="application/pdf",
        bytes=1234,
    )


def _enum(value: str) -> SimpleNamespace:
    return SimpleNamespace(value=value)


def _runtime_error(
    *,
    status_code: int,
    category: str,
    code: str = "private_runtime_error",
) -> CaptureRuntimeError:
    return CaptureRuntimeError(
        status_code=status_code,
        code=code,
        message="private runtime diagnostic Bearer private-token",
        category=category,
    )


def _url(project_id: str, capture_id: str) -> str:
    return (
        f"/projects/{project_id}/capture-workbench/captures/"
        f"{capture_id}/ocr-summary"
    )


def _data_version(connection: sqlite3.Connection) -> int:
    return int(connection.execute("PRAGMA data_version").fetchone()[0])


def _recursive_keys(value: object) -> set[str]:
    if isinstance(value, dict):
        return {
            str(key).lower()
            for key in value
        } | set().union(*(_recursive_keys(item) for item in value.values()))
    if isinstance(value, list):
        return set().union(*(_recursive_keys(item) for item in value))
    return set()
