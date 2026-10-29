"""Application workflows tested against fake ports, without threads or SQLite."""

from dataclasses import replace
from datetime import UTC, datetime, timedelta
from itertools import count
from threading import RLock
from types import SimpleNamespace

import pytest

from cert_prep_backend.platform.errors import OperationNotCancellableError, ProviderUnavailableError
from cert_prep_backend.runtime_provisioning.application import use_cases as cases
from cert_prep_backend.runtime_provisioning.application.ports import RuntimeInstallation
from cert_prep_backend.runtime_provisioning.domain.installation import (
    RuntimeInstallationCanceledError,
    RuntimeInstallationJob,
    RuntimeInstallationPhase,
    RuntimeInstallationTarget,
)
from cert_prep_contracts.runtime import (
    RuntimeInstallationStatus as Status,
    RuntimeInstallProgress as Progress,
    RuntimeRequirementKind as Kind,
)
from runtime_characterization_support import ScriptedInstaller


class FakeJobs:
    def __init__(self):
        self.lock = RLock()
        self.persistent = False
        self.rows = {}
        self.writes = []
        self.recovery_times = []

    def require(self, job_id):
        return self.rows[job_id]

    def find_active_or_create(self, target, create_fn):
        with self.lock:
            for job in self.rows.values():
                if job.kind == target.kind and job.is_active:
                    return job, False
            return self.add(create_fn()), True

    def add(self, job):
        self.save(job)
        return job

    def save(self, job):
        self.rows[job.id] = job
        self.writes.append(job)

    def list_all(self):
        return list(self.rows.values())

    def recover(self, now):
        self.recovery_times.append(now)
        recovered = [job.recover_after_restart(now=now) for job in self.rows.values()]
        self.rows = {job.id: job for job in recovered}
        return recovered


class FakeInstallers:
    def __init__(self, *installers):
        self.items = {installer.kind: installer for installer in installers}
        self.selected_model_kind = Kind.OLLAMA_MODEL

    def get(self, kind):
        return self.items.get(kind)

    def ordered(self):
        return [self.items[kind] for kind in Kind if kind in self.items]


class FakeWork:
    def __init__(self):
        self.signals = {}
        self.pending = []
        self.owned_workers = []
        self.joined = []
        self.on_schedule = lambda: None

    def prepare(self, job_id):
        self.signals[job_id] = False

    def schedule(self, job_id, action):
        self.on_schedule()
        self.pending.append((job_id, action))

    def signal_cancellation(self, job_id):
        if job_id in self.signals:
            self.signals[job_id] = True

    def cancellation_requested(self, job_id):
        return self.signals.get(job_id, False)

    def workers(self):
        return list(self.owned_workers)

    def join_workers(self, workers):
        self.joined.extend(workers)

    def run(self):
        _, action = self.pending.pop(0)
        action()


@pytest.fixture
def runtime():
    ticks, ids = count(), count()
    installer = ScriptedInstaller()
    services = RuntimeInstallation(
        FakeJobs(), FakeInstallers(installer), FakeWork(),
        lambda: datetime(2026, 1, 1, tzinfo=UTC) + timedelta(seconds=next(ticks)),
        lambda: f"job-{next(ids)}",
    )
    return services


def queued(runtime, *, kind=Kind.OLLAMA, job_id="saved", status=Status.QUEUED):
    job = RuntimeInstallationJob.queue(
        id=job_id, target=RuntimeInstallationTarget(kind, "saved-provider", "saved-model"),
        detail="saved", total=80, now=datetime(2025, 1, 1, tzinfo=UTC),
    )
    job = replace(job, status=status)
    runtime.jobs.add(job)
    runtime.work.prepare(job.id)
    return job


def test_list_requirements_evaluates_catalog_without_scheduling(runtime):
    model = ScriptedInstaller(Kind.OLLAMA_MODEL)
    runtime.installers.items[model.kind] = model
    assert [item.kind for item in cases.list_runtime_requirements(runtime)] == list(Kind)
    assert model.calls == ["requirement"]
    assert runtime.jobs.rows == {} and runtime.work.pending == []


def test_start_queues_then_reuses_by_kind_after_validation(runtime):
    first = cases.start_runtime_installation(runtime, Kind.OLLAMA)
    installer = runtime.installers.get(Kind.OLLAMA)
    installer.provider, installer.model = "changed", "changed"
    second = cases.start_runtime_installation(runtime, Kind.OLLAMA)
    assert first == second
    assert (first.provider, first.model, first.status) == ("test-provider", "test-model", Status.QUEUED)
    assert installer.calls == ["requirement", "validate", "requirement", "validate"]
    assert len(runtime.work.pending) == len(runtime.jobs.writes) == 1
    assert runtime.work.signals == {first.id: False}


