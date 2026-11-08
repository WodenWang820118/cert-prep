"""Question Authoring's writes to Source Library: a document's count of drafts and its status.

Question Authoring defines the port. The adapter calls Source Library's use cases on the
connection that commits the drafts (BEGIN IMMEDIATE), so the document's exam state is
written in the same transaction as the drafts and the job or operation that wrote them, as
the UPDATE in Question Authoring's own SQL used to be.
"""

from __future__ import annotations

from sqlite3 import Connection

from cert_prep_backend.authoring.application.ports import DocumentExamState
from cert_prep_backend.authoring.infrastructure.repository import BindDocumentExamState
from cert_prep_backend.bootstrap.source_library_links import document_repository
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


def bind_document_exam_state(db: Database) -> BindDocumentExamState:
    """A document's exam state on the connection that commits its drafts."""

    def bind(connection: Connection) -> DocumentExamState:
        return SourceLibraryExamState(document_repository(db, connection))

    return bind
