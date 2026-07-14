from __future__ import annotations

from dataclasses import dataclass
from sqlite3 import Connection, Row
from typing import Final
from uuid import uuid4

from cert_prep_backend.core.exceptions import (
    DocumentOperationConflictError,
    DocumentOperationStateError,
    DocumentProcessingCanceledError,
    NotFoundError,
    OperationNotCancellableError,
)
from cert_prep_backend.domains.projects.repository import ensure_project_exists
from cert_prep_backend.domains.source_documents.documents import (
    insert_processing_document,
)
from cert_prep_backend.domains.source_documents.models import PdfExtractionResult
from cert_prep_backend.domains.source_documents.progress import (
    complete_document_extraction_in_transaction,
)
from cert_prep_backend.domains.source_documents.records import (
    document_from_row,
    document_query,
)
from cert_prep_backend.persistence.database import Database, utc_now


TERMINAL_STATUSES: Final[frozenset[str]] = frozenset(
    {"canceled", "succeeded", "failed"}
)
RETRYABLE_DOCUMENT_STATUSES: Final[frozenset[str]] = frozenset(
    {"canceled", "ocr_failed", "no_text_detected"}
)


@dataclass(frozen=True, slots=True)
class DocumentOperationClaim:
    operation: dict
    acquired: bool


def claim_operation(
    db: Database,
    *,
    project_id: str,
    operation_id: str,
) -> DocumentOperationClaim:
    """Atomically claim a global upload operation id."""

    ensure_project_exists(db, project_id)
    now = utc_now()
    with db.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        inserted = connection.execute(
            """
            INSERT INTO document_operations(
                id, project_id, document_id, status, phase, cancellable,
                error, created_at, updated_at
            )
            VALUES (?, ?, NULL, 'queued', 'uploading', 1, NULL, ?, ?)
            ON CONFLICT(id) DO NOTHING
            """,
            (operation_id, project_id, now, now),
        )
        row = _operation_query_by_id(connection, operation_id)
        operation = _required_operation(row)
        _assert_operation_project(operation, project_id)
    return DocumentOperationClaim(
        operation=operation,
        acquired=inserted.rowcount == 1,
    )


def cancel_operation(
    db: Database,
    *,
    project_id: str,
    operation_id: str,
) -> dict:
    """Create a cancel tombstone or atomically request active-work cancellation."""

    ensure_project_exists(db, project_id)
    now = utc_now()
    with db.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = _operation_query_by_id(connection, operation_id)
        if row is None:
            connection.execute(
                """
                INSERT INTO document_operations(
                    id, project_id, document_id, status, phase, cancellable,
                    error, created_at, updated_at
                )
                VALUES (?, ?, NULL, 'canceled', 'canceled', 0, NULL, ?, ?)
                """,
                (operation_id, project_id, now, now),
            )
            return _required_operation(_operation_query_by_id(connection, operation_id))
        return _cancel_existing_operation(
            connection,
            operation=_operation_from_row(row),
            project_id=project_id,
            now=now,
        )


def cancel_document_processing(
    db: Database,
    *,
    project_id: str,
    document_id: str,
) -> dict:
    """Cancel the operation owning a document without a lookup/cancel race."""

    ensure_project_exists(db, project_id)
    now = utc_now()
    with db.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        document = connection.execute(
            "SELECT status FROM documents WHERE project_id = ? AND id = ?",
            (project_id, document_id),
        ).fetchone()
        if document is None:
            raise NotFoundError("Document not found.")
        row = connection.execute(
            """
            SELECT *
            FROM document_operations
            WHERE project_id = ? AND document_id = ?
                AND status IN ('queued', 'running', 'cancel_requested')
            LIMIT 1
            """,
            (project_id, document_id),
        ).fetchone()
        if row is not None:
            return _cancel_existing_operation(
                connection,
                operation=_operation_from_row(row),
                project_id=project_id,
                now=now,
            )
        if document["status"] == "canceled":
            canceled = connection.execute(
                """
                SELECT *
                FROM document_operations
                WHERE project_id = ? AND document_id = ? AND status = 'canceled'
                ORDER BY updated_at DESC, created_at DESC, id DESC
                LIMIT 1
                """,
                (project_id, document_id),
            ).fetchone()
            if canceled is not None:
                return _operation_from_row(canceled)
            raise DocumentOperationStateError(
                "Canceled document has no owning document operation."
            )
        if document["status"] in {"processing", "cancel_requested"}:
            raise DocumentOperationStateError(
                "Processing document has no active document operation."
            )
        raise OperationNotCancellableError(
            "Document does not have active extraction to cancel."
        )


