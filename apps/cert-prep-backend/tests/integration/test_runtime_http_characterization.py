from __future__ import annotations

import json
from importlib import import_module
from threading import Event, Thread

import pytest
from fastapi.testclient import TestClient

from cert_prep_backend.api.app import create_app
from cert_prep_backend.platform.config import Settings
from cert_prep_backend.platform.errors import ProviderUnavailableError
from cert_prep_backend.runtime_provisioning.infrastructure.manager import RuntimeInstallationManager
from cert_prep_contracts.runtime import (
    RuntimeInstallationStatus as Status,
    RuntimeInstallProgress as Progress,
    RuntimeRequirementKind as Kind,
    RuntimeRequirementSnapshot,
)


AUTH = {"Authorization": "Bearer test-token"}


class HttpCharacterizationInstaller:
    provider = "test-provider"
    model = "test-model"

    def __init__(self, kind):
        self.kind = kind
        self.available = False
        self.error = None
        self.action = lambda progress: Status.SUCCEEDED

    def requirement(self):
        return RuntimeRequirementSnapshot(
            kind=self.kind, label="HTTP test requirement", available=self.available,
            detail="Manual setup required", unavailable_reason="test_missing", bytes=12,
        )

    def validate_installable(self):
        if self.error:
            raise ProviderUnavailableError(self.error)

    def install(self, progress):
        return self.action(progress)


