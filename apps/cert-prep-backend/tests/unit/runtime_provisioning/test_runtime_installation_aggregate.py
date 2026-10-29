"""Unit tests for the RuntimeInstallationJob aggregate and value objects."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from cert_prep_backend.platform.errors import OperationNotCancellableError
from cert_prep_backend.runtime_provisioning.domain.installation import (
    RuntimeInstallationCanceledError,
    RuntimeInstallationJob,
    RuntimeInstallationPhase,
    RuntimeInstallationProgress,
    RuntimeInstallationTarget,
    UNSET,
)
from cert_prep_contracts.runtime import (
    RuntimeInstallationStatus as Status,
    RuntimeInstallProgress,
    RuntimeRequirementKind as Kind,
)

NOW = datetime(2026, 1, 1, 12, 0, 0, tzinfo=UTC)
LATER = datetime(2026, 1, 1, 12, 5, 0, tzinfo=UTC)
EVEN_LATER = datetime(2026, 1, 1, 12, 10, 0, tzinfo=UTC)


def _target(kind: Kind = Kind.OLLAMA_MODEL) -> RuntimeInstallationTarget:
    return RuntimeInstallationTarget(
        kind=kind,
        provider="ollama",
        model="llama3",
    )


def _queued_job() -> RuntimeInstallationJob:
    return RuntimeInstallationJob.queue(
        id="job-1",
        target=_target(),
        detail="Model download queued",
        total=1000,
        now=NOW,
    )


def test_target_value_object_preserves_open_strings() -> None:
    target = RuntimeInstallationTarget(Kind.OLLAMA, "custom-provider", "custom-model")
    assert target.kind == Kind.OLLAMA
    assert target.provider == "custom-provider"
    assert target.model == "custom-model"


def test_phase_value_object_accepts_known_and_unknown_phases() -> None:
    known = RuntimeInstallationPhase("queued")
    assert known.value == "queued"
    assert known == "queued"
    assert str(known) == "queued"

    unknown = RuntimeInstallationPhase("extracting_blobs")
    assert unknown.value == "extracting_blobs"
    assert unknown == "extracting_blobs"
    assert str(unknown) == "extracting_blobs"


def test_progress_value_object_distinguishes_not_given_from_explicit_null() -> None:
    omitted = RuntimeInstallationProgress(detail="working")
    assert omitted.completed is UNSET
    assert omitted.total is UNSET
    assert omitted.phase is UNSET
    assert omitted.cancellable is UNSET

    explicit_null = RuntimeInstallationProgress(
        detail="reset",
        completed=None,
        total=None,
    )
    assert explicit_null.completed is None
    assert explicit_null.total is None

    counts_tuple = RuntimeInstallationProgress(detail="counted", counts=(25, 100))
    assert counts_tuple.completed == 25
    assert counts_tuple.total == 100

    from_contract = RuntimeInstallationProgress.from_install_progress(
        RuntimeInstallProgress(
            "pulling", completed=5, total=50, phase="downloading", cancellable=True
        )
    )
    assert from_contract.detail == "pulling"
    assert from_contract.completed == 5
    assert from_contract.total == 50
    assert from_contract.phase == "downloading"
    assert from_contract.cancellable is True


def test_queue_creates_job_with_expected_defaults() -> None:
    job = _queued_job()
    assert job.id == "job-1"
    assert job.kind == Kind.OLLAMA_MODEL
    assert job.provider == "ollama"
    assert job.model == "llama3"
    assert job.status == Status.QUEUED
    assert job.phase == "queued"
    assert job.cancellable is True
    assert job.detail == "Model download queued"
    assert job.completed is None
    assert job.total == 1000
    assert job.created_at == NOW
    assert job.updated_at == NOW
    assert job.commit_started_at is None
    assert job.error is None
    assert job.is_active is True
    assert job.is_terminal is False


def test_create_succeeded_creates_completed_job() -> None:
    job = RuntimeInstallationJob.create_succeeded(
        id="job-ready",
        target=_target(),
        detail="Model is ready",
        completed=500,
        total=500,
        now=NOW,
    )
    assert job.status == Status.SUCCEEDED
    assert job.phase == "completed"
    assert job.cancellable is False
    assert job.completed == 500
    assert job.total == 500
    assert job.is_terminal is True
    assert job.is_active is False


def test_start_transitions_queued_to_running() -> None:
    job = _queued_job()
    started = job.start("ollama installation running", now=LATER)

    assert started.status == Status.RUNNING
    assert started.phase == "starting"
    assert started.cancellable is True
    assert started.detail == "ollama installation running"
    assert started.updated_at == LATER
    assert started.created_at == NOW

    # Starting a non-queued job is a no-op
    re_started = started.start("another start", now=EVEN_LATER)
    assert re_started is started


def test_record_progress_defaults_and_latching() -> None:
    job = _queued_job().start("running", now=NOW)

    # Defaults: absent phase -> "installing", absent cancellable -> True
    p1 = RuntimeInstallationProgress(detail="Step 1", completed=10, total=100)
    j1 = job.record_progress(p1, now=LATER)
    assert j1.status == Status.RUNNING
    assert j1.phase == "installing"
    assert j1.cancellable is True
    assert j1.completed == 10
    assert j1.total == 100
    assert j1.commit_started_at is None

    # Explicit null counts
    p2 = RuntimeInstallationProgress(detail="Reset counts", completed=None, total=None)
    j2 = j1.record_progress(p2, now=EVEN_LATER)
    assert j2.completed is None
    assert j2.total is None

    # Commit latching: entering committing non-cancellable locks the state
    p_commit = RuntimeInstallationProgress(
        detail="Committing model",
        completed=100,
        total=100,
        phase="committing",
        cancellable=False,
    )
    j_committed = j2.record_progress(p_commit, now=EVEN_LATER)
    assert j_committed.phase == "committing"
    assert j_committed.cancellable is False
    assert j_committed.commit_started_at == EVEN_LATER

    # Subsequent progress remains committing and non-cancellable
    p_after = RuntimeInstallationProgress(
        detail="Post-commit verification",
        phase="verifying",
        cancellable=True,
    )
    t_after = datetime(2026, 1, 1, 12, 15, 0, tzinfo=UTC)
    j_after = j_committed.record_progress(p_after, now=t_after)
    assert j_after.phase == "committing"
    assert j_after.cancellable is False
    assert j_after.commit_started_at == EVEN_LATER
    assert j_after.detail == "Post-commit verification"


def test_late_progress_revives_terminal_job() -> None:
    job = _queued_job().start("running", now=NOW)
    succeeded = job.complete(detail="success", completed=100, total=100, now=LATER)
    assert succeeded.is_terminal is True

    # Pinned behavior: late progress revives terminal job back to running
    revived = succeeded.record_progress(
        RuntimeInstallationProgress(detail="late update", completed=100, total=100),
        now=EVEN_LATER,
    )
    assert revived.status == Status.RUNNING
    assert revived.detail == "late update"
    assert revived.is_terminal is False


def test_progress_on_cancel_requested_raises_canceled_error() -> None:
    job = _queued_job().start("running", now=NOW)
    requested = job.cancel(now=LATER)
    assert requested.status == Status.CANCEL_REQUESTED

    with pytest.raises(RuntimeInstallationCanceledError, match="canceled"):
        requested.record_progress(RuntimeInstallationProgress("should fail"), now=EVEN_LATER)


def test_cancel_transitions_and_rejections() -> None:
    # Queued job cancels immediately
    queued = _queued_job()
    canceled_queued = queued.cancel(now=LATER)
    assert canceled_queued.status == Status.CANCELED
    assert canceled_queued.phase == "canceled"
    assert canceled_queued.cancellable is False
    assert canceled_queued.detail == "Runtime installation canceled"

    # Running job enters cancel_requested
    running = queued.start("running", now=NOW)
    cancel_running = running.cancel(now=LATER)
    assert cancel_running.status == Status.CANCEL_REQUESTED
    assert cancel_running.phase == "canceling"
    assert cancel_running.cancellable is False
    assert cancel_running.detail == "Runtime installation cancellation requested"

    # Waiting job enters cancel_requested
    waiting = running.wait_for_user(detail="Manual action needed", total=100, now=LATER)
    cancel_waiting = waiting.cancel(now=EVEN_LATER)
    assert cancel_waiting.status == Status.CANCEL_REQUESTED
    assert cancel_waiting.phase == "canceling"

    # Re-cancelling cancel_requested is a no-op
    assert cancel_waiting.cancel(now=EVEN_LATER) is cancel_waiting

    # Cancelling when committing (not cancellable) raises OperationNotCancellableError
    committing = running.record_progress(
        RuntimeInstallationProgress(phase="committing", cancellable=False),
        now=LATER,
    )
    with pytest.raises(
        OperationNotCancellableError, match="committing and can no longer be canceled"
    ):
        committing.cancel(now=EVEN_LATER)

    # Cancelling after commit started and succeeded raises distinct committed message
    committed_succeeded = committing.complete(
        detail="done", completed=10, total=10, now=EVEN_LATER
    )
    with pytest.raises(
        OperationNotCancellableError, match="committed and can no longer be canceled"
    ):
        committed_succeeded.cancel(now=EVEN_LATER)

    # Terminal cancellation without commit is a no-op
    uncommitted_succeeded = running.complete(
        detail="fast done", completed=10, total=10, now=LATER
    )
    assert uncommitted_succeeded.cancel(now=EVEN_LATER) is uncommitted_succeeded


def test_wait_for_user_transitions() -> None:
    running = _queued_job().start("running", now=NOW)
    waiting = running.wait_for_user(detail="Insert USB key", total=500, now=LATER)
    assert waiting.status == Status.WAITING_FOR_USER
    assert waiting.phase == "waiting_for_user"
    assert waiting.cancellable is True
    assert waiting.detail == "Insert USB key"
    assert waiting.completed is None
    assert waiting.total == 500

    # If cancel was requested, wait_for_user finalizes to canceled
    cancel_requested = running.cancel(now=LATER)
    finalized_cancel = cancel_requested.wait_for_user(
        detail="ignored", total=500, now=EVEN_LATER
    )
    assert finalized_cancel.status == Status.CANCELED
    assert finalized_cancel.phase == "canceled"


def test_complete_and_fail_transitions() -> None:
    running = _queued_job().start("running", now=NOW)

    # Normal success
    succeeded = running.complete(
        detail="Installation complete", completed=1000, total=1000, now=LATER
    )
    assert succeeded.status == Status.SUCCEEDED
    assert succeeded.phase == "completed"
    assert succeeded.cancellable is False
    assert succeeded.detail == "Installation complete"
    assert succeeded.completed == 1000
    assert succeeded.total == 1000
    assert succeeded.error is None

    # Normal failure
    failed = running.fail(error="Connection refused", now=LATER)
    assert failed.status == Status.FAILED
    assert failed.phase == "failed"
    assert failed.cancellable is False
    assert failed.error == "Connection refused"
    assert failed.detail == "Connection refused"

    # Finalization while cancel_requested becomes canceled
    cancel_requested = running.cancel(now=LATER)
    cancel_complete = cancel_requested.complete(
        detail="ignored", completed=1000, total=1000, now=EVEN_LATER
    )
    assert cancel_complete.status == Status.CANCELED
    assert cancel_complete.phase == "canceled"
    assert cancel_complete.error is None

    cancel_fail = cancel_requested.fail(error="ignored error", now=EVEN_LATER)
    assert cancel_fail.status == Status.CANCELED
    assert cancel_fail.phase == "canceled"
    assert cancel_fail.error is None


def test_acknowledge_cancellation() -> None:
    running = _queued_job().start("running", now=NOW)
    cancel_requested = running.cancel(now=LATER)
    acknowledged = cancel_requested.acknowledge_cancellation(now=EVEN_LATER)

    assert acknowledged.status == Status.CANCELED
    assert acknowledged.phase == "canceled"
    assert acknowledged.cancellable is False
    assert acknowledged.detail == "Runtime installation canceled"
    assert acknowledged.error is None


def test_recover_after_restart() -> None:
    queued = _queued_job()
    running = queued.start("running", now=NOW)
    cancel_requested = running.cancel(now=LATER)
    waiting = running.wait_for_user(detail="Wait", total=100, now=LATER)
    succeeded = running.complete(detail="ok", completed=100, total=100, now=LATER)

    # Queued / Running become failed with interrupted phase
    rec_queued = queued.recover_after_restart(now=EVEN_LATER)
    assert rec_queued.status == Status.FAILED
    assert rec_queued.phase == "interrupted"
    assert rec_queued.cancellable is False
    assert rec_queued.error == "Runtime installation was interrupted by an app restart."
    assert rec_queued.detail == "Runtime installation was interrupted by an app restart."

    rec_running = running.recover_after_restart(now=EVEN_LATER)
    assert rec_running.status == Status.FAILED
    assert rec_running.phase == "interrupted"
    assert rec_running.error == "Runtime installation was interrupted by an app restart."

    # Cancel requested becomes canceled
    rec_cancel = cancel_requested.recover_after_restart(now=EVEN_LATER)
    assert rec_cancel.status == Status.CANCELED
    assert rec_cancel.phase == "canceled"
    assert rec_cancel.detail == "Runtime installation cancellation completed after restart."

    # Waiting stays waiting
    rec_waiting = waiting.recover_after_restart(now=EVEN_LATER)
    assert rec_waiting.status == Status.WAITING_FOR_USER
    assert rec_waiting is waiting

    # Terminal stays unchanged
    rec_succeeded = succeeded.recover_after_restart(now=EVEN_LATER)
    assert rec_succeeded is succeeded


def test_snapshot_formatting_and_roundtrip() -> None:
    job = _queued_job().start("running", now=NOW)
    committed = job.record_progress(
        RuntimeInstallationProgress(phase="committing", cancellable=False),
        now=LATER,
    )
    snapshot = committed.snapshot()

    assert snapshot.id == "job-1"
    assert snapshot.kind == Kind.OLLAMA_MODEL
    assert snapshot.provider == "ollama"
    assert snapshot.model == "llama3"
    assert snapshot.status == Status.RUNNING
    assert snapshot.phase == "committing"
    assert snapshot.cancellable is False
    assert snapshot.created_at == NOW.isoformat()
    assert snapshot.updated_at == LATER.isoformat()
    assert snapshot.commit_started_at == LATER.isoformat()
    assert snapshot.error is None
