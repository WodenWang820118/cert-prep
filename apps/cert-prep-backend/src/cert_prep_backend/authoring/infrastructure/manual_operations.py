from __future__ import annotations

from collections.abc import Callable
import json
import sqlite3
from sqlite3 import Connection, Row
from typing import Any
from uuid import uuid4

from cert_prep_backend.authoring.domain.generation import (
    ManualDraftOperation,
    ManualDraftOperationStatus,
)
from cert_prep_backend.platform.errors import NotFoundError
from cert_prep_backend.projects.infrastructure.repository import ensure_project_exists
from cert_prep_backend.source_library.infrastructure import repository as documents_repository
from cert_prep_backend.platform.database import Database, utc_now


def create_operation(
    db: Database,
    *,
    project_id: str,
    document_id: str,
    limit: int,
    strategy: str,
    provider: str,
    model: str,
) -> ManualDraftOperation:
    ensure_project_exists(db, project_id)
    documents_repository.ensure_document_exists(db, project_id, document_id)
    queued = ManualDraftOperation.queue(
        operation_id=str(uuid4()),
        project_id=project_id,
        document_id=document_id,
        limit=limit,
        strategy=strategy,
        provider=provider,
        model=model,
        now=utc_now(),
    )
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
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    queued.id,
                    queued.project_id,
                    queued.document_id,
                    queued.limit,
                    queued.strategy,
                    queued.status.value,
                    queued.phase,
                    int(queued.cancellable),
                    queued.provider,
                    queued.model,
                    queued.generated_count,
                    queued.created_at,
                    queued.updated_at,
                ),
            )
            row = connection.execute(
                "SELECT * FROM manual_draft_generation_operations WHERE id = ?",
                (queued.id,),
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
) -> ManualDraftOperation:
    with db.connect() as connection:
        row = _operation_row(connection, operation_id, (project_id, document_id))
    if row is None:
        raise NotFoundError("Manual draft generation operation not found.")
    return operation_from_row(row)


def recover_operations(db: Database) -> list[ManualDraftOperation]:
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


def mark_running(db: Database, operation_id: str) -> ManualDraftOperation:
    return _transition(db, operation_id, lambda operation, now: operation.start(now))


def begin_commit(db: Database, operation_id: str) -> ManualDraftOperation:
    return _transition(db, operation_id, lambda operation, now: operation.begin_commit(now))


def request_cancel(
    db: Database,
    *,
    project_id: str,
    document_id: str,
    operation_id: str,
) -> ManualDraftOperation:
    documents_repository.ensure_document_exists(db, project_id, document_id)
    return _transition(
        db,
        operation_id,
        lambda operation, now: operation.cancel(now),
        owner=(project_id, document_id),
    )


def mark_canceled(db: Database, operation_id: str) -> ManualDraftOperation:
    return _transition(
        db, operation_id, lambda operation, now: operation.acknowledge_cancellation(now)
    )


def mark_failed(db: Database, operation_id: str, detail: str) -> ManualDraftOperation:
    return _transition(db, operation_id, lambda operation, now: operation.fail(detail, now))


def operation_from_row(row: Row) -> ManualDraftOperation:
    return ManualDraftOperation(
        id=row["id"],
        project_id=row["project_id"],
        document_id=row["document_id"],
        limit=row["limit_count"],
        strategy=row["strategy"],
        status=ManualDraftOperationStatus(row["status"]),
        phase=row["phase"],
        cancellable=bool(row["cancellable"]),
        provider=row["provider"],
        model=row["model"],
        effective_provider=row["effective_provider"],
        effective_model=row["effective_model"],
        fallback_reason=row["fallback_reason"],
        generated_count=row["generated_count"],
        unavailable_blocks=tuple(_unavailable_blocks_from_row(row)),
        error=row["error"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        commit_started_at=row["commit_started_at"],
    )


def _unavailable_blocks_from_row(row: Row) -> list[dict[str, Any]]:
    if "unavailable_blocks_json" not in row.keys():
        return []
    try:
        value = json.loads(row["unavailable_blocks_json"] or "[]")
    except (TypeError, ValueError):
        return []
    return value if isinstance(value, list) else []


def _transition(
    db: Database,
    operation_id: str,
    decide: Callable[[ManualDraftOperation, str], ManualDraftOperation],
    *,
    owner: tuple[str, str] | None = None,
) -> ManualDraftOperation:
    """Lock the operation, let the aggregate decide its next state, and store that state."""

    now = utc_now()
    with db.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = _operation_row(connection, operation_id, owner)
        if row is None:
            raise NotFoundError("Manual draft generation operation not found.")
        operation = operation_from_row(row)
        after = decide(operation, now)
        if after is operation:
            return operation
        _apply(connection, operation, after)
        row = _operation_row(connection, operation_id, None)
    if row is None:
        raise NotFoundError("Manual draft generation operation not found.")
    return operation_from_row(row)


def _operation_row(
    connection: Connection, operation_id: str, owner: tuple[str, str] | None
) -> Row | None:
    if owner is None:
        return connection.execute(
            "SELECT * FROM manual_draft_generation_operations WHERE id = ?",
            (operation_id,),
        ).fetchone()
    project_id, document_id = owner
    return connection.execute(
        """
        SELECT * FROM manual_draft_generation_operations
        WHERE id = ? AND project_id = ? AND document_id = ?
        """,
        (operation_id, project_id, document_id),
    ).fetchone()


def _apply(
    connection: Connection, before: ManualDraftOperation, after: ManualDraftOperation
) -> None:
    """Store a transition only if the operation is still in the state it was decided from."""

    updated = connection.execute(
        """
        UPDATE manual_draft_generation_operations
        SET status = ?, phase = ?, cancellable = ?, error = ?, commit_started_at = ?,
            updated_at = ?
        WHERE id = ? AND status = ?
        """,
        (
            after.status.value,
            after.phase,
            int(after.cancellable),
            after.error,
            after.commit_started_at,
            after.updated_at,
            before.id,
            before.status.value,
        ),
    )
    if updated.rowcount != 1:
        raise RuntimeError("Manual draft generation operation changed while it was locked.")


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
    "begin_commit",
    "create_operation",
    "get_operation",
    "mark_canceled",
    "mark_failed",
    "operation_from_row",
    "recover_operations",
    "request_cancel",
]
