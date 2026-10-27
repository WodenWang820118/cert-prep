"""SQLite storage of practice sessions, their question snapshots and attempts."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import replace
import json
from sqlite3 import Connection, Row

from cert_prep_backend.platform.database import Database
from cert_prep_backend.platform.errors import NotFoundError
from cert_prep_backend.practice.domain.attempt import PracticeAttempt
from cert_prep_backend.practice.domain.session import PracticeQuestion, PracticeSession
from cert_prep_backend.practice.domain.wrong_answer import AnsweredQuestion

_QUESTION_DRAFT_COLUMNS = """
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
# The question an attempt answered: the session's snapshot when it has one, else the draft.
_ANSWERED_QUESTION_COLUMNS = """
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
"""


class SqlitePracticeStore:
    def __init__(self, db: Database) -> None:
        self._db = db

    @contextmanager
    def writing(self) -> Iterator[SqlitePracticeRepository]:
        with self._db.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            yield SqlitePracticeRepository(connection)

    @contextmanager
    def reading(self) -> Iterator[SqlitePracticeRepository]:
        with self._db.connect() as connection:
            yield SqlitePracticeRepository(connection)

    def require_document(self, project_id: str, document_id: str) -> None:
        with self._db.connect() as connection:
            row = connection.execute(
                "SELECT 1 FROM documents WHERE project_id = ? AND id = ?",
                (project_id, document_id),
            ).fetchone()
        if row is None:
            raise NotFoundError("Document not found.")


