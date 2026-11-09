"""Source Library's needs from other contexts: whether a project exists, and discarding a
document's unfinished draft jobs.

Source Library defines the ports. These adapters call the owning context's use cases. Stopping
or retrying a document's run discards its unfinished draft jobs on the run's connection, so
the jobs go in the run's transaction (BEGIN IMMEDIATE), as the DELETE in Source Library's own
SQL used to.
"""

from __future__ import annotations

from sqlite3 import Connection

from cert_prep_backend.ai_providers.infrastructure.translation import (
    OllamaTraditionalChineseTranslator,
)
from cert_prep_backend.authoring.application import use_cases as authoring
from cert_prep_backend.authoring.application.ports import DraftGenerationJobRepository
from cert_prep_backend.bootstrap.study_projects import ProjectExistence
from cert_prep_backend.platform.config import Settings
from cert_prep_backend.platform.database import Database
from cert_prep_backend.projects.infrastructure.repository import SqliteProjectRepository
from cert_prep_backend.source_library.application.ports import ChunkTranslator, DocumentDraftJobs, StudyProjects
from cert_prep_backend.source_library.infrastructure.audio import DocumentChunkTranslator
from cert_prep_backend.source_library.infrastructure.operations import BindDraftJobs
from cert_prep_backend.source_library.infrastructure.repository import (
    SqliteDocumentOperationRepository,
    SqliteDocumentRepository,
)


class DraftJobsOfDocument:
    """Question Authoring's `discard_unfinished_generation_jobs`, for Source Library's
    `DocumentDraftJobs` port."""

    def __init__(self, jobs: DraftGenerationJobRepository) -> None:
        self._jobs = jobs

    def discard_unfinished(self, project_id: str, document_id: str) -> None:
        authoring.discard_unfinished_generation_jobs(self._jobs, project_id, document_id)


def bind_document_draft_jobs(db: Database) -> BindDraftJobs:
    """Draft jobs on the connection of the document run that discards them."""

    def bind(connection: Connection) -> DocumentDraftJobs:
        from cert_prep_backend.bootstrap.authoring_links import draft_generation_job_repository

        return DraftJobsOfDocument(draft_generation_job_repository(db, connection))

    return bind


def source_library_projects(db: Database, connection: Connection | None = None) -> StudyProjects:
    return ProjectExistence(SqliteProjectRepository(db, connection))


def document_repository(db: Database, connection: Connection | None = None) -> SqliteDocumentRepository:
    """Source Library's documents; on `connection`, its reads and exam state join that
    transaction."""

    return SqliteDocumentRepository(
        db, projects=source_library_projects(db, connection), connection=connection
    )


def document_operation_repository(db: Database) -> SqliteDocumentOperationRepository:
    return SqliteDocumentOperationRepository(
        db, projects=source_library_projects(db), draft_jobs=bind_document_draft_jobs(db)
    )


def chunk_translator(db: Database, settings: Settings) -> ChunkTranslator:
    """Supply AI Providers text translation to Source Library; one client per request."""

    return DocumentChunkTranslator(
        db,
        translator=lambda: OllamaTraditionalChineseTranslator(settings),
        batch_translator=lambda: OllamaTraditionalChineseTranslator(settings, keep_alive="5m"),
    )
