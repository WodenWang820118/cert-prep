from __future__ import annotations

from dataclasses import asdict
from threading import Event, Thread

import pytest
from runtime_characterization_support import (
    installer as installer,
    make_manager as make_manager,
    no_ollama_start as no_ollama_start,
    runtime_clock as runtime_clock,
    worker_gates as worker_gates,
)

from cert_prep_backend.platform.errors import OperationNotCancellableError, ProviderUnavailableError
from cert_prep_contracts.runtime import (
    RuntimeInstallationStatus as Status,
    RuntimeInstallProgress as Progress,
    RuntimeRequirementKind as Kind,
)
from cert_prep_ollama.exceptions import ProviderUnavailableError as OllamaUnavailableError


def test_ready_creates_fresh_success_before_validation_or_active_reuse(make_manager, installer):
    manager = make_manager(async_jobs=True)
    queued = manager.start_installation(Kind.OLLAMA)
    installer.available = True
    installer.validation_error = AssertionError("ready must bypass validation")
    installer.calls.clear()

    ready = manager.start_installation(Kind.OLLAMA)
    another = manager.start_installation(Kind.OLLAMA)

    assert len({queued.id, ready.id, another.id}) == 3
    assert installer.calls == ["requirement", "requirement"]
    assert ready.status == Status.SUCCEEDED
    assert (ready.phase, ready.cancellable, ready.detail) == (
        "completed", False, "Test requirement is ready",
    )
    assert ready.completed == ready.total == 80
    assert ready.created_at == ready.updated_at
    assert ready.commit_started_at is ready.error is None
    assert manager.get_installation(queued.id).status == Status.QUEUED


@pytest.mark.parametrize("error", [
    ProviderUnavailableError("unavailable"),
    OllamaUnavailableError("unavailable"),
    ValueError("unavailable"),
])
def test_validation_precedes_reuse_and_translates_failures(make_manager, installer, error):
    manager = make_manager(async_jobs=True)
    job = manager.start_installation(Kind.OLLAMA)
    installer.validation_error = error
    installer.calls.clear()

    with pytest.raises(ProviderUnavailableError, match="^unavailable$") as caught:
        manager.start_installation(Kind.OLLAMA)

    assert (caught.value is error) == isinstance(error, ProviderUnavailableError)
    if caught.value is not error:
        assert caught.value.__cause__ is error
    assert installer.calls == ["requirement", "validate"]
    assert manager.get_installation(job.id) == job


def test_invalid_unconfigured_and_missing_jobs(make_manager):
    manager = make_manager()
    with pytest.raises(ValueError):
        manager.start_installation("not-a-kind")
    assert manager.requirement(Kind.OLLAMA_MODEL) is None
    with pytest.raises(ProviderUnavailableError, match="No installer is configured for ollama_model."):
        manager.start_model_installation()
    for method in (manager.get_installation, manager.cancel_installation):
        with pytest.raises(KeyError, match="missing"):
            method("missing")


@pytest.mark.parametrize("active", ["queued", "running", "cancel_requested", "waiting_for_user"])
def test_active_reuse_is_by_kind_even_if_provider_and_model_change(
    make_manager, installer, worker_gates, active,
):
    entered, release = Event(), Event()

    def install(progress):
        entered.set()
        assert release.wait(timeout=10)
        return Status.WAITING_FOR_USER if active == "waiting_for_user" else Status.SUCCEEDED

    installer.action = install
    manager = make_manager(async_jobs=True)
    job = manager.start_installation(Kind.OLLAMA)
    try:
        if active != "queued":
            worker_gates[0][0].set()
            assert entered.wait(timeout=10)
        if active == "waiting_for_user":
            release.set()
            assert worker_gates[0][1].wait(timeout=10)
        if active == "cancel_requested":
            manager.cancel_installation(job.id)
        assert manager.get_installation(job.id).status == active
        installer.provider, installer.model = "changed-provider", "changed-model"
        reused = manager.start_installation(Kind.OLLAMA)
        assert reused.id == job.id
        assert (reused.provider, reused.model) == (job.provider, job.model)
        assert len(worker_gates) == 1
    finally:
        release.set()


def test_different_kinds_have_independent_active_jobs(make_manager, installer):
    other = type(installer)(Kind.OLLAMA_MODEL)
    manager = make_manager(installers=[installer, other], async_jobs=True)
    runtime = manager.start_installation(Kind.OLLAMA)
    model = manager.start_model_installation()
    assert runtime.id != model.id
    assert manager.start_installation(Kind.OLLAMA).id == runtime.id
    assert manager.start_model_installation().id == model.id


