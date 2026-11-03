"""Today's results of the practice queries that used to read other contexts' tables.

The reads now go through the owning context, on the practice transaction's connection
except for document membership, which still opens its own connection first.
"""

from __future__ import annotations

from pathlib import Path
from sqlite3 import Connection

import pytest

from cert_prep_backend.authoring.infrastructure.repository import SqliteQuestionDraftRepository
from cert_prep_backend.bootstrap.practice_reads import bind_practice_reads, practice_documents
from cert_prep_backend.platform.config import Settings
from cert_prep_backend.platform.database import Database
from cert_prep_backend.platform.errors import NotFoundError
from cert_prep_backend.practice.domain.attempt import PracticeAttempt
from cert_prep_backend.practice.domain.session import (
    PracticeQuestion,
    PracticeSession,
    QuestionDraftStatus,
)
from cert_prep_backend.practice.infrastructure.repository import SqlitePracticeStore
from cert_prep_backend.projects.infrastructure.repository import SqliteProjectRepository


class _LeaveUncommitted(Exception):
    """Stops the practice unit of work so its transaction rolls back."""


def test_approved_questions_use_id_order_or_document_source_order(tmp_path: Path) -> None:
    database = _database(tmp_path)
    store = _store(database)
    with database.connect() as connection:
        _project(connection, "proj")
        _document(connection, "proj", "doc-1")
        _document(connection, "proj", "doc-2")
        _draft(
            connection, draft_id="a", project_id="proj", document_id="doc-1",
            source_order=2, citation_page=9, created_at="t9",
        )
        _draft(
            connection, draft_id="b", project_id="proj", document_id="doc-1",
            source_order=1, citation_page=1, created_at="t0",
        )
        _draft(
            connection, draft_id="c", project_id="proj", document_id="doc-1",
            source_order=None, citation_page=5, created_at="t0",
        )
        _draft(
            connection, draft_id="d", project_id="proj", document_id="doc-1",
            source_order=None, citation_page=1, created_at="t9",
        )
        _draft(
            connection, draft_id="e", project_id="proj", document_id="doc-1",
            status="rejected", source_order=0, created_at="t0",
        )
        _draft(
            connection, draft_id="f", project_id="proj", document_id="doc-2",
            source_order=1, created_at="t0",
        )

    with store.reading() as practice:
        assert _ids(practice.approved_questions("proj", document_id=None)) == [
            "a", "b", "c", "d", "f",
        ]
        document_questions = practice.approved_questions("proj", document_id="doc-1")
        assert _ids(document_questions) == ["b", "a", "d", "c"]
        assert document_questions[0].status is QuestionDraftStatus.APPROVED


