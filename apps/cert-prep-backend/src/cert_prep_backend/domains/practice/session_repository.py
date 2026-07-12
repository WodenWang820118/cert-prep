from __future__ import annotations

import json
import secrets
from collections.abc import Mapping
from sqlite3 import Row
from uuid import uuid4

from cert_prep_backend.api.errors import NotFoundError, ValidationError
from cert_prep_backend.domains.practice.exceptions import PracticeSessionConflict
from cert_prep_backend.domains.practice.models import (
    PracticeSessionMode,
    PracticeSessionStatus,
    WrongAnswer,
)
from cert_prep_backend.domains.practice.policies import (
    DOCUMENT_REQUIRED_FOR_FULL_DOCUMENT_MESSAGE,
    PracticeRuleViolation,
    is_playable_practice_question,
    select_random_session_question_ids,
    select_session_question_ids,
)
from cert_prep_backend.domains.practice.query_helpers import (
    ensure_project_row_exists,
    fetch_practice_session_row,
)
from cert_prep_backend.domains.practice.row_mappers import (
    attempt_to_record,
    practice_question_from_row,
    session_to_record,
)
from cert_prep_backend.domains.practice.wrong_answer_repository import (
    list_current_wrong_answer_models,
)
from cert_prep_backend.domains.source_documents import repository as documents_repository
from cert_prep_backend.persistence.database import Database, utc_now


DEFAULT_RANDOM_QUESTION_COUNT = 10
QUESTION_DRAFT_PRACTICE_COLUMNS = """
    id,
    question,
    choices_json,
    answer,
    status,
    rationale,
    citation_page,
    source_excerpt,
    document_id
"""


