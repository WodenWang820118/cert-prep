from __future__ import annotations

import json
from sqlite3 import Row
from uuid import uuid4

from exam_prep_backend.database import Database, utc_now
from exam_prep_backend.errors import NotFoundError, ValidationError
from exam_prep_backend.projects_store import ensure_project_exists


def create_session(db: Database, project_id: str, question_count: int) -> dict:
    ensure_project_exists(db, project_id)
    now = utc_now()
    session_id = str(uuid4())
    with db.connect() as connection:
        question_rows = connection.execute(
            """
            SELECT id
            FROM question_drafts
            WHERE project_id = ? AND status = 'approved'
            ORDER BY created_at
            LIMIT ?
            """,
            (project_id, question_count),
        ).fetchall()
        question_ids = [row["id"] for row in question_rows]
        if not question_ids:
            raise ValidationError("No approved questions are available for practice.")
        connection.execute(
            """
            INSERT INTO practice_sessions(
                id, project_id, question_ids_json, status, created_at, completed_at
            )
            VALUES (?, ?, ?, 'active', ?, NULL)
            """,
            (session_id, project_id, json.dumps(question_ids), now),
        )
        row = _session_query(connection, project_id, session_id)
    if row is None:
        raise NotFoundError("Practice session not found.")
    return _session_from_row(row)


def get_session(db: Database, project_id: str, session_id: str) -> dict:
    with db.connect() as connection:
        row = _session_query(connection, project_id, session_id)
    if row is None:
        raise NotFoundError("Practice session not found.")
    return _session_from_row(row)


def record_attempt(
    db: Database,
    *,
    project_id: str,
    session_id: str,
    question_id: str,
    selected_answer: str,
) -> dict:
    session = get_session(db, project_id, session_id)
    if question_id not in session["question_ids"]:
        raise ValidationError("Question is not part of this practice session.")

    now = utc_now()
    attempt_id = str(uuid4())
    with db.connect() as connection:
        question = connection.execute(
            """
            SELECT *
            FROM question_drafts
            WHERE project_id = ? AND id = ? AND status = 'approved'
            """,
            (project_id, question_id),
        ).fetchone()
        if question is None:
            raise NotFoundError("Approved question not found.")
        is_correct = selected_answer == question["answer"]
        connection.execute(
            """
            INSERT INTO practice_attempts(
                id, session_id, project_id, question_id, selected_answer,
                is_correct, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                attempt_id,
                session_id,
                project_id,
                question_id,
                selected_answer,
                int(is_correct),
                now,
            ),
        )
        row = connection.execute(
            "SELECT * FROM practice_attempts WHERE id = ?",
            (attempt_id,),
        ).fetchone()
    return _attempt_from_row(row)


def list_wrong_answers(db: Database, project_id: str) -> list[dict]:
    ensure_project_exists(db, project_id)
    with db.connect() as connection:
        rows = connection.execute(
            """
            SELECT
                practice_attempts.id AS attempt_id,
                practice_attempts.session_id,
                practice_attempts.question_id,
                practice_attempts.selected_answer,
                practice_attempts.created_at,
                question_drafts.question,
                question_drafts.answer AS correct_answer,
                question_drafts.rationale,
                question_drafts.citation_page,
                question_drafts.source_excerpt
            FROM practice_attempts
            JOIN question_drafts ON question_drafts.id = practice_attempts.question_id
            WHERE practice_attempts.project_id = ? AND practice_attempts.is_correct = 0
            ORDER BY practice_attempts.created_at DESC
            """,
            (project_id,),
        ).fetchall()
    return [_wrong_answer_from_row(row) for row in rows]


def _session_query(connection, project_id: str, session_id: str) -> Row | None:
    return connection.execute(
        "SELECT * FROM practice_sessions WHERE project_id = ? AND id = ?",
        (project_id, session_id),
    ).fetchone()


def _session_from_row(row: Row) -> dict:
    return {
        "id": row["id"],
        "project_id": row["project_id"],
        "question_ids": json.loads(row["question_ids_json"]),
        "status": row["status"],
        "created_at": row["created_at"],
        "completed_at": row["completed_at"],
    }


def _attempt_from_row(row: Row) -> dict:
    return {
        "id": row["id"],
        "session_id": row["session_id"],
        "project_id": row["project_id"],
        "question_id": row["question_id"],
        "selected_answer": row["selected_answer"],
        "is_correct": bool(row["is_correct"]),
        "created_at": row["created_at"],
    }


def _wrong_answer_from_row(row: Row) -> dict:
    return {
        "attempt_id": row["attempt_id"],
        "session_id": row["session_id"],
        "question_id": row["question_id"],
        "question": row["question"],
        "selected_answer": row["selected_answer"],
        "correct_answer": row["correct_answer"],
        "rationale": row["rationale"],
        "citation_page": row["citation_page"],
        "source_excerpt": row["source_excerpt"],
        "created_at": row["created_at"],
    }
