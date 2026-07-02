from __future__ import annotations

import json
import secrets
from sqlite3 import Row
from uuid import uuid4

from cert_prep_backend.api.errors import NotFoundError, ValidationError
from cert_prep_backend.domains.practice.models import PracticeSessionMode
from cert_prep_backend.domains.practice.policies import (
    DOCUMENT_REQUIRED_FOR_FULL_DOCUMENT_MESSAGE,
    PracticeRuleViolation,
    is_playable_practice_question,
    select_random_session_question_ids,
    select_session_question_ids,
)
from cert_prep_backend.domains.practice.query_helpers import fetch_practice_session_row
from cert_prep_backend.domains.practice.row_mappers import (
    practice_question_from_row,
    session_to_record,
)
from cert_prep_backend.domains.projects.repository import ensure_project_exists
from cert_prep_backend.domains.source_documents import repository as documents_repository
from cert_prep_backend.persistence.database import Database, utc_now


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
        row = fetch_practice_session_row(connection, project_id, session_id)
    if row is None:
        raise NotFoundError("Practice session not found.")
    return session_to_record(row)


def get_session(db: Database, project_id: str, session_id: str) -> dict:
    with db.connect() as connection:
        row = fetch_practice_session_row(connection, project_id, session_id)
    if row is None:
        raise NotFoundError("Practice session not found.")
    return session_to_record(row)


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
        if is_playable_practice_question(practice_question_from_row(row))
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