@pytest.mark.parametrize("terminal", [Status.SUCCEEDED, Status.FAILED, Status.CANCELED])
def test_terminal_jobs_allow_new_attempts(make_manager, installer, worker_gates, terminal):
    def fail(progress):
        raise RuntimeError("installer failed")

    if terminal == Status.FAILED:
        installer.action = fail
    manager = make_manager(async_jobs=terminal == Status.CANCELED)
    first = manager.start_installation(Kind.OLLAMA)
    if terminal == Status.CANCELED:
        first = manager.cancel_installation(first.id)
    assert first.status == terminal
    second = manager.start_installation(Kind.OLLAMA)
    assert second.id != first.id
    assert manager.get_installation(first.id) == first


def test_worker_start_progress_defaults_and_null_counts(make_manager, installer, runtime_clock):
    seen = []
    manager = make_manager()

    def install(progress):
        job_id = next(iter(manager._jobs))
        seen.append(manager.get_installation(job_id))
        for item in (
            Progress("download", 50, 100, "custom-phase", False),
            Progress("reset counts"),
            Progress("counts may decrease", -2, 0, "", None),
        ):
            progress(item)
            seen.append(manager.get_installation(job_id))
        return Status.SUCCEEDED

    installer.action = install
    completed = manager.start_installation(Kind.OLLAMA)
    assert [item.status for item in seen] == [Status.RUNNING] * 4
    assert (seen[0].phase, seen[0].detail, seen[0].cancellable) == (
        "starting", "test-provider installation running", True,
    )
    assert (seen[0].completed, seen[0].total) == (None, 80)
    assert (seen[1].phase, seen[1].cancellable, seen[1].completed, seen[1].total) == (
        "custom-phase", False, 50, 100,
    )
    assert (seen[2].phase, seen[2].cancellable, seen[2].completed, seen[2].total) == (
        "installing", True, None, None,
    )
    assert (seen[3].phase, seen[3].cancellable, seen[3].completed, seen[3].total) == (
        "installing", True, -2, 0,
    )
    assert completed.status == Status.SUCCEEDED
    assert completed.completed == -2 and completed.total == 0
    assert completed.created_at == runtime_clock[0].isoformat()


def test_commit_latches_first_noncancellable_timestamp_and_rejects_cancellation(
    make_manager, installer,
):
    seen = []
    manager = make_manager()

    def install(progress):
        job_id = next(iter(manager._jobs))
        progress(Progress("not yet a commit", phase="committing", cancellable=True))
        assert manager.get_installation(job_id).commit_started_at is None
        progress(Progress("other noncancellable phase", phase="verifying", cancellable=False))
        assert manager.get_installation(job_id).commit_started_at is None
        for item in (
            Progress("commit", 1, 2, "committing", False),
            Progress("late download", 2, 3, "downloading", True),
            Progress("commit again", phase="committing", cancellable=False),
            Progress("defaults after commit"),
        ):
            progress(item)
            seen.append(manager.get_installation(job_id))
        with pytest.raises(OperationNotCancellableError) as caught:
            manager.cancel_installation(job_id)
        assert str(caught.value) == "Runtime installation is committing and can no longer be canceled."
        return Status.SUCCEEDED

    installer.action = install
    result = manager.start_installation(Kind.OLLAMA)
    assert {item.phase for item in seen} == {"committing"}
    assert all(item.cancellable is False for item in seen)
    assert len({item.commit_started_at for item in seen}) == 1
    assert seen[0].commit_started_at == seen[0].updated_at
    assert result.commit_started_at == seen[0].commit_started_at
    assert result.phase == "completed"
    with pytest.raises(OperationNotCancellableError) as caught:
        manager.cancel_installation(result.id)
    assert str(caught.value) == "Runtime installation committed and can no longer be canceled."


@pytest.mark.parametrize("kind", list(Kind))
@pytest.mark.parametrize("counts", [(None, None), (0, 0), (3, None), (None, 7)])
@pytest.mark.parametrize("detail", ["last detail", ""])
def test_completion_detail_and_independent_count_fallbacks(
    make_manager, installer, kind, counts, detail,
):
    installer.kind = kind

    def install(progress):
        progress(Progress(detail, *counts))
        return Status.SUCCEEDED

    installer.action = install
    manager = make_manager()
    result = manager.start_installation(kind)
    assert not installer.available  # Current normal-return success does not require readiness.
    assert result.status == Status.SUCCEEDED
    assert result.detail == (
        "model download complete" if kind == Kind.OLLAMA_MODEL else detail or "Test requirement is ready"
    )
    assert result.completed == (80 if counts[0] is None else counts[0])
    assert result.total == (80 if counts[1] is None else counts[1])
    assert result.error is None and result.cancellable is False


