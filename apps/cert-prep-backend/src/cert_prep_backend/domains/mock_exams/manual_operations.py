from __future__ import annotations

from enum import StrEnum
import sqlite3
from sqlite3 import Row
from uuid import uuid4

from cert_prep_backend.api.errors import NotFoundError
from cert_prep_backend.domains.mock_exams.draft_jobs import (
    DraftJobCanceledError,
    DraftJobNotCancellableError,
)
from cert_prep_backend.domains.projects.repository import ensure_project_exists
from cert_prep_backend.domains.source_documents import repository as documents_repository
from cert_prep_backend.persistence.database import Database, utc_now


class ManualDraftOperationStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    CANCEL_REQUESTED = "cancel_requested"
    CANCELED = "canceled"
    SUCCEEDED = "succeeded"
    FAILED = "failed"


TERMINAL_STATUSES = {
    ManualDraftOperationStatus.CANCELED,
    ManualDraftOperationStatus.SUCCEEDED,
    ManualDraftOperationStatus.FAILED,
}


def create_operation(
    db: Database,
    *,
    project_id: str,
    document_id: str,
    limit: int,
    strategy: str,
    provider: str,
    model: str,
) -> dict:
    ensure_project_exists(db, project_id)
    documents_repository.ensure_document_exists(db, project_id, document_id)
    now = utc_now()
    operation_id = str(uuid4())
    try:
        with db.connect() as connection:
            existing = _active_operation(connection, project_id, document_id)
            if existing is not None:
                return operation_from_row(existing)
            connection.execute(
                """
                INSERT INTO manual_draft_generation_operations(
                    id, project_id, document_id, limit_count, strategy,
                    status, phase, cancellable, provider, model,
                    generated_count, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, 'queued', 'queued', 1, ?, ?, 0, ?, ?)
                """,
                (
                    operation_id,
                    project_id,
                    document_id,
                    limit,
                    strategy,
                    provider,
                    model,
                    now,
                    now,
                ),
            )
            row = connection.execute(
                "SELECT * FROM manual_draft_generation_operations WHERE id = ?",
                (operation_id,),
            ).fetchone()
    except sqlite3.IntegrityError:
        with db.connect() as connection:
            row = _active_operation(connection, project_id, document_id)
    if row is None:
        raise NotFoundError("Manual draft generation operation was not created.")
    return operation_from_row(row)


def get_operation(
    db: Database,
    *,
    project_id: str,
    document_id: str,
    operation_id: str,
) -> dict:
    with db.connect() as connection:
        row = connection.execute(
            """
            SELECT * FROM manual_draft_generation_operations
            WHERE id = ? AND project_id = ? AND document_id = ?
            """,
            (operation_id, project_id, document_id),
        ).fetchone()
    if row is None:
        raise NotFoundError("Manual draft generation operation not found.")
    return operation_from_row(row)


def recover_operations(db: Database) -> list[dict]:
    now = utc_now()
    with db.connect() as connection:
        connection.execute(
            """
            UPDATE manual_draft_generation_operations
            SET status = 'queued', phase = 'queued', cancellable = 1,
                error = 'Draft generation was interrupted before completion.',
                commit_started_at = NULL, updated_at = ?
            WHERE status = 'running'
            """,
            (now,),
        )
        connection.execute(
            """
            UPDATE manual_draft_generation_operations
            SET status = 'canceled', phase = 'canceled', cancellable = 0,
                error = NULL, updated_at = ?
            WHERE status = 'cancel_requested'
            """,
            (now,),
        )
        rows = connection.execute(
            """
            SELECT * FROM manual_draft_generation_operations
            WHERE status = 'queued'
            ORDER BY updated_at, created_at, id
            """
        ).fetchall()
    return [operation_from_row(row) for row in rows]


