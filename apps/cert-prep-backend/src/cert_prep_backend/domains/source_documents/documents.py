from __future__ import annotations

from uuid import uuid4

from cert_prep_backend.database import Database, utc_now
from cert_prep_backend.domains.projects.repository import ensure_project_exists
from cert_prep_backend.domains.source_documents.chunks import upsert_page_chunk
from cert_prep_backend.domains.source_documents.classification import document_classification
from cert_prep_backend.domains.source_documents.models import PdfExtractionResult
from cert_prep_backend.domains.source_documents.records import document_from_row, document_query
from cert_prep_backend.domains.source_documents.statuses import SourceDocumentStatus
from cert_prep_backend.errors import NotFoundError


def create_document(
    db: Database,
    *,
    project_id: str,
    filename: str,
    sha256: str,
    language_hint: str = "auto",
    storage_path: str,
    extraction: PdfExtractionResult,
) -> dict:
    """Persist imported document metadata and extracted page chunks."""

    ensure_project_exists(db, project_id)
    document_id = str(uuid4())
    now = utc_now()
    content_profile, classification_detail = document_classification(extraction.pages)
    with db.connect() as connection:
        connection.execute(
            """
            INSERT INTO documents(
                id, project_id, filename, sha256, storage_path, page_count,
                has_text, status, extraction_method, ocr_device, ocr_fallback_reason,
                ocr_duration_ms, processed_page_count, parse_wall_duration_ms,
                render_duration_ms, ocr_engine_duration_ms, ocr_worker_count,
                first_chunk_ms, exam_item_count, language_hint,
                content_profile, classification_detail, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
            """,
            (
                document_id,
                project_id,
                filename,
                sha256,
                storage_path,
                extraction.page_count,
                int(extraction.has_text),
                extraction.status,
                extraction.extraction_method,
                extraction.ocr_device,
                extraction.ocr_fallback_reason,
                extraction.ocr_duration_ms,
                extraction.processed_page_count,
                extraction.parse_wall_duration_ms,
                extraction.render_duration_ms,
                extraction.ocr_engine_duration_ms,
                extraction.ocr_worker_count,
                extraction.first_chunk_ms,
                language_hint,
                content_profile,
                classification_detail,
                now,
                now,
            ),
        )
        for chunk_index, page in enumerate(extraction.pages):
            upsert_page_chunk(
                connection,
                project_id=project_id,
                document_id=document_id,
                page=page,
                chunk_index=chunk_index,
                now=now,
            )
        row = document_query(connection, project_id, document_id)
    if row is None:
        raise NotFoundError("Document not found.")
    return document_from_row(row)


def create_processing_document(
    db: Database,
    *,
    project_id: str,
    filename: str,
    sha256: str,
    language_hint: str,
    storage_path: str,
    page_count: int,
) -> dict:
    """Persist document metadata before background extraction starts."""

    ensure_project_exists(db, project_id)
    document_id = str(uuid4())
    now = utc_now()
    with db.connect() as connection:
        connection.execute(
            """
            INSERT INTO documents(
                id, project_id, filename, sha256, storage_path, page_count,
                has_text, status, extraction_method, ocr_device, ocr_fallback_reason,
                ocr_duration_ms, processed_page_count, parse_wall_duration_ms,
                render_duration_ms, ocr_engine_duration_ms, ocr_worker_count,
                first_chunk_ms, exam_item_count, language_hint,
                content_profile, classification_detail, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'none', NULL, NULL, 0, 0, 0, 0, 0, 0, 0, 0, ?,
                'unknown', '', ?, ?)
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