@pytest.mark.parametrize("returned", [Status.QUEUED, Status.RUNNING, Status.FAILED, Status.CANCELED, None])
def test_every_normal_nonwaiting_installer_return_is_success(make_manager, installer, returned):
    installer.action = lambda progress: returned
    result = make_manager().start_installation(Kind.OLLAMA)
    assert result.status == Status.SUCCEEDED
    assert result.detail == "test-provider installation running"
    assert (result.completed, result.total) == (80, 80)


def test_waiting_completion_clears_completed_then_poll_observes_readiness(make_manager, installer):
    def install(progress):
        progress(Progress("downloaded", 70, 90))
        return Status.WAITING_FOR_USER

    installer.action = install
    manager = make_manager()
    waiting = manager.start_installation(Kind.OLLAMA)
    assert (waiting.status, waiting.phase, waiting.cancellable) == (
        Status.WAITING_FOR_USER, "waiting_for_user", True,
    )
    assert (waiting.detail, waiting.completed, waiting.total) == ("Manual setup required", None, 80)
    assert manager.get_installation(waiting.id) == waiting
    installer.available = True
    ready = manager.get_installation(waiting.id)
    assert (ready.status, ready.phase, ready.cancellable) == (Status.SUCCEEDED, "completed", False)
    assert ready.detail == "Test requirement is ready"
    assert ready.completed == ready.total == 80
    assert ready.error is None


def test_queued_cancellation_prevents_installer_and_repeats_are_noops(
    make_manager, installer, worker_gates,
):
    manager = make_manager(async_jobs=True)
    queued = manager.start_installation(Kind.OLLAMA)
    assert (queued.status, queued.phase, queued.cancellable) == (Status.QUEUED, "queued", True)
    assert queued.detail == "Test requirement installation queued"
    assert queued.completed is None and queued.total == 80
    canceled = manager.cancel_installation(queued.id)
    assert (canceled.status, canceled.phase, canceled.cancellable) == (Status.CANCELED, "canceled", False)
    assert canceled.detail == "Runtime installation canceled"
    assert manager.cancel_installation(queued.id) == canceled
    worker_gates[0][0].set()
    assert worker_gates[0][1].wait(timeout=10)
    assert manager.get_installation(queued.id) == canceled
    assert installer.calls == ["requirement", "validate", "cancel"]


@pytest.mark.parametrize("outcome", ["progress", "success", "failure", "waiting"])
def test_running_cancellation_wins_over_worker_finalization(
    make_manager, installer, worker_gates, outcome,
):
    entered, release = Event(), Event()

    def install(progress):
        progress(Progress("partial", 3, 8))
        entered.set()
        assert release.wait(timeout=10)
        if outcome == "progress":
            progress(Progress("too late", 8, 8))
        if outcome == "failure":
            raise RuntimeError("late failure")
        return Status.WAITING_FOR_USER if outcome == "waiting" else Status.SUCCEEDED

    installer.action = install
    manager = make_manager(async_jobs=True)
    queued = manager.start_installation(Kind.OLLAMA)
    worker_gates[0][0].set()
    try:
        assert entered.wait(timeout=10)
        requested = manager.cancel_installation(queued.id)
        assert (requested.status, requested.phase, requested.cancellable) == (
            Status.CANCEL_REQUESTED, "canceling", False,
        )
        assert requested.detail == "Runtime installation cancellation requested"
        assert manager.cancel_installation(queued.id) == requested
        assert installer.calls.count("cancel") == 1
    finally:
        release.set()
    assert worker_gates[0][1].wait(timeout=10)
    canceled = manager.get_installation(queued.id)
    assert (canceled.status, canceled.phase, canceled.cancellable) == (Status.CANCELED, "canceled", False)
    assert canceled.detail == "Runtime installation canceled"
    assert canceled.error is None
    assert canceled.completed == (None if outcome == "waiting" else 3)
    assert canceled.total == (80 if outcome == "waiting" else 8)


