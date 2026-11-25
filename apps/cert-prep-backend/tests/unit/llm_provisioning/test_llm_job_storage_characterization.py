from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from llm_characterization_support import (
    installer as installer,
    make_installation as make_installation,
    no_ollama_start as no_ollama_start,
    runtime_clock as runtime_clock,
    worker_gates as worker_gates,
)

from cert_prep_backend.llm_provisioning.application.use_cases import (
    cancel_llm_installation,
    download_selected_model,
    start_llm_installation,
    view_llm_installation,
)
from cert_prep_backend.platform.config import Settings
from cert_prep_backend.platform.database import Database
from cert_prep_contracts.llm_installation import (
    LLMInstallProgress as Progress,
    LLMInstallationStatus as Status,
    LLMRequirementKind as Kind,
)


def seed_job(database, job_id, status, *, offset=0, error="old error", commit=None):
    timestamp = (datetime(2025, 1, 1, tzinfo=UTC) + timedelta(seconds=offset)).isoformat()
    with database.connect() as connection:
        connection.execute(
            """
            INSERT INTO llm_installation_jobs(
                id, kind, provider, model, status, phase, cancellable,
                detail, completed, total, error, created_at, updated_at, commit_started_at
            ) VALUES (?, 'ollama', 'saved-provider', 'saved-model', ?, 'saved-phase', 1,
                      'saved detail', 4, NULL, ?, ?, ?, ?)
            """,
            (job_id, status, error, timestamp, timestamp, commit),
        )


def saved_job(database, job_id):
    with database.connect() as connection:
        return dict(connection.execute(
            "SELECT * FROM llm_installation_jobs WHERE id = ?", (job_id,),
        ).fetchone())


@pytest.mark.parametrize("original", list(Status))
def test_restart_recovery_preserves_columns_and_applies_status_rules(
    tmp_path, make_installation, installer, original,
):
    database = Database(Settings(data_dir=tmp_path))
    commit = "2025-01-01T00:00:00+00:00"
    seed_job(database, "saved-job", original, commit=commit)
    before = saved_job(database, "saved-job")
    installation = make_installation(db=database)
    recovered = view_llm_installation(installation, "saved-job")
    after = saved_job(database, "saved-job")

    if original in {Status.QUEUED, Status.RUNNING}:
        assert recovered.status == Status.FAILED
        assert recovered.phase == "interrupted" and recovered.cancellable is False
        assert recovered.detail == recovered.error == (
            "LLM installation was interrupted by an app restart."
        )
    elif original == Status.CANCEL_REQUESTED:
        assert recovered.status == Status.CANCELED
        assert recovered.phase == "canceled" and recovered.cancellable is False
        assert recovered.detail == "LLM installation cancellation completed after restart."
        assert recovered.error is None
    else:
        assert after == before
        assert recovered.status == original
        assert recovered.error == "old error"

    changed = {"status", "phase", "cancellable", "detail", "error", "updated_at"}
    assert {key: value for key, value in after.items() if key not in changed} == {
        key: value for key, value in before.items() if key not in changed
    }
    assert recovered.commit_started_at == commit
    assert (recovered.provider, recovered.model, recovered.completed, recovered.total) == (
        "saved-provider", "saved-model", 4, None,
    )
    if original in {Status.QUEUED, Status.RUNNING, Status.CANCEL_REQUESTED}:
        assert after["updated_at"] > before["updated_at"]
    if original == Status.WAITING_FOR_USER:
        assert view_llm_installation(installation, "saved-job") == recovered
        installer.available = True
        ready = view_llm_installation(installation, "saved-job")
        assert ready.status == Status.SUCCEEDED
        assert ready.error is None
        assert saved_job(database, "saved-job")["error"] is None


