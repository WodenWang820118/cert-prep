from __future__ import annotations

from sqlite3 import Row

from cert_prep_backend.api.errors import NotFoundError
from cert_prep_backend.domains.practice.models import PracticeQuestion, WrongAnswer
from cert_prep_backend.domains.practice.policies import current_wrong_answers
from cert_prep_backend.domains.practice.query_helpers import ensure_project_row_exists
from cert_prep_backend.domains.practice.row_mappers import (
    practice_attempt_from_wrong_answer_row,
    practice_question_from_wrong_answer_row,
)
from cert_prep_backend.persistence.database import Database


def list_wrong_answers(db: Database, project_id: str) -> list[dict]:
    with db.connect() as connection:
        ensure_project_row_exists(connection, project_id)
        rows = _wrong_answer_rows(connection, project_id)

    return [wrong_answer.to_record() for wrong_answer in _current_wrong_answers(project_id, rows)]


def get_current_wrong_answer(db: Database, project_id: str, attempt_id: str) -> WrongAnswer:
    with db.connect() as connection:
        ensure_project_row_exists(connection, project_id)
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
    attempts = [practice_attempt_from_wrong_answer_row(project_id, row) for row in rows]
    questions: dict[str, PracticeQuestion] = {}
    for row in rows:
        questions.setdefault(row["question_id"], practice_question_from_wrong_answer_row(row))
    return current_wrong_answers(attempts, questions)
