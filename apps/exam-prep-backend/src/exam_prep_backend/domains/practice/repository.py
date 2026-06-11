from __future__ import annotations

import json
from sqlite3 import Row
from uuid import uuid4

from exam_prep_backend.database import Database, utc_now
from exam_prep_backend.domains.practice.models import PracticeQuestion, PracticeSession
from exam_prep_backend.domains.practice.policies import (
    PracticeRuleViolation,
    build_practice_attempt,
    current_wrong_answers,
    select_session_question_ids,
)
from exam_prep_backend.domains.projects.repository import ensure_project_exists
from exam_prep_backend.errors import NotFoundError, ValidationError


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
        try:
            question_ids = select_session_question_ids(
                [row["id"] for row in question_rows],
                question_count,
            )
        except PracticeRuleViolation as exc:
            raise ValidationError(str(exc)) from exc
        connection.execute(
            """
            INSERT INTO practice_sessions(
                id, project_id, question_ids_json, status, created_at, completed_at
            )
            VALUES (?, ?, ?, 'active', ?, NULL)
            """,
            (session_id, project_id, json.dumps(list(question_ids)), now),
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
    session_record = get_session(db, project_id, session_id)
    session = PracticeSession(
        id=session_record["id"],
        project_id=session_record["project_id"],
        question_ids=tuple(session_record["question_ids"]),
        status=session_record["status"],
        created_at=session_record["created_at"],
        completed_at=session_record["completed_at"],
    )

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

        practice_question = _practice_question_from_row(question)
        try:
            attempt = build_practice_attempt(
                attempt_id=attempt_id,
                session=session,
                question=practice_question,
                selected_answer=selected_answer,
                created_at=now,
            )
        except PracticeRuleViolation as exc:
            raise ValidationError(str(exc)) from exc

        connection.execute(
            """
            INSERT INTO practice_attempts(
                id, session_id, project_id, question_id, selected_answer,
                is_correct, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                attempt.id,
                attempt.session_id,
                attempt.project_id,
                attempt.question_id,
                attempt.selected_answer,
                int(attempt.is_correct),
                attempt.created_at,
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
                practice_attempts.is_correct,
                practice_attempts.created_at,
                question_drafts.question,
                question_drafts.choices_json,
                question_drafts.answer AS correct_answer,
                question_drafts.rationale,
                question_drafts.citation_page,
                question_drafts.source_excerpt
            FROM practice_attempts
            JOIN question_drafts ON question_drafts.id = practice_attempts.question_id
            WHERE practice_attempts.project_id = ?
            ORDER BY practice_attempts.created_at DESC
            """,
            (project_id,),
        ).fetchall()

    attempts = [_practice_attempt_from_wrong_answer_row(project_id, row) for row in rows]
    questions = {
        row["question_id"]: _practice_question_from_wrong_answer_row(row)
        for row in rows
    }
    return [wrong_answer.to_record() for wrong_answer in current_wrong_answers(attempts, questions)]


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


def _practice_question_from_row(row: Row) -> PracticeQuestion:
    return PracticeQuestion(
        id=row["id"],
        choices=tuple(json.loads(row["choices_json"])),
        correct_answer=row["answer"],
        question=row["question"],
        status=row["status"],
        rationale=row["rationale"],
        citation_page=row["citation_page"],
        source_excerpt=row["source_excerpt"],
    )


def _practice_attempt_from_wrong_answer_row(project_id: str, row: Row):
    from exam_prep_backend.domains.practice.models import PracticeAttempt

    return PracticeAttempt(
        id=row["attempt_id"],
        session_id=row["session_id"],
        project_id=project_id,
        question_id=row["question_id"],
        selected_answer=row["selected_answer"],
        is_correct=bool(row["is_correct"]),
        created_at=row["created_at"],
    )


def _practice_question_from_wrong_answer_row(row: Row) -> PracticeQuestion:
    return PracticeQuestion(
        id=row["question_id"],
        choices=tuple(json.loads(row["choices_json"])),
        correct_answer=row["correct_answer"],
        question=row["question"],
        rationale=row["rationale"],
        citation_page=row["citation_page"],
        source_excerpt=row["source_excerpt"],
    )