def test_waiting_cancel_stays_requested_without_worker(make_manager, installer):
    # Pins current behaviour: waiting cancellation has no worker to acknowledge it.
    installer.action = lambda progress: Status.WAITING_FOR_USER
    manager = make_manager()
    waiting = manager.start_installation(Kind.OLLAMA)
    requested = manager.cancel_installation(waiting.id)
    installer.available = True
    assert requested.status == Status.CANCEL_REQUESTED
    assert manager.get_installation(waiting.id) == requested
    assert manager.cancel_installation(waiting.id) == requested
    manager.close()
    assert manager.get_installation(waiting.id) == requested


@pytest.mark.parametrize("failed", [False, True])
def test_terminal_finalization_and_cancellation_are_idempotent(make_manager, installer, failed):
    def install(progress):
        progress(Progress("partial", 3, 8))
        if failed:
            raise RuntimeError("installer failed")
        return Status.SUCCEEDED

    installer.action = install
    manager = make_manager()
    terminal = manager.start_installation(Kind.OLLAMA)
    assert terminal.status == (Status.FAILED if failed else Status.SUCCEEDED)
    assert terminal.error == ("installer failed" if failed else None)
    assert terminal.detail == ("installer failed" if failed else "partial")
    assert (terminal.completed, terminal.total) == (3, 8)
    assert manager.cancel_installation(terminal.id) == terminal
    manager._update_job(
        terminal.id, status=Status.FAILED, phase="different", cancellable=True,
        detail="late finalization", completed=None, total=None, error="late error",
    )
    assert manager.get_installation(terminal.id) == terminal
    assert "cancel" not in installer.calls


@pytest.mark.parametrize("failed", [False, True])
def test_late_progress_after_terminal_revives_job(make_manager, installer, failed):
    # Pins current behaviour: progress after success/failure revives a terminal job.
    def install(progress):
        if failed:
            raise RuntimeError("original failure")
        return Status.SUCCEEDED

    installer.action = install
    manager = make_manager()
    terminal = manager.start_installation(Kind.OLLAMA)
    installer.progress(Progress("late progress", 1, None))
    revived = manager.get_installation(terminal.id)
    assert (revived.status, revived.phase, revived.cancellable) == (Status.RUNNING, "installing", True)
    assert (revived.detail, revived.completed, revived.total) == ("late progress", 1, None)
    assert revived.error == terminal.error
    assert revived.created_at == terminal.created_at
    assert revived.updated_at > terminal.updated_at
    assert asdict(revived)["id"] == terminal.id


def test_cancel_callback_is_outside_lock_and_callback_failure_is_swallowed(
    make_manager, installer,
):
    manager = make_manager()
    reads = []
    readers = []
    callback_unlocked = []

    def cancel():
        observed = Event()

        def read():
            reads.append(manager.get_installation(next(iter(manager._jobs))))
            observed.set()

        reader = Thread(target=read)
        readers.append(reader)
        reader.start()
        callback_unlocked.append(observed.wait(timeout=5))
        raise RuntimeError("optional cancel callback failed")

    def install(progress):
        progress(Progress("partial", 2, 9))
        requested = manager.cancel_installation(next(iter(manager._jobs)))
        assert requested.status == Status.CANCEL_REQUESTED
        raise RuntimeError("worker failed after cancellation")

    installer.on_cancel = cancel
    installer.action = install
    result = manager.start_installation(Kind.OLLAMA)
    for reader in readers:
        reader.join(timeout=5)
        assert not reader.is_alive()
    assert callback_unlocked == [True]
    assert reads[0].status == Status.CANCEL_REQUESTED
    assert result.status == Status.CANCELED
    assert result.error is None
    assert (result.completed, result.total) == (2, 9)


def test_post_install_requirement_exception_leaves_job_running(make_manager, installer):
    # Pins current behaviour: the post-install probe is outside the worker's
    # exception handler, so its exception escapes without finalizing the job.
    original_requirement = installer.requirement

    def requirement():
        if "install" in installer.calls:
            raise RuntimeError("post-install probe failed")
        return original_requirement()

    installer.requirement = requirement
    manager = make_manager()
    with pytest.raises(RuntimeError, match="^post-install probe failed$"):
        manager.start_installation(Kind.OLLAMA)
    result = manager.get_installation(next(iter(manager._jobs)))
    assert (result.status, result.phase, result.cancellable) == (Status.RUNNING, "starting", True)
    assert result.error is None


@pytest.mark.parametrize("bytes_count", [None, 0])
@pytest.mark.parametrize("kind", list(Kind))
def test_completion_fallback_preserves_null_or_zero_requirement_bytes(
    make_manager, installer, bytes_count, kind,
):
    installer.bytes = bytes_count
    installer.kind = kind
    result = make_manager().start_installation(kind)
    assert result.completed == result.total == bytes_count
