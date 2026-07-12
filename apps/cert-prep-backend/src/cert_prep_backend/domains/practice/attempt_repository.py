from __future__ import annotations

from uuid import uuid4

from cert_prep_backend.api.errors import NotFoundError, ValidationError
from cert_prep_backend.domains.practice.exceptions import PracticeSessionConflict
from cert_prep_backend.domains.practice.models import (
    PracticeQuestion,
    PracticeSession,
    PracticeSessionStatus,
)
from cert_prep_backend.domains.practice.policies import (
    PracticeRuleViolation,
    build_practice_attempt,
    is_playable_practice_question,
)
from cert_prep_backend.domains.practice.query_helpers import fetch_practice_session_row
from cert_prep_backend.domains.practice.row_mappers import (
    attempt_to_record,
    practice_question_from_row,
    practice_session_from_row,
)
from cert_prep_backend.persistence.database import Database, utc_now


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
        session_row = fetch_practice_session_row(connection, project_id, session_id)
        if session_row is None:
            raise NotFoundError("Practice session not found.")
        session = practice_session_from_row(session_row)
        if session.status is PracticeSessionStatus.ABANDONED:
            raise PracticeSessionConflict(
                "practice_session_abandoned",
                "Abandoned practice sessions cannot accept attempts.",
            )
        practice_question = _practice_question_for_attempt(
            connection,
            session=session,
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
        _complete_session_after_full_coverage(
            connection,
            session=session,
            completed_at=now,
        )
        row = connection.execute(
            "SELECT * FROM practice_attempts WHERE id = ?",
            (attempt_id,),
        ).fetchone()
    return attempt_to_record(row)


def _complete_session_after_full_coverage(
    connection,
    *,
    session: PracticeSession,
    completed_at: str,
) -> None:
    if session.status is not PracticeSessionStatus.ACTIVE:
        return

    required_question_ids = tuple(dict.fromkeys(session.question_ids))
    required_question_count = len(required_question_ids)
    if required_question_count == 0:
        return
    placeholders = ", ".join("?" for _ in required_question_ids)
    answered_question_count = connection.execute(
        f"""
        SELECT COUNT(DISTINCT question_id)
        FROM practice_attempts
        WHERE project_id = ? AND session_id = ?
            AND question_id IN ({placeholders})
        """,
        (session.project_id, session.id, *required_question_ids),
    ).fetchone()[0]
    if answered_question_count < required_question_count:
        return

    connection.execute(
        """
        UPDATE practice_sessions
        SET status = 'completed', completed_at = COALESCE(completed_at, ?)
        WHERE project_id = ? AND id = ? AND status = 'active'
        """,
        (completed_at, session.project_id, session.id),
    )


def _practice_question_for_attempt(
    connection,
    *,
    session: PracticeSession,
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
            source_excerpt,
            document_id
        FROM practice_session_questions
        WHERE project_id = ? AND session_id = ? AND question_id = ?
        """,
        (session.project_id, session_id, question_id),
    ).fetchone()
    if snapshot_row is not None:
        return practice_question_from_row(snapshot_row)

    question_row = connection.execute(
        """
        SELECT
            id,
            choices_json,
            answer,
            question,
            status,
            rationale,
            citation_page,
            source_excerpt,
            document_id
        FROM question_drafts
        WHERE project_id = ? AND id = ?
        """,
        (session.project_id, question_id),
    ).fetchone()
    if question_row is None:
        return None

    practice_question = practice_question_from_row(question_row)
    if session.includes_question(question_id):
        return practice_question
    if not is_playable_practice_question(practice_question):
        return None
    return practice_question
