from __future__ import annotations

from sqlite3 import Connection

from cert_prep_contracts.sources import SourceKind

from cert_prep_backend.platform.database import Database
from cert_prep_backend.platform.errors import NotFoundError
from cert_prep_backend.source_library.application.ports import StudyProjects
from cert_prep_backend.source_library.domain.source import (
    SourceChunk,
    Source,
    SourceFile,
)
from cert_prep_backend.source_library.domain.operation import SourceOperation
from cert_prep_backend.source_library.infrastructure import operations
from cert_prep_backend.source_library.infrastructure.chunks import (
    get_chunk,
    get_source_chunks,
    list_chunks,
    update_chunk_text,
    update_chunk_translation,
)
from cert_prep_backend.source_library.infrastructure.sources import (
    get_source,
    get_source_file,
    list_sources,
    set_authored_question_count,
    set_question_count,
)
from cert_prep_backend.source_library.infrastructure.progress import (
    recover_processing_sources,
)
from cert_prep_backend.source_library.infrastructure.records import (
    source_from_row,
    source_query,
    ensure_source_exists,
    ensure_project_exists,
)


class SqliteSourceRepository:
    """Persist sources and their chunks."""

    def __init__(
        self, db: Database, *, projects: StudyProjects, connection: Connection | None = None
    ) -> None:
        # A caller's connection joins that transaction for `source`, `record_question_count`
        # and `record_authored_question_count`. Question Authoring passes the connection that
        # commits its questions, so the source's question count and status is written with them.
        self._db = db
        self._projects = projects
        self._connection = connection

    def sources_of(self, project_id: str) -> list[Source]:
        ensure_project_exists(self._projects, project_id)
        return list_sources(self._db, project_id)

    def source(self, project_id: str, source_id: str) -> Source:
        if self._connection is None:
            return get_source(self._db, project_id, source_id)
        row = source_query(self._connection, project_id, source_id)
        if row is None:
            raise NotFoundError("Document not found.")
        return source_from_row(row)

    def record_question_count(
        self, project_id: str, source_id: str, *, status: str, question_count: int
    ) -> None:
        if self._connection is None:
            raise RuntimeError("The question count joins the transaction that stores the questions.")
        set_question_count(
            self._connection,
            project_id=project_id,
            source_id=source_id,
            status=status,
            question_count=question_count,
        )

    def record_authored_question_count(
        self, project_id: str, source_id: str, *, question_count: int
    ) -> None:
        """Store the count only; status, failure message and `updated_at` stay."""

        if self._connection is None:
            raise RuntimeError("The question count joins the transaction that stores the question.")
        set_authored_question_count(
            self._connection,
            project_id=project_id,
            source_id=source_id,
            question_count=question_count,
        )

    def source_file(self, project_id: str, source_id: str) -> SourceFile:
        return get_source_file(self._db, project_id, source_id)

    def chunks_of(self, project_id: str, source_id: str) -> list[SourceChunk]:
        return list_chunks(self._db, project_id, source_id)

    def chunk(self, project_id: str, source_id: str, chunk_id: str) -> SourceChunk:
        return get_chunk(self._db, project_id, source_id, chunk_id)

    def edit_chunk_text(
        self, project_id: str, source_id: str, chunk_id: str, text: str
    ) -> SourceChunk:
        return update_chunk_text(self._db, project_id, source_id, chunk_id, text)

    def recover_processing(self) -> int:
        return recover_processing_sources(self._db)

    def attach_source(
        self,
        project_id: str,
        operation_id: str,
        *,
        filename: str,
        sha256: str,
        language_hint: str,
        storage_path: str,
        page_count: int,
        source_kind: SourceKind,
        duration_ms: int | None = None,
    ) -> Source:
        ensure_project_exists(self._projects, project_id)
        return operations.create_and_attach_source(
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


class SqliteSourceOperationRepository:
    """Source operations. Each transition is one transaction that stores what the
    SourceOperation decided, guarded by the state it decided from."""

    def __init__(
        self,
        db: Database,
        *,
        projects: StudyProjects,
        question_jobs: operations.BindQuestionJobs,
    ) -> None:
        self._db = db
        self._projects = projects
        # Stopping or retrying a run discards the source's unfinished question jobs on the
        # run's connection, so they go in the same transaction.
        self._question_jobs = question_jobs

    def operation(self, project_id: str, operation_id: str) -> SourceOperation:
        return operations.get_operation(self._db, project_id=project_id, operation_id=operation_id)

    def active_operation_of(self, project_id: str, source_id: str) -> SourceOperation | None:
        return operations.get_active_operation_for_source(
            self._db, project_id=project_id, source_id=source_id
        )

    def claim(self, project_id: str, operation_id: str) -> tuple[SourceOperation, bool]:
        ensure_project_exists(self._projects, project_id)
        claim = operations.claim_operation(
            self._db, project_id=project_id, operation_id=operation_id
        )
        return claim.operation, claim.acquired

    def claim_upload(self, project_id: str, operation_id: str) -> bool:
        return self.claim(project_id, operation_id)[1]

    def start_retry(
        self, project_id: str, source_id: str, operation_id: str
    ) -> SourceOperation:
        ensure_project_exists(self._projects, project_id)
        return operations.start_retry_operation(
            self._db,
            project_id=project_id,
            source_id=source_id,
            question_jobs=self._question_jobs,
            operation_id=operation_id,
        )

    def fail(
        self,
        project_id: str,
        operation_id: str,
        *,
        error: str,
        source_status: str | None = None,
        extraction_method: str | None = None,
    ) -> SourceOperation:
        return operations.finish_failed(
            self._db,
            project_id=project_id,
            operation_id=operation_id,
            error=error,
            question_jobs=self._question_jobs,
            source_status=source_status,
            extraction_method=extraction_method,
        )

    def cancel(self, project_id: str, operation_id: str) -> SourceOperation:
        ensure_project_exists(self._projects, project_id)
        return operations.cancel_operation(
            self._db, project_id=project_id, operation_id=operation_id
        )

    def acknowledge_cancellation(
        self, project_id: str, operation_id: str
    ) -> SourceOperation:
        return operations.acknowledge_cancellation(
            self._db,
            project_id=project_id,
            operation_id=operation_id,
            question_jobs=self._question_jobs,
        )

    def cancel_processing_of(self, project_id: str, source_id: str) -> SourceOperation:
        ensure_project_exists(self._projects, project_id)
        return operations.cancel_source_processing(
            self._db, project_id=project_id, source_id=source_id
        )

    def recover_interrupted(self) -> int:
        return operations.recover_operations(self._db, question_jobs=self._question_jobs)


__all__ = [
    "SqliteSourceOperationRepository",
    "SqliteSourceRepository",
    "ensure_source_exists",
    "get_chunk",
    "get_source",
    "get_source_file",
    "get_source_chunks",
    "list_chunks",
    "list_sources",
    "recover_processing_sources",
    "update_chunk_translation",
]
