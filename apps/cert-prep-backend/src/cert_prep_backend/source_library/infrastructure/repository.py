from __future__ import annotations

from sqlite3 import Connection

from cert_prep_backend.platform.database import Database
from cert_prep_backend.platform.errors import NotFoundError
from cert_prep_backend.source_library.application.ports import StudyProjects
from cert_prep_backend.source_library.domain.document import (
    DocumentChunk,
    SourceDocument,
    SourceFile,
)
from cert_prep_backend.source_library.domain.operation import DocumentOperation
from cert_prep_backend.source_library.infrastructure import operations
from cert_prep_backend.source_library.infrastructure.chunks import (
    get_chunk,
    get_source_chunks,
    list_chunks,
    update_chunk_text,
    update_chunk_translation,
)
from cert_prep_backend.source_library.infrastructure.documents import (
    get_document,
    get_source_file,
    list_documents,
    set_exam_state,
    update_exam_state,
)
from cert_prep_backend.source_library.infrastructure.progress import (
    record_extraction_progress,
    recover_processing_documents,
)
from cert_prep_backend.source_library.infrastructure.records import (
    document_from_row,
    document_query,
    ensure_document_exists,
    ensure_project_exists,
)


class SqliteDocumentRepository:
    """Source documents and their chunks."""

    def __init__(
        self, db: Database, *, projects: StudyProjects, connection: Connection | None = None
    ) -> None:
        # A caller's connection joins that transaction for `document` and `record_exam_state`.
        # Question Authoring passes the connection that commits its drafts, so the document's
        # exam state is written with them.
        self._db = db
        self._projects = projects
        self._connection = connection

    def documents_of(self, project_id: str) -> list[SourceDocument]:
        ensure_project_exists(self._projects, project_id)
        return list_documents(self._db, project_id)

    def document(self, project_id: str, document_id: str) -> SourceDocument:
        if self._connection is None:
            return get_document(self._db, project_id, document_id)
        row = document_query(self._connection, project_id, document_id)
        if row is None:
            raise NotFoundError("Document not found.")
        return document_from_row(row)

    def record_exam_state(
        self, project_id: str, document_id: str, *, status: str, exam_item_count: int
    ) -> None:
        if self._connection is not None:
            set_exam_state(
                self._connection,
                project_id=project_id,
                document_id=document_id,
                status=status,
                exam_item_count=exam_item_count,
            )
            return
        update_exam_state(
            self._db,
            project_id=project_id,
            document_id=document_id,
            status=status,
            exam_item_count=exam_item_count,
        )

    def source_file(self, project_id: str, document_id: str) -> SourceFile:
        return get_source_file(self._db, project_id, document_id)

    def chunks_of(self, project_id: str, document_id: str) -> list[DocumentChunk]:
        return list_chunks(self._db, project_id, document_id)

    def chunk(self, project_id: str, document_id: str, chunk_id: str) -> DocumentChunk:
        return get_chunk(self._db, project_id, document_id, chunk_id)

    def edit_chunk_text(
        self, project_id: str, document_id: str, chunk_id: str, text: str
    ) -> DocumentChunk:
        return update_chunk_text(self._db, project_id, document_id, chunk_id, text)

    def recover_processing(self) -> int:
        return recover_processing_documents(self._db)

    def attach_document(
        self,
        project_id: str,
        operation_id: str,
        *,
        filename: str,
        sha256: str,
        language_hint: str,
        storage_path: str,
        page_count: int,
        source_kind: str = "document",
        duration_ms: int | None = None,
    ) -> SourceDocument:
        ensure_project_exists(self._projects, project_id)
        return operations.create_and_attach_document(
            self._db,
            project_id=project_id,
            operation_id=operation_id,
            filename=filename,
            sha256=sha256,
            language_hint=language_hint,
            storage_path=storage_path,
            page_count=page_count,
            source_kind=source_kind,
            duration_ms=duration_ms,
        )


class SqliteDocumentOperationRepository:
    """Document operations. Each transition is one transaction that stores what the
    DocumentOperation decided, guarded by the state it decided from."""

    def __init__(
        self,
        db: Database,
        *,
        projects: StudyProjects,
        draft_jobs: operations.BindDraftJobs,
    ) -> None:
        self._db = db
        self._projects = projects
        # Stopping or retrying a run discards the document's unfinished draft jobs on the
        # run's connection, so they go in the same transaction.
        self._draft_jobs = draft_jobs

    def operation(self, project_id: str, operation_id: str) -> DocumentOperation:
        return operations.get_operation(self._db, project_id=project_id, operation_id=operation_id)

    def active_operation_of(self, project_id: str, document_id: str) -> DocumentOperation | None:
        return operations.get_active_operation_for_document(
            self._db, project_id=project_id, document_id=document_id
        )

    def claim(self, project_id: str, operation_id: str) -> tuple[DocumentOperation, bool]:
        ensure_project_exists(self._projects, project_id)
        claim = operations.claim_operation(
            self._db, project_id=project_id, operation_id=operation_id
        )
        return claim.operation, claim.acquired

    def claim_upload(self, project_id: str, operation_id: str) -> bool:
        return self.claim(project_id, operation_id)[1]

    def start_retry(
        self, project_id: str, document_id: str, operation_id: str
    ) -> DocumentOperation:
        ensure_project_exists(self._projects, project_id)
        return operations.start_retry_operation(
            self._db,
            project_id=project_id,
            document_id=document_id,
            draft_jobs=self._draft_jobs,
            operation_id=operation_id,
        )

    def fail(
        self,
        project_id: str,
        operation_id: str,
        *,
        error: str,
        document_status: str | None = None,
        extraction_method: str | None = None,
    ) -> DocumentOperation:
        return operations.finish_failed(
            self._db,
            project_id=project_id,
            operation_id=operation_id,
            error=error,
            draft_jobs=self._draft_jobs,
            document_status=document_status,
            extraction_method=extraction_method,
        )

    def cancel(self, project_id: str, operation_id: str) -> DocumentOperation:
        ensure_project_exists(self._projects, project_id)
        return operations.cancel_operation(
            self._db, project_id=project_id, operation_id=operation_id
        )

    def acknowledge_cancellation(
        self, project_id: str, operation_id: str
    ) -> DocumentOperation:
        return operations.acknowledge_cancellation(
            self._db,
            project_id=project_id,
            operation_id=operation_id,
            draft_jobs=self._draft_jobs,
        )

    def cancel_processing_of(self, project_id: str, document_id: str) -> DocumentOperation:
        ensure_project_exists(self._projects, project_id)
        return operations.cancel_document_processing(
            self._db, project_id=project_id, document_id=document_id
        )

    def recover_interrupted(self) -> int:
        return operations.recover_operations(self._db, draft_jobs=self._draft_jobs)


__all__ = [
    "SqliteDocumentOperationRepository",
    "SqliteDocumentRepository",
    "ensure_document_exists",
    "get_chunk",
    "get_document",
    "get_source_file",
    "get_source_chunks",
    "list_chunks",
    "list_documents",
    "record_extraction_progress",
    "recover_processing_documents",
    "update_exam_state",
    "update_chunk_translation",
]
