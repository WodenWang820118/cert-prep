from __future__ import annotations

from dataclasses import asdict
from threading import Event, Thread

import pytest
from llm_characterization_support import (
    installer as installer,
    make_installation as make_installation,
    no_ollama_start as no_ollama_start,
    runtime_clock as runtime_clock,
    worker_gates as worker_gates,
)

from cert_prep_backend.llm_provisioning.application.use_cases import (
    _update_job,
    cancel_llm_installation,
    download_selected_model,
    start_llm_installation,
    stop_llm_installations,
    view_llm_installation,
)
from cert_prep_backend.platform.errors import InstallerUnavailable, OperationNotCancellableError
from cert_prep_contracts.llm_installation import (
    LLMInstallationStatus as Status,
    LLMInstallProgress as Progress,
    LLMRequirementKind as Kind,
)
from cert_prep_ollama.exceptions import OllamaInstallationUnavailable


def test_ready_creates_fresh_success_before_validation_or_active_reuse(make_installation, installer):
    installation = make_installation(async_jobs=True)
    queued = start_llm_installation(installation, Kind.OLLAMA)
    installer.available = True
    installer.validation_error = AssertionError("ready must bypass validation")
    installer.calls.clear()

    ready = start_llm_installation(installation, Kind.OLLAMA)
    another = start_llm_installation(installation, Kind.OLLAMA)

    assert len({queued.id, ready.id, another.id}) == 3
    assert installer.calls == ["requirement", "requirement"]
    assert ready.status == Status.SUCCEEDED
    assert (ready.phase, ready.cancellable, ready.detail) == (
        "completed", False, "Test requirement is ready",
    )
    assert ready.completed == ready.total == 80
    assert ready.created_at == ready.updated_at
    assert ready.commit_started_at is ready.error is None
    assert view_llm_installation(installation, queued.id).status == Status.QUEUED


@pytest.mark.parametrize("error", [
    InstallerUnavailable("unavailable"),
    OllamaInstallationUnavailable("unavailable"),
    ValueError("unavailable"),
])
def test_validation_precedes_reuse_and_translates_failures(make_installation, installer, error):
    installation = make_installation(async_jobs=True)
    job = start_llm_installation(installation, Kind.OLLAMA)
    installer.validation_error = error
    installer.calls.clear()

    with pytest.raises(InstallerUnavailable, match="^unavailable$") as caught:
        start_llm_installation(installation, Kind.OLLAMA)

    assert (caught.value is error) == isinstance(error, InstallerUnavailable)
    if caught.value is not error:
        assert caught.value.__cause__ is error
    assert installer.calls == ["requirement", "validate"]
    assert view_llm_installation(installation, job.id) == job


def test_invalid_unconfigured_and_missing_jobs(make_installation):
    installation = make_installation()
    with pytest.raises(ValueError):
        start_llm_installation(installation, "not-a-kind")
    assert installation.installers.get(Kind.OLLAMA_MODEL) is None
    with pytest.raises(InstallerUnavailable, match="No installer is configured for ollama_model."):
        download_selected_model(installation)
    for read in (view_llm_installation, cancel_llm_installation):
        with pytest.raises(KeyError, match="missing"):
            read(installation, "missing")


@pytest.mark.parametrize("active", ["queued", "running", "cancel_requested", "waiting_for_user"])
def test_active_reuse_is_by_kind_even_if_provider_and_model_change(
    make_installation, installer, worker_gates, active,
):
    entered, release = Event(), Event()

    def install(progress):
        entered.set()
        assert release.wait(timeout=10)
        return Status.WAITING_FOR_USER if active == "waiting_for_user" else Status.SUCCEEDED

    installer.action = install
    installation = make_installation(async_jobs=True)
    job = start_llm_installation(installation, Kind.OLLAMA)
    try:
        if active != "queued":
            worker_gates[0][0].set()
            assert entered.wait(timeout=10)
        if active == "waiting_for_user":
            release.set()
            assert worker_gates[0][1].wait(timeout=10)
        if active == "cancel_requested":
            cancel_llm_installation(installation, job.id)
        assert view_llm_installation(installation, job.id).status == active
        installer.provider, installer.model = "changed-provider", "changed-model"
        reused = start_llm_installation(installation, Kind.OLLAMA)
        assert reused.id == job.id
        assert (reused.provider, reused.model) == (job.provider, job.model)
        assert len(worker_gates) == 1
    finally:
        release.set()