def create_and_attach_document(
    db: Database,
    *,
    project_id: str,
    operation_id: str,
    filename: str,
    sha256: str,
    language_hint: str,
    storage_path: str,
    page_count: int,
    document_id: str | None = None,
) -> dict:
    """Insert a document and attach it to the sole operation claimant atomically."""

    ensure_project_exists(db, project_id)
    now = utc_now()
    next_document_id = document_id or str(uuid4())
    with db.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        operation = _required_operation(_operation_query_by_id(connection, operation_id))
        _assert_operation_project(operation, project_id)
        if operation["status"] in {"cancel_requested", "canceled"}:
            raise DocumentProcessingCanceledError("Document upload was canceled.")
        if not (
            operation["status"] == "queued"
            and operation["phase"] == "uploading"
            and operation["cancellable"]
            and operation["document_id"] is None
        ):
            raise DocumentOperationStateError(
                "Document operation was not exclusively claimed for upload."
            )
        document = insert_processing_document(
            connection,
            document_id=next_document_id,
            project_id=project_id,
            filename=filename,
            sha256=sha256,
            language_hint=language_hint,
            storage_path=storage_path,
            page_count=page_count,
            now=now,
        )
        attached = connection.execute(
            """
            UPDATE document_operations
            SET document_id = ?, status = 'running', phase = 'processing',
                cancellable = 1, updated_at = ?
            WHERE id = ? AND project_id = ? AND status = 'queued'
                AND phase = 'uploading' AND cancellable = 1
                AND document_id IS NULL
            """,
            (next_document_id, now, operation_id, project_id),
        )
        if attached.rowcount != 1:
            raise DocumentOperationStateError(
                "Document operation could not attach its processing document."
            )
    return document


def _begin_commit(
    connection: Connection,
    *,
    project_id: str,
    operation_id: str,
    document_id: str,
    now: str,
) -> None:
    """Win cancel-vs-complete inside the caller's uncommitted publication transaction."""

    operation = _required_operation(_operation_query_by_id(connection, operation_id))
    _assert_operation_project(operation, project_id)
    if operation["document_id"] != document_id:
        raise DocumentOperationStateError(
            "Document operation does not own the publication document."
        )
    if operation["status"] in {"cancel_requested", "canceled"}:
        raise DocumentProcessingCanceledError("Document processing was canceled.")
    updated = connection.execute(
        """
        UPDATE document_operations
        SET phase = 'committing', cancellable = 0, updated_at = ?
        WHERE id = ? AND project_id = ? AND document_id = ?
            AND status = 'running' AND phase = 'processing' AND cancellable = 1
        """,
        (now, operation_id, project_id, document_id),
    )
    if updated.rowcount != 1:
        raise DocumentOperationStateError(
            "Document operation was not in its cancellable processing phase."
        )


def publish_success(
    db: Database,
    *,
    project_id: str,
    operation_id: str,
    document_id: str,
    extraction: PdfExtractionResult,
) -> dict:
    """Atomically publish final extraction data and terminal operation success."""

    now = utc_now()
    with db.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        operation = _required_operation(_operation_query_by_id(connection, operation_id))
        _assert_operation_project(operation, project_id)
        if operation["document_id"] != document_id:
            raise DocumentOperationStateError(
                "Document operation does not own the publication document."
            )
        if operation["status"] == "succeeded":
            row = document_query(connection, project_id, document_id)
            if row is None:
                raise NotFoundError("Document not found.")
            return document_from_row(row)
        if operation["status"] in {"cancel_requested", "canceled"}:
            raise DocumentProcessingCanceledError("Document processing was canceled.")
        if operation["status"] in TERMINAL_STATUSES:
            raise DocumentOperationStateError(
                "Terminal document operation cannot publish extraction results."
            )
        _begin_commit(
            connection,
            project_id=project_id,
            operation_id=operation_id,
            document_id=document_id,
            now=now,
        )
        document = complete_document_extraction_in_transaction(
            connection,
            project_id=project_id,
            document_id=document_id,
            extraction=extraction,
            now=now,
        )
        completed = connection.execute(
            """
            UPDATE document_operations
            SET status = 'succeeded', phase = 'completed', cancellable = 0,
                error = NULL, updated_at = ?
            WHERE id = ? AND project_id = ? AND document_id = ?
                AND status = 'running' AND phase = 'committing'
                AND cancellable = 0
            """,
            (now, operation_id, project_id, document_id),
        )
        if completed.rowcount != 1:
            raise DocumentOperationStateError(
                "Document operation success could not be committed."
            )
    return document