class SqlitePracticeRepository:
    def __init__(self, connection: Connection) -> None:
        self._connection = connection

    def project_exists(self, project_id: str) -> bool:
        row = self._connection.execute(
            "SELECT 1 FROM projects WHERE id = ?", (project_id,)
        ).fetchone()
        return row is not None

    def active_session(self, project_id: str) -> PracticeSession | None:
        row = self._connection.execute(
            """
            SELECT *
            FROM practice_sessions
            WHERE project_id = ? AND status = 'active'
            ORDER BY created_at DESC, id DESC
            LIMIT 1
            """,
            (project_id,),
        ).fetchone()
        return None if row is None else _session_from_row(row)

    def approved_questions(
        self, project_id: str, *, document_id: str | None
    ) -> list[PracticeQuestion]:
        if document_id is None:
            rows = self._connection.execute(
                f"""
                SELECT {_QUESTION_DRAFT_COLUMNS}
                FROM question_drafts
                WHERE project_id = ? AND status = 'approved'
                ORDER BY id
                """,
                (project_id,),
            ).fetchall()
        else:
            rows = self._connection.execute(
                f"""
                SELECT {_QUESTION_DRAFT_COLUMNS}
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
        return [_question_from_row(row) for row in rows]

    def answer_history(self, project_id: str) -> list[AnsweredQuestion]:
        rows = self._connection.execute(
            f"""
            SELECT
                practice_attempts.id AS attempt_id,
                practice_attempts.session_id,
                practice_attempts.question_id,
                practice_attempts.selected_answer,
                practice_attempts.is_correct,
                practice_attempts.created_at,
                {_ANSWERED_QUESTION_COLUMNS}
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
            ORDER BY practice_attempts.created_at DESC, practice_attempts.rowid DESC
            """,
            (project_id,),
        ).fetchall()
        return [_answered_question_from_row(project_id, row) for row in rows]

    def answer_history_since(self, project_id: str, attempt_id: str) -> list[AnsweredQuestion]:
        rows = self._connection.execute(
            f"""
            WITH target_attempt AS (
                SELECT question_id, created_at, rowid AS attempt_sequence
                FROM practice_attempts
                WHERE project_id = ? AND id = ?
            ),
            ranked_attempts AS (
                SELECT
                    practice_attempts.*,
                    practice_attempts.rowid AS attempt_sequence,
                    ROW_NUMBER() OVER (
                        PARTITION BY practice_attempts.question_id
                        ORDER BY practice_attempts.created_at DESC, practice_attempts.rowid DESC
                    ) AS attempt_rank
                FROM target_attempt
                JOIN practice_attempts
                    ON practice_attempts.project_id = ?
                    AND practice_attempts.question_id = target_attempt.question_id
                    AND (
                        practice_attempts.created_at > target_attempt.created_at
                        OR (
                            practice_attempts.created_at = target_attempt.created_at
                            AND practice_attempts.rowid >= target_attempt.attempt_sequence
                        )
                    )
            )
            SELECT
                ranked_attempts.id AS attempt_id,
                ranked_attempts.session_id,
                ranked_attempts.question_id,
                ranked_attempts.selected_answer,
                ranked_attempts.is_correct,
                ranked_attempts.created_at,
                {_ANSWERED_QUESTION_COLUMNS}
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
            ORDER BY ranked_attempts.created_at DESC, ranked_attempts.attempt_sequence DESC
            """,
            (project_id, attempt_id, project_id),
        ).fetchall()
        return [_answered_question_from_row(project_id, row) for row in rows]

    def add_session(self, session: PracticeSession) -> None:
        self._connection.execute(
            """
            INSERT INTO practice_sessions(
                id, project_id, question_ids_json, mode, source_document_id,
                requested_question_count, random_seed, status, created_at, completed_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
            """,
            (
                session.id,
                session.project_id,
                json.dumps(list(session.question_ids)),
                session.mode.value,
                session.source_document_id,
                session.requested_question_count,
                session.random_seed,
                session.status.value,
                session.created_at,
            ),
        )
        self._connection.executemany(
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
                    session.id,
                    session.project_id,
                    question.id,
                    index,
                    question.question,
                    json.dumps(list(question.choices)),
                    question.correct_answer,
                    question.rationale,
                    question.citation_page,
                    question.source_excerpt,
                    session.created_at,
                    question.document_id,
                )
                for index, question in enumerate(session.questions)
            ],
        )

    def session(self, project_id: str, session_id: str) -> PracticeSession | None:
        row = self._connection.execute(
            "SELECT * FROM practice_sessions WHERE project_id = ? AND id = ?",
            (project_id, session_id),
        ).fetchone()
        if row is None:
            return None
        session = _session_from_row(row)
        return replace(session, questions=tuple(self._session_questions(session)))

    def attempts_of(self, session: PracticeSession) -> list[PracticeAttempt]:
        rows = self._connection.execute(
            """
            SELECT *
            FROM practice_attempts
            WHERE project_id = ? AND session_id = ?
            ORDER BY created_at, id
            """,
            (session.project_id, session.id),
        ).fetchall()
        return [_attempt_from_row(row) for row in rows]

    def question_for_answer(
        self, session: PracticeSession, question_id: str
    ) -> PracticeQuestion | None:
        snapshot_row = self._connection.execute(
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
            (session.project_id, session.id, question_id),
        ).fetchone()
        if snapshot_row is not None:
            return _question_from_row(snapshot_row)
        draft_row = self._connection.execute(
            f"""
            SELECT {_QUESTION_DRAFT_COLUMNS}
            FROM question_drafts
            WHERE project_id = ? AND id = ?
            """,
            (session.project_id, question_id),
        ).fetchone()
        if draft_row is None:
            return None
        question = _question_from_row(draft_row)
        if session.includes_question(question_id) or question.is_playable():
            return question
        return None

    def add_attempt(self, attempt: PracticeAttempt) -> None:
        self._connection.execute(
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

    def answered_question_ids(self, session: PracticeSession) -> set[str]:
        rows = self._connection.execute(
            """
            SELECT DISTINCT question_id
            FROM practice_attempts
            WHERE project_id = ? AND session_id = ?
            """,
            (session.project_id, session.id),
        ).fetchall()
        return {row["question_id"] for row in rows}

    def save_status(self, session: PracticeSession) -> None:
        self._connection.execute(
            """
            UPDATE practice_sessions
            SET status = ?, completed_at = ?, abandoned_at = ?
            WHERE project_id = ? AND id = ? AND status = 'active'
            """,
            (
                session.status.value,
                session.completed_at,
                session.abandoned_at,
                session.project_id,
                session.id,
            ),
        )

    def _session_questions(self, session: PracticeSession) -> list[PracticeQuestion]:
        snapshot_rows = self._connection.execute(
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
            (session.project_id, session.id),
        ).fetchall()
        rows_by_id: dict[str, Row] = {row["id"]: row for row in snapshot_rows}
        missing = [question_id for question_id in session.question_ids if question_id not in rows_by_id]
        if missing:
            # Sessions from before question snapshots fall back to the drafts.
            placeholders = ", ".join("?" for _ in missing)
            draft_rows = self._connection.execute(
                f"""
                SELECT
                    id, question, choices_json, answer, rationale, citation_page,
                    source_excerpt, document_id
                FROM question_drafts
                WHERE project_id = ? AND id IN ({placeholders})
                """,
                (session.project_id, *missing),
            ).fetchall()
            rows_by_id.update({row["id"]: row for row in draft_rows})
        return [
            _question_from_row(rows_by_id[question_id])
            for question_id in session.question_ids
            if question_id in rows_by_id
        ]


def _session_from_row(row: Row) -> PracticeSession:
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
        abandoned_at=row["abandoned_at"],
    )


def _question_from_row(row: Row) -> PracticeQuestion:
    keys = row.keys()
    return PracticeQuestion(
        id=row["id"],
        choices=tuple(json.loads(row["choices_json"])),
        correct_answer=row["answer"],
        question=row["question"],
        status=row["status"] if "status" in keys else "approved",
        rationale=row["rationale"],
        citation_page=row["citation_page"],
        source_excerpt=row["source_excerpt"],
        document_id=row["document_id"],
    )


def _attempt_from_row(row: Row) -> PracticeAttempt:
    return PracticeAttempt(
        id=row["id"],
        session_id=row["session_id"],
        project_id=row["project_id"],
        question_id=row["question_id"],
        selected_answer=row["selected_answer"],
        is_correct=bool(row["is_correct"]),
        created_at=row["created_at"],
    )


def _answered_question_from_row(project_id: str, row: Row) -> AnsweredQuestion:
    return AnsweredQuestion(
        attempt=PracticeAttempt(
            id=row["attempt_id"],
            session_id=row["session_id"],
            project_id=project_id,
            question_id=row["question_id"],
            selected_answer=row["selected_answer"],
            is_correct=bool(row["is_correct"]),
            created_at=row["created_at"],
        ),
        question=PracticeQuestion(
            id=row["question_id"],
            choices=tuple(json.loads(row["choices_json"])),
            correct_answer=row["correct_answer"],
            question=row["question"],
            rationale=row["rationale"],
            citation_page=row["citation_page"],
            source_excerpt=row["source_excerpt"],
            document_id=row["document_id"],
        ),
    )