def test_different_kinds_have_independent_active_jobs(make_installation, installer):
    other = type(installer)(Kind.OLLAMA_MODEL)
    installation = make_installation(installers=[installer, other], async_jobs=True)
    runtime = start_llm_installation(installation, Kind.OLLAMA)
    model = download_selected_model(installation)
    assert runtime.id != model.id
    assert start_llm_installation(installation, Kind.OLLAMA).id == runtime.id
    assert download_selected_model(installation).id == model.id


@pytest.mark.parametrize("terminal", [Status.SUCCEEDED, Status.FAILED, Status.CANCELED])
def test_terminal_jobs_allow_new_attempts(make_installation, installer, worker_gates, terminal):
    def fail(progress):
        raise RuntimeError("installer failed")

    if terminal == Status.FAILED:
        installer.action = fail
    installation = make_installation(async_jobs=terminal == Status.CANCELED)
    first = start_llm_installation(installation, Kind.OLLAMA)
    if terminal == Status.CANCELED:
        first = cancel_llm_installation(installation, first.id)
    assert first.status == terminal
    second = start_llm_installation(installation, Kind.OLLAMA)
    assert second.id != first.id
    assert view_llm_installation(installation, first.id) == first


def test_worker_start_progress_defaults_and_null_counts(make_installation, installer, runtime_clock):
    seen = []
    installation = make_installation()

    def install(progress):
        job_id = installation.jobs.list_all()[0].id
        seen.append(view_llm_installation(installation, job_id))
        for item in (
            Progress("download", 50, 100, "custom-phase", False),
            Progress("reset counts"),
            Progress("counts may decrease", -2, 0, "", None),
        ):
            progress(item)
            seen.append(view_llm_installation(installation, job_id))
        return Status.SUCCEEDED

    installer.action = install
    completed = start_llm_installation(installation, Kind.OLLAMA)
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
    make_installation, installer,
):
    seen = []
    installation = make_installation()

    def install(progress):
        job_id = installation.jobs.list_all()[0].id
        progress(Progress("not yet a commit", phase="committing", cancellable=True))
        assert view_llm_installation(installation, job_id).commit_started_at is None
        progress(Progress("other noncancellable phase", phase="verifying", cancellable=False))
        assert view_llm_installation(installation, job_id).commit_started_at is None
        for item in (
            Progress("commit", 1, 2, "committing", False),
            Progress("late download", 2, 3, "downloading", True),
            Progress("commit again", phase="committing", cancellable=False),
            Progress("defaults after commit"),
        ):
            progress(item)
            seen.append(view_llm_installation(installation, job_id))
        with pytest.raises(OperationNotCancellableError) as caught:
            cancel_llm_installation(installation, job_id)
        assert str(caught.value) == "LLM installation is committing and can no longer be canceled."
        return Status.SUCCEEDED

    installer.action = install
    result = start_llm_installation(installation, Kind.OLLAMA)
    assert {item.phase for item in seen} == {"committing"}
    assert all(item.cancellable is False for item in seen)
    assert len({item.commit_started_at for item in seen}) == 1
    assert seen[0].commit_started_at == seen[0].updated_at
    assert result.commit_started_at == seen[0].commit_started_at
    assert result.phase == "completed"
    with pytest.raises(OperationNotCancellableError) as caught:
        cancel_llm_installation(installation, result.id)
    assert str(caught.value) == "LLM installation committed and can no longer be canceled."


@pytest.mark.parametrize("kind", list(Kind))
@pytest.mark.parametrize("counts", [(None, None), (0, 0), (3, None), (None, 7)])
@pytest.mark.parametrize("detail", ["last detail", ""])
def test_completion_detail_and_independent_count_fallbacks(
    make_installation, installer, kind, counts, detail,
):
    installer.kind = kind

    def install(progress):
        progress(Progress(detail, *counts))
        return Status.SUCCEEDED

    installer.action = install
    installation = make_installation()
    result = start_llm_installation(installation, kind)
    assert not installer.available  # Current normal-return success does not require readiness.
    assert result.status == Status.SUCCEEDED
    assert result.detail == (
        "model download complete" if kind == Kind.OLLAMA_MODEL else detail or "Test requirement is ready"
    )
    assert result.completed == (80 if counts[0] is None else counts[0])
    assert result.total == (80 if counts[1] is None else counts[1])
    assert result.error is None and result.cancellable is False


