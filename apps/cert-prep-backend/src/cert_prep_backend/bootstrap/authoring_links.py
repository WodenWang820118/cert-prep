"""Question Authoring's writes to Source Library: a source's count of questions and its status.

Question Authoring defines the port. The adapter calls Source Library's use cases on the
connection that commits the questions (BEGIN IMMEDIATE), so the source's question count and status is
written in the same transaction as the questions and the job or operation that wrote them, as
the UPDATE in Question Authoring's own SQL used to be.
"""

from __future__ import annotations

from sqlite3 import Connection

from cert_prep_backend.authoring.application.ports import (
    SourceQuestionCount,
    ProjectSources,
)
from cert_prep_backend.authoring.infrastructure.question_generation_jobs import SqliteQuestionGenerationJobRepository
from cert_prep_backend.authoring.infrastructure.repository import (
    BindSourceQuestionCount,
    SqliteQuestionRepository,
)
from cert_prep_backend.authoring.infrastructure.sources import SourceLibraryQuestionSources
from cert_prep_backend.bootstrap.source_library_links import source_repository
from cert_prep_backend.bootstrap.study_projects import authoring_projects
from cert_prep_backend.platform.database import Database
from cert_prep_backend.source_library.application import use_cases as source_library
from cert_prep_backend.source_library.application.ports import SourceRepository


class SourceLibraryQuestionCount:
    """Source Library's `record_question_count` and `record_import_question_count`, for Question
    Authoring's `SourceQuestionCount` port."""

    def __init__(self, sources: SourceRepository) -> None:
        self._sources = sources

    def record_question_count(self, project_id: str, source_id: str, count: int) -> None:
        source_library.record_question_count(self._sources, project_id, source_id, count)

    def record_import_question_count(self, project_id: str, source_id: str, count: int) -> None:
        source_library.record_import_question_count(
            self._sources, project_id, source_id, count
        )


class SourceMembership:
    """Source Library's `view_source`: the source belongs to the project, or NotFoundError."""

    def __init__(self, sources: SourceRepository) -> None:
        self._sources = sources

    def require(self, project_id: str, source_id: str) -> None:
        source_library.view_source(self._sources, project_id, source_id)


def bind_source_question_count(db: Database) -> BindSourceQuestionCount:
    """A source's question count and status on the connection that commits its questions."""

    def bind(connection: Connection) -> SourceQuestionCount:
        return SourceLibraryQuestionCount(source_repository(db, connection))

    return bind


def authoring_sources(
    db: Database, connection: Connection | None = None
) -> ProjectSources:
    return SourceMembership(source_repository(db, connection))


def question_repository(
    db: Database, connection: Connection | None = None
) -> SqliteQuestionRepository:
    repository = source_repository(db, connection)
    return SqliteQuestionRepository(
        db,
        connection,
        projects=authoring_projects(db, connection),
        sources=SourceLibraryQuestionSources(repository),
    )


def question_generation_job_repository(
    db: Database, connection: Connection | None = None
) -> SqliteQuestionGenerationJobRepository:
    return SqliteQuestionGenerationJobRepository(
        db,
        connection,
        sources=authoring_sources(db, connection),
    )