@pytest.fixture
def runtime_http(tmp_path, monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("HTTP characterization must never start Ollama")

    for module in (
        "cert_prep_ollama", "cert_prep_ollama.server", "cert_prep_ollama.installers",
        "cert_prep_ollama.profile_installer",
        "cert_prep_backend.ai_providers.infrastructure.ollama_transport",
    ):
        monkeypatch.setattr(import_module(module), "ensure_ollama_server_running", forbidden)
    settings = Settings(data_dir=tmp_path, api_token="test-token", llm_provider="fake")
    app = create_app(settings=settings)
    installers = {kind: HttpCharacterizationInstaller(kind) for kind in Kind}
    manager = RuntimeInstallationManager(
        settings=settings, llm_provider=object(), machine_inventory=object(),
        db=app.state.database, async_jobs=False, installers=list(installers.values()),
    )
    app.state.runtime_installation_manager = manager
    with TestClient(app) as client:
        yield client, app, manager, installers


@pytest.mark.parametrize("kind,prefix,event", [
    (Kind.OLLAMA, "/runtime/installations", "runtime-installation"),
    (Kind.OLLAMA_MODEL, "/llm/model-downloads", "model-download"),
])
def test_runtime_http_ready_poll_cancel_and_terminal_sse(runtime_http, kind, prefix, event):
    client, app, manager, installers = runtime_http
    installers[kind].available = True
    start = f"{prefix}/{kind}" if kind == Kind.OLLAMA else prefix
    first = client.post(start, headers=AUTH)
    assert first.status_code == 202
    job = first.json()
    assert job["status"] == "succeeded"
    assert ("kind" in job) == (kind == Kind.OLLAMA)
    second = client.post(start, headers=AUTH)
    assert second.status_code == 202 and second.json()["id"] != job["id"]
    path = f"{prefix}/{job['id']}"
    assert client.get(path, headers=AUTH).json() == job
    assert client.delete(path, headers=AUTH).json() == job
    for cursor, sequence in [(None, 1), ("7", 8), ("invalid", 1)]:
        headers = AUTH if cursor is None else {**AUTH, "Last-Event-ID": cursor}
        response = client.get(f"{path}/events", headers=headers)
        assert response.status_code == 200
        assert response.headers["cache-control"] == "no-store"
        assert response.headers["x-accel-buffering"] == "no"
        assert response.headers["content-type"].startswith("text/event-stream")
        assert response.text.startswith(f"id: {sequence}\nevent: {event}\ndata: ")
        assert response.text.endswith("\n\n")
        assert response.text.count("event:") == 1
        assert json.loads(response.text.split("data: ", 1)[1]) == job


@pytest.mark.parametrize("prefix,start", [
    ("/runtime/installations", "/runtime/installations/ollama"),
    ("/llm/model-downloads", "/llm/model-downloads"),
])
def test_runtime_http_auth_missing_and_validation_envelopes(runtime_http, prefix, start):
    client, app, manager, installers = runtime_http
    assert client.post(start).status_code == 401
    assert client.get(f"{prefix}/missing").status_code == 401
    assert client.get(f"{prefix}/missing/events").status_code == 401
    for method, suffix in [("GET", ""), ("DELETE", ""), ("GET", "/events")]:
        response = client.request(method, f"{prefix}/missing{suffix}", headers=AUTH)
        assert response.status_code == 404
        assert response.json() == {
            "code": "not_found",
            "message": "Runtime installation job was not found." if prefix.startswith("/runtime")
            else "Model download job was not found.",
        }
    for installer in installers.values():
        installer.error = "test unsupported provider"
    response = client.post(start, headers=AUTH)
    assert response.status_code == 503
    assert response.json() == {"code": "provider_unavailable", "message": "test unsupported provider"}


def test_runtime_http_requirements_invalid_kind_waiting_reuse_and_restart(runtime_http):
    client, app, manager, installers = runtime_http
    assert client.get("/runtime/requirements").status_code == 401
    response = client.get("/runtime/requirements", headers=AUTH)
    assert response.status_code == 200
    assert [item["kind"] for item in response.json()["items"]] == [kind.value for kind in Kind]
    assert client.post("/runtime/installations/invalid", headers=AUTH).status_code == 422
    installers[Kind.OLLAMA].action = lambda progress: Status.WAITING_FOR_USER
    started = client.post("/runtime/installations/ollama", headers=AUTH).json()
    assert started["status"] == "waiting_for_user"
    reused = client.post("/runtime/installations/ollama", headers=AUTH).json()
    assert reused == started
    path = f"/runtime/installations/{started['id']}"
    assert client.get(path, headers=AUTH).json() == started
    requested = client.delete(path, headers=AUTH).json()
    assert requested["status"] == "cancel_requested"
    assert client.get(path, headers=AUTH).json() == requested
    restarted = RuntimeInstallationManager(
        settings=app.state.settings, llm_provider=object(), machine_inventory=object(),
        db=app.state.database, async_jobs=False, installers=list(installers.values()),
    )
    app.state.runtime_installation_manager = restarted
    assert client.get(path, headers=AUTH).json()["status"] == "canceled"
    retried = client.post("/runtime/installations/ollama", headers=AUTH).json()
    assert retried["id"] != started["id"]
    installers[Kind.OLLAMA].available = True
    assert client.get(f"/runtime/installations/{retried['id']}", headers=AUTH).json()["status"] == "succeeded"


@pytest.mark.parametrize("kind,prefix", [
    (Kind.OLLAMA, "/runtime/installations"),
    (Kind.OLLAMA_MODEL, "/llm/model-downloads"),
])
def test_runtime_http_commit_and_committed_rejections(runtime_http, kind, prefix):
    client, app, manager, installers = runtime_http
    observed = []

    def install(progress):
        progress(Progress("commit", 4, 12, "committing", False))
        job_id = next(iter(manager._jobs))
        observed.append(client.get(f"{prefix}/{job_id}", headers=AUTH).json())
        rejected = client.delete(f"{prefix}/{job_id}", headers=AUTH)
        assert rejected.status_code == 409
        assert rejected.json() == {
            "code": "operation_not_cancellable",
            "message": "Runtime installation is committing and can no longer be canceled.",
        }
        return Status.SUCCEEDED

    installers[kind].action = install
    start = f"{prefix}/{kind}" if kind == Kind.OLLAMA else prefix
    response = client.post(start, headers=AUTH)
    assert response.status_code == 202
    assert observed[0]["phase"] == "committing"
    assert observed[0]["commit_started_at"] is not None
    result = response.json()
    rejected = client.delete(f"{prefix}/{result['id']}", headers=AUTH)
    assert rejected.status_code == 409
    assert rejected.json() == {
        "code": "operation_not_cancellable",
        "message": "Runtime installation committed and can no longer be canceled.",
    }


@pytest.mark.parametrize("kind,prefix", [
    (Kind.OLLAMA, "/runtime/installations"),
    (Kind.OLLAMA_MODEL, "/llm/model-downloads"),
])
def test_runtime_http_before_worker_start_cancel_retry_and_failure(
    runtime_http, monkeypatch, kind, prefix,
):
    from cert_prep_backend.runtime_provisioning.infrastructure import manager as module

    client, app, previous, installers = runtime_http
    gates, failures = [], []

    def worker_factory(*, target, args, **kwargs):
        release, done = Event(), Event()

        def run():
            try:
                assert release.wait(timeout=10)
                target(*args)
            except BaseException as exc:
                failures.append(exc)
            finally:
                done.set()

        worker = Thread(target=run, **kwargs)
        gates.append((release, done, worker))
        return worker

    monkeypatch.setattr(module, "Thread", worker_factory)
    manager = RuntimeInstallationManager(
        settings=app.state.settings, llm_provider=object(), machine_inventory=object(),
        db=app.state.database, async_jobs=True, installers=list(installers.values()),
    )
    app.state.runtime_installation_manager = manager
    start = f"{prefix}/{kind}" if kind == Kind.OLLAMA else prefix
    try:
        first = client.post(start, headers=AUTH).json()
        assert first["status"] == "queued"
        assert client.post(start, headers=AUTH).json() == first
        path = f"{prefix}/{first['id']}"
        canceled = client.delete(path, headers=AUTH).json()
        assert canceled["status"] == "canceled"
        assert client.delete(path, headers=AUTH).json() == canceled
        gates[0][0].set()
        assert gates[0][1].wait(timeout=10)
        assert client.get(path, headers=AUTH).json() == canceled

        def fail(progress):
            progress(Progress("partial", 1, 12))
            raise RuntimeError("test installer failure")

        installers[kind].action = fail
        retry = client.post(start, headers=AUTH).json()
        assert retry["status"] == "queued" and retry["id"] != first["id"]
        gates[1][0].set()
        assert gates[1][1].wait(timeout=10)
        failed = client.get(f"{prefix}/{retry['id']}", headers=AUTH).json()
        assert failed["status"] == "failed"
        assert failed["error"] == "test installer failure"
    finally:
        for release, done, worker in gates:
            release.set()
            worker.join(timeout=10)
            assert done.is_set()
        manager.close()
    assert failures == []


@pytest.mark.parametrize("kind,prefix,event", [
    (Kind.OLLAMA, "/runtime/installations", "runtime-installation"),
    (Kind.OLLAMA_MODEL, "/llm/model-downloads", "model-download"),
])
def test_runtime_http_sse_controlled_heartbeat_then_waiting_becomes_ready(
    runtime_http, monkeypatch, kind, prefix, event,
):
    client, app, manager, installers = runtime_http
    installer = installers[kind]
    installer.action = lambda progress: Status.WAITING_FOR_USER
    start = f"{prefix}/{kind}" if kind == Kind.OLLAMA else prefix
    job = client.post(start, headers=AUTH).json()
    waits = []

    def wait_for_change(revision, *, timeout_seconds):
        waits.append(timeout_seconds)
        if len(waits) == 1:
            return revision
        assert len(waits) == 2
        installer.available = True
        return revision + 1

    monkeypatch.setattr(app.state.database_change_notifier, "wait_for_change", wait_for_change)
    response = client.get(
        f"{prefix}/{job['id']}/events", headers={**AUTH, "Last-Event-ID": "40"},
    )
    assert response.status_code == 200
    frames = response.text.split("\n\n")
    assert frames[-1] == ""
    assert frames[0].startswith(f"id: 41\nevent: {event}\ndata: ")
    assert json.loads(frames[0].split("data: ", 1)[1])["status"] == "waiting_for_user"
    assert frames[1] == ": cert-prep heartbeat"
    assert frames[2].startswith(f"id: 42\nevent: {event}\ndata: ")
    terminal = json.loads(frames[2].split("data: ", 1)[1])
    assert terminal["status"] == "succeeded"
    assert ("kind" in terminal) == (kind == Kind.OLLAMA)
    assert waits == [15.0, 15.0]


def test_runtime_http_evicted_ids_are_missing_while_database_keeps_history(runtime_http):
    client, app, manager, installers = runtime_http
    installers[Kind.OLLAMA].available = True
    jobs = []
    for _ in range(103):
        response = client.post("/runtime/installations/ollama", headers=AUTH)
        assert response.status_code == 202
        jobs.append(response.json()["id"])
    assert list(manager._jobs) == jobs[3:]
    for prefix in ("/runtime/installations", "/llm/model-downloads"):
        assert client.get(f"{prefix}/{jobs[0]}", headers=AUTH).status_code == 404
        assert client.get(f"{prefix}/{jobs[0]}/events", headers=AUTH).status_code == 404
        newest = client.get(f"{prefix}/{jobs[-1]}", headers=AUTH)
        assert newest.status_code == 200
        # Current model-download reads accept a runtime-kind job too.
        assert ("kind" in newest.json()) == prefix.startswith("/runtime")
    with app.state.database.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM runtime_installation_jobs").fetchone()[0] == 103
