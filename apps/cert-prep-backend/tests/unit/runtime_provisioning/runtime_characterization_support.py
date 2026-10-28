from __future__ import annotations

from datetime import UTC, datetime, timedelta
from importlib import import_module
from itertools import count
from threading import Event, Thread
from uuid import UUID

import pytest

from cert_prep_backend.platform.config import Settings
from cert_prep_backend.runtime_provisioning.infrastructure import manager as manager_module
from cert_prep_contracts.runtime import (
    RuntimeInstallationStatus as Status,
    RuntimeRequirementKind as Kind,
    RuntimeRequirementSnapshot,
)


class ScriptedInstaller:
    provider = "test-provider"
    model = "test-model"

    def __init__(self, kind=Kind.OLLAMA):
        self.kind = kind
        self.available = False
        self.bytes = 80
        self.validation_error = None
        self.calls = []
        self.action = lambda progress: Status.SUCCEEDED
        self.progress = None
        self.on_cancel = lambda: None

    def requirement(self):
        self.calls.append("requirement")
        return RuntimeRequirementSnapshot(
            kind=self.kind,
            label="Test requirement",
            available=self.available,
            detail="Manual setup required",
            unavailable_reason=None if self.available else "test_missing",
            bytes=self.bytes,
        )

    def validate_installable(self):
        self.calls.append("validate")
        if self.validation_error is not None:
            raise self.validation_error

    def install(self, progress):
        self.calls.append("install")
        self.progress = progress
        return self.action(progress)

    def cancel(self):
        self.calls.append("cancel")
        self.on_cancel()


@pytest.fixture(autouse=True)
def no_ollama_start(monkeypatch):
    # Patch imported aliases too: patching only server.py misses these callers.
    def forbidden(*args, **kwargs):
        raise AssertionError("Characterization must use a fake installer/provider")

    for name in (
        "cert_prep_ollama",
        "cert_prep_ollama.server",
        "cert_prep_ollama.installers",
        "cert_prep_ollama.profile_installer",
        "cert_prep_backend.ai_providers.infrastructure.ollama_transport",
    ):
        monkeypatch.setattr(import_module(name), "ensure_ollama_server_running", forbidden)


@pytest.fixture(autouse=True)
def runtime_clock(monkeypatch):
    ticks = count()
    ids = count(1)
    times = []

    def now():
        value = datetime(2026, 1, 1, tzinfo=UTC) + timedelta(seconds=next(ticks))
        times.append(value)
        return value

    monkeypatch.setattr(manager_module, "utcnow", now)
    monkeypatch.setattr(manager_module, "uuid4", lambda: UUID(int=next(ids)))
    return times


@pytest.fixture
def installer():
    return ScriptedInstaller()


@pytest.fixture
def worker_gates(monkeypatch):
    """Real workers paused before entry; explicit events replace scheduling sleeps."""
    gates = []
    errors = []

    def thread_factory(*, target, args, **kwargs):
        release, done = Event(), Event()

        def run():
            try:
                assert release.wait(timeout=10), "worker gate was never released"
                target(*args)
            except BaseException as exc:
                errors.append(exc)
            finally:
                done.set()

        worker = Thread(target=run, **kwargs)
        gates.append((release, done, worker))
        return worker

    monkeypatch.setattr(manager_module, "Thread", thread_factory)
    yield gates
    for release, done, worker in gates:
        release.set()
        worker.join(timeout=10)
        assert done.is_set(), "worker did not finish"
    assert errors == []


@pytest.fixture
def make_manager(tmp_path, installer, worker_gates):
    managers = []

    def make(*, installers=None, db=None, async_jobs=False):
        instance = manager_module.RuntimeInstallationManager(
            settings=Settings(data_dir=tmp_path, llm_provider="fake"),
            llm_provider=object(),
            machine_inventory=object(),
            db=db,
            async_jobs=async_jobs,
            installers=[installer] if installers is None else installers,
        )
        managers.append(instance)
        return instance

    yield make
    for release, done, worker in worker_gates:
        release.set()
        worker.join(timeout=10)
        assert done.is_set(), "worker did not finish before manager cleanup"
    for instance in managers:
        instance.close()
