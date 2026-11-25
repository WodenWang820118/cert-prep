"""Practice's reads of other contexts, bound to the caller's SQLite connection.

Practice defines the ports. These adapters call the owning context's use cases.
Passing the connection is the existing way to stay inside the caller's transaction
(`insert_processing_source`, `begin_capture_review_commit_in_connection`): practice's
BEGIN IMMEDIATE unit of work hands its connection in, and the read sees that transaction.
Source membership stays on its own connection, as the old `require_source` did.
"""

from __future__ import annotations

from collections.abc import Sequence
from sqlite3 import Connection

from cert_prep_backend.authoring.application import use_cases as authoring
from cert_prep_backend.authoring.application.ports import QuestionRepository
from cert_prep_backend.authoring.domain.question import Question
from cert_prep_backend.bootstrap.authoring_links import question_repository
from cert_prep_backend.bootstrap.source_library_links import source_repository
from cert_prep_backend.bootstrap.study_projects import ProjectExistence
from cert_prep_backend.platform.database import Database
from cert_prep_backend.practice.application.ports import (
    PracticeSourceQuestion,
    PracticeQuestions,
    ProjectSources,
    StudyProjects,
)
from cert_prep_backend.projects.infrastructure.repository import SqliteProjectRepository
from cert_prep_backend.source_library.application import use_cases as source_library
from cert_prep_backend.source_library.application.ports import SourceRepository


class SourceMembership:
    """Source Library's `view_source`: the source belongs to the project, or NotFoundError."""

    def __init__(self, sources: SourceRepository) -> None:
        self._sources = sources

    def require(self, project_id: str, source_id: str) -> None:
        source_library.view_source(self._sources, project_id, source_id)


class AuthoringPracticeQuestions:
    """Question Authoring's question reads, as the questions practice asks about."""

    def __init__(self, questions: QuestionRepository) -> None:
        self._questions = questions

    def for_source(self, project_id: str, *, source_id: str | None) -> list[PracticeSourceQuestion]:
        return [
            _practice_source_question(authored_question)
            for authored_question in authoring.source_questions(
                self._questions, project_id, source_id=source_id
            )
        ]

    def current(self, project_id: str, question_id: str) -> PracticeSourceQuestion | None:
        authored_question = authoring.find_question(self._questions, project_id, question_id)
        return None if authored_question is None else _practice_source_question(authored_question)

    def current_many(self, project_id: str, question_ids: Sequence[str]) -> list[PracticeSourceQuestion]:
        return [
            _practice_source_question(authored_question)
            for authored_question in authoring.questions_for(self._questions, project_id, question_ids)
        ]


def bind_practice_reads(
    db: Database, connection: Connection
) -> tuple[StudyProjects, PracticeQuestions]:
    """Project and question reads on `connection`, so they share practice's transaction."""

    return (
        ProjectExistence(SqliteProjectRepository(db, connection)),
        AuthoringPracticeQuestions(question_repository(db, connection)),
    )


def practice_sources(db: Database) -> ProjectSources:
    """Source membership on its own connection."""

    return SourceMembership(source_repository(db))


def _practice_source_question(authored_question: Question) -> PracticeSourceQuestion:
    answer_key_source = authored_question.answer_key_source
    if not isinstance(answer_key_source, str):
        answer_key_source = None
    return PracticeSourceQuestion(
        id=authored_question.id,
        choices=tuple(authored_question.choices),
        correct_answer=authored_question.answer,
        question=authored_question.question,
        rationale=authored_question.rationale,
        citation_page=authored_question.citation_page,
        source_excerpt=authored_question.source_excerpt,
        source_id=authored_question.source_id,
        answer_key_source=answer_key_source,
    )
