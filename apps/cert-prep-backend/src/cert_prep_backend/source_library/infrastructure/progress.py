from __future__ import annotations

from cert_prep_backend.platform.database import Database, utc_now
from cert_prep_backend.platform.errors import DocumentProcessingCanceledError, NotFoundError
from cert_prep_backend.source_library.domain.classification import document_classification_from_db
from cert_prep_backend.source_library.domain.document import PageExtraction, SourceDocument
from cert_prep_backend.source_library.infrastructure.chunks import sync_document_chunks
from cert_prep_backend.source_library.infrastructure.records import document_from_row, document_query


def complete_document_extraction_in_transaction(
    connection,
    *,
    project_id: str,
    document_id: str,
    extraction: PageExtraction,
    now: str,
) -> SourceDocument:
    """Publish extraction results using the caller's transaction."""

    existing = document_query(connection, project_id, document_id)
    if existing is None:
        raise NotFoundError("Document not found.")
    if existing["status"] != "processing":
        raise DocumentProcessingCanceledError(
            "Document processing is no longer active."
        )
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
    updated = connection.execute(
        """
        UPDATE documents
        SET has_text = ?,
            status = ?,
            extraction_method = ?,
            ocr_device = ?,
            extraction_warnings = ?,
            failure_message = NULL,
            processed_page_count = ?,
            content_profile = ?,
            classification_detail = ?,
            updated_at = ?
        WHERE project_id = ? AND id = ? AND status = 'processing'
        """,
        (
            int(extraction.has_text),
            extraction.status,
            extraction.extraction_method,
            extraction.ocr_device,
            extraction.extraction_warnings,
            extraction.processed_page_count,
            content_profile,
            classification_detail,
            now,
            project_id,
            document_id,
        ),
    )
    if updated.rowcount != 1:
        raise DocumentProcessingCanceledError(
            "Document processing was canceled before publication."
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
            SET status = 'extraction_failed',
                extraction_method = 'none',
                extraction_warnings = NULL,
                failure_message = 'Parsing was interrupted before completion.',
                updated_at = ?
            WHERE status = 'processing'
            """,
            (now,),
        )
        return int(cursor.rowcount)