def mark_running(db: Database, operation_id: str) -> dict:
    return _transition(
        db,
        operation_id,
        expected=ManualDraftOperationStatus.QUEUED,
        status=ManualDraftOperationStatus.RUNNING,
        phase="generating",
        cancellable=True,
        error=None,
    )


def begin_commit(db: Database, operation_id: str) -> dict:
    now = utc_now()
    with db.connect() as connection:
        updated = connection.execute(
            """
            UPDATE manual_draft_generation_operations
            SET phase = 'committing', cancellable = 0,
                commit_started_at = COALESCE(commit_started_at, ?),
                updated_at = ?
            WHERE id = ? AND status = 'running' AND cancellable = 1
            """,
            (now, now, operation_id),
        )
        row = connection.execute(
            "SELECT * FROM manual_draft_generation_operations WHERE id = ?",
            (operation_id,),
        ).fetchone()
        if row is None:
            raise NotFoundError("Manual draft generation operation not found.")
        if updated.rowcount != 1:
            current = ManualDraftOperationStatus(row["status"])
            if current in {
                ManualDraftOperationStatus.CANCEL_REQUESTED,
                ManualDraftOperationStatus.CANCELED,
            }:
                if current == ManualDraftOperationStatus.CANCEL_REQUESTED:
                    connection.execute(
                        """
                        UPDATE manual_draft_generation_operations
                        SET status = 'canceled', phase = 'canceled', cancellable = 0,
                            error = NULL, updated_at = ?
                        WHERE id = ? AND status = 'cancel_requested'
                        """,
                        (now, operation_id),
                    )
                raise DraftJobCanceledError("Manual draft generation was canceled.")
            if current in TERMINAL_STATUSES:
                return operation_from_row(row)
            if (
                current == ManualDraftOperationStatus.RUNNING
                and row["phase"] == "committing"
                and not bool(row["cancellable"])
                and row["commit_started_at"] is not None
            ):
                return operation_from_row(row)
            raise DraftJobNotCancellableError(
                "Manual draft generation is not in a cancellable running phase."
            )
    return operation_from_row(row)


def request_cancel(
    db: Database,
    *,
    project_id: str,
    document_id: str,
    operation_id: str,
) -> dict:
    documents_repository.ensure_document_exists(db, project_id, document_id)
    now = utc_now()
    with db.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute(
            """
            SELECT * FROM manual_draft_generation_operations
            WHERE id = ? AND project_id = ? AND document_id = ?
            """,
            (operation_id, project_id, document_id),
        ).fetchone()
        if row is None:
            raise NotFoundError("Manual draft generation operation not found.")
        current = ManualDraftOperationStatus(row["status"])
        if (
            current == ManualDraftOperationStatus.SUCCEEDED
            and row["commit_started_at"] is not None
        ):
            raise DraftJobNotCancellableError(
                "Manual draft generation committed and can no longer be canceled."
            )
        if current in TERMINAL_STATUSES:
            return operation_from_row(row)
        if current == ManualDraftOperationStatus.CANCEL_REQUESTED:
            return operation_from_row(row)
        if not bool(row["cancellable"]):
            raise DraftJobNotCancellableError(
                "Manual draft generation is committing and can no longer be canceled."
            )
        if current == ManualDraftOperationStatus.QUEUED:
            status = ManualDraftOperationStatus.CANCELED
            phase = "canceled"
            cancellable = 0
        else:
            status = ManualDraftOperationStatus.CANCEL_REQUESTED
            phase = "canceling"
            cancellable = 0
        connection.execute(
            """
            UPDATE manual_draft_generation_operations
            SET status = ?, phase = ?, cancellable = ?, error = NULL, updated_at = ?
            WHERE id = ? AND status = ? AND cancellable = 1
            """,
            (status, phase, cancellable, now, operation_id, current),
        )
        row = connection.execute(
            "SELECT * FROM manual_draft_generation_operations WHERE id = ?",
            (operation_id,),
        ).fetchone()
    if row is None:
        raise NotFoundError("Manual draft generation operation not found.")
    return operation_from_row(row)