def test_ready_start_creates_fresh_success_without_validation_signal_or_schedule(runtime):
    queued(runtime)
    installer = runtime.installers.get(Kind.OLLAMA)
    installer.available = True
    installer.validation_error = ValueError("must not validate")
    first = cases.start_runtime_installation(runtime, installer.kind)
    second = cases.start_runtime_installation(runtime, installer.kind)
    assert first.id != second.id
    assert first.status == second.status == Status.SUCCEEDED
    assert first.detail == "Test requirement is ready"
    assert runtime.work.pending == [] and list(runtime.work.signals) == ["saved"]


@pytest.mark.parametrize("failure", [ProviderUnavailableError("unavailable"), ValueError("invalid")])
def test_validation_precedes_reuse_and_preserves_translation(runtime, failure):
    queued(runtime)
    runtime.installers.get(Kind.OLLAMA).validation_error = failure
    with pytest.raises(ProviderUnavailableError, match=str(failure)) as caught:
        cases.start_runtime_installation(runtime, Kind.OLLAMA)
    if isinstance(failure, ProviderUnavailableError):
        assert caught.value is failure
    else:
        assert caught.value.__cause__ is failure
    assert runtime.work.pending == []


def test_download_resolves_selected_lane_instead_of_assuming_model_kind(runtime):
    runtime.installers.selected_model_kind = Kind.OLLAMA
    result = cases.download_selected_model(runtime)
    assert result.kind == Kind.OLLAMA
    runtime.work.run()
    assert cases.view_runtime_installation(runtime, result.id).status == Status.SUCCEEDED


def test_missing_installer_and_jobs_preserve_errors(runtime):
    with pytest.raises(ProviderUnavailableError, match="No installer is configured for ollama_model."):
        cases.download_selected_model(runtime)
    for action in (cases.view_runtime_installation, cases.cancel_runtime_installation):
        with pytest.raises(KeyError):
            action(runtime, "unknown")


def test_waiting_view_finishes_with_requirement_counts(runtime):
    original = queued(runtime, status=Status.WAITING_FOR_USER)
    installer = runtime.installers.get(original.kind)
    installer.available = True
    installer.bytes = 0
    ready = cases.view_runtime_installation(runtime, original.id)
    assert (ready.status, ready.detail, ready.completed, ready.total) == (
        Status.SUCCEEDED, "Test requirement is ready", 0, 0,
    )
    assert ready.created_at == original.snapshot().created_at
    assert len(runtime.jobs.writes) == 2


def test_waiting_refresh_racing_cancel_cannot_commit_success(runtime):
    job = queued(runtime, status=Status.WAITING_FOR_USER)
    installer = runtime.installers.get(job.kind)
    original_probe = installer.requirement

    def probe():
        cases.cancel_runtime_installation(runtime, job.id)
        installer.available = True
        return original_probe()

    installer.requirement = probe
    ready = cases.view_runtime_installation(runtime, job.id)
    assert ready.status == Status.CANCELED
    assert ready.detail == "Runtime installation canceled"


def test_queued_cancellation_before_schedule_prevents_work(runtime):
    runtime.work.on_schedule = lambda: cases.cancel_runtime_installation(
        runtime, next(iter(runtime.jobs.rows)),
    )
    result = cases.start_runtime_installation(runtime, Kind.OLLAMA)
    runtime.work.run()
    assert result.status == Status.CANCELED
    assert "install" not in runtime.installers.get(Kind.OLLAMA).calls


def test_cancel_persists_before_optional_callback_and_swallows_callback_failure(runtime):
    job = queued(runtime, status=Status.RUNNING)
    installer = runtime.installers.get(job.kind)

    def callback():
        assert runtime.work.signals[job.id]
        assert runtime.jobs.require(job.id).status == Status.CANCEL_REQUESTED
        raise RuntimeError("optional callback failed")

    installer.on_cancel = callback
    result = cases.cancel_runtime_installation(runtime, job.id)
    assert result.status == Status.CANCEL_REQUESTED
    assert cases.cancel_runtime_installation(runtime, job.id) == result
    assert installer.calls == ["cancel"]


def test_perform_records_progress_and_completes_selected_model(runtime):
    installer = ScriptedInstaller(Kind.OLLAMA_MODEL)
    runtime.installers.items[installer.kind] = installer
    job = queued(runtime, kind=installer.kind)
    installer.action = lambda progress: progress(Progress("download", 3, 8)) or Status.SUCCEEDED
    cases.perform_runtime_installation(runtime, job.id, installer)
    result = runtime.jobs.require(job.id)
    assert (result.status, result.detail, result.completed, result.total) == (
        Status.SUCCEEDED, "model download complete", 3, 8,
    )
    assert [write.status for write in runtime.jobs.writes] == [
        Status.QUEUED, Status.RUNNING, Status.RUNNING, Status.SUCCEEDED,
    ]


