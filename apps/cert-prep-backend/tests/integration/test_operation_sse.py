from __future__ import annotations

import json
import queue
import threading
from dataclasses import asdict

import pytest
from fastapi.testclient import TestClient

from cert_prep_backend.api.app import create_app
from cert_prep_backend.api.sse import operation_snapshot_stream
from cert_prep_backend.core.config import Settings
from cert_prep_backend.domains.runtime_installations.manager import RuntimeInstallationManager
from cert_prep_backend.domains.source_documents import operations as document_operations
from cert_prep_backend.persistence.change_notifications import DatabaseChangeNotifier
from cert_prep_backend.persistence.database import Database
from cert_prep_contracts.runtime import (
    RuntimeInstallationStatus,
    RuntimeInstallProgress,
    RuntimeRequirementKind,
    RuntimeRequirementSnapshot,
)


def test_database_notifier_publishes_only_after_a_durable_write(tmp_path) -> None:
    notifier = DatabaseChangeNotifier()
    database = Database(Settings(data_dir=tmp_path), change_notifier=notifier)

    with database.connect() as connection:
        connection.execute("SELECT 1")
    assert notifier.revision() == 0

    with database.connect() as connection:
        connection.execute(
            """
            INSERT INTO projects(id, name, description, created_at, updated_at)
            VALUES ('project-1', 'Project', '', '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00')
            """
        )
    assert notifier.revision() == 1


def test_operation_snapshot_stream_emits_initial_change_and_terminal_frames() -> None:
    notifier = DatabaseChangeNotifier()
    state = {"status": "running", "value": 1}
    stream = operation_snapshot_stream(
        notifier=notifier,
        snapshot=lambda: dict(state),
        event_name="test-operation",
        is_terminal=lambda value: value["status"] == "succeeded",
        last_event_id="41",
    )

    initial = next(stream)
    assert initial.startswith("id: 42\nevent: test-operation\n")
    assert json.loads(initial.split("data: ", 1)[1]) == {
        "status": "running",
        "value": 1,
    }

    frames: queue.Queue[str] = queue.Queue()

    def read_next_frame() -> None:
        frames.put(next(stream))

    reader = threading.Thread(target=read_next_frame)
    reader.start()
    state["value"] = 2
    notifier.publish()
    changed = frames.get(timeout=1)
    reader.join(timeout=1)
    assert "id: 43\nevent: test-operation\n" in changed
    assert json.loads(changed.split("data: ", 1)[1]) == {
        "status": "running",
        "value": 2,
    }

    terminal_reader = threading.Thread(target=read_next_frame)
    terminal_reader.start()
    state["status"] = "succeeded"
    notifier.publish()
    terminal = frames.get(timeout=1)
    terminal_reader.join(timeout=1)
    assert "id: 44\nevent: test-operation\n" in terminal
    assert json.loads(terminal.split("data: ", 1)[1]) == {
        "status": "succeeded",
        "value": 2,
    }
    with pytest.raises(StopIteration):
        next(stream)


def test_operation_snapshot_stream_observes_revision_before_initial_snapshot() -> None:
    class OrderedNotifier(DatabaseChangeNotifier):
        revision_observed = False

        def revision(self) -> int:
            self.revision_observed = True
            return super().revision()

    notifier = OrderedNotifier()
    state = {"status": "running", "value": 1}

    def snapshot() -> dict[str, object]:
        assert notifier.revision_observed
        state["value"] = 2
        notifier.publish()
        return dict(state)

    stream = operation_snapshot_stream(
        notifier=notifier,
        snapshot=snapshot,
        event_name="test-operation",
        is_terminal=lambda value: value["status"] == "succeeded",
        last_event_id=None,
    )

    initial = next(stream)

    assert json.loads(initial.split("data: ", 1)[1]) == {
        "status": "running",
        "value": 2,
    }