def acknowledge_cancellation(
    db: Database,
    *,
    project_id: str,
    operation_id: str,
) -> dict:
    now = utc_now()
    with db.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        operation = _required_operation(_operation_query_by_id(connection, operation_id))
        _assert_operation_project(operation, project_id)
        if operation["status"] in TERMINAL_STATUSES:
            return operation
        if operation["status"] != "cancel_requested":
            raise DocumentOperationStateError(
                "Only a requested cancellation can be acknowledged."
            )
        if operation["document_id"] is not None:
            _reset_document_derived_state(
                connection,
                project_id=project_id,
                document_id=str(operation["document_id"]),
                status="canceled",
                extraction_method="none",
                fallback_reason=None,
                now=now,
            )
        connection.execute(
            """
            UPDATE document_operations
            SET status = 'canceled', phase = 'canceled', cancellable = 0,
                error = NULL, updated_at = ?
            WHERE id = ? AND project_id = ? AND status = 'cancel_requested'
            """,
            (now, operation_id, project_id),
        )
        return _required_operation(_operation_query_by_id(connection, operation_id))


def finish_failed(
    db: Database,
    *,
    project_id: str,
    operation_id: str,
    error: str,
) -> dict:
    now = utc_now()
    with db.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        operation = _required_operation(_operation_query_by_id(connection, operation_id))
        _assert_operation_project(operation, project_id)
        if operation["status"] in TERMINAL_STATUSES:
            return operation
        canceled = operation["status"] == "cancel_requested"
        target_status = "canceled" if canceled else "failed"
        if operation["document_id"] is not None:
            _reset_document_derived_state(
                connection,
                project_id=project_id,
                document_id=str(operation["document_id"]),
                status="canceled" if canceled else "ocr_failed",
                extraction_method="none" if canceled else "ocr_failed",
                fallback_reason=None if canceled else error,
                now=now,
            )
        connection.execute(
            """
            UPDATE document_operations
            SET status = ?, phase = ?, cancellable = 0, error = ?, updated_at = ?
            WHERE id = ? AND project_id = ?
                AND status IN ('queued', 'running', 'cancel_requested')
            """,
            (
                target_status,
                "canceled" if canceled else "failed",
                None if canceled else error,
                now,
                operation_id,
                project_id,
            ),
        )
        return _required_operation(_operation_query_by_id(connection, operation_id))


def start_retry_operation(
    db: Database,
    *,
    project_id: str,
    document_id: str,
    operation_id: str | None = None,
) -> dict:
    """Reset retryable parsing state and create its linked running operation atomically."""

    ensure_project_exists(db, project_id)
    next_operation_id = operation_id or str(uuid4())
    now = utc_now()
    with db.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        existing_operation = _operation_query_by_id(connection, next_operation_id)
        if existing_operation is not None:
            existing = _operation_from_row(existing_operation)
            _assert_operation_project(existing, project_id)
            if existing["status"] in {"cancel_requested", "canceled"}:
                raise DocumentProcessingCanceledError(
                    "Document retry was canceled before it started."
                )
            raise DocumentOperationConflictError(
                "Document operation id is already in use."
            )
        document = document_query(connection, project_id, document_id)
        if document is None:
            raise NotFoundError("Document not found.")
        active = connection.execute(
            """
            SELECT id
            FROM document_operations
            WHERE project_id = ? AND document_id = ?
                AND status IN ('queued', 'running', 'cancel_requested')
            LIMIT 1
            """,
            (project_id, document_id),
        ).fetchone()
        if active is not None:
            raise DocumentOperationConflictError(
                "Document already has an active processing operation."
            )
        if document["status"] not in RETRYABLE_DOCUMENT_STATUSES:
            raise DocumentOperationStateError(
                "Document is not eligible for extraction retry."
            )
        _reset_document_derived_state(
            connection,
            project_id=project_id,
            document_id=document_id,
            status="processing",
            extraction_method="none",
            fallback_reason=None,
            now=now,
        )
        connection.execute(
            """
            INSERT INTO document_operations(
                id, project_id, document_id, status, phase, cancellable,
                error, created_at, updated_at
            )
            VALUES (?, ?, ?, 'running', 'processing', 1, NULL, ?, ?)
            """,
            (next_operation_id, project_id, document_id, now, now),
        )
        return _required_operation(
            _operation_query_by_id(connection, next_operation_id)
        )


def recover_operations(db: Database) -> int:
    """Fail interrupted work while honoring durable user cancellation."""

    with db.connect() as connection:
        rows = connection.execute(
            """
            SELECT id, project_id, status
            FROM document_operations
            WHERE status IN ('queued', 'running', 'cancel_requested')
            ORDER BY created_at, id
            """
        ).fetchall()
    for row in rows:
        if row["status"] == "cancel_requested":
            acknowledge_cancellation(
                db,
                project_id=str(row["project_id"]),
                operation_id=str(row["id"]),
            )
        else:
            finish_failed(
                db,
                project_id=str(row["project_id"]),
                operation_id=str(row["id"]),
                error="Document processing was interrupted by an app restart.",
            )
    return len(rows)


