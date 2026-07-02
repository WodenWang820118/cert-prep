from __future__ import annotations

import json
from sqlite3 import Row
import secrets
from uuid import uuid4

from cert_prep_backend.persistence.database import Database, utc_now
from cert_prep_backend.domains.practice.models import (
    PracticeQuestion,
    PracticeSession,
    PracticeSessionMode,
    WrongAnswer,
)
from cert_prep_backend.domains.practice.policies import (
    DOCUMENT_REQUIRED_FOR_FULL_DOCUMENT_MESSAGE,
    PracticeRuleViolation,
    build_practice_attempt,
    current_wrong_answers,
    is_playable_practice_question,
    select_random_session_question_ids,
    select_session_question_ids,
)
from cert_prep_backend.domains.source_documents import repository as documents_repository
from cert_prep_backend.domains.projects.repository import ensure_project_exists
from cert_prep_backend.api.errors import NotFoundError, ValidationError


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
        _insert_session_question_snapshots(
            connection,
            session_id=session_id,
            project_id=project_id,
            question_rows=question_rows,
            question_ids=question_ids,
            created_at=now,
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
    now = utc_now()
    attempt_id = str(uuid4())
    with db.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        session_row = _session_query(connection, project_id, session_id)
        if session_row is None:
            raise NotFoundError("Practice session not found.")
        session = _practice_session_from_row(session_row)
        practice_question = _practice_question_for_attempt(
            connection,
            project_id=project_id,
            session_id=session_id,
            question_id=question_id,
        )
        if practice_question is None:
            raise NotFoundError("Playable question not found.")
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
    with db.connect() as connection:
        _ensure_project_exists(connection, project_id)
        rows = _wrong_answer_rows(connection, project_id)

    return [wrong_answer.to_record() for wrong_answer in _current_wrong_answers(project_id, rows)]


def get_current_wrong_answer(db: Database, project_id: str, attempt_id: str) -> WrongAnswer:
    with db.connect() as connection:
        _ensure_project_exists(connection, project_id)
        rows = _wrong_answer_rows_for_attempt(connection, project_id, attempt_id)

    for wrong_answer in _current_wrong_answers(project_id, rows):
        if wrong_answer.attempt_id == attempt_id:
            return wrong_answer
    raise NotFoundError("Wrong answer not found.")


def _wrong_answer_rows(connection, project_id: str) -> list[Row]:
    return connection.execute(
        """
        SELECT
            practice_attempts.id AS attempt_id,
            practice_attempts.session_id,
            practice_attempts.question_id,
            practice_attempts.selected_answer,
            practice_attempts.is_correct,
            practice_attempts.created_at,
            CASE
                WHEN practice_session_questions.question_id IS NOT NULL
                THEN practice_session_questions.question
                ELSE question_drafts.question
            END AS question,
            CASE
                WHEN practice_session_questions.question_id IS NOT NULL
                THEN practice_session_questions.choices_json
                ELSE question_drafts.choices_json
            END AS choices_json,
            CASE
                WHEN practice_session_questions.question_id IS NOT NULL
                THEN practice_session_questions.correct_answer
                ELSE question_drafts.answer
            END AS correct_answer,
            CASE
                WHEN practice_session_questions.question_id IS NOT NULL
                THEN practice_session_questions.rationale
                ELSE question_drafts.rationale
            END AS rationale,
            CASE
                WHEN practice_session_questions.question_id IS NOT NULL
                THEN practice_session_questions.citation_page
                ELSE question_drafts.citation_page
            END AS citation_page,
            CASE
                WHEN practice_session_questions.question_id IS NOT NULL
                THEN practice_session_questions.source_excerpt
                ELSE question_drafts.source_excerpt
            END AS source_excerpt
        FROM practice_attempts
        LEFT JOIN practice_session_questions
            ON practice_session_questions.project_id = practice_attempts.project_id
            AND practice_session_questions.session_id = practice_attempts.session_id
            AND practice_session_questions.question_id = practice_attempts.question_id
        LEFT JOIN question_drafts
            ON question_drafts.project_id = practice_attempts.project_id
            AND question_drafts.id = practice_attempts.question_id
        WHERE practice_attempts.project_id = ?
            AND (
                practice_session_questions.question_id IS NOT NULL
                OR question_drafts.id IS NOT NULL
            )
        ORDER BY practice_attempts.created_at DESC
        """,
        (project_id,),
    ).fetchall()


def _wrong_answer_rows_for_attempt(connection, project_id: str, attempt_id: str) -> list[Row]:
    return connection.execute(
        """
        WITH target_attempt AS (
            SELECT question_id, created_at
            FROM practice_attempts
            WHERE project_id = ? AND id = ?
        )
        SELECT
            practice_attempts.id AS attempt_id,
            practice_attempts.session_id,
            practice_attempts.question_id,
            practice_attempts.selected_answer,
            practice_attempts.is_correct,
            practice_attempts.created_at,
            CASE
                WHEN practice_session_questions.question_id IS NOT NULL
                THEN practice_session_questions.question
                ELSE question_drafts.question
            END AS question,
            CASE
                WHEN practice_session_questions.question_id IS NOT NULL
                THEN practice_session_questions.choices_json
                ELSE question_drafts.choices_json
            END AS choices_json,
            CASE
                WHEN practice_session_questions.question_id IS NOT NULL
                THEN practice_session_questions.correct_answer
                ELSE question_drafts.answer
            END AS correct_answer,
            CASE
                WHEN practice_session_questions.question_id IS NOT NULL
                THEN practice_session_questions.rationale
                ELSE question_drafts.rationale
            END AS rationale,
            CASE
                WHEN practice_session_questions.question_id IS NOT NULL
                THEN practice_session_questions.citation_page
                ELSE question_drafts.citation_page
            END AS citation_page,
            CASE
                WHEN practice_session_questions.question_id IS NOT NULL
                THEN practice_session_questions.source_excerpt
                ELSE question_drafts.source_excerpt
            END AS source_excerpt
        FROM target_attempt
        JOIN practice_attempts
            ON practice_attempts.project_id = ?
            AND practice_attempts.question_id = target_attempt.question_id
            AND practice_attempts.created_at >= target_attempt.created_at
        LEFT JOIN practice_session_questions
            ON practice_session_questions.project_id = practice_attempts.project_id
            AND practice_session_questions.session_id = practice_attempts.session_id
            AND practice_session_questions.question_id = practice_attempts.question_id
        LEFT JOIN question_drafts
            ON question_drafts.project_id = practice_attempts.project_id
            AND question_drafts.id = practice_attempts.question_id
        WHERE practice_session_questions.question_id IS NOT NULL
            OR question_drafts.id IS NOT NULL
        ORDER BY practice_attempts.created_at DESC
        """,
        (project_id, attempt_id, project_id),
    ).fetchall()


def _current_wrong_answers(project_id: str, rows: list[Row]) -> tuple[WrongAnswer, ...]:
    attempts = [_practice_attempt_from_wrong_answer_row(project_id, row) for row in rows]
    questions: dict[str, PracticeQuestion] = {}
    for row in rows:
        questions.setdefault(row["question_id"], _practice_question_from_wrong_answer_row(row))
    return current_wrong_answers(attempts, questions)


def _session_query(connection, project_id: str, session_id: str) -> Row | None:
    return connection.execute(
        "SELECT * FROM practice_sessions WHERE project_id = ? AND id = ?",
        (project_id, session_id),
    ).fetchone()


def _ensure_project_exists(connection, project_id: str) -> None:
    row = connection.execute("SELECT 1 FROM projects WHERE id = ?", (project_id,)).fetchone()
    if row is None:
        raise NotFoundError("Project not found.")


def _playable_question_rows(
    connection,
    *,
    project_id: str,
    mode: PracticeSessionMode,
    document_id: str | None,
) -> list[Row]:
    if mode is PracticeSessionMode.FULL_DOCUMENT:
        rows = connection.execute(
            """
            SELECT *
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
        return _playable_rows(rows)

    rows = connection.execute(
        """
        SELECT *
        FROM question_drafts
        WHERE project_id = ? AND status = 'approved'
        ORDER BY id
        """,
        (project_id,),
    ).fetchall()
    return _playable_rows(rows)


def _playable_rows(rows: list[Row]) -> list[Row]:
    return [
        row
        for row in rows
        if is_playable_practice_question(_practice_question_from_row(row))
    ]


def _insert_session_question_snapshots(
    connection,
    *,
    session_id: str,
    project_id: str,
    question_rows: list[Row],
    question_ids: tuple[str, ...],
    created_at: str,
) -> None:
    rows_by_id = {row["id"]: row for row in question_rows}
    connection.executemany(
        """
        INSERT INTO practice_session_questions(
            session_id, project_id, question_id, question_order, question,
            choices_json, correct_answer, rationale, citation_page, source_excerpt,
            created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        [
            (
                session_id,
                project_id,
                question_id,
                index,
                rows_by_id[question_id]["question"],
                rows_by_id[question_id]["choices_json"],
                rows_by_id[question_id]["answer"],
                rows_by_id[question_id]["rationale"],
                rows_by_id[question_id]["citation_page"],
                rows_by_id[question_id]["source_excerpt"],
                created_at,
            )
            for index, question_id in enumerate(question_ids)
        ],
    )


def _practice_question_for_attempt(
    connection,
    *,
    project_id: str,
    session_id: str,
    question_id: str,
) -> PracticeQuestion | None:
    snapshot_row = connection.execute(
        """
        SELECT
            question_id AS id,
            choices_json,
            correct_answer AS answer,
            question,
            'approved' AS status,
            rationale,
            citation_page,
            source_excerpt
        FROM practice_session_questions
        WHERE project_id = ? AND session_id = ? AND question_id = ?
        """,
        (project_id, session_id, question_id),
    ).fetchone()
    if snapshot_row is not None:
        return _practice_question_from_row(snapshot_row)

    question_row = connection.execute(
        """
        SELECT *
        FROM question_drafts
        WHERE project_id = ? AND id = ? AND status = 'approved'
        """,
        (project_id, question_id),
    ).fetchone()
    if question_row is None:
        return None

    practice_question = _practice_question_from_row(question_row)
    if not is_playable_practice_question(practice_question):
        return None
    return practice_question


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
    return _practice_session_from_row(row).to_record()


def _practice_session_from_row(row: Row) -> PracticeSession:
    return PracticeSession(
        id=row["id"],
        project_id=row["project_id"],
        question_ids=tuple(json.loads(row["question_ids_json"])),
        status=row["status"],
        mode=row["mode"],
        source_document_id=row["source_document_id"],
        requested_question_count=row["requested_question_count"],
        random_seed=row["random_seed"],
        created_at=row["created_at"],
        completed_at=row["completed_at"],
    )


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
    from cert_prep_backend.domains.practice.models import PracticeAttempt

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
