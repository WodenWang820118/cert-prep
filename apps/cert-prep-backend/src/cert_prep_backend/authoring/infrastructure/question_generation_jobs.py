from __future__ import annotations

from collections.abc import Callable
from sqlite3 import Connection, Row
from uuid import uuid4

from cert_prep_backend.authoring.application.ports import (
    QuestionSources,
    ProjectSources,
    StudyProjects,
)
from cert_prep_backend.authoring.domain.generation import (
    JOB_RETRYABLE_STATUSES,
    QuestionGenerationJob,
    QuestionGenerationJobStatus,
)
from cert_prep_backend.platform.database import Database, utc_now
from cert_prep_backend.platform.errors import NotFoundError


def enqueue_chunk_job(
    db: Database,
    *,
    project_id: str,
    source_id: str,
    chunk_id: str,
    page_number: int,
    strategy: str,
    provider: str,
    model: str,
    projects: StudyProjects,
    sources: QuestionSources,
) -> QuestionGenerationJob:
    """Create or return the idempotent question job for one source chunk."""

    if not projects.exists(project_id):
        raise NotFoundError("Project not found.")
    sources.chunk(project_id, source_id, chunk_id)
    now = utc_now()
    with db.connect() as connection:
        connection.execute(
            """
            INSERT INTO question_generation_jobs(
                id, project_id, source_id, chunk_id, source_chunk_id,
                page_number, strategy,
                status, provider, model, generated_count, retry_count,
                last_error, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, NULL, ?, ?)
            ON CONFLICT(source_id, chunk_id, strategy) DO NOTHING
            """,
            (
                str(uuid4()),
                project_id,
                source_id,
                chunk_id,
                chunk_id,
                page_number,
                strategy,
                QuestionGenerationJobStatus.PENDING,
                provider,
                model,
                now,
                now,
            ),
        )
        row = connection.execute(
            """
            SELECT *
            FROM question_generation_jobs
            WHERE project_id = ? AND source_id = ? AND chunk_id = ? AND strategy = ?
            """,
            (project_id, source_id, chunk_id, strategy),
        ).fetchone()
    if row is None:
        raise NotFoundError("Question generation job not found.")
    return job_from_row(row)


def list_source_jobs(
    db: Database,
    project_id: str,
    source_id: str,
    *,
    sources: ProjectSources,
) -> list[QuestionGenerationJob]:
    sources.require(project_id, source_id)
    with db.connect() as connection:
        rows = connection.execute(
            """
            SELECT *
            FROM question_generation_jobs
            WHERE project_id = ? AND source_id = ?
            ORDER BY page_number, created_at, id
            """,
            (project_id, source_id),
        ).fetchall()
    return [job_from_row(row) for row in rows]


def recover_runnable_jobs(db: Database) -> list[QuestionGenerationJob]:
    """Return pending jobs from durable storage, resetting interrupted running jobs."""

    now = utc_now()
    with db.connect() as connection:
        connection.execute(
            """
            UPDATE question_generation_jobs
            SET status = ?,
                phase = 'failed',
                cancellable = 0,
                last_error = COALESCE(
                    last_error,
                    'Source chunk is no longer available.'
                ),
                updated_at = ?
            WHERE chunk_id IS NULL
              AND status IN (?, ?)
            """,
            (
                QuestionGenerationJobStatus.FAILED,
                now,
                QuestionGenerationJobStatus.PENDING,
                QuestionGenerationJobStatus.RUNNING,
            ),
        )
        connection.execute(
            """
            UPDATE question_generation_jobs
            SET status = ?,
                phase = 'queued',
                cancellable = 1,
                last_error = 'Question generation was interrupted before completion.',
                updated_at = ?
            WHERE status = ?
            """,
            (
                QuestionGenerationJobStatus.PENDING,
                now,
                QuestionGenerationJobStatus.RUNNING,
            ),
        )
        connection.execute(
            """
            UPDATE question_generation_jobs
            SET status = ?,
                phase = 'canceled',
                cancellable = 0,
                last_error = NULL,
                updated_at = ?
            WHERE status = ?
            """,
            (
                QuestionGenerationJobStatus.CANCELED,
                now,
                QuestionGenerationJobStatus.CANCEL_REQUESTED,
            ),
        )
        rows = connection.execute(
            """
            SELECT *
            FROM question_generation_jobs
            WHERE status = ?
              AND chunk_id IS NOT NULL
            ORDER BY updated_at, page_number, created_at, id
            """,
            (QuestionGenerationJobStatus.PENDING,),
        ).fetchall()
    return [job_from_row(row) for row in rows]