def create_session(
    db: Database,
    project_id: str,
    *,
    mode: PracticeSessionMode | str = PracticeSessionMode.RANDOM_DRAW,
    document_id: str | None = None,
    question_count: int | None = None,
    random_seed: int | None = None,
    wrong_attempt_ids: list[str] | None = None,
) -> dict:
    session_mode = PracticeSessionMode(mode)
    if session_mode is PracticeSessionMode.FULL_DOCUMENT and document_id is None:
        raise ValidationError(DOCUMENT_REQUIRED_FOR_FULL_DOCUMENT_MESSAGE)
    if session_mode is PracticeSessionMode.FULL_DOCUMENT and document_id is not None:
        documents_repository.ensure_document_exists(db, project_id, document_id)

    now = utc_now()
    session_id = str(uuid4())
    with db.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        ensure_project_row_exists(connection, project_id)
        active_row = _fetch_active_session_row(connection, project_id)
        if active_row is not None:
            active_session = _session_summary_record(active_row)
            raise PracticeSessionConflict(
                "active_session_exists",
                "An active practice session already exists for this project.",
                details={"active_session": active_session},
            )
        question_rows = _playable_question_rows(
            connection,
            project_id=project_id,
            mode=session_mode,
            document_id=document_id,
            wrong_attempt_ids=wrong_attempt_ids,
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
            elif session_mode is PracticeSessionMode.FULL_DOCUMENT:
                stored_seed = None
                stored_document_id = document_id
                question_ids = select_session_question_ids(
                    [row["id"] for row in question_rows],
                    effective_count,
                )
            else:
                stored_seed = None
                stored_document_id = None
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
        row = fetch_practice_session_row(connection, project_id, session_id)
        if row is None:
            raise NotFoundError("Practice session not found.")
        return _session_record(connection, row)


def get_session(db: Database, project_id: str, session_id: str) -> dict:
    with db.connect() as connection:
        row = fetch_practice_session_row(connection, project_id, session_id)
        if row is None:
            raise NotFoundError("Practice session not found.")
        return _session_record(connection, row)


def list_active_sessions(db: Database, project_id: str) -> list[dict]:
    with db.connect() as connection:
        ensure_project_row_exists(connection, project_id)
        active_row = _fetch_active_session_row(connection, project_id)
        if active_row is None:
            return []
        return [_session_summary_record(active_row)]


def abandon_session(db: Database, project_id: str, session_id: str) -> dict:
    now = utc_now()
    with db.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = fetch_practice_session_row(connection, project_id, session_id)
        if row is None:
            raise NotFoundError("Practice session not found.")

        session_status = PracticeSessionStatus(row["status"])
        if session_status is PracticeSessionStatus.COMPLETED:
            raise PracticeSessionConflict(
                "practice_session_completed",
                "Completed practice sessions cannot be abandoned.",
            )
        if session_status is PracticeSessionStatus.ACTIVE:
            connection.execute(
                """
                UPDATE practice_sessions
                SET status = 'abandoned', abandoned_at = ?
                WHERE project_id = ? AND id = ? AND status = 'active'
                """,
                (now, project_id, session_id),
            )

        updated_row = fetch_practice_session_row(connection, project_id, session_id)
        if updated_row is None:
            raise NotFoundError("Practice session not found.")
        return _session_record(connection, updated_row)


def _playable_question_rows(
    connection,
    *,
    project_id: str,
    mode: PracticeSessionMode,
    document_id: str | None,
    wrong_attempt_ids: list[str] | None,
) -> list[Row | dict[str, object]]:
    if mode is PracticeSessionMode.REVIEW_RETRY:
        return _review_retry_question_rows(
            connection,
            project_id=project_id,
            wrong_attempt_ids=wrong_attempt_ids,
        )

    if mode is PracticeSessionMode.FULL_DOCUMENT:
        rows = connection.execute(
            f"""
            SELECT {QUESTION_DRAFT_PRACTICE_COLUMNS}
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
        f"""
        SELECT {QUESTION_DRAFT_PRACTICE_COLUMNS}
        FROM question_drafts
        WHERE project_id = ? AND status = 'approved'
        ORDER BY id
        """,
        (project_id,),
    ).fetchall()
    return _playable_rows(rows)


def _review_retry_question_rows(
    connection,
    *,
    project_id: str,
    wrong_attempt_ids: list[str] | None,
) -> list[dict[str, object]]:
    current_wrong_answers = list_current_wrong_answer_models(connection, project_id)
    if wrong_attempt_ids is not None:
        current_by_attempt_id = {
            wrong_answer.attempt_id: wrong_answer for wrong_answer in current_wrong_answers
        }
        unique_attempt_ids = list(dict.fromkeys(wrong_attempt_ids))
        try:
            current_wrong_answers = [
                current_by_attempt_id[attempt_id] for attempt_id in unique_attempt_ids
            ]
        except KeyError as exc:
            raise ValidationError(
                "Wrong attempt ids must refer to current wrong answers in this project."
            ) from exc

    if not current_wrong_answers:
        raise ValidationError("No current wrong answers are available for review retry.")

    return [_review_retry_question_row(wrong_answer) for wrong_answer in current_wrong_answers]


def _review_retry_question_row(wrong_answer: WrongAnswer) -> dict[str, object]:
    return {
        "id": wrong_answer.question_id,
        "question": wrong_answer.question,
        "choices_json": json.dumps(list(wrong_answer.choices)),
        "answer": wrong_answer.correct_answer,
        "rationale": wrong_answer.rationale,
        "citation_page": wrong_answer.citation_page,
        "source_excerpt": wrong_answer.source_excerpt,
        "document_id": wrong_answer.document_id,
    }


def _playable_rows(rows: list[Row]) -> list[Row]:
    return [
        row
        for row in rows
        if is_playable_practice_question(practice_question_from_row(row))
    ]


def _insert_session_question_snapshots(
    connection,
    *,
    session_id: str,
    project_id: str,
    question_rows: list[Mapping[str, object]],
    question_ids: tuple[str, ...],
    created_at: str,
) -> None:
    rows_by_id = {row["id"]: row for row in question_rows}
    connection.executemany(
        """
        INSERT INTO practice_session_questions(
            session_id, project_id, question_id, question_order, question,
            choices_json, correct_answer, rationale, citation_page, source_excerpt,
            created_at, document_id
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                rows_by_id[question_id]["document_id"],
            )
            for index, question_id in enumerate(question_ids)
        ],
    )