def test_waiting_cancellation_finishes_only_after_restart(tmp_path, make_installation, installer):
    database = Database(Settings(data_dir=tmp_path))
    installer.action = lambda progress: Status.WAITING_FOR_USER
    first = make_installation(db=database)
    waiting = start_llm_installation(first, Kind.OLLAMA)
    requested = cancel_llm_installation(first, waiting.id)
    assert requested.status == Status.CANCEL_REQUESTED
    assert saved_job(database, waiting.id)["status"] == "cancel_requested"

    second = make_installation(db=database)
    recovered = view_llm_installation(second, waiting.id)
    assert recovered.status == Status.CANCELED
    assert recovered.detail == "LLM installation cancellation completed after restart."
    assert recovered.error is None
    assert saved_job(database, waiting.id)["status"] == "canceled"


def test_wait_for_user_persists_every_column(tmp_path, make_installation, installer):
    database = Database(Settings(data_dir=tmp_path))

    def waiting_after_partial_progress(progress):
        progress(Progress("downloaded", 70, 90))
        return Status.WAITING_FOR_USER

    installer.action = waiting_after_partial_progress
    waiting = start_llm_installation(make_installation(db=database), Kind.OLLAMA)
    row = saved_job(database, waiting.id)
    assert (row["status"], row["phase"], row["cancellable"]) == (
        "waiting_for_user", "waiting_for_user", 1,
    )
    assert (row["detail"], row["completed"], row["total"], row["error"]) == (
        "Manual setup required", None, 80, None,
    )
    assert row["commit_started_at"] is None
    assert row["updated_at"] == waiting.updated_at
    assert (row["kind"], row["provider"], row["model"]) == ("ollama", "test-provider", "test-model")


def test_wait_for_user_after_cancel_request_persists_canceled_columns(
    tmp_path, make_installation, installer,
):
    database = Database(Settings(data_dir=tmp_path))
    installation = make_installation(db=database)

    def cancel_then_wait(progress):
        progress(Progress("downloaded", 70, 90))
        [stored] = installation.jobs.list_all()
        cancel_llm_installation(installation, stored.id)
        return Status.WAITING_FOR_USER

    installer.action = cancel_then_wait
    result = start_llm_installation(installation, Kind.OLLAMA)
    row = saved_job(database, result.id)
    assert (row["status"], row["phase"], row["cancellable"]) == ("canceled", "canceled", 0)
    assert row["detail"] == "LLM installation canceled"
    assert row["error"] is None
    # The use-case path applies the waiting counts even when cancellation wins;
    # LLMInstallationJob.wait_for_user keeps the prior (70, 90) instead.
    assert (row["completed"], row["total"]) == (None, 80)
    assert row["commit_started_at"] is None
    assert row["updated_at"] == result.updated_at


def test_recovery_retains_exact_newest_100_with_created_and_id_tiebreaks(tmp_path, make_installation):
    database = Database(Settings(data_dir=tmp_path))
    for index in range(105):
        seed_job(database, f"history-{index:03}", Status.SUCCEEDED, offset=index)
    # Equal updated timestamps sort by created_at, then descending id.
    with database.connect() as connection:
        connection.execute("UPDATE llm_installation_jobs SET updated_at = '2025-12-01T00:00:00+00:00'")
        connection.execute(
            "UPDATE llm_installation_jobs SET created_at = '2025-01-01T00:01:44+00:00' "
            "WHERE id IN ('history-000', 'history-001')"
        )
        expected = [str(row["id"]) for row in connection.execute(
            "SELECT id FROM llm_installation_jobs "
            "ORDER BY updated_at DESC, created_at DESC, id DESC LIMIT 100"
        )]
    installation = make_installation(db=database)
    assert expected[:3] == ["history-104", "history-001", "history-000"]
    assert [job.id for job in installation.jobs.list_all()] == list(reversed(expected))
    for index in range(105):
        job_id = f"history-{index:03}"
        if job_id in expected:
            assert view_llm_installation(installation, job_id).id == job_id
        else:
            with pytest.raises(KeyError):
                view_llm_installation(installation, job_id)
    with database.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM llm_installation_jobs").fetchone()[0] == 105


