from __future__ import annotations

from enum import StrEnum
from sqlite3 import Row
from uuid import uuid4

from cert_prep_backend.persistence.database import Database, utc_now
from cert_prep_backend.domains.projects.repository import ensure_project_exists
from cert_prep_backend.domains.source_documents import repository as documents_repository
from cert_prep_backend.api.errors import NotFoundError


class DraftGenerationJobStatus(StrEnum):
    PENDING = "pending"
    RUNNING = "running"
    CANCEL_REQUESTED = "cancel_requested"
    CANCELED = "canceled"
    SUCCEEDED = "succeeded"
    SKIPPED_PROVIDER_UNAVAILABLE = "skipped_provider_unavailable"
    SKIPPED_MISSING_MODEL = "skipped_missing_model"
    FAILED = "failed"


TERMINAL_STATUSES = {
    DraftGenerationJobStatus.SUCCEEDED,
    DraftGenerationJobStatus.SKIPPED_PROVIDER_UNAVAILABLE,
    DraftGenerationJobStatus.SKIPPED_MISSING_MODEL,
    DraftGenerationJobStatus.FAILED,
    DraftGenerationJobStatus.CANCELED,
}
RETRYABLE_STATUSES = {
    DraftGenerationJobStatus.SKIPPED_PROVIDER_UNAVAILABLE,
    DraftGenerationJobStatus.SKIPPED_MISSING_MODEL,
    DraftGenerationJobStatus.FAILED,
    DraftGenerationJobStatus.CANCELED,
}


class DraftJobCanceledError(RuntimeError):
    """Raised when cancellation wins before a draft job commit begins."""


class DraftJobNotCancellableError(RuntimeError):
    """Raised after a draft job has entered its atomic commit phase."""


def enqueue_chunk_job(
    db: Database,
    *,
    project_id: str,
    document_id: str,
    chunk_id: str,
    page_number: int,
    strategy: str,
    provider: str,
    model: str,
) -> dict:
    """Create or return the idempotent draft job for one source chunk."""

    ensure_project_exists(db, project_id)
    documents_repository.get_chunk(db, project_id, document_id, chunk_id)
    now = utc_now()
    with db.connect() as connection:
        connection.execute(
            """
            INSERT INTO draft_generation_jobs(
                id, project_id, document_id, chunk_id, source_chunk_id,
                page_number, strategy,
                status, provider, model, generated_count, retry_count,
                last_error, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, NULL, ?, ?)
            ON CONFLICT(document_id, chunk_id, strategy) DO NOTHING
            """,
            (
                str(uuid4()),
                project_id,
                document_id,
                chunk_id,
                chunk_id,
                page_number,
                strategy,
                DraftGenerationJobStatus.PENDING,
                provider,
                model,
                now,
                now,
            ),
        )
        row = connection.execute(
            """
            SELECT *
            FROM draft_generation_jobs
            WHERE project_id = ? AND document_id = ? AND chunk_id = ? AND strategy = ?
            """,
            (project_id, document_id, chunk_id, strategy),
        ).fetchone()
    if row is None:
        raise NotFoundError("Draft generation job not found.")
    return job_from_row(row)


def list_document_jobs(db: Database, project_id: str, document_id: str) -> list[dict]:
    documents_repository.ensure_document_exists(db, project_id, document_id)
    with db.connect() as connection:
        rows = connection.execute(
            """
            SELECT *
            FROM draft_generation_jobs
            WHERE project_id = ? AND document_id = ?
            ORDER BY page_number, created_at, id
            """,
            (project_id, document_id),
        ).fetchall()
    return [job_from_row(row) for row in rows]


