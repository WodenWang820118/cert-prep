"""Draft generation: what each transition does, which states it leaves alone, and how a
requested cancellation wins over every other ending."""

from __future__ import annotations

from dataclasses import replace

import pytest

from cert_prep_backend.authoring.domain.generation import (
    DraftGenerationJob,
    DraftGenerationJobStatus as Job,
    DraftJobCanceledError,
    DraftJobNotCancellableError,
    ManualDraftOperation,
    ManualDraftOperationStatus as Operation,
)

NOW = "2026-10-27T00:00:00+00:00"
LATER = "2026-10-27T01:00:00+00:00"


def _job(status: Job = Job.PENDING, **changes: object) -> DraftGenerationJob:
    job = DraftGenerationJob(
        id="job",
        project_id="project",
        document_id="document",
        chunk_id="chunk",
        page_number=1,
        strategy="hybrid_reasoning",
        status=status,
        provider="fake",
        model="m",
        effective_provider=None,
        effective_model=None,
        fallback_reason=None,
        phase="queued",
        cancellable=True,
        generated_count=0,
        retry_count=0,
        last_error=None,
        created_at=NOW,
        updated_at=NOW,
    )
    return replace(job, **changes)


def _operation() -> ManualDraftOperation:
    return ManualDraftOperation.queue(
        operation_id="operation",
        project_id="project",
        document_id="document",
        limit=3,
        strategy="hybrid_reasoning",
        provider="fake",
        model="m",
        now=NOW,
    )


def test_only_a_pending_job_starts_and_should_run() -> None:
    started = _job().start(LATER)

    assert (started.status, started.phase, started.cancellable) == (Job.RUNNING, "generating", True)
    assert _job().should_run() and not started.should_run()
    for status in (Job.RUNNING, Job.CANCELED, Job.SUCCEEDED):
        job = _job(status)
        assert job.start(LATER) is job


def test_a_pending_job_is_canceled_at_once_and_a_running_one_is_asked_to_stop() -> None:
    canceled = _job().cancel(LATER)
    requested = _job().start(NOW).cancel(LATER)

    assert (canceled.status, canceled.phase, canceled.cancellable) == (Job.CANCELED, "canceled", False)
    assert (requested.status, requested.phase) == (Job.CANCEL_REQUESTED, "canceling")
    assert requested.cancel(LATER) is requested
    assert canceled.cancel(LATER) is canceled


def test_a_committing_job_can_no_longer_be_canceled() -> None:
    committing = _job().start(NOW).begin_commit(LATER)

    assert (committing.status, committing.phase, committing.cancellable) == (
        Job.RUNNING,
        "committing",
        False,
    )
    with pytest.raises(DraftJobNotCancellableError, match="committing"):
        committing.cancel(LATER)
    with pytest.raises(DraftJobNotCancellableError, match="cancellable running phase"):
        committing.begin_commit(LATER)


@pytest.mark.parametrize("status", [Job.CANCEL_REQUESTED, Job.CANCELED])
def test_committing_after_a_cancellation_raises_without_changing_the_job(status: Job) -> None:
    with pytest.raises(DraftJobCanceledError):
        _job(status, cancellable=False).begin_commit(LATER)


def test_a_pending_job_cannot_commit_and_an_ended_one_stays_ended() -> None:
    with pytest.raises(DraftJobNotCancellableError):
        _job().begin_commit(LATER)
    succeeded = _job(Job.SUCCEEDED, phase="completed", cancellable=False)
    assert succeeded.begin_commit(LATER) is succeeded


@pytest.mark.parametrize(
    ("stop", "status", "error", "retries"),
    [
        (lambda job: job.fail("boom", LATER), Job.FAILED, "boom", 1),
        (lambda job: job.skip_for_missing_model("no model", LATER), Job.SKIPPED_MISSING_MODEL, "no model", 0),
        (lambda job: job.skip_for_unavailable_provider("down", LATER), Job.SKIPPED_PROVIDER_UNAVAILABLE, "down", 0),
        (lambda job: job.acknowledge_cancellation(LATER), Job.CANCELED, None, 0),
    ],
)
def test_a_job_ends_without_drafts_and_only_a_failure_counts_as_a_retry(
    stop, status: Job, error: str | None, retries: int
) -> None:
    ended = stop(_job(generated_count=2).start(NOW))

    assert (ended.status, ended.cancellable, ended.generated_count) == (status, False, 0)
    assert (ended.last_error, ended.retry_count) == (error, retries)
    assert ended.phase == ("canceled" if status is Job.CANCELED else "failed")
    assert stop(ended) is ended


def test_a_requested_cancellation_wins_over_a_failure() -> None:
    ended = _job().start(NOW).cancel(NOW).fail("boom", LATER)

    assert (ended.status, ended.phase, ended.last_error, ended.retry_count) == (
        Job.CANCELED,
        "canceled",
        None,
        0,
    )


def test_a_new_manual_operation_is_queued_and_cancellable() -> None:
    operation = _operation()

    assert (operation.status, operation.phase, operation.cancellable) == (Operation.QUEUED, "queued", True)
    assert (operation.generated_count, operation.unavailable_blocks, operation.commit_started_at) == (0, (), None)


def test_a_manual_operation_commits_once_and_keeps_its_first_commit_time() -> None:
    committing = _operation().start(NOW).begin_commit(LATER)

    assert (committing.phase, committing.cancellable, committing.commit_started_at) == (
        "committing",
        False,
        LATER,
    )
    assert committing.begin_commit("2026-10-27T02:00:00+00:00") is committing
    with pytest.raises(DraftJobNotCancellableError, match="committing"):
        committing.cancel(LATER)


def test_a_committed_manual_operation_can_no_longer_be_canceled() -> None:
    committed = replace(
        _operation(), status=Operation.SUCCEEDED, phase="completed", cancellable=False, commit_started_at=NOW
    )

    with pytest.raises(DraftJobNotCancellableError, match="committed"):
        committed.cancel(LATER)
    assert committed.fail("late", LATER) is committed


def test_a_queued_manual_operation_cannot_commit_or_restart_once_running() -> None:
    with pytest.raises(DraftJobNotCancellableError, match="cancellable running phase"):
        _operation().begin_commit(LATER)
    running = _operation().start(NOW)
    assert running.start(LATER) is running


def test_a_manual_operation_cancellation_wins_and_is_raised_at_commit() -> None:
    requested = _operation().start(NOW).cancel(LATER)

    assert (requested.status, requested.phase, requested.cancellable) == (
        Operation.CANCEL_REQUESTED,
        "canceling",
        False,
    )
    with pytest.raises(DraftJobCanceledError):
        requested.begin_commit(LATER)
    ended = requested.fail("boom", LATER)
    assert (ended.status, ended.phase, ended.error) == (Operation.CANCELED, "canceled", None)


def test_a_queued_manual_operation_is_canceled_at_once() -> None:
    canceled = _operation().cancel(LATER)

    assert (canceled.status, canceled.phase, canceled.cancellable) == (Operation.CANCELED, "canceled", False)
    assert canceled.cancel(LATER) is canceled
