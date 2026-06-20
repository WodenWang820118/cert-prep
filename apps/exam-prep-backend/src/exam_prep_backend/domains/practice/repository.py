from __future__ import annotations

import json
from sqlite3 import Row
import secrets
from uuid import uuid4

from exam_prep_backend.database import Database, utc_now
from exam_prep_backend.domains.practice.models import (
    PracticeQuestion,
    PracticeSession,
    PracticeSessionMode,
)
from exam_prep_backend.domains.practice.policies import (
    DOCUMENT_REQUIRED_FOR_FULL_DOCUMENT_MESSAGE,
    PracticeRuleViolation,
    build_practice_attempt,
    current_wrong_answers,
    select_random_session_question_ids,
    select_session_question_ids,
)
from exam_prep_backend.domains.source_documents import repository as documents_repository
from exam_prep_backend.domains.projects.repository import ensure_project_exists
from exam_prep_backend.errors import NotFoundError, ValidationError


DEFAULT_RANDOM_QUESTION_COUNT = 10


def create_session(
    db: Database,
    project_id: str,
    *,
    mode: PracticeSessionMode | str = PracticeSessionMode.RANDOM_DRAW,
    document_id: str | None = None,
    question_count: int | None = None,
    random_seed: int | None = None,
) -> dict:
    ensure_project_exists(db, project_id)
    session_mode = PracticeSessionMode(mode)
    if session_mode is PracticeSessionMode.FULL_DOCUMENT and document_id is None:
        raise ValidationError(DOCUMENT_REQUIRED_FOR_FULL_DOCUMENT_MESSAGE)
    if session_mode is PracticeSessionMode.FULL_DOCUMENT and document_id is not None:
        documents_repository.ensure_document_exists(db, project_id, document_id)

    now = utc_now()
    session_id = str(uuid4())
    with db.connect() as connection:
        question_rows = _playable_question_rows(
            connection,
            project_id=project_id,
            mode=session_mode,
            document_id=document_id,
        )
        effective_count = _effective_question_count(
            mode=session_mode,
            requested_question_count=question_count,
            available_question_count=len(question_rows),
        )
        try:
            if session_mode is PracticeSessionMode.RANDOM_DRAW:
                stored_seed = random_seed if random_seed is not None else secrets.randbits(63)
                question_ids = select_random_session_question_ids(
                    [row["id"] for row in question_rows],
                    effective_count,
                    stored_seed,
                )
                stored_document_id = None
            else:
                stored_seed = None
                stored_document_id = document_id
                question_ids = select_session_question_ids(
                    [row["id"] for row in question_rows],
                    effective_count,
                )
        except PracticeRuleViolation as exc:
            raise ValidationError(str(exc)) from exc
        connection.execute(
            """
            INSERT INTO practice_sessions(
                id, project_id, question_ids_json, mode, source_document_id,
                requested_question_count, random_seed, status, created_at, completed_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL)
            """,
            (
                session_id,
                project_id,
                json.dumps(list(question_ids)),
                session_mode.value,
                stored_document_id,
                effective_count,
                stored_seed,
                now,
            ),
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
        mode=session_record["mode"],
        source_document_id=session_record["document_id"],
        requested_question_count=session_record["question_count"],
        random_seed=session_record["random_seed"],
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
            raise NotFoundError("Playable question not found.")

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


def _playable_question_rows(
    connection,
    *,
    project_id: str,
    mode: PracticeSessionMode,
    document_id: str | None,
) -> list[Row]:
    if mode is PracticeSessionMode.FULL_DOCUMENT:
        return connection.execute(
            """
            SELECT id
            FROM question_drafts
            WHERE project_id = ? AND document_id = ? AND status = 'approved'
            ORDER BY
                CASE WHEN source_order IS NULL THEN 1 ELSE 0 END,
                source_order,
                citation_page,
                created_at,
                id
            """,
            (project_id, document_id),
        ).fetchall()

    return connection.execute(
        """
        SELECT id
        FROM question_drafts
        WHERE project_id = ? AND status = 'approved'
        ORDER BY id
        """,
        (project_id,),
    ).fetchall()


def _effective_question_count(
    *,
    mode: PracticeSessionMode,
    requested_question_count: int | None,
    available_question_count: int,
) -> int:
    if requested_question_count is not None:
        return requested_question_count
    if mode is PracticeSessionMode.FULL_DOCUMENT and available_question_count > 0:
        return available_question_count
    return DEFAULT_RANDOM_QUESTION_COUNT


def _session_from_row(row: Row) -> dict:
    return {
        "id": row["id"],
        "project_id": row["project_id"],
        "question_ids": json.loads(row["question_ids_json"]),
        "mode": row["mode"],
        "document_id": row["source_document_id"],
        "question_count": row["requested_question_count"],
        "random_seed": row["random_seed"],
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