@pytest.mark.parametrize("outcome", ["success", "failure", "waiting", "progress"])
def test_perform_cancellation_wins_all_finalization_paths(runtime, outcome):
    job = queued(runtime)
    installer = runtime.installers.get(job.kind)

    def install(progress):
        progress(Progress("partial", 2, 9))
        cases.cancel_runtime_installation(runtime, job.id)
        if outcome == "failure":
            raise ValueError("installer failed")
        if outcome == "progress":
            progress(Progress("late", 8, 9))
        return Status.WAITING_FOR_USER if outcome == "waiting" else Status.SUCCEEDED

    installer.action = install
    cases.perform_runtime_installation(runtime, job.id, installer)
    result = runtime.jobs.require(job.id)
    assert result.status == Status.CANCELED and result.error is None


def test_perform_probe_failure_escapes_and_keeps_running(runtime):
    job = queued(runtime)
    installer = runtime.installers.get(job.kind)
    installer.requirement = lambda: (_ for _ in ()).throw(ValueError("probe failed"))
    with pytest.raises(ValueError, match="probe failed"):
        cases.perform_runtime_installation(runtime, job.id, installer)
    assert runtime.jobs.require(job.id).status == Status.RUNNING


def test_perform_non_cancellation_failure_is_persisted(runtime):
    job = queued(runtime)
    installer = runtime.installers.get(job.kind)
    installer.action = lambda progress: (_ for _ in ()).throw(ValueError("install failed"))
    cases.perform_runtime_installation(runtime, job.id, installer)
    result = runtime.jobs.require(job.id)
    assert result.status == Status.FAILED and result.error == result.detail == "install failed"


def test_installer_domain_cancellation_error_keeps_original_failure_translation(runtime):
    job = queued(runtime)
    installer = runtime.installers.get(job.kind)

    def fail(progress):
        raise RuntimeInstallationCanceledError("installer rejected transition")

    installer.action = fail
    cases.perform_runtime_installation(runtime, job.id, installer)
    result = runtime.jobs.require(job.id)
    assert result.status == Status.FAILED and result.error == "installer rejected transition"


def test_perform_waiting_clears_completed_and_keeps_requirement_total(runtime):
    job = queued(runtime)
    installer = runtime.installers.get(job.kind)
    installer.action = lambda progress: progress(Progress("partial", 2, 9)) or Status.WAITING_FOR_USER
    cases.perform_runtime_installation(runtime, job.id, installer)
    result = runtime.jobs.require(job.id)
    assert (result.status, result.completed, result.total, result.detail) == (
        Status.WAITING_FOR_USER, None, 80, "Manual setup required",
    )


def test_recover_runs_once_and_restores_only_active_signals(runtime):
    for status in Status:
        queued(runtime, job_id=status.value, status=status)
    runtime.work.signals.clear()
    runtime.jobs.persistent = True
    cases.recover_runtime_installations(runtime)
    assert len(runtime.jobs.recovery_times) == 1
    assert runtime.jobs.require("queued").status == Status.FAILED
    assert runtime.jobs.require("cancel_requested").status == Status.CANCELED
    assert runtime.work.signals == {"waiting_for_user": False}


def test_recover_without_database_does_not_consume_clock(runtime):
    calls = []
    cases.recover_runtime_installations(replace(runtime, clock=lambda: calls.append("clock")))
    assert calls == runtime.jobs.recovery_times == []


def test_stop_selects_nonterminal_jobs_and_joins_original_worker_snapshot(runtime):
    queued(runtime, job_id="queued")
    queued(runtime, job_id="waiting", status=Status.WAITING_FOR_USER)
    committed = queued(runtime, job_id="committing", status=Status.RUNNING)
    runtime.jobs.save(replace(
        committed, cancellable=False, phase=RuntimeInstallationPhase("committing"),
    ))
    queued(runtime, job_id="terminal", status=Status.SUCCEEDED)
    worker = SimpleNamespace()
    runtime.work.owned_workers = [worker]
    cases.stop_runtime_installations(runtime)
    assert runtime.jobs.require("queued").status == Status.CANCELED
    assert runtime.jobs.require("waiting").status == Status.CANCEL_REQUESTED
    assert runtime.jobs.require("committing").status == Status.RUNNING
    assert runtime.jobs.require("terminal").status == Status.SUCCEEDED
    assert runtime.work.joined == [worker]


def test_committing_cancellation_does_not_signal_or_write(runtime):
    job = queued(runtime)
    runtime.jobs.save(replace(job, cancellable=False))
    with pytest.raises(OperationNotCancellableError):
        cases.cancel_runtime_installation(runtime, job.id)
    assert runtime.work.signals[job.id] is False
    assert len(runtime.jobs.writes) == 2


def test_stop_tolerates_eviction_during_cancellation_and_still_joins(runtime):
    queued(runtime, job_id="first")
    queued(runtime, job_id="evicted")
    runtime.installers.get(Kind.OLLAMA).on_cancel = lambda: runtime.jobs.rows.pop("evicted", None)
    worker = object()
    runtime.work.owned_workers = [worker]
    cases.stop_runtime_installations(runtime)
    assert runtime.jobs.require("first").status == Status.CANCELED
    assert runtime.work.joined == [worker]