def test_session_and_history_keep_snapshot_text_and_the_draft_answer_key(tmp_path: Path) -> None:
    database = _database(tmp_path)
    store = _store(database)
    with database.connect() as connection:
        _project(connection, "proj")
        _document(connection, "proj", "doc")
        _draft(
            connection, draft_id="coalesce", project_id="proj", document_id="doc",
            question="draft coalesce", rationale="draft why",
        )
        _draft(
            connection, draft_id="kept", project_id="proj", document_id="doc",
            question="draft kept", answer_key_source="pdf",
        )
        _draft(
            connection, draft_id="retired", project_id="proj", document_id="doc",
            status="retired", question="draft retired", rationale="retired why",
            answer_key_source="pdf",
        )
        _draft(
            connection, draft_id="bare", project_id="proj", document_id="doc",
            question="bare question", rationale="",
        )
        _draft(
            connection, draft_id="outside", project_id="proj", document_id="doc",
            question="outside question", rationale="playable why", citation_page=2,
        )
        _draft(
            connection, draft_id="unplayable-outside", project_id="proj", document_id="doc",
            question="unplayable outside", rationale="",
        )

    coalesce = _shown("coalesce", correct_answer="B", rationale=None, document_id=None)
    kept = _shown("kept", document_id="kept-doc")
    retired_snapshot = _shown("retired", question="snapshot retired")
    bare = _shown("bare", question="snapshot bare")
    with store.writing() as practice:
        practice.add_session(
            PracticeSession(
                id="session",
                project_id="proj",
                question_ids=("snap-only", "coalesce", "kept", "retired", "bare"),
                created_at="t0",
                questions=(coalesce, kept, retired_snapshot, bare),
            )
        )
        practice._connection.execute(
            """
            INSERT INTO practice_session_questions(
                session_id, project_id, question_id, question_order, question,
                choices_json, correct_answer, rationale, citation_page, source_excerpt,
                created_at, document_id
            )
            VALUES ('session', 'proj', 'snap-only', 0, 'snapshot only',
                '["A", "B"]', 'A', NULL, 2, 'only excerpt', 't0', 'snap-doc')
            """
        )
        practice.add_attempt(_attempt("attempt-coalesce", "coalesce", created_at="t1"))
        practice.add_attempt(_attempt("attempt-retired", "retired", created_at="t2"))
        practice._connection.execute(
            """
            UPDATE question_drafts
            SET answer_key_source = 'pdf', question = 'edited coalesce',
                rationale = 'edited why'
            WHERE id = 'coalesce'
            """
        )
        practice._connection.execute(
            """
            DELETE FROM practice_session_questions
            WHERE question_id IN ('retired', 'bare')
            """
        )
        session = practice.session("proj", "session")
        assert session is not None
        shown = {question.id: question for question in session.questions}
        assert list(shown) == ["snap-only", "coalesce", "kept", "retired", "bare"]

        assert shown["snap-only"].question == "snapshot only"
        assert shown["snap-only"].rationale is None
        assert shown["snap-only"].document_id == "snap-doc"
        assert shown["snap-only"].answer_key_source is None
        assert shown["snap-only"].status is QuestionDraftStatus.APPROVED

        assert shown["coalesce"].question == "snapshot coalesce"
        assert shown["coalesce"].correct_answer == "B"
        assert shown["coalesce"].rationale is None
        assert shown["coalesce"].citation_page == 8
        assert shown["coalesce"].document_id == "doc"
        assert shown["coalesce"].answer_key_source == "pdf"

        assert shown["kept"].document_id == "kept-doc"
        assert shown["kept"].answer_key_source == "pdf"
        assert shown["kept"].question == "snapshot kept"

        assert shown["retired"].question == "draft retired"
        assert shown["retired"].rationale == "retired why"
        assert shown["retired"].status is QuestionDraftStatus.APPROVED
        assert shown["retired"].answer_key_source == "pdf"
        assert shown["bare"].question == "bare question"
        assert shown["bare"].rationale == ""

        asked = practice.question_for_answer(session, "coalesce")
        assert asked is not None
        assert asked.question == "snapshot coalesce"
        assert asked.document_id is None
        assert asked.answer_key_source is None
        assert asked.status is QuestionDraftStatus.APPROVED

        bare_asked = practice.question_for_answer(session, "bare")
        assert bare_asked is not None
        assert bare_asked.question == "bare question"
        assert bare_asked.rationale == ""
        assert bare_asked.status is QuestionDraftStatus.APPROVED
        outside = practice.question_for_answer(session, "outside")
        assert outside is not None and outside.is_playable()
        assert practice.question_for_answer(session, "unplayable-outside") is None

        history = practice.answer_history("proj")
        assert [item.attempt.id for item in history] == ["attempt-retired", "attempt-coalesce"]
        assert history[0].question.question == "draft retired"
        assert history[0].question.status is QuestionDraftStatus.APPROVED
        assert history[0].question.answer_key_source == "pdf"
        assert history[1].question.question == "snapshot coalesce"
        assert history[1].question.rationale is None
        assert history[1].question.document_id == "doc"
        assert history[1].question.correct_answer == "B"
        assert history[1].question.answer_key_source == "pdf"

        with pytest.raises(ValueError, match="retired"):
            practice.question_for_answer(session, "retired")
        with pytest.raises(ValueError, match="retired"):
            practice.current_question("proj", "retired")


def test_answer_history_since_is_the_latest_row_at_or_after_the_target(tmp_path: Path) -> None:
    database = _database(tmp_path)
    store = _store(database)
    with database.connect() as connection:
        _project(connection, "proj")
        _project(connection, "other")
        _document(connection, "proj", "doc")
        _draft(connection, draft_id="q", project_id="proj", document_id="doc", question="draft q")

    question = _shown("q", question="snapshot q", document_id="doc", rationale="why")
    with store.writing() as practice:
        # Only one active session per project; these two exist for their snapshots.
        for session_id in ("session-z", "session-a"):
            practice.add_session(
                PracticeSession(
                    id=session_id,
                    project_id="proj",
                    question_ids=("q",),
                    created_at="t0",
                    status="completed",
                    questions=(question,),
                )
            )
        practice.add_attempt(
            _attempt(
                "attempt-z",
                "q",
                session_id="session-z",
                selected_answer="A",
                created_at="t1",
            )
        )
        practice.add_attempt(
            _attempt(
                "attempt-a",
                "q",
                session_id="session-a",
                selected_answer="B",
                created_at="t1",
            )
        )
        since_earlier = practice.answer_history_since("proj", "attempt-z")
        assert [item.attempt.id for item in since_earlier] == ["attempt-a"]
        assert since_earlier[0].question.question == "snapshot q"
        assert since_earlier[0].question.answer_key_source == "manual"
        since_later = practice.answer_history_since("proj", "attempt-a")
        assert [item.attempt.id for item in since_later] == ["attempt-a"]
        assert practice.answer_history_since("proj", "missing") == []

    with database.connect() as connection:
        connection.execute(
            "DELETE FROM practice_session_questions WHERE session_id = 'session-a'"
        )
        connection.execute("UPDATE question_drafts SET project_id = 'other' WHERE id = 'q'")

    with store.reading() as practice:
        assert practice.answer_history_since("proj", "attempt-z") == []
        assert [item.attempt.id for item in practice.answer_history("proj")] == ["attempt-z"]


