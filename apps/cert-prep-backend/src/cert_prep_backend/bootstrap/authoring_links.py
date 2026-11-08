"""Question Authoring's writes to Source Library: a document's count of drafts and its status.

Question Authoring defines the port. The adapter calls Source Library's use cases on the
connection that commits the drafts (BEGIN IMMEDIATE), so the document's exam state is
written in the same transaction as the drafts and the job or operation that wrote them, as
the UPDATE in Question Authoring's own SQL used to be.
"""

from __future__ import annotations

from sqlite3 import Connection

from cert_prep_backend.authoring.application.ports import (
    DocumentExamState,
    ProjectDocuments,
)
from cert_prep_backend.authoring.infrastructure.draft_jobs import SqliteDraftGenerationJobRepository
from cert_prep_backend.authoring.infrastructure.repository import (
    BindDocumentExamState,
    SqliteQuestionDraftRepository,
)
from cert_prep_backend.authoring.infrastructure.sources import SourceLibraryDraftSources
from cert_prep_backend.bootstrap.source_library_links import document_repository
from cert_prep_backend.bootstrap.study_projects import authoring_projects
from cert_prep_backend.platform.database import Database
from cert_prep_backend.source_library.application import use_cases as source_library
from cert_prep_backend.source_library.application.ports import DocumentRepository


class SourceLibraryExamState:
    """Source Library's `record_draft_count` and `record_import_draft_count`, for Question
    Authoring's `DocumentExamState` port."""

    def __init__(self, documents: DocumentRepository) -> None:
        self._documents = documents

    def record_draft_count(self, project_id: str, document_id: str, count: int) -> None:
        source_library.record_draft_count(self._documents, project_id, document_id, count)

    def record_import_draft_count(self, project_id: str, document_id: str, count: int) -> None:
        source_library.record_import_draft_count(
            self._documents, project_id, document_id, count
        )


class DocumentMembership:
    """Source Library's `view_document`: the document belongs to the project, or NotFoundError."""

    def __init__(self, documents: DocumentRepository) -> None:
        self._documents = documents

    def require(self, project_id: str, document_id: str) -> None:
        source_library.view_document(self._documents, project_id, document_id)


def bind_document_exam_state(db: Database) -> BindDocumentExamState:
    """A document's exam state on the connection that commits its drafts."""

    def bind(connection: Connection) -> DocumentExamState:
        return SourceLibraryExamState(document_repository(db, connection))

    return bind


def authoring_documents(
    db: Database, connection: Connection | None = None
) -> ProjectDocuments:
    return DocumentMembership(document_repository(db, connection))


def question_draft_repository(
    db: Database, connection: Connection | None = None
) -> SqliteQuestionDraftRepository:
    docs = document_repository(db, connection)
    return SqliteQuestionDraftRepository(
        db,
        connection,
        projects=authoring_projects(db, connection),
        sources=SourceLibraryDraftSources(docs),
    )


def draft_generation_job_repository(
    db: Database, connection: Connection | None = None
) -> SqliteDraftGenerationJobRepository:
    return SqliteDraftGenerationJobRepository(
        db,
        connection,
        documents=authoring_documents(db, connection),
    )
