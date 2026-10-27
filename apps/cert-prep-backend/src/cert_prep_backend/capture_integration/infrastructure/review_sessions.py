"""Durable identity and lifecycle state for user-confirmed captures."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from sqlite3 import Connection, Row
from uuid import uuid4

from cert_prep_backend.capture_integration.domain.review_session import (
    ACTIVE_CAPTURE_REVIEW_STATUSES,
    CaptureReviewEnding,
    CaptureReviewSession,
    CaptureReviewStatus,
    CaptureReviewTransitionError,
    event_sequence,
)
from cert_prep_backend.platform.database import Database, utc_now
from cert_prep_backend.platform.errors import NotFoundError


def create(
    db: Database,
    *,
    project_id: str,
    document_id: str,
    operation_id: str,
    expires_in_seconds: int = 1800,
) -> CaptureReviewSession:
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
            (
                session_id,
                project_id,
                document_id,
                operation_id,
                CaptureReviewStatus.PENDING,
                expires,
                now,
                now,
            ),
        )
        return _session(
            connection.execute(
                "SELECT * FROM capture_review_sessions WHERE id = ?", (session_id,)
            ).fetchone()
        )


def get(db: Database, *, project_id: str, session_id: str) -> CaptureReviewSession:
    with db.connect() as connection:
        row = connection.execute(
            "SELECT * FROM capture_review_sessions WHERE project_id = ? AND id = ?",
            (project_id, session_id),
        ).fetchone()
    return _session(row)


def set_runtime_capture_id(
    db: Database,
    *,
    project_id: str,
    session_id: str,
    runtime_capture_id: str,
) -> CaptureReviewSession:
    with db.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute(
            "SELECT * FROM capture_review_sessions WHERE project_id = ? AND id = ?",
            (project_id, session_id),
        ).fetchone()
        if row is None:
            raise CaptureReviewTransitionError("Capture review session is no longer pending.")
        current = _session(row)
        session = current.with_runtime_capture(runtime_capture_id, now=utc_now())
        updated = connection.execute(
            """
            UPDATE capture_review_sessions
            SET runtime_capture_id = ?, updated_at = ?
            WHERE project_id = ? AND id = ? AND status = ?
            """,
            (
                session.runtime_capture_id,
                session.updated_at,
                project_id,
                session_id,
                current.status,
            ),
        )
        if updated.rowcount != 1:
            raise CaptureReviewTransitionError("Capture review session is no longer pending.")
        return _session(
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
) -> CaptureReviewSession:
    observed = event_sequence(sequence)
    with db.connect() as connection:
        updated = connection.execute(
            """
            UPDATE capture_review_sessions
            SET last_event_sequence = MAX(last_event_sequence, ?)
            WHERE project_id = ? AND id = ?
            """,
            (observed, project_id, session_id),
        )
        if updated.rowcount != 1:
            raise NotFoundError("Capture review session not found.")
        return _session(
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
) -> CaptureReviewSession:
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
) -> tuple[CaptureReviewSession, bool]:
    """Claim confirmation and report whether this request won the claim."""

    row = connection.execute(
        "SELECT * FROM capture_review_sessions WHERE project_id = ? AND id = ?",
        (project_id, session_id),
    ).fetchone()
    if row is None:
        raise NotFoundError("Capture review session not found.")
    session = _session(row)
    claimed, acquired = session.claim_confirmation(
        review_revision=review_revision,
        client_request_id=client_request_id,
        review_digest=review_digest,
        now=utc_now(),
    )
    if not acquired:
        return session, False
    updated = connection.execute(
        """
        UPDATE capture_review_sessions
        SET status = ?, review_revision = ?, confirm_request_id = ?,
            confirm_review_digest = ?, updated_at = ?
        WHERE project_id = ? AND id = ? AND status = ?
        """,
        (
            claimed.status,
            claimed.review_revision,
            claimed.confirm_request_id,
            claimed.confirm_review_digest,
            claimed.updated_at,
            project_id,
            session_id,
            session.status,
        ),
    )
    if updated.rowcount != 1:
        raise CaptureReviewTransitionError("Capture review session changed while confirming.")
    return _session(
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
) -> CaptureReviewSession:
    ending = CaptureReviewEnding(status, terminal_sequence)
    with db.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute(
            "SELECT * FROM capture_review_sessions WHERE project_id = ? AND id = ?",
            (project_id, session_id),
        ).fetchone()
        if row is None:
            raise NotFoundError("Capture review session not found.")
        current = _session(row)
        next_session = current.finished(ending, now=utc_now())
        if current.is_terminal:
            if next_session.last_event_sequence != current.last_event_sequence:
                connection.execute(
                    """
                    UPDATE capture_review_sessions
                    SET last_event_sequence = ?
                    WHERE project_id = ? AND id = ?
                    """,
                    (next_session.last_event_sequence, project_id, session_id),
                )
                return _session(
                    connection.execute(
                        """
                        SELECT * FROM capture_review_sessions
                        WHERE project_id = ? AND id = ?
                        """,
                        (project_id, session_id),
                    ).fetchone()
                )
            return next_session
        updated = connection.execute(
            """
            UPDATE capture_review_sessions
            SET status = ?, last_event_sequence = ?, updated_at = ?
            WHERE project_id = ? AND id = ? AND status = ?
            """,
            (
                next_session.status,
                next_session.last_event_sequence,
                next_session.updated_at,
                project_id,
                session_id,
                current.status,
            ),
        )
        row = connection.execute(
            "SELECT * FROM capture_review_sessions WHERE project_id = ? AND id = ?",
            (project_id, session_id),
        ).fetchone()
        if row is None:
            raise NotFoundError("Capture review session not found.")
        stored = _session(row)
        if updated.rowcount != 1 and not stored.is_terminal:
            raise CaptureReviewTransitionError(
                "Capture review session could not reach its terminal state."
            )
        return stored


def expired(db: Database) -> list[CaptureReviewSession]:
    with db.connect() as connection:
        rows = connection.execute(
            """
            SELECT * FROM capture_review_sessions
            WHERE status IN (?, ?) AND expires_at <= ?
            """,
            (*ACTIVE_CAPTURE_REVIEW_STATUSES, utc_now()),
        ).fetchall()
    return [_session(row) for row in rows]


def active(db: Database) -> list[CaptureReviewSession]:
    with db.connect() as connection:
        rows = connection.execute(
            "SELECT * FROM capture_review_sessions WHERE status IN (?, ?)",
            tuple(ACTIVE_CAPTURE_REVIEW_STATUSES),
        ).fetchall()
    return [_session(row) for row in rows]


def _session(row: Row | None) -> CaptureReviewSession:
    if row is None:
        raise NotFoundError("Capture review session not found.")
    return CaptureReviewSession(
        id=row["id"],
        project_id=row["project_id"],
        document_id=row["document_id"],
        operation_id=row["operation_id"],
        runtime_capture_id=row["runtime_capture_id"],
        status=CaptureReviewStatus(row["status"]),
        review_revision=row["review_revision"],
        expires_at=row["expires_at"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        confirm_request_id=row["confirm_request_id"],
        confirm_review_digest=row["confirm_review_digest"],
        last_event_sequence=int(row["last_event_sequence"]),
    )


class CaptureReviewStoreAdapter:
    """Review sessions as the capture review store port."""

    def __init__(self, db: Database) -> None:
        self._db = db

    def get(self, *, project_id: str, session_id: str) -> CaptureReviewSession:
        return get(self._db, project_id=project_id, session_id=session_id)

    def create(
        self, *, project_id: str, document_id: str, operation_id: str
    ) -> CaptureReviewSession:
        return create(
            self._db,
            project_id=project_id,
            document_id=document_id,
            operation_id=operation_id,
        )

    def finish(
        self,
        *,
        project_id: str,
        session_id: str,
        status: CaptureReviewStatus,
        terminal_sequence: int | None = None,
    ) -> CaptureReviewSession:
        return finish(
            self._db,
            project_id=project_id,
            session_id=session_id,
            status=status,
            terminal_sequence=terminal_sequence,
        )


__all__ = [
    "CaptureReviewStoreAdapter",
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
