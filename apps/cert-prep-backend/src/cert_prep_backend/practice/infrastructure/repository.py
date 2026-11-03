"""SQLite storage of practice sessions, their question snapshots and attempts."""

from __future__ import annotations

from collections.abc import Callable, Iterator, Sequence
from contextlib import contextmanager
from dataclasses import replace
import json
from sqlite3 import Connection, Row

from cert_prep_backend.platform.database import Database
from cert_prep_backend.practice.application.ports import (
    DraftedQuestion,
    PracticeQuestions,
    ProjectDocuments,
    StudyProjects,
)
from cert_prep_backend.practice.domain.attempt import PracticeAttempt
from cert_prep_backend.practice.domain.session import PracticeQuestion, PracticeSession
from cert_prep_backend.practice.domain.wrong_answer import AnsweredQuestion


class SqlitePracticeStore:
    def __init__(
        self,
        db: Database,
        *,
        bind_reads: Callable[[Connection], tuple[StudyProjects, PracticeQuestions]],
        documents: ProjectDocuments,
    ) -> None:
        self._db = db
        # bind_reads joins Study Projects and Question Authoring to this unit of work's
        # connection, so their reads stay in practice's transaction.
        self._bind_reads = bind_reads
        self._documents = documents

    @contextmanager
    def writing(self) -> Iterator[SqlitePracticeRepository]:
        with self._db.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            yield self._repository(connection)

    @contextmanager
    def reading(self) -> Iterator[SqlitePracticeRepository]:
        with self._db.connect() as connection:
            yield self._repository(connection)

    def require_document(self, project_id: str, document_id: str) -> None:
        # Its own connection, opened before the write transaction, as before.
        self._documents.require(project_id, document_id)

    def _repository(self, connection: Connection) -> SqlitePracticeRepository:
        projects, questions = self._bind_reads(connection)
        return SqlitePracticeRepository(connection, projects=projects, questions=questions)


