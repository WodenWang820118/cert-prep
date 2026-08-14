"""Durable identity and lifecycle state for user-confirmed captures."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from sqlite3 import Connection, Row
from uuid import uuid4

from cert_prep_backend.api.errors import NotFoundError
from cert_prep_backend.persistence.database import Database, utc_now


PENDING = "pending"
CONFIRMING = "confirming"
COMPLETED = "completed"
CANCELED = "canceled"
FAILED = "failed"
ACTIVE = (PENDING, CONFIRMING)


def create(
    db: Database,
    *,
    project_id: str,
    document_id: str,
    operation_id: str,
    expires_in_seconds: int = 1800,
) -> dict:
    now = utc_now()
    expires = (datetime.now(UTC) + timedelta(seconds=expires_in_seconds)).isoformat()
    session_id = str(uuid4())
    with db.connect() as connection:
        connection.execute(
            """
            INSERT INTO capture_review_sessions(
                id, project_id, document_id, operation_id, runtime_capture_id,
                status, review_revision, expires_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, NULL, ?, 0, ?, ?, ?)
            """,
            (session_id, project_id, document_id, operation_id, PENDING, expires, now, now),
        )
        return _row(
            connection.execute(
                "SELECT * FROM capture_review_sessions WHERE id = ?", (session_id,)
            ).fetchone()
        )


def get(db: Database, *, project_id: str, session_id: str) -> dict:
    with db.connect() as connection:
        row = connection.execute(
            "SELECT * FROM capture_review_sessions WHERE project_id = ? AND id = ?",
            (project_id, session_id),
        ).fetchone()
    if row is None:
        raise NotFoundError("Capture review session not found.")
    return _row(row)


def set_runtime_capture_id(
    db: Database,
    *,
    project_id: str,
    session_id: str,
    runtime_capture_id: str,
) -> dict:
    now = utc_now()
    with db.connect() as connection:
        updated = connection.execute(
            """
            UPDATE capture_review_sessions
            SET runtime_capture_id = ?, updated_at = ?
            WHERE project_id = ? AND id = ? AND status = ?
            """,
            (runtime_capture_id, now, project_id, session_id, PENDING),
        )
        if updated.rowcount != 1:
            raise RuntimeError("Capture review session is no longer pending.")
        return _row(
            connection.execute(
                "SELECT * FROM capture_review_sessions WHERE id = ?", (session_id,)
            ).fetchone()
        )


def observe_event_sequence(
    db: Database,
    *,
    project_id: str,
    session_id: str,
    sequence: int,
) -> dict:
    if not isinstance(sequence, int) or isinstance(sequence, bool) or sequence < 0:
        raise ValueError("Capture event sequence must be a non-negative integer.")
    with db.connect() as connection:
        updated = connection.execute(
            """
            UPDATE capture_review_sessions
            SET last_event_sequence = MAX(last_event_sequence, ?)
            WHERE project_id = ? AND id = ?
            """,
            (sequence, project_id, session_id),
        )
        if updated.rowcount != 1:
            raise NotFoundError("Capture review session not found.")
        return _row(
            connection.execute(
                "SELECT * FROM capture_review_sessions WHERE id = ?", (session_id,)
            ).fetchone()
        )


def begin_confirm(
    db: Database,
    *,
    project_id: str,
    session_id: str,
    review_revision: int,
    client_request_id: str | None = None,
    review_digest: str | None = None,
) -> dict:
    with db.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        session, _acquired = begin_confirm_in_connection(
            connection,
            project_id=project_id,
            session_id=session_id,
            review_revision=review_revision,
            client_request_id=client_request_id,
            review_digest=review_digest,
        )
        return session


def begin_confirm_in_connection(
    connection: Connection,
    *,
    project_id: str,
    session_id: str,
    review_revision: int,
    client_request_id: str | None,
    review_digest: str | None,
) -> tuple[dict, bool]:
    """Claim confirmation and report whether this request won the claim."""

    row = connection.execute(
        "SELECT * FROM capture_review_sessions WHERE project_id = ? AND id = ?",
        (project_id, session_id),
    ).fetchone()
    if row is None:
        raise NotFoundError("Capture review session not found.")
    if row["status"] == CONFIRMING:
        if client_request_id is None and row["review_revision"] == review_revision:
            return _row(row), False
        if (
            row["confirm_request_id"] == client_request_id
            and row["confirm_review_digest"] == review_digest
        ):
            return _row(row), False
        if row["confirm_request_id"] == client_request_id:
            raise RuntimeError("The same client request id was reused with different review data.")
        raise RuntimeError("Capture review session is not pending confirmation.")
    if row["status"] != PENDING:
        raise RuntimeError("Capture review session is not pending confirmation.")
    updated = connection.execute(
        """
        UPDATE capture_review_sessions
        SET status = ?, review_revision = ?, confirm_request_id = ?,
            confirm_review_digest = ?, updated_at = ?
        WHERE project_id = ? AND id = ? AND status = ?
        """,
        (
            CONFIRMING,
            review_revision,
            client_request_id,
            review_digest,
            utc_now(),
            project_id,
            session_id,
            PENDING,
        ),
    )
    if updated.rowcount != 1:
        raise RuntimeError("Capture review session changed while confirming.")
    return _row(
        connection.execute(
            "SELECT * FROM capture_review_sessions WHERE id = ?", (session_id,)
        ).fetchone()
    ), True


def finish(
    db: Database,
    *,
    project_id: str,
    session_id: str,
    status: str,
    terminal_sequence: int | None = None,
) -> dict:
    if status not in {COMPLETED, CANCELED, FAILED}:
        raise ValueError(f"Unsupported capture review terminal status: {status}")
    if terminal_sequence is not None and (
        not isinstance(terminal_sequence, int)
        or isinstance(terminal_sequence, bool)
        or terminal_sequence < 1
    ):
        raise ValueError("Terminal capture event sequence must be a positive integer.")
    with db.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        current = connection.execute(
            "SELECT * FROM capture_review_sessions WHERE project_id = ? AND id = ?",
            (project_id, session_id),
        ).fetchone()
        if current is None:
            raise NotFoundError("Capture review session not found.")
        if current["status"] in {COMPLETED, CANCELED, FAILED}:
            if (
                terminal_sequence is not None
                and terminal_sequence > int(current["last_event_sequence"])
            ):
                connection.execute(
                    """
                    UPDATE capture_review_sessions
                    SET last_event_sequence = ?
                    WHERE project_id = ? AND id = ?
                    """,
                    (terminal_sequence, project_id, session_id),
                )
                current = connection.execute(
                    """
                    SELECT * FROM capture_review_sessions
                    WHERE project_id = ? AND id = ?
                    """,
                    (project_id, session_id),
                ).fetchone()
            return _row(current)
        if current["status"] not in ACTIVE:
            raise RuntimeError("Capture review session could not reach its terminal state.")
        current_sequence = int(current["last_event_sequence"])
        final_sequence = (
            current_sequence + 1
            if terminal_sequence is None
            else max(current_sequence, terminal_sequence)
        )
        updated = connection.execute(
            """
            UPDATE capture_review_sessions
            SET status = ?, last_event_sequence = ?, updated_at = ?
            WHERE project_id = ? AND id = ? AND status IN (?, ?)
            """,
            (
                status,
                final_sequence,
                utc_now(),
                project_id,
                session_id,
                PENDING,
                CONFIRMING,
            ),
        )
        row = connection.execute(
            "SELECT * FROM capture_review_sessions WHERE project_id = ? AND id = ?",
            (project_id, session_id),
        ).fetchone()
        if row is None:
            raise NotFoundError("Capture review session not found.")
        if updated.rowcount != 1 and row["status"] not in {COMPLETED, CANCELED, FAILED}:
            raise RuntimeError("Capture review session could not reach its terminal state.")
        return _row(row)


def expired(db: Database) -> list[dict]:
    with db.connect() as connection:
        rows = connection.execute(
            """
            SELECT * FROM capture_review_sessions
            WHERE status IN (?, ?) AND expires_at <= ?
            """,
            (*ACTIVE, utc_now()),
        ).fetchall()
    return [_row(row) for row in rows]


def active(db: Database) -> list[dict]:
    with db.connect() as connection:
        rows = connection.execute(
            "SELECT * FROM capture_review_sessions WHERE status IN (?, ?)",
            ACTIVE,
        ).fetchall()
    return [_row(row) for row in rows]


def _row(row: Row | None) -> dict:
    if row is None:
        raise NotFoundError("Capture review session not found.")
    return dict(row)


__all__ = [
    "ACTIVE",
    "CANCELED",
    "COMPLETED",
    "CONFIRMING",
    "FAILED",
    "PENDING",
    "begin_confirm",
    "begin_confirm_in_connection",
    "active",
    "create",
    "expired",
    "finish",
    "get",
    "observe_event_sequence",
    "set_runtime_capture_id",
]
