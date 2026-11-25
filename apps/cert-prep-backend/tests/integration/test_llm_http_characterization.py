from __future__ import annotations

import json
from importlib import import_module
from threading import Event, Thread

import pytest
from fastapi.testclient import TestClient

from cert_prep_backend.bootstrap.app import create_app
from cert_prep_backend.platform.config import Settings
from cert_prep_backend.platform.errors import InstallerUnavailable
from cert_prep_backend.llm_provisioning.infrastructure.manager import LLMInstallationManager
from cert_prep_contracts.llm_installation import (
    LLMInstallationStatus as Status,
    LLMInstallProgress as Progress,
    LLMRequirementKind as Kind,
    LLMRequirementSnapshot,
)


AUTH = {"Authorization": "Bearer test-token"}
INSTALLATIONS = "/llm/installations"
INSTALLATION_EVENT = "llm-installation"


class HttpCharacterizationInstaller:
    provider = "test-provider"
    model = "test-model"

    def __init__(self, kind):
        self.kind = kind
        self.available = False
        self.error = None
        self.action = lambda progress: Status.SUCCEEDED

    def requirement(self):
        return LLMRequirementSnapshot(
            kind=self.kind, label="HTTP test requirement", available=self.available,
            detail="Manual setup required", unavailable_reason="test_missing", bytes=12,
        )

    def validate_installable(self):
        if self.error:
            raise InstallerUnavailable(self.error)

    def install(self, progress):
        return self.action(progress)


@pytest.fixture
def llm_http(tmp_path, monkeypatch):
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
    manager = LLMInstallationManager(
        settings=settings, llm_provider=object(), machine_inventory=object(),
        db=app.state.database, async_jobs=False, installers=list(installers.values()),
    )
    app.state.llm_installation_manager = manager
    with TestClient(app) as client:
        yield client, app, manager, installers


@pytest.mark.parametrize("kind", list(Kind))
def test_llm_http_ready_poll_cancel_and_terminal_sse(llm_http, kind):
    client, app, manager, installers = llm_http
    installers[kind].available = True
    first = client.post(INSTALLATIONS, headers=AUTH, json={"kind": kind})
    assert first.status_code == 202
    job = first.json()
    assert job["status"] == "succeeded"
    assert job["kind"] == kind
    second = client.post(INSTALLATIONS, headers=AUTH, json={"kind": kind})
    assert second.status_code == 202 and second.json()["id"] != job["id"]
    path = f"{INSTALLATIONS}/{job['id']}"
    assert client.get(path, headers=AUTH).json() == job
    assert client.delete(path, headers=AUTH).json() == job
    for cursor, sequence in [(None, 1), ("7", 8), ("invalid", 1)]:
        headers = AUTH if cursor is None else {**AUTH, "Last-Event-ID": cursor}
        response = client.get(f"{path}/events", headers=headers)
        assert response.status_code == 200
        assert response.headers["cache-control"] == "no-store"
        assert response.headers["x-accel-buffering"] == "no"
        assert response.headers["content-type"].startswith("text/event-stream")
        assert response.text.startswith(f"id: {sequence}\nevent: {INSTALLATION_EVENT}\ndata: ")
        assert response.text.endswith("\n\n")
        assert response.text.count("event:") == 1
        assert json.loads(response.text.split("data: ", 1)[1]) == job


@pytest.mark.parametrize("kind", list(Kind))
def test_llm_http_auth_missing_and_validation_envelopes(llm_http, kind):
    client, app, manager, installers = llm_http
    assert client.post(INSTALLATIONS, json={"kind": kind}).status_code == 401
    assert client.get(f"{INSTALLATIONS}/missing").status_code == 401
    assert client.get(f"{INSTALLATIONS}/missing/events").status_code == 401
    for method, suffix in [("GET", ""), ("DELETE", ""), ("GET", "/events")]:
        response = client.request(method, f"{INSTALLATIONS}/missing{suffix}", headers=AUTH)
        assert response.status_code == 404
        assert response.json() == {
            "code": "not_found",
            "message": "LLM installation job was not found.",
        }
    for installer in installers.values():
        installer.error = "test unsupported provider"
    response = client.post(INSTALLATIONS, headers=AUTH, json={"kind": kind})
    assert response.status_code == 503
    assert response.json() == {"code": "provider_unavailable", "message": "test unsupported provider"}


def test_llm_http_requirements_invalid_kind_waiting_reuse_and_restart(llm_http):
    client, app, manager, installers = llm_http
    assert client.get("/llm/requirements").status_code == 401
    response = client.get("/llm/requirements", headers=AUTH)
    assert response.status_code == 200
    assert [item["kind"] for item in response.json()["items"]] == [kind.value for kind in Kind]
    for body in ({}, {"kind": "invalid"}):
        assert client.post(INSTALLATIONS, headers=AUTH, json=body).status_code == 422
    installers[Kind.OLLAMA].action = lambda progress: Status.WAITING_FOR_USER
    started = client.post(INSTALLATIONS, headers=AUTH, json={"kind": Kind.OLLAMA}).json()
    assert started["status"] == "waiting_for_user"
    reused = client.post(INSTALLATIONS, headers=AUTH, json={"kind": Kind.OLLAMA}).json()
    assert reused == started
    path = f"/llm/installations/{started['id']}"
    assert client.get(path, headers=AUTH).json() == started
    requested = client.delete(path, headers=AUTH).json()
    assert requested["status"] == "cancel_requested"
    assert client.get(path, headers=AUTH).json() == requested
    restarted = LLMInstallationManager(
        settings=app.state.settings, llm_provider=object(), machine_inventory=object(),
        db=app.state.database, async_jobs=False, installers=list(installers.values()),
    )
    app.state.llm_installation_manager = restarted
    assert client.get(path, headers=AUTH).json()["status"] == "canceled"
    retried = client.post(INSTALLATIONS, headers=AUTH, json={"kind": Kind.OLLAMA}).json()
    assert retried["id"] != started["id"]
    installers[Kind.OLLAMA].available = True
    assert client.get(f"/llm/installations/{retried['id']}", headers=AUTH).json()["status"] == "succeeded"


