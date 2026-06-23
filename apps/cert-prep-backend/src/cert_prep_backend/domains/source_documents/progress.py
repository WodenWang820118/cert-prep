from __future__ import annotations

from cert_prep_backend.database import Database, utc_now
from cert_prep_backend.domains.source_documents.chunks import sync_document_chunks, upsert_page_chunk
from cert_prep_backend.domains.source_documents.classification import (
    document_classification_from_db,
    document_extraction_method_from_db,
)
from cert_prep_backend.domains.source_documents.models import ExtractedPage, PdfExtractionResult
from cert_prep_backend.domains.source_documents.records import document_from_row, document_query
from cert_prep_backend.errors import NotFoundError


def record_extraction_progress(
    db: Database,
    *,
    project_id: str,
    document_id: str,
    processed_page_count: int,
    page: ExtractedPage | None,
    ocr_device: str | None,
    ocr_fallback_reason: str | None,
    ocr_duration_ms: int,
    parse_wall_duration_ms: int | None = None,
    render_duration_ms: int | None = None,
    ocr_engine_duration_ms: int | None = None,
    ocr_worker_count: int | None = None,
    first_chunk_ms: int | None = None,
) -> dict:
    """Store incremental parsing progress and optional page text."""

    now = utc_now()
    with db.connect() as connection:
        existing = document_query(connection, project_id, document_id)
        if existing is None:
            raise NotFoundError("Document not found.")

        extraction_method = existing["extraction_method"]
        if page is not None:
            upsert_page_chunk(
                connection,
                project_id=project_id,
                document_id=document_id,
                page=page,
                chunk_index=page.page_number - 1,
                now=now,
            )
            extraction_method = document_extraction_method_from_db(
                connection,
                project_id,
                document_id,
                fallback=extraction_method,
            )
        content_profile, classification_detail = document_classification_from_db(
            connection,
            project_id,
            document_id,
        )

        connection.execute(
            """
            UPDATE documents
            SET has_text = CASE
                    WHEN EXISTS (
                        SELECT 1 FROM document_chunks
                        WHERE document_chunks.document_id = documents.id
                    )
                    THEN 1 ELSE has_text END,
                extraction_method = ?,
                ocr_device = COALESCE(?, ocr_device),
                ocr_fallback_reason = COALESCE(?, ocr_fallback_reason),
                ocr_duration_ms = ?,
                processed_page_count = ?,
                parse_wall_duration_ms = COALESCE(?, parse_wall_duration_ms),
                render_duration_ms = COALESCE(?, render_duration_ms),
                ocr_engine_duration_ms = COALESCE(?, ocr_engine_duration_ms),
                ocr_worker_count = COALESCE(?, ocr_worker_count),
                first_chunk_ms = COALESCE(?, first_chunk_ms),
                content_profile = ?,
                classification_detail = ?,
                updated_at = ?
            WHERE project_id = ? AND id = ?
            """,
            (
                extraction_method,
                ocr_device,
                ocr_fallback_reason,
                ocr_duration_ms,
                processed_page_count,
                parse_wall_duration_ms,
                render_duration_ms,
                ocr_engine_duration_ms,
                ocr_worker_count,
                first_chunk_ms,
                content_profile,
                classification_detail,
                now,
                project_id,
                document_id,
            ),
        )
        row = document_query(connection, project_id, document_id)
    if row is None:
        raise NotFoundError("Document not found.")
    return document_from_row(row)


def complete_document_extraction(
    db: Database,
    *,
    project_id: str,
    document_id: str,
    extraction: PdfExtractionResult,
) -> dict:
    """Replace temporary progress with the final PDF extraction result."""

    now = utc_now()
    with db.connect() as connection:
        sync_document_chunks(
            connection,
            project_id=project_id,
            document_id=document_id,
            pages=extraction.pages,
            now=now,
        )
        content_profile, classification_detail = document_classification_from_db(
            connection,
            project_id,
            document_id,
            fallback_pages=extraction.pages,
        )
        connection.execute(
            """
            UPDATE documents
            SET has_text = ?,
                status = ?,
                extraction_method = ?,
                ocr_device = ?,
                ocr_fallback_reason = ?,
                ocr_duration_ms = ?,
                processed_page_count = ?,
                parse_wall_duration_ms = ?,
                render_duration_ms = ?,
                ocr_engine_duration_ms = ?,
                ocr_worker_count = ?,
                first_chunk_ms = ?,
                content_profile = ?,
                classification_detail = ?,
                updated_at = ?
            WHERE project_id = ? AND id = ?
            """,
            (
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
                content_profile,
                classification_detail,
                now,
                project_id,
                document_id,
            ),
        )
        row = document_query(connection, project_id, document_id)
    if row is None:
        raise NotFoundError("Document not found.")
    return document_from_row(row)


def fail_document_extraction(
    db: Database,
    *,
    project_id: str,
    document_id: str,
    status: str,
    detail: str,
) -> dict:
    """Record a terminal extraction failure for a source document."""

    now = utc_now()
    with db.connect() as connection:
        connection.execute(
            """
            UPDATE documents
            SET status = ?,
                extraction_method = 'ocr_failed',
                ocr_fallback_reason = ?,
                updated_at = ?
            WHERE project_id = ? AND id = ?
            """,
            (status, detail, now, project_id, document_id),
        )
        row = document_query(connection, project_id, document_id)
    if row is None:
        raise NotFoundError("Document not found.")
    return document_from_row(row)


def recover_processing_documents(db: Database) -> int:
    """Mark stale processing rows from a previous app process as recoverable failures."""

    now = utc_now()
    with db.connect() as connection:
        cursor = connection.execute(
            """
            UPDATE documents
            SET status = 'ocr_failed',
                extraction_method = 'ocr_failed',
                ocr_fallback_reason = 'Parsing was interrupted before completion.',
                updated_at = ?
            WHERE status = 'processing'
            """,
            (now,),
        )
        return int(cursor.rowcount)