@pytest.mark.parametrize(
    ("kind", "event_name"),
    [
        (RuntimeRequirementKind.OLLAMA, "runtime-installation"),
        (RuntimeRequirementKind.OLLAMA_MODEL, "model-download"),
    ],
)
def test_runtime_manager_db_commits_wake_operation_stream(
    tmp_path,
    kind: RuntimeRequirementKind,
    event_name: str,
) -> None:
    notifier = DatabaseChangeNotifier()
    settings = Settings(data_dir=tmp_path, api_token="test-token", llm_provider="fake")
    database = Database(settings, change_notifier=notifier)
    progress_emitted = threading.Event()
    release_install = threading.Event()

    class BlockingInstaller:
        provider = "test-installer"
        model = "test-model"

        def __init__(self, installer_kind: RuntimeRequirementKind) -> None:
            self.kind = installer_kind

        def requirement(self) -> RuntimeRequirementSnapshot:
            return RuntimeRequirementSnapshot(
                kind=self.kind,
                label="Test runtime requirement",
                available=False,
                detail="Test requirement is not installed.",
                unavailable_reason="test_missing",
                bytes=2,
            )

        def install(self, progress) -> RuntimeInstallationStatus:
            progress(
                RuntimeInstallProgress(
                    "Test installation is running.",
                    completed=1,
                    total=2,
                    phase="downloading",
                    cancellable=True,
                )
            )
            progress_emitted.set()
            release_install.wait(timeout=2)
            return RuntimeInstallationStatus.SUCCEEDED

    manager = RuntimeInstallationManager(
        settings=settings,
        llm_provider=object(),
        db=database,
        async_jobs=True,
        installers=[BlockingInstaller(kind)],
    )
    try:
        job = manager.start_installation(kind)
        assert progress_emitted.wait(timeout=1)
        stream = operation_snapshot_stream(
            notifier=notifier,
            snapshot=lambda: asdict(manager.get_installation(job.id)),
            event_name=event_name,
            is_terminal=lambda value: value["status"]
            in {
                RuntimeInstallationStatus.CANCELED,
                RuntimeInstallationStatus.SUCCEEDED,
                RuntimeInstallationStatus.FAILED,
            },
            last_event_id=None,
        )

        initial = next(stream)
        assert f"event: {event_name}" in initial

        release_install.set()
        terminal = next(stream)
        assert f"event: {event_name}" in terminal
        terminal_payload = json.loads(terminal.split("data: ", 1)[1].strip())
        assert terminal_payload["status"] == RuntimeInstallationStatus.SUCCEEDED
        assert notifier.revision() >= 3
    finally:
        release_install.set()
        manager.close()


def test_document_operation_events_route_streams_authenticated_terminal_snapshot(
    tmp_path,
) -> None:
    token = "route-token"
    settings = Settings(data_dir=tmp_path, api_token=token, llm_provider="fake")
    app = create_app(settings=settings)
    headers = {"Authorization": f"Bearer {token}"}

    with TestClient(app) as client:
        project_response = client.post(
            "/projects",
            headers=headers,
            json={"name": "SSE route smoke"},
        )
        assert project_response.status_code == 201
        project_id = project_response.json()["id"]
        operation_id = "route-terminal-operation"
        document_operations.claim_operation(
            app.state.database,
            project_id=project_id,
            operation_id=operation_id,
        )
        document_operations.finish_failed(
            app.state.database,
            project_id=project_id,
            operation_id=operation_id,
            error="Route smoke terminal state.",
        )
        path = f"/projects/{project_id}/document-operations/{operation_id}/events"

        assert client.get(path).status_code == 401
        with client.stream(
            "GET",
            path,
            headers={**headers, "Last-Event-ID": "7"},
        ) as response:
            assert response.status_code == 200
            assert response.headers["content-type"].startswith("text/event-stream")
            assert response.headers["cache-control"] == "no-store"
            body = response.read().decode()

    assert body.startswith("id: 8\nevent: document-operation\ndata: ")
    payload = json.loads(body.split("data: ", 1)[1].strip())
    assert payload["operation"]["id"] == operation_id
    assert payload["operation"]["status"] == "failed"


def test_document_operation_events_active_route_does_not_expose_recovered_operation(
    tmp_path,
) -> None:
    token = "restart-token"
    settings = Settings(data_dir=tmp_path, api_token=token, llm_provider="fake")
    headers = {"Authorization": f"Bearer {token}"}
    first_app = create_app(settings=settings)

    with TestClient(first_app) as client:
        project_response = client.post(
            "/projects",
            headers=headers,
            json={"name": "Restart recovery smoke"},
        )
        assert project_response.status_code == 201
        project_id = project_response.json()["id"]
        operation_id = "restart-active-operation"
        document_operations.claim_operation(
            first_app.state.database,
            project_id=project_id,
            operation_id=operation_id,
        )
        document = document_operations.create_and_attach_document(
            first_app.state.database,
            project_id=project_id,
            operation_id=operation_id,
            filename="restart.pdf",
            sha256="a" * 64,
            language_hint="en",
            storage_path=str(tmp_path / "restart.pdf"),
            page_count=1,
        )
        document_id = document["id"]
        assert (
            document_operations.get_active_operation_for_document(
                first_app.state.database,
                project_id=project_id,
                document_id=document_id,
            )
            is not None
        )

    recovered_app = create_app(settings=settings)
    with TestClient(recovered_app) as client:
        active_path = (
            f"/projects/{project_id}/documents/{document_id}/document-operation/events"
        )
        assert client.get(active_path, headers=headers).status_code == 404

        terminal_path = (
            f"/projects/{project_id}/document-operations/{operation_id}/events"
        )
        with client.stream("GET", terminal_path, headers=headers) as response:
            assert response.status_code == 200
            body = response.read().decode()

    payload = json.loads(body.split("data: ", 1)[1].strip())
    assert payload["operation"]["status"] == "failed"
    assert payload["document"]["status"] == "ocr_failed"