class SqlitePracticeRepository:
    def __init__(
        self,
        connection: Connection,
        *,
        projects: StudyProjects,
        questions: PracticeQuestions,
    ) -> None:
        self._connection = connection
        self._projects = projects
        self._questions = questions

    def project_exists(self, project_id: str) -> bool:
        return self._projects.exists(project_id)

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
        return [
            draft.as_question(keep_status=True)
            for draft in self._questions.approved(project_id, document_id=document_id)
        ]

    def answer_history(self, project_id: str) -> list[AnsweredQuestion]:
        attempts = self._attempt_rows(
            """
            SELECT
                id AS attempt_id,
                session_id,
                question_id,
                selected_answer,
                is_correct,
                created_at
            FROM practice_attempts
            WHERE project_id = ?
            ORDER BY created_at DESC, rowid DESC
            """,
            (project_id,),
        )
        return self._answered_questions(project_id, attempts)

    def answer_history_since(self, project_id: str, attempt_id: str) -> list[AnsweredQuestion]:
        # The latest attempt of the target's question at or after that attempt. Rank 1
        # with no snapshot and no draft drops the row, rather than falling through.
        target = self._connection.execute(
            """
            SELECT question_id, created_at, rowid AS attempt_sequence
            FROM practice_attempts
            WHERE project_id = ? AND id = ?
            """,
            (project_id, attempt_id),
        ).fetchone()
        if target is None:
            return []
        attempts = self._attempt_rows(
            """
            SELECT
                id AS attempt_id,
                session_id,
                question_id,
                selected_answer,
                is_correct,
                created_at
            FROM practice_attempts
            WHERE project_id = ? AND question_id = ?
                AND (
                    created_at > ?
                    OR (created_at = ? AND rowid >= ?)
                )
            ORDER BY created_at DESC, rowid DESC
            LIMIT 1
            """,
            (
                project_id,
                target["question_id"],
                target["created_at"],
                target["created_at"],
                target["attempt_sequence"],
            ),
        )
        return self._answered_questions(project_id, attempts)

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
        draft = self._questions.current(session.project_id, question_id)
        if draft is None:
            return None
        question = draft.as_question(keep_status=True)
        if session.includes_question(question_id) or question.is_playable():
            return question
        return None

    def current_question(self, project_id: str, question_id: str) -> PracticeQuestion | None:
        draft = self._questions.current(project_id, question_id)
        return None if draft is None else draft.as_question(keep_status=True)

    def attempts_for_question(self, project_id: str, question_id: str) -> list[PracticeAttempt]:
        rows = self._connection.execute(
            """
            SELECT *
            FROM practice_attempts
            WHERE project_id = ? AND question_id = ?
            ORDER BY created_at ASC, rowid ASC
            """,
            (project_id, question_id),
        ).fetchall()
        return [_attempt_from_row(row) for row in rows]

    def refresh_snapshot_keys(self, project_id: str, question: PracticeQuestion) -> int:
        updated = self._connection.execute(
            """
            UPDATE practice_session_questions
            SET correct_answer = ?, rationale = ?
            WHERE project_id = ? AND question_id = ? AND question = ? AND choices_json = ?
            """,
            (
                question.correct_answer,
                question.rationale,
                project_id,
                question.id,
                question.question,
                json.dumps(list(question.choices)),
            ),
        )
        return updated.rowcount

    def save_attempt_grades(self, attempts: list[PracticeAttempt]) -> None:
        self._connection.executemany(
            """
            UPDATE practice_attempts
            SET is_correct = ?
            WHERE project_id = ? AND id = ?
            """,
            [
                (int(attempt.is_correct), attempt.project_id, attempt.id)
                for attempt in attempts
            ],
        )

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
                question_id AS id,
                question,
                choices_json,
                correct_answer AS answer,
                rationale,
                citation_page,
                source_excerpt,
                document_id
            FROM practice_session_questions
            WHERE project_id = ? AND session_id = ?
            """,
            (session.project_id, session.id),
        ).fetchall()
        snapshots = {row["id"]: row for row in snapshot_rows}
        drafts = self._drafts_by_id(session.project_id, session.question_ids)
        questions: list[PracticeQuestion] = []
        for question_id in session.question_ids:
            snapshot = snapshots.get(question_id)
            draft = drafts.get(question_id)
            if snapshot is not None:
                questions.append(_snapshot_question(snapshot, draft))
            elif draft is not None:
                # Sessions from before question snapshots fall back to the draft, and the
                # old query did not select the draft's status, so the question stays approved.
                questions.append(draft.as_question(keep_status=False))
        return questions

    def _attempt_rows(self, sql: str, parameters: tuple[object, ...]) -> list[Row]:
        return self._connection.execute(sql, parameters).fetchall()

    def _answered_questions(
        self, project_id: str, attempts: Sequence[Row]
    ) -> list[AnsweredQuestion]:
        if not attempts:
            return []
        snapshots = self._snapshots(project_id)
        drafts = self._drafts_by_id(project_id, [row["question_id"] for row in attempts])
        answered: list[AnsweredQuestion] = []
        for row in attempts:
            question = _question_as_answered(
                row["question_id"],
                snapshots.get((row["session_id"], row["question_id"])),
                drafts.get(row["question_id"]),
            )
            if question is None:
                continue
            answered.append(_answered_question(project_id, row, question))
        return answered

    def _snapshots(self, project_id: str) -> dict[tuple[str, str], Row]:
        rows = self._connection.execute(
            """
            SELECT
                session_id,
                question_id,
                question,
                choices_json,
                correct_answer,
                rationale,
                citation_page,
                source_excerpt,
                document_id
            FROM practice_session_questions
            WHERE project_id = ?
            """,
            (project_id,),
        ).fetchall()
        return {(row["session_id"], row["question_id"]): row for row in rows}

    def _drafts_by_id(
        self, project_id: str, question_ids: Sequence[str]
    ) -> dict[str, DraftedQuestion]:
        return {
            draft.id: draft
            for draft in self._questions.current_many(project_id, list(question_ids))
        }


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
        answer_key_source=_optional_text(row, "answer_key_source"),
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


def _answered_question(project_id: str, row: Row, question: PracticeQuestion) -> AnsweredQuestion:
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
        question=question,
    )


def _snapshot_question(snapshot: Row, draft: DraftedQuestion | None) -> PracticeQuestion:
    """A stored snapshot. Its document id falls back to the draft; the answer key always does."""

    document_id = snapshot["document_id"]
    if document_id is None and draft is not None:
        document_id = draft.document_id
    return PracticeQuestion(
        id=snapshot["id"],
        choices=tuple(json.loads(snapshot["choices_json"])),
        correct_answer=snapshot["answer"],
        question=snapshot["question"],
        rationale=snapshot["rationale"],
        citation_page=snapshot["citation_page"],
        source_excerpt=snapshot["source_excerpt"],
        document_id=document_id,
        answer_key_source=None if draft is None else draft.answer_key_source,
    )


def _question_as_answered(
    question_id: str, snapshot: Row | None, draft: DraftedQuestion | None
) -> PracticeQuestion | None:
    """The question an attempt answered: the snapshot when the session stored one, else the draft.

    An attempt with neither is left out. The snapshot wins for the text that was shown;
    the answer-key source always comes from the current draft, and a null snapshot
    document id falls back to the draft's.
    """

    if snapshot is None:
        return None if draft is None else draft.as_question(keep_status=False)
    document_id = snapshot["document_id"]
    if document_id is None and draft is not None:
        document_id = draft.document_id
    return PracticeQuestion(
        id=question_id,
        choices=tuple(json.loads(snapshot["choices_json"])),
        correct_answer=snapshot["correct_answer"],
        question=snapshot["question"],
        rationale=snapshot["rationale"],
        citation_page=snapshot["citation_page"],
        source_excerpt=snapshot["source_excerpt"],
        document_id=document_id,
        answer_key_source=None if draft is None else draft.answer_key_source,
    )


def _optional_text(row: Row, column: str) -> str | None:
    if column not in row.keys():
        return None
    value = row[column]
    return value if isinstance(value, str) else None