@pytest.mark.parametrize("returned", [Status.QUEUED, Status.RUNNING, Status.FAILED, Status.CANCELED, None])
def test_every_normal_nonwaiting_installer_return_is_success(make_installation, installer, returned):
    installer.action = lambda progress: returned
    result = start_llm_installation(make_installation(), Kind.OLLAMA)
    assert result.status == Status.SUCCEEDED
    assert result.detail == "test-provider installation running"
    assert (result.completed, result.total) == (80, 80)


def test_waiting_completion_clears_completed_then_poll_observes_readiness(make_installation, installer):
    def install(progress):
        progress(Progress("downloaded", 70, 90))
        return Status.WAITING_FOR_USER

    installer.action = install
    installation = make_installation()
    waiting = start_llm_installation(installation, Kind.OLLAMA)
    assert (waiting.status, waiting.phase, waiting.cancellable) == (
        Status.WAITING_FOR_USER, "waiting_for_user", True,
    )
    assert (waiting.detail, waiting.completed, waiting.total) == ("Manual setup required", None, 80)
    assert view_llm_installation(installation, waiting.id) == waiting
    installer.available = True
    ready = view_llm_installation(installation, waiting.id)
    assert (ready.status, ready.phase, ready.cancellable) == (Status.SUCCEEDED, "completed", False)
    assert ready.detail == "Test requirement is ready"
    assert ready.completed == ready.total == 80
    assert ready.error is None


def test_queued_cancellation_prevents_installer_and_repeats_are_noops(
    make_installation, installer, worker_gates,
):
    installation = make_installation(async_jobs=True)
    queued = start_llm_installation(installation, Kind.OLLAMA)
    assert (queued.status, queued.phase, queued.cancellable) == (Status.QUEUED, "queued", True)
    assert queued.detail == "Test requirement installation queued"
    assert queued.completed is None and queued.total == 80
    canceled = cancel_llm_installation(installation, queued.id)
    assert (canceled.status, canceled.phase, canceled.cancellable) == (Status.CANCELED, "canceled", False)
    assert canceled.detail == "LLM installation canceled"
    assert cancel_llm_installation(installation, queued.id) == canceled
    worker_gates[0][0].set()
    assert worker_gates[0][1].wait(timeout=10)
    assert view_llm_installation(installation, queued.id) == canceled
    assert installer.calls == ["requirement", "validate", "cancel"]