def _effective_question_count(
    *,
    mode: PracticeSessionMode,
    requested_question_count: int | None,
    available_question_count: int,
) -> int:
    if requested_question_count is not None:
        return requested_question_count
    if mode in {PracticeSessionMode.FULL_DOCUMENT, PracticeSessionMode.REVIEW_RETRY}:
        return available_question_count
    return DEFAULT_RANDOM_QUESTION_COUNT


def _session_record(connection, row: Row) -> dict:
    record = session_to_record(row)
    record["questions"] = _session_question_records(
        connection,
        project_id=row["project_id"],
        session_id=row["id"],
        question_ids=record["question_ids"],
    )
    record["attempts"] = _session_attempt_records(
        connection,
        project_id=row["project_id"],
        session_id=row["id"],
    )
    return record


def _fetch_active_session_row(connection, project_id: str) -> Row | None:
    return connection.execute(
        """
        SELECT *
        FROM practice_sessions
        WHERE project_id = ? AND status = 'active'
        ORDER BY created_at DESC, id DESC
        LIMIT 1
        """,
        (project_id,),
    ).fetchone()


def _session_summary_record(row: Row) -> dict[str, object]:
    return {
        "id": row["id"],
        "project_id": row["project_id"],
        "mode": row["mode"],
        "document_id": row["source_document_id"],
        "status": row["status"],
        "created_at": row["created_at"],
    }


def _session_attempt_records(
    connection,
    *,
    project_id: str,
    session_id: str,
) -> list[dict[str, object]]:
    rows = connection.execute(
        """
        SELECT *
        FROM practice_attempts
        WHERE project_id = ? AND session_id = ?
        ORDER BY created_at, id
        """,
        (project_id, session_id),
    ).fetchall()
    return [attempt_to_record(row) for row in rows]


def _session_question_records(
    connection,
    *,
    project_id: str,
    session_id: str,
    question_ids: list[str],
) -> list[dict[str, object]]:
    snapshot_rows = connection.execute(
        """
        SELECT
            practice_session_questions.question_id AS id,
            practice_session_questions.question,
            practice_session_questions.choices_json,
            practice_session_questions.correct_answer AS answer,
            practice_session_questions.rationale,
            practice_session_questions.citation_page,
            practice_session_questions.source_excerpt,
            COALESCE(practice_session_questions.document_id, question_drafts.document_id)
                AS document_id
        FROM practice_session_questions
        LEFT JOIN question_drafts
            ON question_drafts.project_id = practice_session_questions.project_id
            AND question_drafts.id = practice_session_questions.question_id
        WHERE practice_session_questions.project_id = ?
            AND practice_session_questions.session_id = ?
        """,
        (project_id, session_id),
    ).fetchall()
    rows_by_id: dict[str, Row] = {row["id"]: row for row in snapshot_rows}
    missing_question_ids = [
        question_id for question_id in question_ids if question_id not in rows_by_id
    ]
    if missing_question_ids:
        placeholders = ", ".join("?" for _ in missing_question_ids)
        draft_rows = connection.execute(
            f"""
            SELECT
                id,
                question,
                choices_json,
                answer,
                rationale,
                citation_page,
                source_excerpt,
                document_id
            FROM question_drafts
            WHERE project_id = ? AND id IN ({placeholders})
            """,
            (project_id, *missing_question_ids),
        ).fetchall()
        rows_by_id.update({row["id"]: row for row in draft_rows})
    return [
        _session_question_record(rows_by_id[question_id])
        for question_id in question_ids
        if question_id in rows_by_id
    ]


def _session_question_record(row: Row) -> dict[str, object]:
    return {
        "id": row["id"],
        "question": row["question"],
        "choices": list(json.loads(row["choices_json"])),
        "answer": row["answer"],
        "rationale": row["rationale"],
        "citation_page": row["citation_page"],
        "source_excerpt": row["source_excerpt"],
        "document_id": row["document_id"],
    }