def get_operation(
    db: Database,
    *,
    project_id: str,
    operation_id: str,
) -> dict:
    with db.connect() as connection:
        row = connection.execute(
            "SELECT * FROM document_operations WHERE id = ? AND project_id = ?",
            (operation_id, project_id),
        ).fetchone()
    if row is None:
        raise NotFoundError("Document operation not found.")
    return _operation_from_row(row)


def _reset_document_derived_state(
    connection: Connection,
    *,
    project_id: str,
    document_id: str,
    status: str,
    extraction_method: str,
    fallback_reason: str | None,
    now: str,
) -> None:
    connection.execute(
        """
        DELETE FROM draft_generation_jobs
        WHERE project_id = ? AND document_id = ?
            AND status IN ('pending', 'running', 'cancel_requested')
        """,
        (project_id, document_id),
    )
    connection.execute(
        "DELETE FROM document_chunks WHERE project_id = ? AND document_id = ?",
        (project_id, document_id),
    )
    updated = connection.execute(
        """
        UPDATE documents
        SET status = ?, has_text = 0, extraction_method = ?,
            ocr_device = NULL, ocr_fallback_reason = ?, ocr_duration_ms = 0,
            processed_page_count = 0, parse_wall_duration_ms = 0,
            render_duration_ms = 0, ocr_engine_duration_ms = 0,
            ocr_worker_count = 0, first_chunk_ms = 0, exam_item_count = 0,
            content_profile = 'unknown', classification_detail = '',
            updated_at = ?
        WHERE project_id = ? AND id = ?
        """,
        (
            status,
            extraction_method,
            fallback_reason,
            now,
            project_id,
            document_id,
        ),
    )
    if updated.rowcount != 1:
        raise NotFoundError("Document not found.")


def _operation_query_by_id(connection: Connection, operation_id: str) -> Row | None:
    return connection.execute(
        "SELECT * FROM document_operations WHERE id = ?",
        (operation_id,),
    ).fetchone()


def _cancel_existing_operation(
    connection: Connection,
    *,
    operation: dict,
    project_id: str,
    now: str,
) -> dict:
    _assert_operation_project(operation, project_id)
    operation_id = str(operation["id"])
    status = str(operation["status"])
    if status in TERMINAL_STATUSES or status == "cancel_requested":
        return operation
    if status == "queued":
        connection.execute(
            """
            UPDATE document_operations
            SET status = 'canceled', phase = 'canceled', cancellable = 0,
                error = NULL, updated_at = ?
            WHERE id = ? AND project_id = ? AND status = 'queued'
            """,
            (now, operation_id, project_id),
        )
        return _required_operation(_operation_query_by_id(connection, operation_id))
    if (
        status == "running"
        and operation["phase"] == "processing"
        and operation["cancellable"]
    ):
        updated = connection.execute(
            """
            UPDATE document_operations
            SET status = 'cancel_requested', phase = 'canceling',
                cancellable = 0, updated_at = ?
            WHERE id = ? AND project_id = ? AND status = 'running'
                AND phase = 'processing' AND cancellable = 1
            """,
            (now, operation_id, project_id),
        )
        if updated.rowcount != 1:
            raise DocumentOperationStateError(
                "Document operation changed while cancellation was requested."
            )
        if operation["document_id"] is not None:
            connection.execute(
                """
                UPDATE documents
                SET status = 'cancel_requested', updated_at = ?
                WHERE project_id = ? AND id = ? AND status = 'processing'
                """,
                (now, project_id, operation["document_id"]),
            )
        return _required_operation(_operation_query_by_id(connection, operation_id))
    if status == "running" and not operation["cancellable"]:
        raise OperationNotCancellableError(
            "Document processing is committing and can no longer be canceled."
        )
    raise DocumentOperationStateError(
        f"Document operation cannot be canceled from {status}/{operation['phase']}."
    )


def _required_operation(row: Row | None) -> dict:
    if row is None:
        raise NotFoundError("Document operation not found.")
    return _operation_from_row(row)


def _assert_operation_project(operation: dict, project_id: str) -> None:
    if operation["project_id"] != project_id:
        raise DocumentOperationConflictError(
            "Document operation id is already in use."
        )


def _operation_from_row(row: Row) -> dict:
    return {
        "id": row["id"],
        "project_id": row["project_id"],
        "document_id": row["document_id"],
        "status": row["status"],
        "phase": row["phase"],
        "cancellable": bool(row["cancellable"]),
        "error": row["error"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


__all__ = [
    "DocumentOperationClaim",
    "acknowledge_cancellation",
    "cancel_document_processing",
    "cancel_operation",
    "claim_operation",
    "create_and_attach_document",
    "finish_failed",
    "get_operation",
    "publish_success",
    "recover_operations",
    "start_retry_operation",
]
