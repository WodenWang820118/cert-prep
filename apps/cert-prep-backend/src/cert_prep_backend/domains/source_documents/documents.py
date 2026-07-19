from __future__ import annotations

from cert_prep_backend.persistence.database import Database, utc_now
from cert_prep_backend.domains.projects.repository import ensure_project_exists
from cert_prep_backend.domains.source_documents.models import SourceFile
from cert_prep_backend.domains.source_documents.records import document_from_row, document_query
from cert_prep_backend.domains.source_documents.statuses import SourceDocumentStatus
from cert_prep_backend.api.errors import NotFoundError


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
) -> dict:
    """Insert processing metadata using the caller's transaction."""

    connection.execute(
        """
        INSERT INTO documents(
            id, project_id, filename, sha256, storage_path, page_count,
            has_text, status, extraction_method, ocr_device, ocr_fallback_reason,
            ocr_duration_ms, processed_page_count, parse_wall_duration_ms,
            render_duration_ms, ocr_engine_duration_ms, ocr_worker_count,
            first_chunk_ms, exam_item_count, language_hint,
            content_profile, classification_detail, created_at, updated_at, source_kind,
            duration_ms,
            transcription_status, translation_status
        )
        VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'none', NULL, NULL, 0, 0, 0, 0, 0, 0, 0, 0, ?,
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


def list_documents(db: Database, project_id: str) -> list[dict]:
    """List source documents for a project in newest-first order."""

    ensure_project_exists(db, project_id)
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


def get_document(db: Database, project_id: str, document_id: str) -> dict:
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
) -> dict:
    """Update mock-exam generation state on a source document."""

    now = utc_now()
    with db.connect() as connection:
        connection.execute(
            """
            UPDATE documents
            SET status = ?, exam_item_count = ?, updated_at = ?
            WHERE project_id = ? AND id = ?
            """,
            (status, exam_item_count, now, project_id, document_id),
        )
        row = document_query(connection, project_id, document_id)
    if row is None:
        raise NotFoundError("Document not found.")
    return document_from_row(row)
