"""Repository for storing and returning RuntimeInstallationJob aggregates."""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime
import sqlite3
from sqlite3 import Row
from threading import RLock

from cert_prep_backend.platform.database import Database
from cert_prep_backend.runtime_provisioning.domain.installation import (
    RuntimeInstallationJob,
    RuntimeInstallationPhase,
    RuntimeInstallationTarget,
)
from cert_prep_contracts.runtime import (
    RuntimeInstallationStatus,
    RuntimeRequirementKind,
)

__all__ = [
    "RuntimeInstallationJobRepository",
]

_MAX_RETAINED_JOBS = 100


class RuntimeInstallationJobRepository:
    """Thread-safe in-memory identity map with optional SQLite persistence."""

    def __init__(
        self,
        db: Database | None = None,
        *,
        max_retained_jobs: int = _MAX_RETAINED_JOBS,
        lock: RLock | None = None,
        on_evict: Callable[[str], None] | None = None,
    ) -> None:
        self._db = db
        self._max_retained_jobs = max_retained_jobs
        self._lock = lock if lock is not None else RLock()
        self._on_evict = on_evict
        self._jobs: dict[str, RuntimeInstallationJob] = {}

    @property
    def lock(self) -> RLock:
        return self._lock

    def get(self, job_id: str) -> RuntimeInstallationJob | None:
        with self._lock:
            return self._jobs.get(job_id)

    def require(self, job_id: str) -> RuntimeInstallationJob:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                raise KeyError(job_id)
            return job

    def active_job_for(self, kind: RuntimeRequirementKind) -> RuntimeInstallationJob | None:
        with self._lock:
            for job in self._jobs.values():
                if job.kind == kind and job.is_active:
                    return job
            return None

    def find_active_or_create(
        self,
        target: RuntimeInstallationTarget,
        create_fn: Callable[[], RuntimeInstallationJob],
    ) -> tuple[RuntimeInstallationJob, bool]:
        with self._lock:
            self._evict_terminal_jobs_locked()
            for job in self._jobs.values():
                if job.kind == target.kind and job.is_active:
                    return job, False
            job = create_fn()
            self._jobs[job.id] = job
            self._persist_job_locked(job)
            return job, True

    def add(self, job: RuntimeInstallationJob) -> RuntimeInstallationJob:
        with self._lock:
            self._jobs[job.id] = job
            self._persist_job_locked(job)
            if job.is_terminal:
                self._evict_terminal_jobs_locked()
            return job

    def save(self, job: RuntimeInstallationJob) -> None:
        with self._lock:
            self._jobs[job.id] = job
            self._persist_job_locked(job)
            if job.is_terminal:
                self._evict_terminal_jobs_locked()

    def update(
        self,
        job_id: str,
        transition: Callable[[RuntimeInstallationJob], RuntimeInstallationJob],
    ) -> RuntimeInstallationJob:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                raise KeyError(job_id)
            updated = transition(job)
            if updated is not job:
                self._jobs[job_id] = updated
                self._persist_job_locked(updated)
                if updated.is_terminal:
                    self._evict_terminal_jobs_locked()
            return updated

    def list_all(self) -> list[RuntimeInstallationJob]:
        with self._lock:
            return list(self._jobs.values())

    def recover(self, now: datetime) -> list[RuntimeInstallationJob]:
        if self._db is None:
            return []
        now_str = now.isoformat()
        with self._lock:
            with self._db.connect() as connection:
                connection.execute(
                    """
                    UPDATE runtime_installation_jobs
                    SET status = 'failed', phase = 'interrupted', cancellable = 0,
                        detail = 'Runtime installation was interrupted by an app restart.',
                        error = 'Runtime installation was interrupted by an app restart.',
                        updated_at = ?
                    WHERE status IN ('queued', 'running')
                    """,
                    (now_str,),
                )
                connection.execute(
                    """
                    UPDATE runtime_installation_jobs
                    SET status = 'canceled', phase = 'canceled', cancellable = 0,
                        detail = 'Runtime installation cancellation completed after restart.',
                        error = NULL, updated_at = ?
                    WHERE status = 'cancel_requested'
                    """,
                    (now_str,),
                )
                rows = connection.execute(
                    """
                    SELECT * FROM runtime_installation_jobs
                    ORDER BY updated_at DESC, created_at DESC, id DESC
                    LIMIT ?
                    """,
                    (self._max_retained_jobs,),
                ).fetchall()
            recovered: list[RuntimeInstallationJob] = []
            for row in reversed(rows):
                job = self._job_from_row(row)
                self._jobs[job.id] = job
                recovered.append(job)
            return recovered

    def _job_from_row(self, row: Row | sqlite3.Row) -> RuntimeInstallationJob:
        status = RuntimeInstallationStatus(str(row["status"]))
        return RuntimeInstallationJob(
            id=str(row["id"]),
            target=RuntimeInstallationTarget(
                kind=RuntimeRequirementKind(str(row["kind"])),
                provider=str(row["provider"]),
                model=str(row["model"]),
            ),
            status=status,
            phase=RuntimeInstallationPhase(str(row["phase"])),
            cancellable=bool(row["cancellable"]),
            detail=str(row["detail"]),
            completed=row["completed"],
            total=row["total"],
            created_at=datetime.fromisoformat(str(row["created_at"])),
            updated_at=datetime.fromisoformat(str(row["updated_at"])),
            commit_started_at=(
                datetime.fromisoformat(str(row["commit_started_at"]))
                if row["commit_started_at"] is not None
                else None
            ),
            error=row["error"],
        )

    def _persist_job_locked(self, job: RuntimeInstallationJob) -> None:
        if self._db is None:
            return
        with self._db.connect() as connection:
            connection.execute(
                """
                INSERT INTO runtime_installation_jobs(
                    id, kind, provider, model, status, phase, cancellable,
                    detail, completed, total, error, created_at, updated_at,
                    commit_started_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    status = excluded.status,
                    phase = excluded.phase,
                    cancellable = excluded.cancellable,
                    detail = excluded.detail,
                    completed = excluded.completed,
                    total = excluded.total,
                    error = excluded.error,
                    updated_at = excluded.updated_at,
                    commit_started_at = excluded.commit_started_at
                """,
                (
                    job.id,
                    job.kind.value,
                    job.provider,
                    job.model,
                    job.status.value,
                    job.phase.value,
                    int(job.cancellable),
                    job.detail,
                    job.completed,
                    job.total,
                    job.error,
                    job.created_at.isoformat(),
                    job.updated_at.isoformat(),
                    (
                        job.commit_started_at.isoformat()
                        if job.commit_started_at is not None
                        else None
                    ),
                ),
            )

    def _evict_terminal_jobs_locked(self) -> None:
        if len(self._jobs) <= self._max_retained_jobs:
            return
        terminal_jobs = sorted(
            (
                job
                for job in self._jobs.values()
                if job.is_terminal
            ),
            key=lambda job: job.updated_at,
        )
        for job in terminal_jobs:
            if len(self._jobs) <= self._max_retained_jobs:
                break
            self._jobs.pop(job.id, None)
            if self._on_evict is not None:
                self._on_evict(job.id)