@pytest.mark.parametrize("kind", list(Kind))
def test_llm_http_commit_and_committed_rejections(llm_http, kind):
    client, app, manager, installers = llm_http
    observed = []

    def install(progress):
        progress(Progress("commit", 4, 12, "committing", False))
        job_id = next(iter(manager._jobs))
        observed.append(client.get(f"{INSTALLATIONS}/{job_id}", headers=AUTH).json())
        rejected = client.delete(f"{INSTALLATIONS}/{job_id}", headers=AUTH)
        assert rejected.status_code == 409
        assert rejected.json() == {
            "code": "operation_not_cancellable",
            "message": "LLM installation is committing and can no longer be canceled.",
        }
        return Status.SUCCEEDED

    installers[kind].action = install
    response = client.post(INSTALLATIONS, headers=AUTH, json={"kind": kind})
    assert response.status_code == 202
    assert observed[0]["phase"] == "committing"
    assert observed[0]["commit_started_at"] is not None
    result = response.json()
    rejected = client.delete(f"{INSTALLATIONS}/{result['id']}", headers=AUTH)
    assert rejected.status_code == 409
    assert rejected.json() == {
        "code": "operation_not_cancellable",
        "message": "LLM installation committed and can no longer be canceled.",
    }


@pytest.mark.parametrize("kind", list(Kind))
def test_llm_http_before_worker_start_cancel_retry_and_failure(
    llm_http, monkeypatch, kind,
):
    from cert_prep_backend.llm_provisioning.infrastructure import manager as module

    client, app, previous, installers = llm_http
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
    manager = LLMInstallationManager(
        settings=app.state.settings, llm_provider=object(), machine_inventory=object(),
        db=app.state.database, async_jobs=True, installers=list(installers.values()),
    )
    app.state.llm_installation_manager = manager
    try:
        first = client.post(INSTALLATIONS, headers=AUTH, json={"kind": kind}).json()
        assert first["status"] == "queued"
        assert client.post(INSTALLATIONS, headers=AUTH, json={"kind": kind}).json() == first
        path = f"{INSTALLATIONS}/{first['id']}"
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
        retry = client.post(INSTALLATIONS, headers=AUTH, json={"kind": kind}).json()
        assert retry["status"] == "queued" and retry["id"] != first["id"]
        gates[1][0].set()
        assert gates[1][1].wait(timeout=10)
        failed = client.get(f"{INSTALLATIONS}/{retry['id']}", headers=AUTH).json()
        assert failed["status"] == "failed"
        assert failed["error"] == "test installer failure"
    finally:
        for release, done, worker in gates:
            release.set()
            worker.join(timeout=10)
            assert done.is_set()
        manager.close()
    assert failures == []


@pytest.mark.parametrize("kind", list(Kind))
def test_llm_http_sse_controlled_heartbeat_then_waiting_becomes_ready(
    llm_http, monkeypatch, kind,
):
    client, app, manager, installers = llm_http
    installer = installers[kind]
    installer.action = lambda progress: Status.WAITING_FOR_USER
    job = client.post(INSTALLATIONS, headers=AUTH, json={"kind": kind}).json()
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
        f"{INSTALLATIONS}/{job['id']}/events", headers={**AUTH, "Last-Event-ID": "40"},
    )
    assert response.status_code == 200
    frames = response.text.split("\n\n")
    assert frames[-1] == ""
    assert frames[0].startswith(f"id: 41\nevent: {INSTALLATION_EVENT}\ndata: ")
    assert json.loads(frames[0].split("data: ", 1)[1])["status"] == "waiting_for_user"
    assert frames[1] == ": cert-prep heartbeat"
    assert frames[2].startswith(f"id: 42\nevent: {INSTALLATION_EVENT}\ndata: ")
    terminal = json.loads(frames[2].split("data: ", 1)[1])
    assert terminal["status"] == "succeeded"
    assert terminal["kind"] == kind
    assert waits == [15.0, 15.0]


def test_llm_http_evicted_ids_are_missing_while_database_keeps_history(llm_http):
    client, app, manager, installers = llm_http
    installers[Kind.OLLAMA].available = True
    jobs = []
    for _ in range(103):
        response = client.post(INSTALLATIONS, headers=AUTH, json={"kind": Kind.OLLAMA})
        assert response.status_code == 202
        jobs.append(response.json()["id"])
    assert list(manager._jobs) == jobs[3:]
    assert client.get(f"{INSTALLATIONS}/{jobs[0]}", headers=AUTH).status_code == 404
    assert client.get(f"{INSTALLATIONS}/{jobs[0]}/events", headers=AUTH).status_code == 404
    newest = client.get(f"{INSTALLATIONS}/{jobs[-1]}", headers=AUTH)
    assert newest.status_code == 200
    assert newest.json()["kind"] == Kind.OLLAMA
    with app.state.database.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM runtime_installation_jobs").fetchone()[0] == 103