def retry_source_jobs(
    db: Database,
    *,
    project_id: str,
    source_id: str,
    provider: str,
    model: str,
    sources: ProjectSources,
) -> list[QuestionGenerationJob]:
    """Requeue retryable terminal jobs for a source after runtime blockers clear."""

    sources.require(project_id, source_id)
    now = utc_now()
    retryable_statuses = tuple(status.value for status in JOB_RETRYABLE_STATUSES)
    with db.connect() as connection:
        connection.execute(
            """
            UPDATE question_generation_jobs
            SET status = ?,
                phase = 'queued',
                cancellable = 1,
                provider = ?,
                model = ?,
                effective_provider = NULL,
                effective_model = NULL,
                fallback_reason = NULL,
                generated_count = 0,
                retry_count = retry_count + 1,
                last_error = NULL,
                updated_at = ?
            WHERE project_id = ?
              AND source_id = ?
              AND status IN (?, ?, ?, ?)
              AND chunk_id IS NOT NULL
            """,
            (
                QuestionGenerationJobStatus.PENDING,
                provider,
                model,
                now,
                project_id,
                source_id,
                *retryable_statuses,
            ),
        )
        rows = connection.execute(
            """
            SELECT *
            FROM question_generation_jobs
            WHERE project_id = ?
              AND source_id = ?
              AND status = ?
              AND chunk_id IS NOT NULL
            ORDER BY updated_at, page_number, created_at, id
            """,
            (project_id, source_id, QuestionGenerationJobStatus.PENDING),
        ).fetchall()
    return [job_from_row(row) for row in rows]


def get_job(db: Database, job_id: str) -> QuestionGenerationJob:
    with db.connect() as connection:
        row = connection.execute(
            "SELECT * FROM question_generation_jobs WHERE id = ?",
            (job_id,),
        ).fetchone()
    if row is None:
        raise NotFoundError("Question generation job not found.")
    return job_from_row(row)


def mark_running(db: Database, job_id: str) -> QuestionGenerationJob:
    return _transition(db, job_id, lambda job, now: job.start(now))


def begin_commit(db: Database, job_id: str) -> QuestionGenerationJob:
    """Win the cancel-vs-commit race and publish the non-cancellable phase."""

    return _transition(db, job_id, lambda job, now: job.begin_commit(now))


def request_cancel(
    db: Database,
    *,
    project_id: str,
    source_id: str,
    job_id: str,
    sources: ProjectSources,
) -> QuestionGenerationJob:
    """Cancel pending work or request cooperative cancellation for running work."""

    sources.require(project_id, source_id)
    return _transition(
        db,
        job_id,
        lambda job, now: job.cancel(now),
        owner=(project_id, source_id),
    )


def mark_canceled(db: Database, job_id: str) -> QuestionGenerationJob:
    return _transition(db, job_id, lambda job, now: job.acknowledge_cancellation(now))


def mark_skipped_missing_model(db: Database, job_id: str, *, detail: str) -> QuestionGenerationJob:
    return _transition(db, job_id, lambda job, now: job.skip_for_missing_model(detail, now))


def mark_skipped_provider_unavailable(
    db: Database, job_id: str, *, detail: str
) -> QuestionGenerationJob:
    return _transition(db, job_id, lambda job, now: job.skip_for_unavailable_provider(detail, now))


def mark_failed(db: Database, job_id: str, *, detail: str) -> QuestionGenerationJob:
    return _transition(db, job_id, lambda job, now: job.fail(detail, now))


