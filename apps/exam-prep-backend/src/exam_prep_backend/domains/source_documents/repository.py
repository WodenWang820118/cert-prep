from __future__ import annotations

from sqlite3 import Row
from uuid import uuid4

from exam_prep_backend.database import Database, utc_now
from exam_prep_backend.domains.source_documents.models import PdfExtractionResult
from exam_prep_backend.errors import NotFoundError
from exam_prep_backend.domains.projects.repository import ensure_project_exists


def create_document(
    db: Database,
    *,
    project_id: str,
    filename: str,
    sha256: str,
    storage_path: str,
    extraction: PdfExtractionResult,
) -> dict:
    """Persist imported document metadata and extracted page chunks."""

    ensure_project_exists(db, project_id)
    document_id = str(uuid4())
    now = utc_now()
    with db.connect() as connection:
        connection.execute(
            """
            INSERT INTO documents(
                id, project_id, filename, sha256, storage_path, page_count,
                has_text, status, extraction_method, ocr_device, ocr_fallback_reason,
                ocr_duration_ms, processed_page_count, exam_item_count, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
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
                now,
            ),
        )
        for chunk_index, page in enumerate(extraction.pages):
            connection.execute(
                """
                INSERT INTO document_chunks(
                    id, project_id, document_id, page_number, chunk_index,
                    text, source_excerpt, extraction_method, created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    str(uuid4()),
                    project_id,
                    document_id,
                    page.page_number,
                    chunk_index,
                    page.text,
                    page.source_excerpt,
                    page.extraction_method,
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


def update_exam_state(
    db: Database,
    *,
    project_id: str,
    document_id: str,
    status: str,
    exam_item_count: int,
) -> dict:
    with db.connect() as connection:
        connection.execute(
            """
            UPDATE documents
            SET status = ?, exam_item_count = ?
            WHERE project_id = ? AND id = ?
            """,
            (status, exam_item_count, project_id, document_id),
        )
        row = _document_query(connection, project_id, document_id)
    if row is None:
        raise NotFoundError("Document not found.")
    return _document_from_row(row)


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
        "page_count": row["page_count"],
        "has_text": bool(row["has_text"]),
        "status": row["status"],
        "extraction_method": row["extraction_method"],
        "ocr_device": row["ocr_device"],
        "ocr_fallback_reason": row["ocr_fallback_reason"],
        "ocr_duration_ms": row["ocr_duration_ms"],
        "processed_page_count": row["processed_page_count"],
        "exam_item_count": row["exam_item_count"],
        "chunks_count": row["chunks_count"],
        "created_at": row["created_at"],
    }


def _chunk_from_row(row: Row) -> dict:
    return {
        "id": row["id"],
        "document_id": row["document_id"],
        "page_number": row["page_number"],
        "chunk_index": row["chunk_index"],
        "text": row["text"],
        "source_excerpt": row["source_excerpt"],
        "extraction_method": row["extraction_method"],
        "created_at": row["created_at"],
    }
