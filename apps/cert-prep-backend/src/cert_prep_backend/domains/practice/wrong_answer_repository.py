from __future__ import annotations

from collections import Counter, defaultdict
from sqlite3 import Connection, Row

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
        wrong_answers = list_current_wrong_answer_models(connection, project_id)

    return [wrong_answer.to_record() for wrong_answer in wrong_answers]


def list_current_wrong_answer_models(
    connection: Connection, project_id: str
) -> list[WrongAnswer]:
    ensure_project_row_exists(connection, project_id)
    rows = _wrong_answer_rows(connection, project_id)
    return list(_current_wrong_answers(project_id, rows))


def get_current_wrong_answer(db: Database, project_id: str, attempt_id: str) -> WrongAnswer:
    with db.connect() as connection:
        ensure_project_row_exists(connection, project_id)
        rows = _wrong_answer_rows_for_attempt(connection, project_id, attempt_id)

    for wrong_answer in _current_wrong_answers(project_id, rows):
        if wrong_answer.attempt_id == attempt_id:
            return wrong_answer
    raise NotFoundError("Wrong answer not found.")


def summarize_wrong_answers(db: Database, project_id: str) -> dict:
    with db.connect() as connection:
        ensure_project_row_exists(connection, project_id)
        rows = _wrong_answer_rows(connection, project_id)

    return _wrong_answer_summary(project_id, rows)


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
            END AS source_excerpt,
            CASE
                WHEN practice_session_questions.document_id IS NOT NULL
                THEN practice_session_questions.document_id
                ELSE question_drafts.document_id
            END AS document_id
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
        ),
        ranked_attempts AS (
            SELECT
                practice_attempts.*,
                ROW_NUMBER() OVER (
                    PARTITION BY practice_attempts.question_id
                    ORDER BY practice_attempts.created_at DESC, practice_attempts.id DESC
                ) AS attempt_rank
            FROM target_attempt
            JOIN practice_attempts
                ON practice_attempts.project_id = ?
                AND practice_attempts.question_id = target_attempt.question_id
                AND practice_attempts.created_at >= target_attempt.created_at
        )
        SELECT
            ranked_attempts.id AS attempt_id,
            ranked_attempts.session_id,
            ranked_attempts.question_id,
            ranked_attempts.selected_answer,
            ranked_attempts.is_correct,
            ranked_attempts.created_at,
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
            END AS source_excerpt,
            CASE
                WHEN practice_session_questions.document_id IS NOT NULL
                THEN practice_session_questions.document_id
                ELSE question_drafts.document_id
            END AS document_id
        FROM ranked_attempts
        LEFT JOIN practice_session_questions
            ON practice_session_questions.project_id = ranked_attempts.project_id
            AND practice_session_questions.session_id = ranked_attempts.session_id
            AND practice_session_questions.question_id = ranked_attempts.question_id
        LEFT JOIN question_drafts
            ON question_drafts.project_id = ranked_attempts.project_id
            AND question_drafts.id = ranked_attempts.question_id
        WHERE (
                practice_session_questions.question_id IS NOT NULL
                OR question_drafts.id IS NOT NULL
            )
            AND ranked_attempts.attempt_rank = 1
        ORDER BY ranked_attempts.created_at DESC
        """,
        (project_id, attempt_id, project_id),
    ).fetchall()


def _current_wrong_answers(project_id: str, rows: list[Row]) -> tuple[WrongAnswer, ...]:
    attempts = [practice_attempt_from_wrong_answer_row(project_id, row) for row in rows]
    questions: dict[str, PracticeQuestion] = {}
    for row in rows:
        questions.setdefault(row["question_id"], practice_question_from_wrong_answer_row(row))
    return current_wrong_answers(attempts, questions)


def _wrong_answer_summary(project_id: str, rows: list[Row]) -> dict:
    attempts = [practice_attempt_from_wrong_answer_row(project_id, row) for row in rows]
    wrong_rows = [row for row in rows if not bool(row["is_correct"])]
    current_wrong_answers = _current_wrong_answers(project_id, rows)
    wrong_count_by_question = Counter(row["question_id"] for row in wrong_rows)
    last_wrong_by_question: dict[str, str] = {}
    questions: dict[str, PracticeQuestion] = {}
    for row in wrong_rows:
        last_wrong_by_question.setdefault(row["question_id"], row["created_at"])
        questions.setdefault(row["question_id"], practice_question_from_wrong_answer_row(row))

    latest_attempt_by_question = {}
    for attempt in sorted(attempts, key=lambda item: item.created_at, reverse=True):
        latest_attempt_by_question.setdefault(attempt.question_id, attempt)

    cleared_question_ids = {
        question_id
        for question_id, attempt in latest_attempt_by_question.items()
        if attempt.is_correct and wrong_count_by_question[question_id] > 0
    }

    return {
        "current_wrong_count": len(current_wrong_answers),
        "cleared_count": len(cleared_question_ids),
        "last_wrong_date": wrong_rows[0]["created_at"] if wrong_rows else None,
        "repeated_misses": _repeated_misses(
            wrong_count_by_question=wrong_count_by_question,
            questions=questions,
            last_wrong_by_question=last_wrong_by_question,
        ),
        "clusters": _wrong_answer_clusters(
            current_wrong_answers=current_wrong_answers,
            cleared_question_ids=cleared_question_ids,
            questions=questions,
            last_wrong_by_question=last_wrong_by_question,
        ),
    }


def _repeated_misses(
    *,
    wrong_count_by_question: Counter[str],
    questions: dict[str, PracticeQuestion],
    last_wrong_by_question: dict[str, str],
) -> list[dict]:
    repeated = [
        {
            "question_id": question_id,
            "question": questions[question_id].question,
            "document_id": questions[question_id].document_id,
            "citation_page": questions[question_id].citation_page,
            "source_excerpt": questions[question_id].source_excerpt,
            "miss_count": miss_count,
            "last_wrong_at": last_wrong_by_question[question_id],
        }
        for question_id, miss_count in wrong_count_by_question.items()
        if miss_count > 1 and question_id in questions
    ]
    return sorted(
        repeated,
        key=lambda item: (-item["miss_count"], item["last_wrong_at"], item["question_id"]),
    )


def _wrong_answer_clusters(
    *,
    current_wrong_answers: tuple[WrongAnswer, ...],
    cleared_question_ids: set[str],
    questions: dict[str, PracticeQuestion],
    last_wrong_by_question: dict[str, str],
) -> list[dict]:
    clusters: defaultdict[tuple[str | None, int | None], dict] = defaultdict(
        lambda: {
            "document_id": None,
            "citation_page": None,
            "current_wrong_count": 0,
            "cleared_count": 0,
            "last_wrong_at": None,
        }
    )
    for wrong_answer in current_wrong_answers:
        key = (wrong_answer.document_id, wrong_answer.citation_page)
        cluster = clusters[key]
        cluster["document_id"] = wrong_answer.document_id
        cluster["citation_page"] = wrong_answer.citation_page
        cluster["current_wrong_count"] += 1
        cluster["last_wrong_at"] = _max_timestamp(
            cluster["last_wrong_at"],
            wrong_answer.created_at,
        )
    for question_id in cleared_question_ids:
        question = questions.get(question_id)
        if question is None:
            continue
        key = (question.document_id, question.citation_page)
        cluster = clusters[key]
        cluster["document_id"] = question.document_id
        cluster["citation_page"] = question.citation_page
        cluster["cleared_count"] += 1
        cluster["last_wrong_at"] = _max_timestamp(
            cluster["last_wrong_at"],
            last_wrong_by_question[question_id],
        )

    return sorted(
        clusters.values(),
        key=lambda item: (
            item["document_id"] or "",
            item["citation_page"] if item["citation_page"] is not None else -1,
        ),
    )


def _max_timestamp(current: str | None, candidate: str) -> str:
    if current is None or candidate > current:
        return candidate
    return current
