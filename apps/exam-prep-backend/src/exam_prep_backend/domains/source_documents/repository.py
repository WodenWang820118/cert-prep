from __future__ import annotations

from sqlite3 import Row
from uuid import uuid4

from exam_prep_backend.database import Database, utc_now
from exam_prep_backend.domains.exam_content import (
    aggregate_content_profile,
    classification_summary,
    content_profile_from_value,
    line_metadata,
)
from exam_prep_backend.domains.source_documents.models import ExtractedPage, PdfExtractionResult
from exam_prep_backend.domains.source_documents.statuses import SourceDocumentStatus
from exam_prep_backend.errors import NotFoundError
from exam_prep_backend.domains.projects.repository import ensure_project_exists


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
    content_profile, classification_detail = _document_classification(extraction.pages)
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
            connection.execute(
                """
                INSERT INTO document_chunks(
                    id, project_id, document_id, page_number, chunk_index,
                    text, raw_text, line_start, line_end, line_count, source_excerpt,
                    extraction_method, content_profile, created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    str(uuid4()),
                    project_id,
                    document_id,
                    page.page_number,
                    chunk_index,
                    page.text,
                    _page_raw_text(page),
                    _page_line_start(page),
                    _page_line_end(page),
                    _page_line_count(page),
                    page.source_excerpt,
                    page.extraction_method,
                    content_profile_from_value(page.content_profile).value,
                    now,
                ),
            )
        row = _document_query(connection, project_id, document_id)
    if row is None:
        raise NotFoundError("Document not found.")
    return _document_from_row(row)


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
        row = _document_query(connection, project_id, document_id)
    if row is None:
        raise NotFoundError("Document not found.")
    return _document_from_row(row)


def list_chunks(db: Database, project_id: str, document_id: str) -> list[dict]:
    ensure_document_exists(db, project_id, document_id)
    with db.connect() as connection:
        rows = connection.execute(
            """
            SELECT *
            FROM document_chunks
            WHERE project_id = ? AND document_id = ?
            ORDER BY page_number, chunk_index
            """,
            (project_id, document_id),
        ).fetchall()
    return [_chunk_from_row(row) for row in rows]


def get_source_chunks(db: Database, project_id: str, document_id: str) -> list[dict]:
    return list_chunks(db, project_id, document_id)


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
        existing = _document_query(connection, project_id, document_id)
        if existing is None:
            raise NotFoundError("Document not found.")

        extraction_method = existing["extraction_method"]
        if page is not None:
            chunk_index = connection.execute(
                """
                SELECT COUNT(*)
                FROM document_chunks
                WHERE project_id = ? AND document_id = ?
                """,
                (project_id, document_id),
            ).fetchone()[0]
            connection.execute(
                """
                INSERT INTO document_chunks(
                    id, project_id, document_id, page_number, chunk_index,
                    text, raw_text, line_start, line_end, line_count, source_excerpt,
                    extraction_method, content_profile, created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    str(uuid4()),
                    project_id,
                    document_id,
                    page.page_number,
                    chunk_index,
                    page.text,
                    _page_raw_text(page),
                    _page_line_start(page),
                    _page_line_end(page),
                    _page_line_count(page),
                    page.source_excerpt,
                    page.extraction_method,
                    content_profile_from_value(page.content_profile).value,
                    now,
                ),
            )
            extraction_method = _merged_extraction_method(
                current=extraction_method,
                next_method=page.extraction_method,
                existing_chunk_count=chunk_index,
            )
        content_profile, classification_detail = _document_classification_from_db(
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
        row = _document_query(connection, project_id, document_id)
    if row is None:
        raise NotFoundError("Document not found.")
    return _document_from_row(row)


def list_documents(db: Database, project_id: str) -> list[dict]:
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
    return [_document_from_row(row) for row in rows]


def get_chunk(db: Database, project_id: str, document_id: str, chunk_id: str) -> dict:
    with db.connect() as connection:
        row = connection.execute(
            """
            SELECT *
            FROM document_chunks
            WHERE project_id = ? AND document_id = ? AND id = ?
            """,
            (project_id, document_id, chunk_id),
        ).fetchone()
    if row is None:
        raise NotFoundError("Document chunk not found.")
    return _chunk_from_row(row)


def get_document(db: Database, project_id: str, document_id: str) -> dict:
    with db.connect() as connection:
        row = _document_query(connection, project_id, document_id)
    if row is None:
        raise NotFoundError("Document not found.")
    return _document_from_row(row)


def complete_document_extraction(
    db: Database,
    *,
    project_id: str,
    document_id: str,
    extraction: PdfExtractionResult,
) -> dict:
    now = utc_now()
    with db.connect() as connection:
        content_profile, classification_detail = _document_classification_from_db(
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
        row = _document_query(connection, project_id, document_id)
    if row is None:
        raise NotFoundError("Document not found.")
    return _document_from_row(row)


def fail_document_extraction(
    db: Database,
    *,
    project_id: str,
    document_id: str,
    status: str,
    detail: str,
) -> dict:
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
        row = _document_query(connection, project_id, document_id)
    if row is None:
        raise NotFoundError("Document not found.")
    return _document_from_row(row)


def update_exam_state(
    db: Database,
    *,
    project_id: str,
    document_id: str,
    status: str,
    exam_item_count: int,
) -> dict:
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
        row = _document_query(connection, project_id, document_id)
    if row is None:
        raise NotFoundError("Document not found.")
    return _document_from_row(row)


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


def ensure_document_exists(db: Database, project_id: str, document_id: str) -> None:
    with db.connect() as connection:
        row = connection.execute(
            "SELECT id FROM documents WHERE project_id = ? AND id = ?",
            (project_id, document_id),
        ).fetchone()
    if row is None:
        raise NotFoundError("Document not found.")


def _document_query(connection, project_id: str, document_id: str) -> Row | None:
    return connection.execute(
        """
        SELECT documents.*,
            COUNT(document_chunks.id) AS chunks_count
        FROM documents
        LEFT JOIN document_chunks ON document_chunks.document_id = documents.id
        WHERE documents.project_id = ? AND documents.id = ?
        GROUP BY documents.id
        """,
        (project_id, document_id),
    ).fetchone()


def _document_from_row(row: Row) -> dict:
    return {
        "id": row["id"],
        "project_id": row["project_id"],
        "filename": row["filename"],
        "sha256": row["sha256"],
        "language_hint": row["language_hint"],
        "page_count": row["page_count"],
        "has_text": bool(row["has_text"]),
        "status": row["status"],
        "extraction_method": row["extraction_method"],
        "ocr_device": row["ocr_device"],
        "ocr_fallback_reason": row["ocr_fallback_reason"],
        "ocr_duration_ms": row["ocr_duration_ms"],
        "processed_page_count": row["processed_page_count"],
        "parse_wall_duration_ms": row["parse_wall_duration_ms"],
        "render_duration_ms": row["render_duration_ms"],
        "ocr_engine_duration_ms": row["ocr_engine_duration_ms"],
        "ocr_worker_count": row["ocr_worker_count"],
        "first_chunk_ms": row["first_chunk_ms"],
        "exam_item_count": row["exam_item_count"],
        "content_profile": row["content_profile"],
        "classification_detail": row["classification_detail"],
        "chunks_count": row["chunks_count"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _chunk_from_row(row: Row) -> dict:
    return {
        "id": row["id"],
        "document_id": row["document_id"],
        "page_number": row["page_number"],
        "chunk_index": row["chunk_index"],
        "text": row["text"],
        "raw_text": row["raw_text"],
        "line_start": row["line_start"],
        "line_end": row["line_end"],
        "line_count": row["line_count"],
        "source_excerpt": row["source_excerpt"],
        "extraction_method": row["extraction_method"],
        "content_profile": row["content_profile"],
        "created_at": row["created_at"],
    }


def _merged_extraction_method(
    *,
    current: str,
    next_method: str,
    existing_chunk_count: int,
) -> str:
    if existing_chunk_count == 0 or current == "none":
        return next_method
    if current == next_method:
        return current
    return "mixed"


def _document_classification(pages: tuple[ExtractedPage, ...]) -> tuple[str, str]:
    profiles = [content_profile_from_value(page.content_profile) for page in pages]
    return aggregate_content_profile(profiles).value, classification_summary(profiles)


def _document_classification_from_db(
    connection,
    project_id: str,
    document_id: str,
    *,
    fallback_pages: tuple[ExtractedPage, ...] = (),
) -> tuple[str, str]:
    rows = connection.execute(
        """
        SELECT content_profile
        FROM document_chunks
        WHERE project_id = ? AND document_id = ?
        ORDER BY page_number, chunk_index
        """,
        (project_id, document_id),
    ).fetchall()
    if rows:
        profiles = [row["content_profile"] for row in rows]
        return aggregate_content_profile(profiles).value, classification_summary(profiles)
    return _document_classification(fallback_pages)


def _page_raw_text(page: ExtractedPage) -> str:
    return page.raw_text or page.text


def _page_line_start(page: ExtractedPage) -> int | None:
    if page.line_start is not None:
        return page.line_start
    return line_metadata(_page_raw_text(page)).line_start


def _page_line_end(page: ExtractedPage) -> int | None:
    if page.line_end is not None:
        return page.line_end
    return line_metadata(_page_raw_text(page)).line_end


def _page_line_count(page: ExtractedPage) -> int:
    if page.line_count:
        return page.line_count
    return line_metadata(_page_raw_text(page)).line_count
