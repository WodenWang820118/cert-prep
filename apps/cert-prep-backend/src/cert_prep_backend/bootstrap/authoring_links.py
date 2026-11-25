"""Question Authoring's writes to Source Library: a document's count of questions and its status.

Question Authoring defines the port. The adapter calls Source Library's use cases on the
connection that commits the questions (BEGIN IMMEDIATE), so the document's question count and status is
written in the same transaction as the questions and the job or operation that wrote them, as
the UPDATE in Question Authoring's own SQL used to be.
"""

from __future__ import annotations

from sqlite3 import Connection

from cert_prep_backend.authoring.application.ports import (
    DocumentQuestionCount,
    ProjectDocuments,
)
from cert_prep_backend.authoring.infrastructure.question_generation_jobs import SqliteQuestionGenerationJobRepository
from cert_prep_backend.authoring.infrastructure.repository import (
    BindDocumentQuestionCount,
    SqliteQuestionRepository,
)
from cert_prep_backend.authoring.infrastructure.sources import SourceLibraryQuestionSources
from cert_prep_backend.bootstrap.source_library_links import document_repository
from cert_prep_backend.bootstrap.study_projects import authoring_projects
from cert_prep_backend.platform.database import Database
from cert_prep_backend.source_library.application import use_cases as source_library
from cert_prep_backend.source_library.application.ports import DocumentRepository


class SourceLibraryQuestionCount:
    """Source Library's `record_question_count` and `record_import_question_count`, for Question
    Authoring's `DocumentQuestionCount` port."""

    def __init__(self, documents: DocumentRepository) -> None:
        self._documents = documents

    def record_question_count(self, project_id: str, document_id: str, count: int) -> None:
        source_library.record_question_count(self._documents, project_id, document_id, count)

    def record_import_question_count(self, project_id: str, document_id: str, count: int) -> None:
        source_library.record_import_question_count(
            self._documents, project_id, document_id, count
        )


class DocumentMembership:
    """Source Library's `view_document`: the document belongs to the project, or NotFoundError."""

    def __init__(self, documents: DocumentRepository) -> None:
        self._documents = documents

    def require(self, project_id: str, document_id: str) -> None:
        source_library.view_document(self._documents, project_id, document_id)


def bind_document_question_count(db: Database) -> BindDocumentQuestionCount:
    """A document's question count and status on the connection that commits its questions."""

    def bind(connection: Connection) -> DocumentQuestionCount:
        return SourceLibraryQuestionCount(document_repository(db, connection))

    return bind


def authoring_documents(
    db: Database, connection: Connection | None = None
) -> ProjectDocuments:
    return DocumentMembership(document_repository(db, connection))


def question_repository(
    db: Database, connection: Connection | None = None
) -> SqliteQuestionRepository:
    docs = document_repository(db, connection)
    return SqliteQuestionRepository(
        db,
        connection,
        projects=authoring_projects(db, connection),
        sources=SourceLibraryQuestionSources(docs),
    )


def question_generation_job_repository(
    db: Database, connection: Connection | None = None
) -> SqliteQuestionGenerationJobRepository:
    return SqliteQuestionGenerationJobRepository(
        db,
        connection,
        documents=authoring_documents(db, connection),
    )