def job_from_row(row: Row) -> QuestionGenerationJob:
    return QuestionGenerationJob(
        id=row["id"],
        project_id=row["project_id"],
        source_id=row["source_id"],
        chunk_id=row["chunk_id"] or row["source_chunk_id"],
        page_number=row["page_number"],
        strategy=row["strategy"],
        status=QuestionGenerationJobStatus(row["status"]),
        provider=row["provider"],
        model=row["model"],
        effective_provider=_optional_row_value(row, "effective_provider"),
        effective_model=_optional_row_value(row, "effective_model"),
        fallback_reason=_optional_row_value(row, "fallback_reason"),
        phase=_optional_row_value(row, "phase") or "queued",
        cancellable=bool(_optional_row_value(row, "cancellable")),
        generated_count=row["generated_count"],
        retry_count=row["retry_count"],
        last_error=row["last_error"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def _transition(
    db: Database,
    job_id: str,
    decide: Callable[[QuestionGenerationJob, str], QuestionGenerationJob],
    *,
    owner: tuple[str, str] | None = None,
) -> QuestionGenerationJob:
    """Lock the job, let the aggregate decide its next state, and store that state."""

    now = utc_now()
    with db.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = _job_row(connection, job_id, owner)
        if row is None:
            raise NotFoundError("Question generation job not found.")
        job = job_from_row(row)
        after = decide(job, now)
        if after is job:
            return job
        _apply(connection, job, after)
        row = _job_row(connection, job_id, None)
    if row is None:
        raise NotFoundError("Question generation job not found.")
    return job_from_row(row)


def _job_row(connection: Connection, job_id: str, owner: tuple[str, str] | None) -> Row | None:
    if owner is None:
        return connection.execute(
            "SELECT * FROM question_generation_jobs WHERE id = ?",
            (job_id,),
        ).fetchone()
    project_id, source_id = owner
    return connection.execute(
        """
        SELECT * FROM question_generation_jobs
        WHERE id = ? AND project_id = ? AND source_id = ?
        """,
        (job_id, project_id, source_id),
    ).fetchone()


def _apply(connection: Connection, before: QuestionGenerationJob, after: QuestionGenerationJob) -> None:
    """Store a transition only if the job is still in the state it was decided from."""

    updated = connection.execute(
        """
        UPDATE question_generation_jobs
        SET status = ?, phase = ?, cancellable = ?, generated_count = ?, retry_count = ?,
            last_error = ?, updated_at = ?
        WHERE id = ? AND status = ?
        """,
        (
            after.status.value,
            after.phase,
            int(after.cancellable),
            after.generated_count,
            after.retry_count,
            after.last_error,
            after.updated_at,
            before.id,
            before.status.value,
        ),
    )
    if updated.rowcount != 1:
        raise RuntimeError("Question generation job changed while it was locked.")


def _optional_row_value(row: Row, column: str):
    return row[column] if column in row.keys() else None


def _discard_unfinished_jobs(connection: Connection, project_id: str, source_id: str) -> None:
    connection.execute(
        """
        DELETE FROM question_generation_jobs
        WHERE project_id = ? AND source_id = ?
            AND status IN ('pending', 'running', 'cancel_requested')
        """,
        (project_id, source_id),
    )


class SqliteQuestionGenerationJobRepository:
    """Question generation jobs stored in SQLite."""

    def __init__(
        self,
        db: Database,
        connection: Connection | None = None,
        *,
        sources: ProjectSources,
    ) -> None:
        # A caller's connection joins that transaction. Source Library passes the connection
        # of the source run it stops or retries, so the jobs go with that run's writes.
        self._db = db
        self._connection = connection
        self._sources = sources

    def jobs_of(self, project_id: str, source_id: str) -> list[QuestionGenerationJob]:
        return list_source_jobs(self._db, project_id, source_id, sources=self._sources)

    def cancel(self, project_id: str, source_id: str, job_id: str) -> QuestionGenerationJob:
        return request_cancel(
            self._db,
            project_id=project_id,
            source_id=source_id,
            job_id=job_id,
            sources=self._sources,
        )

    def discard_unfinished(self, project_id: str, source_id: str) -> None:
        if self._connection is not None:
            _discard_unfinished_jobs(self._connection, project_id, source_id)
            return
        with self._db.connect() as connection:
            _discard_unfinished_jobs(connection, project_id, source_id)