def recover_runnable_jobs(db: Database) -> list[dict]:
    """Return pending jobs from durable storage, resetting interrupted running jobs."""

    now = utc_now()
    with db.connect() as connection:
        connection.execute(
            """
            UPDATE draft_generation_jobs
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
                DraftGenerationJobStatus.FAILED,
                now,
                DraftGenerationJobStatus.PENDING,
                DraftGenerationJobStatus.RUNNING,
            ),
        )
        connection.execute(
            """
            UPDATE draft_generation_jobs
            SET status = ?,
                phase = 'queued',
                cancellable = 1,
                last_error = 'Draft generation was interrupted before completion.',
                updated_at = ?
            WHERE status = ?
            """,
            (
                DraftGenerationJobStatus.PENDING,
                now,
                DraftGenerationJobStatus.RUNNING,
            ),
        )
        connection.execute(
            """
            UPDATE draft_generation_jobs
            SET status = ?,
                phase = 'canceled',
                cancellable = 0,
                last_error = NULL,
                updated_at = ?
            WHERE status = ?
            """,
            (
                DraftGenerationJobStatus.CANCELED,
                now,
                DraftGenerationJobStatus.CANCEL_REQUESTED,
            ),
        )
        rows = connection.execute(
            """
            SELECT *
            FROM draft_generation_jobs
            WHERE status = ?
              AND chunk_id IS NOT NULL
            ORDER BY updated_at, page_number, created_at, id
            """,
            (DraftGenerationJobStatus.PENDING,),
        ).fetchall()
    return [job_from_row(row) for row in rows]


def retry_document_jobs(
    db: Database,
    *,
    project_id: str,
    document_id: str,
    provider: str,
    model: str,
) -> list[dict]:
    """Requeue retryable terminal jobs for a document after runtime blockers clear."""

    documents_repository.ensure_document_exists(db, project_id, document_id)
    now = utc_now()
    retryable_statuses = tuple(status.value for status in RETRYABLE_STATUSES)
    with db.connect() as connection:
        connection.execute(
            """
            UPDATE draft_generation_jobs
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
              AND document_id = ?
              AND status IN (?, ?, ?, ?)
              AND chunk_id IS NOT NULL
            """,
            (
                DraftGenerationJobStatus.PENDING,
                provider,
                model,
                now,
                project_id,
                document_id,
                *retryable_statuses,
            ),
        )
        rows = connection.execute(
            """
            SELECT *
            FROM draft_generation_jobs
            WHERE project_id = ?
              AND document_id = ?
              AND status = ?
              AND chunk_id IS NOT NULL
            ORDER BY updated_at, page_number, created_at, id
            """,
            (project_id, document_id, DraftGenerationJobStatus.PENDING),
        ).fetchall()
    return [job_from_row(row) for row in rows]


def get_job(db: Database, job_id: str) -> dict:
    with db.connect() as connection:
        row = connection.execute(
            "SELECT * FROM draft_generation_jobs WHERE id = ?",
            (job_id,),
        ).fetchone()
    if row is None:
        raise NotFoundError("Draft generation job not found.")
    return job_from_row(row)


def mark_running(db: Database, job_id: str) -> dict:
    now = utc_now()
    with db.connect() as connection:
        connection.execute(
            """
            UPDATE draft_generation_jobs
            SET status = ?, phase = 'generating', cancellable = 1,
                generated_count = 0, last_error = NULL, updated_at = ?
            WHERE id = ? AND status = ?
            """,
            (
                DraftGenerationJobStatus.RUNNING,
                now,
                job_id,
                DraftGenerationJobStatus.PENDING,
            ),
        )
        row = connection.execute(
            "SELECT * FROM draft_generation_jobs WHERE id = ?",
            (job_id,),
        ).fetchone()
    if row is None:
        raise NotFoundError("Draft generation job not found.")
    return job_from_row(row)


def begin_commit(db: Database, job_id: str) -> dict:
    """Win the cancel-vs-commit race and publish the non-cancellable phase."""

    now = utc_now()
    with db.connect() as connection:
        updated = connection.execute(
            """
            UPDATE draft_generation_jobs
            SET phase = 'committing', cancellable = 0, updated_at = ?
            WHERE id = ? AND status = ? AND cancellable = 1
            """,
            (now, job_id, DraftGenerationJobStatus.RUNNING),
        )
        row = connection.execute(
            "SELECT * FROM draft_generation_jobs WHERE id = ?",
            (job_id,),
        ).fetchone()
        if row is None:
            raise NotFoundError("Draft generation job not found.")
        if updated.rowcount != 1:
            current = DraftGenerationJobStatus(row["status"])
            if current in {
                DraftGenerationJobStatus.CANCEL_REQUESTED,
                DraftGenerationJobStatus.CANCELED,
            }:
                if current == DraftGenerationJobStatus.CANCEL_REQUESTED:
                    connection.execute(
                        """
                        UPDATE draft_generation_jobs
                        SET status = ?, phase = 'canceled', cancellable = 0,
                            last_error = NULL, updated_at = ?
                        WHERE id = ? AND status = ?
                        """,
                        (
                            DraftGenerationJobStatus.CANCELED,
                            now,
                            job_id,
                            DraftGenerationJobStatus.CANCEL_REQUESTED,
                        ),
                    )
                raise DraftJobCanceledError("Draft generation was canceled.")
            if current in TERMINAL_STATUSES:
                return job_from_row(row)
            raise DraftJobNotCancellableError(
                "Draft generation is not in a cancellable running phase."
            )
    return job_from_row(row)


def request_cancel(
    db: Database,
    *,
    project_id: str,
    document_id: str,
    job_id: str,
) -> dict:
    """Cancel pending work or request cooperative cancellation for running work."""

    documents_repository.ensure_document_exists(db, project_id, document_id)
    now = utc_now()
    with db.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute(
            """
            SELECT * FROM draft_generation_jobs
            WHERE id = ? AND project_id = ? AND document_id = ?
            """,
            (job_id, project_id, document_id),
        ).fetchone()
        if row is None:
            raise NotFoundError("Draft generation job not found.")
        current = DraftGenerationJobStatus(row["status"])
        if current in TERMINAL_STATUSES:
            return job_from_row(row)
        if current == DraftGenerationJobStatus.CANCEL_REQUESTED:
            return job_from_row(row)
        if not bool(row["cancellable"]):
            raise DraftJobNotCancellableError(
                "Draft generation is committing and can no longer be canceled."
            )
        next_status = (
            DraftGenerationJobStatus.CANCELED
            if current == DraftGenerationJobStatus.PENDING
            else DraftGenerationJobStatus.CANCEL_REQUESTED
        )
        next_phase = "canceled" if next_status == DraftGenerationJobStatus.CANCELED else "canceling"
        connection.execute(
            """
            UPDATE draft_generation_jobs
            SET status = ?, phase = ?, cancellable = ?, last_error = NULL, updated_at = ?
            WHERE id = ? AND status = ? AND cancellable = 1
            """,
            (
                next_status,
                next_phase,
                0,
                now,
                job_id,
                current,
            ),
        )
        row = connection.execute(
            "SELECT * FROM draft_generation_jobs WHERE id = ?",
            (job_id,),
        ).fetchone()
    if row is None:
        raise NotFoundError("Draft generation job not found.")
    return job_from_row(row)


def mark_canceled(db: Database, job_id: str) -> dict:
    return _update_job(
        db,
        job_id,
        status=DraftGenerationJobStatus.CANCELED,
        generated_count=0,
        last_error=None,
    )


def mark_skipped_missing_model(db: Database, job_id: str, *, detail: str) -> dict:
    return _update_job(
        db,
        job_id,
        status=DraftGenerationJobStatus.SKIPPED_MISSING_MODEL,
        generated_count=0,
        last_error=detail,
    )


def mark_skipped_provider_unavailable(db: Database, job_id: str, *, detail: str) -> dict:
    return _update_job(
        db,
        job_id,
        status=DraftGenerationJobStatus.SKIPPED_PROVIDER_UNAVAILABLE,
        generated_count=0,
        last_error=detail,
    )


def mark_failed(db: Database, job_id: str, *, detail: str) -> dict:
    return _update_job(
        db,
        job_id,
        status=DraftGenerationJobStatus.FAILED,
        generated_count=0,
        last_error=detail,
    )


def should_run(job: dict) -> bool:
    status = DraftGenerationJobStatus(job["status"])
    return status == DraftGenerationJobStatus.PENDING


def job_from_row(row: Row) -> dict:
    return {
        "id": row["id"],
        "project_id": row["project_id"],
        "document_id": row["document_id"],
        "chunk_id": row["chunk_id"] or row["source_chunk_id"],
        "page_number": row["page_number"],
        "strategy": row["strategy"],
        "status": row["status"],
        "provider": row["provider"],
        "model": row["model"],
        "effective_provider": _optional_row_value(row, "effective_provider"),
        "effective_model": _optional_row_value(row, "effective_model"),
        "fallback_reason": _optional_row_value(row, "fallback_reason"),
        "phase": _optional_row_value(row, "phase") or "queued",
        "cancellable": bool(_optional_row_value(row, "cancellable")),
        "generated_count": row["generated_count"],
        "retry_count": row["retry_count"],
        "last_error": row["last_error"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _update_job(
    db: Database,
    job_id: str,
    *,
    status: DraftGenerationJobStatus,
    generated_count: int,
    last_error: str | None,
) -> dict:
    now = utc_now()
    with db.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute(
            "SELECT * FROM draft_generation_jobs WHERE id = ?",
            (job_id,),
        ).fetchone()
        if row is None:
            raise NotFoundError("Draft generation job not found.")
        current = DraftGenerationJobStatus(row["status"])
        if current in TERMINAL_STATUSES:
            return job_from_row(row)
        if current == DraftGenerationJobStatus.CANCEL_REQUESTED:
            status = DraftGenerationJobStatus.CANCELED
            generated_count = 0
            last_error = None
        phase = _terminal_phase(status)
        updated = connection.execute(
            """
            UPDATE draft_generation_jobs
            SET status = ?,
                phase = ?,
                cancellable = 0,
                generated_count = ?,
                last_error = ?,
                retry_count = CASE
                    WHEN ? = 'failed' THEN retry_count + 1 ELSE retry_count END,
                updated_at = ?
            WHERE id = ? AND status = ?
            """,
            (status, phase, generated_count, last_error, status, now, job_id, current),
        )
        if updated.rowcount != 1:
            row = connection.execute(
                "SELECT * FROM draft_generation_jobs WHERE id = ?",
                (job_id,),
            ).fetchone()
            if row is None:
                raise NotFoundError("Draft generation job not found.")
            return job_from_row(row)
        row = connection.execute(
            "SELECT * FROM draft_generation_jobs WHERE id = ?",
            (job_id,),
        ).fetchone()
    if row is None:
        raise NotFoundError("Draft generation job not found.")
    return job_from_row(row)


def _optional_row_value(row: Row, column: str):
    return row[column] if column in row.keys() else None


def _terminal_phase(status: DraftGenerationJobStatus) -> str:
    if status == DraftGenerationJobStatus.SUCCEEDED:
        return "completed"
    if status == DraftGenerationJobStatus.CANCELED:
        return "canceled"
    return "failed"