def test_practice_transaction_sees_uncommitted_projects_and_drafts(tmp_path: Path) -> None:
    database = _database(tmp_path)
    store = _store(database)
    with pytest.raises(_LeaveUncommitted):
        with store.writing() as practice:
            practice._connection.execute(
                """
                INSERT INTO projects(id, name, description, created_at, updated_at)
                VALUES ('new-project', 'New', '', 't0', 't0')
                """
            )
            _draft(
                practice._connection,
                draft_id="draft-new",
                project_id="new-project",
                document_id=None,
                question="uncommitted",
            )
            _document(practice._connection, "new-project", "doc-new")
            assert practice.project_exists("new-project") is True
            assert _ids(practice.approved_questions("new-project", document_id=None)) == [
                "draft-new",
            ]
            assert SqliteProjectRepository(database).get("new-project") is None
            assert SqliteQuestionDraftRepository(database).approved(
                "new-project", document_id=None
            ) == []
            with pytest.raises(NotFoundError, match="^Document not found.$"):
                store.require_document("new-project", "doc-new")
            raise _LeaveUncommitted()

    with store.reading() as practice:
        assert practice.project_exists("new-project") is False
        assert practice.approved_questions("new-project", document_id=None) == []


def test_require_document_accepts_a_committed_document_of_that_project(tmp_path: Path) -> None:
    database = _database(tmp_path)
    store = _store(database)
    with database.connect() as connection:
        _project(connection, "proj")
        _project(connection, "other")
        _document(connection, "proj", "doc")

    store.require_document("proj", "doc")
    for project_id, document_id in (("other", "doc"), ("proj", "missing"), ("missing", "doc")):
        with pytest.raises(NotFoundError, match="^Document not found.$"):
            store.require_document(project_id, document_id)


def _database(tmp_path: Path) -> Database:
    database = Database(Settings(data_dir=tmp_path, api_token="test-token"))
    database.migrate()
    return database


def _store(database: Database) -> SqlitePracticeStore:
    return SqlitePracticeStore(
        database,
        bind_reads=lambda connection: bind_practice_reads(database, connection),
        documents=practice_documents(database),
    )


def _project(connection: Connection, project_id: str) -> None:
    connection.execute(
        """
        INSERT INTO projects(id, name, description, created_at, updated_at)
        VALUES (?, 'Study', '', 't0', 't0')
        """,
        (project_id,),
    )


def _document(connection: Connection, project_id: str, document_id: str) -> None:
    connection.execute(
        """
        INSERT INTO documents(
            id, project_id, filename, sha256, storage_path,
            page_count, has_text, status, created_at, updated_at
        )
        VALUES (?, ?, 'notes.pdf', 'hash', 'notes.pdf', 1, 1, 'ready', 't0', 't0')
        """,
        (document_id, project_id),
    )


def _draft(
    connection: Connection,
    *,
    draft_id: str,
    project_id: str,
    document_id: str | None,
    status: str = "approved",
    source_order: int | None = None,
    citation_page: int | None = 1,
    created_at: str = "t0",
    question: str | None = None,
    rationale: str | None = "Because",
    answer_key_source: str = "manual",
) -> None:
    connection.execute(
        """
        INSERT INTO question_drafts(
            id, project_id, document_id, question, choices_json, answer,
            answer_key_source, rationale, citation_page, source_excerpt, status,
            source_order, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, '["A", "B"]', 'A', ?, ?, ?, 'excerpt', ?, ?, ?, ?)
        """,
        (
            draft_id,
            project_id,
            document_id,
            draft_id if question is None else question,
            answer_key_source,
            rationale,
            citation_page,
            status,
            source_order,
            created_at,
            created_at,
        ),
    )


def _shown(
    question_id: str,
    *,
    question: str | None = None,
    correct_answer: str = "A",
    rationale: str | None = "snapshot why",
    document_id: str | None = "snap-doc",
) -> PracticeQuestion:
    return PracticeQuestion(
        id=question_id,
        choices=("A", "B"),
        correct_answer=correct_answer,
        question=f"snapshot {question_id}" if question is None else question,
        rationale=rationale,
        citation_page=8,
        source_excerpt="snapshot excerpt",
        document_id=document_id,
    )


def _attempt(
    attempt_id: str,
    question_id: str,
    *,
    session_id: str = "session",
    selected_answer: str = "A",
    created_at: str,
) -> PracticeAttempt:
    return PracticeAttempt(
        id=attempt_id,
        session_id=session_id,
        project_id="proj",
        question_id=question_id,
        selected_answer=selected_answer,
        is_correct=selected_answer == "A",
        created_at=created_at,
    )


def _ids(questions: list[PracticeQuestion]) -> list[str]:
    return [question.id for question in questions]