def mark_canceled(db: Database, operation_id: str) -> dict:
    return _finish(
        db,
        operation_id,
        status=ManualDraftOperationStatus.CANCELED,
        phase="canceled",
        error=None,
    )


def mark_failed(db: Database, operation_id: str, detail: str) -> dict:
    return _finish(
        db,
        operation_id,
        status=ManualDraftOperationStatus.FAILED,
        phase="failed",
        error=detail,
    )


def operation_from_row(row: Row) -> dict:
    return {
        "id": row["id"],
        "project_id": row["project_id"],
        "document_id": row["document_id"],
        "limit": row["limit_count"],
        "strategy": row["strategy"],
        "status": row["status"],
        "phase": row["phase"],
        "cancellable": bool(row["cancellable"]),
        "provider": row["provider"],
        "model": row["model"],
        "effective_provider": row["effective_provider"],
        "effective_model": row["effective_model"],
        "fallback_reason": row["fallback_reason"],
        "generated_count": row["generated_count"],
        "error": row["error"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "commit_started_at": row["commit_started_at"],
    }


def _transition(
    db: Database,
    operation_id: str,
    *,
    expected: ManualDraftOperationStatus,
    status: ManualDraftOperationStatus,
    phase: str,
    cancellable: bool,
    error: str | None,
) -> dict:
    now = utc_now()
    with db.connect() as connection:
        connection.execute(
            """
            UPDATE manual_draft_generation_operations
            SET status = ?, phase = ?, cancellable = ?, error = ?,
                commit_started_at = NULL, updated_at = ?
            WHERE id = ? AND status = ?
            """,
            (status, phase, int(cancellable), error, now, operation_id, expected),
        )
        row = connection.execute(
            "SELECT * FROM manual_draft_generation_operations WHERE id = ?",
            (operation_id,),
        ).fetchone()
    if row is None:
        raise NotFoundError("Manual draft generation operation not found.")
    return operation_from_row(row)


def _finish(
    db: Database,
    operation_id: str,
    *,
    status: ManualDraftOperationStatus,
    phase: str,
    error: str | None,
) -> dict:
    now = utc_now()
    with db.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute(
            "SELECT * FROM manual_draft_generation_operations WHERE id = ?",
            (operation_id,),
        ).fetchone()
        if row is None:
            raise NotFoundError("Manual draft generation operation not found.")
        current = ManualDraftOperationStatus(row["status"])
        if current in TERMINAL_STATUSES:
            return operation_from_row(row)
        if current == ManualDraftOperationStatus.CANCEL_REQUESTED:
            status = ManualDraftOperationStatus.CANCELED
            phase = "canceled"
            error = None
        connection.execute(
            """
            UPDATE manual_draft_generation_operations
            SET status = ?, phase = ?, cancellable = 0, error = ?, updated_at = ?
            WHERE id = ? AND status = ?
            """,
            (status, phase, error, now, operation_id, current),
        )
        row = connection.execute(
            "SELECT * FROM manual_draft_generation_operations WHERE id = ?",
            (operation_id,),
        ).fetchone()
    if row is None:
        raise NotFoundError("Manual draft generation operation not found.")
    return operation_from_row(row)


def _active_operation(connection, project_id: str, document_id: str) -> Row | None:
    return connection.execute(
        """
        SELECT * FROM manual_draft_generation_operations
        WHERE project_id = ? AND document_id = ?
          AND status IN ('queued', 'running', 'cancel_requested')
        ORDER BY created_at DESC, id DESC
        LIMIT 1
        """,
        (project_id, document_id),
    ).fetchone()


__all__ = [
    "ManualDraftOperationStatus",
    "begin_commit",
    "create_operation",
    "get_operation",
    "mark_canceled",
    "mark_failed",
    "operation_from_row",
    "recover_operations",
    "request_cancel",
]
