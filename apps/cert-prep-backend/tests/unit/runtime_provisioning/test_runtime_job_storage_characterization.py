from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from runtime_characterization_support import (
    installer as installer,
    make_manager as make_manager,
    no_ollama_start as no_ollama_start,
    runtime_clock as runtime_clock,
    worker_gates as worker_gates,
)

from cert_prep_backend.platform.config import Settings
from cert_prep_backend.platform.database import Database
from cert_prep_contracts.runtime import (
    RuntimeInstallationStatus as Status,
    RuntimeRequirementKind as Kind,
)


def seed_job(database, job_id, status, *, offset=0, error="old error", commit=None):
    timestamp = (datetime(2025, 1, 1, tzinfo=UTC) + timedelta(seconds=offset)).isoformat()
    with database.connect() as connection:
        connection.execute(
            """
            INSERT INTO runtime_installation_jobs(
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
            "SELECT * FROM runtime_installation_jobs WHERE id = ?", (job_id,),
        ).fetchone())


@pytest.mark.parametrize("original", list(Status))
def test_restart_recovery_preserves_columns_and_applies_status_rules(
    tmp_path, make_manager, installer, original,
):
    database = Database(Settings(data_dir=tmp_path))
    commit = "2025-01-01T00:00:00+00:00"
    seed_job(database, "saved-job", original, commit=commit)
    before = saved_job(database, "saved-job")
    manager = make_manager(db=database)
    recovered = manager.get_installation("saved-job")
    after = saved_job(database, "saved-job")

    if original in {Status.QUEUED, Status.RUNNING}:
        assert recovered.status == Status.FAILED
        assert recovered.phase == "interrupted" and recovered.cancellable is False
        assert recovered.detail == recovered.error == (
            "Runtime installation was interrupted by an app restart."
        )
    elif original == Status.CANCEL_REQUESTED:
        assert recovered.status == Status.CANCELED
        assert recovered.phase == "canceled" and recovered.cancellable is False
        assert recovered.detail == "Runtime installation cancellation completed after restart."
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
        assert manager.get_installation("saved-job") == recovered
        installer.available = True
        ready = manager.get_installation("saved-job")
        assert ready.status == Status.SUCCEEDED
        assert ready.error is None
        assert saved_job(database, "saved-job")["error"] is None


def test_waiting_cancellation_finishes_only_after_restart(tmp_path, make_manager, installer):
    database = Database(Settings(data_dir=tmp_path))
    installer.action = lambda progress: Status.WAITING_FOR_USER
    first = make_manager(db=database)
    waiting = first.start_installation(Kind.OLLAMA)
    requested = first.cancel_installation(waiting.id)
    assert requested.status == Status.CANCEL_REQUESTED
    assert saved_job(database, waiting.id)["status"] == "cancel_requested"

    second = make_manager(db=database)
    recovered = second.get_installation(waiting.id)
    assert recovered.status == Status.CANCELED
    assert recovered.detail == "Runtime installation cancellation completed after restart."
    assert recovered.error is None
    assert saved_job(database, waiting.id)["status"] == "canceled"


def test_recovery_retains_exact_newest_100_with_created_and_id_tiebreaks(tmp_path, make_manager):
    database = Database(Settings(data_dir=tmp_path))
    for index in range(105):
        seed_job(database, f"history-{index:03}", Status.SUCCEEDED, offset=index)
    # Equal updated timestamps sort by created_at, then descending id.
    with database.connect() as connection:
        connection.execute("UPDATE runtime_installation_jobs SET updated_at = '2025-12-01T00:00:00+00:00'")
        connection.execute(
            "UPDATE runtime_installation_jobs SET created_at = '2025-01-01T00:01:44+00:00' "
            "WHERE id IN ('history-000', 'history-001')"
        )
        expected = [str(row["id"]) for row in connection.execute(
            "SELECT id FROM runtime_installation_jobs "
            "ORDER BY updated_at DESC, created_at DESC, id DESC LIMIT 100"
        )]
    manager = make_manager(db=database)
    assert expected[:3] == ["history-104", "history-001", "history-000"]
    assert list(manager._jobs) == list(reversed(expected))
    for index in range(105):
        job_id = f"history-{index:03}"
        if job_id in expected:
            assert manager.get_installation(job_id).id == job_id
        else:
            with pytest.raises(KeyError):
                manager.get_installation(job_id)
    with database.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM runtime_installation_jobs").fetchone()[0] == 105


@pytest.mark.parametrize("status", [Status.QUEUED, Status.RUNNING, Status.CANCEL_REQUESTED])
def test_recovery_updates_old_rows_before_selecting_retained_history(tmp_path, make_manager, status):
    database = Database(Settings(data_dir=tmp_path))
    seed_job(database, "old-active", status)
    for index in range(105):
        seed_job(database, f"history-{index:03}", Status.SUCCEEDED, offset=index + 1)
    manager = make_manager(db=database)
    assert saved_job(database, "old-active")["status"] == (
        "canceled" if status == Status.CANCEL_REQUESTED else "failed"
    )
    assert manager.get_installation("old-active").status == (
        Status.CANCELED if status == Status.CANCEL_REQUESTED else Status.FAILED
    )
    assert len(manager._jobs) == 100
    with pytest.raises(KeyError):
        manager.get_installation("history-000")


def test_eviction_uses_oldest_terminal_update_and_keeps_active_and_database_history(
    tmp_path, make_manager, installer,
):
    database = Database(Settings(data_dir=tmp_path))
    model = type(installer)(Kind.OLLAMA_MODEL)
    model.available = True
    # A separate kind avoids readiness bypass creating successes for the active kind.
    manager = make_manager(db=database, async_jobs=True, installers=[installer, model])
    active = manager.start_installation(Kind.OLLAMA)
    finished = [manager.start_model_installation() for _ in range(101)]
    assert manager.get_installation(active.id) == active
    for job in finished[:2]:
        with pytest.raises(KeyError):
            manager.get_installation(job.id)
        assert saved_job(database, job.id)["status"] == "succeeded"
    assert list(manager._jobs) == [active.id, *(job.id for job in finished[2:])]
    assert manager.get_installation(finished[-1].id) == finished[-1]
    with database.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM runtime_installation_jobs").fetchone()[0] == 102


def test_terminal_finalization_evicts_oldest_terminal_not_oldest_active(
    tmp_path, make_manager, installer,
):
    database = Database(Settings(data_dir=tmp_path))
    for index in range(100):
        seed_job(database, f"history-{index:03}", Status.SUCCEEDED, offset=index)
    # The newest-created job is oldest by updated_at, so creation order alone
    # would evict the wrong job.
    with database.connect() as connection:
        connection.execute(
            "UPDATE runtime_installation_jobs SET updated_at = '2024-01-01T00:00:00+00:00' "
            "WHERE id = 'history-099'"
        )
    manager = make_manager(db=database)
    result = manager.start_installation(Kind.OLLAMA)
    assert result.status == Status.SUCCEEDED
    with pytest.raises(KeyError):
        manager.get_installation("history-099")
    assert manager.get_installation("history-000").status == Status.SUCCEEDED
    assert len(manager._jobs) == 100
    assert saved_job(database, "history-099")["status"] == "succeeded"


def test_database_less_mode_has_same_lifecycle_and_100_job_retention(
    tmp_path, make_manager, installer,
):
    installer.available = True
    manager = make_manager()
    jobs = [manager.start_installation(Kind.OLLAMA) for _ in range(103)]
    for job in jobs[:3]:
        with pytest.raises(KeyError):
            manager.get_installation(job.id)
    assert list(manager._jobs) == [job.id for job in jobs[3:]]
    assert manager.get_installation(jobs[-1].id) == jobs[-1]
    assert not Settings(data_dir=tmp_path).database_path.exists()


@pytest.mark.parametrize("bytes_count", [None, 0])
def test_available_requirement_preserves_null_or_zero_counts(make_manager, installer, bytes_count):
    installer.available = True
    installer.bytes = bytes_count
    result = make_manager().start_installation(Kind.OLLAMA)
    assert result.completed == result.total == bytes_count