@pytest.mark.parametrize("status", [Status.QUEUED, Status.RUNNING, Status.CANCEL_REQUESTED])
def test_recovery_updates_old_rows_before_selecting_retained_history(tmp_path, make_installation, status):
    database = Database(Settings(data_dir=tmp_path))
    seed_job(database, "old-active", status)
    for index in range(105):
        seed_job(database, f"history-{index:03}", Status.SUCCEEDED, offset=index + 1)
    installation = make_installation(db=database)
    assert saved_job(database, "old-active")["status"] == (
        "canceled" if status == Status.CANCEL_REQUESTED else "failed"
    )
    assert view_llm_installation(installation, "old-active").status == (
        Status.CANCELED if status == Status.CANCEL_REQUESTED else Status.FAILED
    )
    assert len(installation.jobs.list_all()) == 100
    with pytest.raises(KeyError):
        view_llm_installation(installation, "history-000")


def test_eviction_uses_oldest_terminal_update_and_keeps_active_and_database_history(
    tmp_path, make_installation, installer,
):
    database = Database(Settings(data_dir=tmp_path))
    model = type(installer)(Kind.OLLAMA_MODEL)
    model.available = True
    # A separate kind avoids readiness bypass creating successes for the active kind.
    installation = make_installation(db=database, async_jobs=True, installers=[installer, model])
    active = start_llm_installation(installation, Kind.OLLAMA)
    finished = [download_selected_model(installation) for _ in range(101)]
    assert view_llm_installation(installation, active.id) == active
    for job in finished[:2]:
        with pytest.raises(KeyError):
            view_llm_installation(installation, job.id)
        assert saved_job(database, job.id)["status"] == "succeeded"
    assert [job.id for job in installation.jobs.list_all()] == [active.id, *(job.id for job in finished[2:])]
    assert view_llm_installation(installation, finished[-1].id) == finished[-1]
    with database.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM llm_installation_jobs").fetchone()[0] == 102


def test_terminal_finalization_evicts_oldest_terminal_not_oldest_active(
    tmp_path, make_installation, installer,
):
    database = Database(Settings(data_dir=tmp_path))
    for index in range(100):
        seed_job(database, f"history-{index:03}", Status.SUCCEEDED, offset=index)
    # The newest-created job is oldest by updated_at, so creation order alone
    # would evict the wrong job.
    with database.connect() as connection:
        connection.execute(
            "UPDATE llm_installation_jobs SET updated_at = '2024-01-01T00:00:00+00:00' "
            "WHERE id = 'history-099'"
        )
    installation = make_installation(db=database)
    result = start_llm_installation(installation, Kind.OLLAMA)
    assert result.status == Status.SUCCEEDED
    with pytest.raises(KeyError):
        view_llm_installation(installation, "history-099")
    assert view_llm_installation(installation, "history-000").status == Status.SUCCEEDED
    assert len(installation.jobs.list_all()) == 100
    assert saved_job(database, "history-099")["status"] == "succeeded"


def test_database_less_mode_has_same_lifecycle_and_100_job_retention(
    tmp_path, make_installation, installer,
):
    installer.available = True
    installation = make_installation()
    jobs = [start_llm_installation(installation, Kind.OLLAMA) for _ in range(103)]
    for job in jobs[:3]:
        with pytest.raises(KeyError):
            view_llm_installation(installation, job.id)
    assert [job.id for job in installation.jobs.list_all()] == [job.id for job in jobs[3:]]
    assert view_llm_installation(installation, jobs[-1].id) == jobs[-1]
    assert not Settings(data_dir=tmp_path).database_path.exists()


@pytest.mark.parametrize("bytes_count", [None, 0])
def test_available_requirement_preserves_null_or_zero_counts(make_installation, installer, bytes_count):
    installer.available = True
    installer.bytes = bytes_count
    result = start_llm_installation(make_installation(), Kind.OLLAMA)
    assert result.completed == result.total == bytes_count
