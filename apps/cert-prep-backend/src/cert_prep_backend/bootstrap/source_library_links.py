"""Source Library's needs from other contexts: whether a project exists, and discarding a
document's unfinished question jobs.

Source Library defines the ports. These adapters call the owning context's use cases. Stopping
or retrying a document's run discards its unfinished question jobs on the run's connection, so
the jobs go in the run's transaction (BEGIN IMMEDIATE), as the DELETE in Source Library's own
SQL used to.
"""

from __future__ import annotations

from sqlite3 import Connection

from cert_prep_backend.ai_providers.infrastructure.translation import (
    OllamaTraditionalChineseTranslator,
)
from cert_prep_backend.authoring.application import use_cases as authoring
from cert_prep_backend.authoring.application.ports import QuestionGenerationJobRepository
from cert_prep_backend.bootstrap.study_projects import ProjectExistence
from cert_prep_backend.platform.config import Settings
from cert_prep_backend.platform.database import Database
from cert_prep_backend.projects.infrastructure.repository import SqliteProjectRepository
from cert_prep_backend.source_library.application.ports import ChunkTranslator, DocumentQuestionJobs, StudyProjects
from cert_prep_backend.source_library.infrastructure.audio import DocumentChunkTranslator
from cert_prep_backend.source_library.infrastructure.operations import BindQuestionJobs
from cert_prep_backend.source_library.infrastructure.repository import (
    SqliteDocumentOperationRepository,
    SqliteDocumentRepository,
)


class QuestionJobsOfDocument:
    """Question Authoring's `discard_unfinished_generation_jobs`, for Source Library's
    `DocumentQuestionJobs` port."""

    def __init__(self, jobs: QuestionGenerationJobRepository) -> None:
        self._jobs = jobs

    def discard_unfinished(self, project_id: str, document_id: str) -> None:
        authoring.discard_unfinished_generation_jobs(self._jobs, project_id, document_id)


def bind_document_question_jobs(db: Database) -> BindQuestionJobs:
    """Question jobs on the connection of the document run that discards them."""

    def bind(connection: Connection) -> DocumentQuestionJobs:
        from cert_prep_backend.bootstrap.authoring_links import question_generation_job_repository

        return QuestionJobsOfDocument(question_generation_job_repository(db, connection))

    return bind


def source_library_projects(db: Database, connection: Connection | None = None) -> StudyProjects:
    return ProjectExistence(SqliteProjectRepository(db, connection))


def document_repository(db: Database, connection: Connection | None = None) -> SqliteDocumentRepository:
    """Source Library's documents; on `connection`, its reads and question count and status join that
    transaction."""

    return SqliteDocumentRepository(
        db, projects=source_library_projects(db, connection), connection=connection
    )


def document_operation_repository(db: Database) -> SqliteDocumentOperationRepository:
    return SqliteDocumentOperationRepository(
        db, projects=source_library_projects(db), question_jobs=bind_document_question_jobs(db)
    )


def chunk_translator(
    db: Database, settings: Settings, server: object | None = None
) -> ChunkTranslator:
    """Supply AI Providers text translation to Source Library; one client per request.

    ``server`` is the owned Ollama coordinator. Translation then counts as in
    flight and follows a CPU device choice. Callers that have no coordinator
    keep the previous client.
    """

    return DocumentChunkTranslator(
        db,
        translator=lambda: OllamaTraditionalChineseTranslator(settings, server=server),
        batch_translator=lambda: OllamaTraditionalChineseTranslator(
            settings, keep_alive="5m", server=server
        ),
    )
