from __future__ import annotations

from cert_prep_backend.platform.database import Database, utc_now
from cert_prep_backend.platform.errors import SourceProcessingCanceledError, NotFoundError
from cert_prep_backend.source_library.domain.classification import source_classification_from_db
from cert_prep_backend.source_library.domain.source import PageExtraction, Source
from cert_prep_backend.source_library.infrastructure.chunks import sync_source_chunks
from cert_prep_backend.source_library.infrastructure.records import source_from_row, source_query


def complete_source_extraction_in_transaction(
    connection,
    *,
    project_id: str,
    source_id: str,
    extraction: PageExtraction,
    now: str,
    extraction_provenance: str | None = None,
) -> Source:
    """Publish extraction results using the caller's transaction."""

    existing = source_query(connection, project_id, source_id)
    if existing is None:
        raise NotFoundError("Document not found.")
    if existing["status"] != "processing":
        raise SourceProcessingCanceledError(
            "Document processing is no longer active."
        )
    sync_source_chunks(
        connection,
        project_id=project_id,
        source_id=source_id,
        pages=extraction.pages,
        now=now,
    )
    content_profile, classification_detail = source_classification_from_db(
        connection,
        project_id,
        source_id,
        fallback_pages=extraction.pages,
    )
    updated = connection.execute(
        """
        UPDATE sources
        SET has_text = ?,
            status = ?,
            extraction_method = ?,
            ocr_device = ?,
            extraction_warnings = ?,
            extraction_provenance = ?,
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
            extraction_provenance,
            extraction.processed_page_count,
            content_profile,
            classification_detail,
            now,
            project_id,
            source_id,
        ),
    )
    if updated.rowcount != 1:
        raise SourceProcessingCanceledError(
            "Document processing was canceled before publication."
        )
    row = source_query(connection, project_id, source_id)
    if row is None:
        raise NotFoundError("Document not found.")
    return source_from_row(row)


def recover_processing_sources(db: Database) -> int:
    """Mark stale processing rows from a previous app process as recoverable failures."""

    now = utc_now()
    with db.connect() as connection:
        cursor = connection.execute(
            """
            UPDATE sources
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