@pytest.mark.parametrize("outcome", ["progress", "success", "failure", "waiting"])
def test_running_cancellation_wins_over_worker_finalization(
    make_installation, installer, worker_gates, outcome,
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
    installation = make_installation(async_jobs=True)
    queued = start_llm_installation(installation, Kind.OLLAMA)
    worker_gates[0][0].set()
    try:
        assert entered.wait(timeout=10)
        requested = cancel_llm_installation(installation, queued.id)
        assert (requested.status, requested.phase, requested.cancellable) == (
            Status.CANCEL_REQUESTED, "canceling", False,
        )
        assert requested.detail == "LLM installation cancellation requested"
        assert cancel_llm_installation(installation, queued.id) == requested
        assert installer.calls.count("cancel") == 1
    finally:
        release.set()
    assert worker_gates[0][1].wait(timeout=10)
    canceled = view_llm_installation(installation, queued.id)
    assert (canceled.status, canceled.phase, canceled.cancellable) == (Status.CANCELED, "canceled", False)
    assert canceled.detail == "LLM installation canceled"
    assert canceled.error is None
    assert canceled.completed == (None if outcome == "waiting" else 3)
    assert canceled.total == (80 if outcome == "waiting" else 8)


def test_waiting_cancel_stays_requested_without_worker(make_installation, installer):
    # Pins current behaviour: waiting cancellation has no worker to acknowledge it.
    installer.action = lambda progress: Status.WAITING_FOR_USER
    installation = make_installation()
    waiting = start_llm_installation(installation, Kind.OLLAMA)
    requested = cancel_llm_installation(installation, waiting.id)
    installer.available = True
    assert requested.status == Status.CANCEL_REQUESTED
    assert view_llm_installation(installation, waiting.id) == requested
    assert cancel_llm_installation(installation, waiting.id) == requested
    stop_llm_installations(installation)
    assert view_llm_installation(installation, waiting.id) == requested


@pytest.mark.parametrize("failed", [False, True])
def test_terminal_finalization_and_cancellation_are_idempotent(make_installation, installer, failed):
    def install(progress):
        progress(Progress("partial", 3, 8))
        if failed:
            raise RuntimeError("installer failed")
        return Status.SUCCEEDED

    installer.action = install
    installation = make_installation()
    terminal = start_llm_installation(installation, Kind.OLLAMA)
    assert terminal.status == (Status.FAILED if failed else Status.SUCCEEDED)
    assert terminal.error == ("installer failed" if failed else None)
    assert terminal.detail == ("installer failed" if failed else "partial")
    assert (terminal.completed, terminal.total) == (3, 8)
    assert cancel_llm_installation(installation, terminal.id) == terminal
    _update_job(
        installation,
        terminal.id, status=Status.FAILED, phase="different", cancellable=True,
        detail="late finalization", completed=None, total=None, error="late error",
    )
    assert view_llm_installation(installation, terminal.id) == terminal
    assert "cancel" not in installer.calls


@pytest.mark.parametrize("failed", [False, True])
def test_late_progress_after_terminal_revives_job(make_installation, installer, failed):
    # Pins current behaviour: progress after success/failure revives a terminal job.
    def install(progress):
        if failed:
            raise RuntimeError("original failure")
        return Status.SUCCEEDED

    installer.action = install
    installation = make_installation()
    terminal = start_llm_installation(installation, Kind.OLLAMA)
    installer.progress(Progress("late progress", 1, None))
    revived = view_llm_installation(installation, terminal.id)
    assert (revived.status, revived.phase, revived.cancellable) == (Status.RUNNING, "installing", True)
    assert (revived.detail, revived.completed, revived.total) == ("late progress", 1, None)
    assert revived.error == terminal.error
    assert revived.created_at == terminal.created_at
    assert revived.updated_at > terminal.updated_at
    assert asdict(revived)["id"] == terminal.id


def test_cancel_callback_is_outside_lock_and_callback_failure_is_swallowed(
    make_installation, installer,
):
    installation = make_installation()
    reads = []
    readers = []
    callback_unlocked = []

    def cancel():
        observed = Event()

        def read():
            reads.append(view_llm_installation(installation, installation.jobs.list_all()[0].id))
            observed.set()

        reader = Thread(target=read)
        readers.append(reader)
        reader.start()
        callback_unlocked.append(observed.wait(timeout=5))
        raise RuntimeError("optional cancel callback failed")

    def install(progress):
        progress(Progress("partial", 2, 9))
        requested = cancel_llm_installation(installation, installation.jobs.list_all()[0].id)
        assert requested.status == Status.CANCEL_REQUESTED
        raise RuntimeError("worker failed after cancellation")

    installer.on_cancel = cancel
    installer.action = install
    result = start_llm_installation(installation, Kind.OLLAMA)
    for reader in readers:
        reader.join(timeout=5)
        assert not reader.is_alive()
    assert callback_unlocked == [True]
    assert reads[0].status == Status.CANCEL_REQUESTED
    assert result.status == Status.CANCELED
    assert result.error is None
    assert (result.completed, result.total) == (2, 9)


def test_post_install_requirement_exception_leaves_job_running(make_installation, installer):
    # Pins current behaviour: the post-install probe is outside the worker's
    # exception handler, so its exception escapes without finalizing the job.
    original_requirement = installer.requirement

    def requirement():
        if "install" in installer.calls:
            raise RuntimeError("post-install probe failed")
        return original_requirement()

    installer.requirement = requirement
    installation = make_installation()
    with pytest.raises(RuntimeError, match="^post-install probe failed$"):
        start_llm_installation(installation, Kind.OLLAMA)
    result = view_llm_installation(installation, installation.jobs.list_all()[0].id)
    assert (result.status, result.phase, result.cancellable) == (Status.RUNNING, "starting", True)
    assert result.error is None


@pytest.mark.parametrize("bytes_count", [None, 0])
@pytest.mark.parametrize("kind", list(Kind))
def test_completion_fallback_preserves_null_or_zero_requirement_bytes(
    make_installation, installer, bytes_count, kind,
):
    installer.bytes = bytes_count
    installer.kind = kind
    result = start_llm_installation(make_installation(), kind)
    assert result.completed == result.total == bytes_count
