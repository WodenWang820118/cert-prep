from __future__ import annotations

from sqlite3 import Connection

from cert_prep_backend.platform.database import Database, utc_now
from cert_prep_backend.source_library.domain.document import (
    NO_TEXT_DETECTED_MESSAGE,
    SourceDocument,
    SourceFile,
)
from cert_prep_backend.source_library.infrastructure.records import (
    document_from_row,
    document_query,
)
from cert_prep_backend.source_library.domain.statuses import SourceDocumentStatus
from cert_prep_backend.platform.errors import NotFoundError


def insert_processing_document(
    connection,
    *,
    document_id: str,
    project_id: str,
    filename: str,
    sha256: str,
    language_hint: str,
    storage_path: str,
    page_count: int,
    now: str,
    source_kind: str = "document",
    duration_ms: int | None = None,
) -> SourceDocument:
    """Insert processing metadata using the caller's transaction."""

    connection.execute(
        """
        INSERT INTO documents(
            id, project_id, filename, sha256, storage_path, page_count,
            has_text, status, extraction_method, language_hint,
            content_profile, classification_detail, created_at, updated_at, source_kind,
            duration_ms,
            transcription_status, translation_status
        )
        VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'none', ?,
            'unknown', '', ?, ?, ?, ?,
            CASE WHEN ? = 'audio' THEN 'pending' ELSE 'not_applicable' END,
            CASE WHEN ? = 'audio' THEN 'pending' ELSE 'not_applicable' END)
        """,
        (
            document_id,
            project_id,
            filename,
            sha256,
            storage_path,
            page_count,
            SourceDocumentStatus.PROCESSING,
            language_hint,
            now,
            now,
            source_kind,
            duration_ms,
            source_kind,
            source_kind,
        ),
    )
    row = document_query(connection, project_id, document_id)
    if row is None:
        raise NotFoundError("Document not found.")
    return document_from_row(row)


def list_documents(db: Database, project_id: str) -> list[SourceDocument]:
    """List source documents for a project in newest-first order."""

    with db.connect() as connection:
        rows = connection.execute(
            """
            SELECT documents.*,
                COUNT(document_chunks.id) AS chunks_count
            FROM documents
            LEFT JOIN document_chunks ON document_chunks.document_id = documents.id
            WHERE documents.project_id = ?
            GROUP BY documents.id
            ORDER BY documents.created_at DESC
            """,
            (project_id,),
        ).fetchall()
    return [document_from_row(row) for row in rows]


def get_document(db: Database, project_id: str, document_id: str) -> SourceDocument:
    """Load a source document by project and document id."""

    with db.connect() as connection:
        row = document_query(connection, project_id, document_id)
    if row is None:
        raise NotFoundError("Document not found.")
    return document_from_row(row)


def get_source_file(db: Database, project_id: str, document_id: str) -> SourceFile:
    """Load private source-file metadata used by retry processing."""

    with db.connect() as connection:
        row = connection.execute(
            """
            SELECT filename, sha256, storage_path
            FROM documents
            WHERE project_id = ? AND id = ?
            """,
            (project_id, document_id),
        ).fetchone()
    if row is None:
        raise NotFoundError("Document not found.")
    return SourceFile(
        filename=str(row["filename"]),
        sha256=str(row["sha256"]),
        storage_path=str(row["storage_path"]),
    )


def update_exam_state(
    db: Database,
    *,
    project_id: str,
    document_id: str,
    status: str,
    exam_item_count: int,
) -> SourceDocument:
    """Update mock-exam generation state on a source document."""

    with db.connect() as connection:
        set_exam_state(
            connection,
            project_id=project_id,
            document_id=document_id,
            status=status,
            exam_item_count=exam_item_count,
        )
        row = document_query(connection, project_id, document_id)
    if row is None:
        raise NotFoundError("Document not found.")
    return document_from_row(row)


def set_exam_state(
    connection: Connection,
    *,
    project_id: str,
    document_id: str,
    status: str,
    exam_item_count: int,
) -> None:
    """Store the document's status and draft count using the caller's transaction.

    A ready document has no failure message. A document that becomes no_text_detected gets
    Source Library's no-text reason; one that already was keeps the reason it has. Extraction
    warnings stay as they are."""

    connection.execute(
        """
        UPDATE documents
        SET status = :status, exam_item_count = :exam_item_count,
            failure_message = CASE
                WHEN :status = 'ready' THEN NULL
                WHEN :status = 'no_text_detected' AND status = 'no_text_detected'
                    THEN COALESCE(failure_message, :no_text_reason)
                WHEN :status = 'no_text_detected' THEN :no_text_reason
                ELSE failure_message
            END,
            updated_at = :updated_at
        WHERE project_id = :project_id AND id = :document_id
        """,
        {
            "status": status,
            "exam_item_count": exam_item_count,
            "no_text_reason": NO_TEXT_DETECTED_MESSAGE,
            "updated_at": utc_now(),
            "project_id": project_id,
            "document_id": document_id,
        },
    )
